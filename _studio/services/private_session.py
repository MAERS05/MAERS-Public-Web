"""本机私密管理入口：会话鉴权与密码学调用，委托内容工作区和媒体授权组件。"""
import atexit
import base64
import contextlib
import copy
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import config
from .private_state import PrivateState
from .private_media import PrivateMedia
from .private_records import PrivateRecords, read_source, supported, has_private_markers, outer_envelopes

_state = PrivateState()
_media_access = PrivateMedia(_state, lambda cipher, group: _records.decrypt(cipher, group))
_records = PrivateRecords(_state, _media_access, lambda *args: crypt(*args))

active = _state.active
group_unlocked = _state.group_unlocked
read = _records.read
prepare = _records.prepare
envelope = _records.envelope
reference = _records.reference
albums = _records.albums
save_album = _records.save_album
document = _records.document
write_document = _records.write_document
new_document = _records.new_document
catalog = _records.catalog
decrypt = _records.decrypt
encrypt = _records.encrypt
media_keys = _media_access.keys
media_url = _media_access.url
media_bytes = _media_access.read
view = _media_access.view
cookie_header = _media_access.cookie_header
media_authorized = _media_access.authorized


def session_keys():
    return dict(_state.keys)


def session_lease():
    return _state.lease



def group_token(group):
    raw = _state.keys.get(group)
    if raw is None:
        raise ValueError('请先解锁对应密码组')
    return hashlib.sha256(('maers-private-access-v1|' + raw).encode()).hexdigest()


def group_token_hash(group):
    return hashlib.sha256(group_token(group).encode()).hexdigest()


@contextlib.contextmanager
def context(authorized=True):
    token = _state.authorized.set(authorized)
    try:
        yield
    finally:
        _state.authorized.reset(token)


def key_identity(raw):
    return hashlib.sha256(('maers-dek-id|' + raw).encode()).hexdigest()[:16]


def key_matches(group, raw, ring):
    from .crypto_keyring import group_ring
    expected = (group_ring(group, ring) or {}).get('dek_id')
    return isinstance(expected, str) and secrets.compare_digest(key_identity(raw), expected)


def require_ready(path):
    """未完成后台验证时拒绝业务写入，不能把私密目标误作公开目标处理。"""
    if not _state.authorized.get() or path.startswith('/api/crypto/') or path in (
            '/data/crypto-keyring.json',
            '/api/album/job', '/api/admin/backup', '/api/admin/backup_location',
            '/api/admin/import_backup', '/api/admin/pick_directory', '/api/media/retry',
            '/api/git/commit-push'):
        return
    from .crypto_keyring import KEYRING_FILE
    if active():
        ring = read_source(KEYRING_FILE) if os.path.isfile(KEYRING_FILE) else {}
        if not all(key_matches(group, raw, ring) for group, raw in _state.keys.items()):
            close({})
            raise PermissionError('密钥环已变化，请重新验证主密码')
    if not active() and (os.path.isfile(KEYRING_FILE) or status()['has_encrypted']):
        raise PermissionError('请先验证主密码，再进入本机后台')


def status():
    from .crypto_keyring import KEYRING_FILE
    from .crypto_rotation import _files, encrypted_count
    return {'configured': os.path.isfile(KEYRING_FILE),
            'has_encrypted': any(encrypted_count(read_source(path)) for path in _files())}


def start(body):
    from .crypto_keyring import KEYRING_FILE
    keys = body.get('keys')
    if not isinstance(keys, dict) or 'default' not in keys or len(keys) > 129:
        raise ValueError('Invalid private management keys')
    if not os.path.isfile(KEYRING_FILE):
        raise ValueError('本机尚未配置密钥环，请刷新后台')
    ring = read_source(KEYRING_FILE)
    for group, raw in keys.items():
        try:
            decoded = base64.b64decode(raw, validate=True)
            matches = key_matches(group, raw, ring)
        except (TypeError, ValueError):
            raise ValueError('Invalid private management key') from None
        if len(decoded) != 32 or not matches:
            raise ValueError('密码组密钥不匹配，请重新解锁')
    if not shutil.which('node'):
        close({})
        raise RuntimeError('私密管理需要 Node.js，请安装项目要求的 Node.js 后重试')
    if body.get('remember'):
        from . import local_crypto_access
        local_crypto_access.remember(keys)
    if _state.keys != keys:
        close({})
        _state.keys.update(keys)
    _state.lease, _state.media_cookie = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
    return {'status': 'success', 'lease': _state.lease}


def crypt(operation, values, group='default'):
    if not group_unlocked(group):
        raise ValueError('请先解锁对应密码组')
    runtime = os.path.join(config.BASE_DIR, 'tools', 'private_crypto.mjs')
    result = subprocess.run([shutil.which('node'), runtime],
        input=json.dumps({'key': _state.keys[group], 'operation': operation, 'values': values}),
        capture_output=True, text=True, encoding='utf-8', timeout=25,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise ValueError('加密数据无法还原，请检查主密码或恢复备份')
    return json.loads(result.stdout)


def _album_gallery_view(path):
    value = read_source(path)
    for category, entry in albums().items():
        rows = []
        for row in entry['payload']['photos']:
            tags = row.get('tags', [])
            if isinstance(tags, str) and tags:
                tags = json.loads(tags)
            rows.append({**row, '_private': True, 'tags': tags})
        value[category] = rows
    return value


def static(path):
    if not active():
        return None
    text = document(path)
    if text is not None:
        return 'text/plain; charset=utf-8', text.encode('utf-8')
    if os.path.abspath(path) == os.path.abspath(os.path.join(config.DATA_DIR, 'photos-data.json')):
        return 'application/json; charset=utf-8', json.dumps(view(_album_gallery_view(path))).encode()
    if supported(path) and os.path.isfile(path):
        return 'application/json; charset=utf-8', json.dumps(view(read(path, read_source(path)))).encode()
    return None


def protection(source):
    path = os.path.abspath(os.path.join(config.DATA_DIR, source))
    if not active():
        raise PermissionError('请先验证主密码')
    if not supported(path):
        raise ValueError('Invalid private management source')
    read(path, read_source(path))
    return {'references': list(_state.references[path])}


def _replace_cipher(value, cipher, payload):
    if isinstance(value, list):
        return [_replace_cipher(child, cipher, payload) for child in value]
    if not isinstance(value, dict):
        return value
    if value.get('_enc') == cipher:
        return copy.deepcopy(payload)
    return {key: _replace_cipher(child, cipher, payload) for key, child in value.items()}


def unprotect(body):
    from . import storage, album_lock, cms
    path, raw, reference = _records.current_reference(body.get('reference'))
    cipher = reference['envelope']['_enc']
    payload = decrypt(cipher, reference['group'])
    with context(False):
        if reference['album']:
            return album_lock.unlock_category(cipher, payload)
        if reference['cms']:
            module = os.path.basename(path).removesuffix('-tree.json')
            cms._unlock(module, {'id': reference['id'], 'tree': payload}, cms.get_context())
        else:
            storage.write_json(path, _replace_cipher(raw, cipher, payload))
    return 200, {'status': 'success', 'record': payload}


def close(body):
    if body.get('lease') and body['lease'] != _state.lease:
        return {'status': 'ignored'}
    _state.clear()
    return {'status': 'success'}


atexit.register(lambda: close({}))
