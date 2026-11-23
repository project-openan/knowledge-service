"""`t_query_trace` 的 DDL 快照/迁移注册/清理阈值一致性。"""
from __future__ import annotations

import re
from pathlib import Path

from chat import schema

REPO = Path(__file__).resolve().parents[2]
SCHEMA_SQL = REPO / 'deploy' / 'init' / 'pg' / '04-studio-schema.sql'


def test_schema_constants_are_stable():
    assert schema.TABLE_NAME == 'chat_query_trace'
    assert schema.STATUS_VALUES == ('ok', 'error', 'client_disconnect')
    assert schema.COLUMN_NAMES[0] == 'trace_id'
    assert schema.COLUMN_NAMES[-1] == 'top_score'
    assert 'created_at' not in schema.COLUMN_NAMES
    assert len(schema.CREATE_INDEX_STATEMENTS) == len(schema.INDEX_NAMES) == 5


def test_sql_snapshot_mirrors_the_table_and_indexes():
    text = SCHEMA_SQL.read_text(encoding='utf-8')
    assert re.search(r'CREATE TABLE (?:IF NOT EXISTS )?public\.chat_query_trace', text)
    for index_name in schema.INDEX_NAMES:
        assert index_name in text
    for column in schema.COLUMN_NAMES:
        assert re.search(rf'\b{column}\b', text), column
