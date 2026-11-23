"""workflow 剩余分支：InMemory/Pg 存储、bindings、模板装载、服务层工具与路由信封。

不连 DB / 网络：PgFlowStore._connect 打桩，service 用 InMemoryFlowStore。
"""

import json

import pytest

from workflow import bindings as flow_bindings
from workflow import canvas as canvas_util
from workflow import messages as flow_messages
from workflow import responses as flow_responses
from workflow import runtime_config
from workflow import template_loader
from workflow import validation as flow_validation
from workflow.errors import FlowError, FlowStoreError, FlowMalformedRequestError
from workflow.models import FlowCanvasInput, WorkflowRecord
from workflow.repository import InMemoryFlowStore, FlowDraft, FlowPublished, now_timestamp
from workflow.service import FlowService

from conftest import RuntimeCapabilities


# ---------------------------------------------------------------------------
# InMemoryFlowStore 剩余分支
# ---------------------------------------------------------------------------

def _record(workflow_id='wf1', created_by='admin', publish_type=0, updated=None):
    return WorkflowRecord(
        workflow_id=workflow_id, name='n', template='Sequential',
        knowledge_type=None, description=None, publish_type=publish_type,
        status=1, bound_info=None, created_by=created_by,
        created_at='2024-01-01 00:00:00', updated_at=updated or now_timestamp())


def _draft(workflow_id='wf1', version=1):
    return FlowDraft(workflow_id=workflow_id, node_config=[], other_node_config=[],
                     version=version, flow_type='workflow', created_by='admin')


def test_in_memory_store_workflow_branches():
    store = InMemoryFlowStore()
    store.create_workflow_with_draft(_record(), _draft())
    with pytest.raises(FlowStoreError):
        store.create_workflow_with_draft(_record(), _draft())
    with pytest.raises(FlowStoreError):
        store.create_workflow_with_draft(_record('wf2'),
                                         _draft('wf1'))  # 草稿冲突

    store.update_workflow('wf1', 'new-name', None, None, 'desc')
    with pytest.raises(FlowStoreError):
        store.update_workflow('ghost', 'x', None, None, None)

    store.update_publish_type('wf1', 1)
    assert store.get_workflow('wf1').publish_type == 1
    with pytest.raises(FlowStoreError):
        store.update_publish_type('ghost', 1)

    records, total = store.list_workflows('wf1', 1, 10)
    assert total == 1 and records[0].workflow_id == 'wf1'
    assert store.list_workflows(None, 1, 10)[1] == 1
    assert store.list_workflows('admin', 1, 10)[1] == 1  # 按创建人命中
    assert store.list_workflows('wf1', 1, 10, publish_type=1)[1] == 1

    assert store.get_draft('wf1') is not None
    store.update_draft('wf1', 'workflow', [{'a': 1}], [])
    assert store.get_draft('wf1').node_config == [{'a': 1}]
    store.update_draft_version('wf1', 3)
    assert store.get_draft('wf1').version == 3
    with pytest.raises(FlowStoreError):
        store.update_draft('ghost', 'workflow', [], [])
    with pytest.raises(FlowStoreError):
        store.update_draft_version('ghost', 2)
    assert store.list_drafts(['wf1', 'other']) and not store.list_drafts([])

    assert store.get_latest_published('wf1') is None
    assert store.get_max_published_version('wf1') == 0
    store.insert_published(FlowPublished(workflow_id='wf1', version=1,
                                         node_config=[], other_node_config=[],
                                         created_by='admin'))
    assert store.get_latest_published('wf1').version == 1
    with pytest.raises(FlowStoreError):
        store.insert_published(FlowPublished(workflow_id='wf1', version=1,
                                             node_config=[], other_node_config=[],
                                             created_by='admin'))
    assert store.get_max_published_version('wf1') == 1

    store.delete_workflow('wf1')
    assert store.get_workflow('wf1') is None
    assert store.get_draft('wf1') is None
    assert store.get_latest_published('wf1') is None


def test_list_workflows_orders_and_paginates():
    store = InMemoryFlowStore()
    store.create_workflow_with_draft(_record('a', updated='2024-01-02'), _draft('a'))
    store.create_workflow_with_draft(_record('b', updated='2024-01-03'), _draft('b'))
    records, total = store.list_workflows(None, 1, 1)
    assert total == 2
    assert records[0].workflow_id == 'b'   # 最近修改在前
    records, total = store.list_workflows(None, 2, 1)
    assert records[0].workflow_id == 'a' and total == 2


# ---------------------------------------------------------------------------
# PgFlowStore（打桩 _connect / _ensure_schema）
# ---------------------------------------------------------------------------

class _PgCursor:
    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=None):
        self._conn.executed.append((sql, params))
        if self._conn.raise_when_execute is not None:
            raise self._conn.raise_when_execute

    def fetchone(self):
        return self._conn.fetchone()

    def fetchall(self):
        return self._conn.fetchall

    def close(self):
        pass


class _PgConn:
    def __init__(self, raise_when_execute=None):
        self.executed = []
        self.raise_when_execute = raise_when_execute
        self.fetchone_queue = []
        self.fetchall = []
        self.rolled_back = 0
        self.commits = 0
        self.closed = 0

    def cursor(self):
        return _PgCursor(self)

    def fetchone(self):
        return self.fetchone_queue.pop(0) if self.fetchone_queue else None

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rolled_back += 1

    def close(self):
        self.closed += 1


_WORKFLOW_ROW = ('wf1', 'n', 'd', 'Sequential', None, 1, 1, None, 'admin',
                 '2024-01-01 00:00:00', '2024-01-01 00:00:00')


def _pg_store(monkeypatch, raise_when_execute=None):
    from workflow.repository_pg import PgFlowStore

    store = PgFlowStore()
    conn = _PgConn(raise_when_execute)
    monkeypatch.setattr(store, '_connect', lambda: conn)
    monkeypatch.setattr(store, '_ensure_schema', lambda _conn: None)
    return store, conn


def test_pg_store_workflow_crud_with_stubbed_conn(monkeypatch):
    store, conn = _pg_store(monkeypatch)
    conn.fetchone_queue = [list(_WORKFLOW_ROW), (1,), (1,), (1,)]
    conn.fetchall = [list(_WORKFLOW_ROW)]

    record = store.get_workflow('wf1')
    assert record.publish_type == 1

    records, total = store.list_workflows(None, 1, 10)
    assert total == 1 and records[0].workflow_id == 'wf1'
    records, total = store.list_workflows('wf _1', 1, 10, publish_type=1)
    assert total == 1 and records[0].workflow_id == 'wf1'

    assert [r.workflow_id for r in store.list_workflows_by_creator('admin')] == ['wf1']

    store.create_workflow_with_draft(
        WorkflowRecord(workflow_id='w2', name='n', template='t', knowledge_type=None,
                       description=None, publish_type=0, status=1, bound_info=None,
                       created_by='admin', created_at=None, updated_at=None),
        FlowDraft(workflow_id='w2', node_config=[{'x': 1}], other_node_config=[],
                  version=1, flow_type='workflow', created_by='admin'))
    assert conn.commits >= 1

    store.update_workflow('wf1', 'x', None, None, None)
    store.update_publish_type('wf1', 2)
    store.delete_workflow('wf1')
    assert sum('DELETE' in sql for sql, _ in conn.executed) == 3


def test_pg_store_draft_and_published_paths(monkeypatch):
    from workflow.repository_pg import _to_published

    store, conn = _pg_store(monkeypatch)
    conn.fetchone_queue = [('wf1', 2, None, None, None, 'admin',
                            '2024-01-01 00:00:00', '2024-01-01 00:00:00')]
    draft = store.get_draft('wf1')
    assert draft.flow_type == 'workflow'   # NULL → 默认
    assert draft.node_config == []
    conn.fetchone_queue = [(7,)]
    assert store.get_max_published_version('wf1') == 7
    conn.fetchone_queue = [('wf1', 4, None, None, None, 'admin', '2024-01-01 00:00:00')]
    assert store.get_latest_published('wf1').version == 4
    assert store.get_workflow('nope') is None
    assert store.get_draft('nope') is None
    assert store.get_latest_published('nope') is None

    conn.fetchall = []
    assert store.list_drafts(['x']) == []
    assert store.list_drafts([]) == []

    from psycopg2.extras import Json
    store.insert_draft(FlowDraft(workflow_id='w', node_config=[{'a': 1}],
                                 other_node_config=[], version=1, flow_type='workflow',
                                 created_by='u'))
    sql, params = conn.executed[-1]
    assert isinstance(params[3], Json)

    store.update_draft('w', 'workflow', [], [])
    store.update_draft_version('w', 9)
    store.insert_published(FlowPublished(workflow_id='w', version=2,
                                         node_config=[], other_node_config=[],
                                         created_by='u'))

    # 映射函数的 NULL 兜底分支
    published = _to_published(('wf1', 3, None, None, 'admin', '2024-01-01'))
    assert published.node_config == []


def test_pg_store_duplicate_and_db_error_wrapping(monkeypatch):
    from psycopg2 import errors as pg_errors
    import psycopg2

    store, conn = _pg_store(monkeypatch, raise_when_execute=pg_errors.UniqueViolation())
    with pytest.raises(FlowStoreError) as exc:
        store.delete_workflow('x')
    assert exc.value.kind == FlowStoreError.DUPLICATE
    assert conn.rolled_back == 1

    store2, conn2 = _pg_store(monkeypatch, raise_when_execute=psycopg2.Error('db down'))
    with pytest.raises(FlowStoreError) as exc:
        store2.delete_workflow('x')
    assert exc.value.kind == FlowStoreError.DB_ERROR

    store3, conn3 = _pg_store(monkeypatch, raise_when_execute=RuntimeError('other'))
    with pytest.raises(RuntimeError):
        store3.delete_workflow('x')
    assert conn3.rolled_back == 1


def test_like_pattern_escapes_metacharacters():
    from workflow.repository_pg import _like_pattern
    assert _like_pattern('wf_1%') == '%wf\\_1\\%%'
    assert _like_pattern('a\\b') == '%a\\\\b%'


# ---------------------------------------------------------------------------
# bindings
# ---------------------------------------------------------------------------

def test_bound_kbase_names_and_workflow_ids_binding(monkeypatch):
    store = InMemoryFlowStore()
    node = {'componentType': 'retriever', 'variables': {'retriever': [
        {'package': 'p', 'operator': 'VectorRetriever',
         'kwargs': {'knowledge_info_list': [{'knowledge_base_name': 'doc_abc|#|dev'}]}}]}}
    store.create_workflow_with_draft(_record('wf1', created_by='u1'), _draft('wf1'))
    store.update_draft('wf1', 'workflow', [node], [])
    monkeypatch.setattr(flow_bindings, 'create_default_store', lambda: store)

    bound = flow_bindings.bound_kbase_names('u1')
    assert bound == {'wf1': ['doc_abc']}
    assert flow_bindings.bound_kbase_names('nobody') == {}

    # identity_token('doc_abc') = 'abc'：与去前缀的标识比对
    assert flow_bindings.workflow_ids_binding('abc', 1, 'u1') == ['wf1']
    assert flow_bindings.workflow_ids_binding('nope', 2, 'u1') == []


def test_identity_token_strips_suffixes():
    assert flow_bindings.identity_token('doc_abc_vector|#|dev') == 'abc'
    assert flow_bindings.identity_token('graph_x_vector') == 'x'
    assert flow_bindings.identity_token('kb-9') == 'kb-9'
    assert flow_bindings.identity_token('') is None
    assert flow_bindings.identity_token(None) is None


# ---------------------------------------------------------------------------
# 模板装载 / 画布工具 / 消息 / 运行时配置
# ---------------------------------------------------------------------------

def test_load_template_missing_and_broken(monkeypatch, tmp_path):
    from workflow.template_loader import TEMPLATE_SUFFIX

    monkeypatch.setattr(template_loader, 'TEMPLATE_DIR', tmp_path)
    with pytest.raises(FlowError):
        template_loader.load_template('nope', 'zh')

    (tmp_path / f'zh_Sequential{TEMPLATE_SUFFIX}').write_text('{not json', encoding='utf-8')
    with pytest.raises(FlowError):
        template_loader.load_template('Sequential', 'zh')


def test_collect_kbase_names_from_bound_info():
    bound = {'running': [{'tableName': 'doc_a'}, {'tableName': 'graph_b'},
                         {'noTable': 1}, 'not-a-dict'],
             'dev': [{'tableName': 'doc_a'}], 'bad': None}
    assert template_loader.collect_kbase_names(bound) == ['doc_a', 'graph_b']
    assert template_loader.collect_kbase_names(None) == []
    assert template_loader.collect_kbase_names('x') == []


def test_fill_knowledge_binding_graph_vs_vector():
    bindings = template_loader.Bindings(names=['doc_a'], graph_names=['graph_g'],
                                        embedding='emb')
    vector_node = {'variables': {'retriever': [
        {'kwargs': {'knowledge_info_list': [{'knowledge_base_name': []}]}}]}}
    filled = template_loader._fill_knowledge_binding([vector_node], bindings)
    assert filled == {'retriever': 1}

    graph_node = {'variables': {'retriever': [
        {'operator': 'KnowledgeGraphRetriever',
         'kwargs': {'knowledge_base_name': []}}]}}
    assert template_loader._fill_knowledge_binding([graph_node], bindings) == \
        {'retriever': 1}

    # 图谱库名不是列表形状：写不进去，返回 0（不出现在 filled 里）
    bad_shape = {'variables': {'retriever': [
        {'operator': 'KnowledgeGraphRetriever', 'kwargs': {'knowledge_base_name': 'x'}}]}}
    assert template_loader._fill_knowledge_binding([bad_shape], bindings) == {}
    assert template_loader._fill_knowledge_binding([], bindings) == {}


def test_canvas_util_helpers():
    assert canvas_util.node_list(None) == []
    assert canvas_util.node_list([{'a': 1}, 'x']) == [{'a': 1}]
    assert canvas_util.find_engine_operator([
        {'componentType': 'QUERY_ENGINE', 'variables': {'queryengine': {'operator': 'E1'}}},
    ]) == 'E1'
    assert canvas_util.find_engine_operator([{'componentType': 'EDGES'}]) is None


def test_canvas_payload_size_and_structure_check():
    canvas = FlowCanvasInput.from_payload({
        'flowType': 'workflow', 'version': 1,
        'nodeConfigDTOList': [{'componentType': 'retriever'}],
        'otherNodeConfigList': [],
    })
    assert flow_validation.serialized_size(canvas) > 0
    # 非 list 的节点字段被归一成空列表：不抛错，照常序列化
    assert flow_validation.serialized_size(FlowCanvasInput.from_payload(
        {'nodeConfigDTOList': object()})) > 0


def test_messages_render_fallback_on_bad_args(monkeypatch):
    key = [k for k, v in flow_messages.MESSAGES.items()
           if isinstance(v, dict) and '{0}' in str(v)][0]
    assert flow_messages.render(key, 'zh') == flow_messages.MESSAGES[key]['zh']
    with_args = flow_messages.render(key, 'zh', 'x')
    assert 'x' in with_args
    # 两个占位符只给一个参数：IndexError 兜底返回带占位符的原文案
    monkeypatch.setitem(flow_messages.MESSAGES, 'misc.test.two', {'zh': 'a{0}b{1}c'})
    assert flow_messages.render('misc.test.two', 'zh', 'x') == 'a{0}b{1}c'
    # 未知键：回落键名
    assert flow_messages.render('misc.unknown.key', 'zh') == 'misc.unknown.key'


def test_runtime_config_from_env_dimension_fallback():
    caps = runtime_config.from_env({'EMBEDDING_DIMENSION': 'not-int',
                                    'EMBEDDING_MODEL': 'e1'})
    assert caps.embedding_dimensions == {'e1': runtime_config.DEFAULT_EMBEDDING_DIMENSION}
    caps2 = runtime_config.from_env({'EMBEDDING_MODEL': 'e1',
                                     'EMBEDDING_MODEL_NAME': 'e2'})
    assert caps2.embedding_models == ('e1', 'e2')
    assert not caps.has_probed_models()
    assert caps2.has_rerank_endpoint() is False


# ---------------------------------------------------------------------------
# FlowService 工具分支
# ---------------------------------------------------------------------------

def _service(store=None, capabilities=None):
    return FlowService(store or InMemoryFlowStore(),
                       capabilities=capabilities or RuntimeCapabilities())


def test_flow_service_export_and_knowledge_info():
    store = InMemoryFlowStore()
    service = _service(store)
    record = WorkflowRecord(workflow_id='wf1', name='n', template='Sequential',
                            knowledge_type=None, description=None, publish_type=0,
                            status=1, bound_info=None, created_by='admin',
                            created_at=None, updated_at=None)
    store.create_workflow_with_draft(record, FlowDraft(
        workflow_id='wf1', node_config=[{'componentType': 'retriever'}],
        other_node_config=[], version=1, flow_type='workflow', created_by='admin'))

    filename, content = service.export_flow_config('wf1', 'zh')
    assert filename.endswith('.json')
    assert json.loads(content)['appId'] == 'wf1'

    tokens = service.get_flow_knowledge_info('wf1', 'zh')
    assert isinstance(tokens, list)

    with pytest.raises(FlowError):
        service.get_flow_knowledge_info('ghost', 'zh')
    empty_service = _service(InMemoryFlowStore())
    assert empty_service.all_bound_kbase('', 'zh') == {}
    assert empty_service.all_bound_kbase('nobody', 'zh') == {}


def test_all_bound_kbase_lists_drafts():
    store = InMemoryFlowStore()
    service = _service(store)
    store.create_workflow_with_draft(_record('wf1', created_by='u'), _draft('wf1'))
    result = service.all_bound_kbase('u', 'zh')
    assert result == {'wf1': []}


def test_kbase_dimension_provider_failure_is_swallowed():
    store = InMemoryFlowStore()
    service = FlowService(store, capabilities=RuntimeCapabilities(),
                          kbase_dimension_provider=lambda names: (_ for _ in ()).throw(
                              RuntimeError('db down')))
    canvas = FlowCanvasInput.from_payload({'nodeConfigDTOList': [
        {'componentType': 'retriever', 'variables': {'retriever': [
            {'package': 'p', 'operator': 'VectorRetriever',
             'kwargs': {'knowledge_info_list': [{'knowledge_base_name': 'doc_x'}]}}]}}]})
    assert service._kbase_dimensions(canvas) == {}
    assert service._kbase_dimensions(FlowCanvasInput()) == {}


def test_capabilities_for_validation_with_probe(monkeypatch):
    class _Probe:
        def __init__(self, result):
            self._result = result

        def available(self):
            return self._result

    store = InMemoryFlowStore()
    service = FlowService(store, capabilities=RuntimeCapabilities(),
                          model_probe=_Probe(frozenset({'deepseek-chat'})))
    merged = service._capabilities_for_validation()
    assert merged.available_models == frozenset({'deepseek-chat'})

    service_none = FlowService(store, capabilities=RuntimeCapabilities(),
                               model_probe=_Probe(None))
    assert service_none._capabilities_for_validation().available_models == frozenset()
    assert FlowService(store, capabilities=RuntimeCapabilities(),
                       model_probe=None)._capabilities_for_validation()


def test_service_create_duplicate_and_delete_validation():
    store = InMemoryFlowStore()
    service = _service(store)
    payload = {'workFlowId': 'dup', 'name': 'n', 'template': 'Sequential',
               'boundInfo': {'running': [{'tableName': 'doc_dup',
                                          'embeddingModel': 'bge-base-zh-v1.5'}]}}
    service.create_workflow(dict(payload), 'admin', 'zh')
    with pytest.raises(FlowError):
        service.create_workflow(dict(payload), 'admin', 'zh')

    with pytest.raises(Exception):
        service.delete_workflow({'workflowId': '  '}, 'zh')
    with pytest.raises(FlowError):
        service.delete_workflow({'workflowId': 'ghost'}, 'zh')
    service.delete_workflow({'workflowId': 'dup'}, 'zh')

    with pytest.raises(Exception):
        service.update_workflow({'workFlowId': 'ghost', 'name': 'x'}, 'zh')


def test_publish_type_parsing():
    from workflow.service import _publish_type, _first_present
    assert _publish_type(None) is None
    assert _publish_type('') is None
    assert _publish_type('1') == 1
    with pytest.raises(Exception):
        _publish_type('x')
    with pytest.raises(Exception):
        _publish_type('9')
    assert _first_present({'a': '', 'b': 'ok'}, 'a', 'b') == 'ok'
    assert _first_present({}, 'a') is None


def test_flatten_bound_kbs():
    from workflow.service import _flatten_bound_kbs
    assert _flatten_bound_kbs({'running': [{'tableName': 't'}], 'dev': None}) == [{'tableName': 't'}]
    assert _flatten_bound_kbs(None) == []
    assert _flatten_bound_kbs('x') == []
    assert _flatten_bound_kbs({'a': ['skip-me', {'ok': 1}]}) == [{'ok': 1}]


def test_mark_draft_changed():
    store = InMemoryFlowStore()
    service = _service(store)
    store.create_workflow_with_draft(_record('wf1', publish_type=1), _draft('wf1'))
    service._mark_draft_changed('wf1')
    assert store.get_workflow('wf1').publish_type == 2
    service._mark_draft_changed('ghost')  # 不存在：静默
    store.create_workflow_with_draft(_record('wf0', publish_type=0), _draft('wf0'))
    service._mark_draft_changed('wf0')
    assert store.get_workflow('wf0').publish_type == 0


def test_to_vo_requires_record():
    service = _service()
    with pytest.raises(FlowError):
        service._to_vo(None)


# ---------------------------------------------------------------------------
# responses / router 信封
# ---------------------------------------------------------------------------

class _FakeRequest:
    def __init__(self, headers=None, path='/x'):
        self.headers = headers or {}
        self.url = type('U', (), {'path': path})()
        self.query_params = {}
        self.state = type('S', (), {'auth_user': None})()


def test_responses_server_error_envelope():
    response = flow_responses.server_error(_FakeRequest(), 'zh')
    assert response.status_code == 500


def test_parse_json_body_variants():
    assert flow_responses.parse_json_body(b'') == {}
    assert flow_responses.parse_json_body(b'{"a": 1}') == {'a': 1}
    with pytest.raises(FlowMalformedRequestError):
        flow_responses.parse_json_body(b'\xff\xfe', required=True)
    with pytest.raises(FlowMalformedRequestError):
        flow_responses.parse_json_body(b'null', required=True)
    assert flow_responses.parse_json_body(b'null', required=False) == {}
    with pytest.raises(FlowMalformedRequestError):
        flow_responses.parse_json_body(b'[1]')


def test_validation_rerank_and_embedding_helpers():
    canvas = FlowCanvasInput.from_payload({'nodeConfigDTOList': [
        {'componentType': 'post_retriever', 'variables': {'postretriever': [
            {'package': 'p', 'operator': 'RerankRetriever',
             'kwargs': {'model': 'rr-1'}}]}}]})
    assert flow_validation.find_unavailable_models(
        canvas, RuntimeCapabilities(rerank_url='http://rr')) == []
    assert flow_validation.find_embedding_dimension_mismatches(
        canvas, RuntimeCapabilities(rerank_url='http://rr'), {'doc_x': 768}) == []
    assert flow_validation.find_reasoning_model_in_query_rewriter(
        canvas, RuntimeCapabilities(rerank_url='http://rr')) is None
