"""存储域剩余分支：对象键规则、后端错误分类、物化与临时文件清理、注册表对账。"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

import pytest

from infrastructure.storage import backend as backend_module
from infrastructure.storage import kb_storage as storage
from infrastructure.storage import keys
from infrastructure.storage.backend import (
    LocalBackend,
    MinioBackend,
    _error_code,
    _is_missing,
    _normalize_prefix,
    backend_name,
    normalize_key,
    open_source,
    reset_storage_backend,
    scratch_root,
    set_storage_backend,
    storage_backend,
)
from infrastructure.storage import registry as store_registry


@pytest.fixture(autouse=True)
def _reset_backend():
    reset_storage_backend()
    yield
    reset_storage_backend()


FILE_ID = '761c359fc9154f8aa8e27f61e8506920'

# ---------------------------------------------------------------------------
# keys：对象键规则与分量校验
# ---------------------------------------------------------------------------

def test_keys_component_validation_and_layouts():
    assert keys.validate_component('abc') == 'abc'
    assert keys.core_key(FILE_ID) == f'core/{FILE_ID[:4]}/{FILE_ID}'
    assert keys.tmp_preview_key('tmp-1') == 'tmp_preview/tmp-1'
    assert keys.clean_key('c1') == 'clean/c1/c1'
    assert keys.dump_key('资产 包.zip') == 'dump/资产 包.zip'


@pytest.mark.parametrize('value', ['', '  ', None, 'a/b', 'a\\b', 'a\x00b', '.',
                                   '..', 'x' * (keys.MAX_COMPONENT_LENGTH + 1)])
def test_keys_component_rejects_dangerous_values(value):
    with pytest.raises(ValueError):
        keys.validate_component(value, 'file id')


def test_safe_file_name_falls_back_to_unnamed():
    for bad in ('', None, '  ', '.', '..', '/x/..', 'a\\..'):
        assert keys.safe_file_name(bad) == 'unnamed'
    assert keys.safe_file_name('/tmp/report.pdf') == 'report.pdf'


# ---------------------------------------------------------------------------
# backend：键规范与后端选择
# ---------------------------------------------------------------------------

def test_normalize_key_empty_is_rejected():
    with pytest.raises(ValueError):
        normalize_key('')
    with pytest.raises(ValueError):
        normalize_key('///')
    with pytest.raises(ValueError):
        normalize_key('././')


def test_backend_name_rejects_unknown_value(monkeypatch):
    monkeypatch.setenv('RKB_STORAGE_BACKEND', 's3')
    with pytest.raises(RuntimeError):
        backend_name()


def test_scratch_root_follows_backend(monkeypatch, tmp_path):
    monkeypatch.setenv('RKB_KBASE_STORAGE_PATH', str(tmp_path / 'volume'))
    monkeypatch.delenv('RKB_STORAGE_TEMP_PATH', raising=False)
    assert scratch_root() == tmp_path / 'volume'          # 本地后端：卷根

    monkeypatch.setenv('RKB_STORAGE_BACKEND', 'minio')
    monkeypatch.setenv('RKB_MINIO_ENDPOINT', 'minio:9000')
    monkeypatch.setattr(MinioBackend, '_create_client', lambda self: object())
    monkeypatch.setenv('RKB_STORAGE_TEMP_PATH', str(tmp_path / 'scratch'))
    assert scratch_root() == tmp_path / 'scratch'

    monkeypatch.delenv('RKB_STORAGE_TEMP_PATH')
    assert scratch_root() == tmp_path / 'volume' / 'tmp'  # 未配置回落卷根/tmp


def test_storage_backend_rebuilds_when_signature_changes(monkeypatch, tmp_path):
    monkeypatch.setenv('RKB_KBASE_STORAGE_PATH', str(tmp_path / 'a'))
    first = storage_backend()
    monkeypatch.setenv('RKB_KBASE_STORAGE_PATH', str(tmp_path / 'b'))
    second = storage_backend()
    assert first is not second                            # 配置变了 → 重建

    explicit = LocalBackend(tmp_path)
    set_storage_backend(explicit)
    assert storage_backend() is explicit                  # 显式注入优先


def test_normalize_prefix_strips_slashes():
    assert _normalize_prefix('/tenant/a/') == 'tenant/a'
    assert _normalize_prefix('') == ''
    assert _normalize_prefix('a\\b') == 'a/b'


def test_error_code_classification():
    assert _error_code(FakeS3Error('NoSuchKey')) == 'NoSuchKey'

    class Response:
        status = 404

    class ErrorWithResponse(Exception):
        response = Response()

    assert _error_code(ErrorWithResponse()) == 'NoSuchKey'
    assert _error_code(ValueError('x')) == ''
    assert _is_missing(FakeS3Error('NoSuchBucket'))
    assert not _is_missing(ValueError('x'))


class FakeS3Error(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class FakeStat:
    def __init__(self, size):
        self.size = size


class FakeResponse:
    def __init__(self, content=b'body'):
        self._content = content
        self.closed = False
        self.released = False

    def read(self, *args):
        return self._content

    def close(self):
        self.closed = True

    def release_conn(self):
        self.released = True


class FakeMinio:
    def __init__(self):
        self.objects = {}
        self.buckets = set()
        self.fail_make_bucket = None

    def bucket_exists(self, bucket):
        return bucket in self.buckets

    def make_bucket(self, bucket, location=None):
        if self.fail_make_bucket is not None:
            raise self.fail_make_bucket
        self.buckets.add(bucket)

    def put_object(self, bucket, name, data, length, content_type=None):
        self.objects[name] = data.read(length)

    def get_object(self, bucket, name):
        if name not in self.objects:
            raise FakeS3Error('NoSuchKey')
        return FakeResponse(self.objects[name])

    def stat_object(self, bucket, name):
        if name not in self.objects:
            raise FakeS3Error('NoSuchKey')
        return FakeStat(len(self.objects[name]))

    def remove_object(self, bucket, name):
        if name not in self.objects:
            raise FakeS3Error('NoSuchKey')
        self.objects.pop(name, None)

    def fget_object(self, bucket, name, file_path):
        if name not in self.objects:
            raise FakeS3Error('NoSuchKey')
        Path(file_path).parent.mkdir(parents=True, exist_ok=True)
        Path(file_path).write_bytes(self.objects[name])


def _minio(client=None, **kwargs):
    return MinioBackend(endpoint='minio:9000', bucket='bkt',
                        client=client or FakeMinio(), **kwargs)


def test_minio_backend_requires_endpoint_and_bucket():
    with pytest.raises(RuntimeError):
        MinioBackend(endpoint='', bucket='bkt', client=FakeMinio())
    with pytest.raises(RuntimeError):
        MinioBackend(endpoint='minio:9000', bucket='', client=FakeMinio())


def test_minio_backend_creates_real_client_when_injected_absent():
    backend = MinioBackend(endpoint='minio:9000', access_key='ak',
                           secret_key='sk', secure=False, region='us-east-1')
    assert backend.name == 'minio'
    assert backend.prefix == ''


def test_minio_ensure_bucket_races_and_existing_errors():
    client = FakeMinio()
    client.fail_make_bucket = FakeS3Error('BucketAlreadyOwnedByYou')
    backend = _minio(client)
    backend._bucket_ready = False
    backend._ensure_bucket()                             # 并发建桶的「已存在」当成功
    assert backend._bucket_ready

    client2 = FakeMinio()
    client2.fail_make_bucket = FakeS3Error('AccessDenied')
    backend2 = _minio(client2)
    backend2._bucket_ready = False
    with pytest.raises(FakeS3Error):
        backend2._ensure_bucket()


def test_minio_put_overwrite_checks_before_upload():
    backend = _minio()
    backend.put('k', b'first')
    with pytest.raises(FileExistsError):
        backend.put('k', b'second', overwrite=False)


def test_minio_get_open_size_delete_map_missing_and_other_errors():
    client = FakeMinio()
    backend = _minio(client)
    backend.put('k', b'hello')

    with backend.open('k') as stream:
        assert isinstance(stream, backend_module._MinioObjectReader)
    with pytest.raises(FileNotFoundError):
        backend.get('missing')
    with pytest.raises(FileNotFoundError):
        backend.open('missing')
    with pytest.raises(FileNotFoundError):
        backend.get_to_file('missing', '/tmp/never.bin')

    backend.delete('missing')                            # miss 删除幂等

    class Boom(Exception):
        code = 'AccessDenied'

    client.get_object = lambda *args: (_ for _ in ()).throw(Boom())
    with pytest.raises(Boom):
        backend.get('k')

    client.stat_object = lambda *args: (_ for _ in ()).throw(Boom())
    with pytest.raises(Boom):
        backend.size('k')
    with pytest.raises(Boom):
        backend.exists('k')

    client.remove_object = lambda *args: (_ for _ in ()).throw(Boom())
    with pytest.raises(Boom):
        backend.delete('k')


def test_minio_object_reader_closes_and_releases_conn():
    response = FakeResponse()
    reader = backend_module._MinioObjectReader(response)
    assert reader.read() == b'body'
    with reader as entered:
        assert entered is reader
    assert response.closed and response.released


def test_minio_get_to_file_and_error_paths(tmp_path):
    client = FakeMinio()
    backend = _minio(client)
    backend.put('k', b'data')
    destination = tmp_path / 'out' / 'file.bin'
    backend.get_to_file('k', destination)
    assert destination.read_bytes() == b'data'

    class Boom(Exception):
        code = 'AccessDenied'

    client.fget_object = lambda *args: (_ for _ in ()).throw(Boom())
    with pytest.raises(Boom):
        backend.get_to_file('k', destination)


# ---------------------------------------------------------------------------
# open_source：统一 (stream, length)
# ---------------------------------------------------------------------------

def test_open_source_accepts_bytes_path_and_stream(tmp_path):
    source = tmp_path / 'src.bin'
    source.write_bytes(b'0123456789')

    with open_source(b'abc') as (stream, length):
        assert (length, stream.read()) == (3, b'abc')

    with open_source(source) as (stream, length):
        assert length == 10

    with open_source(source) as (stream, length):
        stream.read(2)
        with open_source(stream) as (handle, rest):
            assert rest == 8                              # 从当前位置到结尾

    class NoSeek:
        def read(self):
            return b'fallback'

    with open_source(NoSeek()) as (stream, length):
        assert (length, stream.read()) == (8, b'fallback')


def test_local_backend_open_returns_binary_stream(tmp_path):
    backend = LocalBackend(tmp_path)
    backend.put('k', b'bytes')
    with backend.open('k') as handle:
        assert handle.read() == b'bytes'


# ---------------------------------------------------------------------------
# kb_storage：落盘、临时文件与物化
# ---------------------------------------------------------------------------

def test_save_core_file_local_returns_path(tmp_path, monkeypatch):
    monkeypatch.setenv('RKB_KBASE_STORAGE_PATH', str(tmp_path))
    reference = storage.save_core_file(b'core-bytes', FILE_ID, cover=True)
    assert Path(reference).read_bytes() == b'core-bytes'
    assert storage.core_file_exists(FILE_ID)
    storage.delete_core_file(FILE_ID)
    assert not storage.core_file_exists(FILE_ID)


def test_delete_core_file_swallows_backend_missing(tmp_path):
    class MissingOnDelete:
        name = 'local'

        def delete(self, key):
            raise FileNotFoundError(key)

    set_storage_backend(MissingOnDelete())
    storage.delete_core_file(FILE_ID)                    # 不存在也不报错


def test_tmp_preview_round_trip(tmp_path, monkeypatch):
    monkeypatch.setenv('RKB_KBASE_STORAGE_PATH', str(tmp_path))
    reset_storage_backend()
    path = storage.save_tmp_file(b'preview')
    assert path.read_bytes() == b'preview'
    assert str(path).startswith(str(tmp_path / 'tmp_preview'))

    storage.delete_file_quietly(path)
    assert not path.exists()
    storage.delete_file_quietly(path)                    # 再删一次不报错
    storage.delete_file_quietly(tmp_path)                # 目录也吞掉
    storage.delete_file_quietly(None)                    # 非法路径吞掉


def test_materialize_ref_empty_reference_raises():
    for bad in (None, '', '   '):
        with pytest.raises(FileNotFoundError):
            storage.materialize_ref(bad)


def test_materialize_ref_relative_key_hits_local_backend(tmp_path, monkeypatch):
    monkeypatch.setenv('RKB_KBASE_STORAGE_PATH', str(tmp_path))
    reset_storage_backend()
    saved = storage.save_core_file(b'body', FILE_ID, cover=True)

    path, is_temp = storage.materialize_ref(storage.core_key(FILE_ID))
    assert is_temp is False                              # 本地盘上的对象键直接指向文件
    assert Path(path).read_bytes() == b'body'
    assert Path(saved).is_absolute()


def test_cleanup_materialized_and_task_files(tmp_path):
    target = tmp_path / 'gone.bin'
    storage.cleanup_materialized(target)                 # 不存在 → 静默
    storage.cleanup_materialized(123)                    # 非法类型 → 静默
    storage.cleanup_materialized(None)                   # 空 → 直接返回

    storage.cleanup_task_files(None)                     # 没有 handle → 直接返回
    handle = {'fileId': 'f'}
    storage.cleanup_task_files(handle)                   # 没有物化清单 → 只弹键
    assert '_materialized_files' not in handle

    existing = tmp_path / 'tmp.bin'
    existing.write_bytes(b'x')
    handle = {'_materialized_files': [str(existing)]}
    storage.cleanup_task_files(handle)
    assert not existing.exists()


# ---------------------------------------------------------------------------
# kb_storage_registry：ensure_table / 写入容错 / list_rows / reconcile 分支
# ---------------------------------------------------------------------------

class _Cursor:
    def __init__(self, script=None, ones=None):
        self.sql = []
        self.params = []
        self._script = list(script or [])
        self._ones = list(ones or [])
        self.description = [('kbase_id',), ('state',)]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.sql.append(sql)
        self.params.append(params)

    def fetchall(self):
        return self._script.pop(0) if self._script else []

    def fetchone(self):
        return self._ones.pop(0) if getattr(self, '_ones', None) else (True,)

    def close(self):
        pass


class _Conn:
    def __init__(self, cursor):
        self._cursor = cursor
        self.commits = 0

    def cursor(self):
        return self._cursor

    def commit(self):
        self.commits += 1

    def close(self):
        pass


def _patch_registry_conn(monkeypatch, cursor):
    conn = _Conn(cursor)

    @contextmanager
    def _connection():
        yield conn

    monkeypatch.setattr(store_registry, 'connection', _connection)
    return conn


def test_registry_ensure_table_runs_ddl_once(monkeypatch):
    cursor = _Cursor()
    _patch_registry_conn(monkeypatch, cursor)
    monkeypatch.setattr(store_registry, '_ready', False)

    store_registry.ensure_table()
    assert 'CREATE TABLE IF NOT EXISTS public.kb_storage_registry' in cursor.sql[0]


def test_registry_write_failure_does_not_raise(monkeypatch):
    class BrokenConn:
        def cursor(self):
            raise RuntimeError('pg down')

    @contextmanager
    def _connection():
        yield BrokenConn()

    monkeypatch.setattr(store_registry, 'connection', _connection)
    store_registry.mark_ready('kb-1')                    # 只记日志，不抛
    store_registry.remove('kb-1')


def test_registry_list_rows_maps_columns(monkeypatch):
    cursor = _Cursor(script=[[('kb-1', 'ready')]])
    cursor.description = [('kbase_id',), ('state',)]
    _patch_registry_conn(monkeypatch, cursor)

    rows = store_registry.list_rows()
    assert rows == [{'kbase_id': 'kb-1', 'state': 'ready'}]


def test_registry_reconcile_marks_broken_and_removes_gone(monkeypatch):
    # kb_kbase：kb-1 表在、kb-2 没有表名；registry 里只有 deleting 的 kb-2 和孤儿 kb-gone
    cursor = _Cursor(script=[
        [('kb-1', 'demo', 1, 'vec_1', 'm'), ('kb-2', 'broken', 1, None, 'm')],
        [('kb-2', 'deleting'), ('kb-gone', 'ready')],
        [(True,)],                                         # kb-1 的 vec_1 存在
    ])
    _patch_registry_conn(monkeypatch, cursor)

    stats = store_registry.reconcile()

    assert stats['checked'] == 2
    assert stats['inserted'] == 1                          # kb-1 补一行（ready）
    assert stats['removed'] == 1                           # kb-gone 物理已删 → 移除
    inserts = [(sql, params) for sql, params in zip(cursor.sql, cursor.params)
               if sql.startswith('INSERT INTO public.kb_storage_registry')]
    assert inserts[0][1][-2:] == ('ready', None)
    deletes = [sql for sql in cursor.sql if sql.startswith('DELETE FROM')]
    assert len(deletes) == 1


def test_registry_reconcile_updates_existing_broken_row(monkeypatch):
    cursor = _Cursor(
        script=[
            [('kb-1', 'demo', 1, 'vec_1', 'm')],
            [('kb-1', 'ready')],
        ],
        ones=[(False,)],                                   # vec_1 表已不在 → 标 failed
    )
    _patch_registry_conn(monkeypatch, cursor)

    stats = store_registry.reconcile()
    assert stats['failed'] == 1 and stats['inserted'] == 0
    updates = [(sql, params) for sql, params in zip(cursor.sql, cursor.params)
               if sql.startswith('UPDATE public.kb_storage_registry')]
    assert updates and updates[0][1] == ('failed', 'vector table missing', 'kb-1')


def test_registry_table_exists_handles_missing_name(monkeypatch):
    cursor = _Cursor()
    assert store_registry._table_exists(cursor, None) is False
    assert store_registry._table_exists(cursor, '') is False
    cursor.sql = []
    assert store_registry._table_exists(cursor, 'vec_1') is True


def test_local_backend_full_surface(tmp_path):
    backend = LocalBackend(tmp_path)
    backend.put('k', b'first', overwrite=False)          # 不存在时正常写入
    with pytest.raises(FileExistsError):
        backend.put('k', b'second', overwrite=False)

    assert backend.get('k') == b'first'
    assert backend.exists('k')
    assert backend.size('k') == 5
    with backend.open('k') as handle:
        assert handle.read() == b'first'
    destination = tmp_path / 'out' / 'copy.bin'
    backend.get_to_file('k', destination)
    assert destination.read_bytes() == b'first'

    backend.delete('missing-key')                        # miss 删除幂等
    backend.delete('k')
    assert not backend.exists('k')


def test_minio_open_maps_non_missing_errors_too():
    client = FakeMinio()
    backend = _minio(client)
    backend.put('k', b'data')

    class Boom(Exception):
        code = 'AccessDenied'

    client.get_object = lambda *args: (_ for _ in ()).throw(Boom())
    with pytest.raises(Boom):
        backend.open('k')


def test_minio_bucket_double_check_skips_second_probe():
    client = FakeMinio()
    probes = []
    client.bucket_exists = lambda bucket: probes.append(bucket) or False
    backend = _minio(client)

    class _UnlockingLock:
        def __enter__(self):
            backend._bucket_ready = True                 # 拿到锁前别人已建桶
            return self

        def __exit__(self, *exc):
            return False

    backend._bucket_ready = False
    backend._bucket_lock = _UnlockingLock()
    backend._ensure_bucket()                             # 双检锁内层命中
    assert probes == []                                  # 不再探桶
    assert backend._bucket_ready


def test_storage_root_and_core_file_path_helpers(tmp_path, monkeypatch):
    monkeypatch.setenv('RKB_KBASE_STORAGE_PATH', str(tmp_path))
    reset_storage_backend()
    assert storage.storage_root() == tmp_path
    assert storage.core_file_path(FILE_ID) == tmp_path / 'core' / FILE_ID[:4] / FILE_ID


def test_registry_ensure_table_skips_when_ready(monkeypatch):
    monkeypatch.setattr(store_registry, '_ready', True)
    store_registry.ensure_table()                        # 已就绪 → 不打库
