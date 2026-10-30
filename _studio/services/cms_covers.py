"""
CMS 封面图私密化 (cms_covers.py)

职责：CMS 节点加锁时，把其（及子树）封面图迁入私有桶并从公开侧移除；解锁时迁回。
封面图的数据库行由前端打包进密文（字段 coverRow），后端不保存任何明文记录。

顺序保证：
  加锁：迁入私有桶并校验 -> 写库加锁 -> 删除公开文件与图片行
  解锁：从私有桶取回文件 -> 写库解锁 -> 恢复图片行 -> 外层事务及回执提交后清理私有副本
任一步失败都不会丢失文件。
"""
import json

from . import album_lock, photos, cms, cms_store, storage


def validate_lock_media(module, node_id, paths):
    """在加锁前检查真实正文的媒体清单，拒绝旧客户端遗漏和跨文章共享图片。"""
    tree = cms.fetch_module_tree(module)
    node = next((item for item in cms_store.walk(tree['root']) if item['id'] == node_id), None)
    if node is None or node.get('_enc'):
        raise ValueError('Node not found or already locked')
    selected = {item['id'] for item in cms_store.walk([node])}
    index = {}
    connection = photos.get_db()
    try:
        for row in connection.execute('SELECT * FROM photos'):
            for field in ('path', 'thumb', 'preview'):
                if row[field]:
                    index[row[field]] = row['path']
    finally:
        connection.close()

    def references(item, strict=False):
        if item.get('_enc') or item.get('_private'):
            return set()
        content = str(item.get('content') or '')
        if content.endswith('.md'):
            with open(cms.cms_nodes._md_path(cms.get_context(), content), encoding='utf-8') as source:
                content = source.read()
        keys = [(key, True) for key in photos.media_references(content)]
        if item.get('coverImage'):
            cover = item['coverImage']
            keys.append((cover, cover.startswith(('http://', 'https://', '//'))))
        found = set()
        for key, is_url in keys:
            key = photos.normalize_media_reference(key) if is_url else key
            if key.startswith('photos/'):
                if key not in index:
                    if strict:
                        raise ValueError('Media is missing from gallery index; restore it before locking')
                    continue
                found.add(index[key])
        return found

    required = set().union(*(references(item, strict=True) for item in cms_store.walk([node])))
    if not required <= set(paths):
        raise ValueError('Incomplete media manifest; refresh the page before locking')
    for name in cms.JS_SYNC_MAP:
        for item in cms_store.walk(cms.fetch_module_tree(name)['root']):
            if name == module and item['id'] in selected:
                continue
            if references(item) & set(paths):
                raise ValueError('Media is shared with another public note; use a separate image before locking')


def _cover_category(row):
    """从行或路径推断分类（photos/images/<cat>/<file>）"""
    if row.get('category'):
        return row['category']
    parts = str(row.get('path') or '').split('/')
    return parts[2] if len(parts) > 3 else None


def collect_cover_rows(tree):
    """收集解密子树中所有带 coverRow 的节点行（跳过仍加密的子节点）"""
    rows = {}

    def walk(node):
        if not isinstance(node, dict) or node.get('_enc'):
            return
        for row in [node.get('coverRow'), *(node.get('mediaRows') or [])]:
            if isinstance(row, dict) and row.get('path'):
                rows[row['path']] = row
        for child in node.get('children') or []:
            walk(child)

    walk(tree)
    return list(rows.values())


# ================= 加锁 =================

def prepare_lock(paths):
    """
    把封面图迁入私有桶并校验。返回上下文供 finalize_lock 使用；无封面时返回 None。
    失败抛异常（此时未删除任何数据）
    """
    rows = album_lock.rows_by_paths(paths)
    if {row['path'] for row in rows} != set(paths):
        raise ValueError('Media is missing from gallery index')
    if not rows:
        return None
    store = album_lock._storage()
    keys = album_lock.collect_keys(rows)
    album_lock.move_to_private(store, keys, reuse_private=True)
    return {"store": store, "keys": keys,
            "public_attempts": [], "ids": [r['id'] for r in rows]}


def finalize_lock(ctx):
    """节点已加锁后：删除公开侧文件与图片行"""
    if not ctx:
        return
    from . import media_jobs
    media_jobs.cancel(ctx['keys'])
    for key in ctx['keys']:
        if key.startswith(album_lock.IMAGE_PREFIX):
            # 网络错误也可能发生在实际删除之后，因此先登记补偿键。
            ctx['public_attempts'].append(key)
            ctx['store'].delete('public', key)
    # CMS 原图也不能继续由本地静态服务公开提供。
    for key in ctx['keys']:
        storage.remove(photos.media_path(key))
    album_lock.delete_rows(ctx['ids'])
    photos.sync_gallery_js()
    print(f"  [ CMS ] 🖼️ 封面已迁入私有桶: {len(ctx['ids'])} 张")


def rollback_lock(ctx):
    """恢复已尝试删除的公开原图，私有副本保留供恢复或再次加锁。"""
    try:
        if ctx and ctx['public_attempts']:
            album_lock.rollback_to_public(ctx['store'], ctx['public_attempts'])
    finally:
        photos.rebuild_cache()
        cms.rebuild_cache()


# ================= 解锁 =================

def prepare_unlock(tree):
    """从私有桶取回封面文件（暂不写图片行）。无封面返回 None；失败抛异常（私有副本保留）"""
    rows = collect_cover_rows(tree)
    if not rows:
        return None
    store = album_lock._storage()
    keys = album_lock.collect_keys(rows)
    ctx = {"store": store, "keys": keys, "rows": rows, "public_attempts": []}
    storage.compensate(store.recovery_record('retract_public', keys), lambda: rollback_unlock(ctx))
    album_lock.restore_from_private(store, keys, public_attempts=ctx['public_attempts'])
    return ctx


def finalize_unlock(ctx):
    """节点已解锁后恢复图片行，外层事务成功后才清理私有副本。"""
    if not ctx:
        return
    for r in ctx['rows']:
        if isinstance(r.get('tags'), list):
            r['tags'] = json.dumps(r['tags'], ensure_ascii=False)
        album_lock.insert_rows([r], category=_cover_category(r), prepend=True)
    photos.sync_gallery_js()
    storage.on_commit(lambda: album_lock.purge_private(ctx['store'], ctx['keys']))
    print(f"  [ CMS ] 🖼️ 封面已恢复公开: {len(ctx['rows'])} 张")


def rollback_unlock(ctx):
    """写库解锁失败时撤回已恢复到公开侧的文件（私有副本仍在）"""
    try:
        if ctx:
            album_lock.rollback_to_private(ctx['store'], ctx['public_attempts'])
    finally:
        cms.rebuild_cache()


# ================= 删除 =================

def purge_private_keys(keys):
    """删除加密节点时清理其私有桶封面（失败仅记录日志）"""
    keys = [k for k in (keys or []) if isinstance(k, str) and k.startswith('photos/')]
    if not keys:
        return
    try:
        store = album_lock._storage()
        album_lock.purge_private(store, keys)
    except Exception as e:
        print(f"  [ CMS ] ⚠️ 私有封面清理失败: {e}")
