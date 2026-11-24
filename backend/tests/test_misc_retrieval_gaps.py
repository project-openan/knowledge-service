"""retrieval 剩余分支：ES 访问、三写、检索路径与 Agent 公共面。

零真实 ES / PG：client 与 connection 全部打桩。
"""

import pytest

from retrieval.repository import es_store
from retrieval.repository import vector_store
from retrieval.repository import vector_write_store
from retrieval.repository import kbase_lookup
from retrieval.service import retrieve_service
from retrieval.service import node_mapper
from retrieval.service import search as retrieval_search
from retrieval.service import write as retrieval_write
from retrieval.service import index as retrieval_index

KB_ID = '447a9eb509e44d399790dbfd97f25360'


class _FakeIndices:
    def __init__(self, state):
        self._state = state

    def exists(self, name):
        return self._state.get('exists', False)

    def get_mapping(self, name):
        if self._state.get('mapping_error'):
            raise RuntimeError('es down')
        return self._state.get('mapping') or {}

    def create(self, name, body=None):
        self._state['created'] = (name, body)

    def delete(self, name):
        self._state['deleted'] = name


class _FakeCat:
    def __init__(self, state):
        self._state = state

    def plugins(self, format=None):
        if self._state.get('plugins_error'):
            raise RuntimeError('es down')
        return self._state.get('plugins') or []


class _FakeESClient:
    def __init__(self, state=None):
        self.state = state if state is not None else {}
        self.indices = _FakeIndices(self.state)
        self.cat = _FakeCat(self.state)
        self.search_calls = []
        self.bulk_calls = []
        self.update_calls = []
        self.delete_calls = []

    def search(self, index, body=None):
        self.search_calls.append((index, body))
        return self.state.get('search_result') or {}

    def bulk(self, body_lines):
        self.bulk_calls.append(body_lines)
        return self.state.get('bulk_result') or {'errors': False}

    def update_by_query(self, index, body, conflicts=None):
        self.update_calls.append((index, body, conflicts))
        return self.state.get('update_result') or {}

    def delete_by_query(self, index, body, conflicts=None):
        self.delete_calls.append((index, body))
        return {}


@pytest.fixture(autouse=True)
def _reset_es_caches():
    es_store._ik_status = None
    es_store._analyzer_cache.clear()
    yield
    es_store._ik_status = None
    es_store._analyzer_cache.clear()


@pytest.fixture()
def fake_client(monkeypatch):
    client = _FakeESClient()
    monkeypatch.setattr(es_store, '_client', lambda: client)
    return client


# ---------------------------------------------------------------------------
# es_store
# ---------------------------------------------------------------------------

def test_index_name_uses_pk_id_when_table_name_blank():
    assert es_store.index_name('', 7, KB_ID) == 'doc_7'
    assert es_store.index_name('doc_x_vector', 7, KB_ID) == f'doc_{KB_ID}'
    assert es_store.index_name(None, 0, KB_ID) == 'doc_0'


def test_match_clause_analyzer_selection():
    with_ik = es_store._match_clause('text', 'q', True)
    assert with_ik['match']['text']['analyzer'] == 'ik_smart'
    without = es_store._match_clause('text', 'q', False)
    assert without['match']['text']['minimum_should_match'] == '100%'
    explicit = es_store._match_clause('text', 'q', False, analyzer='english')
    assert explicit['match']['text']['analyzer'] == 'english'


def test_ik_analyzer_probe_caches_result(fake_client):
    fake_client.state['plugins'] = [{'component': 'analysis-ik'}]
    assert es_store.ik_analyzer_enabled() is True
    assert es_store._ik_status is True
    # 二次调用走缓存：即使探测开始报错也不变
    fake_client.state['plugins_error'] = True
    assert es_store.ik_analyzer_enabled() is True


def test_ik_analyzer_probe_failure_is_cached_false(fake_client):
    fake_client.state['plugins_error'] = True
    assert es_store.ik_analyzer_enabled() is False
    assert es_store._ik_status is False


def test_search_index_builds_query_and_widens_score(fake_client):
    fake_client.state['search_result'] = {'hits': {'hits': [
        {'_id': 'n1', '_score': 3.0150585, '_source': {'text': 't'}},
        {'_id': 'n2', '_score': 'raw', '_source': None},
    ]}}
    hits = es_store.search_index(f'doc_{KB_ID}', 'question', 5, analyzer='english')
    assert hits[0]['_score'] == 3.0150585174560547
    assert hits[1]['_score'] == 'raw'
    index, body = fake_client.search_calls[0]
    assert index == f'doc_{KB_ID}'
    assert body['size'] == 5


def test_search_requires_existing_kbase(monkeypatch):
    monkeypatch.setattr(es_store, 'get_kbase_row', lambda kb: None)
    with pytest.raises(LookupError):
        es_store.search(KB_ID, 'q', 3)


def test_search_returns_empty_when_index_missing(monkeypatch, fake_client):
    monkeypatch.setattr(es_store, 'get_kbase_row',
                        lambda kb: {'table_name': 'doc_x_vector', 'id': 3})
    fake_client.state['exists'] = False
    assert es_store.search(KB_ID, 'q', 3) == []


def test_widen_es_score_edges():
    assert es_store._widen_es_score(True) is True
    assert es_store._widen_es_score(None) is None
    assert es_store._widen_es_score('1.5') == '1.5'
    assert es_store._widen_es_score(2.0) == 2.0


def test_index_body_analyzer_and_replica_settings(monkeypatch):
    body = es_store.index_body(use_ik=True)
    assert body['mappings']['properties']['text']['analyzer'] == 'ik_smart'
    assert body['settings']['number_of_replicas'] == 0

    monkeypatch.setenv('ES_NUMBER_OF_REPLICAS', 'garbage')
    assert es_store.index_body(False)['settings']['number_of_replicas'] == 0

    monkeypatch.setenv('ES_NUMBER_OF_REPLICAS', '2')
    en_body = es_store.index_body(False, keyword_analyzer='english')
    assert en_body['settings']['number_of_replicas'] == 2
    assert en_body['mappings']['properties']['text']['analyzer'] == 'english'

    # 没装 IK 却硬写 ik_smart：退回 standard
    fallback = es_store.index_body(use_ik=False, keyword_analyzer='ik_smart')
    assert 'analyzer' not in fallback['mappings']['properties']['text']


def test_index_keyword_analyzer_reads_meta_and_caches(fake_client, monkeypatch):
    fake_client.state['mapping'] = {
        f'doc_{KB_ID}': {'mappings': {'_meta': {'keyword_analyzer': 'english'}}}}
    assert es_store.index_keyword_analyzer(f'doc_{KB_ID}') == 'english'
    fake_client.state['mapping'] = {}
    # 命中缓存（TTL 内不再读 mapping）
    assert es_store.index_keyword_analyzer(f'doc_{KB_ID}') == 'english'


def test_index_keyword_analyzer_fallback_and_error(fake_client, monkeypatch):
    other_index = 'doc_other'
    fake_client.state['mapping'] = {'doc_alias': {'mappings': {
        'properties': {'text': {'analyzer': 'ik_smart'}}}}}
    assert es_store.index_keyword_analyzer(other_index) == 'ik_smart'

    es_store._analyzer_cache.clear()
    fake_client.state['mapping_error'] = True
    assert es_store.index_keyword_analyzer('doc_bad') == 'standard'


def test_create_index_skips_existing(fake_client, monkeypatch):
    monkeypatch.setattr(es_store, 'get_kbase_row',
                        lambda kb: {'table_name': None, 'id': 5})
    fake_client.state['exists'] = True
    es_store.create_index(KB_ID)
    assert 'created' not in fake_client.state


def test_create_and_delete_index(fake_client, monkeypatch):
    monkeypatch.setattr(es_store, 'get_kbase_row',
                        lambda kb: {'table_name': None, 'id': 5})
    es_store.create_index(KB_ID, keyword_analyzer='english')
    name, body = fake_client.state['created']
    assert name == 'doc_5'
    assert body['mappings']['_meta']['keyword_analyzer'] == 'english'

    fake_client.state['exists'] = True
    es_store.delete_index(KB_ID)
    assert fake_client.state['deleted'] == 'doc_5'
    assert 'doc_5' not in es_store._analyzer_cache


def test_delete_index_skips_missing(fake_client, monkeypatch):
    monkeypatch.setattr(es_store, 'get_kbase_row', lambda kb: None)
    es_store.delete_index(KB_ID)
    assert 'deleted' not in fake_client.state


# ---------------------------------------------------------------------------
# vector_write_store：三写
# ---------------------------------------------------------------------------

class _FakeCursor:
    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=None):
        self._conn.executed.append((sql, params))

    def executemany(self, sql, rows):
        self._conn.executed.append((sql, rows))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self):
        self.executed = []

    def cursor(self):
        return _FakeCursor(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture()
def fake_db(monkeypatch):
    conn = _FakeConn()
    monkeypatch.setattr(vector_write_store, 'connection', lambda: conn)
    return conn


def test_flat_document_keeps_zero_and_drops_dirty_values():
    doc = vector_write_store.flat_document(
        'n1', 'f1', '正文',
        {'source': 's.md', 'chunk_index': '', 'chunk_id': 3, 'type': 0})
    assert doc == {'node_id': 'n1', 'file_id': 'f1', 'text': '正文', 'source': 's.md',
                   'chunk_index': '', 'chunk_id': 3, 'type': 0}

    dirty = vector_write_store.flat_document(
        None, None, None, {'source': None, 'chunk_id': 'uuid', 'type': True})
    assert dirty == {}

    assert vector_write_store.flat_document('n', 'f', 't', None)['node_id'] == 'n'


def test_build_metadata_points_content_expand_at_chunk_id():
    assert vector_write_store.build_metadata({'a': 1}, 'c1') == {'a': 1, 'content_expand': 'c1'}
    assert vector_write_store.build_metadata(None, None) == {}


def test_save_chunks_batches_and_skips_empty(fake_db):
    vector_write_store.save_chunks('doc_x_chunk', [])
    assert fake_db.executed == []

    chunks = [{'id': f'c{i}', 'kbId': KB_ID, 'source': 's', 'text': 't',
               'metadata': {'chunk_id': i, 'type': 0}} for i in range(5)]
    vector_write_store.save_chunks('doc_x_chunk', chunks)
    sql, rows = fake_db.executed[0]
    assert 'INSERT INTO kb_index.doc_x_chunk' in sql
    assert len(rows) == 5


def test_save_vectors_batches(fake_db):
    rows = [{'node_id': f'n{i}', 'embedding': [0.1, 0.2],
             'metadata': {'source': 's', 'chunk_id': i, 'type': 0, 'content_expand': f'c{i}'}}
            for i in range(3)]
    vector_write_store.save_vectors('doc_x_vector', rows)
    sql, params = fake_db.executed[0]
    assert '%s::vector' in sql
    assert len(params) == 3
    vector_write_store.save_vectors('doc_x_vector', [])
    assert len(fake_db.executed) == 1


def test_bulk_index_failure_branches(fake_client):
    # 无 items：整批失败
    fake_client.state['bulk_result'] = {'errors': True, 'items': []}
    nodes = [{'node_id': f'n{i}', 'text': 't', 'metadata': {}} for i in range(3)]
    assert vector_write_store._bulk_index(fake_client, 'idx', nodes, 'f1') == [0, 1, 2]

    # 有 items：按状态挑失败项
    fake_client.state['bulk_result'] = {'errors': True, 'items': [
        {'index': {'status': 200}}, {'create': {'status': 500, 'error': 'boom'}}]}
    assert vector_write_store._bulk_index(fake_client, 'idx', nodes, 'f1') == [1]

    # 缺 node_id 直接抛
    with pytest.raises(ValueError):
        vector_write_store._bulk_index(fake_client, 'idx', [{'text': 't'}], 'f1')


def test_save_es_documents_guards(fake_client, monkeypatch):
    monkeypatch.setattr(vector_write_store, 'get_kbase_row', lambda kb: None)
    assert vector_write_store.save_es_documents(KB_ID, 'f', []) is None

    fake_client.state['exists'] = False
    with pytest.raises(RuntimeError):
        vector_write_store.save_es_documents(KB_ID, 'f', [{'node_id': 'n', 'text': 't'}])

    fake_client.state['exists'] = True
    fake_client.state['bulk_result'] = {'errors': True, 'items': [
        {'index': {'status': 500}}]}
    with pytest.raises(RuntimeError):
        vector_write_store.save_es_documents(KB_ID, 'f', [{'node_id': 'n', 'text': 't'}])

    fake_client.state['bulk_result'] = {'errors': False}
    vector_write_store.save_es_documents(KB_ID, 'f', [{'node_id': 'n', 'text': 't'}])
    assert fake_client.bulk_calls


def test_es_index_for_returns_none_when_missing(fake_client, monkeypatch):
    monkeypatch.setattr(vector_write_store, 'get_kbase_row', lambda kb: None)
    fake_client.state['exists'] = False
    assert vector_write_store._es_index_for(KB_ID) is None
    fake_client.state['exists'] = True
    assert vector_write_store._es_index_for(KB_ID) == 'doc_0'


def test_update_es_document_by_node_id(fake_client, monkeypatch):
    monkeypatch.setattr(vector_write_store, 'get_kbase_row', lambda kb: None)
    fake_client.state['exists'] = False
    assert vector_write_store.update_es_document_by_node_id(KB_ID, 'n', 'k', {}) is None

    fake_client.state['exists'] = True
    fake_client.state['update_result'] = {
        'updated': 0, 'failures': [{'x': 1}], 'version_conflicts': 2}
    vector_write_store.update_es_document_by_node_id(
        KB_ID, 'n', '新正文', {'source': 's', 'chunk_id': 1, 'type': 0})
    index, body, conflicts = fake_client.update_calls[0]
    assert conflicts == 'proceed'
    assert body['script']['params']['text'] == '新正文'
    assert body['script']['params']['fields']['chunk_id'] == 1
    assert 'source' in body['script']['params']['fields']


def test_flat_update_script_removes_absent_fields():
    script = vector_write_store._flat_update_script(None, {})
    assert script['params']['text'] is None
    assert script['params']['fields'] == {}
    assert 'ctx._source.remove' in script['source']


def test_delete_es_documents_by_query(fake_client, monkeypatch):
    monkeypatch.setattr(vector_write_store, 'get_kbase_row', lambda kb: None)
    assert vector_write_store.delete_es_documents_by_query(KB_ID, 'file_id', []) is None
    fake_client.state['exists'] = False
    assert vector_write_store.delete_es_documents_by_query(KB_ID, 'file_id', ['f']) is None
    fake_client.state['exists'] = True
    vector_write_store.delete_es_documents_by_query(KB_ID, 'file_id', ['f1', 'f2'])
    index, body = fake_client.delete_calls[0]
    assert body['query']['bool']['must'][0]['terms'] == {'file_id': ['f1', 'f2']}


# ---------------------------------------------------------------------------
# kbase_lookup / 公共包装层（search.py / write.py / index.py）
# ---------------------------------------------------------------------------

def test_kbase_lookup_raises_without_provider(monkeypatch):
    monkeypatch.setattr(kbase_lookup, '_provider', None)
    with pytest.raises(RuntimeError):
        kbase_lookup.get_kbase_row('x')
    provider = lambda kb: {'id': 1}  # noqa: E731
    kbase_lookup.set_kbase_row_provider(provider)
    assert kbase_lookup.get_kbase_row('x') == {'id': 1}
    kbase_lookup.set_kbase_row_provider(None)


def test_search_wrappers_delegate(monkeypatch):
    seen = {}

    class _Row(dict):
        pass

    monkeypatch.setattr(es_store, 'index_name', lambda table, pk, kb: 'doc_x')
    monkeypatch.setattr(es_store, 'index_exists_by_name', lambda name: seen.setdefault('exists', True))
    monkeypatch.setattr(es_store, 'search_index', lambda name, q, k: seen.setdefault('search', (name, q, k)))
    monkeypatch.setattr(vector_store, 'table_exists', lambda t: seen.setdefault('table', t))
    monkeypatch.setattr(vector_store, 'query_by_embedding_with_chunk',
                        lambda *a, **k: seen.setdefault('vector', a))

    assert retrieval_search.index_name_for_row(
        {'table_name': 't', 'id': 1, 'kbase_id': KB_ID}) == 'doc_x'
    assert retrieval_search.index_exists('doc_x') is True
    assert retrieval_search.search_index('doc_x', 'q', 3) == ('doc_x', 'q', 3)
    assert retrieval_search.table_exists('t') == 't'
    assert retrieval_search.query_by_embedding_with_chunk('a', 'b', 'c', 0.5, 3) == ('a', 'b', 'c', 0.5, 3)


def test_write_wrappers_delegate(monkeypatch):
    seen = {}
    monkeypatch.setattr(vector_write_store, 'build_metadata',
                        lambda m, c: seen.setdefault('meta', (m, c)))
    monkeypatch.setattr(vector_write_store, 'save_chunks',
                        lambda t, c: seen.setdefault('chunks', t))
    monkeypatch.setattr(vector_write_store, 'save_vectors',
                        lambda t, r: seen.setdefault('vectors', t))
    monkeypatch.setattr(vector_write_store, 'save_es_documents',
                        lambda kb, f, n: seen.setdefault('es_save', (kb, f)))
    monkeypatch.setattr(vector_write_store, 'update_es_document_by_node_id',
                        lambda kb, n, k, m: seen.setdefault('es_update', n))
    monkeypatch.setattr(vector_write_store, 'delete_es_documents_by_query',
                        lambda kb, field, values: seen.setdefault('es_delete', field))

    retrieval_write.build_metadata({'a': 1}, 'c')
    retrieval_write.save_chunks('t', [])
    retrieval_write.save_vectors('t', [])
    retrieval_write.save_es_documents(KB_ID, 'f', [])
    retrieval_write.update_es_document_by_node_id(KB_ID, 'n', 'k', {})
    retrieval_write.delete_es_documents_by_query(KB_ID, 'file_id', ['f'])
    assert seen['meta'] == ({'a': 1}, 'c')
    assert seen['es_save'] == (KB_ID, 'f')


def test_index_wrappers_delegate(monkeypatch):
    seen = {}
    monkeypatch.setattr(es_store, 'create_index',
                        lambda kb, keyword_analyzer=None: seen.setdefault(
                            'create', (kb, keyword_analyzer)))
    monkeypatch.setattr(es_store, 'delete_index', lambda kb: seen.setdefault('delete', kb))
    monkeypatch.setattr(retrieval_index, 'get_kbase_row', lambda kb: {'table_name': 't', 'id': 1})
    monkeypatch.setattr(es_store, 'index_name', lambda t, pk, kb: 'doc_x')

    client = _FakeESClient()
    monkeypatch.setattr(es_store, '_client', lambda: client)
    retrieval_index.create_index(KB_ID, keyword_analyzer='english')
    retrieval_index.delete_index(KB_ID)
    retrieval_index.delete_documents_by_file_id(KB_ID, 'f1')  # 索引不存在 → no-op
    client.state['exists'] = True
    retrieval_index.delete_documents_by_file_id(KB_ID, 'f1')
    assert seen['create'] == (KB_ID, 'english')
    assert seen['delete'] == KB_ID
    assert client.delete_calls[0][1]['query']['term'] == {'file_id': 'f1'}

    monkeypatch.setattr(vector_write_store, 'delete_es_documents_by_query',
                        lambda kb, f, v: seen.setdefault('del_by_query', (kb, f)))
    retrieval_index.delete_documents_by_query(KB_ID, 'file_id', ['f'])
    assert seen['del_by_query'] == (KB_ID, 'file_id')


# ---------------------------------------------------------------------------
# retrieve_service / node_mapper
# ---------------------------------------------------------------------------

def _payload(**overrides):
    body = {'question': 'RAG', 'type': 0,
            'bases': [{'baseList': ['doc_x'], 'priority': 0, 'top_k': 3,
                       'score_threshold': 0.0}]}
    body.update(overrides)
    return body


@pytest.mark.parametrize('bad', [
    {'question': '   '},
    {'type': None},
    {'type': 2},
    {'type': True},
    {'bases': None},
    {'bases': []},
    {'bases': [{'baseList': None}]},
    {'bases': [{'baseList': []}]},
    {'bases': [{'baseList': ['x'], 'priority': 11}]},
    {'bases': [{'baseList': ['x'], 'top_k': 0}]},
    {'bases': [{'baseList': ['x'], 'top_k': 81}]},
    {'bases': [{'baseList': ['x'], 'score_threshold': 1.5}]},
])
def test_validate_rejects_bad_payloads(bad):
    from shared.errors.api import KbValidationError
    with pytest.raises(KbValidationError):
        retrieve_service._validate(_payload(**bad))


def test_validate_accepts_missing_optional_fields():
    retrieve_service._validate({'question': 'q', 'bases': [{'baseList': ['x']}]})


def test_retrieve_swallows_unexpected_errors(monkeypatch):
    monkeypatch.setattr(retrieve_service, '_validate', lambda dto: None)
    monkeypatch.setattr(retrieve_service, '_query_embedding',
                        lambda dto: (_ for _ in ()).throw(RuntimeError('x')))
    assert retrieve_service.retrieve(_payload()) == []


def test_clean_base_name_strips_scope_suffix():
    assert retrieve_service._clean_base_name('doc_x|#|dev') == 'doc_x'
    assert retrieve_service._clean_base_name('doc_x') == 'doc_x'
    assert retrieve_service._clean_base_name('') == ''


def test_vector_table_name_fallbacks(monkeypatch):
    monkeypatch.setattr(vector_store, 'select_table_name_by_kbase_id',
                        lambda kb: (_ for _ in ()).throw(RuntimeError('db down')))
    assert retrieve_service._vector_table_name(KB_ID, 'doc_x') == 'doc_x_vector'
    assert retrieve_service._vector_table_name(KB_ID, 'doc_x_vector') == 'doc_x_vector'
    assert retrieve_service._vector_table_name(KB_ID, 'legacy') == 'data_legacy'

    monkeypatch.setattr(vector_store, 'select_table_name_by_kbase_id', lambda kb: '  ')
    assert retrieve_service._vector_table_name(KB_ID, 'legacy') == 'data_legacy'
    monkeypatch.setattr(vector_store, 'select_table_name_by_kbase_id', lambda kb: 'doc_real_vector')
    assert retrieve_service._vector_table_name(KB_ID, 'doc_x') == 'doc_real_vector'


def test_chunk_table_name(monkeypatch):
    monkeypatch.setattr(vector_store, 'select_table_name_by_kbase_id',
                        lambda kb: 'doc_real_vector')
    assert retrieve_service._chunk_table_name(KB_ID, 'doc_x') == 'doc_real_chunk'
    monkeypatch.setattr(vector_store, 'select_table_name_by_kbase_id', lambda kb: '')
    assert retrieve_service._chunk_table_name(KB_ID, 'doc_x') == 'doc_x_chunk'


def test_build_docs_empty_records():
    assert retrieve_service.build_docs([]) == []
    assert retrieve_service.keyword_node_with_score(
        {'_id': 'n', '_score': None, '_source': {'text': 't'}})['score'] == 0.0


def test_random_uuid_is_unique():
    assert retrieve_service._random_uuid() != retrieve_service._random_uuid()


def _vector_record(**overrides):
    record = {
        'id': 1, 'text': '正文', 'node_id': 'n1', 'embedding': None,
        'cosine_similarity': 0.15,
        'metadata': {'chunk_index': '', 'source': 's.md', 'type': 0,
                     'chunk_id': 1, 'content_expand': '1'},
        'chunk_text': '切片正文', 'chunk_id': '1',
    }
    record.update(overrides)
    return record


def test_node_mapper_as_helpers():
    assert node_mapper.as_string(None) is None
    assert node_mapper.as_string(True) == 'true'
    assert node_mapper.as_double('1.0') is None
    assert node_mapper.as_double(True) is None
    assert node_mapper.as_double(2) == 2.0


def test_process_vector_record_without_metadata_degrades():
    record = _vector_record()
    record.pop('metadata')
    for column in ('chunk_index', 'source', 'type', 'chunk_id', 'content_expand'):
        record.pop(column, None)
    assert node_mapper.process_vector_record(record) == {}


def test_enrich_metadata_with_chunk_text_branches():
    record = _vector_record()
    node_mapper.enrich_metadata_with_chunk_text(record, '切片正文', '1')
    assert record['metadata']['content_expand'] == '切片正文'

    mismatch = _vector_record()
    node_mapper.enrich_metadata_with_chunk_text(mismatch, 'x', '999')
    assert mismatch['metadata']['content_expand'] == '1'

    no_meta = {'metadata': None}
    node_mapper.enrich_metadata_with_chunk_text(no_meta, 'x', '1')
    assert no_meta['metadata'] is None

    bad_meta = {'metadata': 'not-a-map'}
    node_mapper.enrich_metadata_with_chunk_text(bad_meta, 'x', '1')
    assert bad_meta['metadata'] == 'not-a-map'

    no_chunk = _vector_record()
    node_mapper.enrich_metadata_with_chunk_text(no_chunk, None, None)
    assert no_chunk['metadata']['content_expand'] == '1'


def test_to_search_doc_and_results():
    doc = {'node': {'text': '正文', 'file_id': 'f1', 'metadata': {
        'chunk_id': 1, 'content_expand': 'x', 'source': 's'}}, 'score': 0.5}
    converted = node_mapper.to_search_doc(doc)
    assert converted['chunkId'] == '1'
    assert converted['content'] == '正文'
    assert converted['score'] == 0.5
    assert converted['sourceDocId'] == 'f1'
    assert 'content_expand' not in converted['metadata']

    raw_no_metadata = {'node': {'text': 't'}, 'score': 'x'}
    assert node_mapper.to_search_doc(raw_no_metadata)['metadata'] is None
    assert node_mapper.to_search_doc(raw_no_metadata)['score'] is None

    results = node_mapper.to_search_results([
        {'base_name': 'b', 'docs': [doc, 'not-a-dict']},
        {'base_name': None, 'docs': 'nope'},
    ])
    assert results[0]['docs'] and results[1]['docs'] == []
    assert results[1]['baseName'] is None
