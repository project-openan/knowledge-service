"""graph_import_api.import_graph 的主流程（桩 kbase / 任务车道 / 存储）。

钉：错误阶梯的**报错优先级**（desc → name/desc 校验 → id 格式 → 两个 jsonl →
schema.json 找不到是 illegal、解析不了是 fail）；``_ensure_kbase`` 的复用与
新建分支；任务准入 503。

跑法::

    python -m pytest tests/test_graph_import_api_flow.py -q
"""

from __future__ import annotations

import json
import zipfile

import pytest

from graph.service import graph_import_api as api
from shared.errors.api import KbApiError, KbLiteralError, KbStoreError

VALID_DESC = {'name': '导入库', 'embedding': 'bge-base-zh-v1.5', 'desc': '描述',
              'id': 'graph_' + 'a' * 16}
VALID_SCHEMA = {
    'schema_id': 's-1', 'schema_name': '模板', 'schema_desc': 'd',
    'entities': [{'entity_type': 'Person', 'entity_desc': '人', 'properties': [
        {'name': 'p', 'type': 'STRING', 'desc': '主键', 'is_primary': True}]}],
    'edges': [],
}


def _zip_bytes(entries):
    import io

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def _valid_zip():
    return _zip_bytes({
        'desc.json': json.dumps(VALID_DESC, ensure_ascii=False).encode(),
        'schema.json': json.dumps(VALID_SCHEMA, ensure_ascii=False).encode(),
        'entities.jsonl': b'{"entity_type": "Person", "entity_id": "P1"}',
        'edges.jsonl': b'',
    })


@pytest.fixture()
def import_env(monkeypatch, tmp_path):
    import knowledge_base.name_lock as name_lock
    import knowledge_base.service.kbase_service as kbase_store
    from knowledge_base.service import kbase_v2_service
    from graph import task_runtime
    from graph.repository import graph_import_store
    from infrastructure.storage import kb_storage as storage

    # 名字锁在测试里不做真实文件锁（那会写 /data/kb/.locks）
    import contextlib

    @contextlib.contextmanager
    def fake_acquire(org_id, name, **kwargs):
        yield None

    monkeypatch.setattr(name_lock, 'acquire', fake_acquire)

    state = {'capacity': 'ok', 'rows': {}, 'by_name': {}, 'files': 0,
             'inserted': [], 'created_tasks': [], 'submitted': [],
             'tables': [], 'schemas': [], 'marked': [], 'tmp': str(tmp_path)}

    monkeypatch.setattr(task_runtime, 'ensure_import_capacity',
                        lambda: state.update(capacity='ok'))
    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb_id: state['rows'].get(kb_id))
    monkeypatch.setattr(kbase_store, 'find_kbases_by_name',
                        lambda name, org_id, exclude_id=None:
                        [row for row in state['by_name'].get(name, [])
                         if row.get('kbase_id') != exclude_id])
    monkeypatch.setattr(kbase_store, 'count_files', lambda kb_id: state['files'])
    monkeypatch.setattr(kbase_store, 'generate_kbase_id', lambda: 'new-id-1234')
    def fake_insert(**kwargs):
        state['inserted'].append(kwargs)
        # insert 后 import 会回查 get_kbase_row(new_id)
        state['rows'][kwargs['kbase_id']] = {
            'kbase_id': kwargs['kbase_id'], 'name': kwargs.get('name'),
            'description': kwargs.get('description'),
            'embedding_model': kwargs.get('embedding_model'),
            'category': kwargs.get('category')}
        return 'pk-1'

    monkeypatch.setattr(kbase_store, 'insert_kbase', fake_insert)
    monkeypatch.setattr(kbase_store, 'update_process_with_time',
                        lambda kb, status, progress:
                        state['marked'].append((kb, status, progress)))
    monkeypatch.setattr(kbase_store, 'update_schema',
                        lambda kb, schema_id, obj:
                        state['schemas'].append((kb, schema_id)))
    monkeypatch.setattr(kbase_v2_service, '_create_tables',
                        lambda table, dim, category=None:
                        state['tables'].append((table, dim, category)))
    # graph_import_api 顶部 from-import 绑定了名字 → 要 patch 它自己的引用
    monkeypatch.setattr(api, 'ensure_known_embedding_model', lambda model: None)
    monkeypatch.setattr(api, 'resolve_embedding_dimension', lambda model: 4)
    monkeypatch.setattr(graph_import_store, 'create_task',
                        lambda task_id, kb, schema_id, **kwargs:
                        state['created_tasks'].append((task_id, kb, schema_id)))
    monkeypatch.setattr(task_runtime, 'submit_import',
                        lambda payload, task_id:
                        state['submitted'].append((task_id, payload)))
    monkeypatch.setattr(storage, 'scratch_root', lambda: tmp_path)

    yield state


# ----------------------------------------------------------------------
# 准入与大小
# ----------------------------------------------------------------------


def test_queue_full_is_503(import_env, monkeypatch):
    from graph import task_runtime
    from infrastructure.tasks import TaskRejectedError

    monkeypatch.setattr(task_runtime, 'ensure_import_capacity',
                        lambda: (_ for _ in ()).throw(TaskRejectedError('full')))
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', _valid_zip(), 'emp', None)
    assert caught.value.status == 503


def test_size_limits_are_enforced(import_env, monkeypatch):
    monkeypatch.setattr(api, 'MAX_FILE_SIZE_MB', 0)
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', b'x', 'emp', None)
    assert 'file.size.limit.check' in caught.value.key

    monkeypatch.setattr(api, 'MAX_FILE_SIZE_MB', 500)
    monkeypatch.setattr(api, 'MAX_EXTRACTED_SIZE_MB', 0)
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', _valid_zip(), 'emp', None)
    assert 'file.size.limit.check' in caught.value.key


# ----------------------------------------------------------------------
# 错误阶梯
# ----------------------------------------------------------------------


def test_missing_or_illegal_desc(import_env):
    entries = {'schema.json': b'{}', 'entities.jsonl': b'x', 'edges.jsonl': b'x'}
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', _zip_bytes(entries), 'emp', None)
    assert 'Retcode.graph.import.illegal' in caught.value.key

    entries['desc.json'] = json.dumps({'name': '  ', 'embedding': ''}).encode()
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', _zip_bytes(entries), 'emp', None)
    assert 'Retcode.graph.import.illegal' in caught.value.key


def test_name_and_desc_validators_become_0005(import_env, monkeypatch):

    def boom(name):
        raise KbApiError('kbase.name.validation', code='0004')

    monkeypatch.setattr(api, '_validate_name', boom)
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', _valid_zip(), 'emp', None)
    # 键不变、码升为 0005
    assert 'kbase.name.validation' in caught.value.key
    assert caught.value.code == '0005'


def test_optional_id_format_ladder(import_env):
    def zip_with(id_value):
        desc = dict(VALID_DESC, id=id_value)
        return _zip_bytes({
            'desc.json': json.dumps(desc, ensure_ascii=False).encode(),
            'schema.json': json.dumps(VALID_SCHEMA).encode(),
            'entities.jsonl': b'x', 'edges.jsonl': b'y'})

    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', zip_with('zzz'), 'emp', None)
    assert 'graph.import.id.format.invalid.prefix' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', zip_with('graph_abc'), 'emp', None)
    assert 'graph.import.id.format.invalid.length' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', zip_with('graph_' + 'g' * 16), 'emp', None)
    assert 'graph.import.id.format.invalid.char' in caught.value.key


def test_base_bundle_turns_id_errors_into_generic_fail(import_env):
    desc = dict(VALID_DESC, id='zzz')
    content = _zip_bytes({
        'desc.json': json.dumps(desc, ensure_ascii=False).encode(),
        'schema.json': json.dumps(VALID_SCHEMA).encode(),
        'entities.jsonl': b'x', 'edges.jsonl': b'y'})
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', content, 'emp', None, base_bundle=True)
    assert 'Retcode.graph.import.fail' in caught.value.key


def test_missing_jsonl_entries_before_schema(import_env):
    content = _zip_bytes({
        'desc.json': json.dumps(VALID_DESC).encode(),
        'schema.json': json.dumps(VALID_SCHEMA).encode(),
        'edges.jsonl': b'x'})
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', content, 'emp', None)
    assert 'graph.import.entities.file.required' in caught.value.key

    content = _zip_bytes({
        'desc.json': json.dumps(VALID_DESC).encode(),
        'schema.json': json.dumps(VALID_SCHEMA).encode(),
        'entities.jsonl': b'x'})
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', content, 'emp', None)
    assert 'graph.import.edges.file.required' in caught.value.key


def test_schema_json_missing_vs_unparseable(import_env):
    content = _zip_bytes({
        'desc.json': json.dumps(VALID_DESC).encode(),
        'entities.jsonl': b'x', 'edges.jsonl': b'y'})
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', content, 'emp', None)
    assert 'Retcode.graph.import.illegal' in caught.value.key

    content = _zip_bytes({
        'desc.json': json.dumps(VALID_DESC).encode(),
        'schema.json': b'not-json',
        'entities.jsonl': b'x', 'edges.jsonl': b'y'})
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', content, 'emp', None)
    assert 'Retcode.graph.import.fail' in caught.value.key


def test_invalid_schema_key_is_kept_but_code_is_0005(import_env):
    broken_schema = dict(VALID_SCHEMA, entities=[])
    content = _zip_bytes({
        'desc.json': json.dumps(VALID_DESC).encode(),
        'schema.json': json.dumps(broken_schema).encode(),
        'entities.jsonl': b'x', 'edges.jsonl': b'y'})
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', content, 'emp', None)
    assert caught.value.code == '0005'
    assert 'entities.not.empty' in caught.value.key


def test_unexpected_schema_validation_error_is_fail(import_env, monkeypatch):
    def boom(schema):
        raise RuntimeError('validator down')

    from graph.service import graph_schema_service
    monkeypatch.setattr(graph_schema_service, 'validate_graph_schema_obj', boom)
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', _valid_zip(), 'emp', None)
    assert 'Retcode.graph.import.fail' in caught.value.key


# ----------------------------------------------------------------------
# _ensure_kbase
# ----------------------------------------------------------------------


def test_import_creates_new_kbase_and_submits(import_env):
    api.import_graph('g.zip', _valid_zip(), 'emp', 'org-1')
    assert import_env['inserted'], '新建库'
    inserted = import_env['inserted'][0]
    assert inserted['kbase_id'] == 'a' * 16           # desc.json 的 id
    assert inserted['table_name'] == 'graph_' + 'a' * 16
    assert inserted['category'] == api.CATEGORY_KNOWLEDGE_GRAPH
    assert import_env['tables'] == [('graph_' + 'a' * 16, 4, 10)]
    assert import_env['schemas'] == [('a' * 16, VALID_SCHEMA.get('schema_id'))]
    assert import_env['marked'] == [('a' * 16, '4', 0)]   # 202 前先落「入库中」
    assert import_env['created_tasks']
    kb_index_name = import_env['created_tasks'][0][1]
    assert kb_index_name == 'graph_' + 'a' * 16
    assert import_env['submitted']


def test_import_rejects_without_entities_after_kbase_created(import_env):
    content = _zip_bytes({
        'desc.json': json.dumps(VALID_DESC).encode(),
        'schema.json': json.dumps(VALID_SCHEMA).encode(),
        'edges.jsonl': b'x'})
    with pytest.raises(KbApiError):
        api.import_graph('g.zip', content, 'emp', None)


def test_existing_id_with_same_content_reused(import_env):
    import_env['rows']['a' * 16] = {
        'kbase_id': 'a' * 16, 'name': VALID_DESC['name'],
        'description': VALID_DESC['desc'], 'embedding_model': VALID_DESC['embedding'],
        'category': 10, 'table_name': 'graph_' + 'a' * 16}
    api.import_graph('g.zip', _valid_zip(), 'emp', None)
    assert import_env['inserted'] == []               # 复用，不新建
    assert import_env['marked'] == [('a' * 16, '4', 0)]


def test_existing_id_with_mismatch_reports_joined_problems(import_env):
    import_env['rows']['a' * 16] = {
        'kbase_id': 'a' * 16, 'name': '别的名字', 'description': '别的描述',
        'embedding_model': '别的模型', 'category': 1}
    with pytest.raises(KbLiteralError) as caught:
        api.import_graph('g.zip', _valid_zip(), 'emp', None)
    message = caught.value.render('zh') or ''
    assert '；' in message
    assert 'category' in message and 'name字段' in message and 'embedding' in message


def test_reuse_candidate_must_be_empty_graph_kbase(import_env):
    candidate = {'kbase_id': 'kb-old', 'name': VALID_DESC['name'],
                 'category': 1, 'table_name': 'graph_kb-old'}
    import_env['by_name'][VALID_DESC['name']] = [candidate]

    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', _valid_zip(), 'emp', None)
    assert 'kbase.exist' in caught.value.key

    candidate = {**candidate, 'category': 10, 'table_name': 'doc_kb-old'}
    import_env['by_name'][VALID_DESC['name']] = [candidate]
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', _valid_zip(), 'emp', None)
    assert 'kbase.exist' in caught.value.key

    candidate = {**candidate, 'table_name': 'graph_kb-old'}
    import_env['by_name'][VALID_DESC['name']] = [candidate]
    import_env['files'] = 3
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', _valid_zip(), 'emp', None)
    assert 'kbase.exist' in caught.value.key

    # 空的同名图谱库 → 复用（沿用旧 id），schema 覆写
    import_env['files'] = 0
    api.import_graph('g.zip', _valid_zip(), 'emp', None)
    assert import_env['schemas'][-1][0] == 'kb-old'
    assert import_env['inserted'] == []


def test_duplicate_insert_conflict_is_kbase_exist(import_env, monkeypatch):
    import knowledge_base.service.kbase_service as kbase_store

    def duplicate(**kwargs):
        raise KbStoreError(KbStoreError.DUPLICATE, 'dup')

    monkeypatch.setattr(kbase_store, 'insert_kbase', duplicate)
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', _valid_zip(), 'emp', None)
    assert 'kbase.exist' in caught.value.key

    monkeypatch.setattr(kbase_store, 'insert_kbase',
                        lambda **kwargs: (_ for _ in ()).throw(
                            KbStoreError(KbStoreError.DB_ERROR, 'disk')))
    with pytest.raises(KbStoreError):
        api.import_graph('g.zip', _valid_zip(), 'emp', None)


def test_name_lock_timeout_is_business_error(import_env, monkeypatch):
    import knowledge_base.name_lock as name_lock

    def timeout(org_id, name, **kwargs):
        raise name_lock.NameLockAcquireException()

    monkeypatch.setattr(name_lock, 'acquire', timeout)
    with pytest.raises(KbApiError) as caught:
        api.import_graph('g.zip', _valid_zip(), 'emp', None)
    assert 'kbase.name.lock.timeout' in caught.value.key


def test_mark_importing_without_id_is_noop(import_env):
    api._mark_importing(None)
    assert import_env['marked'] == []


# ----------------------------------------------------------------------
# 解压细节
# ----------------------------------------------------------------------


def test_unzip_skips_dirs(import_env):
    content = _zip_bytes({'dir/': b'', 'desc.json': b'{}'})
    entries = api._unzip(content)
    assert list(entries) == ['desc.json']


def test_write_temp_zip_dedupes_basename(import_env, monkeypatch, tmp_path):
    from infrastructure.storage import kb_storage as storage
    monkeypatch.setattr(storage, 'scratch_root', lambda: tmp_path)
    entries = {
        'nested/dir/entities.jsonl': b'NESTED',
        'entities.jsonl': b'ROOT',
        'document_chunk.jsonl': b'C1',
    }
    path = api._write_temp_zip(entries)
    with zipfile.ZipFile(path) as archive:
        assert sorted(archive.namelist()) == ['document_chunk.jsonl', 'entities.jsonl']
        assert archive.read('entities.jsonl') == b'ROOT'   # 根目录精确名优先
