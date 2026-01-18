import os
import sqlite3
import shutil
import json
import time

# 配置路径 (脚本现位于项目根目录)
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')
PHOTOS_DIR = os.path.join(PROJECT_ROOT, 'photos')

CMS_DB = os.path.join(DATA_DIR, 'cms.db')
GALLERY_DB = os.path.join(DATA_DIR, 'gallery.db')

def print_step(msg):
    print(f"[*] {msg}")

def clean_photos():
    print_step("正在清理图片目录 (Cleaning photos)...")
    subdirs = ['images', 'previews', 'thumbnails']
    for sub in subdirs:
        target_dir = os.path.join(PHOTOS_DIR, sub)
        if os.path.exists(target_dir):
            try:
                # 删除整个目录树并重建，确保干净
                shutil.rmtree(target_dir)
                os.makedirs(target_dir, exist_ok=True)
                print(f"    已清空: photos/{sub}")
            except Exception as e:
                print(f"    ⚠️ 清理失败 {sub}: {e}")
        else:
             os.makedirs(target_dir, exist_ok=True)

def clean_dbs():
    print_step("正在重置数据库 (Resetting databases)...")
    
    # CMS DB (笔记/记录/文学)
    if os.path.exists(CMS_DB):
        try:
            os.remove(CMS_DB)
            print("    已删除旧数据库: cms.db")
        except Exception as e:
            print(f"    ⚠️ 删除 cms.db 失败: {e}")

    try:
        conn = sqlite3.connect(CMS_DB)
        c = conn.cursor()
        # 创建 nodes 表 (对应 cms.py 中的结构)
        c.execute('''
            CREATE TABLE nodes (
                id TEXT PRIMARY KEY,
                module TEXT NOT NULL,
                parent_id TEXT,
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT,
                tags TEXT,
                order_index INTEGER DEFAULT 0,
                created_at REAL,
                updated_at REAL,
                sort_order INTEGER DEFAULT 0
            )
        ''')
        conn.commit()
        conn.close()
        print("    已重建空数据库: cms.db")
    except Exception as e:
        print(f"    ❌ 重建 cms.db 失败: {e}")

    # Gallery DB (相册)
    if os.path.exists(GALLERY_DB):
        try:
            os.remove(GALLERY_DB)
            print("    已删除旧数据库: gallery.db")
        except Exception as e:
            print(f"    ⚠️ 删除 gallery.db 失败: {e}")
        
    try:
        conn = sqlite3.connect(GALLERY_DB)
        c = conn.cursor()
        # 创建 photos 表 (对应 album.py 中的结构)
        c.execute('''
            CREATE TABLE photos (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                thumb TEXT,
                preview TEXT,
                hash TEXT NOT NULL,
                order_index INTEGER DEFAULT 0,
                created_at REAL,
                sort_order INTEGER DEFAULT 0
            )
        ''')
        conn.commit()
        conn.close()
        print("    已重建空数据库: gallery.db")
    except Exception as e:
        print(f"    ❌ 重建 gallery.db 失败: {e}")

def reset_js_files():
    print_step("正在重置数据文件 (Resetting JSON/JS files)...")
    
    # 1. CMS 树状数据 (Notes, Literature, Record)
    # 必须保持 root 结构
    empty_tree_js = "window.MAERS_DATA = {\"root\": []};"
    files = ['notes-tree.js', 'literature-tree.js', 'record-tree.js']
    for f in files:
        path = os.path.join(DATA_DIR, f)
        try:
            with open(path, 'w', encoding='utf-8') as fs:
                fs.write(empty_tree_js)
            print(f"    已重置: {f}")
        except Exception as e:
            print(f"    ⚠️ 重置 {f} 失败: {e}")

    # 2. 相册数据 (window.galleryData)
    empty_gallery_js = "window.galleryData = {};"
    path = os.path.join(DATA_DIR, 'photos-data.js')
    try:
        with open(path, 'w', encoding='utf-8') as fs:
            fs.write(empty_gallery_js)
        print("    已重置: photos-data.js")
    except Exception as e:
        print(f"    ⚠️ 重置 photos-data.js 失败: {e}")

    # 3. 音乐数据 (music-data.json 和 music-data.js)
    # 重置为空列表 []
    empty_music = []
    
    # JSON 文件
    path_json = os.path.join(DATA_DIR, 'music-data.json')
    try:
        with open(path_json, 'w', encoding='utf-8') as fs:
            json.dump(empty_music, fs, ensure_ascii=False)
        print("    已重置: music-data.json")
    except Exception as e:
        print(f"    ⚠️ 重置 music-data.json 失败: {e}")

    # JS 文件
    empty_music_js = "window.musicData = [];"
    path_js = os.path.join(DATA_DIR, 'music-data.js')
    try:
        with open(path_js, 'w', encoding='utf-8') as fs:
            fs.write(empty_music_js)
        print("    已重置: music-data.js")
    except Exception as e:
        print(f"    ⚠️ 重置 music-data.js 失败: {e}")

if __name__ == '__main__':
    print("=========================================")
    print("      MAERS 数据一键清空工具")
    print("      (MAERS Data Cleanup Utility)")
    print("=========================================")
    print("警告: 此操作将永久删除所有用户数据！")
    print("WARNING: This will delete ALL user data (Notes, Photos, Music playlists).")
    print("包括: 数据库, 图片文件, 播放列表等。")
    print("-----------------------------------------")
    print("程序将在 3 秒后开始执行...")
    
    time.sleep(3)
    
    try:
        clean_photos()
        clean_dbs()
        reset_js_files()
        print("\n✅ 所有数据已成功重置！(All data wiped successfully!)")
    except Exception as e:
        print(f"\n❌ 清理过程中发生错误: {e}")
        import traceback
        traceback.print_exc()

    input("\n按回车键退出... (Press Enter to exit)")
