"""媒体同步任务：持久化待办、共享写锁和可重试回执，避免加锁后重新公开。"""

import json
import os
import time
from . import local_media, storage, storage_journal, media_store, operation_status


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


def drafts(keys):
    keys = set(keys)
    return {job['key']: job for job in pending() if job.get('deferred') and job['key'] in keys} if keys else {}


def draft_groups(job):
    return set(job.get('groups', ())) | ({job['group']} if job.get('group') else set())


@storage.serialized
def replace_drafts(changes):
    if changes:
        storage.write_json(_path(), [changes.get(job['key'], job) for job in pending()])


def check_target(store, job):
    if job['backend'] != store.identity():
        raise ValueError('图片待办的媒体存储已变更，请恢复原配置')
    if job.get('bucketId') and store.bucket_target(job['bucketId']) != job.get('bucketTarget'):
        raise ValueError('图片待办的桶组已变更，请恢复原配置')


@storage.serialized
def cancel(keys):
    keys = set(keys)
    jobs = pending()
    kept = [job for job in jobs if job['key'] not in keys]
    if len(kept) != len(jobs):
        storage.write_json(_path(), kept)


@storage.serialized
def enqueue(action, key, bucket_id=None, *, deferred=False, group=None, store=None):
    media_store._key(key)
    jobs = pending()
    if not deferred and action != 'delete' and any(job['key'] == key and job.get('deferred') for job in jobs):
        return
    try:
        store = store or media_store.get_store()
        identity = store.identity()
        target = store.bucket_target(bucket_id) if bucket_id else None
    except Exception:
        if action == 'delete' or bucket_id:
            raise
        # 尚未发生远端写入的本地新图可等待配置修复；首次执行前再固定目标。
        identity = None
    job = {'action': action, 'key': key, 'backend': identity, 'created': time.time()}
    if bucket_id:
        job.update(bucketId=bucket_id, bucketTarget=target)
    if deferred:
        job.update(deferred=True, attemptedScope=None)
    if group:
        job['groups'] = [group]
    jobs = [entry for entry in jobs if entry['key'] != key]
    jobs.append(job)
    storage.write_json(_path(), jobs)


@storage.serialized
def submit(action, keys, *, only_if_missing=None, bucket_id=None):
    keys = [keys] if isinstance(keys, str) else list(dict.fromkeys(keys))
    for key in keys:
        enqueue('ensure' if key == only_if_missing else action, key, bucket_id)
    return retry(keys)


@storage.serialized
def retry(keys=None, *, for_publish=False):
    """只有 Git 发布可以运行暂存图片的任务，失败保留待办。"""
    jobs, remaining, done = pending(), [], 0
    keys = None if keys is None else set(keys)

    def selected(job):
        return (keys is None or job['key'] in keys) and (for_publish or not job.get('deferred'))

    total = sum(selected(job) for job in jobs)
    private = local_media.private_keys() if total else {}
    store = None
    for job in jobs:
        if not selected(job):
            remaining.append(job)
            continue
        try:
            operation_status.update('正在同步图片', done, total)
            store = store or media_store.get_store()
            if job['backend'] is None:
                job['backend'] = store.identity()
                storage.write_json(_path(), jobs)
            check_target(store, job)
            groups = draft_groups(job)
            if not groups and job['action'] in ('upload', 'ensure') and local_media.is_private(job['key'], private):
                raise ValueError('私密图片不能同步到公开桶')
            if job.get('deferred') and not job.get('attemptedScope'):
                # 响应丢失时也能识别可能已经写入正式桶的草稿。
                job['attemptedScope'] = 'private' if groups else 'public'
                storage.write_json(_path(), jobs)
            if groups:
                _publish_private(store, job, groups)
            elif job['action'] in ('upload', 'ensure'):
                from .photos import media_path
                if job.get('bucketId'):
                    store.claim_bucket(job['key'], job['bucketId'])
                if job.get('deferred'):
                    _publish_draft(store, 'public', job['key'], media_path(job['key']))
                elif job['action'] == 'upload' or not store.exists('public', job['key']):
                    with open(media_path(job['key']), 'rb') as source:
                        store.write('public', job['key'], source.read())
            elif job['action'] == 'delete':
                expected = job.get('bucketId')
                if not expected or store.bucket_id(job['key']) == expected:
                    store.delete('public', job['key'])
                elif store.exists('public', job['key']) or store._group(expected).exists('public', job['key']):
                    raise RuntimeError('File bucket could not be confirmed for deletion')
            else:
                raise ValueError('Invalid media task')
            done += 1
            operation_status.update('正在同步图片', done, total)
        except Exception as error:
            print(f"  [ MEDIA ] ⚠️ 同步未完成，待办已保留 | Synchronization pending: {error}")
            remaining.append(job)
    if total:
        storage.write_json(_path(), remaining)
    failed = total - done if for_publish else sum(not job.get('deferred') for job in remaining)
    return {'state': 'pending' if failed else 'complete', 'completed': done, 'pending': failed}


def _publish_draft(store, scope, key, path):
    with open(path, 'rb') as source:
        data = source.read()
    # 避免发布重试为同一张图片额外创建 B2 文件版本。
    if not store.exists(scope, key) or store.read(scope, key) != data:
        store.write(scope, key, data)


def _publish_private(store, job, groups):
    from . import media_groups
    key = job['key']
    with storage.transaction():
        store.claim_bucket(key, job['bucketId'])
        media_groups.publish_draft_policy(store, key, groups, job.get('tokens', {}))
        _publish_draft(store, 'private', key, local_media.path(key))
