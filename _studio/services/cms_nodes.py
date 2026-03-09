import os
import json
import time
import re

# ================= 业务动作 (节点管理) =================

def sanitize_filename(title):
    # Remove invalid chars
    return re.sub(r'[\\/*?:"<>|]', "", title).strip() or "Untitled"

def add_node(module, parent_id, node_type, title, context):
    """添加新节点"""
    get_db = context['get_db']
    DATA_DIR = context['DATA_DIR']
    
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
    
    # Create empty MD file for notes
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
    
    # Sync JS
    if context.get('sync_js_file'):
        context['sync_js_file'](module)
        
    return True

def delete_node(module, node_id, context):
    """删除节点及其子树"""
    get_db = context['get_db']
    PROJECT_ROOT = context['PROJECT_ROOT']
    
    conn = get_db()
    cursor = conn.cursor()
    
    # 级联删除 (简单的递归删除 children)
    # 1. 找到所有子节点 ID (递归)
    ids_to_delete = [node_id]
    
    # 递归查找所有后代节点
    while True:
        placeholders = ','.join('?' for _ in ids_to_delete)
        cursor.execute(f"SELECT id FROM nodes WHERE parent_id IN ({placeholders}) AND id NOT IN ({placeholders})", ids_to_delete + ids_to_delete)
        children = [r[0] for r in cursor.fetchall()]
        if not children:
            break
        ids_to_delete.extend(children)

    # 2. Delete cover images for all nodes before deleting the nodes
    # Import photos module for cover deletion
    try:
        from . import photos
        photo_handler = photos
    except ImportError:
        photo_handler = None
    
    if photo_handler:
        for del_id in ids_to_delete:
            cursor.execute("SELECT coverImage FROM nodes WHERE id=?", (del_id,))
            row = cursor.fetchone()
            if row and row['coverImage']:
                cover_path = row['coverImage']
                print(f"  [ CMS ] 🗑️  正在删除封面图 | Deleting cover image for node {del_id}: {cover_path}")
                try:
                    photo_handler.handle_delete({'path': cover_path})
                except Exception as e:
                    print(f"  [ CMS ] ⚠️  封面图删除失败 | Failed to delete cover {cover_path}: {e}")

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

    # 4. Execute deletion from DB
    placeholders = ','.join('?' for _ in ids_to_delete)
    cursor.execute(f"DELETE FROM nodes WHERE id IN ({placeholders})", ids_to_delete)
    
    conn.commit()
    conn.close()
    print(f"  [ CMS ] 🗑️  节点及子树已删除 | Node & sub-tree deleted: {node_id}")
    
    # Sync JS
    if context.get('sync_js_file'):
        context['sync_js_file'](module)
        
    return True

def update_node(module, node_id, update_data, context):
    """更新节点信息 (重命名/更改内容/标签/封面)"""
    get_db = context['get_db']
    PROJECT_ROOT = context['PROJECT_ROOT']
    
    conn = get_db()
    cursor = conn.cursor()
    
    allowed_fields = {'title', 'content', 'tags', 'coverImage'}
    updates = []
    params = []
    
    try:
        from . import photos
        photo_handler = photos
    except ImportError:
        photo_handler = None

    for k, v in update_data.items():
        if k in allowed_fields:
            if k == 'tags': v = json.dumps(v, ensure_ascii=False)
            
            # Special Logic: Use Photos Module for Cover Deletion
            if k == 'coverImage' and v is None and photo_handler:
                # 1. Fetch old value
                cursor.execute("SELECT coverImage FROM nodes WHERE id=?", (node_id,))
                row = cursor.fetchone()
                if row and row['coverImage']:
                    old_path = row['coverImage']
                    print(f"  [ CMS ] 🗑️  正在清理旧封面 | Purging old cover: {old_path}")
                    photo_handler.handle_delete({'path': old_path})

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
                        norm_new = os.path.normpath(new_full_path)
                        norm_old = os.path.normpath(old_full_path)
                        
                        counter = 1
                        base_name = new_safe_title
                        
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
    # We should NOT update the 'content' column in DB with this text.
    
    content_to_write = None
    
    # Reset updates/params for SQL
    sql_updates = []
    sql_params = []
    
    for k, v in update_data.items():
        if k == 'content':
            content_to_write = v
            continue # Don't add to SQL
            
        if k in allowed_fields:
            if k == 'tags': v = json.dumps(v, ensure_ascii=False)
            sql_updates.append(f"{k}=?")
            sql_params.append(v)

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

    if sql_updates:
        sql_params.append(node_id)
        sql = f"UPDATE nodes SET {', '.join(sql_updates)} WHERE id=?"
        cursor.execute(sql, sql_params)
        conn.commit()
        print(f"  [ CMS ] ✎  节点已更新 | Node updated: {node_id}")
        
    conn.close()
    
    # Sync JS
    if context.get('sync_js_file'):
        context['sync_js_file'](module)
        
    return True

def reorder_nodes(module, ids, context):
    """节点重排序"""
    if not ids: return True
    get_db = context['get_db']
    
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
    
    # Sync JS
    if context.get('sync_js_file'):
        context['sync_js_file'](module)
        
    return True

def move_node(module, node_id, target_parent_id, context):
    """移动节点 (跨父级)"""
    # 防止循环引用
    if node_id == target_parent_id:
        raise ValueError("Cannot move node into itself")
        
    get_db = context['get_db']
    conn = get_db()
    cursor = conn.cursor()
    
    # 检查 target_parent_id 是否在 node_id 的子树中
    if target_parent_id != 'root':
        curr = target_parent_id
        while curr != 'root' and curr is not None:
            if curr == node_id:
                conn.close()
                raise ValueError("Circular reference")
            cursor.execute("SELECT parent_id FROM nodes WHERE id=?", (curr,))
            res = cursor.fetchone()
            curr = res[0] if res else None

    # 执行移动：插入到最前面
    cursor.execute("SELECT MAX(sort_order) FROM nodes WHERE module=? AND parent_id=?", (module, target_parent_id))
    max_order = cursor.fetchone()[0]
    new_order = (max_order if max_order is not None else 0) + 1

    cursor.execute("UPDATE nodes SET parent_id=?, sort_order=? WHERE id=?", (target_parent_id, new_order, node_id))
    
    conn.commit()
    conn.close()
    print(f"  [ CMS ] 🚚 节点已跨级移动 | Node moved: {node_id} -> {target_parent_id}")
    
    # Sync JS
    if context.get('sync_js_file'):
        context['sync_js_file'](module)
        
    return True

def update_node_tags(module, node_id, tags, context):
    """更新单个节点的标签"""
    get_db = context['get_db']
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
        
        print(f"  [ CMS ] 🏷️  Tags Updated: {node_id} -> {tags}")
        
        # Sync JS
        if context.get('sync_js_file'):
            context['sync_js_file'](module)
            
        return True
    except Exception as e:
        print(f"  [ CMS ] ❌ Tag update failed: {e}")
        conn.close()
        return False
