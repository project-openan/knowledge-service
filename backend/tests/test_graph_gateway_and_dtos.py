"""graph_retrieve_gateway 的错误文案/映射、errors.py、三个 models DTO。

网关钉的是：``graph_error_message`` 按码+语言取文案、带参数做 ``format``、
未知码回落「操作失败」；``graph_problem_spec`` 未知码按 500；
``retrieve_result`` 把 EMException 包成 ``GraphRetrieveError``。
DTO 钉的是：pydantic v1 validator 的每条边界（空列表拒绝、labels 去重等）。

跑法::

    python -m pytest tests/test_graph_gateway_and_dtos.py -q
"""

from __future__ import annotations

import json

import pytest

from graph.errors import GraphException
from graph.service import graph_retrieve_gateway as gw
from graph.models.graph_query_dto import GraphFilter, GraphQueryDto
from graph.models.graph_retrieve_dto import GraphRetrieveDto
from graph.models.kg_struct import EdgeData, EntityData, GraphStruct
from shared.errors.exception import EMException
from shared.problem import INTERNAL_ERROR, UPSTREAM_UNAVAILABLE
from pydantic import ValidationError


# ----------------------------------------------------------------------
# errors.py
# ----------------------------------------------------------------------


def test_graph_exception_carries_code_and_args():
    error = GraphException('KG020', 'Entity not found: P1')
    assert error.get_errcode() == 'KG020'
    assert error.get_args() == ('Entity not found: P1',)
    assert str(error) == 'KG020'
    assert isinstance(error, EMException)


# ----------------------------------------------------------------------
# 文案与 problem 映射
# ----------------------------------------------------------------------


def test_error_message_known_codes_by_language():
    zh = gw.graph_error_message(EMException('kb-not-exists'), 'zh')
    assert zh == '知识库不存在'
    en = gw.graph_error_message(EMException('kb-not-exists'), 'en')
    assert en == 'Knowledge base does not exist'
    # 未知语言回落英文
    assert gw.graph_error_message(EMException('kb-not-exists'), 'fr') == en


def test_error_message_formats_args():
    message = gw.graph_error_message(
        EMException('entity-id-length-exceed', 120), 'zh')
    assert '120' in message

    message = gw.graph_error_message(
        EMException('edge-target-node-type-mismatch', 'Knows', 'Robot', 'Person'),
        'en')
    assert 'Robot' in message and 'Person' in message


def test_error_message_unknown_code_falls_back():
    assert gw.graph_error_message(EMException('totally-unknown'), 'zh') == '操作失败'
    assert gw.graph_error_message(EMException('totally-unknown'), 'en') == \
        'Operation failed'
    assert gw.graph_error_message(EMException('totally-unknown'), 'zz') == \
        'Operation failed'


def test_problem_spec_mapping():
    assert gw.graph_problem_spec('embedding-service-error') is UPSTREAM_UNAVAILABLE
    assert gw.graph_problem_spec('database-operation-failed') is INTERNAL_ERROR
    assert gw.graph_problem_spec('never-heard-of') is INTERNAL_ERROR


class _Headers:
    def __init__(self, language='en'):
        self._language = language

    def get_language_option(self):
        return self._language


class _Dto:
    bases = ['graph_demo']
    query = ''
    seed_k = 5
    depth = 1


def test_retrieve_result_wraps_business_error(monkeypatch):
    class FakeService:
        def retrieve_graph(self, dto, headers):
            raise EMException('embedding-service-error')

    monkeypatch.setattr(gw, 'GraphQueryService', FakeService)
    with pytest.raises(gw.GraphRetrieveError) as caught:
        gw.retrieve_result(_Dto(), _Headers('zh'))
    assert caught.value.spec is UPSTREAM_UNAVAILABLE
    assert caught.value.detail == 'Embedding服务调用失败'


def test_retrieve_result_wraps_unexpected_error(monkeypatch):
    class FakeService:
        def retrieve_graph(self, dto, headers):
            raise RuntimeError('boom')

    monkeypatch.setattr(gw, 'GraphQueryService', FakeService)
    with pytest.raises(gw.GraphRetrieveError) as caught:
        gw.retrieve_result(_Dto(), _Headers('en'))
    assert caught.value.spec is INTERNAL_ERROR


def test_retrieve_result_passes_through_graph_error(monkeypatch):
    class FakeService:
        def retrieve_graph(self, dto, headers):
            raise gw.GraphRetrieveError(INTERNAL_ERROR, 'already detailed')

    monkeypatch.setattr(gw, 'GraphQueryService', FakeService)
    with pytest.raises(gw.GraphRetrieveError) as caught:
        gw.retrieve_result(_Dto(), _Headers())
    assert caught.value.detail == 'already detailed'


def test_retrieve_result_returns_service_payload(monkeypatch):
    class FakeService:
        def retrieve_graph(self, dto, headers):
            return {'base_results': [], 'total_entities': 0}

    monkeypatch.setattr(gw, 'GraphQueryService', FakeService)
    assert gw.retrieve_result(_Dto(), None)['base_results'] == []


def test_retrieve_result_from_payload_binds_and_fails_protocol_level():
    with pytest.raises(ValidationError):
        gw.retrieve_result_from_payload({'query': ' ', 'embedding': 'm',
                                         'bases': ['b']})


# ----------------------------------------------------------------------
# GraphRetrieveDto
# ----------------------------------------------------------------------


def _dto(**overrides):
    payload = {'query': 'q', 'embedding': 'm', 'bases': ['b']}
    payload.update(overrides)
    return GraphRetrieveDto(**payload)


def test_retrieve_dto_defaults():
    dto = _dto()
    assert dto.seed_k == 5 and dto.depth == 1 and dto.limit == 1000
    assert dto.score == 0.0 and dto.labels is None
    assert dto.to_json()['query'] == 'q'


@pytest.mark.parametrize('field, value', [
    ('query', ''), ('query', '   '), ('embedding', ''), ('embedding', '  '),
    ('bases', []), ('seed_k', 0), ('seed_k', 51), ('depth', 0), ('depth', 11),
    ('limit', 0), ('limit', 5001), ('score', -0.1), ('score', 1.5),
])
def test_retrieve_dto_rejects_invalid(field, value):
    with pytest.raises(ValidationError):
        _dto(**{field: value})


def test_retrieve_dto_query_and_embedding_are_stripped():
    dto = _dto(query='  hello  ', embedding='  m2 ')
    assert dto.query == 'hello' and dto.embedding == 'm2'


def test_retrieve_dto_labels_rules():
    assert _dto(labels=[]).labels is None                       # 空列表 → None
    assert _dto(labels=['a', 'a', ' b ']).labels == ['a', 'b']  # 去重 + strip
    with pytest.raises(ValidationError):
        _dto(labels='not-a-list')
    with pytest.raises(ValidationError):
        _dto(labels=['a'] * 11)
    with pytest.raises(ValidationError):
        _dto(labels=['a', 1])
    with pytest.raises(ValidationError):
        _dto(labels=['a', ' '])


# ----------------------------------------------------------------------
# GraphQueryDto / GraphFilter
# ----------------------------------------------------------------------


def test_query_dto_defaults_and_valid_values():
    dto = GraphQueryDto(kb_id='graph_kb1', query_type='entity')
    assert dto.depth == 10 and dto.direction == 'both' and dto.limit == 100
    assert dto.offset == 0 and dto.cursor is None
    assert dto.prioritize_levels is False and dto.filters == []
    assert dto.to_json()['kb_id'] == 'graph_kb1'


@pytest.mark.parametrize('payload', [
    {'kb_id': 'g', 'query_type': 'bogus'},
    {'kb_id': 'g', 'query_type': 'entity', 'direction': 'sideways'},
    {'kb_id': 'g', 'query_type': 'entity', 'depth': 0},
    {'kb_id': 'g', 'query_type': 'entity', 'depth': 101},
    {'kb_id': 'g', 'query_type': 'entity', 'limit': 0},
    {'kb_id': 'g', 'query_type': 'entity', 'limit': 5001},
    {'kb_id': 'g', 'query_type': 'entity', 'offset': -1},
    {'kb_id': 'g', 'query_type': 'entity', 'filters': 'not-a-list'},
    {'query_type': 'entity'},                      # kb_id 必填
])
def test_query_dto_rejects_invalid(payload):
    with pytest.raises(ValidationError):
        GraphQueryDto(**payload)


@pytest.mark.parametrize('field', [
    'entity_type', 'edge_type', 'start_entity_type', 'path_entity_type',
    'path_edge_type'])
def test_filter_rejects_empty_type_lists(field):
    with pytest.raises(ValidationError):
        GraphFilter(**{field: []})
    # 非空列表与 None 都合法
    assert getattr(GraphFilter(**{field: ['A']}), field) == ['A']
    assert getattr(GraphFilter(), field) is None


# ----------------------------------------------------------------------
# kg_struct
# ----------------------------------------------------------------------


def test_graph_struct_roundtrip():
    struct = GraphStruct(graph_name='g', entities=[
        {'entity_type': 'Person', 'properties': [{'name': 'id', 'type': 'STRING'}]}],
        edges=[{'edge_type': 'Knows', 'properties': []}])
    assert struct.entities[0].entity_type == 'Person'
    assert struct.edges[0].properties == []
    assert GraphStruct.from_json(struct.model_dump_json()).graph_name == 'g'
    assert GraphStruct.from_dict({'graph_name': 'h'}).graph_name == 'h'
    assert GraphStruct.from_dict({'graph_name': 'h'}).graph_desc == ''


def test_entity_and_edge_data_from_json():
    entity = EntityData.from_json(
        '{"entity_id": "P1", "entity_type": "Person", "properties": {"n": 1}}')
    assert entity.entity_id == 'P1' and entity.properties == {'n': 1}
    assert EntityData.from_json('{"entity_id": "P"}').properties == {}

    edge = EdgeData.from_json(json.dumps({'edge_id': 'K1', 'edge_type': 'Knows',
                                          'source_id': 'P1', 'target_id': 'P2',
                                          'properties': {'w': 1}}))
    assert (edge.edge_id, edge.source_id, edge.target_id) == ('K1', 'P1', 'P2')
    assert EdgeData.from_json('{"edge_id": "K"}').properties == {}

    with pytest.raises(ValueError):
        EntityData.from_json('{invalid')
    with pytest.raises(ValueError):
        EdgeData.from_json('{invalid')
