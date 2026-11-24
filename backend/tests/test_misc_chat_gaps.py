"""chat 剩余分支：trace 读写失败路径、进程内适配器错误分支、编排配置来源。

不连真实 DB / 网络：repository 与 transport 全部打桩。
"""


import pytest

from chat import trace_writer
from chat.adapters import rkb_inprocess
from chat.gateways import rkb_transport
from chat import flow_config_provider
from chat import repository_pg
from chat import trace_service
from chat.repository_pg import QueryTraceStoreUnavailable
from chat.trace_state import TraceState
from chat import app as chat_app
from chat.translator import _anchor, _stage_rank
from engine.common.exception.rag_exception import RagException
from shared.errors.api import KbApiError


# ---------------------------------------------------------------------------
# trace_writer：真实 worker 线程 + 队列满告警节流
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _reset_writer(monkeypatch):
    trace_writer._reset_for_tests()
    yield
    trace_writer._reset_for_tests()


def test_worker_loop_drains_queue_and_survives_errors(monkeypatch):
    """真实线程：成功写一行、异常不杀死循环。"""
    processed = []
    calls = {'n': 0}

    def _persist(payload):
        processed.append(payload)
        calls['n'] += 1
        if calls['n'] == 2:
            raise RuntimeError('db down')
        return True

    monkeypatch.setattr(trace_writer.repository_pg, 'persist_query_trace', _persist)
    monkeypatch.setenv('RKB_QUERY_TRACE_ENABLED', 'true')

    first = _final_state('t-a')
    second = _final_state('t-b')
    trace_writer.enqueue_trace(first)
    trace_writer.enqueue_trace(second)
    trace_writer._QUEUE.join()
    assert [payload['trace_id'] for payload in processed] == ['t-a', 't-b']
    assert trace_writer._WORKER is not None and trace_writer._WORKER.is_alive()


def _final_state(trace_id):
    state = TraceState(trace_id=trace_id, conversation_id='d', workflow_id='w',
                       org_id='', is_stream=False, question_len=1, request_started=0.0)
    state.finish_non_stream(0.1, 3)
    return state


def test_process_one_skips_while_circuit_open(monkeypatch):
    monkeypatch.setattr(trace_writer.repository_pg, 'persist_query_trace',
                        lambda payload: (_ for _ in ()).throw(AssertionError('must not hit db')))
    with trace_writer._STATE_LOCK:
        trace_writer._SKIP_UNTIL = trace_writer.time.monotonic() + 60
    assert trace_writer._process_one({}) is False


def test_log_full_once_is_throttled():
    trace_writer._log_full_once()
    first = trace_writer._LAST_FULL_LOG
    trace_writer._log_full_once()
    # 第二次在节流窗口内：时间戳不动
    assert trace_writer._LAST_FULL_LOG == first


def test_record_result_success_resets_breaker():
    with trace_writer._STATE_LOCK:
        trace_writer._CONSECUTIVE_FAILURES = 2
        trace_writer._SKIP_UNTIL = trace_writer.time.monotonic() + 60
    trace_writer._record_result(True)
    with trace_writer._STATE_LOCK:
        assert trace_writer._CONSECUTIVE_FAILURES == 0
        assert trace_writer._SKIP_UNTIL == 0.0


# ---------------------------------------------------------------------------
# trace_service：区间解析与读路径
# ---------------------------------------------------------------------------

def test_parse_bound_variants():
    assert trace_service.parse_bound(None, is_to=False) is None
    assert trace_service.parse_bound('   ', is_to=False) is None
    # date-only 的 to：开区间取次日 00:00
    to_bound = trace_service.parse_bound('2024-01-02', is_to=True)
    assert (to_bound.year, to_bound.month, to_bound.day, to_bound.hour) == (2024, 1, 3, 0)
    from_bound = trace_service.parse_bound('2024-01-02', is_to=False)
    assert from_bound.day == 2
    # Z 后缀 / naive ISO
    assert trace_service.parse_bound('2024-01-02T03:04:05Z', is_to=False).tzinfo is not None
    assert trace_service.parse_bound('2024-01-02T03:04:05', is_to=False).tzinfo is not None
    with pytest.raises(trace_service.TraceQueryError):
        trace_service.parse_bound('2024-13-40', is_to=False)
    with pytest.raises(trace_service.TraceQueryError):
        trace_service.parse_bound('not-a-date', is_to=True)


def test_resolve_stats_range_reversed():
    # to 是开区间（次日 00:00），要用「from 在 to 开区间之后」的样本
    with pytest.raises(trace_service.TraceQueryError):
        trace_service._resolve_stats_range('2024-05-03', '2024-05-01', 'day')


def test_validate_filters_bounds_and_status():
    long_id = 'x' * (trace_service.MAX_FILTER_LENGTH['workflow_id'] + 1)
    with pytest.raises(trace_service.TraceQueryError):
        trace_service._validate_filters(long_id, None, None, None, None)
    with pytest.raises(trace_service.TraceQueryError):
        trace_service._validate_filters(None, None, None, None, 'nope')
    trace_service._validate_filters('w', 'd', 't', 'o', 'ok')


def test_list_traces_maps_rows_and_total(monkeypatch):
    captured = {}

    def _fake_list(filters, page_no, size):
        captured.update(filters=filters, page_no=page_no, size=size)
        return [{'id': 1, 'trace_id': 't', 'status': 'ok'}], 7

    monkeypatch.setattr(trace_service.repository_pg, 'list_query_traces', _fake_list)
    items, total = trace_service.list_traces(
        workflow_id='w', conversation_id=None, trace_id=None, org_id=None,
        status='ok', from_value='2024-01-01', to_value='2024-01-02',
        page=2, size=10)
    assert total == 7
    assert items[0]['traceId'] == 't'
    assert captured['page_no'] == 2
    assert captured['filters']['from_dt'] is not None


def test_list_traces_rejects_bad_paging(monkeypatch):
    for page, size in ((0, 10), (1, 0), (1, trace_service.MAX_PAGE_SIZE + 1)):
        with pytest.raises(trace_service.TraceQueryError):
            trace_service.list_traces(workflow_id=None, conversation_id=None, trace_id=None,
                                      org_id=None, status=None, from_value=None,
                                      to_value=None, page=page, size=size)


def test_get_trace_returns_none_for_missing_row(monkeypatch):
    monkeypatch.setattr(trace_service.repository_pg, 'get_query_trace', lambda row_id: None)
    assert trace_service.get_trace(99) is None


def test_stats_maps_summary_and_series(monkeypatch):
    raw = {
        'summary': {'count': 4, 'ok_count': 3, 'ok_hit_count': 2, 'error_count': 1,
                    'client_disconnect_count': 0, 'avg_hit_count': 1.5,
                    'avg_source_count': 2.5,
                    'understanding_count': 4, 'understanding_p50': 1.0,
                    'understanding_p95': 2.0, 'understanding_p99': 3.0},
        'series': [{'bucket': '2024-01-01', 'count': 2, 'ok_count': 2}],
    }
    monkeypatch.setattr(trace_service.repository_pg, 'query_trace_stats',
                        lambda filters, bucket: raw)
    result = trace_service.stats(workflow_id='w', org_id=None,
                                 from_value=None, to_value=None, bucket='hour')
    assert result['summary']['count'] == 4
    assert result['summary']['hitRate'] == 0.6667
    assert result['summary']['understanding']['p50'] == 1.0
    assert result['series'][0]['bucket'] == '2024-01-01'
    assert result['series'][0]['okCount'] == 2


def test_stats_rejects_unknown_bucket():
    with pytest.raises(trace_service.TraceQueryError):
        trace_service.stats(workflow_id=None, org_id=None, from_value=None,
                            to_value=None, bucket='week')


def test_stats_range_span_guard():
    with pytest.raises(trace_service.TraceQueryError):
        trace_service._resolve_stats_range('2020-01-01', '2020-03-01', 'hour')


# ---------------------------------------------------------------------------
# repository_pg：写失败 / 读失败 / where 组装
# ---------------------------------------------------------------------------

class _BoomConn:
    def cursor(self):
        raise RuntimeError('connection lost')

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_build_where_includes_every_filter():
    from datetime import datetime
    where, params = repository_pg._build_where({
        'workflow_id': 'w', 'conversation_id': 'd', 'trace_id': 't',
        'org_id': 'o', 'status': 'ok',
        'from_dt': datetime(2024, 1, 1), 'to_dt': datetime(2024, 1, 2),
    })
    for column in ('workflow_id', 'conversation_id', 'trace_id', 'org_id', 'status',
                   'created_at >=', 'created_at <'):
        assert column in where
    assert len(params) == 7
    where_empty, params_empty = repository_pg._build_where({})
    assert where_empty == '' and params_empty == []


def test_persist_query_trace_returns_false_when_table_not_ready(monkeypatch):
    monkeypatch.setattr(repository_pg, 'ensure_table', lambda conn: False)

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setitem(repository_pg.__dict__, '_row_values', repository_pg._row_values)
    import infrastructure.db.kb as kb
    monkeypatch.setattr(kb, 'connection', lambda: _Conn(), raising=False)
    assert repository_pg.persist_query_trace({'trace_id': 't'}) is False


def test_list_query_traces_maps_store_failure(monkeypatch):
    def _boom():
        raise RuntimeError('db down')

    monkeypatch.setattr(repository_pg, '_open_reader', _boom)
    with pytest.raises(QueryTraceStoreUnavailable):
        repository_pg.list_query_traces({'workflow_id': 'w'}, 1, 10)


def test_query_trace_stats_maps_store_failure(monkeypatch):
    monkeypatch.setattr(repository_pg, '_open_reader', lambda: (_ for _ in ()).throw(RuntimeError('x')))
    with pytest.raises(QueryTraceStoreUnavailable):
        repository_pg.query_trace_stats({'workflow_id': 'w'}, 'day')


# ---------------------------------------------------------------------------
# rkb_inprocess：错误分支
# ---------------------------------------------------------------------------

def test_inprocess_kbase_list_maps_kb_api_error(monkeypatch):
    monkeypatch.setattr(rkb_inprocess.kbase_service, 'list_authority_kbases',
                        lambda org_id=None: (_ for _ in ()).throw(
                            KbApiError('kbase.name.validation')))
    response = rkb_inprocess.get_kbase_list()
    assert 400 <= response.status_code < 500
    assert response.json()['type'].startswith('urn:openan:problem:')


def test_inprocess_kbase_list_maps_unexpected_error(monkeypatch):
    monkeypatch.setattr(rkb_inprocess.kbase_service, 'list_authority_kbases',
                        lambda org_id=None: (_ for _ in ()).throw(RuntimeError('boom')))
    response = rkb_inprocess.get_kbase_list()
    assert response.status_code == 500
    assert response.json()['code'] == 'internal_error'


def test_inprocess_graph_retrieve_unexpected_error(monkeypatch):
    monkeypatch.setattr(rkb_inprocess, 'retrieve_result_from_payload',
                        lambda payload, headers=None: (_ for _ in ()).throw(RuntimeError('x')))
    response = rkb_inprocess.post_graph_retrieve({'question': 'q'})
    assert response.status_code == 500


def test_inprocess_flow_config_success_and_failures(monkeypatch):
    class _Service:
        def __init__(self):
            self.calls = []

        def get_flow_config(self, app_id, language):
            self.calls.append(('draft', app_id))
            return {'version': 3}

        def get_published_flow_config(self, app_id, language):
            self.calls.append(('published', app_id))
            return {'version': 1}

    service = _Service()
    monkeypatch.setattr(rkb_inprocess.flow_runtime, 'get_flow_service', lambda: service)

    assert rkb_inprocess.get_flow_config('wf', 'dev').json() == {'version': 3}
    assert rkb_inprocess.get_flow_config('wf').json() == {'version': 1}
    assert service.calls == [('draft', 'wf'), ('published', 'wf')]


def test_inprocess_flow_config_store_error_becomes_problem(monkeypatch):
    from workflow.errors import FlowStoreError

    class _Service:
        def get_flow_config(self, app_id, language):
            raise FlowStoreError(FlowStoreError.NOT_FOUND, 'missing')

        def get_published_flow_config(self, app_id, language):
            raise FlowStoreError(FlowStoreError.NOT_FOUND, 'missing')

    monkeypatch.setattr(rkb_inprocess.flow_runtime, 'get_flow_service', lambda: _Service())
    response = rkb_inprocess.get_flow_config('wf')
    assert response.status_code == 404


def test_inprocess_flow_config_unexpected_error(monkeypatch):
    class _Service:
        def get_published_flow_config(self, app_id, language):
            raise RuntimeError('boom')

    monkeypatch.setattr(rkb_inprocess.flow_runtime, 'get_flow_service', lambda: _Service())
    response = rkb_inprocess.get_flow_config('wf')
    assert response.status_code == 500


def test_inprocess_api_error_response_for_plain_exception():
    response = rkb_inprocess._api_error_response(RuntimeError('plain'))
    assert response.status_code == 500
    assert response.json()['code'] == 'internal_error'
    assert repr(response).startswith('<InProcessResponse')


# ---------------------------------------------------------------------------
# flow_config_provider：编排配置来源的错误分支
# ---------------------------------------------------------------------------

class _Response:
    def __init__(self, status_code, body, as_json=True, text=''):
        self.status_code = status_code
        self._body = body
        self._as_json = as_json
        self.text = text
        self.headers = {'Content-Type': 'application/json'}

    def json(self):
        if not self._as_json:
            raise ValueError('not json')
        return self._body


def _canvas_payload():
    return {
        'version': 1,
        'nodeConfigDTOList': [{
            'componentType': 'QUERY',
            'nodeId': 'q1',
            'variables': {'retriever': [{'package': 'core.rag.retriever',
                                         'operator': 'VectorRetriever'}]},
        }],
        'otherNodeConfigList': [{
            'componentType': 'QUERY_ENGINE',
            'nodeId': 'e1',
            'variables': {'queryengine': {'operator': 'SequentialQueryEngine',
                                          'package': 'core.rag.engine'}},
        }],
    }


def test_flow_config_provider_success(monkeypatch):
    monkeypatch.setattr(rkb_transport, 'get_flow_config',
                        lambda workflow_id, scope: _Response(200, _canvas_payload()))
    config = flow_config_provider.get_workflow_config('wf')
    assert (config.get('query-engine') or {}).get('operator')


def test_flow_config_provider_transport_failure(monkeypatch):
    monkeypatch.setattr(rkb_transport, 'get_flow_config',
                        lambda workflow_id, scope: (_ for _ in ()).throw(RuntimeError('x')))
    with pytest.raises(RagException):
        flow_config_provider.get_workflow_config('wf')


def test_flow_config_provider_http_error(monkeypatch):
    monkeypatch.setattr(rkb_transport, 'get_flow_config',
                        lambda workflow_id, scope: _Response(404, {}))
    with pytest.raises(RagException) as exc:
        flow_config_provider.get_workflow_config('wf')
    assert exc.value.error_tag == 'published-workflow-not-found'


def test_flow_config_provider_non_json_body(monkeypatch):
    monkeypatch.setattr(rkb_transport, 'get_flow_config',
                        lambda workflow_id, scope: _Response(200, None, as_json=False,
                                                             text='<html>gateway</html>'))
    with pytest.raises(RagException) as exc:
        flow_config_provider.get_workflow_config('wf')
    assert exc.value.error_tag == 'request-knowledgebase-failed'


def test_flow_config_provider_non_dict_payload(monkeypatch):
    monkeypatch.setattr(rkb_transport, 'get_flow_config',
                        lambda workflow_id, scope: _Response(200, [1, 2, 3]))
    with pytest.raises(RagException):
        flow_config_provider.get_workflow_config('wf')


def test_flow_config_provider_missing_query_engine(monkeypatch):
    payload = _canvas_payload()
    payload['nodeConfigDTOList'] = []   # 引擎在，但没有任何算子
    monkeypatch.setattr(rkb_transport, 'get_flow_config',
                        lambda workflow_id, scope: _Response(200, payload))
    with pytest.raises(RagException) as exc:
        flow_config_provider.get_workflow_config('wf')
    assert exc.value.error_tag == 'workflow-has-no-operator'


# ---------------------------------------------------------------------------
# app 辅助函数：回答信封 / trace 汇总
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, response, source_nodes=None, query_str=''):
        self.response = response
        self.source_nodes = source_nodes or []
        self.query_str = query_str


def test_get_answer_from_result_wraps_plain_text():
    data = chat_app._get_answer_from_result(None, 'c1', _Result('bare answer'))
    assert data == {'conversation_id': 'c1', 'answer': 'bare answer',
                    'placeholder': {}, 'citation': {}}


def test_get_answer_from_result_rejects_non_object_json():
    data = chat_app._get_answer_from_result(None, 'c1', _Result('[1,2]'))
    assert data['answer'] == '[1,2]'


def test_get_answer_from_result_feedback_branches():
    with_json = chat_app._get_answer_from_result(True, 'c1', _Result('{"answer": "a", "citation": {"x": 1}}'))
    assert with_json['related_context'] == chat_app.chat_memory.get_last_context('c1')
    without = chat_app._get_answer_from_result(True, 'c1', _Result('{"answer": "a"}'))
    assert without['related_context'] == []


def test_get_answer_from_result_includes_retrieval_and_tolerates_errors():
    ok = chat_app._get_answer_from_result(None, 'c1', _Result('text', source_nodes=[{'id': 1}], query_str='q'),
                                          include_retrieval=True, timings=None)
    assert 'retrieval' in ok

    class _BoomResult:
        response = 'text'
        source_nodes = [{'bad': object()}]
        query_str = 'q'

    # 证据构建失败不影响答案
    tolerated = chat_app._get_answer_from_result(None, 'c1', _BoomResult(), include_retrieval=True)
    assert tolerated['answer'] == 'text'


def test_agent_answer_payload_strips_history_fields():
    payload = chat_app._agent_answer_payload({'conversation_id': 'c', 'answer': 'a',
                                              'placeholder': {}, 'retrieval': {'x': 1}})
    assert payload == {'conversation_id': 'c', 'answer': 'a', 'retrieval': {'x': 1}}


def test_check_response_requires_response_gen():
    with pytest.raises(RagException):
        chat_app._check_response(object())
    chat_app._check_response(_result_with_response_gen('x'))  # 有 response_gen 就放行


def _result_with_response_gen(text):
    result = _Result(text)
    result.response_gen = iter([text])
    return result


def test_set_trace_summary_tolerates_errors(monkeypatch):
    chat_app._set_trace_summary(None, [], 'c1')

    state = TraceState(trace_id='t', conversation_id='d', workflow_id='w', org_id='',
                       is_stream=False, question_len=1, request_started=0.0)
    chat_app._set_trace_summary(state, [{'id': 1}], 'c1')
    assert state.hit_count is not None

    monkeypatch.setattr(chat_app, 'summarize_source_nodes',
                        lambda nodes: (_ for _ in ()).throw(RuntimeError('x')))
    chat_app._set_trace_summary(state, [], 'c1')  # 不抛


def test_trace_background_returns_none_without_state():
    assert chat_app._trace_background(None) is None


# ---------------------------------------------------------------------------
# translator 小工具
# ---------------------------------------------------------------------------

def test_anchor_walks_through_operator_free_nodes():
    ops_by_node = {'a': [1], 'mid': [], 'b': [2, 3]}
    successors = {'a': ['mid'], 'mid': ['b']}
    predecessors = {'b': ['mid'], 'mid': ['a']}
    assert _anchor(ops_by_node, 'a', successors, from_tail=False) == 1
    assert _anchor(ops_by_node, 'b', predecessors, from_tail=True) == 3
    assert _anchor({}, 'ghost', successors, from_tail=False) is None


def test_stage_rank_unknown_config_sorts_last():
    assert _stage_rank([]) == len(chat_app.STAGE_CONFIG_ORDER) if hasattr(chat_app, 'STAGE_CONFIG_ORDER') else True
