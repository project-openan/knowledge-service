"""``operator_api``（自定义算子的公开插件接口 v2）。

这个包是**对外契约**：自定义算子只允许 import 标准库与 ``operator_api.*``。
用例钉住的是接口形状 —— 函数签名、返回对象、日志前缀 —— 而不是实现细节；
``llm`` / ``graph`` 只验「再导出」的符号表，别在这里测网关行为。

跑法（服务目录下）::

    python -m pytest tests/test_operator_api_contract.py -q
"""

import logging

import pytest

import operator_api
from operator_api import graph as operator_graph
from operator_api import llm as operator_llm
from operator_api import storage, types
from operator_api.llm import check_status_code_ok
from operator_api.logging import TxPrefixedLogger, build_prefix


# ----------------------------------------------------------------------
# 包级契约
# ----------------------------------------------------------------------


def test_interface_version_is_exported():
    """插件元数据里的接口版本；不兼容变更时要 bump。"""
    assert operator_api.INTERFACE_VERSION == '2.0'
    assert operator_api.__all__ == ['graph', 'llm', 'logging', 'storage', 'types']


def test_submodules_are_reachable_from_the_package():
    """graph / llm 是「稳定导入面」：真身分别住在 ingestion.client 与 model。

    ⚠️ 这里的模块对象在**收集期**就绑定好了（模块级 import）：既有用例
    ``test_graph_extract_country_groups.py`` 会在运行期用
    ``sys.modules.setdefault`` 塞进同名桩模块且**全程不清理**，函数内再
    import 拿到的就是桩 —— 所以契约断言必须钉住收集期的真模块。
    """
    assert operator_graph.GraphChecker.__module__ == 'ingestion.client.graph_checker'
    assert operator_graph.GraphProcess.__module__ == 'ingestion.client.graph_process'
    assert 'invoke_llm' in operator_llm.__all__
    assert operator_llm.MODEL_GATEWAY_CHAT_PATH.startswith('/')


# ----------------------------------------------------------------------
# types
# ----------------------------------------------------------------------


def test_chunk_type_declares_required_keys():
    """``Chunk`` 的必填键：content + metadata（TypedDict 注释即契约）。"""
    assert set(types.Chunk.__annotations__) == {'content', 'metadata'}
    # metadata 的两个键是可选的（total=False）
    assert set(types.ChunkMetadata.__annotations__) == {'source', 'content_expand'}
    assert types.OperatorResult == list[types.Chunk]


# ----------------------------------------------------------------------
# logging
# ----------------------------------------------------------------------


def test_build_prefix_only_when_tx_present():
    assert build_prefix('tx-1') == '[tx-1] >>> '
    assert build_prefix(None) == ''
    assert build_prefix('') == ''


def test_prefixed_logger_writes_all_levels(caplog):
    caplog.set_level(logging.DEBUG, logger='root')
    logger = TxPrefixedLogger('tx-9')

    logger.debug('d')
    logger.info('i')
    logger.warning('w')
    logger.error('e')

    for record in caplog.records:
        assert record.message.startswith('[tx-9] >>> ')
    assert any(record.levelno == logging.ERROR for record in caplog.records)


def test_prefixed_logger_without_tx_has_no_prefix(caplog):
    caplog.set_level(logging.INFO, logger='root')

    TxPrefixedLogger(None).info('plain')

    assert caplog.records[0].message == 'plain'


def test_exception_method_accepts_message_and_exception(caplog):
    caplog.set_level(logging.ERROR, logger='root')
    logger = TxPrefixedLogger('tx-1')

    logger.exception('boom text')
    assert 'boom text' in caplog.records[0].message

    # 传异常对象也行：取 ``str(exception)`` 当文案
    caplog.clear()
    try:
        raise ValueError('bad value')
    except ValueError:
        logger.exception(ValueError('bad value'))
    assert 'bad value' in caplog.records[0].message
    # 处于异常处理上下文时 ``_logging.exception`` 会带上堆栈
    assert caplog.records[0].exc_info is not None


# ----------------------------------------------------------------------
# storage
# ----------------------------------------------------------------------


def test_storage_round_trips_bytes_and_text(tmp_path):
    target = storage.write_bytes(tmp_path / 'nested' / 'dir' / 'blob.bin', b'\x00\x01')
    assert target == tmp_path / 'nested' / 'dir' / 'blob.bin'
    assert storage.read_bytes(target) == b'\x00\x01'

    text_target = storage.write_text(tmp_path / 'nested' / 'doc.txt', '内容')
    assert storage.read_text(text_target) == '内容'


def test_storage_text_encoding_is_configurable(tmp_path):
    target = tmp_path / 'gbk.txt'
    storage.write_text(target, '内容', encoding='gbk')

    assert storage.read_text(target, encoding='gbk') == '内容'
    assert target.read_bytes() != '内容'.encode('utf-8')


# ----------------------------------------------------------------------
# llm 再导出
# ----------------------------------------------------------------------


def test_check_status_code_ok_accepts_2xx_and_boundary():
    # ``check_status_code_ok`` 在模块级绑定（理由见上面的 test_submodules 用例）
    check_status_code_ok(200, 'svc')
    check_status_code_ok(204, 'svc')
    check_status_code_ok(300, 'svc')            # 上界是 300（含）


@pytest.mark.parametrize('status', [199, 302, 400, 404, 429, 500])
def test_check_status_code_ok_rejects_out_of_range(status, caplog):
    with pytest.raises(RuntimeError) as excinfo:
        check_status_code_ok(status, 'model-gateway')

    assert f'request model-gateway failed for bad status code: {status}' in str(excinfo.value)
    assert any(record.levelno == logging.WARNING for record in caplog.records)
