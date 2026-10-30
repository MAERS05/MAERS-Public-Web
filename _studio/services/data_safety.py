"""本机数据保障：清理前校验、隔离回收区、带校验清单的完整备份及恢复。"""

import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path
import config
from . import storage, storage_journal, cms_store, media_store


def _id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{32}', value):
        raise ValueError('Invalid recovery identifier')
    return value


def _directory(kind, identity):
    return os.path.join(storage_journal.local_root(), kind, _id(identity))


def _relative(path):
    root = os.path.realpath(config.PROJECT_ROOT)
    target = os.path.realpath(path)
    if os.path.commonpath([root, target]) != root:
        raise ValueError('Recovery source escapes project')
    return os.path.relpath(target, root).replace('\\', '/')


def _target(relative):
    if not isinstance(relative, str) or relative.startswith(('/', '\\')) or '\\' in relative:
        raise ValueError('Invalid recovery path')
    parts = relative.split('/')
    if '..' in parts or ':' in relative or not parts or (parts[0] not in ('data', 'photos')
            and relative != '_studio/.local/crypto-keyring.json'):
        raise ValueError('Invalid recovery path')
    path = os.path.join(config.PROJECT_ROOT, *parts)
    _relative(path)
    return path


def preflight_cleanup():
    from . import cms, photos, validation
    for module in cms.JS_SYNC_MAP:
        tree = cms_store.load(os.path.join(config.DATA_DIR, f'{module}-tree.json'))
        for node in cms_store.walk(tree['root']):
            content = str(node.get('content') or '')
            if not node.get('_enc') and content.endswith('.md'):
                path = cms.cms_nodes._md_path(cms.get_context(), content)
                if not os.path.isfile(path):
                    raise FileNotFoundError('Referenced markdown is missing; cleanup stopped')
    for path, expected in ((photos.GALLERY_JSON_FILE, dict), (config.ALBUM_CONFIG_JSON, list),
                           (config.MUSIC_DATA, list), (config.SPACE_DATA, dict)):
        with open(path, encoding='utf-8') as source:
            value = json.load(source)
        if not isinstance(value, expected):
            raise ValueError('Invalid source; cleanup stopped')
        if path == config.SPACE_DATA:
            validation.tree(value)


def quarantine(path, batch):
    relative = _relative(path)
    _target(relative)
    directory = _directory('trash', batch)
    manifest = os.path.join(directory, 'manifest.json')
    entries = []
    if os.path.isfile(manifest):
        with open(manifest, encoding='utf-8') as source:
            entries = json.load(source)['files']
    with open(path, 'rb') as source:
        data = source.read()
    name = hashlib.sha256(relative.encode()).hexdigest()
    storage.write_bytes(os.path.join(directory, name), data)
    entries.append({'path': relative, 'blob': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    storage.write_json(manifest, {'v': 1, 'created': time.time(), 'files': entries})
    storage.remove(path)


def _read_verified(directory):
    with open(os.path.join(directory, 'manifest.json'), encoding='utf-8') as source:
        manifest = json.load(source)
    if manifest.get('v') != 1 or not isinstance(manifest.get('files'), list):
        raise ValueError('Invalid recovery manifest')
    for item in manifest['files']:
        blob = item['blob']
        if not isinstance(blob, str) or not re.fullmatch(r'[0-9a-f]{64}', blob):
            raise ValueError('Invalid backup blob')
        path = os.path.realpath(os.path.join(directory, blob))
        if os.path.commonpath([os.path.realpath(directory), path]) != os.path.realpath(directory):
            raise ValueError('Backup blob escapes directory')
        with open(path, 'rb') as source:
            data = source.read()
        if len(data) != item['size'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('Backup checksum mismatch')
    return manifest


@storage.transactional
def restore_trash(batch):
    directory = _directory('trash', batch)
    manifest = _read_verified(directory)
    # 整批先校验边界及目标冲突，绝不覆盖后来新建的同名内容。
    for item in manifest['files']:
        if os.path.exists(_target(item['path'])):
            raise ValueError('Restore target already exists; choose another location before restoring')
    for item in manifest['files']:
        with open(os.path.join(directory, item['blob']), 'rb') as source:
            storage.write_bytes(_target(item['path']), source.read())
    return {'status': 'success', 'restored': len(manifest['files'])}


def _local_files():
    from .crypto_keyring import local_keyring_file
    if os.path.isfile(local_keyring_file()):
        yield local_keyring_file()
    for directory in (config.DATA_DIR, config.PHOTOS_ROOT):
        for root, dirs, files in os.walk(directory, followlinks=False):
            dirs[:] = [name for name in dirs if not name.startswith('.') and not os.path.islink(os.path.join(root, name))
                       and not getattr(os.path, 'isjunction', lambda path: False)(os.path.join(root, name))]
            for name in files:
                if name.startswith('.') or name.endswith(('.db', '.db-wal', '.db-shm')):
                    continue
                path = os.path.join(root, name)
                if not os.path.islink(path):
                    yield path


@storage.serialized
def create_backup(include_remote=True):
    identity = uuid.uuid4().hex
    directory = _directory('backups', identity)
    entries = []
    def add(path, data, scope=None):
        name = hashlib.sha256((str(scope) + '|' + path).encode()).hexdigest()
        storage_journal.atomic(os.path.join(directory, name), data)
        entries.append({'path': path, 'scope': scope, 'blob': name, 'size': len(data),
                        'sha256': hashlib.sha256(data).hexdigest()})
    for path in _local_files():
        with open(path, 'rb') as source:
            add(_relative(path), source.read())
    backend = None
    if include_remote:
        store = media_store.get_store()
        backend = store.identity()
        for scope in ('public', 'private'):
            for key in store.keys(scope):
                media_store._key(key)
                add(key, store.read(scope, key), scope)
    manifest = {'v': 1, 'created': time.time(), 'remote': bool(include_remote), 'backend': backend, 'files': entries}
    storage_journal.atomic(os.path.join(directory, 'manifest.json'), json.dumps(manifest).encode())
    _read_verified(directory)
    return {'status': 'success', 'id': identity, 'files': len(entries), 'includes_remote': bool(include_remote)}


@storage.serialized
def verify_backup(identity):
    manifest = _read_verified(_directory('backups', identity))
    for item in manifest['files']:
        if item.get('scope'):
            if item['scope'] not in ('public', 'private'):
                raise ValueError('Invalid backup media scope')
            media_store._key(item['path'])
        else:
            _target(item['path'])
    return {'status': 'success', 'files': len(manifest['files']), 'includes_remote': manifest['remote']}


@storage.transactional
def restore_backup(identity):
    """校验整份备份再恢复；远端失败保留完整备份，明确上报供继续恢复。"""
    directory = _directory('backups', identity)
    verify_backup(identity)
    manifest = _read_verified(directory)
    store = media_store.get_store() if manifest['remote'] else None
    if store and store.identity() != manifest['backend']:
        raise ValueError('Restore the original backend configuration before restoring this backup')
    current = create_backup(include_remote=manifest['remote'])
    snapshot = _read_verified(_directory('backups', current['id']))
    remote_targets = sorted({(item['scope'], item['path']) for item in manifest['files'] + snapshot['files']
                             if item.get('scope')})
    if store:
        record = {'kind': 'backup', 'backend': store.identity(), 'id': current['id'], 'targets': remote_targets}
        storage.compensate(record, lambda: recover_backup(record))
    local_targets = {item['path'] for item in manifest['files'] if not item.get('scope')}
    batch = uuid.uuid4().hex
    for path in list(_local_files()):
        if _relative(path) not in local_targets:
            quarantine(path, batch)
    expected_remote = {(item['scope'], item['path']) for item in manifest['files'] if item.get('scope')}
    for scope, key in remote_targets:
        if (scope, key) not in expected_remote:
            store.delete(scope, key)
    for item in manifest['files']:
        with open(os.path.join(directory, item['blob']), 'rb') as source:
            data = source.read()
        if item.get('scope'):
            store.write(item['scope'], item['path'], data)
        else:
            storage.write_bytes(_target(item['path']), data)
    from . import crypto_keyring
    crypto_keyring.migrate()
    return {'status': 'success', 'restored': len(manifest['files']), 'safety_backup': current['id']}


def recover_backup(record):
    directory = _directory('backups', record['id'])
    manifest = _read_verified(directory)
    store = media_store.get_store()
    if store.identity() != record['backend']:
        raise RuntimeError('Restore original media configuration before recovery')
    originals = {(item['scope'], item['path']): item for item in manifest['files'] if item.get('scope')}
    for scope, key in record['targets']:
        media_store._key(key)
        item = originals.get((scope, key))
        if item:
            with open(os.path.join(directory, item['blob']), 'rb') as source:
                store.write(scope, key, source.read())
        else:
            store.delete(scope, key)


@storage.serialized
def list_recovery():
    result = {}
    for kind in ('trash', 'backups'):
        parent = Path(storage_journal.local_root()) / kind
        items = []
        if parent.is_dir():
            for directory in parent.iterdir():
                if re.fullmatch(r'[0-9a-f]{32}', directory.name) and (directory / 'manifest.json').is_file():
                    with (directory / 'manifest.json').open(encoding='utf-8') as source:
                        data = json.load(source)
                    items.append({'id': directory.name, 'created': data['created'], 'files': len(data['files'])})
        result[kind] = sorted(items, key=lambda item: item['created'], reverse=True)
    return result
