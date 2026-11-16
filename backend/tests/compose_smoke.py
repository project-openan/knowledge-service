"""Exercise a fresh service installation through its HTTP API."""

import os
import secrets

import requests


def request(session, method, path, status, **kwargs):
    url = f'http://localhost:8091/api/knowledge-service/v1{path}'
    response = session.request(method, url, timeout=20, **kwargs)
    if response.status_code != status:
        raise RuntimeError(f'{method} {path}: expected {status}, got '
                           f'{response.status_code}: {response.text[:500]}')
    return response


def main():
    with requests.Session() as session:
        session.headers['Origin'] = 'http://localhost:8091'
        assert request(session, 'GET', '/health', 200).text == 'ok'

        initial_password = os.environ['RKB_ADMIN_PASSWORD']
        new_password = secrets.token_urlsafe(24) + 'A1!'
        request(session, 'POST', '/auth/login', 200,
                json={'username': 'admin', 'password': initial_password})
        request(session, 'POST', '/auth/password', 204,
                json={'currentPassword': initial_password, 'newPassword': new_password})
        request(session, 'POST', '/auth/login', 200,
                json={'username': 'admin', 'password': new_password})

        knowledge_base = request(session, 'POST', '/knowledge-bases', 201,
                                 json={'name': 'Knowledge service smoke test', 'props': {}})
        kbase_path = '/knowledge-bases/' + knowledge_base.json()['id']
        request(session, 'GET', kbase_path, 200)
        request(session, 'GET', f'{kbase_path}/directories', 200)
        request(session, 'DELETE', kbase_path, 204)
    print('Compose smoke test passed')


if __name__ == '__main__':
    main()
