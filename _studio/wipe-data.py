import os
import sqlite3
import json
import shutil
import config

def wipe_all_data():
    print("========================================================")
    print("   ⚠️  极度危险：MAERS 全量数据清空工具 ⚠️")
    print("========================================================")
    print(" 1. 清空 cms.db (笔记、文献、随记、作品)")
    print(" 2. 清空 gallery.db (相册数据库)")
    print(" 3. 重置所有 data/*.json 静态文件 (包括 Space 收藏)")
    print(" 4. 删除 data/ 各模块下的所有 .md 正文文件")
    print(" 5. 删除 photos/ 下的所有物理图片 (原图、缩略图、预览图)")
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
    # 统一将 Tree 类型文件重置为 {"root": []} 结构
    file_resets = [
        (os.path.join(config.DATA_DIR, 'notes-tree.json'), {"root": []}, 'json'),
        (os.path.join(config.DATA_DIR, 'literature-tree.json'), {"root": []}, 'json'),
        (os.path.join(config.DATA_DIR, 'record-tree.json'), {"root": []}, 'json'),
        (os.path.join(config.DATA_DIR, 'games-tree.json'), {"root": []}, 'json'), # Added games
        (os.path.join(config.DATA_DIR, 'photos-data.json'), {}, 'json'),
        (config.MUSIC_DATA, [], 'json'),
        (os.path.join(config.DATA_DIR, 'search-index.json'), [], 'json'),
        # 重置相册分类配置
        (config.ALBUM_CONFIG_JSON, [], 'json'),
        # 重置 Space 收藏数据
        (config.SPACE_DATA, {"root": []}, 'json')
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

    # 2.5 清理标签配置 (new version)
    tags_dir = os.path.join(config.DATA_DIR, 'tags')
    if os.path.exists(tags_dir):
        try:
            for f in os.listdir(tags_dir):
                if f.endswith('.json'):
                    os.remove(os.path.join(tags_dir, f))
            print(f"✅ 标签配置已清空: data/tags/*.json")
        except Exception as e:
            print(f"❌ 清空标签配置失败: {e}")

    # 3. 处理各模块下的 MD 文件
    # 扫描 data/ 下的子目录 (notes, record, games 等)
    if os.path.exists(config.DATA_DIR):
        for item in os.listdir(config.DATA_DIR):
            sub_dir = os.path.join(config.DATA_DIR, item)
            if os.path.isdir(sub_dir):
                # 如果目录里有 .md 文件，则清理
                md_files = [f for f in os.listdir(sub_dir) if f.endswith('.md')]
                if md_files:
                    try:
                        for md in md_files:
                            os.remove(os.path.join(sub_dir, md))
                        print(f"✅ 模块文档已清空: data/{item}/*.md ({len(md_files)} files)")
                    except Exception as e:
                        print(f"❌ 清理模块文档失败 {item}: {e}")

    # 4. 处理物理图片
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
