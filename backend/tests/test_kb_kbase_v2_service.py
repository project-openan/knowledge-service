"""``kbase_v2_service``：图谱库的建库 / 改名 / 详情 / 删除四条链。

不连库：repository、DDL、索引、registry、graph_bridge、绑定检查全部用桩。

跑法（服务目录下）::

    python -m pytest tests/test_kb_kbase_v2_service.py -q
"""

from __future__ import annotations

import contextlib

import pytest

from shared.errors.api import KbApiError, KbStoreError
from knowledge_base.service import kbase_v2_service as v2
from knowledge_base.service import kbase_service


class _Stub:
    def __init__(self, **kwargs):
        self.calls = []
        for name, value in kwargs.items():
            setattr(self, name, value)


@pytest.fixture()
def env(monkeypatch):
    env = _Stub(
        inserted=[],
        created=[],
        created_indexes=[],
        registry=[],
        dropped=[],
        deleted_rows=[],
        by_name={},
        files_by_id={},
        chunk_tables=[],
        vector_tables=[],
        graph_calls=[],
        directories=[],
        updated_rows=[],
    )

    def find_kbases_by_name(name, org_id=None, exclude_id=None):
        return env.by_name.get(name, [])

    def count_files(kbase_id):
        return env.files_by_id.get(kbase_id, 0)

    def insert_kbase(**kwargs):
        env.inserted.append(kwargs)
        return 66

    def generate_kbase_id():
        return 'genid123'

    def delete_kbase_row(kbase_id):
        env.deleted_rows.append(kbase_id)

    def dummy_connection():
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

        return _Conn()

    monkeypatch.setattr(v2, 'kbase_store', _Stub(
        connection=dummy_connection,
        select_kbase_by_id=lambda kbase_id: env.kbase_row,
        find_kbases_by_name=find_kbases_by_name,
        count_files=count_files,
        insert_kbase=insert_kbase,
        generate_kbase_id=generate_kbase_id,
        delete_kbase_row=delete_kbase_row,
    ))

    class _DirStore:
        TYPE_FILE = 'file'

        @staticmethod
        def get_all_files(kbase_id):
            return env.directories

        @staticmethod
        def get_all_properties(ids):
            return {}

    monkeypatch.setattr(v2, 'directory_store', _DirStore)

    from infrastructure.db import ddl as ddl_module

    def create_vector_table(table, dimension=None):
        env.vector_tables.append(table)

    def create_chunk_table(table):
        env.created.append(table)

    def create_graph_chunk_table(table):
        env.chunk_tables.append(table)

    monkeypatch.setattr(ddl_module, 'create_vector_table', create_vector_table)
    monkeypatch.setattr(ddl_module, 'create_chunk_table', create_chunk_table)
    monkeypatch.setattr(ddl_module, 'create_graph_chunk_table', create_graph_chunk_table)

    monkeypatch.setattr(v2, 'index_service', _Stub(
        create_index=lambda kbase_id, keyword_analyzer=None:
            env.created_indexes.append((kbase_id, keyword_analyzer)),
        delete_index=lambda kbase_id: env.created_indexes.append(('delete', kbase_id)),
    ))
    monkeypatch.setattr(v2, 'storage_registry_store', _Stub(
        begin_create=lambda *args: env.registry.append(('begin_create', args)),
        mark_failed=lambda kbase_id, error: env.registry.append(('mark_failed', kbase_id)),
        mark_ready=lambda kbase_id: env.registry.append(('mark_ready', kbase_id)),
        begin_delete=lambda kbase_id: env.registry.append(('begin_delete', kbase_id)),
        remove=lambda kbase_id: env.registry.append(('remove', kbase_id)),
    ))
    monkeypatch.setattr(v2, 'ensure_known_embedding_model', lambda model: None)
    monkeypatch.setattr(v2, 'resolve_embedding_dimension', lambda model: 1024)
    monkeypatch.setattr(v2.graph_lifecycle, 'ensure_database',
                        lambda table: env.graph_calls.append(('ensure_db', table)))

    @contextlib.contextmanager
    def fake_lock(org_id, name, *args, **kwargs):
        yield

    monkeypatch.setattr(v2.name_lock, 'acquire', fake_lock)
    return env


def _payload(**overrides):
    payload = {'name': '图谱库', 'props': {'embeddingModel': 'bge-base'}}
    payload.update(overrides)
    return payload


# ----------------------------------------------------------------------
# 建库
# ----------------------------------------------------------------------


def test_v2_create_graph_kbase_skips_es_index(env):
    vo = v2.create_kbase(_payload(category=10), 'admin', 'org-1')

    assert vo['id'] == 'genid123' and vo['pkId'] == 66
    assert vo['name'] == '图谱库'
    assert vo['tableName'] is None                             # 窄 VO：五个字段以外全 null
    assert vo['headIcon'] is None

    inserted = env.inserted[0]
    assert inserted['table_name'] == 'graph_genid123'
    assert inserted['es_index_name'] == 'graph_genid123'
    assert inserted['category'] == 10
    assert inserted['file_count_limit'] == 50                  # 恒取 graph_kbase 档

    assert env.created_indexes == []                           # 图谱库不建 ES 索引
    assert env.chunk_tables == ['graph_genid123_chunk']        # 只建图谱 chunk 表
    assert env.vector_tables == []
    assert ('ensure_db', 'graph_genid123') in env.graph_calls
    assert env.directories == []                               # V2 不建默认目录


def test_v2_create_document_kbase_builds_vector_and_chunk_tables(env):
    v2.create_kbase(_payload(), 'admin', 'org-1')

    inserted = env.inserted[0]
    assert inserted['table_name'] == 'doc_genid123_vector'
    assert inserted['es_index_name'] == 'doc_genid123'
    assert env.vector_tables == ['doc_genid123_vector']
    assert env.created == ['doc_genid123_chunk']
    assert len(env.created_indexes) == 1


def test_v2_create_uses_client_kbase_id_when_given(env):
    v2.create_kbase(_payload(kbaseId='clientid123'), 'admin', 'org-1')

    assert env.inserted[0]['kbase_id'] == 'clientid123'
    assert env.inserted[0]['table_name'] == 'doc_clientid123_vector'


def test_v2_create_missing_props_is_npe(env):
    with pytest.raises(RuntimeError) as caught:
        v2.create_kbase({'name': 'kb', 'props': None}, 'admin', 'org-1')
    assert 'getProps()' in str(caught.value)


def test_v2_create_null_category_is_npe(env):
    with pytest.raises(RuntimeError) as caught:
        v2.create_kbase(_payload(category=None), 'admin', 'org-1')
    assert 'java.lang.Integer.equals' in str(caught.value)


def test_v2_create_duplicate_key_translates_to_exist(env, monkeypatch):
    def insert_kbase(**kwargs):
        raise KbStoreError(KbStoreError.DUPLICATE, 'dup', 'kbase_id already exists')

    monkeypatch.setattr(v2.kbase_store, 'insert_kbase', insert_kbase)

    with pytest.raises(KbApiError) as caught:
        v2.create_kbase(_payload(), 'admin', 'org-1')

    assert caught.value.key == 'kbase.exist'


def test_v2_create_lock_timeout_is_business_error(env, monkeypatch):
    @contextlib.contextmanager
    def busy_lock(org_id, name, *args, **kwargs):
        raise v2.name_lock.NameLockAcquireException('busy')
        yield                                                 # pragma: no cover

    monkeypatch.setattr(v2.name_lock, 'acquire', busy_lock)

    with pytest.raises(KbApiError) as caught:
        v2.create_kbase(_payload(), 'admin', 'org-1')

    assert caught.value.key == 'kbase.name.lock.timeout'


# ----------------------------------------------------------------------
# 同名复用
# ----------------------------------------------------------------------


def test_v2_reuse_refuses_category_mismatch(env):
    env.by_name['同名'] = [{'kbase_id': 'old', 'category': 1,
                            'table_name': 'doc_old_vector'}]

    with pytest.raises(KbApiError) as caught:
        v2.create_kbase(_payload(name='同名', category=10), 'admin', 'org-1')

    assert caught.value.key == 'kbase.exist'


def test_v2_reuse_refuses_table_prefix_mismatch(env):
    env.by_name['同名'] = [{'kbase_id': 'old', 'category': 10,
                            'table_name': 'doc_old_vector'}]   # 图谱库配了 doc_ 前缀

    with pytest.raises(KbApiError):
        v2.create_kbase(_payload(name='同名', category=10), 'admin', 'org-1')


def test_v2_reuse_refuses_non_empty_kbase(env):
    env.by_name['同名'] = [{'kbase_id': 'old', 'category': 10,
                            'table_name': 'graph_old'}]
    env.files_by_id['old'] = 2

    with pytest.raises(KbApiError):
        v2.create_kbase(_payload(name='同名', category=10), 'admin', 'org-1')


def test_v2_reuse_returns_full_vo_for_empty_same_category(env):
    env.by_name['同名'] = [{'kbase_id': 'old', 'category': 10, 'table_name': 'graph_old',
                            'kbase_id2': None, 'name': '同名'}]

    vo = v2.create_kbase(_payload(name='同名', category=10), 'admin', 'org-1')

    assert vo['id'] == 'old' and vo['name'] == '同名'
    assert 'currentFileCount' not in vo or vo.get('currentFileCount') is None
    assert env.inserted == []                                  # 复用不再插行


# ----------------------------------------------------------------------
# 改名
# ----------------------------------------------------------------------


def test_v2_update_rejects_name_conflict(env, monkeypatch):
    env.kbase_row = {'kbase_id': 'kb1'}
    env.by_name['占名'] = [{'kbase_id': 'other'}]

    with pytest.raises(KbApiError) as caught:
        v2.update_kbase('kb1', {'name': '占名'}, 'org-1', 'admin')

    assert caught.value.key == 'kbase.exist'
    assert env.updated_rows == []


def test_v2_update_writes_only_present_fields(env, monkeypatch):
    captured = {}

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, sql, params):
            captured['sql'] = sql
            captured['params'] = params

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(v2.kbase_store, 'connection', lambda: _Conn())

    v2.update_kbase('kb1', {'name': '新名'}, 'org-1', 'admin')

    assert 'name' in captured['sql'] and 'updated_by' in captured['sql']
    assert captured['params'] == ['新名', 'admin', 'kb1']


def test_v2_update_empty_payload_writes_nothing(env, monkeypatch):
    def _boom():
        raise AssertionError('空 payload 不应写库')

    monkeypatch.setattr(v2.kbase_store, 'connection', _boom)

    v2.update_kbase('kb1', {'description': None}, 'org-1', 'admin')   # 不抛


def test_v2_update_lock_timeout(env, monkeypatch):
    @contextlib.contextmanager
    def busy_lock(org_id, name, *args, **kwargs):
        raise v2.name_lock.NameLockAcquireException('busy')
        yield                                                 # pragma: no cover

    monkeypatch.setattr(v2.name_lock, 'acquire', busy_lock)

    with pytest.raises(KbApiError) as caught:
        v2.update_kbase('kb1', {'name': 'x1'}, 'org-1', 'admin')

    assert caught.value.key == 'kbase.name.lock.timeout'


# ----------------------------------------------------------------------
# 详情
# ----------------------------------------------------------------------


def test_v2_graph_detail_composite(env, monkeypatch):
    row = {'kbase_id': 'g1', 'category': 10, 'schema_obj': {'entities': []},
           'embedding_model': 'bge'}
    monkeypatch.setattr(kbase_service, 'get_kbase_detail', lambda kbase_id: {
        'id': kbase_id, 'schemaObj': row['schema_obj']})
    monkeypatch.setattr(kbase_service, 'get_kbase_row', lambda kbase_id: row)
    monkeypatch.setattr(v2, '_search_file_by_kb_id', lambda kbase_id: [{'id': 'f1'}])
    monkeypatch.setattr(v2.graph_lifecycle, 'count_graph_entities_and_edges',
                        lambda kbase_id: {'entity_num': 3, 'edge_num': 4})

    detail = v2.get_kbase_detail('g1')

    assert detail['schemaInfo'] == {'entities': []}            # 真值挪到 schemaInfo
    assert detail['data']['schemaObj'] == {}                   # data 里被置空 map
    assert detail['fileInfo'] == [{'id': 'f1'}]
    assert detail['stats'] == {'entity_num': 3, 'edge_num': 4}


def test_v2_graph_stats_none_for_document_kbase(monkeypatch):
    monkeypatch.setattr(kbase_service, 'get_kbase_row',
                        lambda _: {'kbase_id': 'kb1', 'category': 1})

    assert v2._graph_stats('kb1') is None


def test_v2_graph_stats_survives_graph_errors(monkeypatch):
    monkeypatch.setattr(kbase_service, 'get_kbase_row',
                        lambda _: {'kbase_id': 'g1', 'category': 10})

    def boom(kbase_id):
        raise RuntimeError('graph down')

    monkeypatch.setattr(v2.graph_lifecycle, 'count_graph_entities_and_edges', boom)

    assert v2._graph_stats('g1') is None


def test_search_file_by_kb_id_sets_file_size(monkeypatch):
    rows = [{'id': 'f1', 'kbase_id': 'kb1', 'title': 'a.md', 'type': 'file',
             'can_spread': True, 'parent_path': '0', 'status': 1}]
    monkeypatch.setattr(v2.directory_store, 'get_all_files', lambda kbase_id: rows)
    monkeypatch.setattr(v2.directory_store, 'get_properties',
                        lambda ids, name: {'f1': '10'})

    vos = v2._search_file_by_kb_id('kb1')

    assert vos[0]['fileSize'] == 10


def test_search_file_by_kb_id_swallows_store_errors(monkeypatch):
    def boom(kbase_id):
        raise RuntimeError('db down')

    monkeypatch.setattr(v2.directory_store, 'get_all_files', boom)

    assert v2._search_file_by_kb_id('kb1') == []


# ----------------------------------------------------------------------
# 删除
# ----------------------------------------------------------------------


def test_v2_delete_missing_numeric_id_is_permission_denied(env):
    env.kbase_row = None

    with pytest.raises(KbApiError) as caught:
        v2.delete_kbase('999')

    assert caught.value.key == 'permission.denied'


def test_v2_delete_missing_uuid_is_not_exist(env):
    env.kbase_row = None

    with pytest.raises(KbApiError) as caught:
        v2.delete_kbase('abc-def')

    assert caught.value.key == 'kbase.not.exist'


def test_v2_delete_graph_path_order(env, monkeypatch):
    env.kbase_row = {'kbase_id': 'g1', 'id': 5, 'category': 10}
    monkeypatch.setattr(v2, 'delete_directories_of_kbase',
                        lambda kbase_id: env.graph_calls.append(('dirs', kbase_id)))
    monkeypatch.setattr(v2.graph_lifecycle, 'delete_import_and_extract_tasks',
                        lambda kbase_id: env.graph_calls.append(('tasks', kbase_id)))
    monkeypatch.setattr(v2.graph_lifecycle, 'delete_graph_database',
                        lambda kbase_id: env.graph_calls.append(('graphdb', kbase_id)))
    monkeypatch.setattr(v2.graph_lifecycle, 'drop_chunk_and_vector_tables',
                        lambda kbase_id: env.graph_calls.append(('tables', kbase_id)))

    v2.delete_kbase('g1', 'admin')

    assert [step[0] for step in env.graph_calls] == [
        'dirs', 'tasks', 'graphdb', 'tables']
    assert env.deleted_rows == ['g1']                          # 行最后删
    assert env.registry[0][0] == 'begin_delete'
    assert ('remove', 'g1') in env.registry


def test_v2_delete_document_path(env, monkeypatch):
    from infrastructure.db import ddl as ddl_module

    env.kbase_row = {'kbase_id': 'kb1', 'id': 5, 'category': 1,
                     'table_name': 'doc_kb1_vector'}
    monkeypatch.setattr(v2, 'delete_directories_of_kbase',
                        lambda kbase_id: env.graph_calls.append(('dirs', kbase_id)))
    monkeypatch.setattr(ddl_module, 'drop_table',
                        lambda table: env.dropped.append(table))

    v2.delete_kbase('kb1', 'admin')

    assert [step[0] for step in env.graph_calls] == ['dirs']
    assert env.dropped == ['doc_kb1_vector', 'doc_kb1_chunk']
    assert ('delete', 'kb1') in env.created_indexes
    assert env.deleted_rows == ['kb1']


def test_v2_delete_wraps_unexpected_errors(env, monkeypatch):
    env.kbase_row = {'kbase_id': 'kb1', 'id': 5, 'category': 1,
                     'table_name': 'doc_kb1_vector'}

    def boom(kbase_id):
        raise RuntimeError('io error')

    monkeypatch.setattr(v2, 'delete_directories_of_kbase', boom)

    with pytest.raises(KbApiError) as caught:
        v2.delete_kbase('kb1', 'admin')

    assert caught.value.key == 'kbase.delete.fail'
    assert ('remove', 'kb1') not in env.registry


def test_v2_delete_api_error_passes_through(env, monkeypatch):
    env.kbase_row = {'kbase_id': 'kb1', 'id': 5, 'category': 1,
                     'table_name': 'doc_kb1_vector'}

    def boom(kbase_id):
        raise KbApiError('kbase.bound.by.workflow', 'wf-1')

    monkeypatch.setattr(v2, 'delete_directories_of_kbase', boom)

    with pytest.raises(KbApiError) as caught:
        v2.delete_kbase('kb1', 'admin')

    assert caught.value.key == 'kbase.bound.by.workflow'


# ----------------------------------------------------------------------
# 画布绑定前置检查
# ----------------------------------------------------------------------


def test_binding_precheck_disabled_without_provider(env, monkeypatch):
    monkeypatch.setattr(v2, '_workflow_binding_provider', None)

    v2._check_bound_by_workflow('kb1', 5, 'admin')             # 不抛


def test_binding_precheck_blocks_bound_kbase(env, monkeypatch):
    monkeypatch.setattr(v2, '_workflow_binding_provider',
                        lambda kbase_id, pk_id, emp_no: ['wf-1', 'wf-2'])

    with pytest.raises(KbApiError) as caught:
        v2._check_bound_by_workflow('kb1', 5, 'admin')

    assert caught.value.key == 'kbase.bound.by.workflow'
    assert caught.value.args == ('wf-1,wf-2',)


def test_binding_precheck_fails_open_on_provider_error(env, monkeypatch):
    def boom(kbase_id, pk_id, emp_no):
        raise RuntimeError('flow store down')

    monkeypatch.setattr(v2, '_workflow_binding_provider', boom)

    v2._check_bound_by_workflow('kb1', 5, 'admin')             # fail-open：不抛


def test_binding_provider_install(env, monkeypatch):
    seen = {}

    def provider(kbase_id, pk_id, emp_no):
        seen['args'] = (kbase_id, pk_id, emp_no)
        return []

    v2.set_workflow_binding_provider(provider)
    try:
        v2._check_bound_by_workflow('kb1', 5, 'admin')
    finally:
        monkeypatch.setattr(v2, '_workflow_binding_provider', None)

    assert seen['args'] == ('kb1', 5, 'admin')
