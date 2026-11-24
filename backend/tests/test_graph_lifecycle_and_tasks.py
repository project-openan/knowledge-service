"""lifecycle 接缝 + task_runtime 两条车道（桩存储，内存队列模式）。

lifecycle 钉的是「kbase 域只能经这条缝碰图存储」的每个包装；
task_runtime 钉的是：两条车道分开注册、取消钩子把库落成失败态、
``_run_import`` 收尾删 zip 与它的专用空目录（不 rmtree 任意父目录）。

跑法::

    python -m pytest tests/test_graph_lifecycle_and_tasks.py -q
"""

from __future__ import annotations



from graph import task_runtime
from graph.service import lifecycle
from infrastructure.tasks import TaskRecord


# ----------------------------------------------------------------------
# lifecycle
# ----------------------------------------------------------------------


def test_ensure_database_skips_non_graph_tables(monkeypatch):
    from graph.repository import graph_pg

    called = []
    monkeypatch.setattr(graph_pg, 'ensure_database_exists',
                        lambda client, name: called.append(name))
    monkeypatch.setattr(graph_pg, 'new_client', lambda name: {'name': name})

    lifecycle.ensure_database('doc_kb1')
    assert called == []

    lifecycle.ensure_database('graph_kb1')
    assert called == ['graph_kb1']


def test_count_wrappers(monkeypatch):
    from graph.repository import graph_pg

    monkeypatch.setattr(graph_pg, 'graph_db_name_for_query', lambda kb: f'graph_{kb}')
    monkeypatch.setattr(graph_pg, 'count_entities_and_edges',
                        lambda name: {'entityCount': 1, 'edgeCount': 2})
    assert lifecycle.count_graph_entities_and_edges('kb1') == {
        'entityCount': 1, 'edgeCount': 2}

    def boom(name):
        raise RuntimeError('down')

    monkeypatch.setattr(graph_pg, 'count_entities_and_edges', boom)
    assert lifecycle.count_graph_entities_and_edges('kb1') is None


def test_delete_and_drop_wrappers(monkeypatch):
    from graph.repository import graph_delete_store, graph_pg

    calls = []
    monkeypatch.setattr(graph_delete_store, 'delete_import_tasks',
                        lambda kb: calls.append('import'))
    monkeypatch.setattr(graph_delete_store, 'delete_extract_tasks',
                        lambda kb: calls.append('extract'))
    monkeypatch.setattr(graph_delete_store, 'drop_table_if_exists',
                        lambda name: calls.append(f'drop:{name}'))
    monkeypatch.setattr(graph_delete_store, 'delete_knowledge_graph_info',
                        lambda name: calls.append(f'registry:{name}'))
    monkeypatch.setattr(graph_pg, 'drop_database',
                        lambda client, name, missing_ok=False: calls.append('dropdb'))
    monkeypatch.setattr(graph_pg, 'new_client', lambda name: {'name': name})

    lifecycle.delete_import_and_extract_tasks('kb1')
    assert calls == ['import', 'extract']

    calls.clear()
    lifecycle.drop_chunk_and_vector_tables('kb1')
    assert calls == ['drop:kb_index.graph_kb1_chunk', 'drop:kb_index.graph_kb1_vector']

    calls.clear()
    lifecycle.delete_graph_database('kb1')
    assert calls == ['dropdb', 'registry:graph_kb1']


def test_chunk_wrappers_delegate_to_index_store(monkeypatch):
    from graph.repository import graph_index_store

    calls = []
    monkeypatch.setattr(graph_index_store, 'delete_chunks_by_sources',
                        lambda table, sources: calls.append(('delete', table, sources)))
    monkeypatch.setattr(graph_index_store, 'chunk_ids_for_sources',
                        lambda table, names: ['c1'])
    monkeypatch.setattr(graph_index_store, 'delete_source_graph_data',
                        lambda table, kb, ids: calls.append(('purge', table, kb, ids)))

    lifecycle.delete_chunks_by_sources('graph_kb1', ['a.md'])
    lifecycle.chunk_ids_for_sources('graph_kb1', ['a.md'])
    lifecycle.delete_source_graph_data('graph_kb1', 'kb1', ['c1'])
    assert calls == [('delete', 'graph_kb1', ['a.md']),
                     ('purge', 'graph_kb1', 'kb1', ['c1'])]


# ----------------------------------------------------------------------
# task_runtime
# ----------------------------------------------------------------------


def test_capacity_helper_parses_env(monkeypatch):
    monkeypatch.setenv('RKB_TEST_CAP', '7')
    assert task_runtime._capacity('RKB_TEST_CAP', 3) == 7
    monkeypatch.setenv('RKB_TEST_CAP', '')
    assert task_runtime._capacity('RKB_TEST_CAP', 3) == 3
    monkeypatch.setenv('RKB_TEST_CAP', 'bogus')
    assert task_runtime._capacity('RKB_TEST_CAP', 3) == 3
    monkeypatch.setenv('RKB_TEST_CAP', '0')
    assert task_runtime._capacity('RKB_TEST_CAP', 3) == 0


def test_cancel_hooks_require_kbase_id(monkeypatch):
    from knowledge_base.service import kbase_service as kbase_store

    calls = []
    monkeypatch.setattr(kbase_store, 'update_process',
                        lambda kb, status, progress: calls.append(('process', kb, status)))
    monkeypatch.setattr(kbase_store, 'update_process_with_time',
                        lambda kb, status, progress:
                        calls.append(('process_time', kb, status)))
    monkeypatch.setattr(kbase_store, 'update_fail_reason',
                        lambda kb, zh, en: calls.append(('reason', zh)))

    task_runtime._cancel_extract({'kbase_id': 'kb1'})
    task_runtime._cancel_extract({})
    task_runtime._cancel_import({'kbase_id': 'kb1'})
    task_runtime._cancel_import({})

    assert calls == [('process', 'kb1', 101), ('reason', '任务已取消'),
                     ('process_time', 'kb1', '104'), ('reason', '任务已取消')]


def test_run_extract_rebuilds_payload(monkeypatch):
    from graph.service import graph_extract_v2_service

    captured = {}
    monkeypatch.setattr(graph_extract_v2_service, '_run',
                        lambda task_id, tmp_dir, dto, schema_obj, is_update,
                        cache_schema_id=None: captured.update(
                            {'task_id': task_id, 'tmp_dir': tmp_dir, 'dto': dto,
                             'schema_obj': schema_obj, 'is_update': is_update,
                             'cache': cache_schema_id}))

    record = TaskRecord(task_id='t-1', kind='graph_extract', payload={'tmpDir': '/tmp/x', 'dto': {'kbId': 'kb1'},
                                                'schemaObj': {'a': 1}, 'isUpdate': True,
                                                'cacheSchemaId': 's-9'})
    task_runtime._run_extract(record, None)
    assert captured == {'task_id': 't-1', 'tmp_dir': '/tmp/x', 'dto': {'kbId': 'kb1'},
                        'schema_obj': {'a': 1}, 'is_update': True, 'cache': 's-9'}


def test_run_import_runs_engine_and_cleans_zip(monkeypatch, tmp_path):
    from graph.service import graph_import_engine

    captured = {}
    monkeypatch.setattr(graph_import_engine, 'import_from_zip',
                        lambda kb, schema, path, kbase_schema_obj=None, task_id=None:
                        captured.update({'kb': kb, 'zip': path}))

    folder = tmp_path / 'zip-dir'
    folder.mkdir()
    zip_path = folder / 'graph_import.zip'
    zip_path.write_bytes(b'x')
    record = TaskRecord(task_id='t-2', kind='graph_import', payload={'kbIndexName': 'graph_kb1',
                                                'schemaId': 's', 'zipPath': str(zip_path),
                                                'schemaObj': {'a': 1}})
    task_runtime._run_import(record, None)
    assert captured['kb'] == 'graph_kb1'
    assert not zip_path.exists()            # zip 被删
    assert not folder.exists()              # 专用空目录被删


def test_run_import_keeps_shared_parent_dirs(monkeypatch, tmp_path):
    from graph.service import graph_import_engine

    monkeypatch.setattr(graph_import_engine, 'import_from_zip',
                        lambda *a, **k: None)
    shared = tmp_path / 'shared'
    shared.mkdir()
    zip_path = shared / 'graph_import.zip'
    zip_path.write_bytes(b'x')
    # 目录里还有别的文件：rmdir 删不掉，zip 删掉后共享目录必须保留
    (shared / 'other-task.zip').write_bytes(b'y')
    record = TaskRecord(task_id='t-3', kind='graph_import',
                        payload={'zipPath': str(zip_path)})
    task_runtime._run_import(record, None)
    assert shared.exists()                  # 非空父目录不动
    assert not zip_path.exists()


def test_run_import_tolerates_missing_zip(monkeypatch):
    from graph.service import graph_import_engine

    monkeypatch.setattr(graph_import_engine, 'import_from_zip', lambda *a, **k: None)
    record = TaskRecord(task_id='t-4', kind='graph_import',
                        payload={'zipPath': '/nonexistent/x.zip'})
    task_runtime._run_import(record, None)  # 不抛

    record = TaskRecord(task_id='t-5', kind='graph_import', payload={})
    task_runtime._run_import(record, None)  # 无 zipPath 也不抛


def test_stats_and_lane_separation():
    stats = task_runtime.stats()
    assert 'graph_extract' in stats and 'graph_import' in stats


def test_submit_paths_delegate_to_engine(monkeypatch):
    captured = []
    monkeypatch.setattr(task_runtime._ENGINE, 'submit',
                        lambda lane, payload, task_id=None, create_row=True:
                        captured.append((lane, task_id, create_row)) or 'id')
    assert task_runtime.submit_extract({'a': 1}, task_id='t') == 'id'
    assert task_runtime.submit_update({'a': 1}, task_id='t') == 'id'
    assert task_runtime.submit_import({'a': 1}, task_id='t') == 'id'
    assert captured == [('graph_extract', 't', False),
                        ('graph_extract', 't', False),
                        ('graph_import', 't', False)]


def test_ensure_capacity_delegates(monkeypatch):
    calls = []
    monkeypatch.setattr(task_runtime._ENGINE, 'ensure_capacity',
                        lambda lane: calls.append(lane))
    task_runtime.ensure_extract_capacity()
    task_runtime.ensure_import_capacity()
    assert calls == ['graph_extract', 'graph_import']
