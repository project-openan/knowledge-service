"""``directory_service`` 的端点与 VO 装配（补既有目录测试之外的分支）。

不连库：``directory_store`` 用一个小型内存树替身（含游标协议），
``get_kbase_for_aspect`` 直接放行。

跑法（服务目录下）::

    python -m pytest tests/test_kb_directory_service.py -q
"""

from __future__ import annotations

import pytest

from shared.errors.api import KbApiError, KbValidationError
from knowledge_base.service import directory_service as ds


_ROW_COLUMNS = ('id', 'kbase_id', 'title', 'parent_id', 'parent_path', 'can_spread',
                'type', 'status', 'created_by', 'created_at', 'updated_by', 'updated_at',
                'file_from', 'fail_reason')


class _SqlCursor:
    """能看懂服务里那几条手写 SQL 的游标（直接在内存树上执行）。"""

    def __init__(self, tree):
        self.tree = tree
        self.description = None
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        query = ' '.join(sql.split())
        params = params or ()
        if query.startswith('SELECT id FROM kb_directory WHERE kbase_id = %s AND type'):
            kbase_id, dir_type = params
            self._rows = [(row_id,)
                          for row_id, row in sorted(self.tree.rows.items())
                          if row['kbase_id'] == kbase_id and row['type'] == dir_type]
        elif query.startswith('SELECT title FROM kb_directory WHERE kbase_id = %s'):
            kbase_id, parent_id, excluded = params
            self._rows = [(row['title'],) for row in self.tree.rows.values()
                          if row['kbase_id'] == kbase_id
                          and row.get('parent_id') == parent_id
                          and row['type'] == self.tree.TYPE_FILE
                          and row['id'] not in set(excluded or [])]
        elif query.startswith('UPDATE kb_directory SET parent_id'):
            parent_id, parent_path, updated_by, kbase_id, ids = params
            for file_id in ids:
                row = self.tree.rows[file_id]
                row['parent_id'] = parent_id
                row['parent_path'] = parent_path
                row['updated_by'] = updated_by
            self.tree.moved.append(list(ids))
        elif query.startswith('SELECT * FROM kb_directory WHERE id = %s'):
            row = self.tree.rows.get(params[0])
            self.description = [(name,) for name in _ROW_COLUMNS]
            self._rows = [tuple(row.get(name) for name in _ROW_COLUMNS)] if row else []
        else:
            self._rows = []

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _SqlConn:
    def __init__(self, tree):
        self._tree = tree

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return _SqlCursor(self._tree)


class _DirTree:
    """``directory_store`` 的内存树替身：文件夹/文件行 + 属性。"""

    TYPE_FOLDER = 'folder'
    TYPE_FILE = 'file'
    ROOT_DIRECTORY_SYMBOL = '0'
    PATH_SPLIT = '-'
    DOCUMENT_TYPE = 'document'
    FLAG_ENABLE = 'Y'
    FLAG_DISABLE = 'N'

    def __init__(self, rows=None, properties=None):
        self.rows = {row['id']: dict(row) for row in (_default_rows() if rows is None else rows)}
        self.properties = dict(properties or {})
        self.inserted = []
        self.deleted_folders = []
        self.moved = []
        self.updated_titles = []

    # -- 游标协议 ----------------------------------------------------------
    def connection(self):
        return _SqlConn(self)

    # -- 目录 DAO ----------------------------------------------------------
    def count_children_folders(self, cursor, kbase_id, parent_id):
        return sum(1 for row in self.rows.values()
                   if row['kbase_id'] == kbase_id
                   and row.get('parent_id') == parent_id
                   and row['type'] == self.TYPE_FOLDER)

    def get_parent_path(self, cursor, parent_id):
        if not parent_id:
            return self.ROOT_DIRECTORY_SYMBOL
        row = self.rows.get(parent_id)
        if row is None:
            raise LookupError(parent_id)
        return f"{row.get('parent_path')}{self.PATH_SPLIT}{parent_id}"

    def find_folder_by_title(self, cursor, kbase_id, parent_id, title):
        for row in self.rows.values():
            if (row['kbase_id'] == kbase_id and row.get('title') == title
                    and row.get('parent_id') == parent_id
                    and row['type'] == self.TYPE_FOLDER):
                return row
        return None

    def insert_directory(self, cursor, kbase_id, parent_id, parent_path, title,
                         dir_type, status, directory_id=None, created_by=None,
                         file_from=None):
        directory_id = directory_id or f'new-{len(self.rows) + 1}'
        self.rows[directory_id] = {
            'id': directory_id, 'kbase_id': kbase_id, 'title': title,
            'parent_id': parent_id, 'parent_path': parent_path, 'type': dir_type,
            'status': status, 'created_by': created_by, 'created_at': None,
            'updated_by': None, 'updated_at': None, 'can_spread': False,
            'file_from': file_from, 'fail_reason': None,
        }
        self.inserted.append(directory_id)
        return directory_id

    def update_title(self, cursor, directory_id, title):
        self.rows[directory_id]['title'] = title
        self.updated_titles.append((directory_id, title))

    def delete_folders(self, cursor, ids):
        for directory_id in ids:
            self.rows.pop(directory_id, None)
        self.deleted_folders.append(list(ids))

    def get_directory(self, directory_id, kbase_id, dir_type=None):
        row = self.rows.get(directory_id)
        if row is None or row['kbase_id'] != kbase_id:
            return None
        if dir_type and row['type'] != dir_type:
            return None
        return dict(row)

    def get_children(self, kbase_id, parent_id, dir_type=None):
        out = []
        for row in self.rows.values():
            if row['kbase_id'] != kbase_id:
                continue
            if row.get('parent_id') != (parent_id or None):
                continue
            if dir_type and row['type'] != dir_type:
                continue
            out.append(dict(row))
        return out

    def get_descendants(self, kbase_id, parent_id, dir_type=None):
        if not parent_id:
            return self.get_children(kbase_id, None, dir_type)
        out = []
        frontier = [parent_id]
        while frontier:
            current = frontier.pop()
            for row in self.rows.values():
                if row.get('parent_id') != current:
                    continue
                if not (dir_type is None or row['type'] == dir_type):
                    continue
                out.append(dict(row))
                frontier.append(row['id'])
        return out

    def get_all_folders(self, kbase_id):
        return [dict(row) for row in self.rows.values()
                if row['kbase_id'] == kbase_id and row['type'] == self.TYPE_FOLDER]

    def get_files_by_ids(self, ids, kbase_id=None):
        wanted = [item for item in ids if item]
        return [dict(self.rows[item]) for item in wanted
                if item in self.rows
                and (kbase_id is None or self.rows[item]['kbase_id'] == kbase_id)]

    def get_all_files(self, kbase_id):
        return [dict(row) for row in self.rows.values()
                if row['kbase_id'] == kbase_id and row['type'] == self.TYPE_FILE]

    # -- 属性 DAO ----------------------------------------------------------
    def get_properties(self, file_ids, name):
        return {fid: self.properties[(fid, name)]
                for fid in file_ids if (fid, name) in self.properties}

    def get_all_properties(self, file_ids):
        result = {}
        for (fid, name), value in self.properties.items():
            if fid in file_ids:
                result.setdefault(fid, {})[name] = value
        return result

    # -- 分页 DAO（简单返回，不真正分页）-----------------------------------
    def count_files_by_page(self, kbase_id, parent_id, keyword):
        return len(self._files(kbase_id, parent_id, keyword))

    def search_files_by_page(self, kbase_id, parent_id, keyword, limit, offset):
        return self._files(kbase_id, parent_id, keyword)[offset:offset + limit]

    def count_all_files(self, kbase_id, keyword):
        return len(self._files(kbase_id, None, keyword))

    def search_all_files_by_page(self, kbase_id, keyword, limit, offset):
        return self._files(kbase_id, None, keyword)[offset:offset + limit]

    def query_by_ktype(self, kbase_id, parent_id, k_type):
        return [dict(row) for row in self.rows.values()
                if row['kbase_id'] == kbase_id
                and self.properties.get((row['id'], 'KType')) == k_type]

    def _files(self, kbase_id, parent_id, keyword):
        out = []
        for row in self.rows.values():
            if row['kbase_id'] != kbase_id or row['type'] != self.TYPE_FILE:
                continue
            if parent_id is not None and row.get('parent_id') != parent_id:
                continue
            if keyword and keyword not in (row.get('title') or ''):
                continue
            out.append(dict(row))
        return out

    def titles_by_ids(self, kbase_id, ids):
        return [self.rows[i]['title'] for i in ids if i in self.rows]

    def delete_properties_by_file_ids(self, kbase_id, ids):
        pass


def _default_rows():
    rows = [
        {'id': 'root', 'kbase_id': 'kb1', 'title': 'Default', 'parent_id': None,
         'parent_path': '0', 'type': 'folder', 'status': None, 'can_spread': False,
         'created_at': None, 'updated_at': None, 'created_by': 'admin',
         'updated_by': None, 'file_from': None, 'fail_reason': None},
        {'id': 'sub', 'kbase_id': 'kb1', 'title': '子目录', 'parent_id': 'root',
         'parent_path': '0-root', 'type': 'folder', 'status': None, 'can_spread': False,
         'created_at': None, 'updated_at': None, 'created_by': 'admin',
         'updated_by': None, 'file_from': None, 'fail_reason': None},
        {'id': 'f1', 'kbase_id': 'kb1', 'title': 'a.md', 'parent_id': 'root',
         'parent_path': '0-root', 'type': 'file', 'status': 1, 'can_spread': False,
         'created_at': None, 'updated_at': None, 'created_by': 'admin',
         'updated_by': None, 'file_from': '1', 'fail_reason': None},
        {'id': 'f2', 'kbase_id': 'kb1', 'title': 'b.md', 'parent_id': 'sub',
         'parent_path': '0-root-sub', 'type': 'file', 'status': -3,
         'can_spread': False, 'created_at': None, 'updated_at': None,
         'created_by': 'admin', 'updated_by': None, 'file_from': None,
         'fail_reason': None},
    ]
    return rows


def _tree(**extra):
    rows = _default_rows()
    rows.extend(extra)
    return _DirTree(rows, properties={('f1', 'file_size'): '12',
                                      ('f1', 'KType'): 'document'})


@pytest.fixture()
def tree(monkeypatch):
    stub = _tree()
    monkeypatch.setattr(ds, 'directory_store', stub)
    monkeypatch.setattr(ds, 'get_kbase_for_aspect', lambda kbase_id: {'kbase_id': kbase_id})
    return stub


LOCALIZE = lambda key: f'[{key}]'  # noqa: E731


# ----------------------------------------------------------------------
# 标题校验与 VO 装配
# ----------------------------------------------------------------------


@pytest.mark.parametrize('title', ['合法标题', 'ab', 'x' * 30, 'name with space'])
def test_validate_title_accepts(tree, title):
    assert ds._validate_title(title) == title.strip()


@pytest.mark.parametrize('title', ['a', 'x' * 31, 'bad/name', '  ', None])
def test_validate_title_rejects(tree, title):
    with pytest.raises(KbApiError) as caught:
        ds._validate_title(title)
    assert caught.value.key == 'directory.title.validation'


def test_assemble_full_steps(tree):
    vos = ds.assemble([_DirTree().rows['f1']], LOCALIZE, ds.FULL_ASSEMBLY)

    vo = vos[0]
    assert vo['fileSize'] == 12
    assert vo['kType'] == 'document'
    assert vo['idChain'] == '0-root-f1'
    assert vo['canSpread'] == 'N'                              # 树内无文件夹孩子
    assert vo['props'] == {'file_size': '12', 'KType': 'document'}


def test_assemble_descendants_steps_skip_ktype_and_id_chain(tree):
    vos = ds.assemble([_DirTree().rows['f1']], LOCALIZE, ds.DESCENDANTS_ASSEMBLY)

    assert vos[0]['kType'] is None
    assert vos[0]['idChain'] is None
    assert vos[0]['fileSize'] == 12


def test_assemble_without_steps_keeps_nulls(tree):
    vo = ds.assemble([_DirTree().rows['f1']], LOCALIZE)[0]

    assert vo['fileSize'] is None and vo['props'] is None


def test_assemble_marks_fail_reason_for_failed_files(tree):
    row = {'id': 'fx', 'kbase_id': 'kb1', 'title': 'x.md', 'parent_id': None,
           'parent_path': '0', 'type': 'file', 'status': 2,
           'fail_reason': 'RetCode.file.save.error', 'can_spread': None,
           'created_at': None, 'updated_at': None, 'created_by': None,
           'updated_by': None, 'file_from': None}
    vo = ds.assemble([row], LOCALIZE, ds.FULL_ASSEMBLY)[0]

    assert vo['errorMsg'] == '[RetCode.file.save.error]'


def test_reset_status_folds_negative_states(tree):
    row = dict(_DirTree().rows['f2'])
    vo = ds.assemble([row], LOCALIZE, ds.FULL_ASSEMBLY)[0]

    assert vo['status'] == 0                                   # -3 → 0


def test_reset_spread_state_only_counts_folder_children(tree):
    root = dict(_DirTree().rows['root'], can_spread=True)
    sub = dict(_DirTree().rows['sub'], can_spread=True)
    rows = [root, sub, _DirTree().rows['f1']]
    vos = ds.assemble(rows, LOCALIZE, ds.FULL_ASSEMBLY)

    by_id = {vo['id']: vo for vo in vos}
    assert by_id['root']['canSpread'] == 'Y'                   # 有文件夹孩子 → 保持
    assert by_id['sub']['canSpread'] == 'N'                    # 只有文件孩子 → 置 N
    assert [child['id'] for child in by_id['root']['childList']] == ['sub', 'f1']


def test_sort_vos_folders_first_then_title():
    vos = [{'id': 'f', 'type': 'file', 'title': 'aaa'},
           {'id': 'd', 'type': 'folder', 'title': 'zzz'},
           {'id': 'f2', 'type': 'file', 'title': 'AAA'}]

    ordered = [vo['id'] for vo in ds.sort_vos(vos)]

    assert ordered == ['d', 'f2', 'f']                         # 大小写折叠的同名稳定


# ----------------------------------------------------------------------
# 端点
# ----------------------------------------------------------------------


def test_list_children_sorts_folders_first(tree):
    tree.rows['aaa'] = {'id': 'aaa', 'kbase_id': 'kb1', 'title': 'aaa.md',
                        'parent_id': 'root', 'parent_path': '0-root', 'type': 'file',
                        'status': 1, 'can_spread': False, 'created_at': None,
                        'updated_at': None, 'created_by': None, 'updated_by': None,
                        'file_from': None, 'fail_reason': None}

    vos = ds.list_children('kb1', 'root', None, LOCALIZE)

    assert vos[0]['type'] == 'folder'
    assert all(vo['kType'] is not None for vo in vos if vo['type'] == 'file')


def test_list_descendants_sorts_only_on_demand(tree):
    unsorted = ds.list_descendants('kb1', 'root', None, False, LOCALIZE)
    sorted_vos = ds.list_descendants('kb1', 'root', None, True, LOCALIZE)

    assert {vo['id'] for vo in unsorted} == {'sub', 'f1', 'f2'}
    assert sorted_vos[0]['type'] == 'folder'


def test_query_or_create_directory_returns_existing(tree):
    assert ds.query_or_create_directory('kb1', '随便') == 'root'
    assert tree.inserted == []


def test_query_or_create_directory_creates_when_empty(monkeypatch):
    stub = _DirTree()                                          # 空库
    monkeypatch.setattr(ds, 'directory_store', stub)

    new_id = ds.query_or_create_directory('kb1', 'Default')

    assert new_id in stub.rows and stub.rows[new_id]['type'] == 'folder'
    assert stub.rows[new_id]['parent_id'] is None              # 根目录统一 NULL


def test_create_directory_rejects_level_overflow(tree):
    deep = {'id': 'l2', 'kbase_id': 'kb1', 'title': '二层', 'parent_id': 'sub',
            'parent_path': '0-root-sub', 'type': 'folder', 'status': None,
            'can_spread': False, 'created_at': None, 'updated_at': None,
            'created_by': None, 'updated_by': None, 'file_from': None,
            'fail_reason': None}
    tree.rows['l2'] = deep

    with pytest.raises(KbApiError) as caught:
        ds.create_directory('kb1', 'l2', '三层')                # 0-root-sub-l2 → 4 段

    assert caught.value.key == 'directory.level.limit'


def test_create_directory_rejects_duplicate_title(tree):
    with pytest.raises(KbApiError) as caught:
        ds.create_directory('kb1', 'root', '子目录')

    assert caught.value.key == 'directory.already.exist'


def test_create_directory_rejects_full_folder(tree, monkeypatch):
    monkeypatch.setattr(tree, 'count_children_folders',
                        lambda cursor, kbase_id, parent_id: ds.FOLDER_LIMIT)

    with pytest.raises(KbApiError) as caught:
        ds.create_directory('kb1', 'root', '新目录')

    assert caught.value.key == 'directory.folder.size.over.limit'


def test_create_directory_success_has_no_id_chain(tree):
    vo = ds.create_directory('kb1', 'root', '新目录', created_by='admin')

    assert vo['id'] in tree.rows
    assert vo['idChain'] is None                               # 建目录不装配 idChain
    assert vo['parentId'] == 'root'


def test_update_directory_matrix(tree):
    with pytest.raises(KbApiError) as caught:
        ds.update_directory('kb1', 'ghost', '新名')
    assert caught.value.key == 'directory.not.exist'

    # 空名 → 原样返回，不写库
    vo = ds.update_directory('kb1', 'sub', '   ')
    assert vo['title'] == '子目录' and tree.updated_titles == []

    # 改成同级已存在的名字 → 拒（同级 = parent_id 相同）
    tree.rows['sib'] = dict(tree.rows['sub'], id='sib', title='同级')
    with pytest.raises(KbApiError) as caught:
        ds.update_directory('kb1', 'sub', '同级')
    assert caught.value.key == 'directory.already.exist'

    vo = ds.update_directory('kb1', 'sub', '改名后')
    assert vo['title'] == '改名后'
    assert tree.updated_titles == [('sub', '改名后')]


def test_move_files_validations(tree):
    with pytest.raises(KbValidationError):
        ds.move_files('kb1', [], 'root')

    with pytest.raises(KbApiError) as caught:
        ds.move_files('kb1', ['f1'], 'ghost')
    assert caught.value.key == 'directory.not.exist'

    with pytest.raises(KbApiError) as caught:
        ds.move_files('kb1', ['f1', 'ghost-file'], 'root')
    assert caught.value.key == 'file.not.exist'

    tree.rows['f3'] = dict(tree.rows['f1'], id='f3')           # 与 f1 同名（不同目录）
    with pytest.raises(KbApiError) as caught:
        ds.move_files('kb1', ['f1', 'f3'], 'sub')
    assert caught.value.key == 'file.upload.rename'


def test_move_files_updates_parent(tree):
    moved = ds.move_files('kb1', ['f1'], 'sub', emp_no='admin')

    assert moved == 1
    row = tree.rows['f1']
    assert row['parent_id'] == 'sub'
    assert row['parent_path'] == '0-root'                      # 目标目录自己的 parent_path 原样搬


def test_delete_directory_keep_files_requires_child_folder(tree):
    with pytest.raises(KbApiError):
        ds.delete_directory_keep_files('kb1', 'ghost', 'admin')

    with pytest.raises(KbApiError) as caught:
        ds.delete_directory_keep_files('kb1', 'root', 'admin')  # 根目录不许删
    assert caught.value.key == 'directory.not.exist'


def test_delete_directory_keep_files_moves_files_to_default(tree):
    tree.rows['sub2'] = dict(tree.rows['sub'], id='sub2', title='第二个目录',
                             parent_id='root', parent_path='0-root')
    tree.rows['f3'] = dict(tree.rows['f1'], id='f3', title='c.md',
                           parent_id='sub2', parent_path='0-root-sub2')

    ds.delete_directory_keep_files('kb1', 'sub', 'admin')

    assert 'sub' not in tree.rows
    assert tree.rows['f2']['parent_id'] == 'root'              # 移到 Default
    assert tree.rows['f2']['parent_path'] == '0'               # Default 的 parent_path
    assert tree.deleted_folders == [['sub']]
    assert 'f1' in tree.rows and 'f2' in tree.rows             # 文档保留


def test_delete_directory_keep_files_rejects_same_title_in_default(tree):
    tree.rows['f3'] = dict(tree.rows['f1'], id='f3', title='b.md',
                           parent_id='root', parent_path='0-root')

    with pytest.raises(KbApiError) as caught:
        ds.delete_directory_keep_files('kb1', 'sub', 'admin')

    assert caught.value.key == 'file.upload.rename'


def test_delete_directory_keep_files_without_any_root_fails(monkeypatch):
    stub = _DirTree(rows=[{'id': 'only', 'kbase_id': 'kb1', 'title': '唯一目录',
                           'parent_id': None, 'parent_path': '0', 'type': 'folder',
                           'status': None, 'can_spread': False, 'created_at': None,
                           'updated_at': None, 'created_by': None, 'updated_by': None,
                           'file_from': None, 'fail_reason': None}])
    monkeypatch.setattr(ds, 'directory_store', stub)
    monkeypatch.setattr(ds, 'get_kbase_for_aspect', lambda k: {'kbase_id': k})

    with pytest.raises(KbApiError):
        ds.delete_directory_keep_files('kb1', 'only', 'admin')


def test_delete_directory_delegates_to_write_service(tree, monkeypatch):
    from knowledge_base.repository import kbase as kbase_store

    delegated = {}
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: {'id': 5})

    import knowledge_base.service.kbase_write_service as write_service
    monkeypatch.setattr(write_service, '_delete_one_directory',
                        lambda kbase_id, pk_id, directory_id, storage:
                        delegated.update(args=(kbase_id, pk_id, directory_id)))

    ds.delete_directory('kb1', 'sub', LOCALIZE)

    assert delegated['args'] == ('kb1', 5, 'sub')

    with pytest.raises(KbApiError):
        ds.delete_directory('kb1', 'ghost', LOCALIZE)


# ----------------------------------------------------------------------
# 分页
# ----------------------------------------------------------------------


def test_page_params_boundaries():
    assert ds._page_params(None, None) == (1, 10)
    assert ds._page_params(0, 0) == (1, 10)                    # 0 是 falsy → 取默认值

    for page, size in [(-1, 10), (1, ds.MAX_PAGE_SIZE + 1)]:
        with pytest.raises(KbValidationError):
            ds._page_params(page, size)


def test_search_page_file_empty_result(tree):
    body = ds.search_page_file('kb1', 'sub', '不存在', 1, 10, LOCALIZE)

    assert body['total'] == 0 and body['items'] == []


def test_search_page_file_assembles(tree):
    body = ds.search_page_file('kb1', 'root', None, 1, 10, LOCALIZE)

    assert body['total'] == 1
    assert body['items'][0]['id'] == 'f1'
    assert body['items'][0]['kType'] == 'document'


def test_search_page_file_rejects_bad_params_before_kbase_check(monkeypatch):
    def _boom(kbase_id):
        raise AssertionError('参数校验应先于切面')

    monkeypatch.setattr(ds, 'get_kbase_for_aspect', _boom)

    with pytest.raises(KbValidationError):
        ds.search_page_file('kb1', None, None, 1, 101, LOCALIZE)


def test_search_all_files_page_attaches_chunk_counts(tree, monkeypatch):
    monkeypatch.setattr(ds.chunk_store, 'count_by_files',
                        lambda kbase, ids: {'f1': 4})

    body = ds.search_all_files_page('kb1', None, 1, 10, LOCALIZE)

    rows = {row['id']: row for row in body['items']}
    assert rows['f1']['chunkCount'] == 4                       # status=1 的文件才有
    assert 'chunkCount' not in rows['f2']                      # 处理中不加字段


def test_attach_chunk_counts_swallows_store_errors(tree, monkeypatch):
    def boom(kbase, ids):
        raise RuntimeError('chunk table missing')

    monkeypatch.setattr(ds.chunk_store, 'count_by_files', boom)

    vos = ds.assemble(tree.get_all_files('kb1'), LOCALIZE, ds.FULL_ASSEMBLY)
    for vo in vos:
        vo['status'] = 1
    ds._attach_chunk_counts({'kbase_id': 'kb1'}, vos)

    assert all('chunkCount' not in vo for vo in vos)


def test_query_files_by_type_drops_running_rows(tree):
    tree.properties[('f2', 'KType')] = 'document'
    tree.rows['f2']['status'] = 0                              # 运行中（0）要剔除

    vos = ds.query_files_by_type('kb1', None, 'document', LOCALIZE)

    ids = {vo['id'] for vo in vos}
    assert 'f2' not in ids                                     # status 0 被剔除
    assert vos[0]['kType'] is None                             # 不装配


# ----------------------------------------------------------------------
# getNameById
# ----------------------------------------------------------------------


def test_get_name_by_id_type_whitelist(tree):
    with pytest.raises(KbApiError) as caught:
        ds.get_name_by_id({'type': 'unknown', 'ids': []})
    assert caught.value.key == 'knowledgeVector.format.incorrect'

    with pytest.raises(KbApiError):
        ds.get_name_by_id({'type': None, 'ids': []})


def test_get_name_by_id_requires_ids_array(tree):
    # ids 缺席/为 null → 同一条 0005；非数组在绑定期就 ValueError（HTTP 层转 0004）
    with pytest.raises(KbApiError):
        ds.get_name_by_id({'ids': None})

    with pytest.raises(ValueError):
        ds.get_name_by_id({'ids': 'not-a-list'})


def test_get_name_by_id_requires_item_fields(tree):
    # 元素不是对象 → 绑定期 ValueError
    with pytest.raises(ValueError):
        ds.get_name_by_id({'type': 'file', 'ids': ['not-a-dict']})

    for items in ([{'id': '', 'kbaseId': 'kb1'}], [{'id': 'f1', 'kbaseId': ''}],
                  [{'id': 'f1'}], [{'kbaseId': 'kb1'}]):
        with pytest.raises(KbApiError):
            ds.get_name_by_id({'type': 'file', 'ids': items})


def test_get_name_by_id_resolves_files_and_kbases(tree, monkeypatch):
    from knowledge_base.repository import kbase as kbase_store
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id',
                        lambda kbase_id: {'name': '库名'} if kbase_id == 'kb1' else None)

    result = ds.get_name_by_id({'type': 'file', 'ids': [
        {'id': 'f1', 'kbaseId': 'kb1'}, {'id': 'ghost', 'kbaseId': 'kb1'}]})
    assert result[0] == {'name': 'a.md', 'idChain': '0-root-f1',
                         'id': 'f1', 'kbaseId': 'kb1'}
    assert result[1] == {'name': None, 'idChain': None, 'id': None, 'kbaseId': None}

    result = ds.get_name_by_id({'ids': [{'id': 'kb1', 'kbaseId': 'kb1'}]})   # 缺 type → kbase
    assert result[0]['name'] == '库名' and result[0]['idChain'] == '0'

    result = ds.get_name_by_id({'type': 'folder', 'ids': [{'id': 'sub', 'kbaseId': 'kb1'}]})
    assert result[0]['name'] == '子目录'


def test_get_name_by_id_swallows_lookup_errors(tree, monkeypatch):
    def boom(directory_id, kbase_id):
        raise RuntimeError('db down')

    monkeypatch.setattr(ds.directory_store, 'get_directory', boom)

    result = ds.get_name_by_id({'type': 'file', 'ids': [{'id': 'f1', 'kbaseId': 'kb1'}]})

    assert result == [{'name': None, 'idChain': None, 'id': None, 'kbaseId': None}]


def test_kbase_pk_id_defaults_to_zero(monkeypatch):
    from knowledge_base.repository import kbase as kbase_store
    monkeypatch.setattr(kbase_store, 'select_kbase_by_id', lambda _: None)

    assert ds._kbase_pk_id('ghost') == 0
