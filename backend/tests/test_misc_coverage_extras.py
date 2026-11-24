"""收尾缺口：model service 探针分支、parsing md 表格与 PDF 零散分支、retrieval 向量 SQL。

只覆盖前面 test_misc_* 没碰到的行；桩风格与既有测试一致。
"""

import json

import pytest

from infrastructure.config import settings as infra_settings
from model.service import ModelService, _http_error_detail, _probe_exception_message, \
    _optional_int, _optional_float
from model.models import MODEL_KIND_LLM, MODEL_KIND_EMBEDDING, MODEL_KIND_RERANK, \
    ModelRecord, new_model_id
from model.repository import InMemoryModelStore
from model import service as model_service_module

from parsing.parsers.md_tool.md_table_tool import MdTableTool
from parsing.parsers.pdf_tool.read_pdf import PdfContentParser, process_origin_title

from retrieval.repository import vector_store


@pytest.fixture(autouse=True)
def _work_dir(monkeypatch, tmp_path):
    monkeypatch.setitem(infra_settings.Config, 'work_dir', str(tmp_path))
    return tmp_path


# ---------------------------------------------------------------------------
# model service：探针与校验分支
# ---------------------------------------------------------------------------

class _JsonResponse:
    def __init__(self, body, status_code=200):
        self.status_code = status_code
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f'HTTP {self.status_code}')


def _record(kind=MODEL_KIND_LLM, **overrides):
    fields = dict(model_id=new_model_id(), model_kind=kind, model_name='probe-row',
                  display_name='', api_model='', base_url='http://probe:1/v1',
                  chat_path='/chat/completions', embeddings_path='/embeddings',
                  models_path='/models', rerank_path='/rerank',
                  api_key='sk-probe-key')
    fields.update(overrides)
    return ModelRecord(**fields)


def test_optional_number_parsers():
    assert _optional_int({}, 'dimension') is None
    assert _optional_int({'dimension': ''}, 'dimension') is None
    assert _optional_int({'dimension': '12'}, 'dimension') == 12
    with pytest.raises(Exception):
        _optional_int({'dimension': 'x'}, 'dimension')
    assert _optional_float({'dimension': '1.5'}, 'dimension') == 1.5
    with pytest.raises(Exception):
        _optional_float({'dimension': object()}, 'dimension')


def test_http_error_detail_shapes():
    class _Boom:
        def json(self):
            raise ValueError('not json')

    assert _http_error_detail(_Boom()) == ''
    assert _http_error_detail(_JsonResponse('plain')) == ''
    assert _http_error_detail(_JsonResponse({'error': {'message': 'a\nb'}})) == ': a b'
    assert _http_error_detail(_JsonResponse({'error': {'code': 404}})) == ': 404'
    assert _http_error_detail(_JsonResponse({'detail': 'Method Not Allowed'})) == \
        ': Method Not Allowed'
    assert _http_error_detail(_JsonResponse({})) == ''


def test_probe_exception_message_classification():
    assert 'timed out' in _probe_exception_message('p', TimeoutError('x'))
    assert 'TLS' in _probe_exception_message('p', RuntimeError('ssl error'))
    assert 'connection failed' in _probe_exception_message('p', RuntimeError('refused'))
    assert 'request failed' in _probe_exception_message('p', ValueError('x'))
    assert '(POST http://u)' in _probe_exception_message('p', ValueError('x'), 'http://u')


def _service(store=None, **kwargs):
    return ModelService(store or InMemoryModelStore(),
                        reference_checker=lambda kind, name: 0, **kwargs)


@pytest.fixture(autouse=True)
def _no_real_egress(monkeypatch):
    # 任何漏桩的探针请求也不许等 DNS：默认 egress 直接拒连
    from infrastructure.http import egress

    def _refused(*args, **kwargs):
        raise ConnectionError('connection refused (test stub)')
    monkeypatch.setattr(egress, 'post', _refused)
    monkeypatch.setattr(egress, 'get', _refused)


def test_probe_chat_paths():
    service = _service()
    record = _record()
    ok, error = service._probe_chat(record)
    assert ok is False and 'chat' in error

    service = _service(http_post=lambda url, **k: _JsonResponse(
        {'choices': [{'message': {'content': 'ok'}}]}))
    ok, error = service._probe_chat(record)
    assert ok is True

    service = _service(http_post=lambda url, **k: _JsonResponse(
        {'error': {'message': 'nope'}}, status_code=404))
    ok, error = service._probe_chat(record)
    assert ok is False and 'HTTP 404' in error

    no_status = type('R', (), {'status_code': None, 'json': lambda self: {}})()
    service = _service(http_post=lambda url, **k: no_status)
    ok, error = service._probe_chat(record)
    assert ok is False and 'no HTTP status' in error

    def _boom(url, **k):
        raise TimeoutError('timed out')
    service = _service(http_post=_boom)
    ok, error = service._probe_chat(record)
    assert ok is False and 'timed out' in error


def test_probe_rerank_path_not_configured(monkeypatch):
    from model import service as model_service
    monkeypatch.setattr(model_service, 'OP_RERANK', 'unsupported-operation')
    service = _service()
    ok, error = service._probe_rerank(_record(MODEL_KIND_RERANK))
    assert ok is False and 'path is not configured' in error


def test_probe_chat_path_not_configured(monkeypatch):
    from model import service as model_service
    monkeypatch.setattr(model_service, 'OP_CHAT', 'unsupported-operation')
    service = _service()
    ok, error = service._probe_chat(_record(MODEL_KIND_LLM))
    assert ok is False and 'path is not configured' in error


def test_probe_rerank_paths():
    record = _record(MODEL_KIND_RERANK)
    service = _service()

    service = _service(http_post=lambda url, **k: _JsonResponse(
        {'results': [{'index': 0, 'relevance_score': 0.9}]}))
    assert service._probe_rerank(record) == (True, '')

    service = _service(http_post=lambda url, **k: _JsonResponse(
        {'data': [{'index': 1, 'relevance_score': 0.5}]}))
    assert service._probe_rerank(record)[0] is True

    service = _service(http_post=lambda url, **k: _JsonResponse({'results': []}))
    ok, error = service._probe_rerank(record)
    assert ok is False and 'no usable results' in error

    service = _service(http_post=lambda url, **k: _JsonResponse(ValueError('bad')))
    ok, error = service._probe_rerank(record)
    assert ok is False and 'non-JSON' in error

    service = _service(http_post=lambda url, **k: _JsonResponse({}, status_code=500))
    ok, error = service._probe_rerank(record)
    assert ok is False and 'HTTP 500' in error


def test_probe_embedding_dimension_paths(monkeypatch):
    record = _record(MODEL_KIND_EMBEDDING)
    service = _service(http_post=lambda url, **k: _JsonResponse(
        {'data': [{'embedding': [0.1] * 8}]}))
    assert service._probe_embedding_dimension(record) == (8, '')

    service = _service(http_post=lambda url, **k: _JsonResponse({'data': []}))
    dimension, error = service._probe_embedding_dimension(record)
    assert dimension is None and 'no embedding vector' in error

    service = _service(http_post=lambda url, **k: _JsonResponse({}, status_code=404))
    dimension, error = service._probe_embedding_dimension(record)
    assert dimension is None and 'HTTP 404' in error

    def _boom(url, **k):
        raise ConnectionError('connection refused')
    service = _service(http_post=_boom)
    dimension, error = service._probe_embedding_dimension(record)
    assert dimension is None and 'connection failed' in error


def test_probe_embedding_path_not_configured(monkeypatch):
    from model import service as model_service
    monkeypatch.setattr(model_service, 'OP_EMBEDDINGS', 'unsupported-operation')
    service = _service()
    ok, error = service._probe_embedding_dimension(_record(MODEL_KIND_EMBEDDING))
    assert ok is None and 'path is not configured' in error


def test_test_connection_for_embedding_and_rerank(monkeypatch):

    store = InMemoryModelStore()
    service = _service(store, http_post=lambda url, **k: _JsonResponse(
        {'data': [{'embedding': [0.0] * 4}]}),
        http_get=lambda url, **k: _JsonResponse({'data': []}))
    record = _record(MODEL_KIND_EMBEDDING)
    store.insert(record)
    result = service.test_connection(record.to_public())
    assert result['embeddingsOk'] is True

    record_rerank = _record(MODEL_KIND_RERANK)
    store.insert(record_rerank)
    service = _service(store, http_post=lambda url, **k: _JsonResponse(
        {'results': [{'index': 0, 'relevance_score': 0.9}]}))
    result = service.test_connection(record_rerank.to_public())
    assert result['rerankOk'] is True
    assert result['message'].startswith('model call succeeded')


def test_test_connection_message_fallbacks():
    store = InMemoryModelStore()
    service = _service(store, http_post=lambda url, **k: _JsonResponse({}, status_code=500),
                       http_get=lambda url, **k: _JsonResponse({'data': []}))
    record = _record(MODEL_KIND_LLM)
    store.insert(record)
    result = service.test_connection(record.to_public())
    assert result['ok'] is False


def test_update_clears_key_when_base_url_changes():

    store = InMemoryModelStore()
    service = _service(store)
    record = _record()
    store.insert(record)
    payload = record.to_public()
    payload['baseUrl'] = 'http://other:2/v1'
    payload.pop('apiKey', None)
    updated = service.update_model(record.model_id, payload)
    assert updated.api_key == ''  # 换端点没重供 key：旧 key 不带走


def test_delete_reference_failure_and_in_use(monkeypatch):
    store = InMemoryModelStore()
    service = ModelService(store, reference_checker=lambda kind, name: (_ for _ in ()).throw(
        RuntimeError('cross db down')))
    record = _record(MODEL_KIND_EMBEDDING)
    store.insert(record)
    service.delete_model(record.model_id)   # 引用检查失败：放行
    assert store.get_record(record.model_id) is None

    service = ModelService(store, reference_checker=lambda kind, name: 2)
    record = _record(MODEL_KIND_EMBEDDING)
    store.insert(record)
    from model.errors import ModelApiError
    with pytest.raises(ModelApiError):
        service.delete_model(record.model_id)
    llm_record = _record(MODEL_KIND_LLM)
    store.insert(llm_record)
    service.delete_model(llm_record.model_id)  # 非 embedding 不查引用


def test_notify_changed_swallows_errors():
    def _boom():
        raise RuntimeError('cache')
    service = _service(on_change=_boom)
    service._notify_changed()  # 不抛


def test_normalize_thinking_custom_requires_existing_custom(monkeypatch):
    from model.service import _normalize_thinking
    from model import thinking_presets

    record = _record(thinking_mode=thinking_presets.MODE_NONE, thinking_preset='',
                     thinking_payload=None)
    with pytest.raises(Exception):
        _normalize_thinking(MODEL_KIND_LLM, {'thinkingMode': 'custom',
                                             'thinkingPayload': {'x': 1}}, record)
    custom_record = _record(thinking_mode=thinking_presets.MODE_CUSTOM,
                            thinking_preset='', thinking_payload={'a': 1})
    mode, preset, stored = _normalize_thinking(
        MODEL_KIND_LLM, {'thinkingMode': 'custom', 'thinkingPayload': {'thinking': {'type': 'on'}}},
        custom_record)
    assert stored == {'thinking': {'type': 'on'}}
    with pytest.raises(Exception):
        _normalize_thinking(MODEL_KIND_LLM, {'thinkingMode': 'bad'}, custom_record)
    with pytest.raises(Exception):
        _normalize_thinking(MODEL_KIND_LLM, {'thinkingMode': 'preset',
                                             'thinkingPreset': 'no-such'}, custom_record)
    # 非 LLM 一律 none
    assert _normalize_thinking(MODEL_KIND_EMBEDDING, {'thinkingMode': 'custom'}, None) == (
        thinking_presets.MODE_NONE, '', None)


def test_all_records_and_count_knowledge_bases(monkeypatch):
    store = InMemoryModelStore()
    store.insert(_record())
    service = _service(store)
    assert service.all_records(MODEL_KIND_LLM)
    assert service.all_records(None)

    import infrastructure.db.kb as kb
    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=None):
            pass

        def fetchone(self):
            return (3,)

    class _Conn:
        def cursor(self):
            return _Cursor()

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(kb, 'connection', lambda: _Conn())
    assert model_service_module.count_knowledge_bases_using(MODEL_KIND_EMBEDDING, 'm') == 3
    assert model_service_module.count_knowledge_bases_using(MODEL_KIND_LLM, 'm') == 0

    monkeypatch.setattr(kb, 'connection', lambda: (_ for _ in ()).throw(RuntimeError('x')))
    assert model_service_module.count_knowledge_bases_using(MODEL_KIND_EMBEDDING, 'm') == 0


# ---------------------------------------------------------------------------
# parsing：md_table_tool 分支 + read_pdf 零散行
# ---------------------------------------------------------------------------

def test_md_table_tool_bold_header_and_dash_rows():
    markdown = (
        '# 表一\n\n'
        '| **名称** | **数量** |\n'
        '| --- | --- |\n'
        '| 设备A | 3 |\n'
        '| 设备B | 4 |\n'
    )
    content = MdTableTool().md_table_parser(markdown, 'file.md')
    joined = json.dumps(content, ensure_ascii=False)
    assert '名称:设备A' in joined


def test_md_table_tool_title_with_pipe():
    markdown = (
        '# 表|头\n\n'
        '| A | B |\n| --- | --- |\n| 1 | 2 |\n'
    )
    # 短 key 会被 delete_key 清掉：只验证解析不抛错、产出是 dict
    content = MdTableTool().md_table_parser(markdown, 'pipe.md')
    assert isinstance(content, dict)

    # 长标题键保留：标题带 |（is_table_find 的情况 1）
    markdown_long = (
        '# 这是一个非常长的标题含竖线|表\n\n'
        '| A | B |\n| --- | --- |\n| 1 | 2 |\n'
    )
    content_long = MdTableTool().md_table_parser(markdown_long, 'pipe2.md')
    assert isinstance(content_long, dict)


def test_md_table_tool_column_detection_without_pipe_in_first_row(tmp_path):
    tool = MdTableTool()
    rows = ['', '', '| X | Y |', '| --- | --- |', '| 值 | 值 |']
    assert tool.find_table_col_num(rows) == 2
    assert tool.find_table_col_num(['| a | b |']) == 2
    assert tool.is_header_row('| **A** | **B** |', '| x | y |', 2) is True
    assert tool.is_header_row('| A | B |', '| --- | --- |', 2) is True
    assert tool.is_header_row('| A | B |', '| ---x--- | --- |', 2) is True
    assert tool.is_header_row('| A | B | C |', '| --- | --- |', 2) is False
    assert tool.is_header_row('| A |  |', '| x | y |', 2) is False
    assert tool.create_key([' A ', '', 'B ']) == 'A，B'

    # delete_key：短 key 直接删；长 key 且正文含 key 与换行且剩余很短 → 删；
    # 长 key 但正文里没有 key → 保留
    content = {'短': {'text': '正文'},
               '这是一个非常长的标题键': {'text': '这是一个非常长的标题键\nxx'},
               '这是一个超过十个字的保留键': {'text': ' unrelated '}}
    for key in list(content.keys()):
        tool.delete_key(content, key)
    assert '短' not in content
    assert '这是一个非常长的标题键' not in content
    assert '这是一个超过十个字的保留键' in content


def test_pdf_convert_title_all_levels():
    parser = PdfContentParser()
    assert parser.convert_to_markdown_title('t', 2) == '## t'
    assert parser.convert_to_markdown_title('t', 4) == '#### t'
    assert parser.convert_to_markdown_title('t', 5) == '##### t'


def test_process_origin_title_fallback_when_no_match():
    content = '完全没有匹配的内容'
    assert process_origin_title(content, '1.系统启动/关闭', 'T') == content


def test_is_table_list_document_without_pages(monkeypatch):
    parser = PdfContentParser()

    class _EmptyPdf:
        pages = []

    assert parser.is_table_list_document(_EmptyPdf()) is False


def test_textpage_lines_with_newlines_and_blank_chars():
    class _FakeTextPage:
        def __init__(self):
            self.tops = {}

        def get_text_range(self):
            return 'ab\nc\n d'

        def count_chars(self):
            return len(self.get_text_range())

        def get_charbox(self, index):
            # 同一行内 top 相同；换行后换 top；空格给同一 top
            text = self.get_text_range()
            char = text[index]
            if index < 2:
                top = 100.0
            elif char == 'c':
                top = 200.0
            elif char == 'd':
                top = 300.0
            else:
                top = 300.0
            return (0.0, 0.0, 1.0, top)

    parser = PdfContentParser()
    text = parser.textpage_lines(_FakeTextPage())
    assert text.split('\n') == ['ab', 'c', 'd']


def test_combine_text_line_merges_chain_backwards():
    parser = PdfContentParser()
    elements = [
        {'type': 'text', 'bbox': (0, 10, 50, 20), 'data': 'A'},
        {'type': 'text', 'bbox': (5, 12, 30, 18), 'data': 'B'},
        {'type': 'text', 'bbox': (6, 12, 31, 19), 'data': 'C'},
    ]
    parser._combine_text_line(elements)
    assert 'A' in elements[0]['data'] and 'C' in elements[0]['data']


def test_extract_table_content_list_and_none_cells(monkeypatch):
    parser = PdfContentParser()

    class _FakeTable:
        bbox = (10.0, 100.0, 300.0, 200.0)   # PDF 坐标（左下原点）

        def extract(self, **kwargs):
            return [[['甲\n乙'], None, '普通'], ['行二', '值', '']]

    elements = []
    parser._extract_table_content(elements, 780.0, 59.4, 792.0, _FakeTable())
    assert elements and elements[0]['type'] == 'table'
    assert '甲乙' in elements[0]['data']
    assert '|' in elements[0]['data']


# ---------------------------------------------------------------------------
# retrieval：vector_store 的两条 SQL 面
# ---------------------------------------------------------------------------

class _VectorCursor:
    def __init__(self, conn):
        self._conn = conn
        self.description = [('id',), ('text',), ('node_id',), ('embedding',),
                            ('meta_source',), ('meta_content_expand',), ('meta_chunk_id',),
                            ('meta_type',), ('chunk_text',), ('chunk_id',),
                            ('cosine_similarity',)]

    def execute(self, sql, params=None):
        self._conn.executed.append((sql, params))

    def fetchone(self):
        return self._conn.fetchone

    def fetchall(self):
        return self._conn.fetchall

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _VectorConn:
    def __init__(self):
        self.executed = []
        self.fetchone = None
        self.fetchall = []

    def cursor(self):
        return _VectorCursor(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_vector_store_table_exists(monkeypatch):
    conn = _VectorConn()
    conn.fetchone = (1,)
    monkeypatch.setattr(vector_store, 'connection', lambda: conn)
    assert vector_store.table_exists('doc_x_vector') is True
    conn.fetchone = (0,)
    assert vector_store.table_exists('doc_x_vector') is False
    with pytest.raises(Exception):
        vector_store.table_exists('bad name; drop')


def test_vector_store_query_by_embedding_with_chunk(monkeypatch):
    conn = _VectorConn()
    conn.fetchall = [tuple(row.values()) for row in [{
        'id': 1, 'text': '向量行文本', 'node_id': 'n1', 'embedding': '[1,2]',
        'meta_source': 's.md', 'meta_content_expand': 'c1', 'meta_chunk_id': 3,
        'meta_type': 0, 'chunk_text': '切片正文', 'chunk_id': 'c1',
        'cosine_similarity': 0.5,
    }]]
    monkeypatch.setattr(vector_store, 'connection', lambda: conn)
    rows = vector_store.query_by_embedding_with_chunk(
        'doc_x_vector', 'doc_x_chunk', '[1,2]', 0.5, 5)
    assert rows[0]['metadata']['source'] == 's.md'
    assert 'meta_source' not in rows[0]
    sql = conn.executed[0][0]
    assert 'LEFT JOIN kb_index.doc_x_chunk' in sql
    with pytest.raises(Exception):
        vector_store.query_by_embedding_with_chunk('bad name', 'x', '[1,2]', 0.5, 5)


def test_vector_store_select_table_name(monkeypatch):
    conn = _VectorConn()
    conn.fetchone = ('doc_real_vector',)
    monkeypatch.setattr(vector_store, 'connection', lambda: conn)
    assert vector_store.select_table_name_by_kbase_id('kb') == 'doc_real_vector'
    conn.fetchone = None
    assert vector_store.select_table_name_by_kbase_id('kb') is None
