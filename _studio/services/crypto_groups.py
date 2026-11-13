"""密码组关联内容管理：校验版本与两组密钥后原子重加密，保留其他组密文。"""
import copy
import os
import config
from . import crypto_keyring, private_session, storage, media_groups, media_store, operation_status


@storage.serialized
def catalog():
    if not private_session.active():
        raise PermissionError('请先解锁一个密码组')
    return {'items': [{key: value for key, value in item.items() if key != 'media'}
                      for item in private_session.catalog()]}


def _rekey(value, old, new):
    if isinstance(value, list):
        return [_rekey(child, old, new) for child in value]
    if not isinstance(value, dict):
        return value
    if value.get('_enc'):
        if value.get('_group', 'default') != old:
            raise ValueError('内部包含其他密码组的独立加密项，请先单独处理')
        payload = private_session.decrypt(value['_enc'], old)
        result = {**value, '_enc': private_session.encrypt(_rekey(payload, old, new), new)}
        result.pop('_group', None)
        if new != 'default':
            result['_group'] = new
        return result
    return {key: _rekey(child, old, new) for key, child in value.items()}


@storage.transactional
def assign(body):
    operation_status.update('正在校验密钥和内容')
    group = body.get('group', 'default')
    crypto_keyring.require_content_group(group)
    if not crypto_keyring.group_ring(group) or not private_session.group_unlocked(group):
        raise ValueError('请先解锁目标密码组')
    selected = body.get('items')
    if not isinstance(selected, list) or not selected or len(selected) > 1000:
        raise ValueError('请选择要更换密码组的内容')
    items = private_session.catalog()
    by_ref = {item['reference']: item for item in items if not item['locked']}
    targets, seen = [], set()
    for requested in selected:
        if (not isinstance(requested, dict) or not isinstance(requested.get('reference'), str)
                or requested['reference'] in seen):
            raise ValueError('Invalid group selection')
        item = by_ref.get(requested.get('reference'))
        if not item or item['revision'] != requested.get('revision'):
            raise ValueError('内容已变化或尚未解锁，请刷新后重试')
        seen.add(item['reference'])
        if item['group'] != group:
            targets.append(item)
    moving = {item['reference'] for item in targets}
    total = sum(len(set(item['media'])) for item in targets)
    done = 0
    store = media_store.get_store() if total else None
    def media_progress():
        nonlocal done
        done += 1
        operation_status.update('正在更新图片访问权限', done, total)

    snapshots = {}
    for index, item in enumerate(targets):
        operation_status.update('正在重新加密内容', index, len(targets))
        path = os.path.abspath(os.path.join(config.DATA_DIR, item['source']))
        ref = private_session.reference(path, item['reference'])
        cipher = ref['envelope']['_enc']
        payload = private_session.decrypt(cipher, item['group'])
        replacement = _rekey(payload, item['group'], group)
        replacement = {**ref['envelope'], '_enc': private_session.encrypt(replacement, group)}
        replacement.pop('_group', None)
        if group != 'default':
            replacement['_group'] = group
        other_keys = set(key for other in items if other['reference'] not in moving
                         and other['group'] == item['group'] for key in other['media'])
        keys = set(item['media'])
        operation_status.update('正在更新图片访问权限', done, total)
        for shared, remove in ((keys & other_keys, None), (keys - other_keys, item['group'])):
            media_groups.assign(shared, group, remove=remove, store=store, progress=media_progress)
        current = snapshots.setdefault(path, private_session.read_source(path))
        def replace(value):
            if isinstance(value, list):
                return [replace(child) for child in value]
            if not isinstance(value, dict):
                return value
            if value.get('_enc') == cipher:
                return copy.deepcopy(replacement)
            return {key: replace(child) for key, child in value.items()}
        snapshots[path] = replace(current)
    with private_session.context(False):
        for index, (path, value) in enumerate(snapshots.items()):
            operation_status.update('正在保存加密内容', index, len(snapshots))
            storage.write_json(path, value)
    for path, value in snapshots.items():
        private_session.read(path, value)
    operation_status.update('更换密码组完成', len(targets), len(targets))
    return {'status': 'success', 'changed': len(targets)}
