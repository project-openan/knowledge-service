"""配置常量、文件系统助手与日志归档（全部落在 tmp_path，不碰仓库目录）。"""

from __future__ import annotations

import gzip
import logging
import os
import time


from infrastructure.config import constants, deployment, settings
from infrastructure.fs import files, images, pathutil, paths, temp_files
from infrastructure.logging import logutil


# ---------------------------------------------------------------------------
# config：settings / constants / deployment
# ---------------------------------------------------------------------------

def test_settings_config_keys_are_env_driven(monkeypatch):
    assert settings.Config['work_dir']
    assert settings.Config['storage_main_path']
    assert constants.knowledge_file_path == settings.Config['plugin_source_path']
    assert constants.default_top_k == 8
    assert constants.http_ok_code == 200 and constants.fail_code == -1
    assert set(constants.ES_DICT) == {'host', 'port', 'user', 'password'}
    assert constants.memory == os.environ.get('CURRENT_MEM_LIMIT')


def test_deployment_dev_mode_and_maintenance_params(monkeypatch):
    # dev_mode 在 import 时就定格进 Config，改 env 不生效，只能改字典
    monkeypatch.setitem(settings.Config, 'dev_mode', 'true')
    assert deployment.is_dev_mode() is True
    monkeypatch.setitem(settings.Config, 'dev_mode', 'FALSE')
    assert deployment.is_dev_mode() is False

    monkeypatch.setenv('MAINTENANCE_WORK_MEM', '512MB')
    assert deployment.get_maintenance_work_mem() == '512MB'
    monkeypatch.delenv('MAINTENANCE_WORK_MEM')
    assert deployment.get_maintenance_work_mem() == '256MB'

    for value, expected in (('3', 3), ('9', 5), ('-2', 0), ('abc', 0), ('0', 0)):
        monkeypatch.setenv('MAX_PARALLEL_MAINTENANCE_WORKERS', value)
        assert deployment.get_max_parallel_maintenance_workers() == expected


def test_paths_log_dir_prefers_env(monkeypatch, tmp_path):
    monkeypatch.setenv('LOG_DIR', str(tmp_path / 'logs'))
    assert paths.get_log_dir() == str(tmp_path / 'logs')
    monkeypatch.setenv('LOG_DIR', '   ')
    assert paths.get_log_dir().endswith('logs')           # 回落 <work_dir>/logs


# ---------------------------------------------------------------------------
# fs：路径助手与文件工具
# ---------------------------------------------------------------------------

def test_pathutil_creates_dirs_under_root(tmp_path, monkeypatch):
    monkeypatch.setattr(pathutil, 'root_path', str(tmp_path))
    monkeypatch.setitem(pathutil.Config, 'work_dir', str(tmp_path / 'work'))

    assert pathutil.get_workdir() == str(tmp_path.parent)
    assert pathutil.get_data_path('chunks') == str(tmp_path / 'data' / 'chunks')
    assert os.path.isdir(tmp_path / 'data' / 'chunks')
    assert pathutil.get_asset_center_path() == str(tmp_path / 'data' / 'asset-center')
    assert pathutil.get_asset_center_path('1') == str(tmp_path / 'data' / 'asset-center-publish')
    assert pathutil.get_default_data_package_path() == str(tmp_path / 'work' / 'processor-data')
    assert pathutil.get_conf_dir() == str(tmp_path / 'work' / 'config')
    assert pathutil.create_dir_under_root('/sub/dir') == str(tmp_path / 'work') + '/sub/dir'
    assert pathutil.get_plugins_pvc_path() == pathutil.Config['plugin_pvc_path']
    assert pathutil.get_file_track_path() == str(tmp_path / 'work' / 'file_track')


def test_files_helpers(tmp_path, monkeypatch):
    assert files.get_file_type('Report.PDF') == 'pdf'
    assert files.get_file_type('a.b.md') == 'md'

    (tmp_path / 'sub').mkdir()
    (tmp_path / 'a.txt').write_text('x')
    (tmp_path / 'sub' / 'b.txt').write_text('y')
    found = files.get_files_under_dir(str(tmp_path))
    assert len(found) == 2 and any('b.txt' in path for path in found)

    monkey_work = tmp_path / 'work'
    monkey_work.mkdir()
    monkeypatch.setitem(pathutil.Config, 'work_dir', str(monkey_work))
    saved = files.create_save_directory('bundle')
    assert os.path.isdir(saved) and saved.endswith('bundle')


def test_images_move_copies_tree(tmp_path):
    source_root = tmp_path / 'work' / 'temp' / 'split' / 'doc.md' / 'output' / 'images'
    (source_root / 'p1').mkdir(parents=True)
    (source_root / 'p1' / 'img.png').write_bytes(b'png')
    target = tmp_path / 'assets'

    images.move_img(str(target), str(tmp_path / 'work'), 'doc.md')

    assert (target / 'p1' / 'img.png').read_bytes() == b'png'


def test_temp_files_cleanup(tmp_path, monkeypatch):
    work = tmp_path / 'work'
    (work / 'temp' / 'nested').mkdir(parents=True)
    (work / 'temp' / 'nested' / 'f.txt').write_text('x')
    monkeypatch.setattr(temp_files, 'work_dir', str(work))

    temp_files.delete_temp_files()
    assert not (work / 'temp').exists()

    temp_files.delete_temp_files()                        # 再删一次不报错


# ---------------------------------------------------------------------------
# logging：压缩归档 handler
# ---------------------------------------------------------------------------

def _make_handler(tmp_path, name='app', max_bytes=50, backup_count=2):
    log_path = tmp_path / f'{name}.log'
    handler = logutil.CompressedRotatingFileHandler(str(log_path), max_bytes=max_bytes,
                                                    backup_count=backup_count)
    return handler


def test_compressed_handler_writes_and_archives_on_rollover(tmp_path):
    handler = _make_handler(tmp_path)
    logger = logging.getLogger('infra-log-archive-test')
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    logger.handlers = [handler]
    try:
        for index in range(30):
            logger.info('log line number %02d with some padding text', index)
        handler.flush()
        archives = list((tmp_path / 'zip').glob('*.gz'))
        assert archives, 'rollover should produce compressed archives'
        with gzip.open(archives[0], 'rb') as gz:
            assert b'log line number' in gz.read()
        assert os.path.exists(handler.baseFilename)       # 活动文件始终存在
    finally:
        logger.handlers = []


def test_compressed_handler_archives_stale_remains(tmp_path):
    # 先建 handler 拿到目录布局，再放一个「30 分钟前」的残留文件
    handler = _make_handler(tmp_path)
    log_dir = os.path.dirname(handler.baseFilename)
    base = os.path.basename(handler.input_filename)
    stale = os.path.join(log_dir, f'{base}-20250101000000-[111111].log')
    with open(stale, 'w') as fh:
        fh.write('stale content')
    old = time.time() - 3600
    os.utime(stale, (old, old))

    handler._backup_remains()

    archived = tmp_path / 'zip' / f'{base}-20250101000000-[111111].log.gz'
    assert archived.exists() and not os.path.exists(stale)
    with gzip.open(archived, 'rb') as gz:
        assert gz.read() == b'stale content'


def test_compressed_handler_backup_pruning(tmp_path):
    handler = _make_handler(tmp_path, backup_count=1)
    backup_dir = handler.backup_dir                        # 字符串路径
    base = os.path.basename(handler.input_filename)
    for index in range(4):
        name = f'{base}-2025010100000{index}-[111].log.gz'
        with open(os.path.join(backup_dir, name), 'wb') as fh:
            fh.write(b'x')
    to_delete = handler.get_files_to_delete()
    assert len(to_delete) == 3                            # 保留最新 backup_count 份
    for path in to_delete:
        os.remove(path)
    assert handler.get_files_to_delete() == []


def test_get_files_to_delete_returns_empty_when_under_retention(tmp_path):
    handler = _make_handler(tmp_path, backup_count=5)
    assert handler.get_files_to_delete() == []


def test_rotate_swallows_missing_source(tmp_path):
    handler = _make_handler(tmp_path)
    handler.rotate(str(tmp_path / 'not-there.log'),
                   str(tmp_path / 'zip' / 'not-there.log.gz'))    # 直接返回


def test_get_logger_is_idempotent_and_dev_mode_adds_stream(monkeypatch, tmp_path):
    root = logging.getLogger()
    existing = getattr(root, '_ragstudio_file_handler', None)
    before = list(root.handlers)

    monkeypatch.setitem(settings.Config, 'dev_mode', 'false')
    logger = logutil.get_logger()
    assert logger is root
    if existing is not None:
        assert list(root.handlers) == before              # 不重复挂文件 handler

    monkeypatch.setitem(settings.Config, 'dev_mode', 'true')
    logutil.get_logger()
    stream_handlers = [h for h in root.handlers
                       if isinstance(h, logging.StreamHandler)
                       and not isinstance(h, logutil.RotatingFileHandler)]
    added = [h for h in stream_handlers if h not in before]
    assert added, 'dev mode should attach a stream handler'
    for handler in added:
        assert handler.level == logging.DEBUG
        root.removeHandler(handler)
        handler.close()

    monkeypatch.setitem(settings.Config, 'dev_mode', 'false')
    logutil.get_logger()


def test_get_file_handler_uses_log_dir(monkeypatch, tmp_path):
    monkeypatch.setenv('LOG_DIR', str(tmp_path / 'fresh'))   # 目录尚不存在 → 补建
    monkeypatch.setitem(settings.Config, 'dev_mode', 'false')
    handler = logutil.get_file_handler('-test')
    try:
        assert handler.baseFilename.startswith(str(tmp_path / 'fresh'))
        assert os.path.isdir(tmp_path / 'fresh')
        assert handler.level == logging.INFO
    finally:
        handler.close()


def test_handler_creates_missing_log_directory(tmp_path):
    nested = tmp_path / 'deep' / 'logs'
    handler = logutil.CompressedRotatingFileHandler(
        str(nested / 'app.log'), max_bytes=1024, backup_count=1)
    try:
        assert os.path.isdir(nested)                      # 构造时补建目录
    finally:
        handler.close()


def test_backup_cleanup_skips_directories(tmp_path):
    handler = _make_handler(tmp_path, backup_count=1)
    subdir = os.path.join(handler.backup_dir, 'not-a-file')
    os.makedirs(subdir, exist_ok=True)
    assert handler.get_files_to_delete() == []            # 目录项被跳过


def test_backup_remains_skips_vanished_files(tmp_path, monkeypatch):
    handler = _make_handler(tmp_path)
    log_dir = os.path.dirname(handler.baseFilename)
    base = os.path.basename(handler.input_filename)
    stale = os.path.join(log_dir, f'{base}-20250102000000-[222222].log')
    with open(stale, 'w') as fh:
        fh.write('x')

    import infrastructure.logging.logutil as logutil_module
    real_getmtime = os.path.getmtime

    def flaky_getmtime(path):
        if path == stale:
            raise OSError('file disappeared')
        return real_getmtime(path)

    monkeypatch.setattr(logutil_module.os.path, 'getmtime', flaky_getmtime)
    handler._backup_remains()                             # 残留文件消失 → 跳过
    assert os.path.exists(stale)


def test_backup_remains_overwrites_existing_archive(tmp_path):
    handler = _make_handler(tmp_path)
    log_dir = os.path.dirname(handler.baseFilename)
    base = os.path.basename(handler.input_filename)
    stale = os.path.join(log_dir, f'{base}-20250103000000-[333333].log')
    with open(stale, 'w') as fh:
        fh.write('fresh stale')
    old = time.time() - 3600
    os.utime(stale, (old, old))
    archived = os.path.join(handler.backup_dir,
                            f'{base}-20250103000000-[333333].log.gz')
    with open(archived, 'wb') as fh:
        fh.write(b'old archive')

    handler._backup_remains()                             # 旧归档被替换
    with gzip.open(archived, 'rb') as gz:
        assert gz.read() == b'fresh stale'


def test_do_rollover_removes_existing_archive_and_prunes(tmp_path):
    handler = _make_handler(tmp_path, backup_count=1)
    dfn = os.path.join(handler.backup_dir,
                       os.path.basename(handler.baseFilename) + '.gz')
    with open(dfn, 'wb') as fh:
        fh.write(b'previous rollover')
    for index in range(3):
        name = f"{os.path.basename(handler.input_filename)}-2025010100000{index}-[9].log.gz"
        with open(os.path.join(handler.backup_dir, name), 'wb') as fh:
            fh.write(b'old')

    logger = logging.getLogger('infra-log-rollover-prune')
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    logger.handlers = [handler]
    try:
        logger.info('%s', 'x' * 200)                      # 超过 max_bytes 触发 rollover
        handler.flush()
        with open(dfn, 'rb') as fh:
            assert fh.read(2) == b'\x1f\x8b'            # 新归档覆盖了旧的
    finally:
        logger.handlers = []


def test_rotate_swallows_source_vanishing_mid_archive(tmp_path, monkeypatch):
    handler = _make_handler(tmp_path)
    source = os.path.join(os.path.dirname(handler.baseFilename), 'vanish.log')
    with open(source, 'w') as fh:
        fh.write('content')
    destination = os.path.join(handler.backup_dir, 'vanish.log.gz')

    real_remove = os.remove
    def flaky_remove(path):
        real_remove(path)
        raise FileNotFoundError(path)                     # gz 建好但源文件已被人转走

    monkeypatch.setattr(logutil.os, 'remove', flaky_remove)
    handler.rotate(source, destination)                   # 不抛错
    assert os.path.exists(destination)
    monkeypatch.setattr(logutil.os, 'remove', real_remove)
    os.remove(destination)


def test_temp_files_error_branch_is_swallowed(tmp_path, monkeypatch):
    """rmtree 失败走 except 分支；换掉 log 避免「无占位符 + args」的格式化噪音。"""
    work = tmp_path / 'work'
    (work / 'temp').mkdir(parents=True)
    monkeypatch.setattr(temp_files, 'work_dir', str(work))

    class QuietLogger:
        def info(self, *args, **kwargs):
            pass

        def error(self, *args, **kwargs):
            pass

    monkeypatch.setattr(temp_files, 'log', QuietLogger())
    monkeypatch.setattr(temp_files.shutil, 'rmtree',
                        lambda *a, **k: (_ for _ in ()).throw(OSError('busy')))
    temp_files.delete_temp_files()                        # 删失败不抛
    assert (work / 'temp').exists()
