"""文档处理入口层测试：``text_split_service`` / ``file_parse_service`` /
``graph_extract_service`` / ``graph_process`` / ``ingestion.runtime``。

不连 DB、不真跑沙箱：``segment_file`` / ``execute_function_in_sandbox`` /
``corpus.load_corpus_file`` / ``pg_manager`` 全部用桩替换。钉住各入口的分支与
错误通道（文案键异常、进度回写的 WHERE 约束、结果格式收敛）。
"""

import json
import logging
import os

import pytest
from parsing.exception import UnsupportedFormatError

from ingestion import runtime as ingestion_runtime
from ingestion.utility import self_operator
from ingestion.service.operator import (
    file_parse_service as file_parse_service,
    graph_extract_service as graph_extract_service,
    text_split_service as text_split_service,
)
from ingestion.service.operator.graph_extract_service import (
    UPDATE_FAIL_REASON_SQL,
    UPDATE_STATUS_SQL,
    _loggable_params,
    add_id_to_metadata,
    code_check as graph_code_check,
    deduplicate_metadata,
    extract_params as graph_extract_params,
    find_corpus_files,
    graph_extract_entry,
    handle_result,
    parse_corpus_content,
    parse_metadata_manually,
    process_corpus_file,
    process_single_corpus_file,
    save_processed_data,
    update_kbase_fail_reason,
    update_kbase_process,
)
from ingestion.service.operator.text_split_service import (
    code_check as split_code_check,
    text_split_entry,
)


def _tmp_file(tmp_path, name, content='hello'):
    path = tmp_path / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')
    return str(path)


# ---------------------------------------------------------------------------
# text_split_service
# ---------------------------------------------------------------------------

def test_text_split_ofd_is_rejected(tmp_path):
    clean = _tmp_file(tmp_path, 'doc.ofd')
    with pytest.raises(UnsupportedFormatError) as caught:
        text_split_entry({'cleanPath': clean, 'fileFormat': 'OFD', 'operatorId': -1,
                          'fileName': 'doc.ofd'})
    assert caught.value.message == 'RetCode.operator.split.unsupported'
    assert caught.value.source == 'OFD'


def test_text_split_system_operator_with_kbase(tmp_path, monkeypatch):
    clean = _tmp_file(tmp_path, 'doc.md')
    nodes = [{'nodeId': 'n1', 'text': 'a', 'metadata': {'source': 'doc.md', 'content_expand': 'a'}},
             {'nodeId': 'n2', 'text': 'a', 'metadata': {'source': 'doc.md', 'content_expand': 'a'}}]
    monkeypatch.setattr(text_split_service, 'segment_file', lambda *a, **kw: nodes)

    result = text_split_entry({
        'cleanPath': clean, 'fileFormat': 'md', 'operatorId': -1,
        'fileName': 'doc.md', 'kbaseId': 'kb-9',
        'args': [{'argName': 'maxWordCount', 'defaultValue': 512}],
    })
    assert len(result['chunks']) == 1
    assert {node['chunk_id'] for node in result['results']} == {result['chunks'][0]['id']}


def test_text_split_system_operator_preview(tmp_path, monkeypatch):
    clean = _tmp_file(tmp_path, 'doc.md')
    nodes = [{'nodeId': 'n1', 'text': 'a', 'metadata': {}}]
    monkeypatch.setattr(text_split_service, 'segment_file', lambda *a, **kw: nodes)
    result = text_split_entry({'cleanPath': clean, 'fileFormat': 'md', 'operatorId': -1,
                               'fileName': 'doc.md', 'kbaseId': 'kb-9', 'splitPreview': True})
    assert result == {'results': nodes}
    assert 'chunks' not in result


def test_text_split_system_operator_without_kbase(tmp_path, monkeypatch):
    clean = _tmp_file(tmp_path, 'doc.md')
    monkeypatch.setattr(text_split_service, 'segment_file',
                        lambda *a, **kw: [{'nodeId': 'n1', 'text': 'a', 'metadata': {}}])
    result = text_split_entry({'cleanPath': clean, 'fileFormat': 'md', 'operatorId': -2,
                               'fileName': 'doc.md'})
    assert 'chunks' not in result


def test_text_split_custom_operator_nodes(tmp_path, monkeypatch):
    clean = _tmp_file(tmp_path, 'doc.md')
    script = _tmp_file(tmp_path, 'file_split.py', 'def file_split():\n    return []\n')

    def fake_sandbox(script_path, function_name, **kwargs):
        assert function_name == 'file_split'
        assert kwargs['file_path'].endswith('doc.md')
        assert kwargs['format'] == 'md'
        return [{'content': '正文', 'metadata': {'source': 'doc.md'}}]

    monkeypatch.setattr(text_split_service, 'execute_function_in_sandbox', fake_sandbox)
    result = text_split_entry({
        'cleanPath': clean, 'fileFormat': 'md', 'operatorId': 7,
        'fileName': 'doc.md', 'pythonPath': script, 'kbaseId': 'kb-1',
    })
    assert result['results'][0]['text'] == '正文'
    assert result['chunks'][0]['source'] == 'doc.md'


def test_text_split_custom_operator_without_node_result(tmp_path, monkeypatch):
    clean = _tmp_file(tmp_path, 'doc.md')
    script = _tmp_file(tmp_path, 'file_split.py', 'def file_split():\n    return []\n')
    monkeypatch.setattr(text_split_service, 'execute_function_in_sandbox',
                        lambda *a, **kw: [{'content': 'x'}])
    result = text_split_entry({'cleanPath': clean, 'fileFormat': 'md', 'operatorId': 7,
                               'fileName': 'doc.md', 'pythonPath': script})
    assert result == {'results': [{'nodeId': result['results'][0]['nodeId'],
                                   'text': 'x', 'metadata': {}, 'embedding': None}]}


def test_split_code_check_runs_security_then_structure(tmp_path):
    script = _tmp_file(tmp_path, 'file_split.py',
                       "def file_split(file_path: str):\n    return []\n")
    split_code_check(script, {'file_path': 'str'})
    evil = _tmp_file(tmp_path, 'evil.py', "import os\nos.system('id')\n")
    with pytest.raises(Exception) as caught:
        split_code_check(evil, {})
    assert 'security check failed' in str(caught.value).lower()


def test_split_code_check_rejects_bad_signature(tmp_path):
    script = _tmp_file(tmp_path, 'file_split.py',
                       "def file_split(file_path: int):\n    return []\n")
    with pytest.raises(Exception) as caught:
        split_code_check(script, {'file_path': 'str'})
    assert 'Parameter validation error' in str(caught.value)


# ---------------------------------------------------------------------------
# file_parse_service
# ---------------------------------------------------------------------------

def test_file_parse_entry_string_cleans_with_regex(tmp_path, monkeypatch):
    clean = _tmp_file(tmp_path, 'doc.txt')
    script = _tmp_file(tmp_path, 'file_parse.py', 'def file_parse():\n    return ""\n')
    monkeypatch.setattr(file_parse_service, 'execute_function_in_sandbox',
                        lambda *a, **kw: '正文 [AD] 尾部')
    result = file_parse_service.file_parse_entry_string({
        'diskFileKey': clean, 'pythonPath': script, 'fileFormat': 'txt',
        'regexList': [r'\[AD\]'],
    })
    assert result == '正文  尾部'


def test_file_parse_entry_string_without_regex_list(tmp_path, monkeypatch):
    clean = _tmp_file(tmp_path, 'doc.txt')
    script = _tmp_file(tmp_path, 'file_parse.py', 'def file_parse():\n    return ""\n')
    monkeypatch.setattr(file_parse_service, 'execute_function_in_sandbox',
                        lambda *a, **kw: '原样保留')
    result = file_parse_service.file_parse_entry_string({
        'diskFileKey': clean, 'pythonPath': script, 'fileFormat': 'txt',
    })
    assert result == '原样保留'


def test_file_parse_entry_string_requires_str_result(tmp_path, monkeypatch):
    clean = _tmp_file(tmp_path, 'doc.txt')
    script = _tmp_file(tmp_path, 'file_parse.py', 'def file_parse():\n    return ""\n')
    monkeypatch.setattr(file_parse_service, 'execute_function_in_sandbox',
                        lambda *a, **kw: ['not a str'])
    with pytest.raises(Exception, match='result type is not str'):
        file_parse_service.file_parse_entry_string({
            'diskFileKey': clean, 'pythonPath': script, 'fileFormat': 'txt'})


def test_file_parse_entry_uploads_clean_file(tmp_path, monkeypatch):
    clean = _tmp_file(tmp_path, 'doc.txt')
    script = _tmp_file(tmp_path, 'file_parse.py', 'def file_parse():\n    return ""\n')
    uploaded = []
    monkeypatch.setattr(file_parse_service, 'execute_function_in_sandbox',
                        lambda *a, **kw: '清洗后文本')

    def fake_upload(source_file, emp):
        with open(source_file, encoding='utf-8') as f:
            # 临时目录随 with 块销毁，内容只能在这里读
            uploaded.append((f.read(), emp))
        return '/scratch/clean/x'

    monkeypatch.setattr(file_parse_service.disk_client, 'upload_clean_file', fake_upload)
    result = file_parse_service.file_parse_entry({
        'diskFileKey': clean, 'pythonPath': script, 'fileFormat': 'txt'})
    assert result == '/scratch/clean/x'
    assert uploaded == [('清洗后文本', 'admin')]


def test_file_parse_code_check(tmp_path):
    script = _tmp_file(
        tmp_path, 'file_parse.py',
        "def file_parse(file_path: str) -> str:\n    return file_path\n")
    file_parse_service.code_check(script, {'file_path': 'str'})


def test_clean_string_with_multiple_patterns():
    assert file_parse_service.clean_string_with_multiple_patterns('a1b2c', [r'\d']) == 'abc'
    assert file_parse_service.clean_string_with_multiple_patterns('abc', []) == 'abc'


# ---------------------------------------------------------------------------
# graph_extract_service：纯函数
# ---------------------------------------------------------------------------

def test_loggable_params_masks_api_key():
    params = {'kwargs': {'llmConfig': {'api_key': 'sk-secret', 'url': 'u'}}}
    masked = _loggable_params(params)
    assert masked['kwargs']['llmConfig']['api_key'] == '***'
    assert params['kwargs']['llmConfig']['api_key'] == 'sk-secret'  # 原参数不被修改
    assert _loggable_params('not-a-dict') == 'not-a-dict'
    assert _loggable_params({}) == {}
    assert _loggable_params({'kwargs': 'x'}) == {'kwargs': 'x'}
    assert _loggable_params({'kwargs': {'llmConfig': None}}) == {'kwargs': {'llmConfig': None}}
    assert _loggable_params({'kwargs': {'llmConfig': {'url': 'u'}}}) == \
        {'kwargs': {'llmConfig': {'url': 'u'}}}


def test_graph_extract_params_skips_incomplete_entries():
    assert graph_extract_params(None) == {}
    assert graph_extract_params([
        {'argName': 'a', 'defaultValue': '1'},
        {'argName': '', 'defaultValue': '2'},
        {'argName': 'b', 'defaultValue': None},
    ]) == {'a': '1'}


class _FakePG:
    def __init__(self, error=None):
        self.executed = []
        self.error = error

    def execute(self, sql, params=None, commit=True):
        self.executed.append((sql, params))
        if self.error is not None:
            raise self.error


class _FakePGManager:
    def __init__(self, client):
        self.client = client

    def get_pg_client(self):
        return self.client


class _TxLog:
    def __init__(self):
        self.errors = []

    def error(self, message):
        self.errors.append(message)

    def info(self, message):
        pass

    def debug(self, message):
        pass

    def warning(self, message):
        pass

    def exception(self, message):
        pass


def test_update_kbase_process_scoped_to_graph_kbases(monkeypatch):
    client = _FakePG()
    monkeypatch.setattr(graph_extract_service, 'pg_manager', _FakePGManager(client))
    update_kbase_process(_TxLog(), 'kb-1', 3, '42')
    sql, params = client.executed[0]
    assert (sql, params) == (UPDATE_STATUS_SQL, (3, '42', 'kb-1'))
    assert 'category = 10' in sql


def test_update_kbase_process_swallows_db_errors(monkeypatch):
    client = _FakePG(error=RuntimeError('db down'))
    txlog = _TxLog()
    monkeypatch.setattr(graph_extract_service, 'pg_manager', _FakePGManager(client))
    update_kbase_process(txlog, 'kb-1', 3, '1')
    assert '图提取更新进度失败' in txlog.errors[0]


def test_update_kbase_fail_reason_writes_i18n_object(monkeypatch):
    client = _FakePG()
    monkeypatch.setattr(graph_extract_service, 'pg_manager', _FakePGManager(client))
    update_kbase_fail_reason(_TxLog(), 'kb-1', '失败', 'failed')
    sql, params = client.executed[0]
    assert sql == UPDATE_FAIL_REASON_SQL
    assert json.loads(params[0]) == {'zh_CN': '失败', 'en_US': 'failed'}


def test_update_kbase_fail_reason_swallows_db_errors(monkeypatch):
    client = _FakePG(error=RuntimeError('db down'))
    txlog = _TxLog()
    monkeypatch.setattr(graph_extract_service, 'pg_manager', _FakePGManager(client))
    update_kbase_fail_reason(txlog, 'kb-1', '失败', 'failed')
    assert '图提取更新失败原因失败' in txlog.errors[0]


def test_handle_result_localizes_tip(monkeypatch):
    txlog = _TxLog()
    monkeypatch.setattr(graph_extract_service, 'update_kbase_fail_reason', lambda *a: None)
    assert handle_result(txlog, 'kb', 'zh_CN', {'code': '0', 'message': {'zh': '中', 'en': 'en'}}) == \
        ('0', '中')
    assert handle_result(txlog, 'kb', 'en_US', {'code': '0', 'message': {'zh': '中', 'en': 'en'}})[1] == 'en'
    # 非成功码且有 message → 回写失败原因
    calls = []
    monkeypatch.setattr(graph_extract_service, 'update_kbase_fail_reason',
                        lambda txlog, kb, zh, en: calls.append((zh, en)))
    code, tip = handle_result(txlog, 'kb', 'zh_CN', {'code': '-1', 'message': {'zh': '坏', 'en': 'bad'}})
    assert calls == [('坏', 'bad')]


def test_handle_result_tolerates_non_dict_message(monkeypatch):
    monkeypatch.setattr(graph_extract_service, 'update_kbase_fail_reason', lambda *a: None)
    code, tip = handle_result(_TxLog(), 'kb', 'zh_CN', {'code': '1', 'message': 'plain'})
    assert tip == 'plain'
    monkeypatch.setattr(graph_extract_service, 'update_kbase_fail_reason',
                        lambda *a: (_ for _ in ()).throw(RuntimeError('db')))
    code, tip = handle_result(_TxLog(), 'kb', 'zh_CN', {'code': '1', 'message': {'zh': 'x', 'en': 'y'}})
    assert tip == {'zh': 'x', 'en': 'y'}
    assert handle_result(_TxLog(), 'kb', 'zh_CN', {'code': '0'}) == ('0', '')


def test_graph_code_check(tmp_path):
    script = _tmp_file(
        tmp_path, 'graph_extract.py',
        "def graph_extract(**kwargs):\n    return {'code': '0'}\n")
    graph_code_check(script, {})


def test_find_corpus_files_recursive(tmp_path):
    (tmp_path / 'a' / 'b').mkdir(parents=True)
    (tmp_path / 'a' / 'b' / 'corpus_file.txt').write_text('x', encoding='utf-8')
    (tmp_path / 'other.txt').write_text('x', encoding='utf-8')
    found = find_corpus_files(str(tmp_path))
    assert len(found) == 1 and found[0].endswith('corpus_file.txt')


def test_parse_metadata_manually_json_then_python_literal():
    assert parse_metadata_manually('{"source": "a"}') == {'source': 'a'}
    assert parse_metadata_manually("{'source': 'a', 'content_expand': '# 表\\n列'}") == \
        {'source': 'a', 'content_expand': '# 表\n列'}
    assert parse_metadata_manually('not a dict at all') == {}
    # literal_eval 解析成功但不是 dict → 一样按「没解析出」处理
    assert parse_metadata_manually("'just a string'") == {}
    # JSON 路径不检查 dict：合法 JSON 直接返回（包括列表）
    assert parse_metadata_manually('[1, 2]') == [1, 2]
    assert parse_metadata_manually("'py str'") == {}


def test_parse_corpus_content_skips_bad_entries():
    content = (
        "metadata={\"source\": \"a\"}\n"
        "metadata={bad syntax here\n"
        "other=line\n"
        "metadata={'source': 'b'}\n"
    )
    parsed = parse_corpus_content(content)
    assert parsed == [{'source': 'a'}, {'source': 'b'}]


def test_deduplicate_metadata_keeps_first_occurrence():
    data = [{'source': 's', 'content_expand': 'x', 'keep': 1},
            {'source': 's', 'content_expand': 'x', 'keep': 2},
            {'source': 's', 'content_expand': 'y'}]
    assert deduplicate_metadata(data) == [data[0], data[2]]


def test_add_id_to_metadata_assigns_unique_ids():
    data = [{'source': 's'}, {'source': 't'}]
    add_id_to_metadata(data)
    assert data[0]['id'] != data[1]['id']
    assert all(len(item['id']) == 36 for item in data)


def test_save_processed_data_reraises_io_error(tmp_path):
    with pytest.raises(OSError):
        save_processed_data(str(tmp_path / 'missing-dir' / 'corpus_file.txt'), [])


def test_save_processed_data_writes_jsonl(tmp_path):
    path = tmp_path / 'corpus_file.txt'
    save_processed_data(str(path), [{'source': 'a'}, {'source': 'b'}])
    lines = (path.parent / 'document_chunk.jsonl').read_text(encoding='utf-8').splitlines()
    assert [json.loads(line) for line in lines] == [{'source': 'a'}, {'source': 'b'}]


def test_process_single_corpus_file_roundtrip(tmp_path):
    corpus = tmp_path / 'sub' / 'corpus_file.txt'
    corpus.parent.mkdir()
    corpus.write_text("metadata={'source': 'a', 'content_expand': 'dup'}\n"
                      "metadata={'source': 'a', 'content_expand': 'dup'}\n", encoding='utf-8')
    process_single_corpus_file(str(corpus))
    output = json.loads((corpus.parent / 'document_chunk.jsonl').read_text(encoding='utf-8'))
    assert output == {'source': 'a', 'content_expand': 'dup', 'id': output['id']}


def test_process_single_corpus_file_reraises(tmp_path):
    with pytest.raises(OSError):
        process_single_corpus_file(str(tmp_path / 'missing' / 'corpus_file.txt'))


def test_process_corpus_file_without_matches(tmp_path, caplog):
    with caplog.at_level(logging.WARNING):
        process_corpus_file(str(tmp_path), 'kb-1')
    assert '未找到corpus_file.txt文件' in caplog.text


def test_process_corpus_file_logs_and_swallows_errors(tmp_path, monkeypatch):
    # find_corpus_files 抛错：整层兜底记录，不上抛
    def boom(_dir):
        raise RuntimeError('glob failed')

    monkeypatch.setattr(graph_extract_service, 'find_corpus_files', boom)
    process_corpus_file(str(tmp_path), 'kb-1')

    # 单文件处理抛错：记日志后继续，不上抛
    monkeypatch.setattr(graph_extract_service, 'find_corpus_files',
                        lambda _dir: [str(tmp_path / 'c.txt')])
    monkeypatch.setattr(graph_extract_service, 'process_single_corpus_file', boom)
    process_corpus_file(str(tmp_path), 'kb-1')


# ---------------------------------------------------------------------------
# graph_extract_entry：端到端（全部外部依赖打桩）
# ---------------------------------------------------------------------------

def _graph_extract_info(tmp_path, **overrides):
    info = {
        'kbId': 'kb-graph-1',
        'diskFileKey': _tmp_file(tmp_path, 'input' + os.sep + 'doc.md', '正文'),
        'pythonPath': _tmp_file(tmp_path, 'graph_extract.py', 'def graph_extract():\n    return {}\n'),
        'kwargs': {'chunkSize': 2048, 'overlap': 128, 'minChunkSize': 256, 'maxChunkSize': 4096},
        'args': [{'argName': 'model', 'defaultValue': 'graph-model'}],
    }
    info.update(overrides)
    return info


def _stub_corpus_load(tmp_path, monkeypatch, corpus_content=None):
    calls = {}

    def fake_load(input_path, output_path, chunk_size, chunk_overlap, min_chunk_size,
                  max_chunk_size):
        calls['input'] = input_path
        calls['sizes'] = (chunk_size, chunk_overlap, min_chunk_size, max_chunk_size)
        os.makedirs(output_path, exist_ok=True)
        if corpus_content is not None:
            with open(os.path.join(output_path, 'corpus_file.txt'), 'w', encoding='utf-8') as f:
                f.write(corpus_content)

    monkeypatch.setattr(graph_extract_service.corpus, 'load_corpus_file', fake_load)
    return calls


def test_graph_extract_entry_success(tmp_path, monkeypatch):
    info = _graph_extract_info(tmp_path, kwargs={'txId': 'tx-1', 'chunkSize': 2048,
                                                 'overlap': 128, 'minChunkSize': 256,
                                                 'maxChunkSize': 4096})
    calls = _stub_corpus_load(tmp_path, monkeypatch, corpus_content="metadata={'source': 'a'}\n")
    sandbox_calls = {}

    def fake_sandbox(script_path, function_name, **params):
        sandbox_calls.update(params)
        return {'code': '0', 'message': {'zh': '完成', 'en': 'done'}}

    monkeypatch.setattr(self_operator, 'execute_function_in_sandbox', fake_sandbox)
    statuses = []
    monkeypatch.setattr(graph_extract_service, 'update_kbase_process',
                        lambda txlog, kb, status, process: statuses.append((status, process)))
    client = _FakePG()
    monkeypatch.setattr(graph_extract_service, 'pg_manager', _FakePGManager(client))

    result = graph_extract_entry(info, 'zh_CN')

    assert result == {'code': '0', 'message': '完成'}
    assert calls['sizes'] == (2048, 128, 256, 4096)
    # 进度：解析 20 → 100，抽图 1 → 100
    assert statuses == [(2, '20'), (2, '100'), (3, '1'), (3, '100')]
    # 算子参数：workspace 目录、语言、事务 ID、kb_id 收进 kwargs
    assert sandbox_calls['lang'] == 'zh_CN'
    assert sandbox_calls['transaction_id'] == 'tx-1'
    assert sandbox_calls['kwargs']['kb_id'] == 'kb-graph-1'
    assert sandbox_calls['model'] == 'graph-model'
    assert os.path.isdir(sandbox_calls['file_path'])
    # corpus_file.txt 已被处理成 document_chunk.jsonl
    jsonl = os.path.join(sandbox_calls['file_path'], 'document_chunk.jsonl')
    assert os.path.isfile(jsonl)


def test_graph_extract_entry_injects_kb_id_into_kwargs_arg(tmp_path, monkeypatch):
    """算子参数表里自带 ``kwargs``（dict）时，kb_id 注进这个 dict。"""
    info = _graph_extract_info(
        tmp_path, args=[{'argName': 'kwargs', 'defaultValue': {'model': 'm'}}])
    _stub_corpus_load(tmp_path, monkeypatch)
    captured = {}

    def fake_sandbox(_script, _fn, **params):
        captured.update(params)
        return {'code': '0', 'message': None}

    monkeypatch.setattr(self_operator, 'execute_function_in_sandbox', fake_sandbox)
    monkeypatch.setattr(graph_extract_service, 'update_kbase_process', lambda *a: None)
    assert graph_extract_entry(info, 'zh_CN')['code'] == '0'
    assert captured['kwargs'] == {'model': 'm', 'kb_id': 'kb-graph-1'}


def test_graph_extract_entry_default_chunk_sizes(tmp_path, monkeypatch):
    info = _graph_extract_info(tmp_path, kwargs=None)
    calls = _stub_corpus_load(tmp_path, monkeypatch)
    monkeypatch.setattr(self_operator, 'execute_function_in_sandbox',
                        lambda *a, **kw: {'code': '0', 'message': None})
    monkeypatch.setattr(graph_extract_service, 'update_kbase_process', lambda *a: None)
    graph_extract_entry(info, 'en_US')
    assert calls['sizes'] == (1024, 256, 512, 2048)


def test_graph_extract_entry_missing_paths(tmp_path, monkeypatch):
    _stub_corpus_load(tmp_path, monkeypatch)
    monkeypatch.setattr(graph_extract_service, 'update_kbase_process', lambda *a: None)
    statuses = []
    monkeypatch.setattr(graph_extract_service, 'update_kbase_process',
                        lambda txlog, kb, status, process: statuses.append(status))
    result = graph_extract_entry({'kbId': 'kb-1', 'diskFileKey': '', 'pythonPath': ''}, 'zh_CN')
    assert result['code'] == '-1'
    assert 'Failed to execute graph extract' in result['message']
    assert 103 in statuses


def test_graph_extract_entry_sandbox_failure_marks_kbase_failed(tmp_path, monkeypatch):
    info = _graph_extract_info(tmp_path)
    _stub_corpus_load(tmp_path, monkeypatch)

    def boom(*a, **kw):
        raise RuntimeError('gateway down')

    monkeypatch.setattr(self_operator, 'execute_function_in_sandbox', boom)
    monkeypatch.setattr(graph_extract_service, 'update_kbase_process', lambda *a: None)
    client = _FakePG()
    monkeypatch.setattr(graph_extract_service, 'pg_manager', _FakePGManager(client))

    result = graph_extract_entry(info, 'zh_CN')
    assert result['code'] == '-1'
    assert 'gateway down' in result['message']
    # 失败原因按 category=10 图谱库写回
    assert any(sql == UPDATE_FAIL_REASON_SQL for sql, _params in client.executed)


# ---------------------------------------------------------------------------
# graph_process
# ---------------------------------------------------------------------------

def test_graph_process_updates_progress(tmp_path, monkeypatch):
    from ingestion.client import graph_process as graph_process_module
    from ingestion.client.graph_process import GraphProcess

    client = _FakePG()
    monkeypatch.setattr(graph_process_module, 'pg_manager', _FakePGManager(client))
    GraphProcess('tx-1').update_kbase_process('kb-1', '30', '正在处理', 'processing')
    sql, params = client.executed[0]
    assert sql == 'UPDATE kb_kbase SET process = %s, process_obj = %s WHERE kbase_id = %s'
    assert params == ('30', json.dumps({'zh_CN': '正在处理', 'en_US': 'processing'}), 'kb-1')


def test_graph_process_swallows_db_errors(monkeypatch, caplog):
    from ingestion.client import graph_process as graph_process_module
    from ingestion.client.graph_process import GraphProcess

    client = _FakePG(error=RuntimeError('db down'))
    monkeypatch.setattr(graph_process_module, 'pg_manager', _FakePGManager(client))
    GraphProcess(None).update_kbase_process('kb-1', '30', 'zh', 'en')
    assert any('图提取更新进度失败' in rec.getMessage() for rec in caplog.records)


# ---------------------------------------------------------------------------
# ingestion.runtime：入口分发与大文件闸门
# ---------------------------------------------------------------------------

def _patch_entries(monkeypatch, results=None):
    calls = []

    def _stub(name):
        def fake(*args, **kwargs):
            calls.append((name,) + args)
            if results and name in results and results[name] is not None:
                return results[name]
            return 'ok'

        return fake

    monkeypatch.setattr(ingestion_runtime.FileParseService, 'file_parse_entry', _stub('parse'))
    monkeypatch.setattr(ingestion_runtime.FileParseService, 'file_parse_entry_string',
                        _stub('parse_preview'))
    monkeypatch.setattr(ingestion_runtime.TextSplitService, 'text_split_entry', _stub('split'))
    monkeypatch.setattr(ingestion_runtime.GraphExtractService, 'graph_extract_entry',
                        _stub('graph'))
    monkeypatch.setattr(ingestion_runtime.FileParseService, 'code_check', _stub('cc_parse'))
    monkeypatch.setattr(ingestion_runtime.TextSplitService, 'code_check', _stub('cc_split'))
    return calls


def test_runtime_delegates_small_files_and_wrappers(monkeypatch):
    calls = _patch_entries(monkeypatch)
    assert ingestion_runtime.file_parse({'a': 1}) == 'ok'
    assert ingestion_runtime.file_parse_preview({'a': 1}) == 'ok'
    assert ingestion_runtime.text_split({'a': 1, 'fileSize': 10}) == 'ok'
    assert ingestion_runtime.graph_extract({'kbId': 'kb'}, 'en_US') == 'ok'
    assert ingestion_runtime.code_check_file_parse('/p', {}) == 'ok'
    assert ingestion_runtime.code_check_text_split('/p', {}) == 'ok'
    assert {call[0] for call in calls} == {'parse', 'parse_preview', 'split', 'graph',
                                           'cc_parse', 'cc_split'}


def test_runtime_large_file_goes_through_lock(monkeypatch):
    calls = _patch_entries(monkeypatch)
    monkeypatch.setattr(ingestion_runtime, 'LARGE_FILE_SIZE_LIMIT', 10)
    assert ingestion_runtime.text_split({'fileSize': 100}) == 'ok'
    assert calls[-1][0] == 'split'


def test_runtime_large_file_reraises_real_error(monkeypatch):
    _patch_entries(monkeypatch)

    def boom(_info):
        raise ValueError('RetCode.operator.split.empty')

    monkeypatch.setattr(ingestion_runtime.TextSplitService, 'text_split_entry', boom)
    monkeypatch.setattr(ingestion_runtime, 'LARGE_FILE_SIZE_LIMIT', 10)
    # 闸门内的真实失败原样上抛，不折成「文件太大」
    with pytest.raises(ValueError, match='RetCode.operator.split.empty'):
        ingestion_runtime.text_split({'fileSize': 100})


def test_runtime_large_file_busy_after_timeout(monkeypatch):
    class BusyLock:
        def acquire(self, timeout=None):
            return False

        def release(self):
            raise AssertionError('不应释放未持有的锁')

    monkeypatch.setattr(ingestion_runtime, '_large_file_lock', BusyLock())
    monkeypatch.setattr(ingestion_runtime, 'LARGE_FILE_SIZE_LIMIT', 10)
    with pytest.raises(ingestion_runtime.OperatorBusyError) as caught:
        ingestion_runtime.text_split({'fileSize': 100})
    error = caught.value
    assert (error.code, error.bo, error.message) == ('0001', None, 'RetCode.file.size.more')
    assert 'OperatorBusyError' in str(error)


def test_system_operator_manifest_file_exists():
    assert os.path.isfile(ingestion_runtime.SYSTEM_OPERATOR_FILE)
    with open(ingestion_runtime.SYSTEM_OPERATOR_FILE, encoding='utf-8') as f:
        operators = json.load(f)
    assert {item['id'] for item in operators} == {-1, -2}
