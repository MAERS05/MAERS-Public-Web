"""
相册分类服务：分类增删改排、目录与标签资源初始化、album-config.json 持久化。
"""

import sys
import os

# 添加父目录到 path 以导入兄弟模块 (cms_core)
# 注意：在 server.py 运行时 path 已经设置好了，但单独测试时可能需要
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from . import cms, storage
import config
import shutil # Import shutil at top level

def ensure_category_resources(category_id):
    """确保公开分类物理资源存在；加密分类的标签和图片继续保留在私有侧。"""
    from . import private_photos
    if private_photos.entry(category_id):
        return {'dirs_created': False, 'dirs_existed': True, 'tag_file_created': False, 'tag_file_existed': True}
    if not category_id:
        return {}
    
    dirs_created = False
    dirs_existed = False
    tag_file_created = False
    tag_file_existed = False
    
    try:
        # 1. 创建图片目录
        exists_count = 0
        for sub in ['images', 'thumbnails', 'previews']:
            target_dir = os.path.join(config.PROJECT_ROOT, 'photos', sub, category_id)
            if not os.path.exists(target_dir):
                os.makedirs(target_dir, exist_ok=True)
                dirs_created = True
                print(f"  [ ALBUM ] 📂 创建目录 | Created: {target_dir}")
            else:
                exists_count += 1
        if exists_count > 0:
            dirs_existed = True

        # 2. 创建记录/标签文件
        tags_dir = os.path.join(config.DATA_DIR, 'tags')
        os.makedirs(tags_dir, exist_ok=True)

        target_tag_file = os.path.join(tags_dir, f'photos-{category_id}-tag-categories.json')
        
        if not os.path.exists(target_tag_file):
            # 寻找模板
            base_tag_file = os.path.join(tags_dir, 'photos-tag-categories.json')
            if not os.path.exists(base_tag_file):
                base_tag_file = os.path.join(tags_dir, 'cms-tag-categories.json')
            
            if os.path.exists(base_tag_file):
                with open(base_tag_file, 'rb') as source:
                    storage.write_bytes(target_tag_file, source.read())
                print(f"  [ ALBUM ] 🏷️  从模板创建标签 | Created from template: {target_tag_file}")
                tag_file_created = True
            else:
                storage.write_json(target_tag_file, [])
                print(f"  [ ALBUM ] 🏷️  创建空标签文件 | Created empty tag file: {target_tag_file}")
                tag_file_created = True
        else:
            tag_file_existed = True
            print(f"  [ ALBUM ] 🏷️  标签文件已存在 | Tag file exists: {target_tag_file}")

    except OSError as e:
        print(f"  [ ALBUM ] ⚠️ 资源初始化异常 | Resource init error: {e}")

    return {
        "dirs_created": dirs_created,
        "dirs_existed": dirs_existed,
        "tag_file_created": tag_file_created,
        "tag_file_existed": tag_file_existed
    }

@storage.transactional
def handle_ops(path, body):
    conf = cms.load_json(config.ALBUM_CONFIG_JSON) or []
    
    changed = False
    
    if path == '/api/reorder_category':
        print(f"  [ ALBUM ] 📂 分类排序中 | Reordering categories...")
        old_map = {(x.get('id') or x.get('_enc')):x for x in conf if (x.get('id') or x.get('_enc'))}
        # body 是 id 列表
        new_conf = []
        for uid in body:
            if uid in old_map:
                new_conf.append(old_map[uid])
        
        # 补全可能遗漏的
        existing = set(body)
        for x in conf:
            if (x.get('id') or x.get('_enc')) not in existing:
                new_conf.append(x)
        conf = new_conf
        changed = True

    elif path == '/api/add_category': 
        new_id = (body.get('id') or "").strip()
        if not new_id:
            return 400, {"status": "error", "message": "Missing ID"}

        # 无论是否存在配置中，都确保物理资源齐全
        res_info = ensure_category_resources(new_id)

        # 如果 JSON 中不存在，则添加
        if not any(c.get('id') == new_id for c in conf): 
            conf.append(body)
            changed = True
            print(f"  [ ALBUM ] 📝 已写入配置 | Added to album-config.json: {new_id}")
            
        if changed:
            cms.save_json(config.ALBUM_CONFIG_JSON, conf)
            
        return 200, {"status": "success", **res_info}
            
    elif path == '/api/delete_category': 
        # body 是 {id: '...', delete_physical: bool}
        target_id = body.get('id')
        if not target_id:
            return 400, {"status": "error", "message": "Missing ID"}
        delete_physical = body.get('delete_physical', False)
        from . import private_photos
        private = private_photos.entry(target_id)
        print(f"  [ ALBUM ] 🗑️  移除分类 | Removing category: {target_id} (物理删除 | Physical: {delete_physical})")
        
        initial_len = len(conf)
        conf = [c for c in conf if c.get('id') != target_id]
        
        tag_file_deleted = False
        if len(conf) < initial_len:
            changed = True
            
            # 如果要求物理删除
            if delete_physical and target_id and not private:
                import shutil
                try:
                    for sub in ['images', 'thumbnails', 'previews']:
                        target_dir = os.path.join(config.PROJECT_ROOT, 'photos', sub, target_id)
                        if os.path.exists(target_dir):
                            shutil.rmtree(target_dir)
                    print(f"  [ ALBUM ] 💥 物理目录已粉碎 | Physical folders purged: {target_id}")

                    # 同时删除标签配置文件
                    tags_dir = os.path.join(config.DATA_DIR, 'tags')
                    tag_file = os.path.join(tags_dir, f'photos-{target_id}-tag-categories.json')
                    if os.path.exists(tag_file):
                        os.remove(tag_file)
                        print(f"  [ ALBUM ] 🗑️  标签配置已清理 | Tag config removed: {os.path.basename(tag_file)}")
                        tag_file_deleted = True
                        
                except OSError as e:
                    print(f"  [ ALBUM ] ⚠️ 物理粉碎失败 | Physical purge failed: {e}")

            if changed:
                cms.save_json(config.ALBUM_CONFIG_JSON, conf)
            
            return 200, {"status": "success", "tag_file_deleted": tag_file_deleted}

    elif path == '/api/update_category':
        target_id = body.get('id')
        print(f"  [ ALBUM ] ✎  元数据同步 | Updating metadata: {target_id}")
        
        # 更新时一并确保资源齐全
        res_info = ensure_category_resources(target_id)
        
        for c in conf: 
            if target_id and c.get('id') == target_id: 
                c.update(body)
                changed = True
        
        if changed:
            cms.save_json(config.ALBUM_CONFIG_JSON, conf)
            
        return 200, {"status": "success", **res_info}

    if changed:
        cms.save_json(config.ALBUM_CONFIG_JSON, conf)
    
    return 200, {"status": "success"}
