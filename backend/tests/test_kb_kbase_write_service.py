"""``kbase_write_service``：建库 / 删库 / 文件清理的三条链。

不连库：repository、DDL、索引、registry、graph_bridge 全部用桩替换；
``name_lock`` 直接替换成可控的上下文管理器。

跑法（服务目录下）::

    python -m pytest tests/test_kb_kbase_write_service.py -q
"""

from __future__ import annotations

import contextlib

import pytest

from shared.errors.api import KbApiError, KbStoreError, KbValidationError
from knowledge_base.service import kbase_write_service as ws


# ----------------------------------------------------------------------
# 请求体校验
# ----------------------------------------------------------------------


@pytest.mark.parametrize('name', [None, 'ab', 'ok-name_1 房间', 'x' * 30])
def test_validate_name_accepts_null_and_valid_names(name):
    # null 放行（随后在 DB 的 NOT NULL 上炸）；合法名放行
    ws._validate_name(name)


@pytest.mark.parametrize('name', ['a', 'bad/name', 'x' * 31])
def test_validate_name_rejects_invalid(name):
    with pytest.raises(KbValidationError) as caught:
        ws._validate_name(name)
    assert caught.value.key in ('kbase.name.validation', 'kbase.name.not.all.whitespace')


def test_validate_name_whitespace_only_is_rejected():
    with pytest.raises(KbValidationError):
        ws._validate_name('   ')


def test_validate_sizes_boundaries():
    ws._validate_sizes('x' * 1000, 'y' * 255)                  # 闭区间上界合法

    with pytest.raises(KbValidationError) as caught:
        ws._validate_sizes('x' * 1001, None)
    assert caught.value.key == 'description.validation'

    with pytest.raises(KbValidationError) as caught:
        ws._validate_sizes(None, 'y' * 256)
    assert caught.value.key == 'headIcon.validation'


def test_keyword_analyzer_precedence():
    assert ws._keyword_analyzer({'keywordAnalyzer': 'standard'}, 'zh-CN') == 'standard'
    assert ws._keyword_analyzer({}, 'zh-CN') == 'ik_smart'
    assert ws._keyword_analyzer({}, 'en-US') == 'english'
    assert ws._keyword_analyzer(None, '') == 'english'


# ----------------------------------------------------------------------
# 建库
# ----------------------------------------------------------------------


class _Stub:
    def __init__(self, **kwargs):
        self.calls = []
        for name, value in kwargs.items():
            setattr(self, name, value)


@pytest.fixture()
def write_env(monkeypatch):
    """把建库链上所有出网/落库的点换成桩。"""
    env = _Stub(
        inserted=[],
        files_by_name={},
        files_by_id={},
        created_tables=[],
        created_indexes=[],
        registry=[],
        dropped=[],
        deleted_rows=[],
        directories=[],
    )

    def find_kbases_by_name(name, org_id=None, exclude_id=None):
        return env.files_by_name.get((name, org_id), [])

    def count_files(kbase_id):
        return env.files_by_id.get(kbase_id, 0)

    def insert_kbase(**kwargs):
        env.inserted.append(kwargs)
        return 77

    def generate_kbase_id():
        return 'newkb123'

    def delete_kbase_row(kbase_id):
        env.deleted_rows.append(kbase_id)

    monkeypatch.setattr(ws, 'kbase_store', _Stub(
        select_kbase_by_id=lambda kbase_id: None,
        find_kbases_by_name=find_kbases_by_name,
        count_files=count_files,
        insert_kbase=insert_kbase,
        generate_kbase_id=generate_kbase_id,
        delete_kbase_row=delete_kbase_row,
    ))

    class _DirStore:
        TYPE_FOLDER = 'folder'
        TYPE_FILE = 'file'
        ROOT_DIRECTORY_SYMBOL = '0'

        @staticmethod
        def connection():
            class _Cursor:
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

                def execute(self, *args):
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

            return _Conn()

        @staticmethod
        def find_folder_by_title(cursor, kbase_id, parent_id, title):
            return None

        @staticmethod
        def insert_directory(cursor, kbase_id, parent_id, parent_path, title,
                             dir_type, status, **kwargs):
            env.directories.append((kbase_id, title))
            return 'dir-1'

    monkeypatch.setattr(ws, 'directory_store', _DirStore)

    monkeypatch.setattr(ws, 'ddl', _Stub(
        create_vector_table=lambda table, dimension=None: env.created_tables.append(table),
        create_chunk_table=lambda table: env.created_tables.append(table),
        drop_table=lambda table: env.dropped.append(table),
    ))
    monkeypatch.setattr(ws, 'storage_registry_store', _Stub(
        begin_create=lambda *args: env.registry.append(('begin_create', args)),
        mark_failed=lambda kbase_id, error: env.registry.append(('mark_failed', kbase_id)),
        mark_ready=lambda kbase_id: env.registry.append(('mark_ready', kbase_id)),
        begin_delete=lambda kbase_id: env.registry.append(('begin_delete', kbase_id)),
        remove=lambda kbase_id: env.registry.append(('remove', kbase_id)),
    ))
    monkeypatch.setattr(ws, 'index_service', _Stub(
        create_index=lambda kbase_id, keyword_analyzer=None:
            env.created_indexes.append((kbase_id, keyword_analyzer)),
        delete_index=lambda kbase_id: env.created_indexes.append(('delete', kbase_id)),
    ))
    monkeypatch.setattr(ws, 'ensure_known_embedding_model', lambda model: None)
    monkeypatch.setattr(ws, 'resolve_embedding_dimension', lambda model: 1024)

    @contextlib.contextmanager
    def fake_lock(org_id, name, *args, **kwargs):
        env.lock_key = (org_id, name)
        yield

    monkeypatch.setattr(ws.name_lock, 'acquire', fake_lock)
    return env


def _payload(**overrides):
    payload = {'name': '新建知识库', 'props': {'embeddingModel': 'bge-base'},
               'description': '说明'}
    payload.update(overrides)
    return payload


def test_create_kbase_happy_path_returns_narrow_vo(write_env):
    vo = ws.create_kbase(_payload(), 'admin', 'org-1', 'zh-CN')

    assert vo['id'] == 'newkb123' and vo['pkId'] == 77
    assert vo['name'] == '新建知识库'
    assert vo['tableName'] is None                             # 窄 VO：其余全 null
    assert vo['embeddingModel'] is None

    inserted = write_env.inserted[0]
    assert inserted['table_name'] == 'doc_newkb123_vector'
    assert inserted['es_index_name'] == 'doc_newkb123'
    assert inserted['category'] == 1 and inserted['status'] == 0
    assert inserted['file_count_limit'] == 5000

    assert write_env.created_tables == ['doc_newkb123_vector', 'doc_newkb123_chunk']
    assert write_env.created_indexes == [('newkb123', 'ik_smart')]   # zh-CN → ik_smart
    assert write_env.directories == [('newkb123', '默认文件夹')]
    assert write_env.registry[0][0] == 'begin_create'
    assert ('mark_ready', 'newkb123') in write_env.registry


def test_create_kbase_missing_props_is_npe(write_env):
    with pytest.raises(RuntimeError) as caught:
        ws.create_kbase({'name': 'kb', 'props': None}, 'admin', 'org-1')

    assert 'getProps()' in str(caught.value)


def test_create_kbase_invalid_name_is_rejected_before_side_effects(write_env):
    with pytest.raises(KbValidationError):
        ws.create_kbase(_payload(name='a'), 'admin', 'org-1')

    assert write_env.inserted == [] and write_env.created_tables == []


def test_create_kbase_reuses_empty_same_name_kbase(write_env, monkeypatch):
    write_env.files_by_name[('同名', 'org-1')] = [{'kbase_id': 'oldkb', 'name': '同名'}]
    write_env.files_by_id['oldkb'] = 0

    from knowledge_base.service import kbase_service
    monkeypatch.setattr(kbase_service, 'get_kbase_detail',
                        lambda kbase_id: {'id': kbase_id, 'reused': True})

    vo = ws.create_kbase(_payload(name='同名'), 'admin', 'org-1')

    assert vo == {'id': 'oldkb', 'reused': True}               # 复用走全量详情
    assert write_env.inserted == []


def test_create_kbase_rejects_same_name_with_files(write_env):
    write_env.files_by_name[('同名', 'org-1')] = [{'kbase_id': 'oldkb', 'name': '同名'}]
    write_env.files_by_id['oldkb'] = 3

    with pytest.raises(KbApiError) as caught:
        ws.create_kbase(_payload(name='同名'), 'admin', 'org-1')

    assert caught.value.key == 'kbase.exist'


def test_create_kbase_translates_duplicate_key_error(write_env, monkeypatch):
    def insert_kbase(**kwargs):
        raise KbStoreError(KbStoreError.DUPLICATE, 'dup', 'kbase_id already exists')

    monkeypatch.setattr(ws.kbase_store, 'insert_kbase', insert_kbase)

    with pytest.raises(KbApiError) as caught:
        ws.create_kbase(_payload(), 'admin', 'org-1')

    assert caught.value.key == 'kbase.exist'


def test_create_kbase_lock_timeout_is_business_error(write_env, monkeypatch):
    @contextlib.contextmanager
    def busy_lock(org_id, name, *args, **kwargs):
        raise ws.name_lock.NameLockAcquireException('busy')
        yield                                                 # pragma: no cover

    monkeypatch.setattr(ws.name_lock, 'acquire', busy_lock)

    with pytest.raises(KbApiError) as caught:
        ws.create_kbase(_payload(), 'admin', 'org-1')

    assert caught.value.key == 'kbase.name.lock.timeout'


def test_create_kbase_table_failure_marks_registry_failed(write_env, monkeypatch):
    def broken_create(table, dimension=None):
        raise RuntimeError('no such schema')

    monkeypatch.setattr(ws.ddl, 'create_vector_table', broken_create)

    with pytest.raises(RuntimeError):
        ws.create_kbase(_payload(), 'admin', 'org-1')

    assert ('mark_failed', 'newkb123') in write_env.registry
    assert all(step[0] != 'mark_ready' for step in write_env.registry)


# ----------------------------------------------------------------------
# 删库
# ----------------------------------------------------------------------


def test_delete_kbase_missing_row_is_business_error(write_env, monkeypatch):
    monkeypatch.setattr(ws.kbase_store, 'select_kbase_by_id', lambda _: None)

    with pytest.raises(KbApiError) as caught:
        ws.delete_kbase('ghost')

    assert caught.value.key == 'kbase.not.exist'


def test_delete_kbase_delegates_graph_category_to_v2(write_env, monkeypatch):
    monkeypatch.setattr(ws.kbase_store, 'select_kbase_by_id',
                        lambda _: {'kbase_id': 'g1', 'category': 10, 'id': 5})
    delegated = []

    from knowledge_base.service import kbase_v2_service
    monkeypatch.setattr(kbase_v2_service, 'delete_kbase',
                        lambda kbase_id, emp_no: delegated.append((kbase_id, emp_no)))

    ws.delete_kbase('g1', 'admin')

    assert delegated == [('g1', 'admin')]


def test_delete_kbase_rejects_non_empty_kbase(write_env, monkeypatch):
    monkeypatch.setattr(ws.kbase_store, 'select_kbase_by_id',
                        lambda _: {'kbase_id': 'kb1', 'category': 1, 'id': 5,
                                   'table_name': 'doc_kb1_vector'})
    monkeypatch.setattr(ws.kbase_store, 'count_files', lambda _: 2)

    with pytest.raises(KbApiError) as caught:
        ws.delete_kbase('kb1')

    assert caught.value.key == 'kbase.can.not.delete.include.knowledge'
    assert write_env.registry == []                            # 未动 registry


def test_delete_kbase_happy_path_drops_tables_and_index(write_env, monkeypatch):
    monkeypatch.setattr(ws.kbase_store, 'select_kbase_by_id',
                        lambda _: {'kbase_id': 'kb1', 'category': 1, 'id': 5,
                                   'table_name': 'doc_kb1_vector'})
    monkeypatch.setattr(ws.kbase_store, 'count_files', lambda _: 0)

    class _Dir:
        TYPE_FILE = 'file'

        @staticmethod
        def get_all_folders(kbase_id):
            return []

        @staticmethod
        def get_children(kbase_id, parent_id, dir_type=None):
            return []

    monkeypatch.setattr(ws, 'directory_store', _Dir)

    ws.delete_kbase('kb1', 'admin')

    assert write_env.dropped == ['doc_kb1_vector', 'doc_kb1_chunk']
    assert ('delete', 'kb1') in write_env.created_indexes
    assert write_env.deleted_rows == ['kb1']
    assert ('remove', 'kb1') in write_env.registry


def test_chunk_table_name_falls_back_to_pk():
    assert ws.chunk_table_name('doc_kb1_vector', 7) == 'doc_kb1_chunk'
    assert ws.chunk_table_name('', 7).startswith('doc_7')


# ----------------------------------------------------------------------
# 目录级联删除与文件清理
# ----------------------------------------------------------------------


def test_delete_directories_of_kbase_returns_without_row(monkeypatch):
    monkeypatch.setattr(ws.kbase_store, 'select_kbase_by_id', lambda _: None)

    ws.delete_directories_of_kbase('ghost')                    # 不抛


def test_delete_one_directory_purges_files_and_deletes_folders(monkeypatch):
    from knowledge_base.repository import directory as real_dir

    descendants = [
        {'id': 'f1', 'type': 'file'},
        {'id': 'sub', 'type': 'folder'},
        {'id': 'f2', 'type': 'file'},
    ]
    purged = []
    deleted = []
    monkeypatch.setattr(real_dir, 'get_descendants',
                        lambda kbase_id, directory_id: descendants)
    monkeypatch.setattr(ws, '_purge_files',
                        lambda kbase_id, pk_id, file_ids, node_rel, storage:
                        purged.append(list(file_ids)))

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, *args):
            deleted.append(True)

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(real_dir, 'connection', lambda: _Conn())
    monkeypatch.setattr(real_dir, 'delete_folders', lambda cursor, ids: deleted.append(ids))

    ws._delete_one_directory('kb1', 5, 'dir-1', storage=None)

    assert purged == [['f1', 'f2']]
    assert deleted[-1] == ['sub', 'dir-1']


def test_purge_files_noop_without_file_ids(monkeypatch):
    def _boom():
        raise AssertionError('空清单不应触碰任何存储')

    class _Boom:
        def __getattr__(self, name):
            return _boom

    ws._purge_files('kb1', 5, [], _Boom(), _Boom())


def test_purge_files_order_for_document_kbase(monkeypatch):
    """顺序：取名字 → 删 relation → 删 ES → 删属性行 → 删行 → 删磁盘。"""
    from knowledge_base.repository import directory as real_dir
    from knowledge_base.repository import node_relation as real_rel

    calls = []
    monkeypatch.setattr(real_dir, 'titles_by_ids',
                        lambda kbase_id, ids: calls.append(('titles', list(ids))) or ['a.md'])
    monkeypatch.setattr(real_rel, 'delete_by_directory_ids',
                        lambda pk_id, ids: calls.append(('relation', list(ids))))

    class _Row:
        def __init__(self, row):
            self._row = row

        def get(self, key, default=None):
            return self._row.get(key, default)

    monkeypatch.setattr(ws.kbase_store, 'select_kbase_by_id',
                        lambda _: {'kbase_id': 'kb1', 'id': 5,
                                   'table_name': 'doc_kb1_vector', 'category': 1})
    monkeypatch.setattr(ws.write_service, 'delete_es_documents_by_query',
                        lambda kbase_id, field, ids:
                        calls.append(('es', field, list(ids))))
    monkeypatch.setattr(ws.graph_lifecycle, 'delete_chunks_by_sources',
                        lambda table, names: calls.append(('chunks', table, list(names))))
    monkeypatch.setattr(real_dir, 'delete_properties_by_file_ids',
                        lambda kbase_id, ids: calls.append(('props', list(ids))))

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, *args):
            pass

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(real_dir, 'connection', lambda: _Conn())
    monkeypatch.setattr(real_dir, 'delete_files',
                        lambda cursor, kbase_id, ids: calls.append(('rows', list(ids))))

    storage_calls = []

    class _Storage:
        @staticmethod
        def delete_core_file(file_id):
            storage_calls.append(file_id)

    ws._purge_files('kb1', 5, ['f1', 'f2'], real_rel, _Storage)

    assert calls[0] == ('titles', ['f1', 'f2'])
    assert calls[1] == ('relation', ['f1', 'f2'])
    assert calls[2] == ('es', 'file_id', ['f1', 'f2'])
    assert calls[3] == ('chunks', 'doc_kb1_vector', ['a.md'])
    assert calls[4] == ('props', ['f1', 'f2'])
    assert calls[5] == ('rows', ['f1', 'f2'])
    assert storage_calls == ['f1', 'f2']


def test_purge_files_skips_es_and_chunks_without_table_name(monkeypatch):
    from knowledge_base.repository import directory as real_dir
    from knowledge_base.repository import node_relation as real_rel

    calls = []
    monkeypatch.setattr(real_dir, 'titles_by_ids', lambda kbase_id, ids: ['a.md'])
    monkeypatch.setattr(real_rel, 'delete_by_directory_ids', lambda pk_id, ids: None)
    monkeypatch.setattr(ws.kbase_store, 'select_kbase_by_id',
                        lambda _: {'kbase_id': 'kb1', 'id': 5, 'table_name': None,
                                   'category': 1})

    def _boom(*args, **kwargs):
        raise AssertionError('table_name 为空时不应清索引')

    monkeypatch.setattr(ws.write_service, 'delete_es_documents_by_query', _boom)
    monkeypatch.setattr(ws.graph_lifecycle, 'delete_chunks_by_sources', _boom)
    monkeypatch.setattr(real_dir, 'delete_properties_by_file_ids',
                        lambda kbase_id, ids: calls.append('props'))

    class _Noop:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, *args):
            pass

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return _Noop()

    monkeypatch.setattr(real_dir, 'connection', lambda: _Conn())
    monkeypatch.setattr(real_dir, 'delete_files',
                        lambda cursor, kbase_id, ids: calls.append('rows'))

    class _Storage:
        @staticmethod
        def delete_core_file(file_id):
            storage_calls.append(file_id)

    storage_calls = []
    ws._purge_files('kb1', 5, ['f1'], real_rel, _Storage)

    assert calls == ['props', 'rows']
    assert storage_calls == ['f1']


def test_purge_files_graph_branch_deletes_source_graph_data(monkeypatch):
    from knowledge_base.repository import directory as real_dir
    from knowledge_base.repository import node_relation as real_rel

    calls = []
    monkeypatch.setattr(real_dir, 'titles_by_ids', lambda kbase_id, ids: ['a.md'])
    monkeypatch.setattr(real_rel, 'delete_by_directory_ids', lambda pk_id, ids: None)
    monkeypatch.setattr(ws.kbase_store, 'select_kbase_by_id',
                        lambda _: {'kbase_id': 'kb1', 'id': 5,
                                   'table_name': 'graph_kb1', 'category': 10})
    monkeypatch.setattr(ws.graph_lifecycle, 'chunk_ids_for_sources',
                        lambda table, names: calls.append(('chunk_ids',)) or ['c1'])
    monkeypatch.setattr(ws.graph_lifecycle, 'delete_source_graph_data',
                        lambda table, kbase_id, chunk_ids:
                        calls.append(('graph', table, kbase_id, chunk_ids)))
    monkeypatch.setattr(ws.write_service, 'delete_es_documents_by_query',
                        lambda kbase_id, field, ids: None)
    monkeypatch.setattr(ws.graph_lifecycle, 'delete_chunks_by_sources',
                        lambda table, names: calls.append(('chunks',)))

    class _Noop:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, *args):
            pass

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return _Noop()

    monkeypatch.setattr(real_dir, 'connection', lambda: _Conn())
    monkeypatch.setattr(real_dir, 'delete_files',
                        lambda cursor, kbase_id, ids: None)
    monkeypatch.setattr(real_dir, 'delete_properties_by_file_ids',
                        lambda kbase_id, ids: None)

    class _Storage:
        @staticmethod
        def delete_core_file(file_id):
            pass

    ws._purge_files('kb1', 5, ['f1'], real_rel, _Storage)

    assert ('graph', 'graph_kb1', 'kb1', ['c1']) in calls
