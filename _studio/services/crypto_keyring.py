"""
密钥环存储服务 (crypto_keyring.py)

职责：本机保留完整包裹密钥环，公开文件仅保留线上密码解锁所需字段。
后端只做结构校验与防误覆盖，不接触主密码、恢复码与数据密钥明文。
"""

from __future__ import annotations
from .contracts import JsonObject, Response
import os
import json
import re
import hashlib

import config
from . import storage, storage_journal

KEYRING_FILE = os.path.join(config.DATA_DIR, 'crypto-keyring.json')
_B64 = re.compile(r'^[A-Za-z0-9+/=]+$')
HEX_64 = re.compile(r'^[0-9a-f]{64}$')
GROUP_ID = re.compile(r'^g_[0-9a-f]{32}$')
_MASTER_WRAP = re.compile(r'enc:[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+')


def group_ring(identity='default', ring=None):
    ring = _load() if ring is None else ring
    return ring if identity == 'default' else (ring or {}).get('groups', {}).get(identity)


def require_content_group(identity):
    """主密码只负责包裹组密钥，新内容必须选择自建组。兼容读取旧默认组密文。"""
    ring = _read(KEYRING_FILE) or {}
    if identity == 'default' and not ring.get('master_only'):
        return
    if not isinstance(identity, str) or not GROUP_ID.fullmatch(identity) or identity not in ring.get('groups', {}):
        raise ValueError('请先创建并选择内容密码组')


def group_usage():
    counts = {}
    def visit(value):
        if isinstance(value, dict):
            if value.get('_enc'):
                identity = value.get('_group', 'default')
                counts[identity] = counts.get(identity, 0) + 1
            else:
                for child in value.values():
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    for snapshot in _source_snapshots():
        visit(snapshot['data'])
    return counts


def revision(ring):
    data = json.dumps(clean_ring(ring), ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(data.encode()).hexdigest()


def _valid_slot(slot):
    return (isinstance(slot, dict)
            and isinstance(slot.get('salt'), str) and _B64.match(slot['salt'])
            and isinstance(slot.get('iter'), int) and slot['iter'] >= 10000
            and isinstance(slot.get('wrap'), str) and slot['wrap'].startswith('enc:'))


def _valid_master_wrap(group):
    if 'master_wrap' not in group:
        return True
    wrap = group['master_wrap']
    return _valid_wrap(wrap)


def _valid_wrap(value):
    return isinstance(value, str) and len(value) <= 512 and _MASTER_WRAP.fullmatch(value) is not None


def _valid_name(value):
    return isinstance(value, str) and 0 < len(value.strip()) <= 64


def _copy_slot(slot):
    return {key: slot[key] for key in ('salt', 'iter', 'wrap')}


def _group_fields(group):
    return {key: group[key] for key in ('v', 'name', 'dek_id', 'master_wrap') if key in group}


def valid_content_access(value, groups):
    if not isinstance(value, dict) or value.get('v') != 1:
        return False
    if not re.fullmatch(r'[0-9a-f]{16}', str(value.get('dek_id', ''))):
        return False
    if not _valid_slot(value.get('pw')):
        return False
    master_wrap = value.get('master_wrap')
    if not isinstance(master_wrap, str) or not _MASTER_WRAP.fullmatch(master_wrap):
        return False
    wraps = value.get('wraps')
    if not isinstance(wraps, dict) or wraps.keys() != groups.keys():
        return False
    return all(_valid_wrap(wrap) for wrap in wraps.values())


def content_access(value):
    return {**{key: value[key] for key in ('v', 'dek_id', 'master_wrap', 'wraps')},
            'pw': _copy_slot(value['pw'])}


def local_keyring_file():
    return os.path.join(storage_journal.local_root(), 'crypto-keyring.json')


def _read(path):
    if not os.path.isfile(path):
        return None
    with open(path, encoding='utf-8') as source:
        return json.load(source)


def _load():
    public = _read(KEYRING_FILE)
    if public is None:
        return None
    # 兼容旧备份；旧格式的完整密钥环是迁移前的真源。
    if valid_ring(public):
        return public
    local = _read(local_keyring_file())
    if not valid_ring(local) or public_ring(local) != public:
        raise ValueError('Restore the matching local keyring backup before managing encrypted data')
    return local


def public_ring(body):
    public = {'v': body['v'], 'dek_id': body['dek_id'], 'media_base': body.get('media_base', ''),
              'pw': _copy_slot(body['pw'])}
    if 'master_only' in body:
        public['master_only'] = body['master_only']
    if 'name' in body and not body.get('master_only'):
        public['name'] = body['name']
    if 'groups' in body:
        public['groups'] = {
            identity: {**_group_fields(group), 'pw': _copy_slot(group['pw'])}
            for identity, group in body['groups'].items()
        }
    if 'content' in body:
        public['content'] = content_access(body['content'])
    return public


@storage.transactional
def write_ring(body):
    # 两份文件共用持久化事务，先保存恢复材料，再更新公开投影。
    storage.write_json(local_keyring_file(), clean_ring(body))
    storage.write_json(KEYRING_FILE, public_ring(body))


@storage.transactional
def migrate():
    public = _read(KEYRING_FILE)
    if public is None:
        return
    ring = _load()
    if not valid_ring(ring):
        raise ValueError('Invalid legacy keyring; migration stopped')
    empty_default = _can_separate_master(ring)
    if empty_default:
        ring = {**ring, 'master_only': True, 'groups': ring.get('groups', {})}
        ring.pop('name', None)
    if empty_default or 'rc' in public or 'updated' in public or any(
            'rc' in group and group.get('master_wrap') for group in ring.get('groups', {}).values()):
        write_ring(ring)


def _can_separate_master(ring):
    """仅空默认组、全部内容组已接入主密码且没有待完成轮换时自动分离。"""
    if ring.get('master_only') or group_usage().get('default'):
        return False
    if not all(group.get('master_wrap') for group in ring.get('groups', {}).values()):
        return False
    from . import crypto_rotation
    return not crypto_rotation.pending()['pending']


def _valid_ring_fields(body, is_group):
    """主密钥环和内容组共用的字段校验；恢复槽仅允许内容组省略。"""
    if not isinstance(body, dict) or body.get('v') != 1:
        return False
    if 'master_only' in body and not isinstance(body['master_only'], bool):
        return False
    if not re.fullmatch(r'[0-9a-f]{16}', str(body.get('dek_id', ''))):
        return False
    if not _valid_slot(body.get('pw')):
        return False
    if not (is_group and 'rc' not in body) and not _valid_slot(body.get('rc')):
        return False
    if body.get('media_base') and not str(body['media_base']).startswith('https://'):
        return False
    return 'name' not in body or _valid_name(body['name'])


def _valid_group(identity, group):
    if not isinstance(identity, str) or not GROUP_ID.fullmatch(identity):
        return False
    if not isinstance(group, dict) or 'groups' in group:
        return False
    return _valid_name(group.get('name')) and _valid_master_wrap(group) and valid_ring(group, is_group=True)


def valid_ring(body, is_group=False):
    if not _valid_ring_fields(body, is_group):
        return False
    groups = body.get('groups', {})
    if not isinstance(groups, dict) or len(groups) > 128:
        return False
    if not all(_valid_group(identity, group) for identity, group in groups.items()):
        return False
    if body.get('master_only') and not all(group.get('master_wrap') for group in groups.values()):
        return False
    if 'content' in body:
        return body.get('master_only') is True and valid_content_access(body['content'], groups)
    return True


def _clean_group(group):
    # 接入主密码后不再发布或保存旧的组恢复槽。
    slots = ('pw',) if group.get('master_wrap') else ('pw', 'rc')
    return {**_group_fields(group), 'name': group['name'].strip(),
            **{slot: _copy_slot(group[slot]) for slot in slots if slot in group}}


def clean_ring(body):
    clean = {key: body.get(key) for key in ('v', 'dek_id', 'pw', 'rc', 'media_base', 'updated')}
    for slot in ('pw', 'rc'):
        clean[slot] = _copy_slot(body[slot])
    if 'master_only' in body:
        clean['master_only'] = body['master_only']
    if 'name' in body and not body.get('master_only'):
        clean['name'] = body['name'].strip()
    if 'groups' in body:
        clean['groups'] = {identity: _clean_group(group) for identity, group in body['groups'].items()}
    if 'content' in body:
        clean['content'] = content_access(body['content'])
    return clean


def _unique_error(body):
    names = [group['name'].strip() for group in body.get('groups', {}).values()]
    if not body.get('master_only'):
        names.append(body.get('name', '默认组').strip())
    if len(names) != len(set(names)):
        return '密码组名称不能重复'
    ids = [body['dek_id'], *[group['dek_id'] for group in body.get('groups', {}).values()]]
    if 'content' in body:
        ids.append(body['content']['dek_id'])
    if len(ids) != len(set(ids)):
        return '每个密码组必须使用独立密钥'


def _compatibility_error(body, current):
    if current:
        if 'content' in current and 'content' not in body:
            return '请使用支持内容密码的后台保存，避免丢失全局内容解锁配置'
        if current.get('master_only') and not body.get('master_only'):
            return '请使用支持主密码与内容组分离的后台保存'
        if 'groups' in current and 'groups' not in body:
            return '请使用支持密码组的后台保存密钥环'
    if '_expected' in body and body['_expected'] != (revision(current) if current else None):
        return '密码组配置已变化，请重新打开后再保存'


def _group_update_error(body, current, usage):
    if body.get('master_only') and usage.get('default'):
        return '旧默认组仍有加密内容，请先迁入自建组'
    for identity, previous in (current or {}).get('groups', {}).items():
        replacement = body.get('groups', {}).get(identity)
        same_key = replacement is not None and replacement['dek_id'] == previous['dek_id']
        if usage.get(identity) and not same_key:
            return '密码组仍有关联内容，请先转移内容，不能删除或替换密钥'
        if (same_key and previous.get('master_wrap')
                and (replacement.get('master_wrap') != previous['master_wrap'] or body['dek_id'] != current['dek_id'])):
            return '接入主密码的密钥只能通过主密钥轮换更新'


def _master_update_error(body, current, force):
    from . import crypto_rotation
    has_ciphertext = any(crypto_rotation.encrypted_count(item['data'])
                         for item in _source_snapshots())
    if has_ciphertext and (not current or current['dek_id'] != body['dek_id']):
        return '存在加密内容，请恢复原密钥环或使用完整数据密钥轮换，不能直接替换'
    if current and current.get('dek_id') != body['dek_id'] and not force:
        return '已存在另一把数据密钥的密钥环，拒绝覆盖（会使已加密内容无法解锁）'


def _legacy_group_error(body, current, usage):
    if not current or not body.get('groups') or 'groups' in current:
        return
    from . import private_session
    if usage.get('default') and not private_session.group_unlocked('default'):
        return '首次添加密码组前，请先解锁默认组以登记已有图片权限'


def _update_group_access(body, current):
    """结构与版本已确认后，更新撤销记录和首次启用密码组时的图片权限。"""
    from . import private_session, media_groups
    for identity, previous in (current or {}).get('groups', {}).items():
        replacement = body.get('groups', {}).get(identity)
        if replacement is None or replacement['dek_id'] != previous['dek_id']:
            media_groups.revoke(identity)
    if current and body.get('groups') and 'groups' not in current:
        for item in private_session.catalog():
            media_groups.assign(item['media'], item['group'], force=True)


@storage.transactional
def save(body: JsonObject) -> Response:
    """先校验结构、版本及密钥替换限制，再在同一事务内写入完整密钥环和公开投影。"""
    if not isinstance(body, dict):
        return 400, {"error": "格式错误"}
    force = bool(body.pop('force', False))
    if not valid_ring(body):
        return 400, {"error": "版本或 dek_id 无效"}
    error = _unique_error(body)
    if error:
        return 400, {'error': error}
    current = _load()
    error = _compatibility_error(body, current)
    if error:
        return 409, {'error': error}
    usage = group_usage()
    error = (_group_update_error(body, current, usage)
             or _master_update_error(body, current, force)
             or _legacy_group_error(body, current, usage))
    if error:
        return 409, {'error': error}
    _update_group_access(body, current)
    clean = clean_ring(body)
    write_ring(clean)
    print(f"  [ CRYPTO ] 🔑 密钥环已保存 (dek_id={body['dek_id'][:8]})")
    return 200, {"status": "success"}


def _source_snapshots():
    from pathlib import Path
    for path in Path(config.DATA_DIR).rglob('*.json'):
        if path.name == 'crypto-keyring.json' or any(part.startswith('.') for part in path.relative_to(config.DATA_DIR).parts):
            continue
        with path.open(encoding='utf-8') as source:
            yield {'path': str(path), 'data': json.load(source)}
