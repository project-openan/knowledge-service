"""文档处理工具层的杂项测试：本地盘客户端、单例、配置、日志前缀。

不连 DB / 网络：``storage_backend`` 注入内存假后端，``get_config`` 打桩，
``parse_config`` 读包内自带的 ``config_dev.yaml``。
"""

import logging
import os

import pytest

from ingestion.config import loglevel
from ingestion.utility import utils as utils_module
from ingestion.utility import local_disk as local_disk_module
from ingestion.utility import manager as manager_module
from ingestion.utility import txlog as txlog_module
from ingestion.utility.local_disk import LocalClient
from ingestion.utility.manager import DiskClientManager, PGClientManager, get_pg_pw
from ingestion.utility.singleton import singleton
from ingestion.utility.config import Config


# ---------------------------------------------------------------------------
# local_disk
# ---------------------------------------------------------------------------

class FakeBackend:
    name = 'local'

    def __init__(self):
        self.put_calls = []
        self.paths = {}

    def put(self, key, source, overwrite=True, content_type=None):
        self.put_calls.append((key, str(source)))
        self.paths[key] = os.path.abspath(str(source))

    def local_path(self, key):
        return self.paths.get(key)


@pytest.fixture()
def fake_backend():
    from infrastructure.storage.backend import reset_storage_backend, set_storage_backend
    backend = FakeBackend()
    set_storage_backend(backend)
    try:
        yield backend
    finally:
        reset_storage_backend()


def test_upload_dump_file_returns_local_path(tmp_path, fake_backend):
    source = tmp_path / '原始 文件.md'
    source.write_text('x', encoding='utf-8')
    client = LocalClient('/data/kb')
    result = client.upload_dump_file(str(source))
    assert fake_backend.put_calls[0][0].startswith('dump/')
    assert result == str(source.resolve())


def test_upload_dump_file_without_local_path_returns_key(tmp_path, monkeypatch):
    client = LocalClient('/data/kb')
    monkeypatch.setattr(local_disk_module, 'storage_backend', lambda: FakeBackend())
    # local_path 永远返回 None → 回落返回对象键
    assert client.upload_dump_file(str(tmp_path / 'a.md')) == 'dump/a.md'


def test_upload_clean_file_writes_scratch(tmp_path, monkeypatch):
    source = tmp_path / 'clean_source.md'
    source.write_text('清洗内容', encoding='utf-8')
    scratch = tmp_path / 'scratch'
    scratch.mkdir()
    monkeypatch.setattr(local_disk_module, 'scratch_root', lambda: scratch)

    client = LocalClient('/data/kb')
    result = client.upload_clean_file(str(source), 'admin')

    assert result.startswith(str(scratch / 'clean'))
    with open(result, encoding='utf-8') as f:
        assert f.read() == '清洗内容'


# ---------------------------------------------------------------------------
# manager
# ---------------------------------------------------------------------------

def test_disk_client_manager_is_singleton():
    first = DiskClientManager()
    second = DiskClientManager()
    assert first is second
    assert first.get_disk_client() is first.disk_client
    assert isinstance(first.disk_client, LocalClient)


def test_disk_client_manager_reinitialize_with_config(monkeypatch):
    monkeypatch.setattr(manager_module, 'get_config', lambda: {'LocalDisk': {'baseFolder': '/x'}})
    manager = DiskClientManager()
    manager._initialize()
    assert manager.disk_client._base_folder == '/x'


def test_pg_client_manager_builds_client_from_config(monkeypatch):
    config = {'PGDatabase': {'host': 'pg-host', 'database': 'db', 'user': 'u1',
                             'password': 'pw', 'port': '6543'}}
    monkeypatch.setattr(manager_module, 'get_config', lambda: config)
    client = PGClientManager().get_pg_client()
    assert client._get_db_params() == {'host': 'pg-host', 'database': 'db', 'user': 'u1',
                                       'password': 'pw', 'port': '6543'}
    assert get_pg_pw(config) == 'pw'


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

def test_get_project_dir_is_ingestion_package():
    import ingestion
    assert utils_module.get_project_dir() == os.path.dirname(ingestion.__file__)


def test_get_config_reads_dev_yaml(monkeypatch):
    monkeypatch.delenv('server_env', raising=False)  # 默认 dev
    config = utils_module.get_config()
    assert 'LocalDisk' in config and 'PGDatabase' in config
    monkeypatch.setenv('server_env', 'dev')
    assert 'PGDatabase' in utils_module.get_config()


def test_config_wrapper_reads_ini(tmp_path):
    ini = tmp_path / 'setting.ini'
    ini.write_text('[ip]\nDNS_IP=8.8.8.8\n[pg]\nhost=db\n', encoding='utf-8')
    config = Config(str(ini))
    assert config.get_config('ip', 'DNS_IP') == '8.8.8.8'
    assert config.get_config('pg', 'host') == 'db'
    with pytest.raises(KeyError):
        config.get_config('missing', 'key')


def test_singleton_returns_same_instance_per_class():
    @singleton
    class A:
        def __init__(self, value=None):
            self.value = value

    @singleton
    class B:
        pass

    a1 = A(1)
    a2 = A(2)
    assert a1 is a2
    assert a1.value == 1  # 首次构造的参数生效，后续调用不再构造
    assert A(3) is a1
    b1, b2 = B(), B()
    assert b1 is b2
    assert type(b1) is not type(a1)


# ---------------------------------------------------------------------------
# loglevel 常量
# ---------------------------------------------------------------------------

def test_loglevel_constants():
    assert (loglevel.CONSOLE_LEVEL, loglevel.FILE_LEVEL, loglevel.ROOT_LEVEL) == \
        ('consoleLevel', 'fileLevel', 'rootLevel')
    assert loglevel.DEFAULT_CONSOLE_LEVEL == 'DEBUG'
    assert loglevel.DEFAULT_FILE_LEVEL == 'DEBUG'
    assert loglevel.DEFAULT_ROOT_LEVEL == 'INFO'


# ---------------------------------------------------------------------------
# txlog
# ---------------------------------------------------------------------------

class _RaisesOnGet:
    def get(self, *args, **kwargs):
        raise RuntimeError('bad request object')


def test_get_tx_id_from_req_variants():
    assert txlog_module.get_tx_id_from_req({'kwargs': {'txId': 'tx-1'}}) == 'tx-1'
    assert txlog_module.get_tx_id_from_req({'kwargs': None}) is None
    assert txlog_module.get_tx_id_from_req({}) is None
    assert txlog_module.get_tx_id_from_req(None) is None
    assert txlog_module.get_tx_id_from_req(_RaisesOnGet()) is None


def test_build_prefix():
    assert txlog_module.build_prefix('tx-1') == '[tx-1] >>> '
    assert txlog_module.build_prefix(None) == ''


def test_tx_prefixed_logger_wraps_messages(caplog):
    logger = txlog_module.TxPrefixedLogger('tx-9')
    with caplog.at_level(logging.DEBUG):
        logger.debug('d')
        logger.info('i')
        logger.warning('w')
        logger.error('e')
    assert '[tx-9] >>> d' in caplog.text
    assert '[tx-9] >>> i' in caplog.text
    assert '[tx-9] >>> w' in caplog.text
    assert '[tx-9] >>> e' in caplog.text


def test_tx_prefixed_logger_without_tx(caplog):
    logger = txlog_module.TxPrefixedLogger(None)
    with caplog.at_level(logging.INFO):
        logger.info('plain')
    # 无 tx_id 时无前缀
    assert 'plain' in caplog.text


def test_tx_prefixed_logger_exception_variants(caplog):
    logger = txlog_module.TxPrefixedLogger('tx-e')
    with caplog.at_level(logging.ERROR):
        logger.exception('boom')
        logger.exception(RuntimeError('obj'))
    assert '[tx-e] >>> boom' in caplog.text
    assert '[tx-e] >>> obj' in caplog.text
