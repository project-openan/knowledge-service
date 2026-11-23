"""parsing 切分与公共工具的剩余分支（纯函数路径 + 临时目录，零外部依赖）。

work_dir 统一打到 ``tmp_path``：切片产物不再写进源码树。
"""

import logging

import pytest

from infrastructure.config import settings as infra_settings
from parsing import block_splitter as bs
from parsing import corpus
from parsing import split_common
from parsing import splitter
from parsing.common import create_doc
from parsing.common import logutil as parsing_logutil
from parsing.common import pathutil
from parsing.common import profile
from parsing.common import special_filter
from parsing.common import special_filter_docx
from parsing.common.decode_tool import detect_encoding
from parsing.common.sentence_add_validator import SentenceValidator
from parsing.exception import (ParseCorruptError, ParseEmptyError,
                               SensitiveMsgException, UnsupportedFormatError)
from parsing.sensitive import (DefaultSensitiveWordChecker,
                               LocalSensitiveWordChecker, SensitiveWordChecker)


@pytest.fixture(autouse=True)
def _work_dir(monkeypatch, tmp_path):
    monkeypatch.setitem(infra_settings.Config, 'work_dir', str(tmp_path))
    return tmp_path


# ---------------------------------------------------------------------------
# splitter
# ---------------------------------------------------------------------------

def test_is_cjk_char_and_separator_length():
    assert splitter.is_cjk_char('中') is True
    assert splitter.is_cjk_char('。') is True
    assert splitter.is_cjk_char('a') is False
    assert splitter.is_cjk_char('') is False
    assert splitter.separator_length('。', '中') == 0
    assert splitter.separator_length('a', '中') == 0
    assert splitter.separator_length('a', 'b') == 1
    assert splitter.separator_length('', 'b') == 0


def test_hard_split_text_edges():
    assert splitter.hard_split_text('', 10, 0) == []
    assert splitter.hard_split_text('abc', 0, 0) == ['abc']
    assert splitter.hard_split_text('abc', -1, 0) == ['abc']
    # overlap >= size 也要保证前进
    pieces = splitter.hard_split_text('abcdefgh', 4, 10)
    assert ''.join(pieces) == 'abcdefgh'
    assert len(pieces) > 1
    # 空白边界优先（回看 15% 找最近空白），无内容丢失
    pieces = splitter.hard_split_text('aaa bbb ccc', 5, 0)
    assert ''.join(pieces) == 'aaa bbb ccc'
    assert all(len(piece) <= 5 for piece in pieces)


def test_split_text_into_sentences_abbreviations():
    assert splitter.split_text_into_sentences('') == []
    sentences = splitter.split_text_into_sentences('Mr. Smith went to Washington. He stayed.')
    assert sentences == ['Mr. Smith went to Washington.', 'He stayed.']
    assert splitter.split_text_into_sentences('你好。世界！真的？是的') == [
        '你好。', '世界！', '真的？', '是的']
    assert splitter.split_text_into_sentences('Wait... what?') == ['Wait...', 'what?']


def test_sentence_chunk_splitter_param_guards():
    assert splitter.SentenceChunkSplitter(max_word_count=0).max_word_count == 512
    assert splitter.SentenceChunkSplitter(overlap=-5).overlap == 128
    with pytest.raises(AssertionError):
        splitter.SentenceChunkSplitter(max_word_count=4, overlap=8)


def test_sentence_chunk_splitter_long_sentence_and_tail():
    text = '中' * 300 + '。' + '短句。' * 20
    chunks = splitter.SentenceChunkSplitter(max_word_count=100, overlap=20).split(text)
    assert all(len(chunk) <= 100 for chunk in chunks)
    assert splitter.SentenceChunkSplitter().split('   \n  ') == []
    long_splitter = splitter.SentenceChunkSplitter(max_word_count=50, overlap=5)
    assert len(long_splitter._hard_split_long_sentence('x' * 120)) == 3
    # overlap 尾巴：下一块以上一块结尾的句子开头
    text = '第一句。' * 30
    chunks = splitter.SentenceChunkSplitter(max_word_count=20, overlap=8).split(text)
    assert len(chunks) > 2


# ---------------------------------------------------------------------------
# block_splitter
# ---------------------------------------------------------------------------

def _heading(level, text):
    return {'kind': 'heading', 'level': level, 'text': text}


def test_block_splitter_param_guards():
    assert bs.BlockChunkSplitter(max_word_count=0).max_word_count == 512
    assert bs.BlockChunkSplitter(overlap=-1).overlap == 128
    with pytest.raises(AssertionError):
        bs.BlockChunkSplitter(max_word_count=4, overlap=4)
    assert bs.BlockChunkSplitter().split([]) == []
    assert bs.BlockChunkSplitter().split_detailed([]) == []


def test_block_splitter_heading_path_and_merge():
    blocks = [
        _heading(1, '第一章'),
        {'kind': 'text', 'text': '第一段。'},
        _heading(2, '1.1 小节'),
        {'kind': 'text', 'text': '小节正文。'},
        _heading(1, '第二章'),
        {'kind': 'text', 'text': '第二章正文。'},
    ]
    splitter = bs.BlockChunkSplitter(max_word_count=512, overlap=0)
    chunks = splitter.split(blocks)
    joined = '\n'.join(chunks)
    assert '第一章' in joined and '1.1 小节' in joined
    assert '第二章正文。' in chunks[-1]
    # 不跨一级标题打包
    assert not any('第一章' in chunk and '第二章' in chunk for chunk in chunks)

    no_path = bs.BlockChunkSplitter(max_word_count=512, overlap=0,
                                    include_heading_path=False)
    assert all('>' not in chunk for chunk in no_path.split(blocks))


def test_block_splitter_table_paths():
    rows = [['列一', '列二']] + [[f'值{i}', f'说明{i}'] for i in range(1, 8)]
    table = {'kind': 'table', 'title': '设备表', 'rows': rows}
    blocks = [_heading(1, '附录'), table]
    splitter = bs.BlockChunkSplitter(max_word_count=200, overlap=0)
    detailed = splitter.split_detailed(blocks)
    texts = [chunk['text'] for chunk in detailed]
    assert any('设备表' in text for text in texts)
    # 每行只出现一次（表行原子）
    for i in range(1, 8):
        assert sum(f'值{i}|说明{i}' in text for text in texts) == 1

    # 宽表：单行超过预算时按单元格拆
    wide = {'kind': 'table', 'title': '',
            'rows': [['头1', '头2'], ['超' * 100 + '|x', 'y'], ['a', 'b']]}
    chunks = bs.BlockChunkSplitter(max_word_count=60, overlap=0).split([wide])
    assert chunks

    # 空表与无表头表
    assert bs.BlockChunkSplitter().prepare_table({'kind': 'table', 'rows': []}, []) == ('', [], '')
    empty = bs.BlockChunkSplitter(max_word_count=30, overlap=0).split(
        [{'kind': 'table', 'title': 't', 'rows': [['超' * 60]]}])
    assert empty  # 硬切兜底

    # 单元格换行与竖线转义
    assert bs.BlockChunkSplitter().render_row(['a\r\nb', 'c|d']) == 'a  b|c\\|d'


def test_block_splitter_row_split_budgets():
    splitter = bs.BlockChunkSplitter(max_word_count=100, overlap=0)
    assert splitter.split_row('', 0) == ['']
    pieces = splitter.split_row('a|bb|ccc', 4)
    assert '|'.join(pieces).replace('|', '') == 'abbccc'
    # 单格超预算：硬切
    pieces = splitter.split_row('x' * 30 + '|y', 10)
    assert all(len(piece) <= 10 or '|' not in piece for piece in pieces)


def test_block_splitter_overlong_sentence_and_overlap_carry():
    blocks = [_heading(1, '章'), {'kind': 'text', 'text': '超' * 150 + '。'}]
    splitter = bs.BlockChunkSplitter(max_word_count=80, overlap=20)
    chunks = splitter.split(blocks)
    assert all(len(chunk) <= 80 for chunk in chunks)

    # overlap 从上一块带回句子
    text_blocks = [{'kind': 'text', 'text': '句子一。句子二。句子三。句子四。'}]
    carried = bs.BlockChunkSplitter(max_word_count=30, overlap=10)
    assert carried.split(text_blocks)

    # merge_sections=False：每个小节单独落盘
    blocks = [_heading(1, '一章'), {'kind': 'text', 'text': '内容一。'},
              _heading(1, '二章'), {'kind': 'text', 'text': '内容二。'}]
    old = bs.BlockChunkSplitter(max_word_count=512, overlap=0, merge_sections=False)
    chunks = old.split(blocks)
    assert len(chunks) == 2


def test_block_splitter_toc_detection():
    splitter = bs.BlockChunkSplitter()
    assert splitter.toc_page_number({'kind': 'table', 'text': '第一章 概述 1'}) is None
    assert splitter.toc_page_number({'kind': 'text', 'text': ''}) is None
    assert splitter.toc_page_number({'kind': 'text', 'text': 'a' * 61 + ' 1'}) is None
    assert splitter.toc_page_number({'kind': 'text', 'text': '| 第一章 | 1 |'}) is None
    assert splitter.toc_page_number({'kind': 'text', 'text': '图1'}) is None      # 标题太短
    assert splitter.toc_page_number({'kind': 'text', 'text': '2023'}) is None     # 标题以数字结尾
    assert splitter.toc_page_number({'kind': 'text', 'text': '第一章 概述0'}) is None  # 页码 0
    assert splitter.toc_page_number({'kind': 'text', 'text': '第一章 概述 12'}) == 12

    blocks = [{'kind': 'text', 'text': f'第{i}节 内容标题 {i}'} for i in range(1, 7)]
    blocks += [{'kind': 'text', 'text': '正文不会被目录过滤掉。'}]
    kept = splitter.drop_table_of_contents(blocks)
    assert len(kept) == 1

    # 候选不足 / 中断的目录：原样保留
    few = blocks[:3] + [{'kind': 'text', 'text': '正文。'}]
    assert splitter.drop_table_of_contents(few) == few
    shuffled = [
        {'kind': 'text', 'text': '第一节 内容标题 3'},
        {'kind': 'text', 'text': '第二节 内容标题 2'},   # 页码下降：目录中断
        {'kind': 'text', 'text': '第三节 内容标题 4'},
    ]
    assert splitter.drop_table_of_contents(shuffled) == shuffled
    assert splitter.is_toc_line({'kind': 'text', 'text': '第一章 概述 1'})


# ---------------------------------------------------------------------------
# corpus / split_common
# ---------------------------------------------------------------------------

def test_reconstruct_text_dedupes_content_expand():
    from parsing.common.create_doc import LCDocument
    docs = [
        LCDocument('句子A', {'content_expand': '整段A'}),
        LCDocument('句子A2', {'content_expand': '整段A'}),
        LCDocument('句子B', {'content_expand': '整段B'}),
        LCDocument('段落键', {}),
        LCDocument('', {'content_expand': ''}),
    ]
    assert corpus._reconstruct_text(docs) == '整段A\n\n整段B\n\n段落键'
    assert corpus._reconstruct_text(None) == ''


def test_collect_blocks_coverage_guard():
    doc = type('D', (), {'blocks': [
        {'kind': 'text', 'text': '只有一点点'},
    ]})()
    # 块覆盖不足全文一半 → 退回纯文本
    assert corpus._collect_blocks([doc], '很长' * 100) == []
    # 有表格块：不做长度比
    table_doc = type('D', (), {'blocks': [{'kind': 'table', 'title': 't',
                                           'rows': [['a']]}]})()
    assert corpus._collect_blocks([table_doc], 'x' * 500)
    assert corpus._collect_blocks(None, 'x') == []
    assert corpus._block_text_length({'kind': 'table', 'title': 'ab',
                                      'rows': [['a', 'bb'], []]}) == 5
    assert corpus._block_text_length({'kind': 'text', 'text': 'abc'}) == 3
    assert corpus._block_text_length({}) == 0


def test_chunk_type_and_build_document():
    from parsing.common.create_doc import LCDocument
    qa_docs = [LCDocument('q', {'type': 1}), LCDocument('a', {'type': 1})]
    assert corpus._chunk_type(qa_docs) == 1
    assert corpus._chunk_type([LCDocument('x', {'type': 0})]) == 0
    assert corpus._chunk_type([]) == 0
    assert corpus._chunk_type([LCDocument('x', None)]) == 0
    doc = corpus._build_document('切片', 'a.md', 3, 1)
    assert doc.metadata == {'chunk_index': '', 'source': 'a.md',
                            'content_expand': '切片', 'chunk_id': 3, 'type': 1}


def test_process_single_file_unsupported_format(tmp_path, caplog):
    path = tmp_path / 'data.ofd'
    path.write_bytes(b'x')
    with pytest.raises(UnsupportedFormatError):
        corpus.process_single_file(str(path), str(tmp_path / 'out.txt'), 512, 0,
                                   DefaultSensitiveWordChecker())


def test_process_single_file_corrupt_zip(tmp_path):
    path = tmp_path / 'broken.docx'
    path.write_bytes(b'PK\x03\x04truncated')
    with pytest.raises(ParseCorruptError):
        corpus.process_single_file(str(path), str(tmp_path / 'out.txt'), 512, 0,
                                   DefaultSensitiveWordChecker())


def test_process_single_file_empty_text(tmp_path, monkeypatch):
    path = tmp_path / 'empty.md'
    path.write_text('\n\n', encoding='utf-8')

    class _EmptyStrategy:
        def process(self, file_path):
            from parsing.common.create_doc import LCDocument
            return [LCDocument('  ', {'content_expand': '  '})]

    monkeypatch.setitem(corpus.FILE_PARSE_STRATEGIES, 'md', _EmptyStrategy())
    with pytest.raises(ParseEmptyError):
        corpus.process_single_file(str(path), str(tmp_path / 'out.txt'), 512, 0,
                                   DefaultSensitiveWordChecker())


def test_process_single_file_sensitive_check(tmp_path, monkeypatch):
    path = tmp_path / 's.md'
    path.write_text('# 标题\n\n正文内容在这里。', encoding='utf-8')

    class _Reject:
        def check_sensitive_word(self, content):
            raise SensitiveMsgException('0006', None, {})

    with pytest.raises(SensitiveMsgException):
        corpus.process_single_file(str(path), str(tmp_path / 'out.txt'), 512, 0, _Reject())


def test_load_corpus_file_txt_roundtrip(tmp_path):
    input_dir = tmp_path / 'in'
    input_dir.mkdir()
    (input_dir / 'a.txt').write_text('这是第一段话，内容足够长。这是第二段。\n', encoding='utf-8')

    out = corpus.load_corpus_file(str(input_dir), str(tmp_path / 'out'), 512, 0)
    corpus_file = tmp_path / 'out' / 'output' / 'corpus_file.txt'
    assert corpus_file.exists()
    assert 'page_content=' in corpus_file.read_text(encoding='utf-8')
    assert out.endswith('output')

    # 不存在的路径
    with pytest.raises(Exception):
        corpus.load_corpus_file(str(tmp_path / 'nope'), str(tmp_path / 'out2'), 512, 0)


def test_load_corpus_file_single_file_and_cleanup(tmp_path, monkeypatch):
    src = tmp_path / 'doc.md'
    src.write_text('# 标题\n\n正文第一句。第二句在这里。\n', encoding='utf-8')
    out = corpus.load_corpus_file(str(src), str(tmp_path / 'out'), 512, 0)
    assert (tmp_path / 'out' / 'output' / 'corpus_file.txt').exists()

    # 二次写入会先清掉旧文件（幂等）
    corpus.load_corpus_file(str(src), str(tmp_path / 'out'), 512, 0)
    lines = (tmp_path / 'out' / 'output' / 'corpus_file.txt').read_text(
        encoding='utf-8').splitlines()
    assert lines and all(line.startswith('page_content=') for line in lines)

    # 解析抛错要原样往上抛
    class _Boom:
        def process(self, file_path):
            raise RuntimeError('解析失败')

    monkeypatch.setitem(corpus.FILE_PARSE_STRATEGIES, 'md', _Boom())
    with pytest.raises(RuntimeError):
        corpus.load_corpus_file(str(src), str(tmp_path / 'out'), 512, 0)


def test_file_split_common_reads_back_and_filters(tmp_path):
    src = tmp_path / 'doc.txt'
    src.write_text('第一段正文，内容够长。第二句。\x00坏字符\n', encoding='utf-8')

    docs = split_common.file_split_common(str(src), 512, 0, True, custom_work_dir=str(tmp_path))
    assert docs
    for doc in docs:
        assert '\x00' not in doc.page_content


def test_file_split_common_skips_bad_lines(tmp_path, monkeypatch, caplog):
    from parsing.common.create_doc import LCDocument

    docs = [LCDocument('好的切片', {'source': 'a.txt', 'content_expand': '好的切片',
                                   'chunk_id': 1, 'type': 0})]
    # load_corpus_file 桩：返回值就是 file_split_common 里读 corpus_file.txt 的目录
    import os

    def _fake_load(input_path, output_path, *args, **kwargs):
        parent = f'{output_path}/output'
        os.makedirs(parent, exist_ok=True)
        with open(f'{parent}/corpus_file.txt', 'w', encoding='utf-8') as handle:
            handle.write('filepath=skip-me\n')
            handle.write('page_content=not-literal metadata={bad json\n')
            handle.write('page_content=' + repr('好的切片') + ' metadata=' + repr(
                {'source': 'a.txt', 'content_expand': '好的切片', 'chunk_id': 1, 'type': 0}) + '\n')
        return parent

    monkeypatch.setattr(split_common.corpus, 'load_corpus_file', _fake_load)
    result = split_common.file_split_common(str(tmp_path / 'x.txt'), 512, 0, True,
                                            custom_work_dir=str(tmp_path))
    assert [doc.page_content for doc in result] == ['好的切片']


def test_filter_invalid_char_variants():
    from parsing.common.create_doc import LCDocument
    doc = LCDocument('a\x00b\ud800c', {'content_expand': 'x\ud800y\x00'})
    split_common.filter_invalid_char([doc])
    assert doc.page_content == 'abc'
    assert doc.metadata['content_expand'] == 'xy'
    empty = LCDocument('', {'content_expand': ''})
    split_common.filter_invalid_char([empty])
    assert empty.metadata['content_expand'] == ''


# ---------------------------------------------------------------------------
# sensitive / exception
# ---------------------------------------------------------------------------

def _word_file(tmp_path, words):
    path = tmp_path / 'words.txt'
    path.write_text('\n'.join(words), encoding='utf-8')
    return str(path)


def test_sensitive_checkers(tmp_path):
    assert DefaultSensitiveWordChecker().check_sensitive_word('anything') is None

    empty_checker = LocalSensitiveWordChecker(_word_file(tmp_path, ['# 注释', '', '  ']))
    assert empty_checker.check_sensitive_word('任何内容') is None

    checker = LocalSensitiveWordChecker(_word_file(tmp_path, ['机密', '# 注释']))
    with pytest.raises(SensitiveMsgException):
        checker.check_sensitive_word('这里有机密文件')
    assert checker.check_sensitive_word('普通文本') is None
    assert checker.check_sensitive_word('') is None

    missing = LocalSensitiveWordChecker(str(tmp_path / 'no-such-file'))
    assert missing._words == []

    logged = SensitiveWordChecker(_word_file(tmp_path, ['词']))
    assert logged._words == ['词']
    checker_env = LocalSensitiveWordChecker(None)
    assert 'sensitive_words.txt' in checker_env.word_file or checker_env._words == []


def test_exception_types():
    empty = ParseEmptyError('/tmp/a.md', source='md', detail='空')
    assert empty.code == '0001'
    assert 'ParseEmptyError' in str(empty)
    assert UnsupportedFormatError('/tmp/a.ofd', source='ofd').message == \
        'RetCode.operator.split.unsupported'
    corrupt = ParseCorruptError('/tmp/a.docx', source='docx', detail='截断')
    assert 'ParseCorruptError' in str(corrupt)

    error = SensitiveMsgException('0006', None, {'zh_CN': '中文', 'en_US': 'English'})
    assert error.get_code() == '0006' and error.get_bo() is None
    assert error.get_i18n_message('zh_CN') == '中文'
    assert error.get_i18n_message('en_US') == 'English'
    assert error.get_i18n_message('fr') == 'English'
    assert 'SensitiveMsgException' in str(error)
    bare = SensitiveMsgException('0006', None)
    assert bare.get_i18n_message('zh_CN') is None


# ---------------------------------------------------------------------------
# common 工具
# ---------------------------------------------------------------------------

def test_pathutil_helpers(tmp_path):
    assert pathutil.get_workdir() == str(tmp_path)
    assert pathutil.get_name_pre('a.txt') == 'a'
    assert pathutil.get_base_name('/x/y/b.md') == 'b.md'

    nested = str(tmp_path / 'deep' / 'file.txt')
    pathutil.create_parent_dir_all_path(nested)
    pathutil.create_parent_dir_all_path(nested)  # 幂等
    assert (tmp_path / 'deep').exists()

    created = pathutil.create_dir_under_root('/temp/pdf/x_md')
    assert created.startswith(str(tmp_path))
    assert (tmp_path / 'temp' / 'pdf' / 'x_md').exists()

    pathutil.delete_temp()
    assert not (tmp_path / 'temp').exists()


def test_profile_dev_prod(monkeypatch):
    monkeypatch.delenv('DEV_MODE', raising=False)
    assert profile.Profile.dev() is True
    assert profile.Profile.prod() is False
    monkeypatch.setenv('DEV_MODE', 'true')
    assert profile.Profile.dev() is True
    assert profile.Profile.prod() is False
    monkeypatch.delenv('DEV_MODE', raising=False)
    profile.Config['profile'] = 'prod'
    try:
        assert profile.Profile.prod() is True
        assert profile.Profile.dev() is False
    finally:
        profile.Config['profile'] = 'dev'


def test_special_filter_methods():
    f = special_filter.SpecialFilter()
    assert f.char_filter('a\xa0b﻿c。：d') == 'a b c。d'
    key = f.replace_char('【1、】测试-项\xa0|，x\n﻿①')
    assert '【' not in key and '-' not in key
    content = f.replace_content_char('如下图所示\xa0第一行\\n第二行\r\n\n\n第三行\n1. 序号\n：\n 如图\t﻿')
    assert '如下图所示' not in content and '\r' not in content and '\t' not in content
    assert '第一行' in content
    pic = f.replace_pic_and_serial('1. 如图3所示，测试，')
    assert '如图' not in pic and '测试' in pic
    pic_text = f.replace_char_for_pic('如下图所示\xa0内容，。\n\n\n1. 序号\t')
    assert '如下图所示' not in pic_text

    d = special_filter_docx.SpecialFilter_docx()
    assert d.char_filter('a\xa0b﻿c') == 'a b c'
    assert d.replace_pic_and_serial('2）如图5所示，内容，') == '，内容'
    assert '如下图所示' not in d.replace_char_for_pic('如下图所示 内容')


def test_sentence_validator_paths():
    v = SentenceValidator()
    assert v.chinese_ratio('中文内容') == 1.0
    assert v.is_contain_chinese('abc中文') is True
    assert v.is_contain_chinese('abc') is False
    assert v.is_add_sentence_key('这是一个足够长的中文句子') is True
    assert v.is_add_sentence_key('ab') is False
    assert v.is_add_sentence_key('查看 https://example.com/x 页面') is False
    assert v.is_add_sentence_key('this is a long enough english sentence') is True
    assert v.latin_validate('aaa') is True
    assert v.latin_validate('123 456') is False
    assert v.contains_url('see http://a.b/c') is True


def test_detect_encoding(tmp_path):
    path = tmp_path / 'sample.txt'
    path.write_text('中文内容', encoding='utf-8')
    assert detect_encoding(str(path)) is not None


def test_create_doc_and_source(tmp_path):
    content = {'标题一': {'text': '正文', 'source': 'custom.md'},
               '空值键': None, '标题二': {'text': '正文二', 'blocks': [{'kind': 'text'}]}}
    docs = create_doc.create_doc(content, ['raw.md'], 'space-1')
    assert len(docs) == 2
    assert docs[0].metadata['source'] == 'custom.md/space-1'
    assert docs[1].blocks == [{'kind': 'text'}]
    assert create_doc.create_source(['a', 'b'], None) == 'a/b'

    qa_docs = []
    create_doc.create_doc_by_content(qa_docs, '问', '答', 's.csv', is_qa=True)
    assert qa_docs[0].metadata['type'] == 1
    no_qa = []
    create_doc.create_doc_by_content(no_qa, '问', '答', 's.csv')
    assert 'type' not in no_qa[0].metadata

    create_doc.write_txt(qa_docs, str(tmp_path / 'nested' / 'out.txt'))
    assert (tmp_path / 'nested' / 'out.txt').exists()


def test_parsing_logutil_handler(tmp_path, monkeypatch):
    monkeypatch.setenv('LOG_DIR', str(tmp_path / 'logs'))
    handler = parsing_logutil.get_file_handler('misc-test')
    try:
        record = logging.LogRecord('t', logging.INFO, __file__, 1, 'hello', None, None)
        handler.emit(record)
        handler.flush()
        import os
        assert any('rkb-' in name for name in os.listdir(str(tmp_path / 'logs')))
    finally:
        handler.close()


def test_compressed_rotating_file_handler_lifecycle(tmp_path):
    log_file = tmp_path / 'logs' / 'rkb-misc.log'
    handler = parsing_logutil.CompressedRotatingFileHandler(
        str(log_file), maxBytes=100000, backupCount=2)
    try:
        assert handler.backup_dir == str(tmp_path / 'logs' / 'zip')
        assert len(handler._get_rand_str()) == 6
        assert handler._get_filename().startswith(str(tmp_path / 'logs' / 'rkb-'))

        # get_files_to_delete：归档不足 backupCount 时清空
        assert handler.get_files_to_delete() == []

        # rotate：源文件压缩进 zip 目录并删除源文件
        source = tmp_path / 'logs' / 'rkb-20220212110100-[123456].log'
        source.write_text('legacy', encoding='utf-8')
        dest = tmp_path / 'logs' / 'zip' / 'rkb-20220212110100-[123456].log.gz'
        handler.rotate(str(source), str(dest))
        assert dest.exists() and not source.exists()

        # _backup_remains：30 分钟前的残留日志被归档
        import os
        import time as _time
        stale = tmp_path / 'logs' / 'rkb-20210212110100123-[654321].log'
        stale.write_text('stale', encoding='utf-8')
        stamp = _time.time() - 3600
        os.utime(str(stale), (stamp, stamp))
        handler._backup_remains()
        assert not stale.exists()
        assert (tmp_path / 'logs' / 'zip' / 'rkb-20210212110100123-[654321].log.gz').exists()

        # doRollover：换新文件名并按 backupCount 清理
        import gzip as _gzip
        for i in range(5):
            old = tmp_path / 'logs' / 'zip' / f'rkb-2020060101010012{i}-[00000{i}].log.gz'
            old.write_bytes(_gzip.compress(b'x'))
        handler.stream = handler._open()
        handler.doRollover()
        assert len(os.listdir(str(tmp_path / 'logs' / 'zip'))) <= 6
    finally:
        try:
            handler.close()
        except Exception:
            pass
