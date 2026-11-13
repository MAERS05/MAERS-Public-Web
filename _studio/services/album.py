"""
相册分类服务：分类增删改排、目录与标签资源初始化、album-config.json 持久化。
"""

import sys
import os
import re

# 添加父目录到 path 以导入兄弟模块 (cms_core)
# 注意：在 server.py 运行时 path 已经设置好了，但单独测试时可能需要
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from . import cms, storage
import config


def validate_category_slug(conf, category):
    """显示名称、存储 ID 与链接代号分别管理；地址代号不能遮蔽其他分类。"""
    slug = category.get('slug', '')
    if not isinstance(slug, str) or slug and not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', slug):
        raise ValueError('链接代号须为 1 到 64 个小写字母、数字、短横线或下划线，并以字母或数字开头')
    identity = category.get('id')
    name = slug or identity
    if any(not item.get('_enc') and item.get('id') != identity and
           (name in (item.get('id'), item.get('slug') or item.get('id')) or item.get('slug') == identity)
           for item in conf):
        raise ValueError('链接代号已被其他分类使用')


def _category_directories(category_id):
    from .photo_paths import media_component, media_path
    media_component(category_id)
    targets = []
    for sub in ('images', 'thumbnails', 'previews'):
        media_path(f'photos/{sub}/{category_id}/_boundary', config.PROJECT_ROOT)
        targets.append(os.path.join(config.PROJECT_ROOT, 'photos', sub, category_id))
    return targets


def _ensure_tag_file(category_id, resources):
    tags_dir = os.path.join(config.DATA_DIR, 'tags')
    os.makedirs(tags_dir, exist_ok=True)
    target = os.path.join(tags_dir, f'photos-{category_id}-tag-categories.json')
    if os.path.exists(target):
        resources['tag_file_existed'] = True
        print(f"  [ ALBUM ] 🏷️  标签文件已存在 | Tag file exists: {target}")
        return
    templates = [os.path.join(tags_dir, f'{scope}-tag-categories.json')
                 for scope in ('photos', 'cms')]
    template = next((path for path in templates if os.path.exists(path)), None)
    if template:
        with open(template, 'rb') as source:
            storage.write_bytes(target, source.read())
        print(f"  [ ALBUM ] 🏷️  从模板创建标签 | Created from template: {target}")
    else:
        storage.write_json(target, [])
        print(f"  [ ALBUM ] 🏷️  创建空标签文件 | Created empty tag file: {target}")
    resources['tag_file_created'] = True


def ensure_category_resources(category_id):
    """确保公开分类物理资源存在；加密分类的标签和图片继续保留在私有侧。"""
    from . import private_photos
    if private_photos.entry(category_id):
        return {'dirs_created': False, 'dirs_existed': True,
                'tag_file_created': False, 'tag_file_existed': True}
    if not category_id:
        return {}
    resources = dict.fromkeys(('dirs_created', 'dirs_existed',
                               'tag_file_created', 'tag_file_existed'), False)
    try:
        for target in _category_directories(category_id):
            if os.path.exists(target):
                resources['dirs_existed'] = True
            else:
                os.makedirs(target, exist_ok=True)
                resources['dirs_created'] = True
                print(f"  [ ALBUM ] 📂 创建目录 | Created: {target}")
        _ensure_tag_file(category_id, resources)
    except OSError as error:
        print(f"  [ ALBUM ] ⚠️ 资源初始化异常 | Resource init error: {error}")
    return resources


def _reorder_category(conf, order):
    print("  [ ALBUM ] 📂 分类排序中 | Reordering categories...")
    old_map = {(item.get('id') or item.get('_enc')): item for item in conf
               if item.get('id') or item.get('_enc')}
    reordered = [old_map[uid] for uid in order if uid in old_map]
    requested = set(order)
    reordered.extend(item for item in conf
                     if (item.get('id') or item.get('_enc')) not in requested)
    cms.save_json(config.ALBUM_CONFIG_JSON, reordered)
    return 200, {'status': 'success'}


def _add_category(conf, body):
    category_id = (body.get('id') or '').strip()
    if not category_id:
        return 400, {'status': 'error', 'message': 'Missing ID'}
    validate_category_slug(conf, body)
    resources = ensure_category_resources(category_id)
    if not any(item.get('id') == category_id for item in conf):
        conf.append(body)
        cms.save_json(config.ALBUM_CONFIG_JSON, conf)
        print(f"  [ ALBUM ] 📝 已写入配置 | Added to album-config.json: {category_id}")
    return 200, {'status': 'success', **resources}


def _purge_category_resources(category_id):
    """文件、索引、标签与待上传任务共用外层事务，失败时全部回滚。"""
    from . import photos, media_jobs
    files, directories = [], []
    project = os.path.realpath(config.PROJECT_ROOT)
    junction = getattr(os.path, 'isjunction', lambda path: False)
    gallery = cms.load_json(photos.GALLERY_JSON_FILE)
    if not isinstance(gallery, dict):
        raise ValueError('图片索引无效，已停止删除')
    tag_file = os.path.join(config.DATA_DIR, 'tags', f'photos-{category_id}-tag-categories.json')
    if os.path.islink(tag_file) or junction(tag_file):
        raise ValueError('相册标签包含链接，已停止删除')
    for target in _category_directories(category_id):
        if os.path.commonpath([project, os.path.realpath(target)]) != project:
            raise ValueError('相册目录超出项目范围，已停止删除')
        if any(os.path.islink(path) or junction(path) for path in
               (os.path.dirname(os.path.dirname(target)), os.path.dirname(target), target)):
            raise ValueError('相册目录包含链接，已停止删除')
        if not os.path.exists(target):
            continue
        for parent, children, names in os.walk(target, topdown=False, followlinks=False):
            for path in [parent, *(os.path.join(parent, name) for name in children + names)]:
                if os.path.islink(path) or junction(path):
                    raise ValueError('相册目录包含链接，已停止删除')
            files.extend(os.path.join(parent, name) for name in names)
            directories.append(parent)
    # 先核对全部目录，再开始删除；文件内容会由存储事务持久化备份。
    for path in files:
        storage.remove(path)
    for path in directories:
        os.rmdir(path)
    tag_deleted = os.path.isfile(tag_file)
    storage.remove(tag_file)
    if category_id in gallery:
        del gallery[category_id]
        storage.write_json(photos.GALLERY_JSON_FILE, gallery)
        storage.on_commit(photos.rebuild_cache)
    prefixes = tuple(f'photos/{tier}/{category_id}/' for tier in ('images', 'thumbnails', 'previews'))
    media_jobs.cancel([job['key'] for job in media_jobs.pending()
                       if job['action'] in ('upload', 'ensure') and job['key'].startswith(prefixes)])
    return tag_deleted


def _delete_category(conf, body):
    category_id = body.get('id')
    if not category_id:
        return 400, {'status': 'error', 'message': 'Missing ID'}
    from . import private_photos
    private = private_photos.entry(category_id)
    delete_physical = body.get('delete_physical', False)
    if not isinstance(delete_physical, bool):
        raise ValueError('删除选项无效，请重新选择删除方式')
    print(f"  [ ALBUM ] 🗑️  移除分类 | Removing category: {category_id} (物理删除 | Physical: {delete_physical})")
    remaining = [item for item in conf if item.get('id') != category_id]
    if len(remaining) == len(conf):
        return 200, {'status': 'success'}
    if delete_physical and private:
        raise ValueError('请先取消相册对外加密，再删除本地图片')
    tag_deleted = _purge_category_resources(category_id) if delete_physical else False
    cms.save_json(config.ALBUM_CONFIG_JSON, remaining)
    return 200, {'status': 'success', 'tag_file_deleted': tag_deleted}


def _update_category(conf, body):
    category_id = body.get('id')
    previous = next((item for item in conf if item.get('id') == category_id), {})
    validate_category_slug(conf, {**previous, **body})
    print(f"  [ ALBUM ] ✎  元数据同步 | Updating metadata: {category_id}")
    resources = ensure_category_resources(category_id)
    changed = False
    for item in conf:
        if category_id and item.get('id') == category_id:
            item.update(body)
            changed = True
    if changed:
        cms.save_json(config.ALBUM_CONFIG_JSON, conf)
    return 200, {'status': 'success', **resources}


_CATEGORY_HANDLERS = {
    '/api/reorder_category': _reorder_category,
    '/api/add_category': _add_category,
    '/api/delete_category': _delete_category,
    '/api/update_category': _update_category,
}


@storage.transactional
def handle_ops(path, body):
    """各分类操作共用事务边界，资源初始化与配置写入保持在同一次操作中。"""
    conf = cms.load_json(config.ALBUM_CONFIG_JSON) or []
    handler = _CATEGORY_HANDLERS.get(path)
    return handler(conf, body) if handler else (200, {'status': 'success'})
