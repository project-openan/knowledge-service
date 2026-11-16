"""Initialize configured built-in operators."""

from __future__ import annotations

from infrastructure.logging.logutil import log
from operators.repository import operator_store
from operators.service import operator_import, operator_service

#: Built-in operator definitions and their template archives.
DEFAULT_OPERATORS: tuple = ()

#: 播种者身份。``operator.created_by`` 是普通字符串列，固定值便于排查。
SEEDED_BY = 'system'


def ensure_default_operators() -> list:
    """播种缺位的内置算子，返回本次导入的行（日志与测试用）；重复调用幂等。"""
    seeded = []
    for spec in DEFAULT_OPERATORS:
        operator_id = spec['id']
        try:
            if operator_store.select_by_id(operator_id) is not None:
                continue
            content = (operator_import.TEMPLATE_DIR / spec['filename']).read_bytes()
            row = operator_service.import_operator(
                spec['filename'], content, SEEDED_BY, '', 'zh',
                operator_id=operator_id, system=True)
            seeded.append(row)
            log.info('seeded default operator id=%s module=%s name=%s',
                     operator_id, spec['module'], row.get('name'))
        except Exception:                                              # noqa: BLE001
            log.exception('failed to seed default operator id=%s', operator_id)
    return seeded
