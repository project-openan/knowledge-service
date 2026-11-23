"""auth 剩余分支：repository 全量 SQL 面、bootstrap 落盘失败、service/会话边界、CLI。

不连 DB：repository._connection 打桩。
"""

from datetime import datetime, timedelta, timezone

import pytest

from auth import bootstrap
from auth import repository as repo
from auth import service
from auth import sessions
from auth import passwords
from auth import cli as auth_cli
from auth.errors import AuthError, AuthStoreUnavailable, user_not_found
from auth.middleware import AuthMiddleware, _plain_unauthorized, _route_path
from auth.models import AuthUser

USER = AuthUser(id=1, username='admin', email='', display_name='Administrator',
                role='admin', enabled=True, must_change_password=True)


# ---------------------------------------------------------------------------
# repository：SQL 面（打桩连接）
# ---------------------------------------------------------------------------

class _RepoCursor:
    def __init__(self, conn):
        self._conn = conn
        self.rowcount = conn.rowcount
        self.description = conn.description

    description = []

    def execute(self, sql, params=None):
        self._conn.executed.append((sql, params))
        if self._conn.raise_when_execute is not None:
            raise self._conn.raise_when_execute

    def fetchone(self):
        return self._conn.fetchone

    def fetchall(self):
        return self._conn.fetchall

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _RepoConn:
    def __init__(self, raise_when_execute=None):
        self.executed = []
        self.raise_when_execute = raise_when_execute
        self.fetchone = None
        self.fetchall = []
        self.rowcount = 1
        self.commits = 0
        self.description = []

    def cursor(self):
        return _RepoCursor(self)

    def commit(self):
        self.commits += 1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture()
def fake_repo_conn(monkeypatch):
    conn = _RepoConn()
    monkeypatch.setattr(repo, '_connection', lambda: conn)
    return conn


@pytest.fixture(autouse=True)
def _local_mode(monkeypatch):
    monkeypatch.setenv('AUTH_MODE', 'local')


def test_auth_repository_user_queries(fake_repo_conn):
    conn = fake_repo_conn
    conn.fetchone = ('admin',)
    assert repo.table_exists() is True
    conn.fetchone = (0,)
    assert repo.count_users() == 0
    conn.fetchone = None
    assert repo.find_user_by_login('x') is None
    assert repo.find_user_by_username('x') is None
    assert repo.get_user(9) is None
    conn.fetchall = [(1, 'u')]
    conn.description = [('id',), ('username',)]
    created = repo.create_user(username='user1', password_hash='h', display_name='U',
                               role='admin', must_change_password=True)
    assert created == {'id': 1, 'username': 'u'}
    conn.fetchall = []
    assert repo.list_users() == []
    assert repo.update_password(1, 'h2', must_change_password=False) == 1
    assert repo.set_enabled(1, False) == 1
    repo.touch_last_login(1)
    assert repo.delete_user(1) == 1
    executed = ' '.join(sql for sql, _ in conn.executed)
    assert 'DELETE FROM' in executed and 'last_login_at' in executed


def test_auth_repository_session_queries(fake_repo_conn):
    conn = fake_repo_conn
    conn.fetchone = (7,)
    assert repo.create_session(user_id=1, token_hash='h',
                               expires_at=datetime.now(timezone.utc),
                               ip='10.0.0.1', user_agent='ua') == 7
    conn.fetchall = [(3, 'u')]
    conn.description = [('session_id',), ('username',)]
    assert repo.find_session('h') == {'session_id': 3, 'username': 'u'}
    repo.touch_session(3)
    assert repo.revoke_session('h') == 1
    assert repo.revoke_user_sessions(1) == 1
    assert repo.revoke_user_sessions(1, except_token_hash='keep') == 1
    assert repo.delete_expired_sessions(datetime.now(timezone.utc)) == 1
    executed = ' '.join(sql for sql, _ in conn.executed)
    assert 'token_hash <> %s' in executed


def test_auth_repository_translates_missing_table(monkeypatch):
    class _Missing(Exception):
        pgcode = '42P01'

    conn = _RepoConn(raise_when_execute=_Missing('relation does not exist'))
    monkeypatch.setattr(repo, '_connection', lambda: conn)
    with pytest.raises(AuthStoreUnavailable):
        repo.count_users()


# ---------------------------------------------------------------------------
# bootstrap：密码文件落盘失败
# ---------------------------------------------------------------------------

def test_write_password_file_failure_returns_false(tmp_path):
    target = str(tmp_path / 'initial-admin')
    assert bootstrap._write_password_file(target, 'x') is True
    assert (tmp_path / 'initial-admin').read_text() == 'x\n'
    # 目录即路径：open 必失败
    assert bootstrap._write_password_file(str(tmp_path), 'x') is False


def test_bootstrap_generated_password_with_unwritable_file(monkeypatch, tmp_path, caplog):
    monkeypatch.setenv('AUTH_MODE', 'local')
    monkeypatch.setattr(repo, 'table_exists', lambda: True)
    monkeypatch.setattr(repo, 'count_users', lambda: 0)
    monkeypatch.delenv('RKB_ADMIN_PASSWORD', raising=False)
    monkeypatch.setenv('RKB_ADMIN_PASSWORD_FILE', str(tmp_path / 'initial-admin'))
    monkeypatch.setattr(bootstrap, '_write_password_file', lambda path, pwd: False)
    monkeypatch.setattr(service, 'create_user', lambda *a, **k: USER)
    assert bootstrap.ensure_initial_admin() is True


def test_bootstrap_configured_password_with_unwritable_file(monkeypatch, tmp_path):
    monkeypatch.setenv('AUTH_MODE', 'local')
    monkeypatch.setattr(repo, 'table_exists', lambda: True)
    monkeypatch.setattr(repo, 'count_users', lambda: 0)
    monkeypatch.setenv('RKB_ADMIN_PASSWORD', 'short')  # 弱口令：仅 bootstrap 允许
    monkeypatch.setattr(bootstrap, '_write_password_file', lambda path, pwd: False)
    captured = {}
    monkeypatch.setattr(service, 'create_user',
                        lambda username, password, **kwargs:
                        captured.update(password=password, **kwargs) or USER)
    assert bootstrap.ensure_initial_admin() is True
    assert captured['password'] == 'short'
    assert captured['allow_weak_password'] is True


def test_bootstrap_inspect_failure_is_swallowed(monkeypatch):
    monkeypatch.setenv('AUTH_MODE', 'local')
    monkeypatch.setattr(repo, 'table_exists', lambda: (_ for _ in ()).throw(RuntimeError('db')))
    assert bootstrap.ensure_initial_admin() is False


# ---------------------------------------------------------------------------
# service：登录/会话/改密边界
# ---------------------------------------------------------------------------

def _row(**overrides):
    row = {'id': 1, 'username': 'alice', 'email': None, 'display_name': 'Alice',
           'password_hash': passwords.hash_password('correct-password'),
           'role': 'user', 'enabled': True, 'must_change_password': False,
           'created_at': None, 'updated_at': None, 'last_login_at': None}
    row.update(overrides)
    return row


def test_login_unknown_user_runs_dummy_verify(monkeypatch):
    monkeypatch.setattr(repo, 'find_user_by_login', lambda login: None)
    recorded = []
    monkeypatch.setattr(service, '_record_failure',
                        lambda login, ip, reason: recorded.append(reason))
    from auth.errors import invalid_credentials
    monkeypatch.setattr(service, 'invalid_credentials', invalid_credentials)
    with pytest.raises(AuthError):
        service.login('ghost', 'pw', ip='127.0.0.1')
    assert recorded == ['unknown_user']


def test_login_missing_credentials(monkeypatch):
    recorded = []
    monkeypatch.setattr(service, '_record_failure',
                        lambda login, ip, reason: recorded.append(reason))
    with pytest.raises(AuthError):
        service.login('alice', '', ip='127.0.0.1')
    assert recorded == ['missing_credentials']


def test_login_rehashes_when_params_changed(monkeypatch):
    import base64
    import hashlib

    row = _row()
    # 伪造一个"旧参数"哈希：p=2（当前默认 p=1）——可校验，但参数与默认不同
    salt = b'S' * 16
    derived = hashlib.scrypt(b'correct-password', salt=salt, n=passwords.SCRYPT_N,
                             r=passwords.SCRYPT_R, p=2, dklen=passwords.SCRYPT_DKLEN,
                             maxmem=passwords.SCRYPT_MAXMEM)
    row['password_hash'] = '$'.join([
        'scrypt', str(passwords.SCRYPT_N), str(passwords.SCRYPT_R), '2',
        base64.b64encode(salt).decode('ascii'),
        base64.b64encode(derived).decode('ascii')])
    assert passwords.needs_rehash(row['password_hash'])
    monkeypatch.setattr(repo, 'find_user_by_login', lambda login: row)
    updated = {}
    monkeypatch.setattr(repo, 'update_password',
                        lambda uid, hash, **k: updated.update(uid=uid, **k))
    monkeypatch.setattr(repo, 'touch_last_login', lambda uid: None)
    monkeypatch.setattr(repo, 'create_session', lambda **k: 1)
    monkeypatch.setattr(repo, 'delete_expired_sessions', lambda before: 1)
    result = service.login('alice', 'correct-password', ip='127.0.0.1')
    assert result.user.username == 'alice'
    assert updated  # 参数升级触发重哈希


def test_login_session_cleanup_failure_is_swallowed(monkeypatch):
    row = _row()
    monkeypatch.setattr(repo, 'find_user_by_login', lambda login: row)
    monkeypatch.setattr(passwords, 'needs_rehash', lambda stored: False)
    monkeypatch.setattr(repo, 'touch_last_login', lambda uid: None)
    monkeypatch.setattr(repo, 'create_session', lambda **k: 1)
    def _boom(before):
        raise RuntimeError('db down')
    monkeypatch.setattr(repo, 'delete_expired_sessions', _boom)
    result = service.login('alice', 'correct-password', ip='127.0.0.1')
    assert result.token


def test_logout_swallows_failures(monkeypatch):
    service.logout('')  # 无 token：直接返回
    monkeypatch.setattr(repo, 'revoke_session',
                        lambda token_hash: (_ for _ in ()).throw(AuthStoreUnavailable()))
    service.logout('token')  # 表不可用：静默
    monkeypatch.setattr(repo, 'revoke_session',
                        lambda token_hash: (_ for _ in ()).throw(RuntimeError('x')))
    service.logout('token')


def test_validate_session_revokes_expired_and_disabled(monkeypatch):
    row = {'session_id': 3, 'id': 1, 'username': 'alice', 'email': None,
           'display_name': 'A', 'role': 'user', 'enabled': True,
           'must_change_password': False,
           'token_hash': sessions.hash_token('t'),
           'revoked_at': None,
           'expires_at': datetime.now(timezone.utc) - timedelta(seconds=1)}
    monkeypatch.setattr(repo, 'find_session', lambda token_hash: row)
    revoked = []
    monkeypatch.setattr(repo, 'revoke_session', lambda h: revoked.append('session'))
    with pytest.raises(AuthError):
        service.validate_session('t')

    row['expires_at'] = datetime.now(timezone.utc) + timedelta(hours=1)
    row['enabled'] = False
    monkeypatch.setattr(repo, 'revoke_user_sessions', lambda uid, **k: revoked.append('user'))
    with pytest.raises(AuthError):
        service.validate_session('t')
    assert revoked == ['session', 'user']


def test_maybe_touch_throttles(monkeypatch):
    touched = []
    monkeypatch.setattr(repo, 'touch_session', lambda sid: touched.append(sid))
    service._maybe_touch('hash', 5, service._now())
    first_count = len(touched)
    service._maybe_touch('hash', 5, service._now())  # 间隔内不重复打点
    assert len(touched) == first_count


def test_change_password_wrong_current(monkeypatch):
    user = USER
    monkeypatch.setattr(repo, 'get_user', lambda uid: _row())
    with pytest.raises(AuthError):
        service.change_password(user, 'wrong', 'New-password-123', current_token='t')
    monkeypatch.setattr(repo, 'get_user', lambda uid: None)
    with pytest.raises(AuthError):
        service.change_password(user, 'x', 'New-password-123')


def test_change_password_success_removes_bootstrap_file(monkeypatch, tmp_path):
    password_file = tmp_path / 'initial-admin-password'
    password_file.write_text('secret', encoding='utf-8')
    monkeypatch.setenv('RKB_ADMIN_PASSWORD_FILE', str(password_file))
    monkeypatch.setattr(repo, 'get_user', lambda uid: _row())
    monkeypatch.setattr(repo, 'update_password', lambda uid, h, **k: 1)
    monkeypatch.setattr(repo, 'revoke_user_sessions', lambda uid, **k: 1)
    service.change_password(USER, 'correct-password', 'New-password-123',
                            current_token='t')
    assert not password_file.exists()


def test_change_password_revoke_failure_is_swallowed(monkeypatch):
    monkeypatch.setattr(repo, 'get_user', lambda uid: _row())
    monkeypatch.setattr(repo, 'update_password', lambda uid, h, **k: 1)

    def _boom(uid, **k):
        raise RuntimeError('x')
    monkeypatch.setattr(repo, 'revoke_user_sessions', _boom)
    service.change_password(USER, 'correct-password', 'New-password-123')


def test_remove_bootstrap_file_failure_is_logged(monkeypatch, caplog):
    monkeypatch.setenv('RKB_ADMIN_PASSWORD_FILE', '/proc/nope/initial-admin')
    service._remove_bootstrap_password_file()  # 不存在 → 静默返回


def test_user_admin_operations(monkeypatch):
    row = _row()
    monkeypatch.setattr(repo, 'find_user_by_username', lambda username: None)
    with pytest.raises(AuthError):
        service.reset_password('ghost', 'New-password-123')
    with pytest.raises(AuthError):
        service.set_enabled('ghost', True)
    with pytest.raises(AuthError):
        service.delete_user('ghost')

    monkeypatch.setattr(repo, 'find_user_by_username', lambda username: row)
    monkeypatch.setattr(repo, 'update_password', lambda uid, h, **k: 1)
    monkeypatch.setattr(repo, 'revoke_user_sessions', lambda uid, **k: 1)
    updated = service.reset_password('alice', 'New-password-123',
                                     must_change_password=False)
    assert updated.username == 'alice'
    monkeypatch.setattr(repo, 'set_enabled', lambda uid, enabled: 1)
    monkeypatch.setattr(repo, 'get_user', lambda uid: row)
    assert service.set_enabled('alice', False).username == 'alice'
    monkeypatch.setattr(repo, 'delete_user', lambda uid: 1)
    service.delete_user('alice')


def test_create_user_rejects_bad_role_and_weak_bootstrap_password(monkeypatch):
    from auth.errors import password_policy
    with pytest.raises(AuthError):
        service.create_user('user1', 'Strong-password-1', role='root')
    with pytest.raises(AuthError):
        service.create_user('user1', '   ', allow_weak_password=True)
    monkeypatch.setattr(repo, 'create_user', lambda **k: _row())
    user = service.create_user('user1', 'weak', allow_weak_password=True,
                               must_change_password=True)
    assert user.username == 'alice'


# ---------------------------------------------------------------------------
# middleware / sessions
# ---------------------------------------------------------------------------

class _MiddlewareRequest:
    def __init__(self, path='/', root='', headers=None, cookies=None, method='GET'):
        self.url = type('U', (), {'path': path})()
        self.scope = {'root_path': root}
        self.headers = headers or {}
        self.cookies = cookies or {}
        self.method = method


def test_route_path_strips_root_path():
    assert _route_path(_MiddlewareRequest('/api/v1/kb', '/api/v1')) == '/kb'
    assert _route_path(_MiddlewareRequest('/kb')) == '/kb'
    assert _route_path(_MiddlewareRequest('/api/v1', '/api/v1')) == '/'


def test_plain_unauthorized_is_json():
    response = _plain_unauthorized()
    assert response.status_code == 401


def test_middleware_set_log_path(tmp_path):
    AuthMiddleware.set_log_path(str(tmp_path / 'logs'))
    AuthMiddleware.set_log_path(None)  # 空值不建目录
    assert (tmp_path / 'logs').exists()


def test_sessions_client_ip_and_origin():
    assert sessions.client_ip({'x-real-ip': '1.2.3.4, 5'}, 'fb') == '1.2.3.4'
    assert sessions.client_ip({}, ' fallback ') == 'fallback'
    assert sessions.client_ip({}, '') == ''

    host = {'host': 'svc:8000'}
    assert sessions.origin_allowed(host, required=True) is False
    assert sessions.origin_allowed(host, required=False) is True
    assert sessions.origin_allowed({**host, 'origin': 'http://svc:8000'}, required=True) is True
    assert sessions.origin_allowed({**host, 'origin': 'null'}, required=False) is False
    assert sessions.origin_allowed({**host, 'origin': 'http://evil:1'}, required=False) is False
    assert sessions.origin_allowed({**host, 'referer': 'http://svc:8000/x'}, required=True) is True
    assert sessions.origin_allowed({**host, 'referer': 'http://evil/x'}, required=True) is False
    assert sessions.origin_allowed({**host, 'origin': '::::'}, required=True) is False


def test_clear_cookie_secure_attribute():
    secure = sessions.clear_session_cookie(secure=True)
    assert 'Secure' in secure
    assert 'Secure' not in sessions.clear_session_cookie(secure=False)


def test_extract_session_token():
    assert sessions.extract_session_token({sessions.COOKIE_NAME: ' t '}) == 't'
    assert sessions.extract_session_token({}) == ''
    assert sessions.extract_session_token(None) == ''


# ---------------------------------------------------------------------------
# passwords
# ---------------------------------------------------------------------------

def test_hash_password_requires_password():
    with pytest.raises(passwords.PasswordPolicyError):
        passwords.hash_password('')
    with pytest.raises(passwords.PasswordPolicyError):
        passwords.hash_password(None)


def test_verify_password_rejects_bad_formats():
    assert passwords.verify_password('x', 'not-a-hash') is False
    assert passwords.verify_password('x', 'md5$1$2$3$YQ$YQ') is False
    assert passwords.verify_password('x', 'scrypt$0$8$1$YQ$YQ') is False
    assert passwords.verify_password('x', 'scrypt$1024$8$1$YQ$YQ') is False
    assert passwords.verify_password('x', 'scrypt$1024$0$1$YQ$YQ') is False
    assert passwords.verify_password('x', 'scrypt$1024$8$1$YQ$YQ') is False  # 盐太短
    assert passwords.verify_password('', passwords.DUMMY_HASH) is False
    assert passwords.verify_password('x', 123) is False


def test_verify_password_round_trip():
    stored = passwords.hash_password('Secret-123')
    assert passwords.verify_password('Secret-123', stored)
    assert not passwords.verify_password('wrong', stored)
    assert passwords.needs_rehash(stored) is False
    # 旧参数 → 需要重哈希
    parts = stored.split('$')
    parts[1] = str(2 ** 8)
    assert passwords.needs_rehash('$'.join(parts))


# ---------------------------------------------------------------------------
# cli
# ---------------------------------------------------------------------------

def test_cli_password_generate_and_explicit(monkeypatch):
    generated, was_generated = auth_cli._password(None, generate=True)
    assert was_generated and generated
    explicit, was_generated2 = auth_cli._password('Explicit-123', generate=False)
    assert explicit == 'Explicit-123' and not was_generated2


def test_cli_unique_violation_and_db_error(monkeypatch, capsys):
    from psycopg2 import errors as pg_errors
    import psycopg2

    monkeypatch.setattr(repo, 'list_users',
                        lambda: (_ for _ in ()).throw(pg_errors.UniqueViolation()))
    assert auth_cli.main(['list']) == 1
    assert '已存在' in capsys.readouterr().err

    monkeypatch.setattr(repo, 'list_users',
                        lambda: (_ for _ in ()).throw(psycopg2.Error('db down')))
    assert auth_cli.main(['list']) == 1
    assert '数据库错误' in capsys.readouterr().err


def test_cli_delete_requires_yes(monkeypatch, capsys):
    assert auth_cli.main(['delete', '--username', 'alice']) == 2
    assert '拒绝执行' in capsys.readouterr().err

    deleted = []
    monkeypatch.setattr(service, 'delete_user', lambda username: deleted.append(username))
    assert auth_cli.main(['delete', '--username', 'alice', '--yes']) == 0
    assert deleted == ['alice']
    assert 'deleted: alice' in capsys.readouterr().out


def test_cli_set_enabled_and_reset(monkeypatch, capsys):
    monkeypatch.setattr(service, 'set_enabled',
                        lambda username, enabled: AuthUser(
                            id=1, username=username, email='', display_name='',
                            role='user', enabled=enabled, must_change_password=False))
    assert auth_cli.main(['enable', '--username', 'alice']) == 0
    assert 'enabled: alice' in capsys.readouterr().out
    assert auth_cli.main(['disable', '--username', 'alice']) == 0

    monkeypatch.setattr(service, 'reset_password',
                        lambda username, password, must_change_password=True: AuthUser(
                            id=1, username=username, email='', display_name='',
                            role='user', enabled=True,
                            must_change_password=must_change_password))
    assert auth_cli.main(['reset-password', '--username', 'alice',
                          '--password', 'New-password-123']) == 0
    out = capsys.readouterr().out
    assert 'must_change_password: true' in out

    assert auth_cli.main(['reset-password', '--username', 'alice',
                          '--password', 'New-password-123', '--no-must-change']) == 0
    out = capsys.readouterr().out
    assert 'must_change_password' not in out
