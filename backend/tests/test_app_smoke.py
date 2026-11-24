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


def test_auth_endpoints_are_mounted_under_the_api_prefix(client):
    status = client.get(f'{RKB_PREFIX}/auth/status')
    assert status.status_code == 200
    assert status.json()['mode'] == 'none'

    login = client.post(f'{RKB_PREFIX}/auth/login', json={})
    assert login.status_code == 409
    assert login.json()['code'] == 'auth_not_enabled'


def test_unknown_path_returns_problem_envelope(client):
    response = client.get(f'{RKB_PREFIX}/no/such/route')

    assert response.status_code == 404
    assert response.headers['content-type'].startswith('application/problem+json')
    body = response.json()
    assert body['code'] == 'not_found'
    assert body['type'].startswith('urn:openan:problem:')


def test_studio_routes_match_the_enabled_workspaces():
    from route_helpers import api_routes

    routes = [(route.path_format.removeprefix(RKB_PREFIX), route.methods)
              for route in api_routes(app)]
    operations = {(method, path) for path, methods in routes for method in methods}

    assert {
        ('GET', '/knowledge-bases'),
        ('POST', '/knowledge-bases/{kbase_id}/documents'),
        ('GET', '/graph-schemas'),
        ('POST', '/retrieval'),
        ('POST', '/retrieval/graph'),
        ('GET', '/workflows'),
        ('POST', '/query'),
        ('GET', '/models'),
        ('GET', '/operators/available'),
    } <= operations
    assert all(not path.startswith(('/agent', '/mcp', '/tasks')) for path, _methods in routes)
    assert all(method == 'GET' for method, path in operations if path.startswith('/operators'))
    assert routes[-1][0] == '/{unknown_path}'
