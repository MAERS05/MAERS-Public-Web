import os
import sqlite3
import json
import shutil
import config

def wipe_all_data():
    print("========================================================")
    print("   ⚠️  极度危险：MAERS 全量数据清空工具 ⚠️")
    print("========================================================")
    print(" 此操作将执行以下动作：")
    print(" 1. 清空 cms.db (笔记、文献、随笔)")
    print(" 2. 清空 gallery.db (相册数据库)")
    print(" 3. 重置所有 data/*.json 静态文件")
    print(" 4. 删除 photos/ 下的所有物理图片 (原图、缩略图、预览图)")
    print("========================================================")
    
    confirm = input("确定要清空吗？此操作不可撤销！请输入 'YES' 确认: ")
    if confirm != 'YES':
        print("❌ 操作已取消。")
        return

    # 1. 处理数据库
    dbs = {
        'cms.db': ["DELETE FROM nodes", "DELETE FROM sqlite_sequence WHERE name='nodes'"],
        'gallery.db': ["DELETE FROM photos", "DELETE FROM sqlite_sequence WHERE name='photos'"]
    }
    
    for db_name, sql_commands in dbs.items():
        db_path = os.path.join(config.DATA_DIR, db_name)
        if os.path.exists(db_path):
            try:
                conn = sqlite3.connect(db_path)
                for sql in sql_commands:
                    try:
                        conn.execute(sql)
                    except Exception as sql_err:
                        pass
                        
                conn.commit()
                conn.execute("VACUUM") 
                conn.close()
                print(f"✅ 数据库已清空: {db_name}")
            except Exception as e:
                print(f"❌ 清空数据库失败 {db_name}: {e}")

    # 2. 处理 JSON 和 JS 配置文件
    file_resets = [
        (os.path.join(config.DATA_DIR, 'notes-tree.json'), [], 'json'),
        (os.path.join(config.DATA_DIR, 'literature-tree.json'), [], 'json'),
        (os.path.join(config.DATA_DIR, 'record-tree.json'), [], 'json'),
        (os.path.join(config.DATA_DIR, 'photos-data.json'), {}, 'json'),
        (config.MUSIC_DATA, [], 'json'),
        (os.path.join(config.DATA_DIR, 'search-index.json'), [], 'json'),
        # 重置相册分类配置
        (config.ALBUM_CONFIG_JSON, [], 'json'),
        (config.ALBUM_CONFIG_JS, 'window.CATEGORY_CONFIG = [];', 'js_content')
    ]
    
    for file_path, default_val, f_type in file_resets:
        try:
            parent = os.path.dirname(file_path)
            if not os.path.exists(parent):
                os.makedirs(parent, exist_ok=True)

            with open(file_path, 'w', encoding='utf-8') as f:
                if f_type == 'json':
                    json.dump(default_val, f, ensure_ascii=False, indent=2)
                elif f_type == 'js_content':
                    f.write(default_val)
            
            rel_path = os.path.relpath(file_path, config.PROJECT_ROOT)
            print(f"✅ 配置文件已重置: {rel_path}")
        except Exception as e:
            print(f"❌ 重置配置文件失败 {file_path}: {e}")

    # 3. 处理物理图片
    image_dirs = ['images', 'thumbnails', 'previews']
    for sub in image_dirs:
        target_dir = os.path.join(config.PHOTOS_ROOT, sub)
        if os.path.exists(target_dir):
            try:
                for item in os.listdir(target_dir):
                    item_path = os.path.join(target_dir, item)
                    if os.path.isfile(item_path):
                        os.remove(item_path)
                    elif os.path.isdir(item_path):
                        shutil.rmtree(item_path)
                print(f"✅ 物理文件夹已清空: photos/{sub}/")
            except Exception as e:
                print(f"❌ 清理文件夹失败 {sub}: {e}")

    print("========================================================")
    print("✨ 全量数据清空完成！您的系统已恢复至“出厂状态”。")
    print("========================================================")

if __name__ == '__main__':
    wipe_all_data()
