"""``file_service`` 的上传编排与磁盘/删除链路（补 ``test_kb_api_file.py`` 之外的分支）。

不连库：``directory_store`` / ``storage`` / 队列全部用桩；判重与自定义算子格式在
夹具里替换，避免触碰 ``connection()``。

跑法（服务目录下）::

    python -m pytest tests/test_kb_file_service_upload_flow.py -q
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from shared.errors.api import (KbApiError, KbServerError, KbValidationError,
                               KbWrappedValidatorError)
from knowledge_base.repository import kbase as kbase_store
from knowledge_base.service import file_service as fs


class _Queue:
    def __init__(self):
        self.handles = []

    def submit_task(self, handle):
        self.handles.append(handle)
        return 'task-1'


class _DummyCursor:
    """哑游标：只服务 ``_parent_path`` 那类"读一下就行"的调用。"""

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        pass

    def fetchone(self):
        return ('0',)

    def fetchall(self):
        return []


class _DummyConn:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return _DummyCursor()


class _Memory:
    """``directory_store`` 的最小内存替身（行 + 属性 + 状态）。"""

    TYPE_FOLDER = 'folder'
    TYPE_FILE = 'file'
    ROOT_DIRECTORY_SYMBOL = '0'
    DOCUMENT_TYPE = 'document'

    def __init__(self, directories=(), properties=None, kbase=None):
        self.directories = {row['id']: dict(row) for row in directories}
        self.properties = dict(properties or {})
        self.kbase = kbase or {}
        self.updates = []

    def connection(self):
        return _DummyConn()

    def get_directory(self, directory_id, kbase_id, dir_type=None):
        row = self.directories.get(directory_id)
        if row is None or (dir_type and row.get('type') != dir_type):
            return None
        return dict(row)

    def count_files(self, kbase_id):
        return sum(1 for row in self.directories.values() if row.get('type') == 'file')

    def insert_directory(self, cursor, kbase_id, parent_id, parent_path, title,
                         dir_type, status, directory_id=None, created_by=None,
                         file_from=None):
        directory_id = directory_id or 'new-file-id'
        self.directories[directory_id] = {
            'id': directory_id, 'kbase_id': kbase_id, 'title': title,
            'parent_id': parent_id, 'parent_path': parent_path, 'type': dir_type,
            'status': status, 'file_from': file_from, 'created_by': created_by,
        }
        return directory_id

    def update_file_status(self, cursor, file_id, status, fail_reason=None):
        row = self.directories.get(file_id)
        assert row is not None, f'file row missing: {file_id}'
        row['status'] = status
        if fail_reason and fail_reason.strip():                # 与实现一致：空白保留旧值
            row['fail_reason'] = fail_reason
        self.updates.append((file_id, status, fail_reason))

    def update_file_from(self, cursor, file_id, file_from):
        self.directories[file_id]['file_from'] = file_from

    def create_property(self, cursor, kbase_id, file_id, name, value):
        self.properties[(file_id, name)] = str(value)

    def upsert_property(self, cursor, kbase_id, file_id, name, value):
        self.properties[(file_id, name)] = str(value)


@pytest.fixture()
def db(monkeypatch):
    folder = {'id': 'dir-1', 'kbase_id': 'kb1', 'title': 'Default', 'type': 'folder',
              'parent_id': None, 'parent_path': '0'}
    memory = _Memory([folder], kbase={'id': 1, 'kbase_id': 'kb1',
                                      'embedding_model': 'bge-base',
                                      'table_name': 'doc_kb1_vector',
                                      'file_count_limit': 5000})
    monkeypatch.setattr(fs, 'directory_store', memory)
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id',
                        lambda kbase_id: memory.kbase if kbase_id == 'kb1' else None)
    monkeypatch.setattr(fs, '_custom_operator_formats', lambda: set())

    # 判重查询打桩成"目录内已有同名文件（含已删行）就抛"——语义与实现一致
    def reject_duplicates(kbase_id, directory_id, names):
        titles = {row['title'] for row in memory.directories.values()
                  if row.get('type') == 'file'}
        duplicates = sorted(set(names) & titles)
        if duplicates:
            raise KbApiError('file.upload.rename', ', '.join(duplicates),
                             code=fs.FILE_RENAME_ERROR_CODE)

    monkeypatch.setattr(fs, '_reject_duplicate_names', reject_duplicates)

    saved = {}

    def fake_save(content, file_id, cover):
        saved[file_id] = bytes(content)
        return f'/data/kb/core/{file_id[:4]}/{file_id}'

    monkeypatch.setattr(fs.storage, 'save_core_file', fake_save)
    monkeypatch.setattr(fs.storage, 'core_file_exists', lambda file_id: file_id in saved)
    monkeypatch.setattr(fs.storage, 'read_core_file', lambda file_id: saved[file_id])
    monkeypatch.setattr(fs.storage, 'delete_core_file',
                        lambda file_id: saved.pop(file_id, None))
    memory.saved = saved
    return memory


def _metadata(**overrides):
    metadata = {
        'directoryId': 'dir-1', 'kbaseId': 'kb1', 'kType': 'document',
        'splitType': 'system', 'splitOperator': {'md': {'operatorId': -1, 'args': []}},
    }
    metadata.update(overrides)
    return metadata


def _zip_bytes(*names):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name in names:
            archive.writestr(name, b'x')
    return buffer.getvalue()


# ----------------------------------------------------------------------
# 自定义算子格式（_custom_operator_formats 的解析）
# ----------------------------------------------------------------------


def test_custom_operator_formats_parse_prop_values(monkeypatch):
    calls = []

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, sql, params):
            calls.append((sql, params))

        def fetchall(self):
            return [('[md, txt]',), (None,), ('',), ('zedx',)]

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(fs.directory_store, 'connection', lambda: _Conn())

    assert fs._custom_operator_formats() == {'md', 'txt', 'zedx'}
    assert 'support_format' in calls[0][0]


# ----------------------------------------------------------------------
# expand_zip 的分支
# ----------------------------------------------------------------------


def test_expand_zip_skips_directories_and_hidden_entries():
    files = [fs.UploadedFile('pack.zip', _zip_bytes('sub/a.md', 'sub/', '.hidden.md'))]

    expanded = fs.expand_zip(files)

    assert [item.filename for item in expanded] == ['a.md']


def test_expand_zip_keeps_original_when_archive_has_no_files():
    files = [fs.UploadedFile('pack.zip', _zip_bytes('only-dir/'))]

    assert fs.expand_zip(files) is files


def test_expand_zip_is_case_insensitive_on_suffix():
    files = [fs.UploadedFile('PACK.ZIP', _zip_bytes('a.md'))]

    assert [item.filename for item in fs.expand_zip(files)] == ['a.md']


# ----------------------------------------------------------------------
# 上传前的批次校验（upload_check）
# ----------------------------------------------------------------------


def test_upload_check_rejects_too_many_files(monkeypatch):
    monkeypatch.setenv('MEM_LIMIT', '1024')                    # outer-document 档 = 50
    files = [fs.UploadedFile(f'f{i}.md', b'x') for i in range(51)]

    with pytest.raises(KbApiError) as caught:
        fs.upload_check(files, 'outer-document')

    assert caught.value.key == 'RetCode.file.count.limit'


def test_upload_check_rejects_same_name_in_batch():
    files = [fs.UploadedFile('a.md', b'x'), fs.UploadedFile('a.md', b'y')]

    with pytest.raises(KbApiError) as caught:
        fs.upload_check(files, 'document')

    assert caught.value.key == 'RetCode.upload.file.rename'


def test_upload_check_rejects_over_long_base_name():
    with pytest.raises(KbApiError) as caught:
        fs.upload_check([fs.UploadedFile('x' * 151 + '.md', b'x')], 'document')

    assert caught.value.key == 'file.name.length.check'


def test_upload_check_allows_150_char_base_name(monkeypatch):
    monkeypatch.setenv('MEM_LIMIT', '1024')
    monkeypatch.setattr(fs, '_custom_operator_formats', lambda: set())

    fs.upload_check([fs.UploadedFile('x' * 150 + '.md', b'x')], 'document')   # 不抛


def test_upload_check_rejects_oversized_file(monkeypatch):
    monkeypatch.setenv('MEM_LIMIT', '8')                       # txt 档压到 2.5MB
    monkeypatch.setattr(fs, '_custom_operator_formats', lambda: set())

    big = fs.UploadedFile('a.txt', b'x' * (3 * 1024 * 1024))
    with pytest.raises(KbApiError) as caught:
        fs.upload_check([big], 'document')

    assert caught.value.key == 'RetCode.file.size.limit.check'
    assert caught.value.args == ('2',)                          # int(2.5)


def test_upload_check_rejects_parent_directory_names(monkeypatch):
    monkeypatch.setenv('MEM_LIMIT', '1024')
    monkeypatch.setattr(fs, '_custom_operator_formats', lambda: set())
    with pytest.raises(KbValidationError) as caught:
        fs.upload_check([fs.UploadedFile('../escape.md', b'x')], 'document')

    assert caught.value.key == 'RetCode.illegalArgument'


def test_upload_check_accepts_custom_operator_format(monkeypatch):
    monkeypatch.setenv('MEM_LIMIT', '1024')
    monkeypatch.setattr(fs, '_custom_operator_formats', lambda: {'zedx'})

    fs.upload_check([fs.UploadedFile('a.zedx', b'x')], 'document')   # 不抛

    with pytest.raises(KbValidationError):
        fs.upload_check([fs.UploadedFile('a.xyz', b'x')], 'document')


# ----------------------------------------------------------------------
# 空文件与单库文件数
# ----------------------------------------------------------------------


def test_empty_files_are_reported_all_at_once():
    files = [fs.UploadedFile('empty.md', b''), fs.UploadedFile('  ', b'x')]

    with pytest.raises(KbApiError) as caught:
        fs._validate_files_present(files)

    assert caught.value.args == ('empty.md,   ',)


def test_file_count_uses_kbase_row_limit(monkeypatch):
    row = {'file_count_limit': 5000}
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: row)
    monkeypatch.setattr(fs.directory_store, 'count_files', lambda _: 4999)

    fs._check_kbase_file_count('kb1', 1)                       # 4999 + 1 → 不抛

    with pytest.raises(KbApiError) as caught:
        fs._check_kbase_file_count('kb1', 2)
    assert caught.value.key == 'kbase.file.count.exceed'
    assert caught.value.args == (4999, 2, 5000)


def test_file_count_skips_unlimited_and_blank_kbase(monkeypatch):
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: {})
    monkeypatch.setattr(fs.directory_store, 'count_files', lambda _: 10 ** 6)

    fs._check_kbase_file_count('kb1', 10)                      # 无上限 → 不抛
    fs._check_kbase_file_count('', 10 ** 6)                    # 空 kbaseId → 不查


# ----------------------------------------------------------------------
# upload_files 主流程
# ----------------------------------------------------------------------


def test_upload_files_happy_path_system_split(db):
    queue = _Queue()

    result = fs.upload_files([fs.UploadedFile('a.md', b'AAA')], _metadata(),
                             'kb1', 'admin', queue=queue)

    file_id = result['a.md']
    assert len(file_id) == 32
    assert db.saved[file_id] == b'AAA'
    row = db.directories[file_id]
    assert row['status'] == fs.STATUS_UPLOAD_CLOUD_DISK
    assert row['parent_path'] == '0'
    assert db.properties[(file_id, 'KType')] == 'document'
    assert db.properties[(file_id, 'file_size')] == '3'

    handle = queue.handles[0]
    assert handle['fileId'] == file_id
    assert handle['kbaseId'] == 'kb1'
    assert handle['format'] == 'md'
    assert handle['fileName'] == 'a.md'
    assert handle['fileSize'] == 3
    assert handle['modelName'] == 'bge-base'
    assert handle['operatorSplitDTO'] == {'operatorId': -1, 'args': []}
    assert 'operatorParseDTO' not in handle

    persisted = json.loads(db.properties[(file_id, fs.TASK_CONFIG_PROP)])
    assert persisted['operatorSplitDTO'] == {'operatorId': -1, 'args': []}
    assert persisted['operatorParseDTO'] is None
    assert persisted['regexList'] is None


def test_upload_files_custom_split_uses_md_split_operator(db):
    metadata = _metadata(splitType='custom',
                         splitOperator={'md': {'operatorId': -1, 'args': []}},
                         parseOperator={'txt': {'operatorId': 5, 'args': []}})
    queue = _Queue()

    result = fs.upload_files([fs.UploadedFile('b.txt', b'BBB')], metadata,
                             'kb1', 'admin', queue=queue)

    handle = queue.handles[0]
    assert handle['operatorParseDTO'] == {'operatorId': 5, 'args': []}
    assert handle['operatorSplitDTO'] == {'operatorId': -1, 'args': []}
    assert result['b.txt'] == handle['fileId']


def test_upload_files_persists_regex_list(db):
    metadata = _metadata(regexList=['a+', 'b'])
    queue = _Queue()

    fs.upload_files([fs.UploadedFile('a.md', b'A')], metadata, 'kb1', 'admin',
                    queue=queue)

    persisted = json.loads(db.properties[(queue.handles[0]['fileId'],
                                          fs.TASK_CONFIG_PROP)])
    assert persisted['regexList'] == ['a+', 'b']


def test_upload_files_graph_category_skips_operator_check(db):
    metadata = _metadata(category=fs.CATEGORY_KNOWLEDGE_GRAPH,
                         splitOperator={}, parseOperator={})
    queue = _Queue()

    result = fs.upload_files([fs.UploadedFile('a.md', b'A')], metadata,
                             'kb1', 'admin', queue=queue)

    assert result                                              # 算子不覆盖也不拦


def test_upload_files_without_split_pipeline_skips_checks_and_enqueue(db):
    """抽图建库那条路：不算子校验（splitOperator 缺席也不 NPE）、不入队。"""
    metadata = _metadata(splitOperator=None)
    queue = _Queue()

    result = fs.upload_files([fs.UploadedFile('a.md', b'A')], metadata,
                             'kb1', 'admin', queue=queue, run_split_pipeline=False)

    assert result
    assert queue.handles == []
    assert db.directories[result['a.md']]['status'] == fs.STATUS_UPLOAD_CLOUD_DISK


def test_upload_files_missing_metadata_field_is_wrapped_validation():
    with pytest.raises(KbWrappedValidatorError):
        fs.upload_files([fs.UploadedFile('a.md', b'A')], {'directoryId': 'd'},
                        'kb1', 'admin', queue=_Queue())


def test_upload_files_missing_directory_is_business_error(db):
    with pytest.raises(KbApiError) as caught:
        fs.upload_files([fs.UploadedFile('a.md', b'A')],
                        _metadata(directoryId='ghost'), 'kb1', 'admin', queue=_Queue())

    assert caught.value.key == 'directory.not.exist'


def test_upload_files_rejects_duplicate_name_without_cover(db):
    db.directories['old'] = {'id': 'old', 'kbase_id': 'kb1', 'title': 'a.md',
                             'type': 'file', 'parent_id': 'dir-1', 'status': 1}

    with pytest.raises(KbApiError) as caught:
        fs.upload_files([fs.UploadedFile('a.md', b'A')], _metadata(),
                        'kb1', 'admin', queue=_Queue())

    assert caught.value.key == 'file.upload.rename'
    assert caught.value.code == fs.FILE_RENAME_ERROR_CODE
    assert caught.value.args == ('a.md',)


def test_upload_files_cover_reuses_existing_row_and_purges(db, monkeypatch):
    db.directories['old-id'] = {'id': 'old-id', 'kbase_id': 'kb1', 'title': 'a.md',
                                'type': 'file', 'parent_id': 'dir-1', 'status': 1,
                                'fail_reason': 'boom'}
    db.saved['old-id'] = b'stale'
    purged = []

    monkeypatch.setattr(fs, '_find_existing_file', lambda kb, d, name: {
        'id': 'old-id', 'kbase_id': kb, 'title': name, 'type': 'file'})

    def fake_purge(kbase_id, file_id, file_name):
        purged.append((kbase_id, file_id, file_name))
        db.saved.pop(file_id, None)

    monkeypatch.setattr(fs, '_purge_old_file', fake_purge)

    queue = _Queue()
    result = fs.upload_files([fs.UploadedFile('a.md', b'NEW')],
                             _metadata(coverFlag=True), 'kb1', 'admin', queue=queue)

    assert result == {'a.md': 'old-id'}                        # 复用旧行 id
    assert purged == [('kb1', 'old-id', 'a.md')]
    assert db.directories['old-id']['status'] == fs.STATUS_UPLOAD_CLOUD_DISK
    assert db.saved['old-id'] == b'NEW'                        # 覆盖写回
    assert queue.handles[0]['fileId'] == 'old-id'
    assert db.properties[('old-id', 'file_size')] == '3'   # b'NEW' 3 字节


def test_upload_files_cover_with_append_file_id_keeps_identifier(db, monkeypatch):
    db.directories['f' * 32] = {'id': 'f' * 32, 'kbase_id': 'kb1', 'title': 'a.md',
                                'type': 'file', 'parent_id': 'dir-1', 'status': 1}
    monkeypatch.setattr(fs, '_find_existing_file', lambda kb, d, name: None)
    queue = _Queue()

    result = fs.upload_files([fs.UploadedFile('a.md', b'A')],
                             _metadata(coverFlag=True, appendFileId='f' * 32),
                             'kb1', 'admin', queue=queue)

    assert result['a.md'] == 'f' * 32


def test_disk_failure_marks_row_failed_and_skips_enqueue(db, monkeypatch):
    def boom(content, file_id, cover):
        raise OSError('disk full')

    monkeypatch.setattr(fs.storage, 'save_core_file', boom)
    queue = _Queue()

    result = fs.upload_files([fs.UploadedFile('a.md', b'A')], _metadata(),
                             'kb1', 'admin', queue=queue)

    assert result == {}
    assert queue.handles == []
    assert any(status == fs.STATUS_UPLOAD_FAILURE
               for _fid, status, _reason in db.updates)
    failed_row = [row for row in db.directories.values() if row.get('type') == 'file'][0]
    assert failed_row['fail_reason'] == 'RetCode.file.save.error'


def test_disk_failure_still_succeeds_when_marking_fails(db, monkeypatch):
    monkeypatch.setattr(fs.storage, 'save_core_file',
                        lambda *a, **k: (_ for _ in ()).throw(OSError('x')))

    def broken_status(cursor, file_id, status, fail_reason=None):
        raise RuntimeError('db down')

    monkeypatch.setattr(fs.directory_store, 'update_file_status', broken_status)
    queue = _Queue()

    assert fs.upload_files([fs.UploadedFile('a.md', b'A')], _metadata(),
                           'kb1', 'admin', queue=queue) == {}
    assert queue.handles == []


def test_too_long_task_config_is_skipped(db):
    metadata = _metadata(regexList=['x' * 1200])
    queue = _Queue()

    fs.upload_files([fs.UploadedFile('a.md', b'A')], metadata, 'kb1', 'admin',
                    queue=queue)

    file_id = queue.handles[0]['fileId']
    assert (file_id, fs.TASK_CONFIG_PROP) not in db.properties


def test_persist_task_config_swallows_store_errors(db, monkeypatch):
    def broken_upsert(cursor, kbase_id, file_id, name, value):
        if name == fs.TASK_CONFIG_PROP:                        # 只让任务配置写失败
            raise RuntimeError('db down')

    monkeypatch.setattr(fs.directory_store, 'upsert_property', broken_upsert)
    queue = _Queue()

    result = fs.upload_files([fs.UploadedFile('a.md', b'A')], _metadata(),
                             'kb1', 'admin', queue=queue)

    assert result and queue.handles                            # 上传本身不失败


# ----------------------------------------------------------------------
# appendFileId 与行查找
# ----------------------------------------------------------------------


def test_validate_append_file_id_ignores_blank_but_rejects_whitespace():
    fs.validate_append_file_id('', 'kb1')                      # 空串 = 未传
    with pytest.raises(KbValidationError):                     # 纯空白不是合法 hex
        fs.validate_append_file_id('   ', 'kb1')


def test_find_existing_file_maps_row_by_description(monkeypatch):
    captured = {}

    class _Cursor:
        description = (('id',), ('title',))

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, sql, params):
            captured['sql'] = sql
            captured['params'] = params

        def fetchone(self):
            return ('old-id', 'a.md')

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(fs.directory_store, 'connection', lambda: _Conn())

    row = fs._find_existing_file('kb1', 'dir-1', 'a.md')

    assert row == {'id': 'old-id', 'title': 'a.md'}
    assert 'ORDER BY created_at DESC LIMIT 1' in captured['sql']
    assert captured['params'] == ('kb1', 'dir-1', 'a.md')


def test_parent_path_falls_back_to_root_symbol(monkeypatch):
    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, sql, params):
            pass

        def fetchone(self):
            return None

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(fs.directory_store, 'connection', lambda: _Conn())

    assert fs._parent_path('ghost') == '0'


def test_kbase_row_missing_is_business_error(monkeypatch):
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: None)

    with pytest.raises(KbApiError) as caught:
        fs._kbase_row('ghost')

    assert caught.value.key == 'kbase.not.exist'


# ----------------------------------------------------------------------
# 删除与下载
# ----------------------------------------------------------------------


def test_delete_files_delegates_to_write_service(monkeypatch):
    import knowledge_base.service.kbase_write_service as write_service

    captured = {}
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id',
                        lambda _: {'id': 1, 'kbase_id': 'kb1'})
    monkeypatch.setattr(write_service, '_purge_files',
                        lambda kbase_id, pk_id, file_ids, node_rel, storage:
                        captured.update(kbase_id=kbase_id, pk_id=pk_id,
                                        file_ids=file_ids))

    fs.delete_files('kb1', ['f1', 'f2'])

    assert captured == {'kbase_id': 'kb1', 'pk_id': 1, 'file_ids': ['f1', 'f2']}


def test_doc_download_requires_kbase_then_file(monkeypatch):
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: None)

    with pytest.raises(KbApiError) as caught:
        fs.doc_download_file('ghost', 'f1')
    assert caught.value.key == 'kbase.not.exist'

    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: {'kbase_id': 'kb1'})
    monkeypatch.setattr(fs.directory_store, 'get_directory', lambda *a, **k: None)

    with pytest.raises(KbApiError) as caught:
        fs.doc_download_file('kb1', 'ghost-file')
    assert caught.value.key == 'file.not.exist'


def test_doc_download_maps_missing_storage_to_file_not_exist(monkeypatch):
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: {'kbase_id': 'kb1'})
    monkeypatch.setattr(fs.directory_store, 'get_directory',
                        lambda *a, **k: {'id': 'f1'})
    monkeypatch.setattr(fs.storage, 'read_core_file',
                        lambda file_id: (_ for _ in ()).throw(FileNotFoundError(file_id)))

    with pytest.raises(KbApiError) as caught:
        fs.doc_download_file('kb1', 'f1')

    assert caught.value.key == 'file.not.exist'


def test_doc_download_returns_bytes(monkeypatch):
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: {'kbase_id': 'kb1'})
    monkeypatch.setattr(fs.directory_store, 'get_directory',
                        lambda *a, **k: {'id': 'f1'})
    monkeypatch.setattr(fs.storage, 'read_core_file', lambda file_id: b'content')

    assert fs.doc_download_file('kb1', 'f1') == b'content'


def test_local_files_reads_titles_and_skips_missing(monkeypatch):
    monkeypatch.setattr(fs.directory_store, 'connection', lambda: _DummyConn())
    rows = [('f1', 'a.md'), ('ghost', 'gone.md')]

    class _Cursor(_DummyCursor):
        def execute(self, sql, params):
            self.sql = sql

        def fetchall(self):
            return rows

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(fs.directory_store, 'connection', lambda: _Conn())
    monkeypatch.setattr(fs.storage, 'core_file_exists',
                        lambda file_id: file_id == 'f1')
    monkeypatch.setattr(fs.storage, 'read_core_file', lambda file_id: b'AAA')

    assert fs.local_files([], 'kb1') == []
    files = fs.local_files(['f1', '', None, 'ghost'], 'kb1')

    assert [(item.filename, item.content) for item in files] == [('a.md', b'AAA')]


# ----------------------------------------------------------------------
# 文件名工具
# ----------------------------------------------------------------------


@pytest.mark.parametrize('name, expected', [
    ('a.md', 'md'),
    ('a.tar.gz', 'gz'),
    ('noext', ''),
    ('/path/to/a.md', 'md'),
    ('C:\\path\\a.pdf', 'pdf'),
    ('.hidden', 'hidden'),
])
def test_file_extension(name, expected):
    assert fs._file_extension(name) == expected


@pytest.mark.parametrize('name, expected', [
    ('a.md', 'a'),
    ('a.tar.gz', 'a.tar'),
    ('noext', 'noext'),
    ('/path/to/a.md', 'a'),
    ('C:\\path\\a.pdf', 'a'),
])
def test_name_without_extension(name, expected):
    assert fs._name_without_extension(name) == expected


def test_size_limit_category_without_tier_is_server_error(monkeypatch):
    monkeypatch.setenv('MEM_LIMIT', '1024')
    monkeypatch.setattr(fs, '_custom_operator_formats', lambda: set())

    with pytest.raises(KbServerError):
        fs.file_size_limit(3)                                  # code-document 无档位
