"""``knowledge_base.task.handlers``：解析 → 切分 → 向量化三段 handler。

不连库：materialize / 算子运行时 / 状态回写 / 三写全部用桩。

跑法（服务目录下）::

    python -m pytest tests/test_kb_task_handlers.py -q
"""

from __future__ import annotations

import pytest

from knowledge_base.task import handlers as handlers_module
from knowledge_base.task import operator_runtime
from knowledge_base.task.handlers import (
    FileEmbeddingHandler,
    FileParseHandler,
    FileSplitHandler,
    _fail_reason,
    _format_suffix,
    _kbase_row,
    _normalized_operator_id,
    _with_default_split_args,
)


@pytest.fixture()
def env(monkeypatch):
    env = {
        'materialized': [],
        'statuses': [],
        'calls': [],
        'parse': None,
    }

    import knowledge_base.repository.chunk as chunk_store
    import knowledge_base.repository.directory as directory_store
    import knowledge_base.repository.kbase as kbase_store
    import knowledge_base.repository.node_relation as relation_store
    import retrieval.service.write as write_service
    from model import gateway as model_gateway

    def fake_materialize(ref, suffix=''):
        env['materialized'].append((ref, suffix))
        return f'/tmp/materialized{suffix}', True           # 返回临时文件 → 要清理

    monkeypatch.setattr(handlers_module.storage, 'materialize_ref', fake_materialize)

    def update_status(cursor, file_id, status, reason=None):
        env['statuses'].append((file_id, status, reason))

    class _C:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return self

    monkeypatch.setattr(directory_store, 'connection', lambda: _C())
    monkeypatch.setattr(directory_store, 'update_file_status', update_status)
    monkeypatch.setattr(directory_store, 'operator_python_path',
                        lambda operator_id: f'/ops/{operator_id}.py')

    def fake_parse(operator_id, args, python_path, file_format, regex_list, key):
        env['calls'].append(('parse', operator_id, python_path, file_format, key))
        return '/tmp/clean.md'

    def fake_split(operator_id, args, python_path, file_format, clean_path,
                   file_name, file_size, kbase_id):
        env['calls'].append(('split', operator_id, python_path))
        return {'results': env.get('results', []), 'chunks': env.get('chunks', [])}

    monkeypatch.setattr(operator_runtime, 'file_parse', fake_parse)
    monkeypatch.setattr(operator_runtime, 'text_split', fake_split)

    row = {'id': 5, 'kbase_id': 'kb1', 'table_name': 'doc_kb1_vector'}
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id',
                        lambda kbase_id: row if kbase_id == 'kb1' else None)

    monkeypatch.setattr(write_service, 'save_chunks',
                        lambda chunk_table, chunks:
                        env['calls'].append(('save_chunks', chunk_table)))
    monkeypatch.setattr(write_service, 'save_vectors',
                        lambda table, rows: env['calls'].append(('save_vectors', table)))
    monkeypatch.setattr(write_service, 'save_es_documents',
                        lambda kbase_id, file_id, docs:
                        env['calls'].append(('es_save', docs)))
    monkeypatch.setattr(write_service, 'delete_es_documents_by_query',
                        lambda kbase_id, field, values:
                        env['calls'].append(('es_delete', field, list(values))))
    monkeypatch.setattr(write_service, 'build_metadata',
                        lambda metadata, chunk_id: dict(metadata, chunk_id=chunk_id))
    monkeypatch.setattr(relation_store, 'batch_insert_relations',
                        lambda kbase_id, file_id, node_ids:
                        env['calls'].append(('relations', list(node_ids))))
    monkeypatch.setattr(chunk_store, 'delete_chunk_by_id',
                        lambda kbase, chunk_id:
                        env['calls'].append(('delete_chunk', chunk_id)))
    monkeypatch.setattr(model_gateway, 'embed_many',
                        lambda texts, model: env.get('vectors', []))
    return env


# ----------------------------------------------------------------------
# 小工具
# ----------------------------------------------------------------------


def test_format_suffix():
    assert _format_suffix('md') == '.md'
    assert _format_suffix(None) == ''
    assert _format_suffix('  ') == ''


@pytest.mark.parametrize('value, expected', [
    (None, None),
    ('', None),
    ('   ', None),
    ('3', 3),
    (3, 3),
    (1.9, 1),
])
def test_normalized_operator_id(value, expected):
    assert _normalized_operator_id(value) == expected


def test_normalized_operator_id_rejects_non_numeric_strings():

    with pytest.raises(Exception):
        _normalized_operator_id('abc')


def test_with_default_split_args_injects_defaults():
    merged = _with_default_split_args([{'argName': 'maxWordCount', 'defaultValue': 512}],
                                      'kb1')

    assert merged[0]['argName'] == 'maxWordCount'
    assert {'argName': 'emp_no', 'argType': 'str', 'defaultValue': 'test'} in merged
    assert {'argName': 'kbase_id', 'argType': 'str', 'defaultValue': 'kb1'} in merged

    assert _with_default_split_args(None, 'kb1')               # args 为空 → 建空表再注入


def test_kbase_row_missing_raises(monkeypatch):
    import knowledge_base.repository.kbase as kbase_store
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: None)

    with pytest.raises(LookupError):
        _kbase_row('ghost')


def test_fail_reason_variants():
    from model.gateway import EmbeddingError
    from shared.errors.api import KbApiError

    class _Cancelled(Exception):
        pass

    from infrastructure.tasks.cancellation import TaskCancelled

    assert _fail_reason(TaskCancelled()) == 'Task cancelled'
    assert _fail_reason(KbApiError('kbase.not.exist')) == 'kbase.not.exist'
    assert _fail_reason(EmbeddingError('dim')) == 'RetCode.file.embedding.error'
    assert _fail_reason(ValueError('x')) == 'RetCode.database.updateOrInsertException'


# ----------------------------------------------------------------------
# FileParseHandler
# ----------------------------------------------------------------------


def test_parse_handler_passthrough_without_dto(env):
    handle = {'fileId': 'f1', 'diskPath': '/tmp/a.md', 'format': 'md'}

    FileParseHandler().handle(handle)

    assert handle['cleanPath'].startswith('/tmp/materialized')  # 直通：只物化
    assert env['statuses'] == []                               # 不推状态
    assert handle['_materialized_files']                       # 临时文件记录在案


def test_parse_handler_calls_operator_and_advances_status(env):
    handle = {'fileId': 'f1', 'diskPath': '/tmp/a.md', 'format': 'pdf',
              'regexList': ['a+'],
              'operatorParseDTO': {'operatorId': 7, 'args': []}}

    FileParseHandler().handle(handle)

    assert handle['cleanPath'] == '/tmp/clean.md'
    assert handle['format'] == 'md'                            # 清洗后一律 md
    assert env['calls'][0] == ('parse', 7, '/ops/7.py', 'pdf', '/tmp/materialized.pdf')
    assert env['statuses'] == [('f1', handlers_module.STATUS_PARSE_DONE, None)]


def test_parse_handler_failure_marks_failed_and_reraises(env, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError('operator down')

    monkeypatch.setattr(operator_runtime, 'file_parse', boom)
    handle = {'fileId': 'f1', 'diskPath': '/tmp/a.md', 'format': 'md',
              'operatorParseDTO': {'operatorId': 7}}

    with pytest.raises(RuntimeError):
        FileParseHandler().handle(handle)

    assert env['statuses'] == [('f1', 2, 'RetCode.database.updateOrInsertException')]


def test_parse_handler_rollback_is_noop(env):
    FileParseHandler().rollback({'fileId': 'f1'})              # 不抛


# ----------------------------------------------------------------------
# FileSplitHandler
# ----------------------------------------------------------------------


def test_split_handler_positive_operator_id_uses_python_path(env):
    handle = {'fileId': 'f1', 'cleanPath': '/tmp/c.md', 'format': 'md',
              'fileName': 'a.md', 'fileSize': 10, 'kbaseId': 'kb1',
              'operatorSplitDTO': {'operatorId': 9, 'args': []}}

    FileSplitHandler().handle(handle)

    assert env['calls'][0] == ('split', 9, '/ops/9.py')
    assert env['statuses'] == [('f1', handlers_module.STATUS_SPLIT_DONE, None)]
    assert handle['splitResult'] == {'results': [], 'chunks': []}


def test_split_handler_negative_or_missing_operator_gets_defaults(env):
    for dto in ({'operatorId': -1, 'args': []}, {'operatorId': ''},
                {'operatorId': None}, {}):
        env['calls'].clear()
        handle = {'fileId': 'f1', 'cleanPath': '/tmp/c.md', 'format': 'md',
                  'fileName': 'a.md', 'fileSize': 10, 'kbaseId': 'kb1',
                  'operatorSplitDTO': dict(dto)}

        FileSplitHandler().handle(handle)

        call = env['calls'][0]
        assert call[1] in (-1, None)
        handle.get('_injected') or True
        assert handle['splitResult'] == {'results': [], 'chunks': []}

    # 注入参数落到 text_split 的 args（None / '' 走同一支）
    seen = {}

    def fake_split(operator_id, args, python_path, file_format, clean_path,
                   file_name, file_size, kbase_id):
        seen['args'] = args
        return {'results': [], 'chunks': []}

    import knowledge_base.task.operator_runtime as ort
    ort.text_split = fake_split
    handle = {'fileId': 'f1', 'cleanPath': '/tmp/c.md', 'format': 'md',
              'fileName': 'a.md', 'fileSize': 10, 'kbaseId': 'kb1',
              'operatorSplitDTO': {'operatorId': None}}
    FileSplitHandler().handle(handle)

    names = [arg['argName'] for arg in seen['args']]
    assert 'emp_no' in names and 'kbase_id' in names


def test_split_handler_invalid_operator_id_fails_file(env):
    handle = {'fileId': 'f1', 'cleanPath': '/tmp/c.md', 'format': 'md',
              'fileName': 'a.md', 'fileSize': 10, 'kbaseId': 'kb1',
              'operatorSplitDTO': {'operatorId': 'abc'}}

    with pytest.raises(Exception):
        FileSplitHandler().handle(handle)

    assert env['statuses'][0][1] == 2


# ----------------------------------------------------------------------
# FileEmbeddingHandler
# ----------------------------------------------------------------------


def _embedding_handle(results=None, chunks=None):
    return {'fileId': 'f1', 'kbaseId': 'kb1', 'modelName': 'bge',
            'splitResult': {'results': results or [], 'chunks': chunks or []}}


def test_embedding_handler_without_split_result_is_noop(env):
    FileEmbeddingHandler().handle({'fileId': 'f1', 'kbaseId': 'kb1'})

    assert env['statuses'] == [] and env['calls'] == []


def test_embedding_handler_three_writes(env):
    env['results'] = [{'nodeId': 'n1', 'text': '正文', 'chunk_id': 'c1',
                       'metadata': {'type': 1}}]
    env['chunks'] = [{'id': 'c1', 'source': 'a.md'}]
    env['vectors'] = [[0.5, 0.5]]

    FileEmbeddingHandler().handle(_embedding_handle(env['results'], env['chunks']))

    kinds = [call[0] for call in env['calls']]
    assert kinds == ['save_chunks', 'relations', 'save_vectors', 'es_save']
    assert env['calls'][0][1] == 'doc_kb1_chunk'
    assert env['statuses'] == [('f1', handlers_module.STATUS_EMBEDDING_DONE, None)]
    assert env['results'][0]['embedding'] == [0.5, 0.5]


def test_embedding_handler_batches_by_size(env, monkeypatch):
    env['results'] = [{'nodeId': f'n{i}', 'text': 't', 'chunk_id': f'c{i}',
                       'metadata': {}} for i in range(3)]
    env['vectors'] = [[0.1]]
    seen_batches = []

    def fake_persist(kbase_id, file_id, pk_id, table_name, nodes, chunks):
        seen_batches.append(len(nodes))

    monkeypatch.setattr(handlers_module, '_persist_index_nodes', fake_persist)
    monkeypatch.setattr(handlers_module, 'EMBEDDING_BATCH_SIZE', 2)

    FileEmbeddingHandler().handle(_embedding_handle(env['results'], []))

    assert seen_batches == [2, 1]


def test_embedding_handler_checks_cancellation_per_batch(env, monkeypatch):
    from infrastructure.tasks import cancellation

    env['results'] = [{'nodeId': 'n1', 'text': 't', 'chunk_id': 'c1', 'metadata': {}}]
    env['vectors'] = [[0.1]]
    calls = []

    def raise_cancelled():
        calls.append(1)
        raise cancellation.TaskCancelled('cancelled')

    monkeypatch.setattr(cancellation, 'raise_if_cancelled', raise_cancelled)

    with pytest.raises(Exception):
        FileEmbeddingHandler().handle(_embedding_handle(env['results'], []))

    assert env['statuses'] == [('f1', 2, 'Task cancelled')]


def test_embedding_handler_failure_marks_failed(env, monkeypatch):
    import retrieval.service.write as write_service

    def boom(chunk_table, chunks):
        raise RuntimeError('chunk table missing')

    monkeypatch.setattr(write_service, 'save_chunks', boom)

    with pytest.raises(RuntimeError):
        FileEmbeddingHandler().handle(_embedding_handle([], []))

    assert env['statuses'] == [('f1', 2, 'RetCode.database.updateOrInsertException')]


def test_embedding_handler_rollback_cleans_three_stores(env, monkeypatch):
    import knowledge_base.repository.node_relation as relation_store

    def broken_relation(pk_id, ids):
        raise RuntimeError('db down')

    monkeypatch.setattr(relation_store, 'delete_by_directory_ids', broken_relation)

    handle = _embedding_handle(chunks=[{'id': 'c1'}, {'id': None}])

    FileEmbeddingHandler().rollback(handle)                    # 关系失败不阻断

    kinds = [call[0] for call in env['calls']]
    assert 'delete_chunk' in kinds and 'es_delete' in kinds
    # 只有带 id 的 chunk 会被删
    assert [call[1] for call in env['calls'] if call[0] == 'delete_chunk'] == ['c1']


def test_embedding_handler_rollback_swallows_all_errors(env, monkeypatch):
    import knowledge_base.repository.chunk as chunk_store
    import knowledge_base.repository.node_relation as relation_store
    import retrieval.service.write as write_service
    import knowledge_base.repository.kbase as kbase_store

    def boom(*args, **kwargs):
        raise RuntimeError('down')

    monkeypatch.setattr(relation_store, 'delete_by_directory_ids', boom)
    monkeypatch.setattr(chunk_store, 'delete_chunk_by_id', boom)
    monkeypatch.setattr(write_service, 'delete_es_documents_by_query', boom)
    # kbase 查不到 → rollback 内部抛 LookupError，同样被吞掉
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: None)

    FileEmbeddingHandler().rollback(_embedding_handle(chunks=[{'id': 'c1'}]))


def test_persist_index_nodes_builds_rows(env):
    nodes = [{'nodeId': 'n1', 'text': '正文', 'chunk_id': 'c1', 'metadata': {'type': 1}},
             {'nodeId': 'n2', 'text': None, 'chunk_id': 'missing', 'metadata': {}}]
    chunks = [{'id': 'c1', 'source': 'a.md'}]

    FileEmbeddingHandler().handle(_embedding_handle(nodes, chunks))

    es_docs = [call[1] for call in env['calls'] if call[0] == 'es_save'][0]
    assert es_docs[0]['metadata']['source'] == 'a.md'          # 缺省补 source
    assert es_docs[1]['metadata'].get('source') is None        # chunk 找不到 → 不补
