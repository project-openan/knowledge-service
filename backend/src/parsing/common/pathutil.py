import os
import shutil

from infrastructure.logging.logutil import log


def get_workdir():
    """运行时工作目录：统一走 infrastructure 的 ``work_dir``（env ``WORK_DIR`` 可覆写）。

    历史上这里返回解析包的**源码目录**（``src/parsing``），运行期 temp 产物
    （html/pptx 转 md、语料切片）会写进源码树 ``src/parsing/temp``；本地跑过
    Compose 后还留下 root 属主目录，让后续测试写不进去。现在与
    ``infrastructure/config/settings`` 的落盘根同源。
    """
    from infrastructure.fs.paths import get_work_dir
    return get_work_dir()


def create_parent_dir_all_path(file_path):
    parent_directory = os.path.dirname(file_path)
    if not os.path.exists(parent_directory):
        os.makedirs(parent_directory, exist_ok=True)


def create_dir_under_root(file_path):
    if not os.path.exists(get_workdir() + file_path):
        os.makedirs(get_workdir() + file_path, exist_ok=True)
    return get_workdir() + file_path


def get_name_pre(corpus_txt_name):
    return os.path.splitext(corpus_txt_name)[0]


def get_base_name(path):
    return os.path.basename(path)


def delete_temp():
    try:
        if os.path.exists(f'{get_workdir()}/temp'):
            shutil.rmtree(f'{get_workdir()}/temp')
    except Exception as e:
        log.error('delete temp error ', e)
