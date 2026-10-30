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

import config
from . import storage, storage_journal

KEYRING_FILE = os.path.join(config.DATA_DIR, 'crypto-keyring.json')
_B64 = re.compile(r'^[A-Za-z0-9+/=]+$')
HEX_64 = re.compile(r'^[0-9a-f]{64}$')


def _valid_slot(slot):
    return (isinstance(slot, dict)
            and isinstance(slot.get('salt'), str) and _B64.match(slot['salt'])
            and isinstance(slot.get('iter'), int) and slot['iter'] >= 10000
            and isinstance(slot.get('wrap'), str) and slot['wrap'].startswith('enc:'))


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
    if not valid_ring(local) or any(local.get(k) != public.get(k) for k in ('v', 'dek_id', 'pw', 'media_base')):
        raise ValueError('Restore the matching local keyring backup before managing encrypted data')
    return local


def public_ring(body):
    return {'v': body['v'], 'dek_id': body['dek_id'], 'media_base': body.get('media_base', ''),
            'pw': {key: body['pw'][key] for key in ('salt', 'iter', 'wrap')}}


@storage.transactional
def write_ring(body):
    # 两份文件共用持久化事务，先保存恢复材料，再更新公开投影。
    storage.write_json(local_keyring_file(), clean_ring(body))
    storage.write_json(KEYRING_FILE, public_ring(body))


@storage.transactional
def migrate():
    public = _read(KEYRING_FILE)
    if public is not None and ('rc' in public or 'updated' in public):
        ring = _load()
        if not valid_ring(ring):
            raise ValueError('Invalid legacy keyring; migration stopped')
        write_ring(ring)


def valid_ring(body):
    return (isinstance(body, dict) and body.get('v') == 1
            and re.fullmatch(r'[0-9a-f]{16}', str(body.get('dek_id', '')))
            and _valid_slot(body.get('pw')) and _valid_slot(body.get('rc'))
            and (not body.get('media_base') or str(body['media_base']).startswith('https://')))


def clean_ring(body):
    return {key: body.get(key) for key in ('v', 'dek_id', 'pw', 'rc', 'media_base', 'updated')}


@storage.transactional
def save(body: JsonObject) -> Response:
    """校验并写入密钥环；dek_id 与现有文件不同时拒绝（除非 force）"""
    if not isinstance(body, dict):
        return 400, {"error": "格式错误"}
    force = bool(body.pop('force', False))
    if body.get('v') != 1 or not re.match(r'^[0-9a-f]{16}$', str(body.get('dek_id', ''))):
        return 400, {"error": "版本或 dek_id 无效"}
    if not _valid_slot(body.get('pw')) or not _valid_slot(body.get('rc')):
        return 400, {"error": "密钥槽结构无效"}
    media = body.get('media_base') or ''
    if media and not str(media).startswith('https://'):
        return 400, {"error": "media_base 必须为 https 地址"}

    current = _load()
    from . import crypto_rotation
    has_ciphertext = any(crypto_rotation.encrypted_count(item['data'])
                         for item in _source_snapshots())
    if has_ciphertext and (not current or current['dek_id'] != body['dek_id']):
        return 409, {'error': '存在加密内容，请恢复原密钥环或使用完整数据密钥轮换，不能直接替换'}
    if current and current.get('dek_id') != body['dek_id'] and not force:
        # 换成另一把数据密钥会导致所有已加密内容无法解开
        return 409, {"error": "已存在另一把数据密钥的密钥环，拒绝覆盖（会使已加密内容无法解锁）"}

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
            yield {'data': json.load(source)}
