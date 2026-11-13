"""私密媒体按密码组授权：每个对象一份私有权限记录，事务失败可恢复旧权限。"""
import hashlib
import json
from . import media_store, storage


def policy_key(key):
    media_store._key(key)
    return '_maers/media-groups/' + hashlib.sha256(key.encode()).hexdigest() + '.json'


def _write_policy(store, key, data, rollback):
    def restore():
        if rollback is None:
            store.delete_policy(key)
        else:
            store.write_policy(key, rollback)

    storage.compensate({'kind': 'media-policy', 'backend': store.identity(), 'key': key,
                        'before': rollback.hex() if rollback is not None else None}, restore)
    store.write_policy(key, data)


def _ensure_token(store, group, token_hash):
    """在目标私有存储核验已解锁组的令牌，供读取同一存储的媒体网关使用。"""
    from . import private_session
    key = f'_maers/private-tokens/{group}.json'
    before = store.read_policy(key)
    digest = token_hash or private_session.group_token_hash(group)
    data = json.dumps({'hash': digest}, separators=(',', ':')).encode()
    if before != data:
        _write_policy(store, key, data, before)


def _groups(current, group, remove, replace):
    groups = set() if replace else set(current)
    groups.discard(remove)
    groups.add(group)
    return sorted(groups)


def _save_groups(store, key, groups, before, rollback):
    after = json.dumps({'key': key, 'groups': groups}, sort_keys=True).encode()
    if before != after:
        _write_policy(store, policy_key(key), after, rollback)


def assign(keys, group, remove=None, force=False, token_hash=None, replace=False, *, store=None, progress=None):
    from .crypto_keyring import group_ring, _read, KEYRING_FILE
    from . import media_jobs, private_session
    ring = group_ring(group) if group != 'default' else None
    if group != 'default' and ring is None:
        raise ValueError('Unknown password group')
    if not keys:
        return
    keys = set(keys)
    drafts = media_jobs.drafts(keys)
    token = {'dekId': ring['dek_id'], 'hash': token_hash or private_session.group_token_hash(group)} if drafts and ring else None
    for job in drafts.values():
        groups = _groups(media_jobs.draft_groups(job), group, remove, replace)
        job.pop('group', None)
        job['groups'] = groups
        tokens = {name: value for name, value in job.get('tokens', {}).items() if name in groups}
        if token:
            tokens[group] = token
        if tokens:
            job['tokens'] = tokens
        else:
            job.pop('tokens', None)
        if progress:
            progress()
    media_jobs.replace_drafts(drafts)
    keys.difference_update(drafts)
    if not keys:
        return
    if group == 'default' and not force and 'groups' not in (_read(KEYRING_FILE) or {}):
        return
    store = store or media_store.get_store()
    if group != 'default':
        _ensure_token(store, group, token_hash)
    for key in sorted(keys):
        policy = policy_key(key)
        before = store.read_policy(policy)
        current = json.loads(before) if before else {'key': key, 'groups': []}
        if current.get('key') != key or not isinstance(current.get('groups'), list):
            raise ValueError('Invalid media group policy')
        # 首次迁入失败时保留的私有副本应保持不可访问。
        rollback = before
        if before is None and group != 'default' and remove is None:
            rollback = json.dumps({'key': key, 'groups': []}).encode()
        _save_groups(store, key, _groups(current['groups'], group, remove, replace), before, rollback)
        if progress:
            progress()


def publish_draft_policy(store, key, groups, tokens):
    from .crypto_keyring import group_ring
    for group in sorted(groups - {'default'}):
        ring = group_ring(group)
        if ring is None:
            raise ValueError('图片所属密码组已不存在')
        # 手机已验证的组通常已有令牌，本机首次加锁的组在发布时补齐。
        saved = store.read_policy(f'_maers/private-tokens/{group}.json')
        if not saved or not json.loads(saved).get('hash'):
            token = tokens.get(group, {})
            digest = token['hash'] if token.get('dekId') == ring['dek_id'] else None
            _ensure_token(store, group, digest)
    before = store.read_policy(policy_key(key))
    rollback = before if before is not None else json.dumps({'key': key, 'groups': []}).encode()
    _save_groups(store, key, sorted(groups), before, rollback)


def revoke(group):
    """删除空组或替换未使用的密钥时撤销旧图片令牌。"""
    store = media_store.get_store()
    key = f'_maers/private-tokens/{group}.json'
    before = store.read_policy(key)
    if before is not None:
        storage.compensate({'kind': 'media-policy', 'backend': store.identity(), 'key': key, 'before': before.hex()},
                           lambda: store.write_policy(key, before))
        store.write_policy(key, b'{"hash":""}')
