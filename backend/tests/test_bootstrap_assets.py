"""空卷启动资产的形状测试。

校验基础表、Studio 新增表与 Compose 初始化目录一致。

跑法::

    python -m pytest tests/test_bootstrap_assets.py -q
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCHEMA = REPO / 'deploy' / 'init' / 'pg' / '00-schema.sql'
STUDIO_SCHEMA = SCHEMA.with_name('04-studio-schema.sql')
COMPOSE = REPO / 'deploy' / 'docker-compose.yml'


def test_schema_snapshot_exists_and_has_core_objects():
    text = SCHEMA.read_text(encoding='utf-8')
    assert 'CREATE SCHEMA IF NOT EXISTS kb_index' in text
    for table in ('kb_kbase', 'kb_directory', 'kb_node_relation', 'operator'):
        assert f'CREATE TABLE public.{table}' in text
    assert 'kb_kbase_kbase_id_uidx' in text
    assert 'kb_node_relation_kbase_node_uidx' in text


def test_studio_schema_adds_the_enabled_domains():
    text = STUDIO_SCHEMA.read_text(encoding='utf-8')
    for table in ('graph_schema', 'graph_registry', 'flow_workflow',
                  'flow_draft', 'flow_release', 'model_registry', 'chat_query_trace'):
        assert f'CREATE TABLE public.{table}' in text
    assert 'idx_chat_query_trace_created' in text
    assert 'agent_api_key' not in text


def test_default_compose_mounts_init_pg():
    text = COMPOSE.read_text(encoding='utf-8')
    assert './init/pg:/docker-entrypoint-initdb.d:ro' in text
