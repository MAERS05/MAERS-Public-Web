import os
import sqlite3
import json
import shutil

# 配置
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')
PHOTOS_ROOT = os.path.join(PROJECT_ROOT, 'photos')

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
        'cms.db': "DELETE FROM nodes",
        'gallery.db': "DELETE FROM photos"
    }
    
    for db_name, sql in dbs.items():
        db_path = os.path.join(DATA_DIR, db_name)
        if os.path.exists(db_path):
            try:
                conn = sqlite3.connect(db_path)
                conn.execute(sql)
                conn.commit()
                conn.execute("VACUUM") # 压缩数据库文件
                conn.close()
                print(f"✅ 数据库已清空: {db_name}")
            except Exception as e:
                print(f"❌ 清空数据库失败 {db_name}: {e}")

    # 2. 处理 JSON 文件
    json_resets = {
        'notes-tree.json': [],
        'literature-tree.json': [],
        'record-tree.json': [],
        'photos-data.json': {},
        'music-data.json': [],
        'search-index.json': []
    }
    
    for file_name, default_val in json_resets.items():
        file_path = os.path.join(DATA_DIR, file_name)
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(default_val, f, ensure_ascii=False, indent=2)
            print(f"✅ JSON 已重置: {file_name}")
        except Exception as e:
            print(f"❌ 重置 JSON 失败 {file_name}: {e}")

    # 3. 处理物理图片
    image_dirs = ['images', 'thumbnails', 'previews']
    for sub in image_dirs:
        target_dir = os.path.join(PHOTOS_ROOT, sub)
        if os.path.exists(target_dir):
            try:
                # 删除目录下所有内容但保留目录本身
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
