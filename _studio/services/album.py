import sys
import os

# 添加父目录到 path 以导入兄弟模块 (cms_core)
# 注意：在 server.py 运行时 path 已经设置好了，但单独测试时可能需要
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from . import cms
import config

def handle_ops(path, body):
    conf = cms.load_json(config.ALBUM_CONFIG_JSON, config.ALBUM_CONFIG_JS) or []
    
    changed = False
    
    if path == '/api/reorder_category':
        print(f"  [ ALBUM ] 📂 分类排序中 | Reordering categories...")
        old_map = {x['id']:x for x in conf}
        # body 是 id 列表
        new_conf = []
        for uid in body:
            if uid in old_map:
                new_conf.append(old_map[uid])
        
        # 补全可能遗漏的
        existing = set(body)
        for x in conf:
            if x['id'] not in existing:
                new_conf.append(x)
        conf = new_conf
        changed = True

    elif path == '/api/add_category': 
        # body 是 new item
        new_id = body.get('id')
        dirs_created = False
        if new_id and not any(c['id'] == new_id for c in conf): 
            print(f"  [ ALBUM ] 🆕 添加新分类 | Adding new category: {new_id}")
            # 物理创建文件夹逻辑
            try:
                # 对应 photos.py 中的路径常量
                for sub in ['images', 'thumbnails', 'previews']:
                    target_dir = os.path.join(config.PROJECT_ROOT, 'photos', sub, new_id)
                    if not os.path.exists(target_dir):
                        os.makedirs(target_dir, exist_ok=True)
                        dirs_created = True
                if dirs_created:
                    print(f"  [ ALBUM ] 📁 物理目录已创建 | Created physical folders for: {new_id}")
            except Exception as e:
                print(f"  [ ALBUM ] ⚠️ 目录创建失败 | Failed to create folders: {e}")

            conf.append(body)
            changed = True
            
        if changed:
            cms.save_json(config.ALBUM_CONFIG_JSON, conf, config.ALBUM_CONFIG_JS, 'CATEGORY_CONFIG')
            return 200, {"status": "success", "dirs_created": dirs_created}
            
    elif path == '/api/delete_category': 
        # body 是 {id: '...', delete_physical: bool}
        target_id = body.get('id')
        delete_physical = body.get('delete_physical', False)
        print(f"  [ ALBUM ] 🗑️  移除分类 | Removing category: {target_id} (物理删除 | Physical: {delete_physical})")
        
        initial_len = len(conf)
        conf = [c for c in conf if c['id'] != target_id]
        
        if len(conf) < initial_len:
            changed = True
            
            # 如果要求物理删除
            if delete_physical and target_id:
                import shutil
                try:
                    for sub in ['images', 'thumbnails', 'previews']:
                        target_dir = os.path.join(config.PROJECT_ROOT, 'photos', sub, target_id)
                        if os.path.exists(target_dir):
                            shutil.rmtree(target_dir)
                    print(f"  [ ALBUM ] 💥 物理目录已粉碎 | Physical folders purged: {target_id}")
                except Exception as e:
                    print(f"  [ ALBUM ] ⚠️ 物理粉碎失败 | Physical purge failed: {e}")

    elif path == '/api/update_category':
        target_id = body.get('id')
        print(f"  [ ALBUM ] ✎  元数据同步 | Updating metadata: {target_id}")
        for c in conf: 
            if c['id'] == target_id: 
                c.update(body)
                changed = True

    if changed:
        cms.save_json(config.ALBUM_CONFIG_JSON, conf, config.ALBUM_CONFIG_JS, 'CATEGORY_CONFIG')
    
    return 200, {"status": "success"}
