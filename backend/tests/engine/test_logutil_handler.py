"""日志基建：``engine/logutil.py`` 的压缩轮转 handler 与级别开关。

重点钉住四件事（都是排查线上问题时会踩的）：

  * ``CompressedRotatingFileHandler``：文件名形状（``<name>-<ts>-[<rand>].log``）、
    ``zip/`` 归档目录、超过 ``maxBytes`` 触发轮转后旧文件被 **gzip** 压进 ``zip/``；
  * ``_backup_remains``：残留未归档文件按 mtime 判定（>30 分钟），轮转成 ``.gz``；
  * ``get_files_to_delete``：超出 ``backupCount`` 才删、且删的是最旧的一批；
  * ``set_log_level`` / ``get_logger``：动态级别落到 root logger 与全部 handler，
    dev 模式追加 StreamHandler —— 全局状态用例后恢复，不泄漏给别的测试。
"""
import gzip
import logging
import logging as origin_logging
import os
import re
import time


from engine import path_utils
from engine import logutil


# --------------------------------------------------------------------------
# 级别开关
# --------------------------------------------------------------------------
def test_set_log_level_updates_root_and_every_handler():
    root = origin_logging.getLogger()
    orig_level = root.level
    orig_handler_levels = [h.level for h in root.handlers]
    orig_module_level = logutil._log_level
    try:
        assert logutil.set_log_level('debug') == 'DEBUG'
        assert logutil.get_log_level() == 'DEBUG'
        assert root.level == origin_logging.DEBUG
        assert root.handlers, 'root logger 应已有模块 import 时挂上的文件 handler'
        assert all(h.level == origin_logging.DEBUG for h in root.handlers)

        # 未知级别回落 INFO（level_map.get 的缺省分支）
        assert logutil.set_log_level('nonsense') == 'INFO'
        assert logutil.get_log_level() == 'INFO'
        assert root.level == origin_logging.INFO
    finally:
        root.setLevel(orig_level)
        for handler, level in zip(root.handlers, orig_handler_levels):
            handler.setLevel(level)
        logutil._log_level = orig_module_level


def test_get_log_level_defaults_to_info():
    assert logutil.get_log_level() == 'INFO'


# --------------------------------------------------------------------------
# 文件名 / 随机数
# --------------------------------------------------------------------------
def test_get_rand_str_is_six_digits():
    for _ in range(5):
        value = logutil._get_rand_str()
        assert len(value) == 6
        assert value.isdigit()


def test_get_filename_shape(tmp_path):
    handler = logutil.CompressedRotatingFileHandler(str(tmp_path / 'unit-log'),
                                                    max_bytes=1024 * 1024, backup_count=3)
    name = handler._get_filename()
    assert name.startswith(os.path.abspath(str(tmp_path)) + os.sep + 'unit-log-')
    assert re.fullmatch(r'.*unit-log-\d{14}-\[\d{6}\]\.log', name)
    handler.stream.close() if handler.stream else None


def test_constructor_names_file_and_creates_zip_dir(tmp_path):
    handler = logutil.CompressedRotatingFileHandler(str(tmp_path / 'unit-log'),
                                                    max_bytes=1024 * 1024, backup_count=3)
    assert re.search(r'unit-log-\d{14}-\[\d{6}\]\.log$', os.path.basename(handler.baseFilename))
    assert os.path.isdir(handler.backup_dir)
    assert os.path.basename(handler.backup_dir) == 'zip'
    assert os.path.exists(handler.baseFilename)  # delay=False，构造即打开


def test_constructor_creates_missing_log_dir(tmp_path):
    log_dir = tmp_path / 'nested' / 'logs'
    logutil.CompressedRotatingFileHandler(str(log_dir / 'unit-log'),
                                          max_bytes=1024 * 1024, backup_count=1)
    assert log_dir.is_dir()


# --------------------------------------------------------------------------
# 备份清理
# --------------------------------------------------------------------------
def _backup_name(base: str, timestamp: str, rand: str, gz: bool = False) -> str:
    suffix = '.log.gz' if gz else '.log'
    return f'{base}-{timestamp}-[{rand}]{suffix}'


def test_get_files_to_delete_keeps_everything_below_backup_count(tmp_path):
    handler = logutil.CompressedRotatingFileHandler(str(tmp_path / 'unit-log'),
                                                    max_bytes=1024 * 1024, backup_count=3)
    for timestamp, rand in (('20200101000000', '111111'), ('20200102000000', '222222')):
        (tmp_path / 'zip' / _backup_name('unit-log', timestamp, rand, gz=True)).write_text('x')
    # 不匹配后缀的文件与子目录都不应入选
    (tmp_path / 'zip' / 'unrelated.txt').write_text('x')
    (tmp_path / 'zip' / 'subdir').mkdir()
    assert handler.get_files_to_delete() == []


def test_get_files_to_delete_drops_oldest_beyond_backup_count(tmp_path):
    handler = logutil.CompressedRotatingFileHandler(str(tmp_path / 'unit-log'),
                                                    max_bytes=1024 * 1024, backup_count=2)
    names = [_backup_name('unit-log', ts, rand, gz=True)
             for ts, rand in (('20200101000000', '111111'), ('20200102000000', '222222'),
                              ('20200103000000', '333333'), ('20200104000000', '444444'))]
    for name in names:
        (tmp_path / 'zip' / name).write_text('x')
    to_delete = handler.get_files_to_delete()
    assert len(to_delete) == 2
    # sorted() 后最旧的两个（时间戳最小）先删
    assert [os.path.basename(p) for p in to_delete] == names[:2]


def test_backup_remains_archives_stale_log_files(tmp_path):
    handler = logutil.CompressedRotatingFileHandler(str(tmp_path / 'unit-log'),
                                                    max_bytes=1024 * 1024, backup_count=5)
    stale = tmp_path / _backup_name('unit-log', '20200101000000', '999999')
    stale.write_text('stale-content')
    old = time.time() - 31 * 60
    os.utime(stale, (old, old))

    fresh = tmp_path / _backup_name('unit-log', '20991231235959', '888888')
    fresh.write_text('fresh')

    (tmp_path / 'a-directory').mkdir()  # 非文件条目：跳过不炸

    handler._backup_remains()

    assert not stale.exists()
    archived = tmp_path / 'zip' / _backup_name('unit-log', '20200101000000', '999999', gz=True)
    assert archived.exists()
    with gzip.open(archived, 'rt') as fh:
        assert fh.read() == 'stale-content'
    assert fresh.exists()  # 新残留不受影响


def test_backup_remains_overwrites_existing_archive(tmp_path):
    handler = logutil.CompressedRotatingFileHandler(str(tmp_path / 'unit-log'),
                                                    max_bytes=1024 * 1024, backup_count=5)
    stale = tmp_path / _backup_name('unit-log', '20200101000000', '777777')
    stale.write_text('newer-observation')
    old = time.time() - 31 * 60
    os.utime(stale, (old, old))
    archived = tmp_path / 'zip' / _backup_name('unit-log', '20200101000000', '777777', gz=True)
    archived.write_text('stale-archive')

    handler._backup_remains()

    with gzip.open(archived, 'rt') as fh:
        assert fh.read() == 'newer-observation'
    assert not stale.exists()


def test_rotate_gzips_and_removes_source(tmp_path):
    handler = logutil.CompressedRotatingFileHandler(str(tmp_path / 'unit-log'),
                                                    max_bytes=1024 * 1024, backup_count=5)
    source = tmp_path / 'plain.log'
    source.write_text('payload')
    dest = tmp_path / 'zip' / 'plain.log.gz'
    handler.rotate(str(source), str(dest))
    assert not source.exists()
    with gzip.open(dest, 'rt') as fh:
        assert fh.read() == 'payload'


# --------------------------------------------------------------------------
# 轮转
# --------------------------------------------------------------------------
def test_do_rollover_prunes_archives_beyond_backup_count(tmp_path):
    # backupCount=1：zip/ 里预置 3 个归档，轮转后应只剩 1 个（最旧的 2 个被删）
    handler = logutil.CompressedRotatingFileHandler(str(tmp_path / 'unit-log'),
                                                    max_bytes=1024 * 1024, backup_count=1)
    handler.emit(logging.LogRecord('unit', logging.ERROR, __file__, 1, 'x', (), None))
    names = [_backup_name('unit-log', ts, rand, gz=True)
             for ts, rand in (('20200101000000', '111111'), ('20200102000000', '222222'),
                              ('20200103000000', '333333'))]
    for name in names:
        (tmp_path / 'zip' / name).write_text('old')

    handler.doRollover()
    try:
        remaining = sorted(os.listdir(tmp_path / 'zip'))
        # 4 个归档 + backupCount=1 → 删最旧 3 个（含全部预置的 2020 归档）；
        # 留下的正是本次轮转刚归档的那份
        assert len(remaining) == 1
        assert remaining[0] == os.path.basename(handler.baseFilename) + '.gz'
    finally:
        if handler.stream:
            handler.stream.close()


def test_do_rollover_archives_current_file_and_reopens_stream(tmp_path):
    handler = logutil.CompressedRotatingFileHandler(str(tmp_path / 'unit-log'),
                                                    max_bytes=1024 * 1024, backup_count=5)
    handler.emit(logging.LogRecord('unit', logging.ERROR, __file__, 1, 'hello', (), None))
    previous_base = handler.baseFilename
    assert os.path.exists(previous_base)

    handler.doRollover()

    archived = tmp_path / 'zip' / (os.path.basename(previous_base) + '.gz')
    assert archived.exists()
    with gzip.open(archived, 'rt') as fh:
        assert fh.read().strip() == 'hello'
    # 同一秒内轮转时新文件名与旧名相同（时间戳 + 构造期随机数都一样），
    # 这是模块自身语义：靠 zip/ 归档区分代次，活跃文件名不保证变化。
    assert handler.stream is not None  # delay=False：轮转后重开新文件
    assert handler.stream.name == handler.baseFilename
    handler.stream.close()


def test_writing_past_max_bytes_triggers_rollover(tmp_path):
    handler = logutil.CompressedRotatingFileHandler(str(tmp_path / 'unit-log'),
                                                    max_bytes=10, backup_count=5)
    logger = logging.getLogger('unit-log-rollover')
    logger.setLevel(logging.ERROR)
    logger.addHandler(handler)
    previous_base = handler.baseFilename
    try:
        for i in range(5):
            logger.error('message %s that is definitely longer than ten bytes', i)
    finally:
        logger.removeHandler(handler)
    assert (tmp_path / 'zip' / (os.path.basename(previous_base) + '.gz')).exists()
    assert os.path.exists(handler.baseFilename)
    handler.stream.close()


# --------------------------------------------------------------------------
# logger 装配
# --------------------------------------------------------------------------
def test_is_dev_mode_reads_config(monkeypatch):
    monkeypatch.setitem(logutil.Config, 'dev_mode', 'true')
    assert logutil.is_dev_mode() is True
    monkeypatch.setitem(logutil.Config, 'dev_mode', 'false')
    assert logutil.is_dev_mode() is False


def test_get_logger_reuses_the_single_file_handler_and_dev_mode_adds_stream(monkeypatch, caplog):
    root = origin_logging.getLogger()
    handlers_before = list(root.handlers)
    assert getattr(root, '_ragstudio_file_handler', None) in handlers_before

    monkeypatch.setattr(logutil, 'is_dev_mode', lambda: True)
    added = []
    try:
        logutil.get_logger()
        added = [h for h in root.handlers if h not in handlers_before]
        stream_handlers = [h for h in added if isinstance(h, origin_logging.StreamHandler)]
        assert stream_handlers, 'dev 模式应追加一个 StreamHandler'
        assert all(h.filters for h in added)  # TraceIdFilter 必须挂上

        # 再调一次：文件 handler 已挂（_ragstudio_file_handler 标记），不得重复挂。
        # 注意标记可能由 tools/log/logutil（另一份实现）先挂上 —— 「谁先 import
        # 谁创建，后到的复用」是这个函数的契约，所以只验证同一对象被复用。
        file_handler = root._ragstudio_file_handler
        logutil.get_logger()
        assert root._ragstudio_file_handler is file_handler
        # dev 模式的 StreamHandler 每次调用都会追加 —— 模块预期行为，测完统一清理。
        added = [h for h in root.handlers if h not in handlers_before]
    finally:
        for handler in added:
            root.removeHandler(handler)
            handler.close()


def test_get_logger_creates_file_handler_when_marker_missing(monkeypatch):
    """标记不存在（谁先 import 谁创建）：engine 侧挂自己的 CompressedRotatingFileHandler。"""
    root = origin_logging.getLogger()
    original_marker = getattr(root, '_ragstudio_file_handler', None)
    monkeypatch.delattr(root, '_ragstudio_file_handler', raising=False)
    monkeypatch.setattr(logutil, 'is_dev_mode', lambda: False)
    created = None
    try:
        logutil.get_logger()
        created = root._ragstudio_file_handler
        assert isinstance(created, logutil.CompressedRotatingFileHandler)
        assert created in root.handlers
    finally:
        if created is not None:
            root.removeHandler(created)
            if created.stream:
                created.stream.close()
        if original_marker is not None:
            root._ragstudio_file_handler = original_marker


def test_get_file_handler_creates_missing_log_dir(tmp_path, monkeypatch):
    target = tmp_path / 'brand-new-logs'
    monkeypatch.setattr(path_utils, 'get_log_dir', lambda: str(target))
    handler = logutil.get_file_handler('-mkdir')
    try:
        assert target.is_dir()
    finally:
        handler.stream.close() if handler.stream else None


def test_get_file_handler_uses_log_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(path_utils, 'get_log_dir', lambda: str(tmp_path))
    handler = logutil.get_file_handler('-probe')
    try:
        assert handler.baseFilename.startswith(str(tmp_path / 'rag-component-service-probe-'))
        assert handler.level == origin_logging.INFO
        assert handler.formatter is not None
    finally:
        handler.stream.close() if handler.stream else None


def test_new_exception_logs_warning_with_exc_info(caplog):
    with caplog.at_level(logging.WARNING, logger='root'):
        logutil.logger.exception('boom %s', 'detail')
    warnings = [r for r in caplog.records if r.getMessage() == 'boom detail']
    assert warnings
    assert warnings[0].levelno == logging.WARNING
    assert warnings[0].exc_info is not None


# --------------------------------------------------------------------------
# path_utils
# --------------------------------------------------------------------------
def test_get_log_dir_uses_env_and_creates_directory(tmp_path, monkeypatch):
    target = tmp_path / 'ks-logs'
    monkeypatch.setenv('LOG_DIR', str(target))
    assert path_utils.get_log_dir() == str(target)
    assert target.is_dir()


def test_get_log_dir_falls_back_to_default(tmp_path, monkeypatch):
    monkeypatch.delenv('LOG_DIR', raising=False)
    assert path_utils.get_log_dir() == '/tmp/rkb-logs'
    assert os.path.isdir('/tmp/rkb-logs')
