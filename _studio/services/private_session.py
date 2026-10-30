"""本机私密管理：密钥与工作记录仅保留在内存，读时还原、写时重新加密。"""
import atexit
import base64
import contextlib
import contextvars
import copy
import hashlib
import json
import os
import secrets
import shutil
import subprocess
from urllib.parse import quote, unquote
import config

_authorized = contextvars.ContextVar('private_admin', default=False)
_key = None
_lease = None
_media_cookie = None
_decoded = {}
_references = {}
_documents = {}
_dirty_documents = set()
_albums = {}
_media = set()
_MARKERS = {'_private', '_private_id'}


@contextlib.contextmanager
def context(authorized=True):
    token = _authorized.set(authorized)
    try:
        yield
    finally:
        _authorized.reset(token)


def active():
    return bool(_key and _authorized.get())


def require_ready(path):
    """未完成后台验证时拒绝业务写入，不能把私密目标误作公开目标处理。"""
    if not _authorized.get() or path.startswith('/api/crypto/') or path in (
            '/data/crypto-keyring.json',
            '/api/album/job', '/api/admin/backup', '/api/media/retry',
            '/api/git/commit_push', '/api/git/commit-push'):
        return
    if active():
        from .crypto_keyring import KEYRING_FILE
        identity = hashlib.sha256(('maers-dek-id|' + _key).encode()).hexdigest()[:16]
        if not os.path.isfile(KEYRING_FILE) or _raw(KEYRING_FILE).get('dek_id') != identity:
            close({})
            raise PermissionError('密钥环已变化，请重新验证主密码')
    if not active() and status()['has_encrypted']:
        raise PermissionError('请先验证主密码，再管理加密内容')


def _raw(path):
    with open(path, encoding='utf-8') as source:
        return json.load(source)


def _relative(path):
    return os.path.relpath(os.path.abspath(path), config.DATA_DIR).replace('\\', '/')


def supported(path):
    relative = _relative(path)
    return '/' not in relative and (relative.endswith('-tree.json') or relative in (
        'album-config.json', 'index-cards.json', 'music-data.json', 'space-tree.json'))


def _marked(value):
    if isinstance(value, dict):
        return bool(_MARKERS.intersection(value)) or any(_marked(child) for child in value.values())
    return isinstance(value, list) and any(_marked(child) for child in value)


def status():
    from .crypto_keyring import KEYRING_FILE
    from .crypto_rotation import _files, encrypted_count
    return {'configured': os.path.isfile(KEYRING_FILE),
            'has_encrypted': any(encrypted_count(_raw(path)) for path in _files())}


def start(body):
    global _key, _lease, _media_cookie
    from .crypto_keyring import KEYRING_FILE
    raw = body.get('key')
    try:
        decoded = base64.b64decode(raw, validate=True)
    except (TypeError, ValueError):
        raise ValueError('Invalid private management key') from None
    if not os.path.isfile(KEYRING_FILE):
        raise ValueError('本机尚未配置密钥环，请刷新后台')
    ring = _raw(KEYRING_FILE)
    identity = hashlib.sha256(('maers-dek-id|' + raw).encode()).hexdigest()[:16]
    if len(decoded) != 32 or not secrets.compare_digest(identity, ring['dek_id']):
        raise ValueError('后台密钥不匹配，请重新输入主密码')
    if _key != raw:
        close({})
        _key = raw
    if not shutil.which('node'):
        close({})
        raise RuntimeError('私密管理需要 Node.js，请安装项目要求的 Node.js 后重试')
    _lease, _media_cookie = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
    return {'status': 'success', 'lease': _lease}


def close(body):
    global _key, _lease, _media_cookie
    if body.get('lease') and body['lease'] != _lease:
        return {'status': 'ignored'}
    _key = _lease = _media_cookie = None
    for cache in (_decoded, _references, _documents, _albums):
        cache.clear()
    _media.clear()
    _dirty_documents.clear()
    return {'status': 'success'}


atexit.register(lambda: close({}))


def cookie_header():
    return f'maers_private={_media_cookie or ""}; HttpOnly; SameSite=Strict; Path=/api/private/media/'


def media_authorized(header):
    from http.cookies import SimpleCookie
    cookie = SimpleCookie()
    try:
        cookie.load(header or '')
        value = cookie.get('maers_private')
        return bool(_key and _media_cookie and value and secrets.compare_digest(value.value, _media_cookie))
    except (ValueError, TypeError):
        return False


def crypt(operation, values):
    if not active():
        raise ValueError('请先输入主密码以管理加密内容')
    runtime = os.path.join(config.BASE_DIR, 'tools', 'private_crypto.mjs')
    result = subprocess.run([shutil.which('node'), runtime],
        input=json.dumps({'key': _key, 'operation': operation, 'values': values}),
        capture_output=True, text=True, encoding='utf-8', timeout=25,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise ValueError('加密数据无法还原，请检查主密码或恢复备份')
    return json.loads(result.stdout)


def _decrypt(cipher):
    if cipher not in _decoded:
        _decoded[cipher] = crypt('decrypt', [cipher])[0]
    return copy.deepcopy(_decoded[cipher])


def _encrypt(value):
    cipher = crypt('encrypt', [value])[0]
    _decoded[cipher] = copy.deepcopy(value)
    return cipher


def _register_media(value):
    if isinstance(value, dict):
        for field in ('path', 'thumb', 'preview'):
            if isinstance(value.get(field), str) and value[field].startswith('photos/'):
                _media.add(value[field])
        for child in value.values():
            _register_media(child)
    elif isinstance(value, list):
        for child in value:
            _register_media(child)


def read(path, value):
    if not active() or not supported(path):
        return value
    path = os.path.abspath(path)
    refs = _references[path] = {}
    cms = path.endswith('-tree.json') and os.path.basename(path) != 'space-tree.json'
    album = path == os.path.abspath(config.ALBUM_CONFIG_JSON)
    if album:
        _albums.clear()
    module = os.path.basename(path).removesuffix('-tree.json')

    def visit(item, inherited=False):
        if isinstance(item, list):
            return [visit(child, inherited) for child in item]
        if not isinstance(item, dict):
            return item
        if item.get('_enc'):
            envelope = copy.deepcopy(item)
            body = _decrypt(item['_enc'])
            if cms and item.get('id') != body.get('id'):
                raise ValueError('私密记录编号不一致，已停止读取')
            cipher_id = hashlib.sha256(item['_enc'].encode()).hexdigest()[:24]
            if album:
                category = body['category']
                _albums[category['id']] = {'payload': body, 'envelope': envelope}
                _register_media(body.get('photos', []))
                body = copy.deepcopy(category)
            elif cms:
                _register_media(body)
            body.setdefault('id', 'private_' + cipher_id)
            marker = hashlib.sha256((path + '|' + str(body['id'])).encode()).hexdigest()[:24]
            refs[marker] = {'envelope': envelope, 'id': body['id'], 'cms': cms, 'album': album}
            body = visit(body, True)
            body['_private_id'] = marker
            return body
        result = {key: visit(child, inherited) for key, child in item.items()}
        if inherited and any(key in result for key in ('id', 'title', 'name', 'bvid', 'url', 'type')):
            result.setdefault('id', 'private_' + hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()[:24])
            result['_private'] = True
            if cms and result.get('type') == 'note':
                relative = f'{module}/private-{result["id"]}.md'
                if not all(c.isalnum() or c in '_-.' for c in result['id']):
                    raise ValueError('Invalid private node identity')
                full = os.path.abspath(os.path.join(config.DATA_DIR, relative))
                text = result.pop('md', '')
                if full not in _dirty_documents:
                    _documents[full] = text
                result['content'] = relative
        return result
    return visit(value)


def prepare(path, value):
    if not supported(path):
        return value
    if not active():
        if _marked(value):
            raise ValueError('私密管理验证已失效，请刷新后重新验证主密码')
        return value
    path = os.path.abspath(path)
    if os.path.isfile(path):
        read(path, _raw(path))
    refs = _references.get(path, {})
    by_id = {ref['id']: (marker, ref) for marker, ref in refs.items()}
    cms = path.endswith('-tree.json') and os.path.basename(path) != 'space-tree.json'

    def encode(item, inside=False):
        if isinstance(item, str) and item.startswith('/api/private/media/'):
            return unquote(item[len('/api/private/media/'):])
        if isinstance(item, list):
            return [encode(child, inside) for child in item]
        if not isinstance(item, dict) or item.get('_enc'):
            return item
        marker = item.get('_private_id')
        match = refs.get(marker) or by_id.get(item.get('id'), (None, None))[1]
        if marker and marker not in refs:
            raise ValueError('私密内容已变化，请刷新后重新保存')
        protect = bool(match or item.get('_private')) and (not inside or bool(marker))
        clean = {k: encode(v, inside or protect) for k, v in item.items() if k not in _MARKERS}
        if cms and (protect or inside) and item.get('type') == 'note':
            full = os.path.abspath(os.path.join(config.DATA_DIR, item.get('content', '')))
            if full not in _documents:
                raise ValueError('私密正文未载入，保存已停止')
            clean.pop('content', None)
            clean['md'] = _documents[full]
        if not protect:
            return clean
        envelope = copy.deepcopy(match['envelope']) if match else ({'id': item['id'], 'type': 'locked',
                     'children': None, 'mediaVersion': 1} if cms else {})
        if match and match['album']:
            payload = copy.deepcopy(_albums[item['id']]['payload'])
            payload['category'] = clean
            clean = payload
        envelope['_enc'] = _encrypt(clean)
        return envelope
    return encode(value)


def envelope(path, marker):
    return copy.deepcopy(_references[os.path.abspath(path)][marker]['envelope'])


def albums():
    if active() and os.path.isfile(config.ALBUM_CONFIG_JSON):
        read(config.ALBUM_CONFIG_JSON, _raw(config.ALBUM_CONFIG_JSON))
    return _albums if active() else {}


def save_album(category, payload):
    from . import storage
    current = _raw(config.ALBUM_CONFIG_JSON)
    entry = _albums[category]
    index = next((i for i, item in enumerate(current) if item.get('_enc') == entry['envelope']['_enc']), None)
    if index is None:
        raise ValueError('私密相册已变化，请重新载入后再保存')
    current[index] = {**entry['envelope'], '_enc': _encrypt(payload)}
    storage.write_json(config.ALBUM_CONFIG_JSON, current)
    read(config.ALBUM_CONFIG_JSON, current)


def document(path):
    return _documents.get(os.path.abspath(path)) if active() else None


def write_document(path, text):
    path = os.path.abspath(path)
    if active() and path in _documents:
        from . import storage
        previous = _documents[path]
        storage.on_rollback(lambda: (_documents.__setitem__(path, previous), _dirty_documents.discard(path)))
        storage.on_commit(lambda: _dirty_documents.discard(path))
        _dirty_documents.add(path)
        _documents[path] = text
        return True
    return False


def new_document(module, identity, text=''):
    if not isinstance(identity, str) or not identity or not all(c.isalnum() or c in '_-.' for c in identity):
        raise ValueError('Invalid private node identity')
    relative = f'{module}/private-{identity}.md'
    path = os.path.abspath(os.path.join(config.DATA_DIR, relative))
    _documents[path] = ''
    write_document(path, text)
    return relative


def media_url(key):
    return '/api/private/media/' + '/'.join(quote(part, safe='') for part in key.split('/'))


def media_bytes(key):
    from . import media_store
    if not active() or key not in _media:
        raise ValueError('Private media is not available')
    return media_store.get_store().read('private', key)


def view(value):
    """只转换响应中的媒体地址；工作记录始终保留真实文件键。"""
    if isinstance(value, list):
        return [view(child) for child in value]
    if not isinstance(value, dict):
        return value
    result = {key: view(child) for key, child in value.items()}
    for field in ('path', 'thumb', 'preview', 'coverImage', 'coverThumb', 'coverPreview'):
        if isinstance(result.get(field), str) and result[field] in _media:
            result[field] = media_url(result[field])
    if isinstance(value.get('coverRow'), dict):
        row = value['coverRow']
        result['coverPreview'] = media_url(row.get('preview') or row['path'])
        result['coverThumb'] = media_url(row.get('thumb') or row['path'])
    return result


def static(path):
    if not active():
        return None
    text = document(path)
    if text is not None:
        return 'text/plain; charset=utf-8', text.encode('utf-8')
    if os.path.abspath(path) == os.path.abspath(os.path.join(config.DATA_DIR, 'photos-data.json')):
        value = _raw(path)
        for category, entry in albums().items():
            value[category] = [{**row, '_private': True, 'tags': json.loads(row['tags']) if isinstance(row.get('tags'), str) and row['tags'] else row.get('tags', [])} for row in entry['payload']['photos']]
        return 'application/json; charset=utf-8', json.dumps(view(value)).encode()
    if supported(path) and os.path.isfile(path):
        return 'application/json; charset=utf-8', json.dumps(view(read(path, _raw(path)))).encode()
    return None


def protection(source):
    path = os.path.abspath(os.path.join(config.DATA_DIR, source))
    if not active():
        raise PermissionError('请先验证主密码')
    if not supported(path):
        raise ValueError('Invalid private management source')
    read(path, _raw(path))
    return {'references': list(_references[path])}


def unprotect(body):
    from . import storage, album_lock, cms
    marker = body.get('reference')
    found = next(((path, refs[marker]) for path, refs in _references.items() if marker in refs), None)
    if not active():
        raise PermissionError('请先验证主密码')
    if found is None:
        raise ValueError('请刷新后台后再取消加密')
    path, reference = found
    raw = _raw(path)
    read(path, raw)
    reference = _references[path].get(marker)
    if reference is None:
        raise ValueError('该记录的加密状态已变化，请刷新后台')
    cipher = reference['envelope']['_enc']
    payload = _decrypt(cipher)

    def replace(value):
        if isinstance(value, dict):
            if value.get('_enc') == cipher:
                return copy.deepcopy(payload)
            return {key: replace(child) for key, child in value.items()}
        return [replace(child) for child in value] if isinstance(value, list) else value

    with context(False):
        if reference['album']:
            return album_lock.unlock_category(cipher, payload)
        if reference['cms']:
            module = os.path.basename(path).removesuffix('-tree.json')
            cms._unlock(module, {'id': reference['id'], 'tree': payload}, cms.get_context())
        else:
            storage.write_json(path, replace(raw))
    return 200, {'status': 'success', 'record': payload}
