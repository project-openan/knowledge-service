"""graph_import_engine.import_from_zip 的终态机（桩图存储 / 索引 / 任务行）。

钉三条不变量：

1. **返回前任务必为终态**：clean → COMPLETED；有失败 → COMPLETED_WITH_ERRORS；
   异常 → FAILED；取消 → CANCELLED；
2. 计数 ``total == success + failed``（拒绝路径也计 total）；
3. 终态回写 ``kb_kbase``：5（成功）/ 104（有失败，带原因）。

跑法::

    python -m pytest tests/test_graph_import_engine_flow.py -q
"""

from __future__ import annotations

import json
import zipfile

import pytest

from graph.service import graph_import_engine as geng
from graph.repository import graph_import_store as store
from infrastructure.tasks.cancellation import TaskCancelled

SCHEMA = {
    'schema_id': 's-1',
    'entities': [{'entity_type': 'Person'}],
    'edges': [{'edge_type': 'Knows', 'source_entity': 'Person', 'target_entity': 'Person'}],
}


def make_zip(tmp_path, entries):
    path = tmp_path / 'graph.zip'
    with zipfile.ZipFile(path, 'w') as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload)
    return str(path)


@pytest.fixture()
def engine(monkeypatch, tmp_path):
    """桩掉图存储、向量索引、任务行与 kbase 终态回写。"""
    from knowledge_base.service import kbase_service as kbase_store

    state = {'settled': [], 'progress': [], 'statuses': [], 'created': [],
             'present': set(), 'fail_upserts': False, 'index_error': None,
             'verify_error': None, 'cancelled': []}

    monkeypatch.setattr(store, 'create_task',
                        lambda task_id, kb, schema_id, **kwargs:
                        state['created'].append((task_id, kb, schema_id,
                                                 kwargs.get('lane'))))
    monkeypatch.setattr(store, 'update_status',
                        lambda task_id, status, message=None:
                        state['statuses'].append((status, message)))
    monkeypatch.setattr(store, 'update_progress',
                        lambda task_id, progress, entity, edge:
                        state['progress'].append(progress))
    monkeypatch.setattr(store, 'cancel_task',
                        lambda task_id, **kwargs: state['cancelled'].append(task_id))

    from graph.repository import graph_pg
    monkeypatch.setattr(graph_pg, 'ensure_database_exists', lambda client, name: True)
    from types import SimpleNamespace
    monkeypatch.setattr(graph_pg, 'new_client',
                        lambda dbname: SimpleNamespace(dbname=dbname))

    def fake_bulk(dbname, rows):
        if state['fail_upserts']:
            raise RuntimeError('bulk down')
        state['present'].update(row[1] for row in rows)

    monkeypatch.setattr(graph_pg, 'upsert_entities_bulk', fake_bulk)

    def fake_bulk_edges(dbname, rows):
        if state['fail_upserts']:
            raise RuntimeError('bulk down')
        if not state.get('drop_edge_present'):
            state['present'].update(row[1] for row in rows)

    monkeypatch.setattr(graph_pg, 'upsert_edges_bulk', fake_bulk_edges)
    monkeypatch.setattr(graph_pg, 'upsert_entity',
                        lambda dbname, t, eid, props, labels: (_ for _ in ()).throw(
                            RuntimeError('row down')))
    monkeypatch.setattr(graph_pg, 'upsert_edge',
                        lambda dbname, t, eid, s, tg, props, labels: (_ for _ in ()).throw(
                            RuntimeError('row down')))
    def fake_present(dbname, id_field, ids):
        if state['verify_error']:
            raise RuntimeError(state['verify_error'])
        return {i for i in ids if i in state['present']}

    monkeypatch.setattr(graph_pg, 'present_ids', fake_present)

    monkeypatch.setattr(geng, 'build_pg_index', lambda *a, **k: (
        (_ for _ in ()).throw(RuntimeError(state['index_error']))
        if state['index_error'] else {'entities': 1}))

    monkeypatch.setattr(kbase_store, 'update_process_with_time',
                        lambda kb_id, status, progress:
                        state['settled'].append((kb_id, status, progress)))
    monkeypatch.setattr(kbase_store, 'update_fail_reason',
                        lambda kb_id, zh, en:
                        state.setdefault('reasons', []).append((kb_id, zh, en)))

    from infrastructure.db import kb as db
    registry = []

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=None):
            registry.append((sql.split(' ')[0], params))

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(db, 'connection', lambda: _Conn())
    state['registry'] = registry
    return state


def _zip_with(tmp_path, entities=None, edges=None):
    entities = entities if entities is not None else [
        {'entity_type': 'Person', 'entity_id': 'P1', 'properties': {'name': 'x'}}]
    edges = edges if edges is not None else [
        {'edge_type': 'Knows', 'edge_id': 'K1', 'source_id': 'P1', 'target_id': 'P1',
         'properties': {}}]
    return make_zip(tmp_path, {
        'entities.jsonl': '\n'.join(json.dumps(row) for row in entities),
        'edges.jsonl': '\n'.join(json.dumps(row) for row in edges),
    })


def test_import_from_zip_clean_run_is_completed(engine, tmp_path):
    zip_path = _zip_with(tmp_path)
    task_id = geng.import_from_zip('graph_kb1', 's-1', zip_path, kbase_schema_obj=SCHEMA)

    assert task_id in [row[0] for row in engine['created']]
    assert engine['created'][0][3] == 'graph_import_internal'
    assert engine['statuses'][-1][0] == store.STATUS_COMPLETED
    assert engine['settled'] == [('kb1', '5', 100)]
    assert engine['progress'][-1] == 100


def test_import_from_zip_accepts_prefixed_base_without_double_prefix(engine, tmp_path):
    zip_path = _zip_with(tmp_path)
    geng.import_from_zip('kb1', 's-1', zip_path, kbase_schema_obj=SCHEMA)
    assert engine['created'][0][1] == 'kb1'


def test_import_from_zip_task_id_reuse_skips_internal_row(engine, tmp_path):
    zip_path = _zip_with(tmp_path)
    geng.import_from_zip('graph_kb1', 's-1', zip_path, kbase_schema_obj=SCHEMA,
                         task_id='given-id')
    assert engine['created'] == []  # 任务行由调用方建，引擎不再自建


def test_import_entities_counts_and_rejections(engine, tmp_path):
    zip_path = make_zip(tmp_path, {
        'entities.jsonl': '\n'.join([
            json.dumps({'entity_type': 'Person', 'entity_id': 'P1', 'properties': {}}),
            json.dumps({'entity_type': 'Alien', 'entity_id': 'A1', 'properties': {}}),
            json.dumps({'entity_type': 'Person', 'entity_id': '  ', 'properties': {}}),
            json.dumps({'entity_type': 'Person', 'entity_id': 'P2',
                        'properties': {'bad key': 1}}),
            'not json',
            json.dumps({'entity_type': 'Person', 'entity_id': 'P3', 'labels': ['L'],
                        'properties': {}}),
        ]),
    })
    schema = {'entities': [{'entity_type': 'Person'}], 'edges': []}
    from types import SimpleNamespace
    counters = geng.Counters()
    imported = geng.import_entities(SimpleNamespace(dbname='graph_demo'), zip_path,
                                    schema, counters)

    # total=6：坏行与每条拒绝行都计；成功 P1/P3
    assert counters.total == 6
    assert counters.failed == 4
    assert imported == {'Person': {'P1', 'P3'}}
    assert counters.failed_records[0]['error'].startswith("entity_type 'Alien'")
    assert any('entity_id is missing' in record['error']
               for record in counters.failed_records)
    assert any('illegal property name' in record['error']
               for record in counters.failed_records)
    assert any('Invalid JSON format' in record['error']
               for record in counters.failed_records)


def test_import_edges_skip_duplicates_and_require_imported_endpoints(engine, tmp_path):
    zip_path = make_zip(tmp_path, {'edges.jsonl': '\n'.join([
        json.dumps({'edge_type': 'Knows', 'edge_id': 'K1', 'source_id': 'P1',
                    'target_id': 'P2', 'properties': {}}),
        json.dumps({'edge_type': 'Knows', 'edge_id': 'K1', 'source_id': 'P1',
                    'target_id': 'P2', 'properties': {}}),   # 重复：完全跳过
        json.dumps({'edge_type': 'Knows', 'edge_id': '', 'source_id': 'P1',
                    'target_id': 'P2', 'properties': {}}),
        json.dumps({'edge_type': 'Alien', 'edge_id': 'K2', 'source_id': 'P1',
                    'target_id': 'P2', 'properties': {}}),
        json.dumps({'edge_type': 'Knows', 'edge_id': 'K3', 'source_id': None,
                    'target_id': 'P2', 'properties': {}}),
        json.dumps({'edge_type': 'Knows', 'edge_id': 'K4', 'source_id': 'P9',
                    'target_id': 'P1', 'properties': {}}),
    ])})
    schema = {'entities': [], 'edges': [
        {'edge_type': 'Knows', 'source_entity': 'Person', 'target_entity': 'Person'}]}
    counters = geng.Counters()
    from types import SimpleNamespace
    imported = geng.import_edges(SimpleNamespace(dbname='g'), zip_path, schema,
                                 {'Person': {'P1', 'P2'}}, counters)
    # total=5：重复行完全跳过（0 计），空 id 计 1，其余计 4 → 1+4=5
    assert counters.total == 5
    assert counters.failed == 4
    assert 'K1' in imported.get('Knows', set())
    assert imported == {'Knows': {'K1'}}


def test_import_edges_accepts_any_of_multiple_definitions(engine, tmp_path):
    zip_path = make_zip(tmp_path, {'edges.jsonl': json.dumps({
        'edge_type': 'Rel', 'edge_id': 'R2', 'source_id': 'P1', 'target_id': 'C1',
        'properties': {}})})
    schema = {'entities': [], 'edges': [
        {'edge_type': 'Rel', 'source_entity': 'Person', 'target_entity': 'Person'},
        {'edge_type': 'Rel', 'source_entity': 'Person', 'target_entity': 'Company'},
    ]}
    counters = geng.Counters()
    from types import SimpleNamespace
    imported = geng.import_edges(SimpleNamespace(dbname='g'), zip_path, schema,
                                 {'Person': {'P1'}, 'Company': {'C1'}}, counters)
    assert imported == {'Rel': {'R2'}}


def test_bulk_failure_falls_back_to_per_row(engine, tmp_path):
    zip_path = _zip_with(tmp_path)
    engine['fail_upserts'] = True
    task_id = geng.import_from_zip('graph_kb1', 's-1', zip_path, kbase_schema_obj=SCHEMA)
    assert engine['statuses'][-1][0] == store.STATUS_COMPLETED_WITH_ERRORS
    assert engine['settled'][-1][1] == '104'
    assert any('知识图谱导入完成但有失败记录' in reason[1]
               for reason in engine.get('reasons', []))
    assert task_id


def test_index_build_failure_marks_completed_with_errors(engine, tmp_path):
    zip_path = _zip_with(tmp_path)
    engine['index_error'] = 'gateway 503'
    geng.import_from_zip('graph_kb1', 's-1', zip_path, kbase_schema_obj=SCHEMA)
    status, message = engine['statuses'][-1]
    assert status == store.STATUS_COMPLETED_WITH_ERRORS
    assert 'index build failed: gateway 503' in (message or '')


def test_verification_failure_does_not_kill_import(engine, tmp_path):
    zip_path = _zip_with(tmp_path)
    engine['verify_error'] = 'verify down'
    geng.import_from_zip('graph_kb1', 's-1', zip_path, kbase_schema_obj=SCHEMA)
    status, message = engine['statuses'][-1]
    # 校验失败不判死导入：仍是 COMPLETED，但 message 里留了「校验没跑成」
    assert status == store.STATUS_COMPLETED
    assert 'post-import verification could not run' in (message or '')


def test_not_persisted_records_are_reported(engine, tmp_path):
    zip_path = _zip_with(tmp_path)
    # 边写入路径成功，但回查在库里查不到这条边
    engine['drop_edge_present'] = True
    geng.import_from_zip('graph_kb1', 's-1', zip_path, kbase_schema_obj=SCHEMA)
    status, _message = engine['statuses'][-1]
    assert status == store.STATUS_COMPLETED_WITH_ERRORS


def test_cancel_is_reported_as_cancelled(engine, tmp_path, monkeypatch):
    zip_path = _zip_with(tmp_path)
    from infrastructure.tasks import cancellation

    def raise_cancel():
        raise TaskCancelled()

    monkeypatch.setattr(cancellation, 'raise_if_cancelled', raise_cancel)
    task_id = geng.import_from_zip('graph_kb1', 's-1', zip_path, kbase_schema_obj=SCHEMA)
    # 取消：任务行落 CANCELLED（update_status 不再调用，停在 PROCESSING 之后）
    assert engine['cancelled'] == [task_id]
    assert engine['settled'][-1][1] == '104'
    assert any('取消' in reason[1] for reason in engine.get('reasons', []))
    assert task_id


def test_unexpected_error_is_failed(engine, tmp_path, monkeypatch):
    zip_path = _zip_with(tmp_path)

    def boom(*_args):
        raise RuntimeError('schema table down')

    monkeypatch.setattr(geng, 'load_schema', boom)
    geng.import_from_zip('graph_kb1', 's-1', zip_path, kbase_schema_obj=SCHEMA)
    status, message = engine['statuses'][-1]
    assert status == store.STATUS_FAILED
    assert 'schema table down' in (message or '')


def test_bad_zip_file_is_failed(engine, tmp_path):
    bad = tmp_path / 'bad.zip'
    bad.write_bytes(b'not a zip at all')
    geng.import_from_zip('graph_kb1', 's-1', str(bad), kbase_schema_obj=SCHEMA)
    assert engine['statuses'][-1][0] == store.STATUS_FAILED


# ----------------------------------------------------------------------
# 名称归一与杂项
# ----------------------------------------------------------------------


def test_to_kbase_id_strips_prefix():
    assert geng.to_kbase_id('graph_abc') == 'abc'
    assert geng.to_kbase_id('abc') == 'abc'
    assert geng.to_kbase_id(None) is None


def test_build_pg_index_resolves_base_and_model(monkeypatch):
    from knowledge_base.service import kbase_service as kbase_store
    from graph.repository import graph_index_store

    captured = {}

    def fake_build(**kwargs):
        captured.update(kwargs)
        return {'entities': 0}

    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb_id: {'table_name': 'graph_tbl', 'embedding_model': 'm1'})
    monkeypatch.setattr(graph_index_store, 'build_index', lambda **kwargs: fake_build(**kwargs))
    monkeypatch.setattr('model.gateway.embed_many', lambda texts, model: [])

    stats = geng.build_pg_index('graph_kb9', '/tmp/x.zip', {'Person': {'P1'}}, None)
    assert stats == {'entities': 0}
    assert captured['base'] == 'graph_tbl'
    assert captured['embedding_model'] == 'm1'
    assert captured['kbase_id'] == 'kb9'
    assert captured['entity_ids'] == {'Person': {'P1'}}


def test_build_pg_index_requires_resolvable_base(monkeypatch):
    from knowledge_base.service import kbase_service as kbase_store

    monkeypatch.setattr(kbase_store, 'get_kbase_row', lambda kb_id: None)
    with pytest.raises(RuntimeError):
        geng.build_pg_index('graph_None', '/tmp/x.zip')


def test_load_schema_prefers_graph_schema_then_kbase_then_raises(monkeypatch):
    from graph.repository import graph_schema_store
    from knowledge_base.service import kbase_service as kbase_store

    monkeypatch.setattr(graph_schema_store, 'get_schema_by_id',
                        lambda schema_id: {'schema_obj': SCHEMA})
    assert geng.load_schema('s-1', 'kb1', None) == SCHEMA

    monkeypatch.setattr(graph_schema_store, 'get_schema_by_id',
                        lambda schema_id: None)
    assert geng.load_schema('s-1', 'kb1', {'entities': []}) == {'entities': []}

    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb_id: {'schema_obj': json.dumps(SCHEMA)})
    assert geng.load_schema('s-1', 'kb1', None)['schema_id'] == 's-1'

    monkeypatch.setattr(kbase_store, 'get_kbase_row', lambda kb_id: None)
    with pytest.raises(RuntimeError):
        geng.load_schema('missing', 'kb1', None)


def test_upsert_knowledge_graph_info_registers_row(engine):
    geng._upsert_knowledge_graph_info('graph_kb1', 's-1', SCHEMA)
    assert engine['registry'] and engine['registry'][0][0] == 'INSERT'


def test_find_unsafe_key_flags_bad_property_names():
    assert geng._find_unsafe_key({'ok_name': 1}) is None
    assert geng._find_unsafe_key({'bad key': 1}) == 'bad key'
    assert geng._find_unsafe_key({'1number': 1}) == '1number'
    assert geng._find_unsafe_key({}) is None


def test_count_not_persisted_lists_missing_ids(monkeypatch):
    from graph.repository import graph_pg
    from types import SimpleNamespace

    monkeypatch.setattr(graph_pg, 'present_ids',
                        lambda dbname, id_field, ids: {i for i in ids if i == 'P1'})
    counters = geng.Counters()
    missing = geng._count_not_persisted(SimpleNamespace(dbname='g'),
                                        {'Person': {'P1', 'P2'}},
                                        'entity_id', counters)
    assert missing == 1
    assert counters.failed_records[0]['id'] == 'P2'
    assert counters.failed_records[0]['error'].startswith('reported as succeeded')
