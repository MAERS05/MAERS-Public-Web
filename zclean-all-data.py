import os
import shutil
import sqlite3
import json

# 配置路径
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
PHOTOS_DIR = os.path.join(BASE_DIR, 'photos')
DYNAMIC_STYLE_DIR = os.path.join(BASE_DIR, 'dynamic-style')

def clean_db(db_name, table_name):
    db_path = os.path.join(DATA_DIR, db_name)
    if os.path.exists(db_path):
        try:
            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()
            cursor.execute(f"DELETE FROM {table_name}")
            conn.commit()
            cursor.execute("VACUUM") # 压缩数据库文件
            conn.commit()
            conn.close()
            print(f"✅ Database cleaned: {db_name} (Table: {table_name})")
        except Exception as e:
            print(f"❌ Failed to clean {db_name}: {e}")
    else:
        print(f"⚠️ Database not found: {db_name}")

def write_file(path, content):
    try:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"✅ File reset: {os.path.basename(path)}")
    except Exception as e:
        print(f"❌ Failed to reset {os.path.basename(path)}: {e}")

def clean_photos_dir():
    # 需要清理的子目录
    subdirs = ['images', 'thumbnails', 'previews']
    for subdir in subdirs:
        target_dir = os.path.join(PHOTOS_DIR, subdir)
        if os.path.exists(target_dir):
            try:
                # 删除目录下的所有文件和文件夹
                for filename in os.listdir(target_dir):
                    file_path = os.path.join(target_dir, filename)
                    try:
                        if os.path.isfile(file_path) or os.path.islink(file_path):
                            os.unlink(file_path)
                        elif os.path.isdir(file_path):
                            shutil.rmtree(file_path)
                    except Exception as e:
                        print(f"   Failed to delete {file_path}. Reason: {e}")
                print(f"✅ Photos directory cleaned: photos/{subdir}")
            except Exception as e:
                print(f"❌ Failed to clean photos/{subdir}: {e}")

def main():
    print("🚀 Starting MAERS Project Data Cleanup...")
    print("========================================")

    # 1. Cleaning Config Files
    write_file(os.path.join(DYNAMIC_STYLE_DIR, 'album-config.json'), "[]")
    write_file(os.path.join(DYNAMIC_STYLE_DIR, 'album-config.js'), "window.CATEGORY_CONFIG = [];")
    
    # 2. Cleaning Data Files
    write_file(os.path.join(DATA_DIR, 'music-data.json'), "[]")
    write_file(os.path.join(DATA_DIR, 'music-data.js'), "var musicData = [];")
    write_file(os.path.join(DATA_DIR, 'photos-data.js'), "window.galleryData = {};")
    
    # Tree JS files (Notes, Literature, Record)
    empty_tree = 'window.MAERS_DATA = {"root": []};'
    write_file(os.path.join(DATA_DIR, 'notes-tree.js'), empty_tree)
    write_file(os.path.join(DATA_DIR, 'literature-tree.js'), empty_tree)
    write_file(os.path.join(DATA_DIR, 'record-tree.js'), empty_tree)

    # 3. Cleaning Databases
    clean_db('cms.db', 'nodes')
    clean_db('gallery.db', 'photos')

    # 4. Cleaning Photos
    clean_photos_dir()

    print("========================================")
    print("✨ All data cleaned successfully! The project is now an empty shell.")
    print("👉 If you are running the browser, please refresh the page to see changes.")

if __name__ == "__main__":
    main()
