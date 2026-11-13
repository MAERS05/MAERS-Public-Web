"""正文发布镜像：发布时把公开 Markdown 增量同步到公开存储，私密 Markdown 同步到私有存储；本机文件始终是唯一真源。"""

import hashlib
import json
import os
import config
from . import cms_markdown, cms_store, media_settings, media_store, storage, storage_journal


class PublishConfigurationError(ValueError):
    """公开正文发布需要云存储和读取地址。"""


def _manifest_path():
    return os.path.join(storage_journal.local_root(), 'content-sync.json')


def _load_manifest(identity):
    """读取上次同步记录；记录缺失、损坏或属于其他存储目标时视为空，下次按对象对账全量补传。"""
    try:
        with open(_manifest_path(), encoding='utf-8') as source:
            value = json.load(source)
    except (OSError, ValueError):
        return {'public': {}, 'private': {}, 'bucketIds': {}, 'complete': False, 'bucketTargets': {}}
    if isinstance(value, dict) and value.get('backend') == identity:
        return {
            'public': value.get('public') if isinstance(value.get('public'), dict) else value.get('files', {}),
            'private': value.get('private') if isinstance(value.get('private'), dict) else {},
            'bucketIds': value.get('bucketIds') if isinstance(value.get('bucketIds'), dict) else {},
            'complete': value.get('complete') is True,
            'bucketTargets': value.get('bucketTargets') if isinstance(value.get('bucketTargets'), dict) else {}
        }
    return {'public': {}, 'private': {}, 'bucketIds': {}, 'complete': False, 'bucketTargets': {}}


def _save_manifest(identity, records):
    storage.write_json(_manifest_path(), {'backend': identity, 'files': records.get('public', {}), **records})


def _is_private_node(node):
    if not isinstance(node, dict):
        return False
    return bool(node.get('_private') or node.get('_private_id') or node.get('_private_group') or '_enc' in node)


def _walk_notes(nodes, parent_group=None):
    for node in nodes:
        if not isinstance(node, dict):
            continue
        group = parent_group
        if _is_private_node(node):
            group = node.get('_private_group') or node.get('_group') or group or 'default'
        yield node, group
        yield from _walk_notes(node.get('children') or [], group)


def collect(private_groups=None):
    """扫描全部正文，按公开与私密分类返回：{'public': {存储键: 字节}, 'private': {存储键: 字节}}。"""
    from . import cms
    context = {'DATA_DIR': config.DATA_DIR, 'MARKDOWN_ROOT': config.MARKDOWN_ROOT, 'PROJECT_ROOT': config.PROJECT_ROOT}
    public_files = {}
    private_files = {}
    for module in cms.JS_SYNC_MAP:
        tree = cms_store.load(os.path.join(config.DATA_DIR, f'{module}-tree.json'))
        for node, group in _walk_notes(tree['root']):
            content = str(node.get('content') or '')
            if not content.endswith('.md'):
                continue
            path = cms_markdown.md_path(context, content)
            if not os.path.isfile(path):
                raise FileNotFoundError(f'引用的正文文件不存在：{content}')
            with open(path, 'rb') as source:
                data = source.read()
            key = media_store.MediaStore.content_key(content.replace('\\', '/'))
            if group:
                private_files[key] = data
                if private_groups is not None:
                    private_groups.setdefault(key, set()).add(group)
            else:
                public_files[key] = data
    return {'public': public_files, 'private': private_files}


def _private_policy_key(key):
    return '_maers/content-groups/' + hashlib.sha256(key.encode()).hexdigest() + '.json'


def _verify_content_bucket(store, key, assigned):
    actual = store.bucket_id(key)
    if assigned and actual != assigned:
        raise ValueError('正文的原桶归属无法确认，请恢复原配置')
    return actual


def is_synced():
    """推送前只读核对正文路径、字节、公私归属和存储目标，要求上次同步完整成功。"""
    all_local = collect()
    store = media_store.get_store()
    if store.client is None:
        return not any(all_local.values()) and not os.path.exists(_manifest_path())
    manifest = _load_manifest(store.identity())
    if not manifest['complete']:
        return False
    buckets = {media_store.DEFAULT_BUCKET, *manifest['bucketIds'].values()}
    if manifest['bucketTargets'] != {bucket: store.bucket_target(bucket) for bucket in buckets}:
        return False
    return all(manifest[scope] == {key: hashlib.sha256(data).hexdigest() for key, data in files.items()}
               for scope, files in all_local.items())


@storage.serialized
def sync(progress=None, *, bucket_id=None, for_publish=False):
    """按内容哈希增量上传变化的正文（公开至 public 桶，私密至 private 桶），并清理已删除对象。"""
    store = media_store.get_store()
    if bucket_id is not None:
        store.bucket_target(bucket_id)
    if store.client is None:
        if for_publish and collect()['public']:
            raise PublishConfigurationError('发布公开正文前，请在存储设置配置云端存储桶')
        return {'enabled': False, 'uploaded': 0, 'deleted': 0}
    private_groups = {} if store.bucket_groups else None
    all_local = collect(private_groups)
    if for_publish and all_local['public'] and not media_settings.published_addresses().get('CONTENT_PUBLIC_BASE', '').strip():
        raise PublishConfigurationError('发布公开正文前，请在存储设置填写公开正文地址')
    identity = store.identity()
    manifest = _load_manifest(identity)
    bucket_ids = manifest['bucketIds']
    for bucket in bucket_ids.values():
        store.bucket_target(bucket)
    scopes = ('public', 'private')
    all_remote = {scope: set(store.content_keys(scope)) for scope in scopes}
    known = {key for scope in scopes for key in all_remote[scope] | set(manifest[scope])}

    total_uploaded = 0
    total_deleted = 0
    new_records = {'bucketIds': bucket_ids, 'complete': False}

    try:
        for scope in scopes:
            selected = store.write_buckets[f'{scope}_content'] if bucket_id is None else bucket_id
            local = all_local[scope]
            remote = all_remote[scope]
            if scope == 'public' and not local and remote:
                raise RuntimeError('No local markdown found; refusing to clear the remote content mirror')
            synced = manifest.get(scope, {})
            hashes = {key: hashlib.sha256(data).hexdigest() for key, data in local.items()}
            upload = [key for key in sorted(local) if key not in remote or synced.get(key) != hashes[key]]
            delete = sorted(remote - set(local))

            current = {key: value for key, value in synced.items() if key in remote and key in local}
            try:
                if scope == 'private' and private_groups is not None:
                    for key, groups in private_groups.items():
                        policy = _private_policy_key(key)
                        value = json.dumps({'key': key, 'groups': sorted(groups)}, sort_keys=True).encode()
                        if store.read_policy(policy) != value:
                            store.write_policy(policy, value)
                for key in upload:
                    actual = _verify_content_bucket(store, key, bucket_ids.get(key))
                    if selected != media_store.DEFAULT_BUCKET and key not in known and actual == media_store.DEFAULT_BUCKET:
                        store.claim_bucket(key, selected)
                        actual = selected
                    if actual != media_store.DEFAULT_BUCKET:
                        bucket_ids[key] = actual
                    store.write_content(key, local[key], scope=scope)
                    known.add(key)
                    current[key] = hashes[key]
                    total_uploaded += 1
                    if progress:
                        progress(total_uploaded, total_uploaded + len(upload) + len(delete))
                for key in delete:
                    _verify_content_bucket(store, key, bucket_ids.get(key))
                    store.delete_content(key, scope=scope)
                    if scope == 'private' and private_groups is not None:
                        store.delete_policy(_private_policy_key(key))
                    current.pop(key, None)
                    total_deleted += 1
                    if progress:
                        progress(total_uploaded + total_deleted, total_uploaded + len(upload) + len(delete))
            finally:
                new_records[scope] = current
        buckets = {media_store.DEFAULT_BUCKET, *bucket_ids.values()}
        new_records['bucketTargets'] = {bucket: store.bucket_target(bucket) for bucket in buckets}
        new_records['complete'] = True
    finally:
        _save_manifest(identity, new_records)

    print(f"  [ CONTENT ] ☁️ 正文双桶镜像同步完成 | Content mirror synced: {total_uploaded} uploaded, {total_deleted} removed")
    return {'enabled': True, 'uploaded': total_uploaded, 'deleted': total_deleted}


