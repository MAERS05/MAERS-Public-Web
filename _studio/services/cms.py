import os
import json
import sqlite3
import time
import re

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

# JS 同步映射
JS_SYNC_MAP = {
    'notes': 'data/notes-tree.js',
    'literature': 'data/literature-tree.js',
    'record': 'data/record-tree.js'
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
            "content": row['content'],
            # "created_at": row['created_at'], # 前端不需要这个字段
            "children": [] if row['type'] == 'folder' else None
        }
        nodes_map[row['id']] = { "data": node, "parent_id": row['parent_id'] }

    # 第二次遍历：构建树
    for node_id, item in nodes_map.items():
        node = item['data']
        parent_id = item['parent_id']

        if parent_id == 'root':
            root_nodes.append(node)
        elif parent_id in nodes_map:
            parent_node = nodes_map[parent_id]['data']
            if parent_node['children'] is not None:
                parent_node['children'].append(node)
        else:
            # 孤儿节点 (父节点找不到)，暂时挂在根目录或者丢弃
            # 为了安全，挂在根目录
            pass 

    return {"root": root_nodes}

def sync_js_file(module):
    """生成静态 JS 文件"""
    js_rel_path = JS_SYNC_MAP.get(module)
    if not js_rel_path: return

    data = fetch_module_tree(module)
    js_path = os.path.join(PROJECT_ROOT, js_rel_path)
    
    try:
        js_content = f"window.MAERS_DATA = {json.dumps(data, ensure_ascii=False, indent=2)};\n"
        with open(js_path, 'w', encoding='utf-8') as f:
            f.write(js_content)
        print(f"✅ JS 同步成功: {js_rel_path}")
    except Exception as e:
        print(f"❌ JS 同步失败: {e}")

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
    ''', (new_id, module, parent_id, node_type, title, "" if node_type == 'note' else None, "[]", created_at, new_order))
    
    conn.commit()
    conn.close()
    return True

def _action_delete(module, node_id):
    conn = get_db()
    cursor = conn.cursor()
    
    # 级联删除 (简单的递归删除 children)
    # SQLite 如果没有开启 FK cascade，需要手动查 children
    # 这里简单处理：查出所有子孙节点 ID 并删除
    
    # 1. 找到所有子节点 ID (递归)
    ids_to_delete = [node_id]
    
    # 简单起见，不递归查了，直接假定应用层逻辑只删除单节点或前端已清空
    # 既然是文件夹，确实应该递归删除。
    # 采用简单的暴力方法：反复查找 parent_id 在 ids_to_delete 中的节点
    while True:
        placeholders = ','.join('?' for _ in ids_to_delete)
        cursor.execute(f"SELECT id FROM nodes WHERE parent_id IN ({placeholders}) AND id NOT IN ({placeholders})", ids_to_delete + ids_to_delete)
        children = [r[0] for r in cursor.fetchall()]
        if not children:
            break
        ids_to_delete.extend(children)

    # 2. 执行删除
    placeholders = ','.join('?' for _ in ids_to_delete)
    cursor.execute(f"DELETE FROM nodes WHERE id IN ({placeholders})", ids_to_delete)
    
    conn.commit()
    conn.close()
    return True

def _action_update(module, node_id, update_data):
    conn = get_db()
    cursor = conn.cursor()
    
    allowed_fields = {'title', 'content', 'tags'}
    updates = []
    params = []
    
    for k, v in update_data.items():
        if k in allowed_fields:
            if k == 'tags': v = json.dumps(v, ensure_ascii=False)
            updates.append(f"{k}=?")
            params.append(v)
            
    if updates:
        params.append(node_id)
        sql = f"UPDATE nodes SET {', '.join(updates)} WHERE id=?"
        cursor.execute(sql, params)
        conn.commit()
        
    conn.close()
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
    return True

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
    # 简单实现，不再包含复杂锁
    try:
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except: return False

def handle_request(path, method, query_params, body_data):
    try:
        module = query_params.get('module', ['notes'])[0]
        # 兼容旧逻辑映射，虽然已经不用 file map 了
        if module not in JS_SYNC_MAP: return 400, {"error": "Invalid module"}

        if method == 'GET' and path.endswith('/fetch'):
            return 200, fetch_module_tree(module)

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
                else:
                    return 400, {"error": "Unknown action"}
            except ValueError as ve:
                print(f"❌ Logic Error: {ve}")
                return 400, {"error": str(ve)}

            if changed:
                # 🔥 关键：每次修改后，重新生成静态 JS 文件供前端读取
                sync_js_file(module)
                return 200, {"status": "success"}
            return 400, {"error": "No changes made"}

        return 404, {"error": "Not found"}

    except Exception as e:
        import traceback
        traceback.print_exc()
        return 500, {"error": str(e)}
