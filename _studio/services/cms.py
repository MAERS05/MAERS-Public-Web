import os
import json
import sqlite3
import time
import shutil

# Import new modules
from . import cms_nodes
from . import cms_tags
from . import cms_other_tags

# ================= 配置 =================

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SERVICE_DIR) # _studio/
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')
DB_PATH = os.path.join(DATA_DIR, 'cms.db')


# JS 同步映射
JS_SYNC_MAP = {
    'notes': 'data/notes-tree.json',
    'literature': 'data/literature-tree.json',
    'record': 'data/record-tree.json',
    'games': 'data/games-tree.json',
    'videos': 'data/videos-tree.json'
}

# ================= 数据库操作 / 基础设施 =================

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def get_context():
    """依赖注入上下文"""
    return {
        'get_db': get_db,
        'DATA_DIR': DATA_DIR,
        'PROJECT_ROOT': PROJECT_ROOT,
        'sync_js_file': sync_js_file
    }

def fetch_module_tree(module):
    """从数据库构建树状结构"""
    conn = get_db()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM nodes WHERE module=? ORDER BY sort_order ASC", (module,))
    rows = cursor.fetchall()
    conn.close()

    if not rows:
        return {"root": []}

    # 构建 ID -> Node 映射
    nodes_map = {}
    root_nodes = []

    # 第一次遍历：创建所有节点对象
    for row in rows:
        node = {
            "id": row['id'],
            "type": row['type'],
            "title": row['title'],
            "tags": json.loads(row['tags']) if row['tags'] else [],
            "content": row['content'], 
            "coverImage": row['coverImage'] if 'coverImage' in row.keys() else None,
            "children": [] if row['type'] == 'folder' else None
        }
        nodes_map[row['id']] = { "data": node, "parent_id": row['parent_id'] }

    # 第二次遍历：构建树
    for node_id, item in nodes_map.items():
        node = item['data']
        parent_id = item['parent_id']

        if str(parent_id) == 'root' or parent_id is None:
            root_nodes.append(node)
        elif parent_id in nodes_map:
            parent_node = nodes_map[parent_id]['data']
            if parent_node['children'] is not None:
                parent_node['children'].append(node)
        else:
            root_nodes.append(node) 

    return {"root": root_nodes}

def sync_js_file(module):
    """生成静态 JSON 文件供前端读取"""
    js_rel_path = JS_SYNC_MAP.get(module)
    if not js_rel_path: return

    data = fetch_module_tree(module)
    js_path = os.path.join(PROJECT_ROOT, js_rel_path)
    
    try:
        # Atomic write
        temp_path = js_path + '.tmp'
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        if os.path.exists(js_path):
            os.remove(js_path)
        os.rename(temp_path, js_path)
        
        print(f"  [ CMS ] 📂 同步完成 | Sync complete: {js_rel_path}")
    except Exception as e:
        print(f"  [ CMS ] ❌ 同步失败 | Sync failed: {e}")
        if os.path.exists(temp_path):
            try: os.remove(temp_path)
            except: pass

def load_json(path, fallback_path=None):
    """【兼容性保留】供 server.py 中非 CMS 模块 (如 modules.json) 使用"""
    if path in JS_SYNC_MAP or (fallback_path and fallback_path in JS_SYNC_MAP):
        return {"root": []} 
        
    target = path if os.path.exists(path) else fallback_path
    if not target or not os.path.exists(target): return [] if 'modules.json' in str(path) else {}
    try:
        with open(target, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        # Fallback: Try to parse as JS assignment
        try:
            with open(target, 'r', encoding='utf-8') as f:
                content = f.read()
                start = content.find('[')
                end = content.rfind(']')
                if start != -1 and end != -1:
                    return json.loads(content[start:end+1])
        except:
            pass
        return []

def save_json(filepath, data, js_path=None, var_name=None):
    """【兼容性保留】供 server.py 中非 CMS 模块使用"""
    try:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        if js_path and var_name:
            js_full_path = os.path.join(PROJECT_ROOT, js_path) if not os.path.isabs(js_path) else js_path
            os.makedirs(os.path.dirname(js_full_path), exist_ok=True)
            js_content = f"window.{var_name} = {json.dumps(data, ensure_ascii=False, indent=2)};\n"
            with open(js_full_path, 'w', encoding='utf-8') as f:
                f.write(js_content)
            print(f"  [ CMS ] ✅ 静态 JS 已同步 | Static JS synced: {js_path}")
        
        print(f"  [ CMS ] 💾 配置已保存 | Config saved: {os.path.basename(filepath)}")
        return True
    except Exception as e:
        print(f"  [ CMS ] ❌ 保存失败 | Save failed: {e}")
        return False

# ================= 标签操作封装 (Wrapper) =================

def get_strategy(module, context):
    if module.startswith('photos-'):
        return cms_other_tags.PhotosTagStrategy(context)
    if module == 'space':
        return cms_other_tags.SpaceTagStrategy(context)
    return cms_tags.CmsTagStrategy(context)

def get_tag_categories(module):
    return get_strategy(module, get_context()).get_categories(module)

def save_tag_categories(data, module):
    return get_strategy(module, get_context()).save_categories(data, module)

def cleanup_unused_tags(module):
    # Logic reuse from cms_tags strategy but needs handling here because it was a standalone function?
    # Actually we should move the coordinator logic here or in Strategy?
    # In previous cms_tags.py we had `cleanup_unused_tags` as a module function calling strategy.
    # Let's implement the coordinator here to avoid duplication in both files.
    
    strategy = get_strategy(module, get_context())
    try:
        print(f"  [ CMS ] 🔍 开始标签清理 | Starting cleanup for module: {module}")
        
        # 1. Collect used tags
        used_tags = strategy.cleanup_tags(module)
        print(f"  [ CMS ] 🏷️  使用中的标签: {sorted(used_tags)}")
        
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
            print(f"  [ CMS ] ✅ 清理了 {len(removed_tags)} 个标签: {removed_tags}")
        else:
            print(f"  [ CMS ] ✨ 无需清理")
        
        return {
            "success": True,
            "removed_count": len(removed_tags),
            "removed_tags": removed_tags,
            "empty_categories": empty_categories
        }
    except Exception as e:
        print(f"  [ CMS ] ❌ 标签清理失败: {e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(e)}

def rename_tag(module, old_name, new_name):
    try:
        print(f"  [ CMS ] ✎ 重命名标签 | Renaming tag: {old_name} → {new_name} (module: {module})")
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

    except Exception as e:
        print(f"  [ CMS ] ❌ 标签重命名失败: {e}")
        return {"success": False, "error": str(e)}

def delete_tag(module, tag_name):
    try:
        print(f"  [ CMS ] ✕ 删除标签 | Deleting tag: {tag_name} (module: {module})")
        
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
    except Exception as e:
        print(f"  [ CMS ] ❌ 标签删除失败: {e}")
        return {"success": False, "error": str(e)}


def update_node_tags(module, node_id, tags):
    return cms_nodes.update_node_tags(module, node_id, tags, get_context())

# ================= 入口分发 =================

def handle_request(path, method, query_params, body_data):
    try:
        # Tag APIs (Before Module Validation)
        if method == 'GET' and path.endswith('/get_categories'):
            module = query_params.get('module', ['cms'])[0]
            return 200, get_tag_categories(module)

        if method == 'POST' and path.endswith('/save_categories'):
            module = query_params.get('module', ['cms'])[0]
            success = save_tag_categories(body_data, module)
            return 200, {"status": "success" if success else "error"}

        # Node APIs Validation
        module = query_params.get('module', ['notes'])[0]
        if module not in JS_SYNC_MAP: return 400, {"error": f"Invalid module: {module}"}

        if method == 'GET' and path.endswith('/fetch'):
            return 200, fetch_module_tree(module)

        if method == 'POST' and path.endswith('/node'):
            action = query_params.get('action', [''])[0]
            context = get_context()
            
            changed = False
            try:
                if action == 'move':
                    changed = cms_nodes.move_node(module, body_data.get('id'), body_data.get('targetParentId'), context)
                elif action == 'add':
                    changed = cms_nodes.add_node(module, body_data.get('parentId'), body_data.get('type'), body_data.get('title'), context)
                elif action == 'delete':
                    changed = cms_nodes.delete_node(module, body_data.get('id'), context)
                elif action == 'update':
                    changed = cms_nodes.update_node(module, body_data.get('id'), body_data.get('data'), context)
                elif action == 'reorder':
                    changed = cms_nodes.reorder_nodes(module, body_data.get('ids', []), context)
                else:
                    return 400, {"error": "Unknown action"}
            except ValueError as ve:
                print(f"❌ Logic Error: {ve}")
                return 400, {"error": str(ve)}
            except Exception as e:
                print(f"❌ Operation Error: {e}")
                import traceback
                traceback.print_exc()
                return 500, {"error": str(e)}

            if changed:
                return 200, {"status": "success"}
            return 400, {"error": "No changes made"}

        return 404, {"error": "Not found"}

    except Exception as e:
        import traceback
        traceback.print_exc()
        return 500, {"error": str(e)}
