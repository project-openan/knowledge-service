"""knowledge_base 域剩余缺口：kbase_service 公共面 / http_support /
embedding_dimension / api.py 路由 / file_retry 边界 / graph_bridge 契约。

跑法（服务目录下）::

    python -m pytest tests/test_kb_service_gaps.py -q
"""

from __future__ import annotations

import contextlib
import json

import pytest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from shared.errors.api import KbApiError
from shared.prefixes import RKB_PREFIX
from http_api import register_rkb_api
from knowledge_base import api as kb_api
from knowledge_base import graph_bridge
from knowledge_base.repository import kbase as kbase_store
from knowledge_base import http_support
from knowledge_base.service import (embedding_dimension, file_retry_service,
                                    file_service, kbase_service)


# ----------------------------------------------------------------------
# kbase_service：对其它域开放的薄委托
# ----------------------------------------------------------------------


def test_public_delegators_forward_to_store(monkeypatch):
    captured = {}

    def record(name, result=None):
        def fn(*args, **kwargs):
            captured[name] = args if args else kwargs
            return result
        return fn

    monkeypatch.setattr(kbase_store, 'update_process', record('update_process'))
    monkeypatch.setattr(kbase_store, 'update_process_with_time',
                        record('update_process_with_time'))
    monkeypatch.setattr(kbase_store, 'update_fail_reason', record('update_fail_reason'))
    monkeypatch.setattr(kbase_store, 'update_operator_id', record('update_operator_id'))
    monkeypatch.setattr(kbase_store, 'update_schema', record('update_schema'))
    monkeypatch.setattr(kbase_store, 'set_kbase_status_modified',
                        record('set_kbase_status_modified'))
    monkeypatch.setattr(kbase_store, 'generate_kbase_id',
                        record('generate_kbase_id', 'abc'))
    monkeypatch.setattr(kbase_store, 'count_files', record('count_files', 3))
    monkeypatch.setattr(kbase_store, 'find_kbases_by_name',
                        record('find_kbases_by_name', []))
    monkeypatch.setattr(kbase_store, 'insert_kbase', record('insert_kbase', 9))
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id',
                        record('select_kbase_by_id', {'kbase_id': 'kb'}))
    monkeypatch.setattr(kbase_store, 'select_all_kbases',
                        record('select_all_kbases', []))

    assert kbase_service.get_kbase_row('kb') == {'kbase_id': 'kb'}
    assert kbase_service.list_all_kbases('org') == []
    kbase_service.update_process('kb', '5', 40)
    kbase_service.update_process_with_time('kb', '5', 40, 'admin')
    kbase_service.update_fail_reason('kb', 'zh', 'en')
    kbase_service.update_operator_id('7', 'kb')
    kbase_service.update_schema('kb', 's1', {'a': 1})
    kbase_service.set_kbase_status_modified('kb')
    assert kbase_service.generate_kbase_id() == 'abc'
    assert kbase_service.count_files('kb') == 3
    kbase_service.find_kbases_by_name('name', 'org', exclude_id='kb2')
    assert kbase_service.insert_kbase(
        kbase_id='kb', name='n', description='d', kbase_type='document',
        embedding_model='m', table_name='t', es_index_name='e', category=1,
        status=0, file_count_limit=5000, org_id='org', created_by='a') == 9

    assert captured['update_process'] == ('kb', '5', 40)
    assert captured['update_process_with_time'] == ('kb', '5', 40, 'admin')
    assert captured['update_fail_reason'] == ('kb', 'zh', 'en')
    assert captured['update_operator_id'] == ('7', 'kb')
    assert captured['update_schema'] == ('kb', 's1', {'a': 1})
    assert captured['set_kbase_status_modified'] == ('kb',)
    assert captured['find_kbases_by_name'] == ('name', 'org')
    assert captured['insert_kbase']['head_icon'] is None        # v1 不传图标


# ----------------------------------------------------------------------
# kbase_service：三个列表/详情 VO
# ----------------------------------------------------------------------


def _row(**overrides):
    row = {'id': 9, 'kbase_id': 'kb1', 'name': 'demo-kb', 'type': 'document',
           'es_index_name': 'doc_kb1', 'head_icon': 'i.png',
           'embedding_model': 'bge', 'table_name': 'doc_kb1_vector',
           'description': 'd', 'category': 1, 'fail_reason_obj': None,
           'process_obj': None, 'process': 100, 'schema_obj': {'entities': []},
           'created_at': None, 'updated_at': None, 'created_by': 'admin',
           'updated_by': None, 'file_count_limit': 5000}
    row.update(overrides)
    return row


def test_list_authority_kbases_sets_six_fields_and_sorts(monkeypatch):
    monkeypatch.setattr(kbase_store, 'select_all_kbases',
                        lambda org_id=None: [_row(name='zzz'), _row(name='AAA'),
                                             _row(kbase_id='kb2', name='bbb')])

    vos = kbase_service.list_authority_kbases('org')

    assert [vo['name'] for vo in vos] == ['AAA', 'bbb', 'zzz']  # 主强度排序
    by_name = {vo['name']: vo for vo in vos}
    assert by_name['bbb']['id'] == 'kb2'
    for vo in vos:
        assert vo['action'] == 'm'
        assert vo['pkId'] == 9
        assert vo['tableName'] is None                          # 编排层的坑：恒为 null
        assert vo['embeddingModel'] is None
        assert vo['currentFileCount'] is None
        assert vo['description'] is None


def test_list_kbases_by_ids_sets_model_and_table(monkeypatch):
    monkeypatch.setattr(kbase_store, 'select_by_ids',
                        lambda ids: [_row()])

    assert kbase_service.list_kbases_by_ids([]) == []

    vos = kbase_service.list_kbases_by_ids(['kb1'])

    assert vos[0]['embeddingModel'] == 'bge'                    # 与 /kbase 不同的一份 VO
    assert vos[0]['tableName'] == 'doc_kb1_vector'
    assert vos[0]['action'] == 'm'


def test_get_kbase_detail_document_category(monkeypatch):
    row = _row(fail_reason_obj={'zh_CN': '失败原因'}, process_obj={'zh_CN': '进度'},
               created_at=None, updated_at=None)
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: row)
    monkeypatch.setattr(kbase_store, 'count_files', lambda _: 4)

    from knowledge_base.repository import chunk as chunk_store
    monkeypatch.setattr(chunk_store, 'count_all', lambda kbase: 7)

    vo = kbase_service.get_kbase_detail('kb1')

    assert vo['failReason'] == '失败原因'
    assert vo['processDetailInfo'] == '进度'
    assert vo['currentFileCount'] == 4
    assert vo['chunkCount'] == 7                               # 文档库才有
    assert vo['props'] == {'embeddingModel': 'bge',
                           'splitMethod': 'comprehensiveSplitter', 'regex': '\\n\\n'}
    assert vo['schemaName'] is None                            # 详情保持 null


def test_get_kbase_detail_graph_category_has_no_chunk_count(monkeypatch):
    row = _row(category=10)
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: row)
    monkeypatch.setattr(kbase_store, 'count_files', lambda _: 0)

    vo = kbase_service.get_kbase_detail('kb1')

    assert 'chunkCount' not in vo


def test_chunk_count_failure_is_not_fatal(monkeypatch):
    row = _row()
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: row)
    monkeypatch.setattr(kbase_store, 'count_files', lambda _: 0)

    from knowledge_base.repository import chunk as chunk_store

    def boom(kbase):
        raise RuntimeError('vector table missing')

    monkeypatch.setattr(chunk_store, 'count_all', boom)

    assert kbase_service.get_kbase_detail('kb1')['chunkCount'] == 0


def test_is_kbase_empty(monkeypatch):
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: None)
    with pytest.raises(KbApiError) as caught:
        kbase_service.is_kbase_empty('ghost')
    assert caught.value.key == 'kbase.not.exist'

    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: _row())
    monkeypatch.setattr(kbase_store, 'count_files', lambda _: 0)
    assert kbase_service.is_kbase_empty('kb1') is True

    monkeypatch.setattr(kbase_store, 'count_files', lambda _: 2)
    with pytest.raises(KbApiError) as caught:
        kbase_service.is_kbase_empty('kb1')
    assert caught.value.key == 'kbase.can.not.delete.include.knowledge'


def test_search_kbases_zero_total_short_circuits(monkeypatch):
    monkeypatch.setattr(kbase_store, 'count_search_kbases', lambda *args: 0)

    def _boom(*args, **kwargs):
        raise AssertionError('总数为 0 时不应查询行')

    monkeypatch.setattr(kbase_store, 'search_kbases', _boom)

    body = kbase_service.search_kbases({'currentPage': 2, 'pageSize': 20})

    assert body == {'items': [], 'total': 0, 'page': 2, 'pageSize': 20}


def test_search_kbases_page_overrides(monkeypatch):
    monkeypatch.setattr(kbase_store, 'count_search_kbases', lambda *args: 1)
    monkeypatch.setattr(kbase_store, 'search_kbases', lambda *args, **kwargs: [_row()])
    monkeypatch.setattr(kbase_store, 'count_files_by_kbase_ids',
                        lambda ids: {'kb1': 3})

    body = kbase_service.search_kbases({'currentPage': 1, 'pageSize': 10,
                                        'keyword': 'kw', 'categories': [1],
                                        'embeddingModel': 'bge',
                                        'orderList': [{'key': 'name',
                                                       'ascending': True}]})

    vo = body['items'][0]
    assert vo['schemaName'] == '' and vo['schemaObj'] is None   # 分页不加载 schema_obj
    assert vo['failReason'] == ''                               # map 为 null → 空串
    assert vo['fullName'] == '' and vo['fullNameEn'] == ''
    assert vo['action'] == 'm'
    assert vo['currentFileCount'] == 3


def test_localized_string_value_null_semantics(monkeypatch):
    monkeypatch.setattr(kbase_store, 'count_search_kbases', lambda *args: 1)
    row = _row(fail_reason_obj={'other': 1})                    # map 非空但缺 zh_CN
    monkeypatch.setattr(kbase_store, 'search_kbases', lambda *a, **k: [row])
    monkeypatch.setattr(kbase_store, 'count_files_by_kbase_ids', lambda ids: {})

    vo = kbase_service.search_kbases({'currentPage': 1, 'pageSize': 10})['items'][0]

    assert vo['failReason'] == 'null'                           # 字符串 "null"


def test_validate_search_range_errors():
    from shared.errors.api import KbValidatorError

    with pytest.raises(KbValidatorError):
        kbase_service._check_range(None, 1, 10, 'zh-CN')
    with pytest.raises(KbValidatorError) as min_err:
        kbase_service._check_range(0, 1, 10, 'zh-CN')
    with pytest.raises(KbValidatorError) as max_err:
        kbase_service._check_range(501, 1, 500, 'zh-CN')
    assert min_err.value.render('zh') != max_err.value.render('zh')


def test_environment_helpers(monkeypatch):
    assert kbase_service.is_ais_environment('ais') is True
    assert kbase_service.is_ais_environment(' v7 ') is True
    assert kbase_service.is_ais_environment('other') is False
    assert kbase_service.is_ais_environment(None) is False

    monkeypatch.setenv('DEPLOYED_BY', 'manual')
    assert kbase_service.deployed_by() == 'manual'
    monkeypatch.delenv('DEPLOYED_BY', raising=False)
    assert kbase_service.deployed_by() is None


def test_embedding_model_names_from_registry(monkeypatch):
    from model import resolver

    monkeypatch.setattr(resolver, 'embedding_models', lambda: ['bge-base', None])
    assert kbase_service.list_embedding_model_names() == ['bge-base', None]
    assert kbase_service.list_embedding_models() == ['bge-base', None]

    monkeypatch.setattr(resolver, 'embedding_models', lambda: None)
    assert kbase_service.list_embedding_model_names() == []     # 注册表不可用 → 空清单


# ----------------------------------------------------------------------
# embedding_dimension
# ----------------------------------------------------------------------


def test_resolve_embedding_dimension_from_registry(monkeypatch):
    from model import resolver

    resolved = type('R', (), {'dimension': 1536})()
    monkeypatch.setattr(resolver, 'resolve', lambda kind, name: resolved)

    assert embedding_dimension.resolve_embedding_dimension('bge') == 1536


def test_resolve_embedding_dimension_falls_back_to_env(monkeypatch):
    from model import resolver

    def boom(kind, name):
        raise RuntimeError('registry down')

    monkeypatch.setattr(resolver, 'resolve', boom)
    monkeypatch.setenv('EMBEDDING_DIMENSION', '768')

    assert embedding_dimension.resolve_embedding_dimension('bge') == 768


def test_resolve_embedding_dimension_invalid_inputs(monkeypatch):
    monkeypatch.setenv('EMBEDDING_DIMENSION', 'not-a-number')
    assert embedding_dimension.resolve_embedding_dimension(None) == 1024

    monkeypatch.setenv('EMBEDDING_DIMENSION', '-5')
    assert embedding_dimension.resolve_embedding_dimension('') == 1024

    monkeypatch.setenv('EMBEDDING_DIMENSION', '256')
    assert embedding_dimension.resolve_embedding_dimension(None) == 256

    monkeypatch.delenv('EMBEDDING_DIMENSION', raising=False)
    assert embedding_dimension.resolve_embedding_dimension(None, default=512) == 512
    assert embedding_dimension.resolve_embedding_dimension(None, default='bad') == 1024


def test_ensure_known_embedding_model(monkeypatch):
    from model import resolver

    # 空 / 非字符串 / 纯空白：跟随部署默认，不校验
    for value in (None, '', '   ', 123):
        embedding_dimension.ensure_known_embedding_model(value)

    monkeypatch.setattr(resolver, 'is_writable_embedding_model', lambda name: True)
    embedding_dimension.ensure_known_embedding_model('bge')    # 不抛

    monkeypatch.setattr(resolver, 'is_writable_embedding_model', lambda name: False)
    with pytest.raises(KbApiError) as caught:
        embedding_dimension.ensure_known_embedding_model('bge')
    assert caught.value.key == 'kbase.embedding.model.invalid'
    assert caught.value.code == '0004'

    with pytest.raises(KbApiError) as caught:
        embedding_dimension.ensure_known_embedding_model(
            'bge', error_key='graph.extract.embedding.model.invalid')
    assert caught.value.key == 'graph.extract.embedding.model.invalid'

    def boom(name):
        raise RuntimeError('registry down')

    monkeypatch.setattr(resolver, 'is_writable_embedding_model', boom)
    embedding_dimension.ensure_known_embedding_model('bge')    # 无法判定 → 放行


# ----------------------------------------------------------------------
# http_support
# ----------------------------------------------------------------------


def test_search_dto_parses_query_params():
    class _Query(dict):
        def getlist(self, name):
            return ['name:asc', 'bogus:desc']

    query = _Query({'page': '3', 'size': '20', 'keyword': 'kw',
                    'categories': '1,10', 'embeddingModel': 'bge'})

    dto = http_support.search_dto(query)

    assert dto == {'currentPage': 3, 'pageSize': 20, 'keyword': 'kw',
                   'categories': [1, 10], 'embeddingModel': 'bge',
                   # 查询层的 orderList 不做枚举校验，原样带两条（校验在服务层）
                   'orderList': [{'key': 'name', 'ascending': True},
                                 {'key': 'bogus', 'ascending': False}]}


def _starlette_upload(name, content):
    import asyncio
    import tempfile

    from starlette.datastructures import UploadFile as StarletteUploadFile

    item = StarletteUploadFile(tempfile.SpooledTemporaryFile(), filename=name)

    async def _prepare():
        await item.write(content)
        await item.seek(0)

    asyncio.run(_prepare())
    return item


def test_read_upload_variants():
    import asyncio

    from shared.errors.api import KbMalformedRequestError

    files = [_starlette_upload('a.md', b'AAA')]

    uploaded, metadata = asyncio.run(http_support.read_upload(files, None))
    assert [(item.filename, item.content) for item in uploaded] == [('a.md', b'AAA')]
    assert metadata == {}

    uploaded, metadata = asyncio.run(http_support.read_upload(files, '   '))
    assert metadata == {}

    uploaded, metadata = asyncio.run(
        http_support.read_upload(files, '{"kType": "document"}'))
    assert metadata == {'kType': 'document'}

    with pytest.raises(KbMalformedRequestError):
        asyncio.run(http_support.read_upload(files, 'not json'))
    with pytest.raises(KbMalformedRequestError):
        asyncio.run(http_support.read_upload(files, '[1,2]'))  # 非 dict


def test_form_text_and_form_files():
    import asyncio
    import tempfile

    from starlette.datastructures import UploadFile as StarletteUploadFile

    upload = _starlette_upload('a.md', b'AAA')

    class _Form(dict):
        def getlist(self, name):
            return [upload, 'not-an-upload']                   # 非上传对象要被滤掉

    form = _Form({'title': '标题', 'files': [upload]})
    assert asyncio.run(http_support.form_text(form, 'title')) == '标题'
    assert asyncio.run(http_support.form_text(form, 'missing')) is None
    files = asyncio.run(http_support.form_files(form, 'files'))
    assert [(item.filename, item.content) for item in files] == [('a.md', b'AAA')]


# ----------------------------------------------------------------------
# api.py 路由
# ----------------------------------------------------------------------


def _client():
    app = FastAPI()
    register_rkb_api(app)
    return TestClient(app)


def test_add_chunk_requires_document_id():
    with pytest.raises(KbApiError) as caught:
        kb_api.add_chunk('kb1', {})
    assert caught.value.key == 'RetCode.illegalArgument'


def test_lookup_directory_detail_missing_row_returns_empty_vo(monkeypatch):
    from knowledge_base.repository import directory as directory_store

    monkeypatch.setattr(kbase_store, 'select_kbase_by_id',
                        lambda _: {'kbase_id': 'kb1'})
    monkeypatch.setattr(directory_store, 'get_directory', lambda *a, **k: None)

    vo = kb_api.lookup_directory_detail('kb1', 'ghost', lambda key: key)

    assert vo['id'] is None and vo['title'] is None            # _base_vo({})


def test_lookup_directory_detail_assembles_row(monkeypatch):
    from knowledge_base.repository import directory as directory_store

    row = {'id': 'f1', 'kbase_id': 'kb1', 'title': 'a.md', 'type': 'file',
           'parent_id': None, 'parent_path': '0', 'can_spread': False,
           'status': 1, 'created_at': None, 'updated_at': None,
           'created_by': None, 'updated_by': None, 'file_from': None,
           'fail_reason': None}
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: {'kbase_id': 'kb1'})
    monkeypatch.setattr(directory_store, 'get_directory', lambda *a, **k: row)

    vo = kb_api.lookup_directory_detail('kb1', 'f1', lambda key: key)

    assert vo['id'] == 'f1' and vo['canSpread'] == 'N'


def test_kbase_graph_detail_route(monkeypatch):
    from knowledge_base.service import kbase_v2_service

    monkeypatch.setattr(kbase_v2_service, 'get_kbase_detail',
                        lambda kbase_id: {'schemaInfo': None, 'data': {}, 'fileInfo': []})

    response = _client().get(f'{RKB_PREFIX}/knowledge-bases/kb1/graph')

    assert response.status_code == 200
    assert 'schemaInfo' in response.json()


def test_download_document_routes_kb_error(monkeypatch):
    def boom(kbase_id, file_id):
        raise KbApiError('file.not.exist')

    monkeypatch.setattr(kb_api.file_service, 'doc_download_file', boom)

    response = _client().get(f'{RKB_PREFIX}/knowledge-bases/kb1/documents/f1/content')

    assert response.status_code == 404                         # problem+json
    assert response.headers['content-type'].startswith('application/problem+json')


def test_download_document_routes_unexpected_error(monkeypatch):
    def boom(kbase_id, file_id):
        raise RuntimeError('io error')

    monkeypatch.setattr(kb_api.file_service, 'doc_download_file', boom)

    response = _client().get(f'{RKB_PREFIX}/knowledge-bases/kb1/documents/f1/content')

    assert response.status_code == 500


def test_download_document_streams_bytes(monkeypatch):
    monkeypatch.setattr(kb_api.file_service, 'doc_download_file',
                        lambda kbase_id, file_id: b'CONTENT')

    response = _client().get(f'{RKB_PREFIX}/knowledge-bases/kb1/documents/f1/content')

    assert response.status_code == 200
    assert response.content == b'CONTENT'
    assert response.headers['content-length'] == '7'


def test_chunk_list_and_add_routes(monkeypatch):
    from knowledge_base.service import chunk_service

    monkeypatch.setattr(chunk_service, 'get_chunk_list',
                        lambda kbase_id, file_id, keyword, page, size:
                        {'items': [], 'total': 0, 'page': page, 'pageSize': size})
    monkeypatch.setattr(chunk_service, 'add_chunk',
                        lambda kbase_id, file_id, payload: {'chunkId': 'c1'})

    client = _client()
    body = client.get(f'{RKB_PREFIX}/knowledge-bases/kb1/chunks?page=2&size=5').json()
    assert body == {'items': [], 'total': 0, 'page': 2, 'pageSize': 5}

    response = client.post(f'{RKB_PREFIX}/knowledge-bases/kb1/chunks',
                           json={'documentId': 'f1', 'content': '正文'})
    assert response.status_code == 201
    assert response.json() == {'chunkId': 'c1'}

    # 缺 documentId → 校验错误
    response = client.post(f'{RKB_PREFIX}/knowledge-bases/kb1/chunks',
                           json={'content': '正文'})
    assert response.status_code == 422


def test_document_chunks_route_order_flag(monkeypatch):
    from knowledge_base.service import chunk_service

    captured = {}

    def fake(kbase_id, file_id, keyword, page, size, chunk_id_asc):
        captured['asc'] = chunk_id_asc
        return {'items': [], 'total': 0, 'page': page, 'pageSize': size}

    monkeypatch.setattr(chunk_service, 'search_chunk_from_file', fake)
    client = _client()

    client.get(f'{RKB_PREFIX}/knowledge-bases/kb1/documents/f1/chunks?order=asc')
    assert captured['asc'] is True

    client.get(f'{RKB_PREFIX}/knowledge-bases/kb1/documents/f1/chunks?chunkIdAsc=true')
    assert captured['asc'] is True

    client.get(f'{RKB_PREFIX}/knowledge-bases/kb1/documents/f1/chunks')
    assert captured['asc'] is False


def test_create_kbase_route_selects_v2_for_graph(monkeypatch):
    from knowledge_base.service import kbase_v2_service, kbase_write_service

    routed = []

    def fake_v2(payload, emp_no, org_id, language=''):
        routed.append('v2')
        return {'id': 'g1'}

    def fake_v1(payload, emp_no, org_id, language=''):
        routed.append('v1')
        return {'id': 'd1'}

    monkeypatch.setattr(kbase_v2_service, 'create_kbase', fake_v2)
    monkeypatch.setattr(kbase_write_service, 'create_kbase', fake_v1)

    client = _client()
    assert client.post(f'{RKB_PREFIX}/knowledge-bases?type=graph',
                       json={'name': 'x'}).status_code in (200, 201)
    assert routed[-1] == 'v2'

    assert client.post(f'{RKB_PREFIX}/knowledge-bases',
                       json={'name': 'x'}).status_code in (200, 201)
    assert routed[-1] == 'v1'

    # 空请求体 → body_required
    assert client.post(f'{RKB_PREFIX}/knowledge-bases').status_code == 400


# ----------------------------------------------------------------------
# file_retry_service 边界
# ----------------------------------------------------------------------


ROW = {'id': 'file-1', 'kbase_id': 'kb-1', 'title': 'guide.pdf', 'type': 'file',
       'status': 2, 'fail_reason': 'RetCode.operator.split.error'}


def _patch_retry(monkeypatch, row=ROW, claim=True, config=None, size='1024'):
    import knowledge_base.repository.directory as directory_store
    import operators.service.operator_service as operator_service

    monkeypatch.setattr(file_retry_service.directory_store, 'get_directory',
                        lambda *a, **k: row)
    monkeypatch.setattr(file_retry_service.storage, 'core_file_exists', lambda _: True)
    monkeypatch.setattr(file_retry_service.storage, 'core_key',
                        lambda file_id: f'core/{file_id[:4]}/{file_id}')
    monkeypatch.setattr(file_retry_service.directory_store, 'get_properties',
                        lambda ids, name: {ids[0]: size})
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id',
                        lambda _: {'embedding_model': 'bge'})
    monkeypatch.setattr(file_retry_service.directory_store, 'get_all_properties',
                        lambda ids: {ids[0]: {'task_config': json.dumps(config)}
                                     if config is not None else {}})

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def execute(self, *args):
            pass

        def fetchone(self):
            return ('file-1',) if claim else None

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(file_retry_service.directory_store, 'connection', _Conn)

    class _Q:
        def __init__(self):
            self.handles = []

        def submit_task(self, handle):
            self.handles.append(handle)
            return 'task-1'

    queue = _Q()
    monkeypatch.setattr(file_retry_service.runtime, 'get_queue', lambda: queue)
    monkeypatch.setattr(operator_service, 'support',
                        lambda payload, emp_no, org_id: {'pdf': [{'id': -1, 'args': []}]})
    return queue


def test_retry_status_parsing_survives_garbage(monkeypatch):
    assert file_retry_service._status_of({'status': None}) == 0
    assert file_retry_service._status_of({'status': 'not-a-number'}) == 0
    assert file_retry_service._status_of({'status': '2'}) == 2


def test_retry_file_size_survives_garbage(monkeypatch):
    import knowledge_base.repository.directory as directory_store

    monkeypatch.setattr(directory_store, 'get_properties',
                        lambda ids, name: {ids[0]: 'not-a-number'})

    assert file_retry_service._file_size('f1') == 0
    assert file_retry_service._file_size('f1') == 0


def test_stored_config_invalid_json_falls_back(monkeypatch):
    import knowledge_base.repository.directory as directory_store

    monkeypatch.setattr(directory_store, 'get_all_properties',
                        lambda ids: {ids[0]: {'task_config': '{broken'}})

    assert file_retry_service._stored_config('f1') == {}


def test_stored_config_non_dict_falls_back(monkeypatch):
    import knowledge_base.repository.directory as directory_store

    monkeypatch.setattr(directory_store, 'get_all_properties',
                        lambda ids: {ids[0]: {'task_config': '[1,2]'}})

    assert file_retry_service._stored_config('f1') == {}


def test_retry_missing_kbase_row_keeps_model_none(monkeypatch):
    queue = _patch_retry(monkeypatch)
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: None)

    file_retry_service.retry_file('kb-1', 'file-1', 'admin')

    assert queue.handles[0]['modelName'] is None


def test_restore_failed_survives_store_errors(monkeypatch):
    import knowledge_base.repository.directory as directory_store

    def boom(*args, **kwargs):
        raise RuntimeError('db down')

    monkeypatch.setattr(directory_store, 'connection', boom)
    monkeypatch.setattr(directory_store, 'update_file_status', boom)

    file_retry_service._restore_failed('f1', None)             # 只记日志，不抛


def test_default_split_operator_requires_format(monkeypatch):
    assert file_retry_service._default_split_operator('', 'admin', None) is None


def test_retry_claim_uses_directory_store(monkeypatch):
    queue = _patch_retry(monkeypatch)

    result = file_retry_service.retry_file('kb-1', 'file-1', 'admin', org_id='org')

    assert result == {'fileId': 'file-1', 'taskId': 'task-1'}
    handle = queue.handles[0]
    assert handle['operatorSplitDTO']['operatorId'] == -1
    assert handle['diskPath'] == 'core/file/file-1'


# ----------------------------------------------------------------------
# file_service 尾部小分支
# ----------------------------------------------------------------------


def test_memory_limited_values(monkeypatch):
    monkeypatch.setattr(file_service, '_memory_limit_value', lambda: 512.0)

    limited = file_service._memory_limited(dict(file_service.FILE_MAX_SIZE_MAP))

    assert limited['txt'] == 2.5                               # <=10 减半
    assert limited['md'] == 5.0                                # >10 压到 5


def test_memory_limit_value_ignores_illegal_env(monkeypatch):
    monkeypatch.setenv('MEM_LIMIT', 'abc')
    monkeypatch.setattr(file_service, '_cgroup_memory_mb', lambda: None)

    assert file_service._memory_limit_value() == file_service.UNLIMITED_MEMORY_MB


def test_memory_limit_value_strips_units(monkeypatch):
    monkeypatch.setenv('MEM_LIMIT', '1024MB')

    assert file_service._memory_limit_value() == 1024.0


def test_purge_old_file_order(monkeypatch):
    captured = []

    import knowledge_base.repository.kbase as repo_kbase
    import knowledge_base.repository.node_relation as node_relation

    monkeypatch.setattr(repo_kbase, 'select_kbase_by_id',
                        lambda _: {'id': 5, 'table_name': 'doc_kb1_vector'})
    monkeypatch.setattr(node_relation, 'delete_by_directory_ids',
                        lambda pk_id, ids: captured.append(('relation', pk_id, ids)))

    class _Bridge:
        @staticmethod
        def delete_chunks_by_sources(table, names):
            captured.append(('chunks', table, names))

    monkeypatch.setattr(file_service, 'graph_lifecycle', _Bridge)

    import retrieval.service.index as index_service
    monkeypatch.setattr(index_service, 'delete_documents_by_file_id',
                        lambda kbase_id, file_id:
                        captured.append(('es', kbase_id, file_id)))

    file_service._purge_old_file('kb1', 'f1', 'a.md')

    assert captured == [('relation', 5, ['f1']),
                        ('chunks', 'doc_kb1_vector', ['a.md']),
                        ('es', 'kb1', 'f1')]


def test_purge_old_file_without_table_name(monkeypatch):
    captured = []

    import knowledge_base.repository.kbase as repo_kbase
    import knowledge_base.repository.node_relation as node_relation

    monkeypatch.setattr(repo_kbase, 'select_kbase_by_id', lambda _: {'id': 5})

    def _boom(*args, **kwargs):
        raise AssertionError('无 table_name 时不应清图谱')

    monkeypatch.setattr(node_relation, 'delete_by_directory_ids',
                        lambda pk_id, ids: captured.append('relation'))

    class _Bridge:
        delete_chunks_by_sources = staticmethod(_boom)

    monkeypatch.setattr(file_service, 'graph_lifecycle', _Bridge)

    import retrieval.service.index as index_service
    monkeypatch.setattr(index_service, 'delete_documents_by_file_id',
                        lambda kbase_id, file_id: captured.append('es'))

    file_service._purge_old_file('kb1', 'f1', 'a.md')

    assert captured == ['relation', 'es']


def test_delete_es_documents_delegates(monkeypatch):
    import retrieval.service.index as index_service

    captured = {}
    monkeypatch.setattr(index_service, 'delete_documents_by_file_id',
                        lambda kbase_id, file_id:
                        captured.update(args=(kbase_id, file_id)))

    file_service._delete_es_documents('kb1', 'f1')

    assert captured['args'] == ('kb1', 'f1')


def test_node_relation_store_helper_returns_module():
    import knowledge_base.repository.node_relation as node_relation

    assert file_service._node_relation_store() is node_relation


# ----------------------------------------------------------------------
# graph_bridge 契约
# ----------------------------------------------------------------------


def test_graph_bridge_requires_install(monkeypatch):
    monkeypatch.setattr(graph_bridge, '_implementation', None)

    # 注意：其它用例对 graph_bridge 的 monkeypatch 会在模块上留下"直连属性"，
    # 让 __getattr__ 失效；这里显式走 __getattr__，钉住委托契约本身。
    with pytest.raises(RuntimeError, match='not installed'):
        graph_bridge.__getattr__('anything')


def test_graph_bridge_delegates_to_installed_module(monkeypatch):
    class _Impl:
        @staticmethod
        def delete_graph_database(kbase_id):
            return f'deleted-{kbase_id}'

    monkeypatch.setattr(graph_bridge, '_implementation', _Impl)

    assert graph_bridge.__getattr__('delete_graph_database')('kb1') == 'deleted-kb1'

    with pytest.raises(AttributeError):
        graph_bridge.__getattr__('missing_attribute')         # 透传 AttributeError
