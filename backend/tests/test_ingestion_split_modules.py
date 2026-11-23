"""切分管线的纯逻辑层测试（``ingestion/split``）。

不真起沙箱：``segment_file`` 的 ``execute_operator_module`` 用桩替换，
只钉住注册表查找、格式改写复制、预览分支与 kbase 校验；其余是
``node_transfer`` / ``result_convert`` 的纯函数行为。
"""

import os

import pytest

from ingestion.split import node_transfer, result_convert, system_split_manager
from ingestion.split.node_transfer import (
    LCDocument,
    _safe_int,
    build_node,
    identify_duplicate_chunks,
    parse_md_to_nodes,
    rewrite_source_metadata,
)
from ingestion.split.result_convert import result_convert
from ingestion.split.system_split_manager import (
    _operator_module_path,
    _service_root,
    find_operator_by_id,
    find_operator_module_by_id,
    segment_file,
)


# ---------------------------------------------------------------------------
# 注册表
# ---------------------------------------------------------------------------

def test_operator_registry_lookup():
    operator = find_operator_by_id(-1)
    assert operator['operator_module'] == 'operators/text_split'
    assert operator['operator_function'] == 'file_split_with_chunk'
    assert find_operator_by_id(-2)['operator_function'] == 'file_split'
    assert find_operator_by_id(12345) is None


def test_operator_module_lookup():
    assert find_operator_module_by_id(-1) == 'operators/text_split'
    assert find_operator_module_by_id(999) is None


def test_service_root_is_import_root():
    import ingestion
    assert _service_root() == os.path.dirname(os.path.dirname(os.path.abspath(ingestion.__file__)))


def test_operator_module_path_resolves_entry_file():
    path = _operator_module_path('operators/text_split')
    assert path.endswith(os.path.join('operators', 'text_split', 'main.py'))
    assert os.path.isfile(path)


def test_operator_module_path_missing_raises():
    with pytest.raises(ValueError) as caught:
        _operator_module_path('operators/does_not_exist')
    assert 'System operator module not found' in str(caught.value)


# ---------------------------------------------------------------------------
# segment_file
# ---------------------------------------------------------------------------

class _StubDocs:
    """最小可用的 docs 列表元素（parse_md_to_nodes 只认 page_content/metadata）。"""

    @staticmethod
    def build(text, metadata=None):
        return LCDocument(text, metadata or {})


def _stub_execute(monkeypatch, capture=None):
    def fake(module_path, function_name, **kwargs):
        if capture is not None:
            capture.append((module_path, function_name, kwargs))
        return [LCDocument('第一段', {'source': 'original.md'})]

    monkeypatch.setattr(system_split_manager, 'execute_operator_module', fake)


def test_segment_file_unknown_category():
    with pytest.raises(ValueError, match='Unknown category'):
        segment_file('/tmp/x.md', 12345, False)


def test_segment_file_without_operator_module(monkeypatch):
    monkeypatch.setattr(system_split_manager, 'find_operator_by_id', lambda _id: {'id': -9})
    with pytest.raises(ValueError, match='has no operator_module'):
        segment_file('/tmp/x.md', -9, False)


def test_segment_file_same_format_keeps_path(monkeypatch, tmp_path):
    source_file = tmp_path / 'doc.md'
    source_file.write_text('# t', encoding='utf-8')
    captured = []
    _stub_execute(monkeypatch, captured)

    nodes = segment_file(str(source_file), -1, False, format='md', kbase_id='kb-1')

    module_path, function_name, kwargs = captured[0]
    assert function_name == 'file_split_with_chunk'
    assert kwargs['file_path'] == str(source_file)
    # 受控上下文（emp_no/kbase_id/format）不作为算子 kwargs 传入
    assert 'kbase_id' not in kwargs and 'format' not in kwargs
    # 格式匹配 → 不改写 source 元数据
    assert nodes[0]['metadata']['source'] == 'original.md'


def test_segment_file_rewrites_mismatched_format(monkeypatch, tmp_path):
    source_file = tmp_path / 'doc.md'
    source_file.write_text('# t', encoding='utf-8')
    captured = []
    _stub_execute(monkeypatch, captured)

    segment_file(str(source_file), -2, False, format='txt', kbase_id='kb-1')

    module_path, function_name, kwargs = captured[0]
    assert function_name == 'file_split'
    assert kwargs['file_path'].endswith('.txt')
    assert os.path.isfile(kwargs['file_path'])  # 已按新扩展名复制了一份


def test_segment_file_rewrites_source_metadata_for_copied_file(monkeypatch, tmp_path):
    source_file = tmp_path / 'doc.md'
    source_file.write_text('# t', encoding='utf-8')
    _stub_execute(monkeypatch)

    nodes = segment_file(str(source_file), -2, False, format='txt', kbase_id='kb-1')
    # 复制出去的文件名与原 doc_name 不同 → 用 doc_name 重写 source
    assert nodes[0]['metadata']['source'] == 'doc.md'


def test_segment_file_preview_skips_kbase_check(monkeypatch, tmp_path):
    source_file = tmp_path / 'doc.md'
    source_file.write_text('# t', encoding='utf-8')
    _stub_execute(monkeypatch)

    nodes = segment_file(str(source_file), -1, True, format='md', kbase_id=None)
    assert nodes[0]['text'] == '第一段'


def test_segment_file_requires_kbase_id_outside_preview(monkeypatch, tmp_path):
    source_file = tmp_path / 'doc.md'
    source_file.write_text('# t', encoding='utf-8')
    _stub_execute(monkeypatch)

    with pytest.raises(ValueError, match='Unknown kbase_id'):
        segment_file(str(source_file), -1, False, format='md', kbase_id=None)


# ---------------------------------------------------------------------------
# node_transfer
# ---------------------------------------------------------------------------

def test_rewrite_source_metadata_handles_missing_metadata():
    docs = [LCDocument('a', None), LCDocument('b', {'source': 'old', 'keep': 1})]
    rewritten = rewrite_source_metadata(docs, 'new.md')
    assert rewritten[0].metadata == {'source': 'new.md'}
    assert rewritten[1].metadata == {'source': 'new.md', 'keep': 1}
    assert docs[0].metadata is None  # 原 docs 不被修改


def test_parse_md_to_nodes_builds_nodes():
    docs = [LCDocument('chunk-1', {'source': 'a.md'})]
    nodes = parse_md_to_nodes(docs)
    assert len(nodes) == 1
    assert nodes[0]['nodeId']
    assert nodes[0]['text'] == 'chunk-1'
    assert nodes[0]['metadata'] == {'source': 'a.md'}
    assert nodes[0]['embedding'] is None
    assert build_node(LCDocument('x', {}))['nodeId']


@pytest.mark.parametrize('value, expected', [
    (None, None),
    (7, 7),
    (True, True),
    ('3,4', 3),
    (' 3 ,4', 3),
    ('abc', None),
    ('', None),
    (2.7, 2),
    (object(), None),
])
def test_safe_int(value, expected):
    assert _safe_int(value) == expected


def _nodes(*texts_and_meta):
    nodes = []
    for text, metadata in texts_and_meta:
        nodes.append({'nodeId': 'n', 'text': text, 'metadata': metadata})
    return nodes


def test_identify_duplicate_chunks_dedups_by_content_expand():
    nodes = _nodes(
        ('a', {'source': 'f.md', 'content_expand': 'same', 'chunk_index': 3}),
        ('a-different-text', {'source': 'f.md', 'content_expand': 'same', 'chunk_index': 1}),
        ('b', {'source': 'f.md', 'content_expand': 'other', 'chunk_index': 2}),
    )
    result, chunks = identify_duplicate_chunks(nodes, 'kb-1', 'f.md')
    assert len(result) == 3
    assert result[0]['chunk_id'] == result[1]['chunk_id']
    assert result[2]['chunk_id'] != result[0]['chunk_id']
    assert len(chunks) == 2
    assert all(chunk['kbId'] == 'kb-1' for chunk in chunks)
    # chunk 表 text 用 content_expand（完整上下文语义）
    assert {chunk['text'] for chunk in chunks} == {'same', 'other'}
    assert chunks[0]['chunkOrder'] == 3


def test_identify_duplicate_chunks_falls_back_to_text():
    nodes = _nodes(
        ('dup', {'source': 'f.md'}),
        ('dup', {'source': 'f.md'}),
        ('unique', {'source': 'f.md'}),
    )
    result, chunks = identify_duplicate_chunks(nodes, 'kb-1')
    assert len(result) == 3
    assert len(chunks) == 2
    assert chunks[0]['text'] == 'dup'
    # 未传 source → 回落到 metadata.source
    assert chunks[0]['source'] == 'f.md'
    assert chunks[0]['chunkOrder'] is None


def test_identify_duplicate_chunks_chunk_order_and_labels():
    nodes = _nodes(
        ('t', {'source': 'f', 'chunk_order': '5', 'spilt_type': 'para',
               'label': 'L', 'table_name': 'tn', 'table_id': 'ti'}),
    )
    _, chunks = identify_duplicate_chunks(nodes, 'kb-1')
    assert chunks[0]['chunkOrder'] == 5
    assert chunks[0]['spiltType'] == 'para'
    assert chunks[0]['label'] == 'L'
    assert chunks[0]['tableName'] == 'tn'
    assert chunks[0]['tableId'] == 'ti'


def test_identify_duplicate_chunks_handles_missing_metadata():
    nodes = [{'nodeId': 'n', 'text': 't'}]
    result, chunks = identify_duplicate_chunks(nodes, 'kb-1')
    assert result[0]['metadata'] == {}
    assert len(chunks) == 1
    # split_type / split_type 两种拼写都认
    nodes = [{'nodeId': 'n', 'text': 't', 'metadata': {'split_type': 'fixed'}}]
    _, chunks = identify_duplicate_chunks(nodes, 'kb-1')
    assert chunks[0]['spiltType'] == 'fixed'


# ---------------------------------------------------------------------------
# result_convert
# ---------------------------------------------------------------------------

def test_result_convert_maps_content_to_nodes():
    nodes = result_convert([{'content': '正文', 'metadata': {'source': 'a.md'}},
                            {'content': 'b'}])
    assert nodes[0]['text'] == '正文'
    assert nodes[0]['metadata'] == {'source': 'a.md'}
    assert nodes[1]['metadata'] == {}
    assert all(node['nodeId'] for node in nodes)


def test_result_convert_empty_list():
    assert result_convert([]) == []
