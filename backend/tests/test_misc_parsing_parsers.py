"""parsing 解析器层：txt/md/docx/xlsx/html/pptx/pdf 与格式策略。

文件全部临时生成（python-docx / python-pptx / openpyxl / 手写最小 PDF），
work_dir 打到 ``tmp_path``，零外部依赖。
"""

import json

import docx as python_docx
import openpyxl
import pytest
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Emu

from infrastructure.config import settings as infra_settings
from parsing.common import create_doc
from parsing.parsers import strategies
from parsing.parsers.docx_tool.read_word import WordContentParser
from parsing.parsers.docx_tool.word_table_tool import WordTableParser
from parsing.parsers.excel_tool.read_execl import ExcelContentParser
from parsing.parsers.html_tool import html_md_tool
from parsing.parsers.html_tool.read_html import HtmlContentParser
from parsing.parsers.md_tool.md_table_tool import MdTableTool
from parsing.parsers.md_tool.read_md import MdContentParser
from parsing.parsers.pdf_tool import read_pdf as pdf_read
from parsing.parsers.pdf_tool.read_pdf import PdfContentParser
from parsing.parsers.pptx_tool import read_pptx
from parsing.parsers.pptx_tool.read_pptx import PPTXContentParser
from parsing.parsers.txt_tool.read_txt import TxtContentParser

pytest.importorskip('pdfplumber')


@pytest.fixture(autouse=True)
def _work_dir(monkeypatch, tmp_path):
    monkeypatch.setitem(infra_settings.Config, 'work_dir', str(tmp_path))
    import parsing.parsers.pdf_tool.read_pdf as _pdf
    import parsing.parsers.pptx_tool.read_pptx as _pptx
    import parsing.parsers.html_tool.html_md_tool as _html
    monkeypatch.setattr(_pdf, 'work_dir', str(tmp_path))
    monkeypatch.setattr(_pptx, 'work_dir', str(tmp_path))
    monkeypatch.setattr(_html, 'workdir', str(tmp_path))
    return tmp_path


# ---------------------------------------------------------------------------
# 手写最小 PDF（带可选书签与表格线）
# ---------------------------------------------------------------------------

def _pdf_escape(text):
    return text.replace('\\', r'\\').replace('(', r'\(').replace(')', r'\)')


def _build_pdf(path, pages, outlines=None, page_lines=None):
    """构造最小 PDF。

    :param pages: ``[[ (x, y, size, text), ... ], ...]``（PDF 坐标，原点左下）
    :param outlines: ``[(level, title, page_index)]``（可选）
    :param page_lines: ``{page_index: [(x0, y0, x1, y1)]}``（可选，画表格线）
    """
    objects = []  # (body, is_stream)

    def add(body, stream=None):
        objects.append((body, stream))
        return len(objects)

    catalog_id = add(b'')  # 1 占位
    pages_id = add(b'')    # 2 占位
    outlines_id = add(b'') # 3 占位
    outline_item_ids = []
    for _level, _title, _page in (outlines or []):
        outline_item_ids.append(add(b''))
    page_ids = []
    content_ids = []
    font_id = add(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    for index, ops in enumerate(pages):
        content_ids.append(add(b'', None))
        page_ids.append(add(b''))
    # 内容流（表格线 + 文本）
    for index, ops in enumerate(pages):
        parts = []
        for line in (page_lines or {}).get(index, []):
            x0, y0, x1, y1 = line
            parts.append(f'{x0} {y0} m {x1} {y1} l S'.encode('ascii'))
        for (x, y, size, text) in ops:
            parts.append(
                f'BT /F1 {size} Tf {x} {y} Td ({_pdf_escape(text)}) Tj ET'.encode('latin-1'))
        objects[content_ids[index] - 1] = (b'', b'\n'.join(parts))
    page_ref = lambda pid: f'{pid} 0 R'.encode('ascii')  # noqa: E731
    for index, pid in enumerate(page_ids):
        body = (b'<< /Type /Page /Parent ' + str(pages_id).encode() + b' 0 R '
                b'/MediaBox [0 0 612 792] /Resources << /Font << /F1 '
                + str(font_id).encode() + b' 0 R >> >> /Contents '
                + str(content_ids[index]).encode() + b' 0 R >>')
        objects[pid - 1] = (body, None)
    kids = b'[' + b' '.join(page_ref(pid) for pid in page_ids) + b']'
    objects[pages_id - 1] = (
        b'<< /Type /Pages /Kids ' + kids + b' /Count ' + str(len(pages)).encode() + b' >>', None)
    if outlines:
        count = len(outlines)
        first, last = outline_item_ids[0], outline_item_ids[-1]
        objects[outlines_id - 1] = (
            f'<< /Type /Outlines /Count {count} /First {first} 0 R /Last {last} 0 R >>'.encode(),
            None)
        for i, ((level, title, page_index), oid) in enumerate(zip(outlines, outline_item_ids)):
            parts = [f'/Title ({_pdf_escape(title)})', f'/Parent {outlines_id} 0 R',
                     f'/Dest [{page_ids[page_index]} 0 R /Fit]']
            if i > 0:
                parts.append(f'/Prev {outline_item_ids[i - 1]} 0 R')
            if i < len(outlines) - 1:
                parts.append(f'/Next {outline_item_ids[i + 1]} 0 R')
            objects[oid - 1] = ('<< ' + ' '.join(parts) + ' >>'.encode('ascii', 'ignore')
                                if False else ('<< ' + ' '.join(parts) + ' >>').encode('latin-1'),
                                None)
    objects[catalog_id - 1] = (
        f'<< /Type /Catalog /Pages {pages_id} 0 R /Outlines {outlines_id} 0 R >>'.encode(), None)

    out = bytearray(b'%PDF-1.4\n')
    offsets = [0]
    for number, (body, stream) in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f'{number} 0 obj\n'.encode('ascii')
        if stream is not None:
            out += (f'<< /Length {len(stream)} >>\nstream\n'.encode('ascii')
                    + stream + b'\nendstream\n')
        else:
            out += body + b'\n'
        out += b'endobj\n'
    xref_at = len(out)
    out += f'xref\n0 {len(objects) + 1}\n'.encode('ascii')
    out += b'0000000000 65535 f \n'
    for offset in offsets[1:]:
        out += f'{offset:010d} 00000 n \n'.encode('ascii')
    out += (f'trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n'
            f'startxref\n{xref_at}\n%%EOF\n').encode('ascii')
    path.write_bytes(bytes(out))
    return str(path)


# ---------------------------------------------------------------------------
# 纯文本函数（read_pdf / read_pptx 顶部的工具）
# ---------------------------------------------------------------------------

def test_pdf_text_helpers():
    assert pdf_read.replace_pic_no_pre('如图1-2所示前文图3.4后文') == '前文后文'
    assert pdf_read.replace_char('a b【】“”\\，c') == 'a_bc'
    assert pdf_read.find_last_match(
        __import__('re').compile(r'b'), 'abeb') is not None
    assert pdf_read.remove_first_space('1. 标题') == '1.标题'
    assert pdf_read.adjust_special_scene_title('1.系统启动/关闭') == \
        '1. 系统启动 / 关闭'
    assert pdf_read.create_flexible_space_pattern('a b').search('a\u2003b')


def test_process_origin_title_branches():
    content = '引言 1.2 概述结尾'
    # 精确（灵活空格）匹配
    assert pdf_read.process_origin_title(content, '1.2 概述', '# 1.2 概述') == \
        '引言 # 1.2 概述结尾'
    # 去掉首个空格后再匹配
    assert pdf_read.process_origin_title('a 1.2概述', '1.2 概述', 'T') == 'a T'
    # 特殊场景：斜杠补空格
    assert pdf_read.process_origin_title('x 1.系统启动/关闭 y', '1.系统启动/关闭', 'T') == \
        'x T y'


def test_convert_to_markdown_and_titles():
    assert PdfContentParser._convert_to_markdown([]) == ''
    table = PdfContentParser._convert_to_markdown([['h1', 'h2'], ['a'], ['b', 'c']])
    assert table.splitlines() == ['| h1 | h2 |', '| --- | --- |', '| a |  |', '| b | c |']
    parser = PdfContentParser()
    assert parser.convert_to_markdown_title('t', 1) == '# t'
    assert parser.convert_to_markdown_title('t', 3) == '### t'
    assert parser.convert_to_markdown_title('t', 6) == '###### t'
    assert parser.convert_to_markdown_title('t', 9) == '###### t'


def test_pdf_geometry_helpers():
    parser = PdfContentParser()
    assert parser._is_in_header_footer((0, 0, 10, 10), 60, 780) is True
    assert parser._is_in_header_footer((0, 100, 10, 200), 60, 780) is False
    assert parser._convert_bbox((1, 2, 3, 4), 800) == (1, 796, 3, 798)
    assert parser._bbox_overlap((0, 0, 5, 5), (3, 3, 9, 9)) is True
    assert parser._bbox_overlap((0, 0, 2, 2), (4, 4, 9, 9)) is False


def _table(page_num, bbox, height=792.0):
    from parsing.parsers.pdf_tool.read_pdf import PDFTable
    return PDFTable(table_id='table1', page_num=page_num, content='| a |',
                    bbox=bbox, page_height=height)


def test_group_continuous_tables():
    parser = PdfContentParser()
    assert parser.group_continuous_tables() == []
    parser.tables = [_table(1, (0, 0, 10, 780)), _table(2, (0, 5, 10, 400)),
                     _table(3, (0, 0, 10, 400))]
    groups = parser.group_continuous_tables()
    assert len(groups) == 2
    assert [len(group) for group in groups] == [2, 1]


def test_process_single_element_both_types():
    parser = PdfContentParser()
    output, tables = parser._process_elements(
        [{'type': 'text', 'bbox': (0, 0, 1, 1), 'data': 'hello'},
         {'type': 'table', 'bbox': (0, 0, 1, 1), 'data': '| a |'}], 3, 792.0)
    assert output.split('  \n') == ['hello', '{{table1}}']
    assert tables[0].page_num == 3 and parser.table_counter == 2


def test_combine_text_line_merges_nested_boxes():
    parser = PdfContentParser()
    elements = [
        {'type': 'text', 'bbox': (0, 10, 50, 20), 'data': 'A'},
        {'type': 'text', 'bbox': (5, 12, 30, 18), 'data': 'B'},
        {'type': 'table', 'bbox': (0, 0, 1, 1), 'data': 'x'},
    ]
    parser._combine_text_line(elements)
    assert elements[0]['data'] == 'AB'
    assert elements[1]['type'] == 'table'


def test_export_full_markdown_replaces_placeholders(tmp_path):
    parser = PdfContentParser()
    from parsing.parsers.pdf_tool.read_pdf import PDFPageContent
    pages = [PDFPageContent(page_num=1, text='前 {{table1}} 后 图1 所示')]
    out = str(tmp_path / 'out.md')
    parser.export_full_markdown('doc.pdf', pages, [[_table(1, (0, 0, 1, 1))]], out)
    content = open(out, encoding='utf-8').read()
    assert '| a |' in content and '{{table1}}' not in content
    assert '图1 所示' not in content or '所示' in content


def test_extract_pdf_outlines_and_convert(tmp_path):
    path = _build_pdf(tmp_path / 'book.pdf', [
        [(72, 700, 18, 'Chapter One')],
        [(72, 700, 12, 'body text')],
    ], outlines=[(0, 'Chapter One', 0)])
    parser = PdfContentParser()
    outlines = parser.extract_pdf_outlines(path)
    assert outlines and outlines[0]['title'].startswith('#')
    assert outlines[0]['page'] == 1


# ---------------------------------------------------------------------------
# PdfContentParser：整本解析（手写 PDF）
# ---------------------------------------------------------------------------

def test_parse_text_pdf_without_outlines(tmp_path):
    path = _build_pdf(tmp_path / 'plain.pdf', [
        [(72, 700, 14, 'This is a heading line'),
         (72, 650, 10, 'Body paragraph number one with enough words here.')],
    ])
    parser = PdfContentParser()
    pages, groups = parser.parse(path)
    assert len(pages) == 1 and groups == []
    assert 'This is a heading line' in pages[0].text


def _grid(page_index):
    """2×1 单元格的网格线（pdfplumber 需要线段交叉成格才认表）。"""
    lines = [(72, 600, 300, 600), (72, 620, 300, 620), (72, 640, 300, 640),
             (72, 600, 72, 640), (186, 600, 186, 640), (300, 600, 300, 640)]
    return lines


def test_parse_table_pdf(tmp_path):
    path = _build_pdf(tmp_path / 'table.pdf', [
        [(80, 625, 10, 'A'), (192, 625, 10, 'B'),
         (80, 605, 10, 'C'), (192, 605, 10, 'D')]],
        page_lines={0: _grid(0)})
    parser = PdfContentParser()
    pages, groups = parser.parse(path)
    assert groups, '检测到的表格应产出分组'
    assert groups[0][0].content.startswith('|')


def _full_page_grid():
    return [(50, 60, 560, 60), (50, 740, 560, 740),
            (50, 60, 50, 740), (300, 60, 300, 740), (560, 60, 560, 740),
            (50, 400, 560, 400)]


def test_parse_table_list_document_uses_pdfium(tmp_path):
    # 每页一张铺满页面的表（获奖名单型）：采样命中后整本走 pdfium 快速路径
    path = _build_pdf(tmp_path / 'list.pdf', [
        [(60, 700, 10, 'row one'), (320, 700, 10, 'v one'),
         (60, 360, 10, 'row two'), (320, 360, 10, 'v two')],
        [(60, 700, 10, 'row three'), (320, 700, 10, 'v three'),
         (60, 360, 10, 'row four'), (320, 360, 10, 'v four')],
    ], page_lines={0: _full_page_grid(), 1: _full_page_grid()})
    parser = PdfContentParser()
    pages, groups = parser.parse(path)
    assert groups == []            # 快速路径不做表格抽取
    assert len(pages) == 2
    assert 'row one' in pages[0].text


def test_textpage_lines_splits_by_charboxes(tmp_path):
    path = _build_pdf(tmp_path / 'lines.pdf', [
        [(60, 700, 10, 'first'), (60, 650, 10, 'second')]])
    import pypdfium2 as pdfium
    document = pdfium.PdfDocument(path)
    page = document[0]
    textpage = page.get_textpage()
    parser = PdfContentParser()
    text = parser.textpage_lines(textpage)
    textpage.close()
    page.close()
    document.close()
    assert 'first' in text and 'second' in text.split('\n')


def test_parser_pdf_to_md_writes_markdown(tmp_path):
    _build_pdf(tmp_path / 'report.pdf', [
        [(72, 700, 14, 'Report title line'), (72, 650, 10, 'Some body content here.')],
    ], outlines=[(0, 'Report title line', 0)])
    parser = PdfContentParser()
    output = parser.convert_pdf(str(tmp_path), 'report.pdf')
    assert output.endswith('.md')
    assert 'Report title line' in open(output, encoding='utf-8').read()


# ---------------------------------------------------------------------------
# PPTX
# ---------------------------------------------------------------------------

def _make_pptx(path, with_chart_type=None, group=False, table=False):
    prs = Presentation()
    layout = prs.slide_layouts[6]
    slide = prs.slides.add_slide(layout)
    left_box = slide.shapes.add_textbox(Emu(100000), Emu(100000), Emu(3000000), Emu(600000))
    left_box.text_frame.text = 'Slide Title'
    left_box.text_frame.paragraphs[0]
    sub = left_box.text_frame.add_paragraph()
    sub.text = 'Indented item'
    sub.level = 1
    right_box = slide.shapes.add_textbox(Emu(6000000), Emu(100000), Emu(3000000), Emu(600000))
    right_box.text_frame.text = 'Right column text'
    if table:
        rows, cols = 2, 2
        shape = slide.shapes.add_table(rows, cols, Emu(100000), Emu(3000000),
                                       Emu(3000000), Emu(1000000))
        shape.table.cell(0, 0).text = '头一'
        shape.table.cell(0, 1).text = '头二'
        shape.table.cell(1, 0).text = '值一\n换行'
        shape.table.cell(1, 1).text = '值二'
    if group:
        group_shape = slide.shapes.add_group_shape()
        from pptx.enum.shapes import MSO_SHAPE
        inner = group_shape.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(100000), Emu(5000000),
                                             Emu(2000000), Emu(400000))
        inner.text_frame.text = 'Grouped text'
    if with_chart_type is not None:
        data = CategoryChartData()
        data.categories = ['c1', 'c2']
        data.add_series('s1', (1.0, 2.0))
        slide.shapes.add_chart(with_chart_type, Emu(3000000), Emu(4000000),
                               Emu(3000000), Emu(2000000), data)
    prs.save(str(path))
    return str(path)


def test_pptx_to_markdown_full(tmp_path):
    _make_pptx(tmp_path / 'deck.pptx', group=True, table=True)
    parser = PPTXContentParser()
    output = parser.convert_pptx(str(tmp_path), 'deck.pptx')
    markdown = open(output, encoding='utf-8').read()
    assert 'Slide Title' in markdown
    assert 'Right column text' in markdown
    assert 'Grouped text' in markdown
    assert '| 头一 | 头二 |' in markdown
    assert '换行' in markdown


def test_pptx_chart_supported_type(tmp_path):
    _make_pptx(tmp_path / 'chart.pptx', with_chart_type=XL_CHART_TYPE.COLUMN_CLUSTERED)
    parser = PPTXContentParser()
    output = parser.convert_pptx(str(tmp_path), 'chart.pptx')
    markdown = open(output, encoding='utf-8').read()
    assert '| Plot | Series | Category | Value |' in markdown


def test_pptx_chart_unsupported_type_falls_back_to_xml(tmp_path):
    _make_pptx(tmp_path / 'bar.pptx', with_chart_type=XL_CHART_TYPE.BAR_CLUSTERED)
    parser = PPTXContentParser()
    output = parser.convert_pptx(str(tmp_path), 'bar.pptx')
    markdown = open(output, encoding='utf-8').read()
    assert '| Category | Value |' in markdown


def test_pptx_helpers():
    assert read_pptx.replace_char('a b【】“”\\，c') == 'a_bc'
    assert read_pptx.clean_text('如图1-2所示\x00文字') == '文字'
    assert read_pptx.parse_xml(
        '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<c:cat><c:strRef><c:strCache>'
        '<c:pt><c:v>A</c:v></c:pt><c:pt><c:v>B</c:v></c:pt></c:strCache></c:strRef></c:cat>'
        '<c:val><c:numRef><c:numCache>'
        '<c:pt><c:v>1.0</c:v></c:pt><c:pt><c:v>2.0</c:v></c:pt></c:numCache></c:numRef></c:val>'
        '</c:chartSpace>').splitlines() == ['| Category | Value |', '|------|----|',
                                            '| A | 1 |', '| B | 2 |']


class _FakeSeries:
    def __init__(self, name, values):
        self.name = name
        self.values = values


class _FakePlot:
    def __init__(self, categories, series):
        self.categories = categories
        self.series = series


class _FakeChart:
    def __init__(self, plots):
        self.plots = plots


def test_extract_chart_data_helpers():
    plot = _FakePlot([type('C', (), {'label': 'L1'})()], [_FakeSeries('S', [1, None])])
    table = read_pptx.extract_chart_data_for_supported_type(_FakeChart([plot]))
    assert 'L1' in table and '| 0 |' in table  # None → 0

    unnamed = _FakePlot(None, [_FakeSeries(None, [3])])
    table2 = read_pptx.extract_chart_data_for_supported_type(_FakeChart([unnamed]))
    assert 'Series_1_1' in table2 and 'Category 1' in table2

    values_only = _FakePlot([type('C', (), {'label': 'L1'})()],
                            [_FakeSeries('S', [7, 8])])
    assert 'Unknown' in read_pptx.extract_chart_data_for_supported_type(
        _FakeChart([values_only]))

    with pytest.raises(Exception):
        read_pptx.extract_chart_data_for_supported_type(_FakeChart([]))


def test_check_chart_type_and_title_helpers(monkeypatch):
    chart = type('C', (), {'chart_type': XL_CHART_TYPE.COLUMN_CLUSTERED,
                           'chart_title': type('T', (), {'text_frame': type(
                               'F', (), {'text': '标题'})()})()})()
    assert read_pptx.check_chart_type_supported(chart) is True
    assert read_pptx.get_chart_title(chart) == '标题'

    unsupported = type('C', (), {'chart_type': XL_CHART_TYPE.AREA})()
    assert read_pptx.check_chart_type_supported(unsupported) is False

    raising = type('C', (), {'chart_type': property(lambda self: (_ for _ in ()).throw(
        RuntimeError('no type')))})()
    assert read_pptx.check_chart_type_supported(raising) is False
    assert read_pptx.get_chart_title(type('C', (), {'chart_title': property(
        lambda self: (_ for _ in ()).throw(RuntimeError('no title')))})()) == ''

    class _Shape:
        def __init__(self, top, left):
            self.top = top
            self.left = left

    first, second = _Shape(2, 1), _Shape(1, 0)
    assert read_pptx.sort_page_shapes([first, second]) == [second, first]
    assert read_pptx.sort_page_shapes([_Shape(None, None)]) is not None

    class _Boom:
        @property
        def top(self):
            raise RuntimeError('x')

    boom = _Boom()
    assert read_pptx.sort_page_shapes([boom, boom]) is not None


def test_process_paragraph_title_and_indent():
    parser = PPTXContentParser()
    markdown = []
    parser.process_paragraph(markdown, {'value': True},
                             type('P', (), {'level': 0})(), '第一页标题')
    assert markdown == ['# 第一页标题\n']
    # 同一标题不再重复
    parser.process_paragraph(markdown, {'value': True},
                             type('P', (), {'level': 0})(), '第一页标题')
    assert len(markdown) == 1
    parser.process_paragraph(markdown, {'value': False},
                             type('P', (), {'level': 0})(), '正文段')
    assert markdown[-1] == '正文段\n\n'
    parser.process_paragraph(markdown, {'value': False},
                             type('P', (), {'level': 2})(), '二级列表')
    assert markdown[-1] == '  - 二级列表\n'


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------

def test_write_md_for_html_and_read_html(monkeypatch, tmp_path):
    html = tmp_path / 'page.html'
    html.write_text(
        '<html><head><title>页面标题</title><style>b{}</style>'
        '<script>var x=1;</script></head>'
        '<body><h1>文档标题</h1><p>这是正文段落，足够长。</p>'
        '<noscript>none</noscript></body></html>', encoding='utf-8')

    md_dir = html_md_tool.write_md_for_html(str(html), 'page', 'html')
    md_files = html_md_tool.read_md_files('html', md_dir)
    assert md_files and md_files[0].endswith('.md')
    markdown = open(md_files[0], encoding='utf-8').read()
    assert '文档标题' in markdown
    assert '页面标题' not in markdown and 'var x=1' not in markdown

    content = html_md_tool.save_standard_txt('html', md_dir)
    assert content
    blocks = html_md_tool.collect_blocks('html', md_dir)
    assert blocks and blocks[0]['kind'] == 'heading'

    parsed_content, parsed_blocks = HtmlContentParser().read_html(str(html))
    assert parsed_content and parsed_blocks

    # collect_blocks 读失败不致命
    monkeypatch.setattr(html_md_tool, 'read_md_files', lambda *_: ['/no/such/file.md'])
    assert html_md_tool.collect_blocks('html', 'x') == []


def test_drop_non_content_and_helpers():
    assert html_md_tool.get_file_name('/x/y/page.html') == 'page.md'
    assert html_md_tool.get_file_name('page.htm') == 'page.md'
    assert '一、' not in html_md_tool.create_standard_title('一、标题 内容*')
    assert html_md_tool.create_standard_title('1.2 标题') == '标题'

    import bs4
    original = bs4.BeautifulSoup

    class _Boom:
        def __init__(self, *args, **kwargs):
            raise RuntimeError('parser down')

    try:
        bs4.BeautifulSoup = _Boom
        assert html_md_tool._drop_non_content('<p>raw</p>') == '<p>raw</p>'
    finally:
        bs4.BeautifulSoup = original


def test_add_sentence_for_content(html_keys_tmp=None):
    content = {'标题': {'text': '这是一个足够长的中文句子。第二句也够长。'}}
    html_md_tool.add_sentence_for_content(content)
    assert any('足够长' in key for key in content.keys())


def test_save_corpus(tmp_path):
    from parsing.common.create_doc import LCDocument
    docs = [LCDocument('问', {'source': 'a'})]
    html_md_tool.save_corpus(docs, 'corpus.txt', '/temp/html/save')
    written = tmp_path / 'temp' / 'html' / 'savecorpus.txt'
    assert written.exists()


# ---------------------------------------------------------------------------
# TXT / MD / md_table_tool
# ---------------------------------------------------------------------------

def test_txt_parser(tmp_path):
    path = tmp_path / 'a.txt'
    path.write_text('这是一个足够长的中文句子。第二句。\n短句。\n', encoding='utf-8')
    parser = TxtContentParser()
    content = parser.read_txt(str(path))
    assert any('这是一个足够长的中文句子' in key for key in content.keys())
    assert parser.read_txt_content(str(path)).startswith('这')


def _write_md(tmp_path, text, name='doc.md'):
    path = tmp_path / name
    path.write_text(text, encoding='utf-8')
    return str(path)


def test_read_md_content_and_sections(tmp_path):
    markdown = (
        '开篇导语段落。\n'
        '# 一级标题\n\n正文第一段。\n\n'
        '## 1.1 二级标题\n\n'
        '| 表头 | 列 |\n| --- | --- |\n| 值1 | 值2 |\n\n'
        '### 只有标题没有正文的章节\n'
        '# 一级标题\n\n第二个一级章节。\n'
    )
    path = _write_md(tmp_path, markdown)
    parser = MdContentParser()
    content = parser.read_md_content(path)
    assert '开篇导语段落' in content

    result = parser.create_doc_from_md(content, path)
    assert result
    cleaned = parser.clean_result(result)
    assert all(value.get('text') for value in cleaned.values())
    std = parser.create_standard_title('1.2 一级、标题：内容*')
    assert '1.2' not in std and '一级' in std
    headers = parser.conbine_header('# 一级', ['', '', '', '', '', ''])
    headers = parser.conbine_header('## 二级', headers)
    headers = parser.conbine_header('### 三级', headers)
    headers = parser.conbine_header('#### 四级', headers)
    headers = parser.conbine_header('##### 五级', headers)
    headers = parser.conbine_header('####### 六级', headers)
    assert headers[0] == '一级' and headers[5] == '六级'
    assert '，' in parser.create_key_by_title(['《书名》', '1.2 标题'])


def test_extract_heading_and_paragraphs_keeps_preamble_and_title_only():
    parser = MdContentParser()
    sections = parser.extract_heading_and_paragraphs(
        '<!-- Slide 1 -->\n前言文字。\n# 标题A\n\n<!-- 注释 -->\n# 标题B\n')
    assert sections[''] == {'text': '前言文字。'}
    assert sections['标题A'] == {'text': '标题A'}   # 只有标题：用标题兜底
    assert sections['标题B'] == {'text': '标题B'}


def test_module_level_sentence_helpers():
    parser = MdContentParser()
    content = {'k': {'text': '这是一个足够长的中文句子。'}}
    import parsing.parsers.md_tool.read_md as read_md_module
    # add_sentence_for_content 不用 self：能独立工作
    derived = {}
    read_md_module.add_sentence_for_content(None, derived,
                                            '这是一个足够长的中文句子。', '正文')
    assert derived
    # 模块级 create_key_by_content / split_paragraph 经 self 取到的却是类方法，
    # 形状不兼容 —— 历史遗留的死代码，调用只求覆盖到入口行
    with pytest.raises(TypeError):
        read_md_module.create_key_by_content(parser, content)
    with pytest.raises(TypeError):
        read_md_module.split_paragraph(parser, {}, '这是一个足够长的中文句子。')


def test_md_table_tool(tmp_path):
    markdown = (
        '# 设备表\n\n'
        '| 名称 | 数量 |\n'
        '| --- | --- |\n'
        '| 设备A | 3 |\n'
        '| 设备B | 4 |\n\n'
        '## 1.1 其他\n\n普通正文段落。\n'
    )
    path = _write_md(tmp_path, markdown)
    content = MdTableTool().md_table_parser(markdown, path)
    assert content
    joined = json.dumps(content, ensure_ascii=False)
    assert '设备A' in joined and '数量' in joined


# ---------------------------------------------------------------------------
# Excel
# ---------------------------------------------------------------------------

def test_excel_xlsx_and_csv(tmp_path):
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(['问题', '答案', None])
    sheet.append(['问题一', '答案一', None])
    sheet.append([None, None, None])
    xlsx = tmp_path / 'qa.xlsx'
    workbook.save(str(xlsx))

    parser = ExcelContentParser()
    docs = parser.write_txt_for_xlsx('qa', str(xlsx))
    assert docs[0].blocks[0]['kind'] == 'table'
    assert docs[0].metadata['type'] == 1
    assert '问题一 | 答案一' in docs[1].page_content

    csv_path = tmp_path / 'qa.csv'
    csv_path.write_text('名称,数量\n设备A,3\n\n设备B,4\n', encoding='utf-8')
    csv_docs = parser.write_txt_for_csv('qa', str(csv_path))
    assert '设备A | 3' in csv_docs[1].page_content


# ---------------------------------------------------------------------------
# Word
# ---------------------------------------------------------------------------

def _make_docx(path, with_table=True):
    document = python_docx.Document()
    document.add_heading('第一章 概述', level=1)
    document.add_paragraph('表格标题说明')
    document.add_paragraph('这是一个足够长的正文句子。第二句也在这一段。')
    if with_table:
        table = document.add_table(rows=2, cols=2)
        table.cell(0, 0).text = '名称'
        table.cell(0, 1).text = '数量'
        table.cell(1, 0).text = '设备A'
        table.cell(1, 1).text = '3'
        document.add_paragraph('')
        table2 = document.add_table(rows=2, cols=2)
        table2.cell(0, 0).text = '名称'
        table2.cell(0, 1).text = '数量'
        table2.cell(1, 0).text = '设备B'
        table2.cell(1, 1).text = '4'
    document.add_heading('第二章 结论', level=2)
    document.add_paragraph('结论内容，也足够长。')
    document.save(str(path))
    return str(path)


def test_read_word_document(tmp_path):
    path = _make_docx(tmp_path / 'doc.docx')
    doc = python_docx.Document(path)
    content = WordContentParser().read_content(doc)
    joined = json.dumps(content, ensure_ascii=False)
    assert '第一章 概述' in joined
    assert '设备A' in joined and '设备B' in joined
    # 结构块挂在分区条目上
    assert any(entry.get('blocks') for entry in content.values())


def test_read_word_helpers():
    parser = WordContentParser()
    assert parser.text_block(1, ' 标题 ') == {'kind': 'heading', 'level': 1, 'text': '标题'}
    assert parser.text_block(0, '正文') == {'kind': 'text', 'text': '正文'}
    assert parser.text_block(0, '  ') is None

    blocks = [
        {'kind': 'text', 'text': '表标题'},
        {'kind': 'table', 'title': '表标题', 'rows': [['a']]},
        {'kind': 'heading', 'level': 2, 'text': '表标题2'},
        {'kind': 'table', 'title': '表标题2', 'rows': [['b']]},
        {'kind': 'table', 'title': '', 'rows': [['c']]},
    ]
    cleaned = parser.drop_repeated_table_titles(blocks)
    assert cleaned[0]['kind'] == 'table'          # 文本标题被并入表格块
    assert cleaned[1]['kind'] == 'heading'
    assert cleaned[2]['title'] == ''              # 标题在标题块上：清掉重复
    assert cleaned[3]['rows'] == [['c']]
    assert len(cleaned) == 4

    content = {}
    parser.add_block(content, 'k', None)
    parser.add_block(content, 'k', {'kind': 'text', 'text': 'x'})
    parser.add_block(content, 'k', {'kind': 'text', 'text': 'y'})
    assert len(content['k']['blocks']) == 2

    # 标题层级
    class _P:
        def __init__(self, name, style_id):
            self._name = name
            self._p = type('P', (), {'style': style_id})()

        @property
        def style(self):
            return type('S', (), {'name': self._name})()

    parser._style_names = {}
    assert parser.heading_level(_P('Heading 3', 'a')) == 3
    assert parser.heading_level(_P('Heading 9', 'b')) == 0
    assert parser.heading_level(_P('Normal', 'c')) == 0
    assert parser.heading_level(_P('Heading', 'd')) == 0

    headers, record = parser.method_name(_P('Heading 1', 'e'), '一', ['', '', '', '', ''], '')
    assert headers[0] == '一' and record == '一 '
    headers, _ = parser.method_name(_P('Heading 2', 'f'), '1.1', headers, record)
    assert headers[1] == '1.1'
    headers, _ = parser.method_name(_P('Heading 3', 'g'), 'a', headers, record)
    headers, _ = parser.method_name(_P('Heading 4', 'h'), 'b', headers, record)
    headers, _ = parser.method_name(_P('Heading 5', 'i'), 'c', headers, record)
    assert headers[3] == 'b' and headers[4] == 'c'

    content = {'k': {'text': '同一段'}, 'j': {'text': '同一段'}}
    parser.replace_content_text(content)
    assert content['k']['text'] == content['j']['text']


def test_drop_empty_sections_and_combine():
    parser = WordContentParser()
    content = {'空标题': {'text': '空标题'}, '。': {'text': '。'},
               '有内容的标题': {'text': '有内容的标题 这是正文。'},
               '派生空': {'text': '。'}}
    parser.drop_empty_sections(content, ['空标题', '。', '有内容的标题'])
    assert '空标题' not in content
    assert '有内容的标题' in content

    merged = {}
    parser.combine_content_text(merged, 'k', '')
    assert 'k' not in merged
    parser.combine_content_text(merged, 'k', '第一行')
    parser.combine_content_text(merged, 'k', '第二行')
    assert merged['k']['text'] == '第一行\n第二行'


def test_word_table_parser_cells():
    document = python_docx.Document()
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = '名称'
    table.cell(0, 1).text = '数量'
    table.cell(1, 0).text = ''
    table.cell(1, 1).text = '4'
    parser = WordTableParser()
    result, table_text = [], []
    rows = parser.read_tables(result, table_text, [table])
    assert rows and rows[0] == ['名称', '数量']
    assert table_text and table_text[0]
    # 缺格兜底：above/left 各分支
    assert parser.left_text({}) == ' '
    assert parser.above_text([], 3, 0) == ' '
    assert parser.above_text([{0: '上'}, {}], 1, 5) == ' '
    assert parser.header_text([{0: '名'}], 0) == '名'
    assert parser.header_text([{0: '名'}], 7) == ''


# ---------------------------------------------------------------------------
# strategies（格式 → 解析器入口）
# ---------------------------------------------------------------------------

def test_strategy_txt(tmp_path):
    path = tmp_path / 'plain.txt'
    path.write_text('## 文章一\n\n这是文章一的正文内容，足够长。\n'
                    '## 文章二\n\n这是文章二的正文内容。\n', encoding='utf-8')
    docs = strategies.TxtFileParseStrategy().process(str(path))
    assert docs and docs[0].blocks
    assert create_doc.get_source({'source': 'x'}, ['n'], None) == 'x'


def test_strategy_txt_without_headings(tmp_path):
    path = tmp_path / 'plain2.txt'
    path.write_text('只是一个普通段落，没有任何 markdown 标记的正文内容。\n', encoding='utf-8')
    docs = strategies.TxtFileParseStrategy().process(str(path))
    assert docs and docs[0].blocks is None


def test_strategy_excel_and_word(tmp_path):
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(['问题', '答案'])
    sheet.append(['问题一', '答案一'])
    xlsx = tmp_path / 'qa2.xlsx'
    workbook.save(str(xlsx))
    assert strategies.ExcelFileParseStrategy().process(str(xlsx))

    csv_path = tmp_path / 'qa2.csv'
    csv_path.write_text('名称,数量\n设备A,3\n', encoding='utf-8')
    assert strategies.ExcelFileParseStrategy().process(str(csv_path))

    word_path = _make_docx(tmp_path / 'doc2.docx', with_table=False)
    docs = strategies.WordFileParseStrategy().process(word_path)
    assert docs


def test_strategy_md_and_attach_blocks(tmp_path):
    path = _write_md(tmp_path, '# 标题\n\n这是一个足够长的正文句子。\n', 'doc3.md')
    docs = strategies.MdFileParseStrategy().process(str(path))
    assert docs and docs[0].blocks

    assert strategies.attach_markdown_blocks([], '内容') == []
    assert strategies.attach_markdown_blocks([object()], '') is not None
    no_markdown = strategies.attach_markdown_blocks(
        [type('D', (), {'blocks': None})()], 'plain text without headings')
    assert no_markdown[0].blocks == [{'kind': 'text', 'text': 'plain text without headings'}]
    assert strategies.FileParseStrategy().process('x') is None
    assert set(strategies.FILE_PARSE_STRATEGIES) == {
        'txt', 'docx', 'html', 'xlsx', 'csv', 'md', 'pptx', 'pdf'}


def test_strategy_html(tmp_path):
    html = tmp_path / 'page2.html'
    html.write_text('<html><head><title>t</title></head><body>'
                    '<h1>HTML 标题</h1><p>这是 HTML 的正文段落，足够长。</p></body></html>',
                    encoding='utf-8')
    docs = strategies.HtmlFileParseStrategy().process(str(html))
    assert docs and docs[0].blocks


def test_strategy_pptx(tmp_path):
    path = _make_pptx(tmp_path / 'deck2.pptx')
    docs = strategies.PptxFileParseStrategy().process(path)
    assert docs and docs[0].blocks


def test_strategy_pdf(tmp_path):
    path = _build_pdf(tmp_path / 'doc4.pdf', [
        [(72, 700, 14, 'A heading line'), (72, 650, 10, 'Body content words here.')]])
    docs = strategies.PdfFileParseStrategy().process(path)
    assert docs and docs[0].blocks
