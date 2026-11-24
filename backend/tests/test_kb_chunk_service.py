"""``chunk_service``：切片的新增/修改/删除/列表/按文件搜/溯源。

不连库：repository、向量写入、embedding 网关全部用桩。

跑法（服务目录下）::

    python -m pytest tests/test_kb_chunk_service.py -q
"""

from __future__ import annotations

import pytest

from shared.errors.api import KbApiError, KbLiteralError
from knowledge_base.service import chunk_service as cs


@pytest.fixture()
def env(monkeypatch):
    """chunk_service 依赖的所有出模块的点。"""
    env = {
        'kbase': {'kbase_id': 'kb1', 'id': 5, 'table_name': 'doc_kb1_vector',
                  'embedding_model': 'bge-base'},
        'file_row': {'id': 'f1', 'kbase_id': 'kb1', 'title': 'a.md', 'type': 'file',
                     'parent_id': 'root'},
        'calls': [],
    }

    import knowledge_base.repository.chunk as chunk_store
    import knowledge_base.repository.directory as directory_store
    import knowledge_base.repository.kbase as kbase_store
    import knowledge_base.repository.node_relation as relation_store
    import retrieval.service.write as write_service
    from model import gateway as model_gateway

    monkeypatch.setattr(kbase_store, 'select_kbase_by_id',
                        lambda kbase_id: env['kbase'] if kbase_id == 'kb1' else None)
    monkeypatch.setattr(directory_store, 'get_directory',
                        lambda file_id, kbase_id, dir_type=None:
                        env['file_row'] if file_id == 'f1' else None)
    monkeypatch.setattr(directory_store, 'get_files_by_ids',
                        lambda ids, kbase_id=None: env.get('files', []))

    def select_relation(chunk_id, kbase_id):
        env['calls'].append(('relation', chunk_id, kbase_id))
        if chunk_id == 11:
            return {'id': 11, 'kbase_id': 'kb1', 'directory_id': 'f1',
                    'node_id': 'node-1'}
        return None

    monkeypatch.setattr(chunk_store, 'select_relation_by_id', select_relation)
    monkeypatch.setattr(chunk_store, 'insert_index',
                        lambda kbase, rows: env['calls'].append(('insert_index', rows)))
    monkeypatch.setattr(chunk_store, 'insert_chunk',
                        lambda kbase, chunk_id, kbase_id, source, text:
                        env['calls'].append(('insert_chunk', chunk_id, text)))
    monkeypatch.setattr(chunk_store, 'delete_by_node_ids',
                        lambda kbase, node_ids:
                        env['calls'].append(('delete_nodes', list(node_ids))))
    monkeypatch.setattr(chunk_store, 'update_index',
                        lambda kbase, index_id, text, metadata, embedding:
                        env['calls'].append(('update_index', index_id, text, metadata)))
    monkeypatch.setattr(chunk_store, 'update_chunk_text',
                        lambda kbase, chunk_id, text, metadata:
                        env['calls'].append(('update_chunk_text', chunk_id, text)))
    monkeypatch.setattr(chunk_store, 'delete_chunk_by_id',
                        lambda kbase, chunk_id:
                        env['calls'].append(('delete_chunk', chunk_id)))
    monkeypatch.setattr(chunk_store, 'delete_relation',
                        lambda chunk_id: env['calls'].append(('delete_relation', chunk_id)))
    monkeypatch.setattr(chunk_store, 'query_by_node_id',
                        lambda kbase, node_id: {'id': 7, 'metadata': {
                            'content_expand': 'chunk-9', 'source': 'a.md'}})
    monkeypatch.setattr(chunk_store, 'query_page_by_keyword',
                        lambda kbase, keyword, page, size: ([], 0))
    monkeypatch.setattr(chunk_store, 'count_by_file',
                        lambda kbase, file_id, keyword: env.get('total', 0))
    monkeypatch.setattr(chunk_store, 'list_by_file',
                        lambda kbase, file_id, keyword, page, size, asc=False:
                        env.get('rows', []))
    monkeypatch.setattr(chunk_store, 'query_by_chunk_ids',
                        lambda kbase, ids: env.get('chunk_rows', []))
    monkeypatch.setattr(chunk_store, 'select_relations_by_node_ids',
                        lambda node_ids, kbase_id=None: env.get('relations', []))

    monkeypatch.setattr(relation_store, 'batch_insert_relations',
                        lambda kbase_id, file_id, node_ids:
                        env['calls'].append(('relations', kbase_id, file_id,
                                             list(node_ids))))
    monkeypatch.setattr(write_service, 'save_es_documents',
                        lambda kbase_id, file_id, docs:
                        env['calls'].append(('es_save', kbase_id, file_id, docs)))
    monkeypatch.setattr(write_service, 'update_es_document_by_node_id',
                        lambda kbase_id, node_id, text, metadata:
                        env['calls'].append(('es_update', node_id, text)))
    monkeypatch.setattr(write_service, 'delete_es_documents_by_query',
                        lambda kbase_id, field, values:
                        env['calls'].append(('es_delete', field, list(values))))
    monkeypatch.setattr(write_service, 'save_chunks',
                        lambda chunk_table, chunks:
                        env['calls'].append(('save_chunks', chunk_table)))
    monkeypatch.setattr(model_gateway, 'embed', lambda text, model: [0.1, 0.2])

    return env


# ----------------------------------------------------------------------
# 前置检查
# ----------------------------------------------------------------------


def test_kbase_or_raise(env, monkeypatch):
    assert cs._kbase_or_raise('kb1') == env['kbase']
    with pytest.raises(KbApiError) as caught:
        cs._kbase_or_raise('ghost')
    assert caught.value.key == 'kbase.not.exist'


def test_file_or_raise_rejects_folders(env):
    assert cs._file_or_raise('kb1', 'f1') == env['file_row']
    with pytest.raises(KbApiError) as caught:
        cs._file_or_raise('kb1', 'root')                       # 文件夹 id → 文件不存在
    assert caught.value.key == 'RetCode.file.not.exist'


def test_relation_or_raise(env):
    assert cs._relation_or_raise(11, 'kb1')['node_id'] == 'node-1'
    with pytest.raises(KbApiError) as caught:
        cs._relation_or_raise(404, 'kb1')
    assert caught.value.key == 'RetCode.dataSet.not.exist'


# ----------------------------------------------------------------------
# 新增
# ----------------------------------------------------------------------


def test_add_chunk_writes_vector_chunk_relation_and_es(env):
    result = cs.add_chunk('kb1', 'f1', {'content': '正文', 'supplement': '补充'})

    kinds = [call[0] for call in env['calls']]
    assert kinds == ['insert_index', 'insert_chunk', 'relations', 'es_save']
    assert result['chunkId']

    insert_index = env['calls'][0][1][0]
    assert insert_index['text'] is None                        # 正文只留 chunk.text
    assert insert_index['metadata']['source'] == 'a.md'
    assert insert_index['metadata']['content_expand'] == result['chunkId']
    assert insert_index['metadata']['type'] == 1
    assert insert_index['embedding'] == [0.1, 0.2]

    assert env['calls'][1][1] == result['chunkId']             # chunk 表写 supplement
    assert env['calls'][1][2] == '补充'
    assert env['calls'][2][1:3] == ('kb1', 'f1')
    es_docs = env['calls'][3][3]
    assert es_docs[0]['text'] == '正文'


def test_add_chunk_supplement_falls_back_to_content(env):
    cs.add_chunk('kb1', 'f1', {'content': '正文'})

    assert env['calls'][1][2] == '正文'                         # supplement 缺省回落 content


def test_add_chunk_rolls_back_vector_row_when_chunk_write_fails(env, monkeypatch):
    import knowledge_base.repository.chunk as chunk_store

    def broken_insert_chunk(kbase, chunk_id, kbase_id, source, text):
        raise RuntimeError('chunk table missing')

    monkeypatch.setattr(chunk_store, 'insert_chunk', broken_insert_chunk)

    with pytest.raises(RuntimeError):
        cs.add_chunk('kb1', 'f1', {'content': '正文'})

    kinds = [call[0] for call in env['calls']]
    assert kinds == ['insert_index', 'delete_nodes']           # 补偿删向量行


def test_add_chunk_embedding_failure_is_literal_error(env, monkeypatch):
    from model import gateway as model_gateway

    def boom(text, model):
        raise RuntimeError('gateway down')

    monkeypatch.setattr(model_gateway, 'embed', boom)

    with pytest.raises(KbLiteralError) as caught:
        cs.add_chunk('kb1', 'f1', {'content': '正文'})

    assert caught.value.literal_message() == 'RetCode.embedding.fail'


# ----------------------------------------------------------------------
# 修改
# ----------------------------------------------------------------------


def test_update_chunk_rewrites_chunk_vector_and_es(env):
    cs.update_chunk(11, 'kb1', {'content': '新正文', 'supplement': '新补充'})

    calls = [call for call in env['calls'] if call[0] != 'relation']
    assert [call[0] for call in calls] == ['update_chunk_text', 'update_index',
                                           'es_update']
    assert calls[0][1:] == ('chunk-9', '新补充')
    assert calls[1][1:3] == (7, None)                          # 向量表不写正文
    assert calls[2][1:] == ('node-1', '新正文')


def test_update_chunk_without_chunk_row_skips_chunk_write(env, monkeypatch):
    import knowledge_base.repository.chunk as chunk_store
    monkeypatch.setattr(chunk_store, 'query_by_node_id',
                        lambda kbase, node_id: {'id': 7, 'metadata': {}})

    cs.update_chunk(11, 'kb1', {'content': '新正文'})

    kinds = [call[0] for call in env['calls'] if call[0] != 'relation']
    assert 'update_chunk_text' not in kinds


def test_update_chunk_propagates_chunk_write_failure(env, monkeypatch):
    import knowledge_base.repository.chunk as chunk_store

    def broken(kbase, chunk_id, text, metadata):
        raise RuntimeError('db down')

    monkeypatch.setattr(chunk_store, 'update_chunk_text', broken)

    with pytest.raises(RuntimeError):
        cs.update_chunk(11, 'kb1', {'content': '正文', 'supplement': 's'})


# ----------------------------------------------------------------------
# 删除
# ----------------------------------------------------------------------


def test_delete_chunk_order_es_first_relation_last(env):
    cs.delete_chunk(11, 'kb1')

    calls = [call for call in env['calls'] if call[0] != 'relation']
    assert [call[0] for call in calls] == ['es_delete', 'delete_chunk', 'delete_nodes',
                                           'delete_relation']
    assert calls[0][1:] == ('node_id', ['node-1'])
    assert calls[1][1] == 'chunk-9'


def test_delete_chunk_without_chunk_row(env, monkeypatch):
    import knowledge_base.repository.chunk as chunk_store
    monkeypatch.setattr(chunk_store, 'query_by_node_id',
                        lambda kbase, node_id: {'id': 7, 'metadata': {}})

    cs.delete_chunk(11, 'kb1')

    kinds = [call[0] for call in env['calls'] if call[0] != 'relation']
    assert 'delete_chunk' not in kinds                         # 无 content_expand → 不删
    assert kinds == ['es_delete', 'delete_nodes', 'delete_relation']


# ----------------------------------------------------------------------
# 列表与按文件搜
# ----------------------------------------------------------------------


def test_chunk_list_empty_page(env):
    body = cs.get_chunk_list('kb1', None, None, 1, 20)

    assert body['total'] == 0 and body['items'] == []


def test_chunk_list_assembles_supplement_and_source(env, monkeypatch):
    records = [{'id': 1, 'text': None, 'node_id': 'node-1',
                'metadata': {'content_expand': 'chunk-9', 'source': 'a.md'}}]
    env['calls'] = []
    import knowledge_base.repository.chunk as chunk_store
    monkey_total = {'kw': (records, 1)}

    def fake_query(kbase, keyword, page, size):
        return monkey_total.get(keyword or 'kw', ([], 0))

    monkeypatch.setattr(chunk_store, 'query_page_by_keyword', fake_query)
    monkeypatch.setattr(chunk_store, 'query_by_chunk_ids',
                        lambda kbase, ids: [{'id': 'chunk-9', 'text': '切片正文'}])
    monkeypatch.setattr(chunk_store, 'select_relations_by_node_ids',
                        lambda node_ids, kbase_id=None: [
                            {'id': 11, 'node_id': 'node-1', 'directory_id': 'f1'}])

    import knowledge_base.repository.directory as directory_store
    monkeypatch.setattr(directory_store, 'get_files_by_ids',
                        lambda ids, kbase_id=None:
                        [{'id': 'f1', 'title': 'a.md'}])

    body = cs.get_chunk_list('kb1', None, 'kw', 1, 20)

    vo = body['items'][0]
    assert vo['chunkId'] == 11                                 # relation 主键
    assert vo['fileId'] == 'f1'
    assert vo['supplement'] == '切片正文'                       # chunk 表正文优先
    assert vo['source'] == 'a.md'
    assert vo['rankScore'] is None and vo['fullScore'] is None # 13 键全集的尾部


def test_chunk_list_survives_chunk_table_errors(env, monkeypatch):
    import knowledge_base.repository.chunk as chunk_store

    records = [{'id': 1, 'text': None, 'node_id': 'node-1',
                'metadata': {'content_expand': 'chunk-9'}}]

    def boom(kbase, ids):
        raise RuntimeError('chunk table missing')

    monkeypatch.setattr(chunk_store, 'query_page_by_keyword',
                        lambda kbase, kw, page, size: (records, 1))
    monkeypatch.setattr(chunk_store, 'query_by_chunk_ids', boom)
    monkeypatch.setattr(chunk_store, 'select_relations_by_node_ids',
                        lambda node_ids, kbase_id=None: [])
    import knowledge_base.repository.directory as directory_store
    monkeypatch.setattr(directory_store, 'get_files_by_ids',
                        lambda ids, kbase_id=None: [])

    body = cs.get_chunk_list('kb1', None, 'kw', 1, 20)

    assert body['items'][0]['supplement'] == 'chunk-9'         # 回落 content_expand


def test_supplement_semantics():
    assert cs._supplement_of(None, {'text': 'x'}) == ''
    assert cs._supplement_of({}, {'text': 'x'}) == ''
    assert cs._supplement_of({'type': 1}, {'text': 'x'}) == ''
    # chunk 行存在且有正文 → 用正文
    assert cs._supplement_of({'content_expand': 'c1'}, {'id': 'c1', 'text': '正文'}) == '正文'
    # chunk 行不存在（正文查询落空）→ 回落 content_expand
    assert cs._supplement_of({'content_expand': 'c1'}, None) == 'c1'
    assert cs._supplement_of({'content_expand': 'c1'}, {'id': 'c1', 'text': '   '}) == 'c1'
    assert cs._chunk_id_of(None) is None
    assert cs._chunk_id_of({'metadata': {'content_expand': 7}}) == '7'


def test_search_chunk_from_file_empty(env):
    body = cs.search_chunk_from_file('kb1', 'f1', None, 1, 10)

    assert body['total'] == 0 and body['items'] == []
    assert body['nameChain'] == ['Default' if False else '', '']


def test_search_chunk_from_file_with_rows(env, monkeypatch):
    import knowledge_base.repository.chunk as chunk_store
    import knowledge_base.repository.directory as directory_store

    env['total'] = 1
    joined = [{'chunk_id': 11, 'directory_id': 'f1', 'text': '正文',
               'metadata': {'content_expand': 'chunk-9', 'source': 'a.md'}}]
    monkeypatch.setattr(chunk_store, 'list_by_file',
                        lambda kbase, file_id, kw, page, size, asc=False: joined)
    monkeypatch.setattr(chunk_store, 'query_by_chunk_ids',
                        lambda kbase, ids: [{'id': 'chunk-9', 'text': '切片正文'}])
    monkeypatch.setattr(directory_store, 'get_files_by_ids',
                        lambda ids, kbase_id=None:
                        [{'id': 'root', 'title': 'Default'}, {'id': 'f1', 'title': 'a.md'}])

    body = cs.search_chunk_from_file('kb1', 'f1', None, 1, 10, chunk_id_asc=True)

    vo = body['items'][0]
    assert vo['content'] == '正文' and vo['supplement'] == '切片正文'
    assert vo['source'] == 'a.md'
    assert body['nameChain'] == ['Default', 'a.md']            # 父目录名 + 文件名


def test_search_chunk_from_file_zero_total_skips_list_query(env, monkeypatch):
    import knowledge_base.repository.chunk as chunk_store

    def _boom(*args, **kwargs):
        raise AssertionError('total=0 时不应查询切片行')

    monkeypatch.setattr(chunk_store, 'list_by_file', _boom)
    import knowledge_base.repository.directory as directory_store
    monkeypatch.setattr(directory_store, 'get_files_by_ids', lambda ids, kbase_id=None: [])

    body = cs.search_chunk_from_file('kb1', 'f1', None, 1, 10)

    assert body['items'] == []


# ----------------------------------------------------------------------
# 溯源
# ----------------------------------------------------------------------


def test_trace_source_file_groups_nodes(env, monkeypatch):
    import knowledge_base.repository.chunk as chunk_store
    import knowledge_base.repository.kbase as kbase_store
    import knowledge_base.repository.directory as directory_store

    relations = [
        {'id': 1, 'node_id': 'n1', 'kbase_id': 'kb1', 'directory_id': 'f1'},
        {'id': 2, 'node_id': 'n2', 'kbase_id': 'kb2', 'directory_id': 'f2'},
    ]
    monkeypatch.setattr(chunk_store, 'select_relations_by_node_ids',
                        lambda node_ids: relations)
    monkeypatch.setattr(kbase_store, 'select_all_kbases',
                        lambda org_id: [{'kbase_id': 'kb1'}])   # 只有 kb1 可访问
    monkeypatch.setattr(directory_store, 'get_files_by_ids',
                        lambda ids, kbase_id=None: [
                            {'id': 'f1', 'kbase_id': 'kb1', 'title': 'a.md'}])

    result = cs.trace_source_file(['n1', 'n2', 'n3'], org_id='org-1')

    assert result['untraceable'] == ['n3']                     # 无 relation 行
    assert result['noPermission'] == ['n2']                    # 库不在可访问集合
    assert result['result'][0]['id'] == 'f1'
    assert result['result'][0]['nodeId'] == ['n1']
    assert result['result'][0]['downloadUrl'].endswith(
        '/knowledge-bases/kb1/documents/f1/content')


def test_trace_source_file_skips_directories_without_nodes(env, monkeypatch):
    import knowledge_base.repository.chunk as chunk_store
    import knowledge_base.repository.kbase as kbase_store
    import knowledge_base.repository.directory as directory_store

    relations = [{'id': 1, 'node_id': 'n1', 'kbase_id': 'kb1', 'directory_id': 'f1'}]
    monkeypatch.setattr(chunk_store, 'select_relations_by_node_ids',
                        lambda node_ids: relations)
    monkeypatch.setattr(kbase_store, 'select_all_kbases',
                        lambda org_id: [{'kbase_id': 'kb1'}])
    monkeypatch.setattr(directory_store, 'get_files_by_ids',
                        lambda ids, kbase_id=None: [
                            {'id': 'f1', 'kbase_id': 'kb1', 'title': 'a.md'},
                            {'id': 'f9', 'kbase_id': 'kb1', 'title': 'empty.md'}])

    result = cs.trace_source_file(['n1'])

    assert [item['id'] for item in result['result']] == ['f1']


def test_download_url_uses_http_prefix(env):
    assert cs.DOWNLOAD_URL.endswith('/knowledge-bases')
