"""私密文章的图片上传和公开转私密迁移；管理视图保持可编辑，真源始终加密。"""
import copy
import hashlib
from contextlib import closing
from . import cms, cms_store, cms_nodes, cms_covers, photos, private_session, storage

_MEDIA_FIELDS = ('path', 'thumb', 'preview')


def _node(tree, identity):
    return cms_nodes._find(tree, identity)[2]


def _text(node):
    content = node.get('content') or ''
    if not content.endswith('.md'):
        return content
    path = cms_nodes._md_path(cms.get_context(), content)
    text = private_session.document(path)
    if text is not None:
        return text
    with open(path, encoding='utf-8', newline='') as source:
        return source.read()


def validate_edit(node, changes):
    """私密正文仅引用本记录已持有的站内图片，避免误挂公开图片。"""
    rows = [node.get('coverRow'), *(node.get('mediaRows') or [])]
    index = {row[field]: row for row in rows if isinstance(row, dict)
             for field in _MEDIA_FIELDS if row.get(field)}
    keys = photos.media_references(changes.get('content', ''))
    cover = changes.get('coverImage')
    if cover:
        key = cover if cover in index else photos.normalize_media_reference(cover)
        if key.startswith('photos/'):
            keys.append(key)
    if any(key not in index and photos.normalize_media_reference(key) not in index for key in keys):
        raise ValueError('私密内容中的站内图片请通过本文章的上传按钮添加，以免引用公开图片')
    # 所有引用通过校验后再修改内存封面，失败时保留原有记录。
    if cover and key.startswith('photos/'):
        node['coverRow'] = index[key]
    elif not cover and 'coverImage' in changes:
        node.pop('coverRow', None)


@storage.transactional
def upload(query, data):
    from .private_photos import store_image
    module, identity = query.get('module', [''])[0], query.get('node_id', [''])[0]
    tree = cms.fetch_module_tree(module)
    node = _node(tree, identity)
    if node.get('_enc'):
        raise PermissionError('请先解锁文章所属密码组再上传')
    if not node.get('_private'):
        return None
    category = photos.media_component(query.get('category', ['_notes'])[0])
    rows = node.setdefault('mediaRows', [])
    digest = hashlib.md5(data).hexdigest()
    duplicate = next((row for row in rows if row.get('hash') == digest
                      and row['path'].split('/')[2] == category), None)
    row = store_image(category, data, query.get('name', ['image.png'])[0],
                      group=node.get('_private_group', 'default'), existing=duplicate, fallback_label=query.get('dateLabel', [None])[0])
    if not any(existing['path'] == row['path'] for existing in rows):
        rows.append(row)
    if query.get('cover') == ['1']:
        node['coverImage'], node['coverRow'] = row['path'], row
    cms.save_module_tree(module, tree)
    private_session.read(cms._tree_path(module), cms_store.load(cms._tree_path(module)))
    return {**row, 'relPath': row['path'], 'status': 'success', 'sync': {'state': 'complete'}}


def _image_index():
    """以三种图像路径建立同一张照片的查询索引，并及时释放缓存连接。"""
    photos.rebuild_cache()
    with closing(photos.get_db()) as connection:
        rows = (dict(row) for row in connection.execute('SELECT * FROM photos'))
        return {row[field]: row for row in rows for field in _MEDIA_FIELDS if row[field]}


class _NodePacker:
    """一次迁移共用媒体索引，递归打包时保留已有密文及密码组归属。"""

    def __init__(self, module, group):
        self.module = module
        self.group = group
        self.images = _image_index()
        self.paths = set()

    def _envelope(self, node):
        if node.get('_enc'):
            envelope = copy.deepcopy(node)
        elif node.get('_private_id'):
            envelope = private_session.envelope(cms._tree_path(self.module), node['_private_id'])
        else:
            return None
        if envelope.get('_group', 'default') != self.group:
            raise ValueError('子项使用其他密码组，请先单独调整后再整体加密')
        return envelope

    def _image(self, key):
        path = photos.normalize_media_reference(key)
        row = self.images.get(key) or self.images.get(path)
        if row is None:
            row = cms_covers.restore_relay_attachments([key]).get(path)
            if row is not None:
                self.images.update({row[field]: row for field in _MEDIA_FIELDS if row[field]})
        return row

    def _media_rows(self, node, text):
        """在迁移私密图片前收集正文和封面引用的真实图片。"""
        keys = photos.media_references(text)
        cover = node.get('coverImage')
        if cover and photos.normalize_media_reference(cover).startswith('photos/'):
            keys.append(cover)
        rows = {}
        for key in keys:
            row = self._image(key)
            if row is not None:
                rows[row['path']] = row
                self.paths.add(row['path'])
        return list(rows.values())

    def pack(self, node):
        envelope = self._envelope(node)
        if envelope is not None:
            return envelope
        result = {key: copy.deepcopy(node[key]) for key in ('id', 'type', 'title', 'tags', 'coverImage') if key in node}
        text = _text(node)
        if node['type'] == 'note':
            result['md'] = text
        if node.get('coverImage'):
            result['coverRow'] = self._image(node['coverImage'])
        result['mediaRows'] = self._media_rows(node, text)
        result['children'] = [self.pack(child) for child in node.get('children') or []] if node['type'] == 'folder' else None
        return result


def _require_group(group):
    """加密、换组共用：主密码会话有效，且所选密码组存在并已解锁（需要其令牌授权私有图片）。"""
    from . import crypto_keyring
    if not private_session.active():
        raise ValueError('请先验证主密码')
    crypto_keyring.require_content_group(group)
    if not private_session.group_unlocked(group):
        raise ValueError('请先解锁所选密码组')


@storage.transactional
def protect(module, identity, group='default'):
    """将节点标记为私密：图片迁入私有桶并授权给所选密码组，保留本地物理 Markdown，打上 _private 标记。"""
    from . import media_groups
    _require_group(group)
    tree = cms.fetch_module_tree(module)
    siblings, index, target = cms_nodes._find(tree, identity)
    if target.get('_private'):
        return True
    packer = _NodePacker(module, group)
    payload = packer.pack(target)
    cms_covers.validate_lock_media(module, identity, packer.paths)
    # 图片迁入私有桶后公开图库行会被删除，行信息随节点保存，解密时据此完整恢复。
    media_rows = cms_covers.collect_cover_rows(payload)
    migration = cms_covers.prepare_lock(packer.paths)
    if migration:
        media_groups.assign(migration['keys'], group, replace=True, store=migration['store'])
    target['_private'] = True
    if group != 'default':
        target['_group'] = group
    if media_rows:
        target['_media'] = media_rows
    cms.save_module_tree(module, tree)
    cms_covers.finalize_lock(migration)
    return True


@storage.transactional
def unprotect(module, identity):
    """解除对外加密：整棵子树恢复公开，私有桶图片迁回公开桶并恢复图库登记，本地 Markdown 不变。"""
    tree = cms.fetch_module_tree(module)
    target = cms_nodes._find(tree, identity)[2]
    subtree = list(cms_store.walk([target]))
    if not target.get('_private'):
        raise ValueError('Node is not locked')
    if any(node.get('_private_id') or node.get('_private_group') for node in subtree):
        raise ValueError('旧版密文内容请使用解密入口')
    rows = {}
    for node in subtree:
        for row in node.pop('_media', None) or []:
            rows[row['path']] = row
        node.pop('_private', None)
        node.pop('_group', None)
    restoration = cms_covers.prepare_unlock({'mediaRows': list(rows.values())})
    cms.save_module_tree(module, tree)
    cms_covers.finalize_unlock(restoration)
    return True



@storage.transactional
def change_group(module, identity, group):
    """更换私密节点所属密码组：子树的 _group 标记与私有图片的访问授权一并更新，本地 Markdown 不变。"""
    from . import media_groups, album_lock
    _require_group(group)
    tree = cms.fetch_module_tree(module)
    target = cms_nodes._find(tree, identity)[2]
    subtree = list(cms_store.walk([target]))
    if not target.get('_private'):
        raise ValueError('Node is not locked')
    if any(node.get('_private_id') or node.get('_private_group') for node in subtree):
        raise ValueError('旧版密文内容请使用解密入口')
    keys = []
    for node in subtree:
        if node is target or node.get('_private'):
            if group == 'default':
                node.pop('_group', None)
            else:
                node['_group'] = group
        keys += album_lock.collect_keys(node.get('_media') or [])
    if keys:
        media_groups.assign(keys, group, replace=True)
    cms.save_module_tree(module, tree)
    return True
