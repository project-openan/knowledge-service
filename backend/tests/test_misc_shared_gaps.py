"""shared 模块剩余分支：CorpusProcessException、MessageFormat 引号规则、problem 兜底。"""

from shared.errors import api as api_errors
from shared.errors.corpus_process import CorpusProcessException
from shared.errors.exception import EMException
from shared.i18n import messages as messages_module
from shared import problem as problem_module
from shared.problem import ApiError, resolve_problem, spec_for_status


# ---------------------------------------------------------------------------
# CorpusProcessException（整文件此前 0 覆盖）
# ---------------------------------------------------------------------------

def test_corpus_process_exception_carries_code_and_args():
    error = CorpusProcessException('0006', 'a.txt', 3)

    assert error.get_errcode() == '0006'
    assert error.get_args() == ('a.txt', 3)
    # 没有 __str__ 覆写：回落 Exception 默认（args 元组）
    assert str(error) == "('a.txt', 3)"


# ---------------------------------------------------------------------------
# EMException.__str__
# ---------------------------------------------------------------------------

def test_em_exception_str_is_errcode():
    assert str(EMException('request-embedding-failed')) == 'request-embedding-failed'
    assert EMException('x', 1).get_args() == (1,)


# ---------------------------------------------------------------------------
# MessageFormat 的引号规则（``''`` → ``'``、``'...'`` → 内容）
# ---------------------------------------------------------------------------

def test_message_render_strips_single_quote_escapes():
    # 引号规则只在**带参数**时生效（无参直接返回模板）
    text = messages_module.render('RetCode.graph.edge.direction.invalid', 'zh', 'x')
    assert "必须是'out" not in text
    assert text == '边方向必须是out或in：x'


def test_message_render_without_args_keeps_template_verbatim():
    text = messages_module.render('kbase.name.validation', 'zh')
    # 无参：不进 MessageFormat，模板里的引号原样保留
    assert "下划线'_'" in text


def test_message_format_quotes_doubled_and_unclosed():
    quotes = messages_module._message_format_quotes
    assert quotes("a''b") == "a'b"
    assert quotes("x'y'z") == 'xyz'
    assert quotes("tail'") == 'tail'
    assert quotes('no quotes') == 'no quotes'


def test_message_format_arg_only_groups_int():
    fmt = messages_module._format_arg
    assert fmt(99999) == '99,999'
    assert fmt(True) is True
    assert fmt(1.5) == 1.5
    assert fmt('raw') == 'raw'


def test_message_render_returns_template_when_args_mismatch():
    # 参数个数对不上（IndexError）：返回带占位符的原文案
    text = messages_module.render('kbase.name.lock.timeout', 'zh', 1, 2)
    assert text == '知识库名称检查繁忙，请稍后重试'


# ---------------------------------------------------------------------------
# problem 兜底分支
# ---------------------------------------------------------------------------

def test_spec_for_status_unmapped_statuses():
    assert spec_for_status(599).code == 'internal_error'
    spec = spec_for_status(418)
    assert spec.status == 418
    assert spec.code == 'http_error'
    assert spec_for_status(404).code == 'not_found'


def test_resolve_problem_priority_branches():
    # 显式 status + problem_code 最优先
    spec = resolve_problem(status=409, problem_code='task_conflict')
    assert spec.status == 409 and spec.code == 'task_conflict'
    # 只有 problem_code：用 default_status
    spec = resolve_problem(problem_code='operator_not_found')
    assert spec.status == 400
    # key 命中 KEY_SPECS
    spec = resolve_problem(key='kbase.name.validation')
    assert spec.status == 422
    # literal 命中精确表
    spec = resolve_problem(literal='知识库不存在')
    assert spec.code == 'knowledge_base_not_found'
    # literal 命中前缀表
    spec = resolve_problem(literal='算子不存在: abc')
    assert spec.code == 'operator_not_found'
    # 机器码兜底
    assert resolve_problem(error_code='0001').code == 'internal_error'
    assert resolve_problem(error_code='0004').code == 'validation_failed'
    assert resolve_problem(error_code='1001').code == 'file_name_conflict'
    # 全不命中：默认规格
    spec = resolve_problem()
    assert spec.status == 400 and spec.code == 'bad_request'


# ---------------------------------------------------------------------------
# ApiError / KbValidatorError / KbApiError 的渲染分支
# ---------------------------------------------------------------------------

def test_api_error_render_defaults_to_none():
    error = ApiError('some.key')
    assert error.render('zh') is None
    assert error.literal_message() is None


def test_kb_validator_error_renders_none_without_key():
    error = api_errors.KbValidatorError(None)
    assert error.render('zh') is None


def test_kb_validator_error_renders_via_validator_catalog():
    error = api_errors.KbValidatorError('validator.max', 10000)
    assert error.render('zh') == '最大不能超过10000'
    assert error.render('en') == 'must be less than or equal to 10000'


def test_kb_permission_error_uses_403():
    error = api_errors.KbPermissionError('kbase.name.validation')
    assert error.status == 403
    assert error.problem_spec().code == 'permission_denied'


def test_kb_literal_error_returns_literal_message():
    error = api_errors.KbLiteralError('这句是字面量')
    assert error.render('zh') == '这句是字面量'
    assert error.literal_message() == '这句是字面量'


def test_problem_module_exported_helpers_exist():
    # 防止 re-export 面被误删（shared.errors.problem 是给 http 层用的门面）
    assert problem_module.resolve_problem is resolve_problem
