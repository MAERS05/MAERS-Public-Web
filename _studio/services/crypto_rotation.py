"""数据密钥轮换：导出版本快照、原子替换全部密文及密钥环、跟踪私密令牌撤销。"""

import hashlib
import json
import os
from pathlib import Path
import config
from . import storage, storage_journal, crypto_keyring, cms_store, data_safety


def _files():
    return sorted(path for path in Path(config.DATA_DIR).rglob('*.json')
                  if not any(part.startswith('.') for part in path.relative_to(config.DATA_DIR).parts)
                  and path.name != 'crypto-keyring.json')


def _marker():
    return os.path.join(storage_journal.local_root(), 'rotation-pending.json')


def encrypted_count(value):
    if isinstance(value, dict):
        return int(bool(value.get('_enc'))) + sum(encrypted_count(v) for k, v in value.items() if k != '_enc')
    return sum(encrypted_count(v) for v in value) if isinstance(value, list) else 0


def _shape(before, after):
    if isinstance(before, dict):
        if not isinstance(after, dict) or before.keys() != after.keys():
            return False
        if '_enc' in before:
            if before.get('_group', 'default') != 'default':
                return before == after
            return (isinstance(after['_enc'], str) and after['_enc'].startswith('enc:')
                    and all(_shape(before[k], after[k]) for k in before if k != '_enc'))
        return all(_shape(before[k], after[k]) for k in before)
    if isinstance(before, list):
        return isinstance(after, list) and len(before) == len(after) and all(_shape(a, b) for a, b in zip(before, after))
    return type(before) is type(after) and before == after


@storage.serialized
def export_snapshots():
    ring = crypto_keyring._load()
    if not ring:
        raise ValueError('Restore the current keyring before rotation')
    snapshots = []
    for path in _files():
        raw = path.read_bytes()
        snapshots.append({'path': path.relative_to(config.DATA_DIR).as_posix(),
                          'revision': hashlib.sha256(raw).hexdigest(), 'data': json.loads(raw)})
    return {'dek_id': ring['dek_id'], 'keyring_revision': crypto_keyring.revision(ring), 'files': snapshots}


@storage.transactional
def rotate(body):
    if os.path.exists(_marker()):
        raise ValueError('Finish private-token revocation before starting another rotation')
    current = export_snapshots()
    if (body.get('expected_dek_id') != current['dek_id']
            or body.get('expected_keyring_revision') != current['keyring_revision']):
        raise ValueError('Keyring changed; reload before rotating')
    previous = crypto_keyring._load()
    ring = body.get('keyring')
    if (not isinstance(ring, dict) or ring.get('v') != 1 or ring.get('dek_id') == current['dek_id']
            or not crypto_keyring.valid_ring(ring)
            or ring.get('master_only', False) != previous.get('master_only', False)
            or ring.get('media_base') != previous.get('media_base')):
        raise ValueError('Invalid replacement keyring')
    ring = crypto_keyring.clean_ring(ring)
    old_groups, new_groups = previous.get('groups', {}), ring.get('groups', {})
    old_content, new_content = previous.get('content'), ring.get('content')
    if bool(old_content) != bool(new_content):
        raise ValueError('Master rotation must preserve content-password access')
    if old_content:
        before_content, after_content = old_content.copy(), new_content.copy()
        before_wrap = before_content.pop('master_wrap')
        after_wrap = after_content.pop('master_wrap')
        if before_content != after_content or before_wrap == after_wrap:
            raise ValueError('Master rotation must rewrap and preserve the content-password key')
    if old_groups.keys() != new_groups.keys():
        raise ValueError('Master key rotation cannot alter content password groups')
    for identity, group in old_groups.items():
        old_fields, new_fields = group.copy(), new_groups[identity].copy()
        old_wrap, new_wrap = old_fields.pop('master_wrap', None), new_fields.pop('master_wrap', None)
        if (old_fields != new_fields or bool(old_wrap) != bool(new_wrap)
                or (old_wrap and old_wrap == new_wrap)):
            raise ValueError('Master key rotation must rewrap linked groups and preserve their own keys')
    snapshots = body.get('files')
    if not isinstance(snapshots, list) or len(snapshots) != len(current['files']):
        raise ValueError('Rotation must cover every source snapshot')
    for before, after in zip(current['files'], snapshots):
        if (before['path'] != after.get('path') or before['revision'] != after.get('revision')
                or not _shape(before['data'], after.get('data'))):
            raise ValueError('Source changed or rotation altered public data; reload and retry')
        if before['path'] in {f'{module}-tree.json' for module in ('notes', 'record', 'literature', 'games', 'videos')}:
            cms_store.validate(after['data'])
    token_hash = body.get('token_hash')
    token_pending = bool(ring.get('media_base')) and not ring.get('master_only', False)
    if token_pending and (not isinstance(token_hash, str) or not crypto_keyring.HEX_64.fullmatch(token_hash)):
        raise ValueError('Private-token hash is required')
    # 本机备份包含旧密文和被包裹的旧密钥环，不包含主密码或明文 DEK。
    backup = data_safety.create_backup('local')
    for item in snapshots:
        storage.write_json(os.path.join(config.DATA_DIR, item['path']), item['data'])
    crypto_keyring.write_ring(ring)
    if token_pending:
        storage.write_json(_marker(), {'dek_id': ring['dek_id'], 'token_hash': token_hash})
    return {'status': 'success', 'backup': backup['id'], 'token_pending': token_pending}


@storage.serialized
def pending():
    if not os.path.isfile(_marker()):
        return {'pending': False}
    with open(_marker(), encoding='utf-8') as source:
        data = json.load(source)
    return {'pending': True, 'dek_id': data['dek_id']}


@storage.transactional
def finalize(body):
    if not os.path.isfile(_marker()):
        return {'status': 'success'}
    with open(_marker(), encoding='utf-8') as source:
        marker = json.load(source)
    if (body.get('token_hash') != marker['token_hash'] or body.get('dek_id') != marker['dek_id']
            or crypto_keyring._load()['dek_id'] != marker['dek_id']):
        raise ValueError('Private-token verification does not match current rotation')
    storage.remove(_marker())
    return {'status': 'success'}
