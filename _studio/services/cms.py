import os
import json
import sqlite3
import time
import time
import re
import shutil

# ================= 配置 =================

# Update BASE_DIR: logic was os.path.dirname(os.path.abspath(__file__)) which pointed to _studio/
# Now file is in _studio/services/, so we need to go up one level to be at _studio/
# CMS_CORE logic:
# BASE_DIR = _studio/
# PROJECT_ROOT = parent of _studio/
# DATA_DIR = PROJECT_ROOT/data

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SERVICE_DIR) # _studio/
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')
DB_PATH = os.path.join(DATA_DIR, 'cms.db')


# JS 同步映射 (Now generating JSON files)
JS_SYNC_MAP = {
    'notes': 'data/notes-tree.json',
    'literature': 'data/literature-tree.json',
    'record': 'data/record-tree.json',
    'games': 'data/games-tree.json'
}

# ================= 数据库操作 =================

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def fetch_module_tree(module):
    """从数据库构建树状结构"""
    conn = get_db()
    cursor = conn.cursor()
    
    # 获取该模块所有节点，按 sort_order 倒序排列 (前端通常是新在后，或者由JS控制，这里保持插入顺序)
    # 修正: 前端原本是 list.insert(0)，也就是新项目在最前。
    # 所以 sort_order 应该正序还是倒序？
    # 原有的 list.insert(0) 意味着列表索引 0 是最新。
    # 我们在 migration 时用了 enumerate index，index 0 是第一个元素。
    # 如果要保持一致性，我们按 sort_order ASC 排序即可。
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
            "tags": json.loads(row['tags']) if row['tags'] else [],
            # Content is now a file path (or empty if legacy/migrated)
            # Frontend will load this path.
            "content": row['content'], 
            "coverImage": row['coverImage'] if 'coverImage' in row.keys() else None,
            "children": [] if row['type'] == 'folder' else None
        }
        nodes_map[row['id']] = { "data": node, "parent_id": row['parent_id'] }

    # 第二次遍历：构建树
    for node_id, item in nodes_map.items():
        node = item['data']
        parent_id = item['parent_id']

    # 第二次遍历：构建树
    for node_id, item in nodes_map.items():
        node = item['data']
        parent_id = item['parent_id']

        # Fix: Ensure parent_id is treated as string for comparison if DB returns int
        if str(parent_id) == 'root' or parent_id is None:
            root_nodes.append(node)
        elif parent_id in nodes_map:
            parent_node = nodes_map[parent_id]['data']
            if parent_node['children'] is not None:
                parent_node['children'].append(node)
        else:
            # 孤儿节点 (父节点找不到)，挂在根目录
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

# ================= 业务动作 (SQL) =================

def _action_add(module, parent_id, node_type, title):
    conn = get_db()
    cursor = conn.cursor()
    
    new_id = f"{node_type[0]}_{int(time.time()*1000)}"
    created_at = time.time()
    
    # 新节点通常插入在最前面 (sort_order = -1 或重排)
    # 简单策略：获取当前最小 sort_order - 1
    cursor.execute("SELECT MIN(sort_order) FROM nodes WHERE module=? AND parent_id=?", (module, parent_id))
    min_order = cursor.fetchone()[0]
    new_order = (min_order if min_order is not None else 0) - 1

    cursor.execute('''
        INSERT INTO nodes (id, module, parent_id, type, title, content, tags, created_at, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (new_id, module, parent_id, node_type, title, "", "[]", created_at, new_order))
    
    # Create empty MD file
    if node_type == 'note':
        try:
            safe_title = sanitize_filename(title)
            filename = f"{safe_title}.md"
            file_dir = os.path.join(DATA_DIR, module)
            if not os.path.exists(file_dir): os.makedirs(file_dir)
            
            # Handle duplicates
            counter = 1
            base_name = safe_title
            while os.path.exists(os.path.join(file_dir, filename)):
                filename = f"{base_name} ({counter}).md"
                counter += 1
                
            filepath = os.path.join(file_dir, filename)
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write("")
                
            # Update DB with relative path
            rel_path = f"{module}/{filename}"
            cursor.execute("UPDATE nodes SET content=? WHERE id=?", (rel_path, new_id))
        except Exception as e:
            print(f"  [ CMS ] ⚠️ Failed to create MD file: {e}")

    conn.commit()
    conn.close()
    print(f"  [ CMS ] 🆕 节点已添加 | Node added: {title} ({module})")
    return True

def sanitize_filename(title):
    # Remove invalid chars
    return re.sub(r'[\\/*?:"<>|]', "", title).strip() or "Untitled"

def _action_delete(module, node_id):
    conn = get_db()
    cursor = conn.cursor()
    
    # 级联删除 (简单的递归删除 children)
    # SQLite 如果没有开启 FK cascade，需要手动查 children
    # 这里简单处理：查出所有子孙节点 ID 并删除
    
    # 1. 找到所有子节点 ID (递归)
    ids_to_delete = [node_id]
    
    # 递归查找所有后代节点
    # 采用简单的 BFS/循环查找方法：反复查找 parent_id 在 ids_to_delete 中的节点
    while True:
        placeholders = ','.join('?' for _ in ids_to_delete)
        cursor.execute(f"SELECT id FROM nodes WHERE parent_id IN ({placeholders}) AND id NOT IN ({placeholders})", ids_to_delete + ids_to_delete)
        children = [r[0] for r in cursor.fetchall()]
        if not children:
            break
        ids_to_delete.extend(children)

    # 2. Delete cover images for all nodes before deleting the nodes
    # Import photos module for cover deletion
    from . import photos
    
    for del_id in ids_to_delete:
        cursor.execute("SELECT coverImage FROM nodes WHERE id=?", (del_id,))
        row = cursor.fetchone()
        if row and row['coverImage']:
            cover_path = row['coverImage']
            print(f"  [ CMS ] 🗑️  正在删除封面图 | Deleting cover image for node {del_id}: {cover_path}")
            try:
                # Reuse existing logic that handles thumbs/previews/DB
                photos.handle_delete({'path': cover_path})
            except Exception as e:
                print(f"  [ CMS ] ⚠️  封面图删除失败 | Failed to delete cover {cover_path}: {e}")
                # Continue with node deletion even if cover deletion fails

    # 2. 执行删除
    # 3. Delete MD files for all nodes
    for del_id in ids_to_delete:
        cursor.execute("SELECT content FROM nodes WHERE id=?", (del_id,))
        row = cursor.fetchone()
        if row and row['content'] and str(row['content']).endswith('.md'):
            md_path = os.path.join(PROJECT_ROOT, 'data', row['content'])
            if os.path.exists(md_path):
                try:
                    os.remove(md_path)
                    print(f"  [ CMS ] 🗑️  Deleted MD file: {md_path}")
                except Exception as e:
                    print(f"  [ CMS ] ⚠️ Failed to delete MD file: {e}")

    placeholders = ','.join('?' for _ in ids_to_delete)
    cursor.execute(f"DELETE FROM nodes WHERE id IN ({placeholders})", ids_to_delete)
    
    conn.commit()
    conn.close()
    print(f"  [ CMS ] 🗑️  节点及子树已删除 | Node & sub-tree deleted: {node_id}")
    return True

def _action_update(module, node_id, update_data):
    conn = get_db()
    cursor = conn.cursor()
    
    allowed_fields = {'title', 'content', 'tags', 'coverImage'}
    updates = []
    params = []
    
    from . import photos # Lazy import to avoid potential circular dependency issues

    for k, v in update_data.items():
        if k in allowed_fields:
            if k == 'tags': v = json.dumps(v, ensure_ascii=False)
            
            # Special Logic: Use Photos Module for Cover Deletion
            if k == 'coverImage' and v is None:
                # 1. Fetch old value
                cursor.execute("SELECT coverImage FROM nodes WHERE id=?", (node_id,))
                row = cursor.fetchone()
                if row and row['coverImage']:
                    old_path = row['coverImage']
                    print(f"  [ CMS ] 🗑️  正在清理旧封面 | Purging old cover: {old_path}")
                    # Reuse existing logic that handles thumbs/previews/DB
                    photos.handle_delete({'path': old_path})

            # Handle Title Rename (Rename File)
            if k == 'title':
                cursor.execute("SELECT content, title FROM nodes WHERE id=?", (node_id,))
                row = cursor.fetchone()
                
                # Only rename if title actually changed (and content path exists)
                if row and row['title'] != v and row['content'] and str(row['content']).endswith('.md'):
                    old_rel_path = row['content']
                    old_full_path = os.path.join(PROJECT_ROOT, 'data', old_rel_path)
                    
                    if os.path.exists(old_full_path):
                        # Construct new filename
                        new_safe_title = sanitize_filename(v)
                        new_filename = f"{new_safe_title}.md"
                        # Keep same module dir
                        module_dir = os.path.dirname(old_full_path)
                        new_full_path = os.path.join(module_dir, new_filename)
                        
                        # Handle collision
                        # Normalize for comparison (Windows issue: / vs \)
                        norm_new = os.path.normpath(new_full_path)
                        norm_old = os.path.normpath(old_full_path)
                        
                        counter = 1
                        base_name = new_safe_title
                        
                        # Check existance AND if it's a different file path string
                        while os.path.exists(new_full_path) and norm_new.lower() != norm_old.lower():
                             new_filename = f"{base_name} ({counter}).md"
                             new_full_path = os.path.join(module_dir, new_filename)
                             norm_new = os.path.normpath(new_full_path)
                             counter += 1
                        
                        try:
                            # Only rename if paths differ
                            if norm_new.lower() != norm_old.lower():
                                os.rename(old_full_path, new_full_path)
                                # Update content path in DB
                                new_rel_path = f"{module}/{new_filename}" 
                                cursor.execute("UPDATE nodes SET content=? WHERE id=?", (new_rel_path, node_id))
                                print(f"  [ CMS ] 📛 Renamed file: {old_rel_path} -> {new_rel_path}")
                        except Exception as e:
                            print(f"  [ CMS ] ⚠️ Failed to rename file: {e}")

            updates.append(f"{k}=?")
            params.append(v)
            
    # Handle Content Update (Write to File)
    # If 'content' is in update_data, it means we have new text body.
    # We should NOT update the 'content' column in DB with this text (it holds the path).
    # We should Write to file. 
    # BUT, the loop above added 'content=?' to updates! We must remove it or handle it.
    
    # Correct approach: Filter out 'content' from SQL updates, handle it manually.
    final_updates = []
    final_params = []
    
    content_to_write = None
    
    # Re-process updates to separate SQL columns and File writes
    # (Since we already built updates list, let's just rebuild it safely)
    
    # Reset
    updates = []
    params = []
    
    for k, v in update_data.items():
        if k == 'content':
            content_to_write = v
            continue # Don't add to SQL
            
        if k in allowed_fields:
            if k == 'tags': v = json.dumps(v, ensure_ascii=False)
            updates.append(f"{k}=?")
            params.append(v)

    if content_to_write is not None:
        # Get current file path
        cursor.execute("SELECT content FROM nodes WHERE id=?", (node_id,))
        row = cursor.fetchone()
        if row and row['content'] and str(row['content']).endswith('.md'):
             md_path = os.path.join(PROJECT_ROOT, 'data', row['content'])
             try:
                 with open(md_path, 'w', encoding='utf-8') as f:
                     f.write(content_to_write)
                 print(f"  [ CMS ] 📝 Content written to {md_path}")
             except Exception as e:
                 print(f"  [ CMS ] ❌ Failed to write content: {e}")
        else:
            # If no file exists (legacy node?), create one?
            # Creating one now based on title
            # (Omitting for brevity, assuming migration ran)
            pass

    if updates:
        params.append(node_id)
        sql = f"UPDATE nodes SET {', '.join(updates)} WHERE id=?"
        cursor.execute(sql, params)
        conn.commit()
        print(f"  [ CMS ] ✎  节点已更新 | Node updated: {node_id}")
        
    conn.close()
    return True

def _action_reorder(module, ids):
    if not ids: return True
    conn = get_db()
    cursor = conn.cursor()
    try:
        for idx, node_id in enumerate(ids):
            cursor.execute("UPDATE nodes SET sort_order=? WHERE id=?", (idx, node_id))
        conn.commit()
    except:
        conn.rollback()
        raise
    finally:
        conn.close()
    print(f"  [ CMS ] ↕️  节点重排序完成 | Nodes reordered ({module})")
    return True

def _action_move(module, node_id, target_parent_id):
    # 防止循环引用
    # 1. 检查 target_parent_id 是否是 node_id 的子孙
    if node_id == target_parent_id:
        raise ValueError("Cannot move node into itself")
        
    conn = get_db()
    cursor = conn.cursor()
    
    # 检查 target_parent_id 是否在 node_id 的子树中
    # 同样使用简单的 BFS/DFS 检查
    if target_parent_id != 'root':
        parent_chain = []
        curr = target_parent_id
        while curr != 'root' and curr is not None:
            if curr == node_id:
                conn.close()
                raise ValueError("Circular reference")
            cursor.execute("SELECT parent_id FROM nodes WHERE id=?", (curr,))
            res = cursor.fetchone()
            curr = res[0] if res else None

    # 执行移动
    # 也是插入到最前面
    cursor.execute("SELECT MAX(sort_order) FROM nodes WHERE module=? AND parent_id=?", (module, target_parent_id))
    max_order = cursor.fetchone()[0]
    new_order = (max_order if max_order is not None else 0) + 1

    cursor.execute("UPDATE nodes SET parent_id=?, sort_order=? WHERE id=?", (target_parent_id, new_order, node_id))
    
    conn.commit()
    conn.close()
    print(f"  [ CMS ] 🚚 节点已跨级移动 | Node moved: {node_id} -> {target_parent_id}")
    return True

def update_node_tags(module, node_id, tags):
    """Granular tag update - only updates tags field without full tree regeneration"""
    conn = get_db()
    cursor = conn.cursor()
    
    try:
        tags_json = json.dumps(tags, ensure_ascii=False)
        cursor.execute("UPDATE nodes SET tags=? WHERE id=? AND module=?", (tags_json, node_id, module))
        
        if cursor.rowcount == 0:
            conn.close()
            return False
            
        conn.commit()
        conn.close()
        
        # Still sync the JS file for frontend consistency
        sync_js_file(module)
        
        print(f"  [ CMS ] 🏷️  Tags Updated: {node_id} -> {tags}")
        return True
    except Exception as e:
        print(f"  [ CMS ] ❌ Tag update failed: {e}")
        conn.close()
        return False

# ================= 总入口 =================

def load_json(path, fallback_path=None):
    """【兼容性保留】供 server.py 中非 CMS 模块 (如 modules.json) 使用"""
    # 如果路径是 JS_SYNC_MAP 中的，说明是旧代码在调用，直接忽略或报错
    # 但 server.py 里只用它读 modules.json 和 config
    # 只要不是那三个 tree.json 即可
    if path in JS_SYNC_MAP or (fallback_path and fallback_path in JS_SYNC_MAP):
        return {"root": []} # 应该走 DB
        
    # 原有的文件读取逻辑
    target = path if os.path.exists(path) else fallback_path
    if not target or not os.path.exists(target): return [] if 'modules.json' in str(path) else {}
    try:
        with open(target, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        # Fallback: Try to parse as JS assignment (e.g. window.CONF = [...])
        try:
            with open(target, 'r', encoding='utf-8') as f:
                content = f.read()
                # Find the first '[' and the last ']'
                start = content.find('[')
                end = content.rfind(']')
                if start != -1 and end != -1:
                    import json
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
        
        # 如果提供了 js_path，同步生成 JS 文件供前端读取
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

def handle_request(path, method, query_params, body_data):
    try:
        module = query_params.get('module', ['notes'])[0]
        # 兼容旧逻辑映射，虽然已经不用 file map 了
        if module not in JS_SYNC_MAP: return 400, {"error": "Invalid module"}

        if method == 'GET' and path.endswith('/fetch'):
            return 200, fetch_module_tree(module)

        # Tag APIs (New)
        if method == 'GET' and path.endswith('/get_categories'):
            module = query_params.get('module', ['cms'])[0]
            return 200, get_tag_categories(module)

        if method == 'POST' and path.endswith('/save_categories'):
            module = query_params.get('module', ['cms'])[0]
            # body_data is the array of categories
            success = save_tag_categories(body_data, module)
            return 200, {"status": "success" if success else "error"}

        if method == 'POST' and path.endswith('/node'):
            action = query_params.get('action', [''])[0]
            
            changed = False
            try:
                if action == 'move':
                    changed = _action_move(module, body_data.get('id'), body_data.get('targetParentId'))
                elif action == 'add':
                    changed = _action_add(module, body_data.get('parentId'), body_data.get('type'), body_data.get('title'))
                elif action == 'delete':
                    changed = _action_delete(module, body_data.get('id'))
                elif action == 'update':
                    changed = _action_update(module, body_data.get('id'), body_data.get('data'))
                elif action == 'reorder':
                    changed = _action_reorder(module, body_data.get('ids', []))
                else:
                    return 400, {"error": "Unknown action"}
            except ValueError as ve:
                print(f"❌ Logic Error: {ve}")
                return 400, {"error": str(ve)}

            if changed:
                # 每次修改后，重新生成静态 JS 文件供前端读取
                sync_js_file(module)
                return 200, {"status": "success"}
            return 400, {"error": "No changes made"}

        return 404, {"error": "Not found"}

    except Exception as e:
        import traceback
        traceback.print_exc()
        return 500, {"error": str(e)}
# ================= 标签操作 =================

def _get_tags_file(module):
    """根据模块返回对应的标签分类文件路径"""
    tags_dir = os.path.join(DATA_DIR, 'tags')
    if not os.path.exists(tags_dir):
        os.makedirs(tags_dir)
        
    target_module = module if module else 'cms'
    
    if target_module == 'cms':
        return os.path.join(tags_dir, 'cms-tag-categories.json')

    # 1. 优先逻辑：Photos 和 Space 模块统一使用不带 cms- 前缀的文件名
    # 以保持与 album.py 等模块创建的资源一致
    if target_module.startswith('photos-') or target_module == 'space':
        return os.path.join(tags_dir, f'{target_module}-tag-categories.json')
        
    # 2. 传统 CMS 模块 (notes, literature, etc.) 默认使用 cms- 前缀
    return os.path.join(tags_dir, f'cms-{target_module}-tag-categories.json')

def get_tag_categories(module='cms'):
    """读取标签分类配置"""
    filepath = _get_tags_file(module)
    if not os.path.exists(filepath):
        return []
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"Error reading tag categories for {module}: {e}")
        return []

def save_tag_categories(data, module='cms'):
    """保存标签分类配置"""
    try:
        filepath = _get_tags_file(module)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        print(f"Error saving tag categories for {module}: {e}")
        return False

def cleanup_unused_tags(module):
    """清理未使用的标签 - 手动触发
    
    支持三种数据源：
    - Photos 模块 (photos-*): gallery.db → photos 表
    - Space 模块: space-tree.json
    - CMS 模块: cms.db → nodes 表
    """
    try:
        print(f"  [ CMS ] 🔍 开始标签清理 | Starting cleanup for module: {module}")
        used_tags = set()
        
        # ======== 1. 收集正在使用的标签 ========
        
        if module.startswith('photos-'):
            # Photos: gallery.db (不是 cms.db!)
            category = module.replace('photos-', '')
            gallery_db_path = os.path.join(DATA_DIR, 'gallery.db')
            print(f"  [ CMS ] 📸 连接 gallery.db, category={category}")
            
            if not os.path.exists(gallery_db_path):
                print(f"  [ CMS ] ❌ gallery.db 不存在!")
                return {"success": False, "error": "gallery.db not found"}
            
            conn = sqlite3.connect(gallery_db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("SELECT tags FROM photos WHERE category=?", (category,))
            rows = cursor.fetchall()
            conn.close()
            
            for row in rows:
                if row['tags']:
                    used_tags.update(json.loads(row['tags']))
            
            print(f"  [ CMS ] 📊 {len(rows)} 张图片, {len(used_tags)} 个标签在使用")
        
        elif module == 'space':
            # Space: space-tree.json
            space_path = os.path.join(PROJECT_ROOT, 'data', 'space-tree.json')
            print(f"  [ CMS ] 🌐 读取 space-tree.json")
            
            if not os.path.exists(space_path):
                print(f"  [ CMS ] ❌ space-tree.json 不存在!")
                return {"success": False, "error": "space-tree.json not found"}
            
            with open(space_path, 'r', encoding='utf-8') as f:
                space_data = json.load(f)
            
            def collect_space_tags(nodes):
                for node in nodes:
                    if node.get('tags'):
                        used_tags.update(node['tags'])
                    if node.get('children'):
                        collect_space_tags(node['children'])
            
            collect_space_tags(space_data.get('root', []))
            print(f"  [ CMS ] 📊 {len(used_tags)} 个标签在使用")
        
        else:
            # CMS: cms.db → nodes 表
            print(f"  [ CMS ] 📝 查询 cms.db, module={module}")
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute("SELECT tags FROM nodes WHERE module=?", (module,))
            rows = cursor.fetchall()
            conn.close()
            
            for row in rows:
                if row['tags']:
                    used_tags.update(json.loads(row['tags']))
            
            print(f"  [ CMS ] 📊 {len(rows)} 个节点, {len(used_tags)} 个标签在使用")
        
        print(f"  [ CMS ] 🏷️  使用中的标签: {sorted(used_tags)}")
        
        # ======== 2. 获取标签分类 ========
        categories = get_tag_categories(module)
        if not categories:
            print(f"  [ CMS ] ℹ️  没有标签分类")
            return {"success": True, "removed_count": 0, "removed_tags": [], "empty_categories": []}
        
        # ======== 3. 清理 ========
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
        
        # ======== 4. 保存 ========
        if removed_tags:
            save_tag_categories(cleaned_categories, module)
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
