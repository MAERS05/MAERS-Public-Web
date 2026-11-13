"""私密内容工作区：读写编解码、内容引用、正文内存与相册载荷，明文不写入公开文件。"""
import copy
import hashlib
import json
import os
from urllib.parse import unquote
import config

_MARKERS = {'_private', '_private_id', '_private_group'}

def read_source(path):
    with open(path, encoding='utf-8') as source:
        return json.load(source)


def _relative(path):
    return os.path.relpath(os.path.abspath(path), config.DATA_DIR).replace('\\', '/')


def supported(path):
    relative = _relative(path)
    return '/' not in relative and (relative.endswith('-tree.json') or relative in (
        'album-config.json', 'index-cards.json', 'music-data.json', 'space-tree.json'))


def has_view_markers(value):
    """旧版后台解密视图专用标记；方案 3 落盘的 _private/_group 不在此列。"""
    if isinstance(value, dict):
        return bool({'_private_id', '_private_group'}.intersection(value)) or any(has_view_markers(child) for child in value.values())
    return isinstance(value, list) and any(has_view_markers(child) for child in value)


def has_private_markers(value):
    if isinstance(value, dict):
        return bool(_MARKERS.intersection(value)) or any(has_private_markers(child) for child in value.values())
    return isinstance(value, list) and any(has_private_markers(child) for child in value)


def outer_envelopes(value):
    """只遍历外层密文；独立加密的后代由对应密码组自行处理。"""
    if isinstance(value, dict):
        if value.get('_enc'):
            yield value
        else:
            for child in value.values():
                yield from outer_envelopes(child)
    elif isinstance(value, list):
        for child in value:
            yield from outer_envelopes(child)


def _is_cms(path):
    return path.endswith('-tree.json') and os.path.basename(path) != 'space-tree.json'


class PrivateRecords:
    """内容视图只依赖显式注入的会话、媒体授权与密码学调用。"""

    def __init__(self, state, media, crypt):
        self.state = state
        self.media = media
        self.crypt = crypt

    def media_keys(self, value, group=None):
        return self.media.keys(value, group)

    def reference(self, path, marker):
        return copy.deepcopy(self.state.references[os.path.abspath(path)][marker])

    def decrypt(self, cipher, group='default'):
        if not self.state.group_unlocked(group):
            raise ValueError('请先解锁对应密码组')
        identity = (group, cipher)
        if identity not in self.state.decoded:
            self.state.decoded[identity] = self.crypt('decrypt', [cipher], group)[0]
        return copy.deepcopy(self.state.decoded[identity])

    def encrypt(self, value, group='default'):
        cipher = self.crypt('encrypt', [value], group)[0]
        self.state.decoded[(group, cipher)] = copy.deepcopy(value)
        return cipher

    def _catalog_record(self, path, marker, reference):
        envelope = reference['envelope']
        payload = self.decrypt(envelope['_enc'], reference['group'])
        record = payload.get('category', payload) if reference['album'] else payload
        return {'reference': marker, 'source': _relative(path), 'group': reference['group'],
                'title': record.get('title') or record.get('name') or reference['id'],
                'revision': hashlib.sha256(envelope['_enc'].encode()).hexdigest(),
                'media': self.media_keys(payload, reference['group']), 'locked': False}

    def catalog(self):
        """只返回已解锁项的标题与媒体；其他组只返回锁定占位。"""
        from .crypto_keyring import _source_snapshots
        if not self.state.active():
            return []
        return [record for snapshot in _source_snapshots() if supported(snapshot['path'])
                for record in self._catalog_snapshot(snapshot)]

    def _catalog_snapshot(self, snapshot):
        path = snapshot['path']
        self.read(path, snapshot['data'])
        envelopes = list(outer_envelopes(snapshot['data']))
        outer = {item['_enc'] for item in envelopes}
        result = [self._catalog_record(path, marker, reference)
                  for marker, reference in self.state.references.get(os.path.abspath(path), {}).items()
                  if reference['envelope']['_enc'] in outer]
        for item in envelopes:
            group = item.get('_group', 'default')
            if not self.state.group_unlocked(group):
                result.append({'reference': '', 'source': _relative(path), 'group': group,
                               'title': '未解锁内容', 'media': [], 'locked': True})
        return result

    def read(self, path, value):
        if not self.state.active() or not supported(path):
            return value
        return _ReadContext(self, os.path.abspath(path)).decode(value)

    def prepare(self, path, value):
        if not supported(path):
            return value
        if not self.state.active():
            if has_view_markers(value):
                raise ValueError('私密管理验证已失效，请刷新后重新验证主密码')
            return value
        path = os.path.abspath(path)
        if os.path.isfile(path):
            self.read(path, read_source(path))
        return _WriteContext(self, path).encode(value)

    def envelope(self, path, marker):
        return copy.deepcopy(self.state.references[os.path.abspath(path)][marker]['envelope'])

    def albums(self):
        if self.state.active() and os.path.isfile(config.ALBUM_CONFIG_JSON):
            self.read(config.ALBUM_CONFIG_JSON, read_source(config.ALBUM_CONFIG_JSON))
        return self.state.albums if self.state.active() else {}

    def save_album(self, category, payload):
        from . import storage
        current = read_source(config.ALBUM_CONFIG_JSON)
        entry = self.state.albums[category]
        index = next((i for i, item in enumerate(current) if item.get('_enc') == entry['envelope']['_enc']), None)
        if index is None:
            raise ValueError('私密相册已变化，请重新载入后再保存')
        current[index] = {**entry['envelope'], '_enc': self.encrypt(payload, entry['group'])}
        storage.write_json(config.ALBUM_CONFIG_JSON, current)
        self.read(config.ALBUM_CONFIG_JSON, current)

    def document(self, path):
        return self.state.documents.get(os.path.abspath(path)) if self.state.active() else None

    def write_document(self, path, text):
        path = os.path.abspath(path)
        if self.state.active() and path in self.state.documents:
            from . import storage
            previous = self.state.documents[path]
            storage.on_rollback(lambda: (self.state.documents.__setitem__(path, previous), self.state.dirty_documents.discard(path)))
            storage.on_commit(lambda: self.state.dirty_documents.discard(path))
            self.state.dirty_documents.add(path)
            self.state.documents[path] = text
            return True
        return False

    def new_document(self, module, identity, text=''):
        if not isinstance(identity, str) or not identity or not all(c.isalnum() or c in '_-.' for c in identity):
            raise ValueError('Invalid private node identity')
        relative = f'markdown/{module}/private-{identity}.md'
        path = os.path.abspath(os.path.join(config.PROJECT_ROOT, relative))
        self.state.documents[path] = ''
        self.write_document(path, text)
        return relative

    def current_reference(self, marker):
        """从最新文件重新定位标记，拒绝使用已经被其他保存替换的引用。"""
        if not self.state.active():
            raise PermissionError('请先验证主密码')
        found = next(((path, refs[marker]) for path, refs in self.state.references.items() if marker in refs), None)
        if found is None:
            raise ValueError('请刷新后台后再取消加密')
        path, reference = found
        raw = read_source(path)
        self.read(path, raw)
        reference = self.state.references[path].get(marker)
        if reference is None:
            raise ValueError('该记录的加密状态已变化，请刷新后台')
        return path, raw, reference


class _ReadContext:
    """单次读取的路径、引用表与格式信息，不与其他读取共享工作状态。"""

    def __init__(self, owner, path):
        self.owner = owner
        self.path = path
        self.refs = self.owner.state.references[path] = {}
        self.cms = _is_cms(path)
        self.album = path == os.path.abspath(config.ALBUM_CONFIG_JSON)
        self.module = os.path.basename(path).removesuffix('-tree.json')
        if self.album:
            self.owner.state.albums.clear()

    def decode(self, item, inherited=False, group='default'):
        if isinstance(item, list):
            return [self.decode(child, inherited, group) for child in item]
        if not isinstance(item, dict):
            return item
        if item.get('_enc'):
            return self._encrypted(item)
        if self.cms and item.get('_private') and self.owner.state.group_unlocked(item.get('_group', 'default')):
            self.owner.media.register(item.get('_media', []))
        result = {key: self.decode(child, inherited, group) for key, child in item.items()}
        if inherited and any(key in result for key in ('id', 'title', 'name', 'bvid', 'url', 'type')):
            self._mark_private(result, group)
        return result

    def _encrypted(self, item):
        envelope = copy.deepcopy(item)
        group = item.get('_group', 'default')
        if not self.owner.state.group_unlocked(group):
            return envelope
        body = self.owner.decrypt(item['_enc'], group)
        if self.cms and item.get('id') != body.get('id'):
            raise ValueError('私密记录编号不一致，已停止读取')
        if self.album:
            category = body['category']
            self.owner.state.albums[category['id']] = {'payload': body, 'envelope': envelope, 'group': group}
            self.owner.media.register(body.get('photos', []))
            body = copy.deepcopy(category)
        elif self.cms:
            self.owner.media.register(body)
        cipher_id = hashlib.sha256(item['_enc'].encode()).hexdigest()[:24]
        body.setdefault('id', 'private_' + cipher_id)
        marker = hashlib.sha256((self.path + '|' + str(body['id'])).encode()).hexdigest()[:24]
        self.refs[marker] = {'envelope': envelope, 'id': body['id'], 'cms': self.cms,
                             'album': self.album, 'group': group}
        body = self.decode(body, True, group)
        body['_private_id'] = marker
        return body

    def _mark_private(self, record, group):
        record.setdefault('id', 'private_' + hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()[:24])
        record['_private'] = True
        record['_private_group'] = group
        if not self.cms or record.get('type') != 'note':
            return
        if not all(char.isalnum() or char in '_-.' for char in record['id']):
            raise ValueError('Invalid private node identity')
        relative = f'markdown/{self.module}/private-{record["id"]}.md'
        full = os.path.abspath(os.path.join(config.PROJECT_ROOT, relative))
        text = record.pop('md', '')
        if full not in self.owner.state.dirty_documents:
            self.owner.state.documents[full] = text
        record['content'] = relative


class _WriteContext:
    """单次保存的引用解析与递归编码，正文仍只从内存工作区取值。"""

    def __init__(self, owner, path):
        self.owner = owner
        self.refs = self.owner.state.references.get(path, {})
        self.by_id = {reference['id']: reference for reference in self.refs.values()}
        self.cms = _is_cms(path)

    def encode(self, item, inside=None):
        if isinstance(item, str) and item.startswith('/api/private/media/'):
            return unquote(item[len('/api/private/media/'):])
        if isinstance(item, list):
            return [self.encode(child, inside) for child in item]
        if not isinstance(item, dict):
            return item
        if item.get('_enc'):
            if inside and item.get('_group', 'default') != inside:
                raise ValueError('文件夹内的独立加密项必须使用同一密码组')
            return item
        return self._record(item, inside)

    def _record(self, item, inside):
        marker = item.get('_private_id')
        match = self.refs.get(marker) or self.by_id.get(item.get('id'))
        if marker and marker not in self.refs:
            raise ValueError('私密内容已变化，请刷新后重新保存')
        # 方案 3 的 _private/_group 是落盘标记，不是旧版解密视图；只有视图专用标记才说明会话已失效。
        protect = bool(match or (item.get('_private') and not self.cms)) and (not inside or bool(marker))
        group = match['group'] if match else item.get('_private_group', inside or 'default')
        if inside and protect and group != inside:
            raise ValueError('文件夹内的独立加密项必须使用同一密码组')
        child_group = group if protect else inside
        keep_flag = self.cms and not protect and not inside and not marker and '_private_group' not in item
        clean = {key: self.encode(child, child_group) for key, child in item.items()
                 if key not in _MARKERS or (keep_flag and key == '_private')}
        if self.cms and (protect or inside) and item.get('type') == 'note':
            self._include_markdown(clean, item)
        return self._envelope(clean, item, match, group) if protect else clean

    def _include_markdown(self, clean, item):
        full = os.path.abspath(os.path.join(config.PROJECT_ROOT, item.get('content', '')))
        if full not in self.owner.state.documents:
            raise ValueError('私密正文未载入，保存已停止')
        clean.pop('content', None)
        clean['md'] = self.owner.state.documents[full]

    def _envelope(self, clean, item, match, group):
        if match:
            envelope = copy.deepcopy(match['envelope'])
        else:
            envelope = {'id': item['id'], 'type': 'locked', 'children': None, 'mediaVersion': 1} if self.cms else {}
        if match and match['album']:
            payload = copy.deepcopy(self.owner.state.albums[item['id']]['payload'])
            payload['category'] = clean
            clean = payload
        if group != 'default':
            envelope['_group'] = group
        envelope['_enc'] = self.owner.encrypt(clean, group)
        return envelope
