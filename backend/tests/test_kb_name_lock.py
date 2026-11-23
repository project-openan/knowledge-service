"""``knowledge_base.name_lock``：建库名称锁的两级锁语义。

用真实锁文件（tmp_path）验证 flock 的互斥与超时；释放失败只告警不抛。

跑法（服务目录下）::

    python -m pytest tests/test_kb_name_lock.py -q
"""

from __future__ import annotations

import fcntl
import threading

import pytest

from knowledge_base import name_lock


@pytest.fixture()
def lock_dir(tmp_path, monkeypatch):
    monkeypatch.setenv(name_lock.ENV_LOCK_DIR, str(tmp_path / '.locks'))
    return tmp_path / '.locks'


def test_build_lock_key_and_file_name():
    assert name_lock.build_lock_key('org', '名称') == 'org:名称'
    assert name_lock.build_lock_key(None, None) == ':'

    # base64url 去掉 padding；同输入同文件名
    first = name_lock.build_lock_file_name('org', '名称')
    second = name_lock.build_lock_file_name('org', '名称')
    assert first == second
    assert first.startswith('lock_') and first.endswith('.lock')
    assert '=' not in first
    # 不同输入不同文件名
    assert name_lock.build_lock_file_name('org', 'a') != \
        name_lock.build_lock_file_name('org', 'b')


def test_lock_dir_env_override_and_default(lock_dir, monkeypatch):
    assert name_lock.lock_dir() == lock_dir

    monkeypatch.delenv(name_lock.ENV_LOCK_DIR, raising=False)
    from infrastructure.storage import kb_storage as storage
    assert name_lock.lock_dir() == storage.storage_root() / '.locks'

    monkeypatch.setenv(name_lock.ENV_LOCK_DIR, '   ')          # 空白视同未设置
    assert name_lock.lock_dir() == storage.storage_root() / '.locks'


def test_acquire_creates_and_releases_lock_file(lock_dir):
    with name_lock.acquire('org', 'kb', timeout_ms=1000):
        files = list(lock_dir.glob('*.lock'))
        assert len(files) == 1

    # 释放后可立即再次获取（锁文件保留，不 unlink）
    with name_lock.acquire('org', 'kb', timeout_ms=1000):
        pass


def test_acquire_serializes_same_key_in_process(lock_dir):
    """进程内二级锁：同 key 的并发获取会排队（第二个等到第一个释放）。"""
    order = []
    first_acquired = threading.Event()
    release_first = threading.Event()

    def first():
        with name_lock.acquire('org', 'kb', timeout_ms=5000):
            order.append('first-in')
            first_acquired.set()
            release_first.wait(5)
            order.append('first-out')

    def second():
        first_acquired.wait(5)
        with name_lock.acquire('org', 'kb', timeout_ms=5000):
            order.append('second-in')

    t1 = threading.Thread(target=first)
    t2 = threading.Thread(target=second)
    t1.start()
    t2.start()
    release_first.set()
    t1.join(10)
    t2.join(10)

    assert order.index('second-in') > order.index('first-out')


def test_acquire_times_out_when_file_lock_is_held(lock_dir):
    """跨"进程"（同进程另一个 fd）持锁时：非阻塞 flock 失败 → 轮询到超时。"""
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_path = lock_dir / name_lock.build_lock_file_name('org', 'kb')
    holder = open(lock_path, 'a+b')
    fcntl.flock(holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    with pytest.raises(name_lock.NameLockAcquireException) as caught:
        with name_lock.acquire('org', 'kb', timeout_ms=120, retry_interval_ms=30):
            pass                                                # 拿不到锁，进不了 with 体

    assert 'file lock timeout' in str(caught.value)
    fcntl.flock(holder.fileno(), fcntl.LOCK_UN)
    holder.close()

    # 持有者释放后可以拿到
    with name_lock.acquire('org', 'kb', timeout_ms=1000):
        pass


def test_acquire_times_out_on_in_process_lock(lock_dir, monkeypatch):
    """进程内锁被占：jvm_lock.acquire 超时 → NameLockAcquireException。"""
    holder = name_lock._jvm_lock(name_lock.build_lock_key('org', 'kb'))
    assert holder.acquire(timeout=1)

    with pytest.raises(name_lock.NameLockAcquireException) as caught:
        with name_lock.acquire('org', 'kb', timeout_ms=100):
            pass

    assert 'jvm lock timeout' in str(caught.value)
    holder.release()


def test_acquire_releases_everything_on_body_exception(lock_dir):
    with pytest.raises(RuntimeError):
        with name_lock.acquire('org', 'kb', timeout_ms=1000):
            raise RuntimeError('boom')

    with name_lock.acquire('org', 'kb', timeout_ms=1000):      # 锁已释放
        pass


def test_release_failures_are_only_logged(lock_dir, monkeypatch):
    """flock 解锁 / close / jvm 释放失败都只告警，不让 with 语句抛错。"""
    calls = []
    real_flock = fcntl.flock

    def flaky_flock(fd, operation):
        if operation == fcntl.LOCK_UN:
            calls.append('unlock-failed')
            raise OSError('unlock boom')
        return real_flock(fd, operation)

    monkeypatch.setattr(name_lock.fcntl, 'flock', flaky_flock)

    class _FlakyLock:
        def acquire(self, timeout=None):
            return True

        def release(self):
            calls.append('release-failed')
            raise RuntimeError('release boom')

    monkeypatch.setattr(name_lock, '_jvm_lock', lambda key: _FlakyLock())

    with name_lock.acquire('org', 'kb', timeout_ms=1000):
        pass                                                   # 不抛

    assert calls == ['unlock-failed', 'release-failed']


def test_close_failure_is_only_logged(lock_dir, monkeypatch):
    real_open = open

    class _FlakyFile:
        def __init__(self, handle):
            self._handle = handle

        def fileno(self):
            return self._handle.fileno()

        def close(self):
            raise OSError('close boom')

    def fake_open(*args, **kwargs):
        return _FlakyFile(real_open(*args, **kwargs))

    monkeypatch.setattr('builtins.open', fake_open)

    with name_lock.acquire('org', 'kb', timeout_ms=1000):
        pass                                                   # close 失败不上抛


def test_jvm_lock_registry_reuses_lock_per_key():
    first = name_lock._jvm_lock('k1')
    second = name_lock._jvm_lock('k1')
    other = name_lock._jvm_lock('k2')

    assert first is second
    assert first is not other
