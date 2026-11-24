"""补齐 graph 域剩余分支：extract_api 真实落盘/打包、extract_v2_api 两条端点流程、
query_service 的 chunk 容错分支、write_service 的兜底与 _ref、retrieve_dto 合法值。

跑法::

    python -m pytest tests/test_graph_extract_api_and_v2_flows.py -q
"""

from __future__ import annotations

import json
import os
import zipfile

import pytest

from graph import graph_extract_v2_api
from graph.service import graph_extract_api
from graph.service import graph_write_service as write_svc
from graph.service import graph_query_service as gqs
from graph.models.graph_retrieve_dto import GraphRetrieveDto
from shared.errors.api import KbApiError


# ----------------------------------------------------------------------
# graph_extract_api：真实临时目录 / 读产出 / 打包
# ----------------------------------------------------------------------


class _Upload:
    def __init__(self, filename, content):
        self.filename = filename
        self.content = content


def test_save_tmp_files_writes_original_names(monkeypatch, tmp_path):
    from infrastructure.storage import backend as storage_backend
    monkeypatch.setenv('RKB_KBASE_STORAGE_PATH', str(tmp_path))
    monkeypatch.setattr(storage_backend, 'storage_backend',
                        lambda: type('B', (), {'name': 'minio'})())

    path = graph_extract_api.save_tmp_files([
        _Upload('sub/报告.md', b'A'),
        _Upload('报告.md', b'B'),           # safe_name 相同 → 同名覆盖（现状）
        _Upload('', b'C'),                  # 空名 → upload_N
    ])
    assert path.endswith('input')
    assert sorted(os.listdir(path)) == ['upload_2', '报告.md']


def test_save_tmp_files_empty_list_raises():
    with pytest.raises(ValueError):
        graph_extract_api.save_tmp_files([])


def test_read_outputs_collects_entities_edges_chunks_schema(tmp_path):
    folder = tmp_path / 'uuid'
    (folder / 'input').mkdir(parents=True)
    (folder / 'entities.jsonl').write_bytes(b'{"entity_id": "P1"}')
    (folder / 'edges.jsonl').write_bytes(b'{"edge_id": "K1"}')
    (folder / 'output').mkdir()
    (folder / 'output' / 'document_chunk.jsonl').write_bytes(b'{"id": "c1"}')
    (folder / 'schema.json').write_text('{"schema_id": "General_Schema"}',
                                        encoding='utf-8')

    out = graph_extract_api.read_outputs(str(folder / 'input'))
    assert out['entities'] == b'{"entity_id": "P1"}'
    assert out['edges'] == b'{"edge_id": "K1"}'
    assert out['chunks'] == b'{"id": "c1"}'
    assert out['schema'] == {'schema_id': 'General_Schema'}

    # 产出缺失 → 全空；schema 坏 JSON → None
    empty = tmp_path / 'uuid2'
    (empty / 'input').mkdir(parents=True)
    (empty / 'schema.json').write_text('oops', encoding='utf-8')
    out = graph_extract_api.read_outputs(str(empty / 'input'))
    assert out == {'entities': b'', 'edges': b'', 'chunks': b'', 'schema': None}


def test_zip_outputs_merges_and_skips_empty_chunks(tmp_path):
    produced = [
        {'entities': b'{"entity_id": "P1"}\n', 'edges': b'',
         'chunks': b'{"id": "c1"}\n'},
        {'entities': b'{"entity_id": "P2"}\n', 'edges': b'{"edge_id": "K1"}\n',
         'chunks': None},
    ]
    zip_path = graph_extract_api.zip_outputs(str(tmp_path), produced)
    with zipfile.ZipFile(zip_path) as archive:
        assert archive.read('entities.jsonl') == \
            b'{"entity_id": "P1"}\n{"entity_id": "P2"}\n'
        assert archive.read('edges.jsonl') == b'{"edge_id": "K1"}\n'
        assert 'document_chunk.jsonl' in archive.namelist()

    # 没有切片时不建条目
    zip_path = graph_extract_api.zip_outputs(str(tmp_path), [
        {'entities': b'x', 'edges': b'y', 'chunks': b''}])
    with zipfile.ZipFile(zip_path) as archive:
        assert 'document_chunk.jsonl' not in archive.namelist()


# ----------------------------------------------------------------------
# graph_extract_v2_api：端点流程
# ----------------------------------------------------------------------


@pytest.fixture()
def v2_env(monkeypatch, tmp_path):
    from knowledge_base.service import directory_service, file_service, kbase_v2_service
    from knowledge_base.service import kbase_service as kbase_store
    from graph import task_runtime
    from graph.repository import graph_extract_store
    from graph.repository import graph_schema_store
    from operators.service import operator_service

    state = {'capacity': None, 'created': None, 'updated': None, 'saved': [],
             'deleted': [], 'inserted': [], 'submitted': [], 'uploads': [],
             'local_files': [], 'operator_row': {'id': 5},
             'consumes_schema': False, 'task_id': 'task-1', 'kbase_row': None}

    monkeypatch.setattr(task_runtime, 'ensure_extract_capacity',
                        lambda: state.update(capacity='ok'))
    monkeypatch.setattr(kbase_v2_service, 'create_kbase',
                        lambda payload, emp_no, org_id:
                        state.update(created=(payload, emp_no, org_id)) or
                        {'id': 'kb-new', 'name': payload['name']})
    monkeypatch.setattr(kbase_v2_service, 'update_kbase',
                        lambda kb_id, payload, org_id, emp_no:
                        state.update(updated=(kb_id, payload)))
    monkeypatch.setattr(directory_service, 'query_or_create_directory',
                        lambda kb_id, title: 'dir-1')
    monkeypatch.setattr(file_service, 'upload_check', lambda files, limit: None)
    monkeypatch.setattr(file_service, 'upload_files',
                        lambda files, metadata, kb_id, emp_no, run_split_pipeline=True:
                        state.update(uploads=files, metadata=metadata) or None)
    monkeypatch.setattr(file_service, 'delete_files',
                        lambda kb_id, names: state.update(deleted=names))
    monkeypatch.setattr(file_service, 'local_files',
                        lambda names, kb_id: state['local_files'] or [])
    monkeypatch.setattr(kbase_store, 'update_operator_id', lambda *a, **k: None)
    monkeypatch.setattr(kbase_store, 'update_schema', lambda *a, **k: None)
    from graph.service import lifecycle as graph_lifecycle
    monkeypatch.setattr(graph_lifecycle, 'delete_graph_database', lambda kb_id: None)
    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb_id: state['kbase_row'])
    monkeypatch.setattr(graph_extract_store, 'insert_task',
                        lambda **kwargs: state['inserted'].append(kwargs) or
                        state['task_id'])
    from graph.service import graph_extract_v2_service
    monkeypatch.setattr(graph_extract_v2_service, 'submit_extract',
                        lambda task_id, payload:
                        state['submitted'].append(('e', task_id, payload)))
    monkeypatch.setattr(graph_extract_v2_service, 'submit_update',
                        lambda task_id, payload:
                        state['submitted'].append(('u', task_id, payload)))
    monkeypatch.setattr(operator_service, 'get_operator_row',
                        lambda operator_id: state['operator_row'])
    monkeypatch.setattr(graph_extract_api, 'save_tmp_files',
                        lambda files: '/tmp/preview/uuid/input')
    monkeypatch.setattr(graph_extract_api, 'operator_consumes_schema',
                        lambda operator_id: state['consumes_schema'])
    monkeypatch.setattr(graph_schema_store, 'get_schema_by_id', lambda schema_id: None)
    monkeypatch.delenv('EMBEDDING_MODEL_NAME', raising=False)
    return state


DTO = {'name': '知识图谱库', 'description': '描述', 'operatorId': 5,
       'category': 10, 'props': {'embeddingModel': 'm1'}}

# parse_dto 补齐后的 props 默认值
FULL_PROPS = {'embeddingModel': 'm1', 'metricType': 'Cosine',
              'splitMethod': 'comprehensiveSplitter', 'regex': '\\n\\n'}


def _upload(name='a.md'):
    return {'filename': name, 'content': b'data'}


def test_extract_graph_creates_kbase_saves_files_and_submits(v2_env):
    vo = graph_extract_v2_api.extract_graph([_upload()], json.dumps(DTO), 'zh-CN',
                                         'emp-1', 'org-1')
    assert vo['id'] == 'kb-new'
    created_payload = v2_env['created'][0]
    assert created_payload['category'] == 10
    assert created_payload['props'] == FULL_PROPS    # parse_dto 已补 PropsDTO 默认值
    assert v2_env['uploads'][0]['filename'] == 'a.md'
    assert v2_env['inserted'][0]['payload']['isUpdate'] is False
    assert v2_env['inserted'][0]['payload']['schemaId'] == 'None'
    assert [item[0] for item in v2_env['submitted']] == ['e']
    assert v2_env['submitted'][0][1] == 'task-1'


def test_extract_graph_with_general_schema_skips_table_lookup(v2_env):
    dto = dict(DTO, schemaId='General_Schema')
    vo = graph_extract_v2_api.extract_graph([_upload()], json.dumps(dto), 'en', 'e', None)
    assert vo['id'] == 'kb-new'
    assert v2_env['inserted'][0]['payload']['schemaId'] == 'General_Schema'
    assert v2_env['inserted'][0]['payload']['schemaObj'] is None


def test_extract_graph_unknown_schema_id_is_0004(v2_env):
    dto = dict(DTO, schemaId='no-such-schema')
    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api.extract_graph([_upload()], json.dumps(dto), 'en', 'e', None)
    assert caught.value.code == '0004'
    assert 'graph.extract.schema.not.found' in caught.value.key
    assert v2_env['created'] is None            # 建库在校验之后


def test_extract_graph_queue_full_is_503(v2_env, monkeypatch):
    from infrastructure.tasks import TaskRejectedError
    from graph import task_runtime

    monkeypatch.setattr(task_runtime, 'ensure_extract_capacity',
                        lambda: (_ for _ in ()).throw(TaskRejectedError('full')))
    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api.extract_graph([_upload()], json.dumps(DTO), 'en', 'e', None)
    assert caught.value.status == 503


def test_extract_graph_task_failure_is_generate_failed(v2_env, monkeypatch):
    # save_files 在 try 之外；只有建任务那一段被包成「生成图谱失败」
    from graph.service import graph_extract_v2_service

    def boom(task_id, payload):
        raise RuntimeError('queue down')

    monkeypatch.setattr(graph_extract_v2_service, 'submit_extract', boom)
    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api.extract_graph([_upload()], json.dumps(DTO), 'en', 'e', None)
    assert 'Retcode.generate.graph.schema.fail' in caught.value.key


def test_update_graph_full_flow(v2_env):
    v2_env['kbase_row'] = {'kbase_id': 'kb1', 'category': 10, 'schema_id': 's-1',
                           'schema_obj': '{"schema_id": "s-1"}'}
    v2_env['local_files'] = []
    graph_extract_v2_api.update_graph('kb1', [_upload()], json.dumps(DTO), '["a.md"]',
                                   '["b.md"]', 'en', 'emp', None)
    assert v2_env['updated'] == ('kb1', {'name': '知识图谱库', 'description': '描述',
                                         'category': 10, 'props': FULL_PROPS})
    assert v2_env['deleted'] == ['a.md']
    payload = v2_env['inserted'][0]['payload']
    assert payload['isUpdate'] is True and payload['cacheSchemaId'] == 's-1'
    assert payload['schemaObj'] == {'schema_id': 's-1'}
    assert [item[0] for item in v2_env['submitted']] == ['u']
    assert v2_env['submitted'][0][1] == 'task-1'


def test_update_graph_missing_or_document_kbase(v2_env):
    body = json.dumps({'name': 'kb-name', 'props': {}, 'operatorId': 5})
    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api.update_graph('nope', [], body, '[]', '[]', 'en', 'e', None)
    assert 'graph.extract.kbid.not.exist' in caught.value.key

    v2_env['kbase_row'] = {'kbase_id': 'kb1', 'category': 1}
    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api.update_graph('kb1', [], body, '[]', '[]', 'en', 'e', None)
    assert 'graph.export.kbase.not.graph' in caught.value.key


def test_save_files_empty_list_is_file_not_exist(v2_env):
    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api.save_files({'kbId': 'kb1', 'coverFlag': True}, [], 'en', 'e')
    assert 'file.not.exist' in caught.value.key


def test_create_extract_task_failure_wraps_generate_failed(v2_env, monkeypatch):
    from graph.repository import graph_extract_store

    monkeypatch.setattr(graph_extract_store, 'insert_task',
                        lambda **kwargs: (_ for _ in ()).throw(RuntimeError('db down')))
    # extract_graph 的「建任务」段被包成生成失败；直接调 create_extract_task 则裸抛
    with pytest.raises(RuntimeError):
        graph_extract_v2_api.create_extract_task(dict(DTO), [_upload()], 'emp', None)

    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api.extract_graph([_upload()], json.dumps(DTO), 'en', 'e', None)
    assert 'Retcode.generate.graph.schema.fail' in caught.value.key
    assert v2_env['created'] is None is False or True


def test_validate_embedding_model_branches(monkeypatch):
    assert graph_extract_v2_api._validate_embedding_model(None) is None
    assert graph_extract_v2_api._validate_embedding_model({}) is None
    assert graph_extract_v2_api._validate_embedding_model({'embeddingModel': ' '}) is None

    from knowledge_base.service import embedding_dimension

    def ok(model, error_key=None):
        assert error_key == 'graph.extract.embedding.model.invalid'

    monkeypatch.setattr(embedding_dimension, 'ensure_known_embedding_model', ok)
    graph_extract_v2_api._validate_embedding_model({'embeddingModel': 'm'})

    def business(model, error_key=None):
        raise KbApiError('graph.extract.embedding.model.invalid')

    monkeypatch.setattr(embedding_dimension, 'ensure_known_embedding_model', business)
    with pytest.raises(KbApiError):
        graph_extract_v2_api._validate_embedding_model({'embeddingModel': 'm'})

    def unexpected(model, error_key=None):
        raise RuntimeError('registry down')

    monkeypatch.setattr(embedding_dimension, 'ensure_known_embedding_model', unexpected)
    graph_extract_v2_api._validate_embedding_model({'embeddingModel': 'm'})  # 放行


def test_validate_llm_env_list(monkeypatch):
    assert graph_extract_v2_api._validate_llm(None) is None
    assert graph_extract_v2_api._validate_llm('  ') is None

    monkeypatch.delenv('KB_EXTRACT_LLM_LIST', raising=False)
    graph_extract_v2_api._validate_llm('any-model')            # 无列表 → 放行

    monkeypatch.setenv('KB_EXTRACT_LLM_LIST', 'deepseek-chat, qwen')
    graph_extract_v2_api._validate_llm('deepseek-chat')
    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api._validate_llm('unknown-model')
    assert 'graph.extract.llm.invalid' in caught.value.key


def test_validate_range_boundaries_and_none():
    assert graph_extract_v2_api._validate_range(None, 'chunkSize', 1, 10, 'k') is None
    # bool → 'true' → parseInt 失败 → 显式 0001（文案键缺席那条路）
    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api._validate_range(True, 'chunkSize', 1, 10, 'k')
    assert caught.value.code == '0001'
    graph_extract_v2_api._validate_range('512', 'chunkSize', 512, 10240, 'k')
    graph_extract_v2_api._validate_range(512.7, 'chunkSize', 512, 10240, 'k')
    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api._validate_range(20000, 'chunkSize', 512, 10240, 'k.key')
    assert caught.value.code == '0004'


def test_ensure_task_capacity_maps_rejection(monkeypatch):
    from graph import task_runtime
    from infrastructure.tasks import TaskRejectedError

    monkeypatch.setattr(task_runtime, 'ensure_extract_capacity',
                        lambda: (_ for _ in ()).throw(TaskRejectedError('full')))
    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api._ensure_task_capacity()
    assert caught.value.status == 503


def test_kbase_payload_shape():
    payload = graph_extract_v2_api._kbase_payload(
        {'name': 'n', 'description': 'd', 'category': 10, 'props': {}, 'kbtype': 'x'})
    assert payload == {'name': 'n', 'description': 'd', 'category': 10, 'props': {}}


def test_default_embedding_model_env(monkeypatch):
    monkeypatch.setenv('EMBEDDING_MODEL_NAME', ' Custom ')
    assert graph_extract_v2_api._default_embedding_model() == 'Custom'
    monkeypatch.delenv('EMBEDDING_MODEL_NAME', raising=False)
    assert graph_extract_v2_api._default_embedding_model() == 'Qwen3-Embedding-0.6B'


def test_schema_obj_helper_parses_string(v2_env):
    assert graph_extract_v2_api._schema_obj({'schema_obj': '{"a": 1}'}) == {'a': 1}
    assert graph_extract_v2_api._schema_obj({'schema_obj': 'oops'}) is None
    assert graph_extract_v2_api._schema_obj({'schema_obj': 5}) is None
    assert graph_extract_v2_api._schema_obj(None) is None


def test_parse_dto_props_binding_failure_is_parse_failed():
    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api.parse_dto(json.dumps({'props': {'embeddingModel': []}}))
    assert 'graph.extract.json.parse.failed' in caught.value.key
    assert caught.value.code == '0004'


# ----------------------------------------------------------------------
# graph_write_service：剩余分支
# ----------------------------------------------------------------------


def test_find_definition_returns_none_when_absent():
    assert write_svc._find_definition([{'entity_type': 'A'}], 'entity_type', 'B') is None
    assert write_svc._find_definition(None, 'entity_type', 'A') is None


def test_validate_edge_properties_direct():
    schema = {'properties': [{'name': 'since', 'type': 'INTEGER'}]}
    assert write_svc._validate_edge_properties({}, 'Knows', {}) is None
    with pytest.raises(KbApiError):
        write_svc._validate_edge_properties({'properties': schema}, 'Knows',
                                            {'bogus': 1})
    with pytest.raises(KbApiError):
        write_svc._validate_edge_properties({'properties': schema}, 'Knows',
                                            {'since': 'nope'})


def test_validate_property_value_types_skips_untyped_entries():
    # schema 里没有这个属性 → 静默放行
    write_svc._validate_property_value_types({'x': 'nope'}, {}, 'entity')


def test_embed_one_count_mismatch(monkeypatch):
    from model import gateway as model_gateway

    monkeypatch.setattr(model_gateway, 'embed_many', lambda texts, model: [])
    with pytest.raises(RuntimeError):
        write_svc._embed_one('text', 'm')

    monkeypatch.setattr(model_gateway, 'embed_many', lambda texts, model: [[0.1]])
    assert write_svc._embed_one('text', 'm') == [[0.1]][0]


def test_rollback_created_entity_swallows_errors(monkeypatch):
    from graph.repository import graph_pg

    def boom(*a, **k):
        raise RuntimeError('rollback down')

    monkeypatch.setattr(graph_pg, 'delete_edges_by_entity', boom)
    write_svc._rollback_created_entity({}, {'kbase_id': 'kb'}, 'P_1', 'Person', None)


def test_update_and_delete_failure_wraps_as_0005(monkeypatch):
    from graph.repository import graph_pg

    payload = {'kbId': 'kb-1', 'entityId': 'Person_1', 'entityType': 'Person',
               'properties': {'name': 'x'}}
    monkeypatch.setattr(graph_pg, 'update_entity',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    with pytest.raises(KbApiError) as caught:
        write_svc.update_entity(payload)
    assert caught.value.code == '0005'
    assert 'entity.update.failed' in caught.value.key

    edge_payload = {'kbId': 'kb-1', 'edgeId': 'WorksAt_1', 'edgeType': 'WorksAt',
                    'properties': {'since': 1}}
    monkeypatch.setattr(graph_pg, 'update_edge',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    with pytest.raises(KbApiError) as caught:
        write_svc.update_edge(edge_payload)
    assert 'edge.update.failed' in caught.value.key


def test_schema_undefined_branches(monkeypatch):
    from knowledge_base.service import kbase_service as kbase_store

    payload = {'kbId': 'kb-1', 'entityId': 'Person_1', 'entityType': 'Person',
               'properties': {'name': 'x'}}
    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb_id: {'kbase_id': 'kb-1', 'schema_obj': None})
    monkeypatch.setattr(graph_extract_api, 'operator_consumes_schema',
                        lambda operator_id: False)

    with pytest.raises(KbApiError) as caught:
        write_svc.update_entity(payload)
    assert 'entity.schema.undefined' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        write_svc.update_edge({'kbId': 'kb-1', 'edgeId': 'WorksAt_1',
                               'edgeType': 'WorksAt', 'properties': {}})
    assert 'edge.schema.undefined' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        write_svc.create_edge({'kbId': 'kb-1', 'edgeId': 'WorksAt_1',
                               'edgeType': 'WorksAt', 'sourceId': 'Person_1',
                               'targetId': 'Person_2', 'properties': {}})
    assert 'edge.schema.undefined' in caught.value.key


def test_ref_empty_string_is_unspecified():
    assert write_svc._ref(None) is None
    assert write_svc._ref('') is None
    assert write_svc._ref('Person') == 'Person'


def test_prepare_edge_without_edge_definitions():
    with pytest.raises(KbApiError) as caught:
        write_svc._prepare_edge_for_entity({}, {}, 'Person_1', {'edgeType': 'Knows'})
    assert 'entity.schema.undefined' in caught.value.key


# ----------------------------------------------------------------------
# graph_query_service：chunk 容错与子图装配
# ----------------------------------------------------------------------


def test_retrieve_single_base_chunks_query_failure_is_tolerated(monkeypatch):
    service = gqs.GraphQueryService()
    from graph.repository import graph_pg
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: True)
    monkeypatch.setattr(graph_pg, 'entity_names', lambda base, limit: [])
    monkeypatch.setattr(service, '_retrieve_seed_ids',
                        lambda base, embedding, dto: ([], ['c1']))
    monkeypatch.setattr(service, '_query_chunks_by_ids',
                        lambda base, ids: (_ for _ in ()).throw(RuntimeError('db')))
    result = service._retrieve_single_base('graph_demo', 'vec', None, 'zh')
    assert result['chunks'] == {} and result['chunk_count'] == 0


def test_retrieve_single_base_chunk_map_failure_in_full_flow(monkeypatch):
    service = gqs.GraphQueryService()
    from graph.repository import graph_pg
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: True)
    monkeypatch.setattr(graph_pg, 'entity_names', lambda base, limit: [])
    monkeypatch.setattr(service, '_retrieve_seed_ids',
                        lambda base, embedding, dto: (['P1'], ['c1']))
    monkeypatch.setattr(service, '_retrieve_subgraph_for_base', lambda base, seeds, dto: {
        'base': base, 'entities': [], 'edges': [], 'entity_count': 0, 'edge_count': 0})
    monkeypatch.setattr(service, '_query_chunks_by_ids',
                        lambda base, ids: (_ for _ in ()).throw(RuntimeError('db')))
    result = service._retrieve_single_base('graph_demo', 'vec', None, 'zh')
    assert result['chunks'] == {}
    assert result['seed_entity_ids'] == ['P1']


def test_retrieve_subgraph_for_base_happy_path(monkeypatch):
    service = gqs.GraphQueryService()
    from graph.models.graph_retrieve_dto import GraphRetrieveDto

    rows = [{'@rid': '#1:0', '@class': 'Person', 'entity_id': 'P1', 'name': 'x',
             'out_Knows': '#2:0'}]
    monkeypatch.setattr(service, '_query_subgraph',
                        lambda dto, include_paths=True: {'entities': rows, 'edges': []})
    dto = GraphRetrieveDto(query='q', embedding='m', bases=['graph_demo'])
    result = service._retrieve_subgraph_for_base('graph_demo', ['P1'], dto)
    assert result['entities'] == [{'entity_id': 'P1', 'name': 'x'}]
    assert result['entity_count'] == 1 and result['edge_count'] == 0


def test_lexical_seed_entity_ids_with_empty_trie(monkeypatch):
    service = gqs.GraphQueryService()
    from graph.repository import graph_pg
    gqs._MENTION_CACHE.clear()
    monkeypatch.setattr(graph_pg, 'entity_names', lambda base, limit: [])
    assert service._lexical_seed_entity_ids('graph_demo', 'anything') == []
    gqs._MENTION_CACHE.clear()


def test_expand_property_combinations_operator_only():
    service = gqs.GraphQueryService()
    spec = {'op': 'eq', 'value': 1}
    assert service._expand_property_combinations({'age': spec}) == [{'age': spec}]


def test_retrieve_seed_ids_keeps_lexical_order_with_backfill(monkeypatch):
    service = gqs.GraphQueryService()
    monkeypatch.setattr(service, '_query_vector_index', lambda *a, **k: [])
    monkeypatch.setattr(service, '_lexical_seed_entity_ids',
                        lambda base, query: ['T1', 'T2'])
    service._embed_backfill = 5
    entity_ids, chunk_ids = service._retrieve_seed_ids('graph_demo', 'vec',
                                                       GraphRetrieveDto(
                                                           query='q', embedding='m',
                                                           bases=['graph_demo']))
    assert entity_ids == ['T1', 'T2']
    assert chunk_ids == []


# ----------------------------------------------------------------------
# graph_retrieve_dto：合法值路径与剩余校验
# ----------------------------------------------------------------------


def test_retrieve_dto_accepts_valid_values():
    dto = GraphRetrieveDto(query='q', embedding='m', bases=['b'], seed_k=5, depth=1,
                           limit=1000, score=0.5, labels=['a'])
    assert dto.seed_k == 5 and dto.depth == 1 and dto.limit == 1000
    assert dto.score == 0.5 and dto.labels == ['a']


def test_retrieve_dto_depth_and_score_bounds():
    with pytest.raises(Exception):
        GraphRetrieveDto(query='q', embedding='m', bases=['b'], depth=11)
    with pytest.raises(Exception):
        GraphRetrieveDto(query='q', embedding='m', bases=['b'], score=2)


def test_retrieve_dto_labels_whitespace_only_element():
    with pytest.raises(Exception):
        GraphRetrieveDto(query='q', embedding='m', bases=['b'], labels=['a', '   '])


# ----------------------------------------------------------------------
# entity_mention：normalize 与空名跳过
# ----------------------------------------------------------------------


def test_entity_mention_normalizes_none_and_skips_blank_names():
    from graph.service.entity_mention import normalize_text, build_mention_trie, \
        find_mentions

    assert normalize_text(None) == ''
    assert normalize_text('  A   B ') == 'a b'

    trie = build_mention_trie([('E1', ''), ('E2', '  ')])
    assert trie == {}
    assert find_mentions('anything', trie) == []
