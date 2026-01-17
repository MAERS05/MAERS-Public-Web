import os
import json
import re
import sys

# ================= 配置 =================
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
os.chdir(project_root)

# 扫描范围
DATA_FILES = [
    'data/notes-tree.json',
    'data/literature-tree.json',
    'data/thoughts_tree.json'
]

# 清理目标 (只针对笔记附件文件夹)
TARGET_DIRS = [
    'photos/images/_notes',
    'photos/previews/_notes',
    'photos/thumbnails/_notes'
]

# ================= 核心逻辑 =================

import sqlite3

def get_db_path():
    return os.path.join(project_root, 'data', 'cms.db')

def extract_image_refs_from_db(refs_set):
    """从数据库直接提取白名单"""
    db_path = get_db_path()
    if not os.path.exists(db_path):
        print(f"⚠️ 数据库不存在: {db_path}")
        return

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # 只需要查 content 字段，查找所有看起来像图片的引用
        cursor.execute("SELECT content FROM nodes WHERE content IS NOT NULL AND content != ''")
        rows = cursor.fetchall()
        
        count = 0
        for row in rows:
            content = row[0]
            # 匹配逻辑：只要包含 photos/ 且包含 _notes/ 的都提取
            matches = re.findall(r'(photos/.*?_notes/.*?\.[\w]+)', content)
            for m in matches:
                filename = os.path.basename(m)
                name_no_ext = os.path.splitext(filename)[0]
                refs_set.add(name_no_ext)
                count += 1
        
        print(f"✅ 从数据库中提取了 {len(refs_set)} 个唯一图片引用 (总引用数: {count})")
        conn.close()
    except Exception as e:
        print(f"❌ 读取数据库失败: {e}")

def auto_clean():
    print("🚀 [Auto Clean] 开始全自动清理...")
    
    # 1. 建立白名单 (从数据库)
    whitelist = set()
    extract_image_refs_from_db(whitelist)
    
    # 2. 扫描并斩立决
    deleted_count = 0
    
    for folder in TARGET_DIRS:
        if not os.path.exists(folder): continue
        
        files = os.listdir(folder)
        for f in files:
            if f.startswith('.'): continue
            
            name_no_ext = os.path.splitext(f)[0]
            
            # 如果不在白名单里，且是图片文件 -> 删！
            if name_no_ext not in whitelist and f.lower().endswith(('.jpg', '.png', '.avif', '.webp', '.jpeg', '.gif')):
                full_path = os.path.join(folder, f)
                try:
                    os.remove(full_path)
                    print(f"   🗑️ 已删除: {full_path}")
                    deleted_count += 1
                except Exception as e:
                    print(f"   ❌ 删除出错: {full_path} ({e})")

    if deleted_count == 0:
        print("✨ 系统很干净，无需清理。")
    else:
        print(f"✅ 清理完成！共自动删除了 {deleted_count} 个垃圾文件。")

if __name__ == '__main__':
    auto_clean()
