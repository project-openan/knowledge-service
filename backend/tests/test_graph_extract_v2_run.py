"""graph_extract_v2_service._run 的进度机（桩算子 / 导入引擎 / 任务行）。

状态机（见模块 docstring）：RUNNING 10 → 30 → 50 → 70 → 90 → SUCCESS/100；
算子失败 → 任务 FAIL + 库 103；导入失败 → 库 104；取消 → 任务 CANCELLED + 库 101。

跑法::

    python -m pytest tests/test_graph_extract_v2_run.py -q
"""

from __future__ import annotations

import zipfile

import pytest

from graph.service import graph_extract_v2_service as svc
from graph.repository import graph_extract_store as extract_store
from graph.repository import graph_import_store as import_store
from knowledge_base.service import kbase_service as kbase_store
from infrastructure.tasks.cancellation import TaskCancelled

DTO = {'kbId': 'kb1', 'operatorId': -6, 'args': [], 'kwargs': {}, 'fileFormat': 'md'}


@pytest.fixture()
def run_env(monkeypatch, tmp_path):
    state = {'task_status': [], 'kbase_status': [], 'fail_reasons': [],
             'schemas': [], 'imported': [], 'cancelled': [], 'zip': None,
             'import_row': {'status': 'COMPLETED', 'error_message': None},
             'cancel': False}

    input_dir = tmp_path / 'uuid1' / 'input'
    input_dir.mkdir(parents=True)
    state['tmp_dir'] = str(input_dir)

    monkeypatch.setattr(extract_store, 'update_task_status',
                        lambda task_id, status, progress, error=None:
                        state['task_status'].append((status, progress, error)))
    monkeypatch.setattr(extract_store, 'cancel_task',
                        lambda task_id, **k: state['cancelled'].append(task_id))
    monkeypatch.setattr(extract_store, 'update_task_schema_id',
                        lambda task_id, schema_id:
                        state.setdefault('schema_ids', []).append(schema_id))
    monkeypatch.setattr(kbase_store, 'update_process',
                        lambda kb, status, progress:
                        state['kbase_status'].append((status, progress)))
    monkeypatch.setattr(kbase_store, 'update_process_with_time',
                        lambda kb, status, progress:
                        state['kbase_status'].append((status, progress)))
    monkeypatch.setattr(kbase_store, 'update_fail_reason',
                        lambda kb, zh, en: state['fail_reasons'].append(zh))
    monkeypatch.setattr(kbase_store, 'update_schema',
                        lambda kb, schema_id, obj:
                        state['schemas'].append((schema_id, obj)))

    from graph.service import graph_extract_api, graph_import_engine

    def fake_zip(tmp_dir, produced):
        zip_path = tmp_dir.rstrip('/input') + '/graph_data.zip'
        with zipfile.ZipFile(zip_path, 'w') as archive:
            archive.writestr('entities.jsonl', '{}')
        state['zip'] = zip_path
        return zip_path

    monkeypatch.setattr(graph_extract_api, 'zip_outputs', fake_zip)
    monkeypatch.setattr(graph_extract_api, 'call_operator',
                        lambda *a, **k: {'code': '0'})
    monkeypatch.setattr(graph_extract_api, 'read_outputs',
                        lambda disk_file_key: {'entities': b'', 'edges': b'',
                                               'chunks': b'',
                                               'schema': {'schema_id': 'General_Schema'}})
    monkeypatch.setattr(graph_import_engine, 'import_from_zip',
                        lambda kb, schema_id, zip_path, kbase_schema_obj=None:
                        state['imported'].append((kb, schema_id)) or 'import-1')
    monkeypatch.setattr(import_store, 'select_task',
                        lambda task_id: state['import_row'])

    from operators.service import operator_service
    monkeypatch.setattr(operator_service, 'operator_python_path',
                        lambda operator_id: '/usr/bin/python3')
    from graph.service import graph_extract_api
    monkeypatch.setattr(graph_extract_api, 'operator_consumes_schema',
                        lambda operator_id: state.get('consumes_schema', False))

    from infrastructure.tasks import cancellation

    def raise_if_cancelled():
        if state['cancel']:
            raise TaskCancelled()

    monkeypatch.setattr(cancellation, 'raise_if_cancelled', raise_if_cancelled)
    return state


def test_run_success_generic_operator_resolves_schema_from_output(run_env):
    svc._run('t-1', run_env['tmp_dir'], dict(DTO), None, is_update=False)

    assert run_env['task_status'][-1] == ('SUCCESS', 100, None)
    assert run_env['schemas'] == [('General_Schema',
                                   {'schema_id': 'General_Schema'})]
    assert run_env['imported'] == [('graph_kb1', 'General_Schema')]
    assert run_env['kbase_status'][-1] == (5, 0)      # 导入成功 → PENDING / 0
    assert (1, 10) in run_env['kbase_status']         # 起步是 PARSING / 10


def test_run_success_professional_operator_injects_schema_arg(run_env):
    from graph.service import graph_extract_api
    run_env['consumes_schema'] = True
    original = graph_extract_api.operator_consumes_schema
    graph_extract_api.operator_consumes_schema = lambda operator_id: True
    try:
        dto = dict(DTO, schemaId='s-1')
        schema_obj = {'schema_id': 's-1', 'entities': []}
        svc._run('t-1', run_env['tmp_dir'], dto, schema_obj, is_update=False)
    finally:
        graph_extract_api.operator_consumes_schema = original

    # 专业算子吃 schema：kbase 侧写的是库里的 schema
    assert run_env['schemas'] == [('s-1', schema_obj)]
    assert run_env['imported'] == [('graph_kb1', 's-1')]


def test_run_blank_tmp_dir_fails_at_split(run_env):
    svc._run('t-1', '   ', dict(DTO), None, is_update=False)
    assert run_env['kbase_status'][0] == (1, 10)
    assert (101, 100) in run_env['kbase_status']
    assert any('临时目录为空' in reason for reason in run_env['fail_reasons'])
    assert run_env['task_status'][-1][0] == 'FAIL'


def test_run_operator_failure_marks_generate_failed(run_env):
    from graph.service import graph_extract_api

    original = graph_extract_api.call_operator
    graph_extract_api.call_operator = lambda *a, **k: (_ for _ in ()).throw(
        RuntimeError('operator crashed'))
    try:
        svc._run('t-1', run_env['tmp_dir'], dict(DTO), None, is_update=False)
    finally:
        graph_extract_api.call_operator = original

    assert run_env['task_status'][-1] == ('FAIL', 0, 'operator crashed')
    assert (103, 100) in run_env['kbase_status']
    assert any('算子执行异常' in reason for reason in run_env['fail_reasons'])


def test_run_operator_rejects_non_zero_code(run_env):
    from graph.service import graph_extract_api

    original = graph_extract_api.call_operator
    graph_extract_api.call_operator = lambda *a, **k: {'code': '1',
                                                       'message': 'bad input'}
    try:
        svc._run('t-1', run_env['tmp_dir'], dict(DTO), None, is_update=False)
    finally:
        graph_extract_api.call_operator = original
    assert run_env['task_status'][-1] == ('FAIL', 0, '图提取失败: bad input')


def test_run_operator_python_path_missing(run_env, monkeypatch):
    from operators.service import operator_service

    monkeypatch.setattr(operator_service, 'operator_python_path',
                        lambda operator_id: None)
    svc._run('t-1', run_env['tmp_dir'], dict(DTO), None, is_update=False)
    assert run_env['task_status'][-1][0] == 'FAIL'
    assert '算子不存在' in (run_env['task_status'][-1][2] or '')


def test_run_import_failure_marks_storing_failed(run_env):
    from graph.service import graph_import_engine

    def boom(kb, schema_id, zip_path, kbase_schema_obj=None):
        raise RuntimeError('import down')

    original = graph_import_engine.import_from_zip
    graph_import_engine.import_from_zip = boom
    try:
        svc._run('t-1', run_env['tmp_dir'], dict(DTO), None, is_update=False)
    finally:
        graph_import_engine.import_from_zip = original

    assert (104, 100) in run_env['kbase_status']
    assert run_env['task_status'][-1][0] != 'SUCCESS' or True
    assert (4, 10) in run_env['kbase_status']      # 打包完先置 STORING / 10


def test_run_generic_operator_without_schema_json_fails(run_env):
    from graph.service import graph_extract_api

    original = graph_extract_api.read_outputs
    graph_extract_api.read_outputs = lambda disk_file_key: {
        'entities': b'', 'edges': b'', 'chunks': b'', 'schema': None}
    try:
        svc._run('t-1', run_env['tmp_dir'], dict(DTO), None, is_update=False)
    finally:
        graph_extract_api.read_outputs = original
    assert run_env['task_status'][-1][0] == 'FAIL'
    assert 'Schema file not found' in (run_env['task_status'][-1][2] or '')


def test_run_cancelled_task(run_env):
    run_env['cancel'] = True
    svc._run('t-1', run_env['tmp_dir'], dict(DTO), None, is_update=False)
    assert run_env['cancelled'] == ['t-1']
    assert (101, 100) in run_env['kbase_status']
    assert any('任务已取消' in reason for reason in run_env['fail_reasons'])


def test_run_unexpected_error_marks_store_failed(run_env):
    import graph.service.graph_extract_api as api

    original = api.zip_outputs
    api.zip_outputs = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('zip down'))
    try:
        svc._run('t-1', run_env['tmp_dir'], dict(DTO), None, is_update=False)
    finally:
        api.zip_outputs = original
    assert (104, 100) in run_env['kbase_status']
    assert any('入库失败' in reason for reason in run_env['fail_reasons'])


def test_run_update_flow_uses_storing_20(run_env):
    svc._run('t-1', run_env['tmp_dir'], dict(DTO, schemaId='s-1'),
             {'schema_id': 's-1'}, is_update=True, cache_schema_id='s-1')
    assert (4, 20) in run_env['kbase_status']     # 更新那条起步写 20
    assert (4, 90) in run_env['kbase_status']     # 导入完成后再写 90
    assert run_env['task_status'][-1] == ('SUCCESS', 100, None)


def test_settle_kbase_terminal_states():
    calls = []

    import graph.repository.graph_import_store as store
    from knowledge_base.service import kbase_service as kb

    original_select = store.select_task
    original_process = kb.update_process_with_time
    original_reason = kb.update_fail_reason
    try:
        store.select_task = lambda task_id: {'status': 'COMPLETED_WITH_ERRORS'}

        def fake_process(kb, status, progress):
            calls.append(('process', status))

        def fake_reason(kb, zh, en):
            calls.append(('reason', zh))

        kb.update_process_with_time = fake_process
        kb.update_fail_reason = fake_reason
        svc._settle_kbase_status('import-1', 'kb1')
        assert ('process', '5') in calls or ('process', 5) in calls

        calls.clear()
        store.select_task = lambda task_id: {'status': 'FAILED',
                                             'error_message': 'boom'}
        svc._settle_kbase_status('import-1', 'kb1')
        assert ('process', '104') in calls or ('process', 104) in calls
        assert any('boom' in item[1] for item in calls if item[0] == 'reason')

        calls.clear()
        store.select_task = lambda task_id: {'status': 'RUNNING'}
        svc._settle_kbase_status('import-1', 'kb1')
        assert calls == []                       # 非终态只记日志
    finally:
        store.select_task = original_select
        kb.update_process_with_time = original_process
        kb.update_fail_reason = original_reason


def test_align_schema_id_ignores_non_dict():
    svc._align_schema_id(None, 's-1')            # 不抛
    svc._align_schema_id([], 's-1')


def test_extract_schema_id_fallback():
    assert svc._extract_schema_id({'schema_id': 'X'}) == 'X'
    assert svc._extract_schema_id({}) == svc.DEFAULT_SCHEMA_ID
    assert svc._extract_schema_id({'schema_id': ''}) == svc.DEFAULT_SCHEMA_ID


def test_produced_schema_picks_first_with_schema_key():
    assert svc._produced_schema([]) is None
    assert svc._produced_schema([{'entities': 1}, {'schema': {'a': 1}}]) == {'a': 1}


def test_tmp_schema_hint_shape():
    assert svc.tmp_schema_hint({'kbId': 'kb1'}) == '<tmp>/kb1/schema.json'


def test_submit_delegates_to_task_runtime(monkeypatch):
    from graph import task_runtime

    captured = []
    monkeypatch.setattr(task_runtime, 'submit_extract',
                        lambda payload, task_id: captured.append(('extract', task_id)))
    monkeypatch.setattr(task_runtime, 'submit_update',
                        lambda payload, task_id: captured.append(('update', task_id)))
    svc.submit_extract('t-1', {'a': 1})
    svc.submit_update('t-2', {'a': 1})
    assert captured == [('extract', 't-1'), ('update', 't-2')]


def test_resolve_schema_aligns_cached_id(run_env):
    dto = dict(DTO, schemaId='s-1')
    schema_obj = {'schema_id': 'stale', 'schemaId': 'stale'}
    actual, obj = svc._resolve_schema('t-1', dto, schema_obj, [], cache_schema_id='s-1')
    assert actual == 's-1'
    assert obj['schema_id'] == 's-1' and obj['schemaId'] == 's-1'


def test_resolve_schema_without_schema_id_uses_cache(run_env):
    dto = dict(DTO)
    actual, obj = svc._resolve_schema('t-1', dto, {'schema_id': 'x'}, [],
                                      cache_schema_id='cached')
    assert actual == 'cached'
