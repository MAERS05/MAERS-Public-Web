"""CMS 服务：JSON 与 Markdown 为真源，SQLite 仅为可重建索引。"""

from __future__ import annotations
from .contracts import JsonValue, JsonObject, Query, Response, CmsContext

import json
import os
import sqlite3
import config
from . import cms_nodes, cms_tags, cms_other_tags, cms_store, storage

PROJECT_ROOT = config.PROJECT_ROOT
DATA_DIR = config.DATA_DIR
DB_PATH = config.CMS_DB
JS_SYNC_MAP = {name: f'data/{name}-tree.json' for name in
               ('notes', 'literature', 'record', 'games', 'videos')}


def _tree_path(module):
    if module not in JS_SYNC_MAP:
        raise ValueError('Invalid CMS module')
    return os.path.join(DATA_DIR, f'{module}-tree.json')


@storage.serialized
def fetch_module_tree(module: str) -> JsonObject:
    from . import private_session
    path = _tree_path(module)
    return private_session.read(path, cms_store.load(path))


@storage.serialized
def rebuild_cache() -> None:
    trees = {module: cms_store.load(_tree_path(module)) for module in JS_SYNC_MAP}
    cms_store.rebuild(DB_PATH, trees)


def get_db():
    # 每次显式使用索引前从真源重建；业务读取不依赖缓存是否存在或有效。
    rebuild_cache()
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


@storage.serialized
def save_module_tree(module: str, tree: JsonObject) -> bool:
    storage.write_json(_tree_path(module), cms_store.validate(tree))
    try:
        rebuild_cache()
    except (OSError, sqlite3.Error, ValueError) as error:
        print(f"  [ CMS ] ⚠️ 真源已保存，缓存待重建 | Source saved; cache rebuild pending: {error}")
    return True


def get_context() -> CmsContext:
    return {'DATA_DIR': DATA_DIR, 'PROJECT_ROOT': PROJECT_ROOT,
            'load_tree': fetch_module_tree, 'save_tree': save_module_tree}


def load_json(path: str) -> JsonValue:
    target = path if os.path.isabs(path) else os.path.join(config.PROJECT_ROOT, path)
    if not os.path.exists(target):
        return None
    with open(target, encoding='utf-8') as source:
        from . import private_session
        return private_session.read(target, json.load(source))


@storage.serialized
def save_json(path: str, data: JsonValue) -> bool:
    target = path if os.path.isabs(path) else os.path.join(config.PROJECT_ROOT, path)
    storage.write_json(target, data)
    return True

# ================= 标签操作封装 (Wrapper) =================

def get_strategy(module, context):
    if module.startswith('photos-'):
        return cms_other_tags.PhotosTagStrategy(context)
    if module == 'space':
        return cms_other_tags.SpaceTagStrategy(context)
    return cms_tags.CmsTagStrategy(context)

@storage.serialized
def get_tag_categories(module):
    return get_strategy(module, get_context()).get_categories(module)

@storage.serialized
def save_tag_categories(data, module):
    return get_strategy(module, get_context()).save_categories(data, module)

@storage.transactional
def cleanup_unused_tags(module):
    strategy = get_strategy(module, get_context())
    print(f"  [ CMS ] 🔍 开始标签清理 | Starting cleanup for module: {module}")

    # 1. Collect used tags
    used_tags = strategy.cleanup_tags(module)
    print(f"  [ CMS ] 🏷️  使用中的标签数量: {len(used_tags)}")

    # 2. Get categories
    categories = strategy.get_categories(module)
    if not categories:
        print(f"  [ CMS ] ℹ️  没有标签分类")
        return {"success": True, "removed_count": 0, "removed_tags": [], "empty_categories": []}

    # 3. Cleanup logic
    removed_tags = []
    empty_categories = []
    cleaned_categories = []

    for cat in categories:
        if 'tags' not in cat or not isinstance(cat['tags'], list):
            cleaned_categories.append(cat)
            continue

        kept = [t for t in cat['tags'] if t in used_tags]
        removed = [t for t in cat['tags'] if t not in used_tags]
        removed_tags.extend(removed)

        cat['tags'] = kept
        cleaned_categories.append(cat)

    # 4. Save
    if removed_tags:
        strategy.save_categories(cleaned_categories, module)
        print(f"  [ CMS ] ✅ 清理了 {len(removed_tags)} 个标签")
    else:
        print(f"  [ CMS ] ✨ 无需清理")

    return {
        "success": True,
        "removed_count": len(removed_tags),
        "removed_tags": removed_tags,
        "empty_categories": empty_categories
    }


@storage.transactional
def rename_tag(module, old_name, new_name):
    print(f"  [ CMS ] ✎ 重命名标签 | Renaming tag (module: {module})")
    if not new_name or not new_name.strip(): return {"success": False, "error": "新标签名不能为空"}
    new_name = new_name.strip()
    if old_name == new_name: return {"success": True, "updated_count": 0}

    strategy = get_strategy(module, get_context())

    # 1. Update source
    updated_count = strategy.rename_tag(module, old_name, new_name)

    # 2. Update categories file (with deduplication)
    categories = strategy.get_categories(module)
    if categories:
        changed_cats = False
        for cat in categories:
            if 'tags' in cat and isinstance(cat['tags'], list) and old_name in cat['tags']:
                # Replace old_name with new_name, then deduplicate while preserving order
                renamed = [new_name if t == old_name else t for t in cat['tags']]
                seen = set()
                deduped = []
                for t in renamed:
                    if t not in seen:
                        seen.add(t)
                        deduped.append(t)
                cat['tags'] = deduped
                changed_cats = True

        if changed_cats:
            strategy.save_categories(categories, module)
            print(f"  [ CMS ] ✅ 标签分类文件已更新")

    print(f"  [ CMS ] ✅ 标签重命名完成")
    return {"success": True, "updated_count": updated_count}



@storage.transactional
def delete_tag(module, tag_name):
    print(f"  [ CMS ] ✕ 删除标签 | Deleting tag (module: {module})")

    strategy = get_strategy(module, get_context())

    # 1. Remove from source
    updated_count = strategy.delete_tag(module, tag_name)

    # 2. Remove from categories
    categories = strategy.get_categories(module)
    if categories:
        changed_cats = False
        for cat in categories:
            if 'tags' in cat and isinstance(cat['tags'], list) and tag_name in cat['tags']:
                cat['tags'] = [t for t in cat['tags'] if t != tag_name]
                changed_cats = True

        if changed_cats:
            strategy.save_categories(categories, module)
            print(f"  [ CMS ] ✅ 标签分类文件已更新")

    print(f"  [ CMS ] ✅ 标签删除完成")
    return {"success": True, "updated_count": updated_count}


@storage.serialized
def update_node_tags(module, node_id, tags):
    return cms_nodes.update_node_tags(module, node_id, tags, get_context())

# ================= CMS 节点动作表 =================


@storage.transactional
def _lock(module, body, context):
    from . import cms_covers, photos
    cms_nodes.verify_lock_sources(module, body['id'], body['sources'], context)
    photos.rebuild_cache()
    cms_covers.validate_lock_media(module, body['id'], body.get('covers') or [])
    covers = cms_covers.prepare_lock(body.get('covers') or [])
    if covers:
        storage.compensate(covers['store'].recovery_record('restore_public', covers['keys']),
                           lambda: cms_covers.rollback_lock(covers))
    changed = cms_nodes.lock_node(module, body['id'], body['enc'], context)
    if changed:
        cms_covers.finalize_lock(covers)
    return changed


@storage.transactional
def _unlock(module, body, context):
    from . import cms_covers, photos, private_session
    # 取消对外加密以磁盘密文为准，不能把后台可编辑视图当作已公开记录。
    with private_session.context(False):
        photos.rebuild_cache()
        covers = cms_covers.prepare_unlock(body['tree'])
        changed = cms_nodes.unlock_node(module, body['id'], body['tree'], context)
        if changed:
            cms_covers.finalize_unlock(covers)
        return changed


def _delete(module, body, context):
    changed = cms_nodes.delete_node(module, body['id'], context)
    if changed and body.get('purge_private'):
        from . import cms_covers
        cms_covers.purge_private_keys(body['purge_private'])
    return changed


def _protect(module, body, context):
    from . import private_cms
    return private_cms.protect(module, body['id'])


NODE_ACTIONS = {
    'add': ({'parentId': str, 'type': str, 'title': str},
            lambda m, b, c: cms_nodes.add_node(m, b['parentId'], b['type'], b['title'], c, node_id=b.get('id'))),
    'update': ({'id': str, 'data': dict}, lambda m, b, c: cms_nodes.update_node(m, b['id'], b['data'], c)),
    'delete': ({'id': str}, _delete),
    'move': ({'id': str, 'targetParentId': str}, lambda m, b, c: cms_nodes.move_node(m, b['id'], b['targetParentId'], c)),
    'reorder': ({'ids': list}, lambda m, b, c: cms_nodes.reorder_nodes(m, b['ids'], c)),
    'open_external': ({'id': str}, lambda m, b, c: cms_nodes.open_external_node(m, b['id'], c)),
    'lock': ({'id': str, 'enc': str, 'sources': list}, _lock),
    'protect': ({'id': str}, _protect),
    'unlock': ({'id': str, 'tree': dict}, _unlock),
}


@storage.serialized
def handle_request(path: str, method: str, query_params: Query, body_data: JsonObject) -> Response:
    from . import validation
    module = query_params.get('module', ['notes'])[0]
    if module not in JS_SYNC_MAP:
        raise ValueError('Invalid module')
    if path != '/api/cms/node' or method != 'POST':
        return 404, {'error': 'Not found'}
    action = query_params.get('action', [''])[0]
    if action not in NODE_ACTIONS:
        raise ValueError('Unknown action')
    schema, function = NODE_ACTIONS[action]
    validation.fields(**schema)(body_data)
    if action == 'reorder':
        validation.strings(body_data['ids'])
    if 'purge_private' in body_data:
        validation.strings(body_data['purge_private'])
    if 'covers' in body_data:
        validation.strings(body_data['covers'])
    changed = function(module, body_data, get_context())
    return (200, {'status': 'success'}) if changed else (400, {'error': 'No changes made'})
