"""私密文章的图片上传和公开转私密迁移；管理视图保持可编辑，真源始终加密。"""
import copy
from . import cms, cms_store, cms_nodes, cms_covers, photos, private_session, storage


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
             for field in ('path', 'thumb', 'preview') if row.get(field)}
    keys = photos.media_references(changes.get('content', ''))
    cover = changes.get('coverImage')
    if cover:
        key = cover if cover in index else photos.normalize_media_reference(cover)
        if key.startswith('photos/'):
            keys.append(key)
            node['coverRow'] = index.get(key)
    elif 'coverImage' in changes:
        node.pop('coverRow', None)
    if any(key not in index and photos.normalize_media_reference(key) not in index for key in keys):
        raise ValueError('私密内容中的站内图片请通过本文章的上传按钮添加，以免引用公开图片')


@storage.transactional
def upload(query, data):
    from .private_photos import store_image
    module, identity = query.get('module', [''])[0], query.get('node_id', [''])[0]
    tree = cms.fetch_module_tree(module)
    node = _node(tree, identity)
    if not node.get('_private'):
        return None
    category = photos.media_component(query.get('category', ['_notes'])[0])
    row = store_image(category, data, query.get('name', ['image.png'])[0], owner=f'{module}/{identity}')
    rows = node.setdefault('mediaRows', [])
    if not any(existing['path'] == row['path'] for existing in rows):
        rows.append(row)
    if query.get('cover') == ['1']:
        node['coverImage'], node['coverRow'] = row['path'], row
    cms.save_module_tree(module, tree)
    private_session.read(cms._tree_path(module), cms_store.load(cms._tree_path(module)))
    return {**row, 'relPath': row['path'], 'status': 'success', 'sync': {'state': 'complete'}}


@storage.transactional
def protect(module, identity):
    """复用现有迁移事务，先核验私有副本，再发布密文、移除公开正文和图片。"""
    if not private_session.active():
        raise ValueError('请先验证主密码')
    tree = cms.fetch_module_tree(module)
    siblings, index, target = cms_nodes._find(tree, identity)
    if target.get('_private'):
        return True
    photos.rebuild_cache()
    image_index = {}
    connection = photos.get_db()
    try:
        for row in connection.execute('SELECT * FROM photos'):
            row = dict(row)
            for field in ('path', 'thumb', 'preview'):
                if row[field]:
                    image_index[row[field]] = row
    finally:
        connection.close()
    paths = set()

    def pack(node):
        if node.get('_enc'):
            return copy.deepcopy(node)
        if node.get('_private_id'):
            return private_session.envelope(cms._tree_path(module), node['_private_id'])
        result = {key: copy.deepcopy(node[key]) for key in ('id', 'type', 'title', 'tags', 'coverImage') if key in node}
        text = _text(node)
        if node['type'] == 'note':
            result['md'] = text
        keys = photos.media_references(text)
        cover = node.get('coverImage')
        if cover and photos.normalize_media_reference(cover).startswith('photos/'):
            keys.append(cover)
        rows = {}
        for key in keys:
            row = image_index.get(key) or image_index.get(photos.normalize_media_reference(key))
            if row is None:
                raise ValueError('图片未在公开索引中，已停止加密，请先恢复图片')
            rows[row['path']] = row
            paths.add(row['path'])
        if cover:
            result['coverRow'] = image_index.get(cover) or image_index.get(photos.normalize_media_reference(cover))
        result['mediaRows'] = list(rows.values())
        result['children'] = [pack(child) for child in node.get('children') or []] if node['type'] == 'folder' else None
        return result

    payload = pack(target)
    cms_covers.validate_lock_media(module, identity, paths)
    migration = cms_covers.prepare_lock(paths)
    if migration:
        storage.compensate(migration['store'].recovery_record('restore_public', migration['keys']),
                           lambda: cms_covers.rollback_lock(migration))
    siblings[index] = {'id': identity, 'type': 'locked', 'children': None, 'mediaVersion': 1,
                       '_enc': private_session.crypt('encrypt', [payload])[0]}
    cms.save_module_tree(module, tree)
    cms_nodes._remove_markdown([target], cms.get_context())
    cms_covers.finalize_lock(migration)
    return True
