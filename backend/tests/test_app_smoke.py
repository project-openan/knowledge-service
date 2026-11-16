"""Smoke tests for application assembly, health and fallback responses."""

import pytest
from fastapi.testclient import TestClient

from app import app
from shared.prefixes import RKB_PREFIX


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv('AUTH_MODE', 'none')
    return TestClient(app, raise_server_exceptions=False)


def test_app_boots_and_health_is_public_text(client):
    response = client.get(f'{RKB_PREFIX}/health')

    assert response.status_code == 200
    assert response.text == 'ok'


def test_unknown_path_returns_problem_envelope(client):
    response = client.get(f'{RKB_PREFIX}/no/such/route')

    assert response.status_code == 404
    assert response.headers['content-type'].startswith('application/problem+json')
    body = response.json()
    assert body['code'] == 'not_found'
    assert body['type'].startswith('urn:openan:problem:')


def test_excluded_capability_surfaces_are_not_registered(client):
    """MCP/Agent/chat/model/graph 路由面不得存在于公开装配（合规门禁的行为面）。"""
    from route_helpers import api_routes

    paths = {route.path_format for route in api_routes(app)}

    assert f'{RKB_PREFIX}/query' not in paths
    assert f'{RKB_PREFIX}/mcp' not in paths
    assert f'{RKB_PREFIX}/agent-keys' not in paths
    assert not any(p.startswith(f'{RKB_PREFIX}/agent') for p in paths)
    assert not any('/models' in p for p in paths if p.startswith(RKB_PREFIX))
    assert f'{RKB_PREFIX}/retrieval/graph' not in paths
