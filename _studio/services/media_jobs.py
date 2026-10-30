"""媒体同步任务：持久化待办、共享写锁和可重试回执，避免加锁后重新公开。"""

import json
import os
import time
from . import storage, storage_journal, media_store


def _path():
    return os.path.join(storage_journal.local_root(), 'media-outbox.json')


def pending():
    if not os.path.isfile(_path()):
        return []
    with open(_path(), encoding='utf-8') as source:
        jobs = json.load(source)
    if not isinstance(jobs, list):
        raise ValueError('Invalid media outbox; restore it before modifying media')
    return jobs


@storage.serialized
def cancel(keys):
    keys = set(keys)
    jobs = pending()
    kept = [job for job in jobs if job['key'] not in keys]
    if len(kept) != len(jobs):
        storage.write_json(_path(), kept)


@storage.serialized
def enqueue(action, key):
    media_store._key(key)
    try:
        identity = media_store.get_store().identity()
    except Exception:
        if action == 'delete':
            raise
        # 尚未发生远端写入的本地新图可等待配置修复；首次执行前再固定目标。
        identity = None
    job = {'action': action, 'key': key, 'backend': identity, 'created': time.time()}
    jobs = [entry for entry in pending() if entry['key'] != key]
    jobs.append(job)
    storage.write_json(_path(), jobs)


@storage.serialized
def submit(action, key):
    enqueue(action, key)
    return retry([key])


@storage.serialized
def retry(keys=None):
    """与加锁共用锁；失败保留待办，不报告云端已完成。"""
    jobs, remaining, done = pending(), [], 0
    store = None
    for job in jobs:
        if keys is not None and job['key'] not in keys:
            remaining.append(job)
            continue
        try:
            store = store or media_store.get_store()
            if job['backend'] is None:
                job['backend'] = store.identity()
                storage.write_json(_path(), jobs)
            if job['backend'] != store.identity():
                raise RuntimeError('Media backend changed while uploads are pending')
            if job['action'] == 'upload':
                from .photos import media_path
                with open(media_path(job['key']), 'rb') as source:
                    store.write('public', job['key'], source.read())
            elif job['action'] == 'delete':
                store.delete('public', job['key'])
            else:
                raise ValueError('Invalid media task')
            done += 1
        except Exception as error:
            print(f"  [ MEDIA ] ⚠️ 同步未完成，待办已保留 | Synchronization pending: {error}")
            remaining.append(job)
    if jobs:
        storage.write_json(_path(), remaining)
    return {'state': 'pending' if remaining else 'complete', 'completed': done, 'pending': len(remaining)}
