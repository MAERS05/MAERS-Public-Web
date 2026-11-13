"""
图库业务入口：协调上传、去重、删除、排序、标签及云端登记；路径、图像处理与索引各自封装。
"""

from __future__ import annotations
from .contracts import JsonObject, Query

import os
import sys
import time
import hashlib
import json
import uuid
import functools
from contextlib import closing
from . import storage, operation_status, photo_paths, photo_images, relay_media
from .gallery_store import GalleryStore, top_order

# 确保控制台支持 UTF-8 打印 emoji，防止 Windows GBK 环境抛出 UnicodeEncodeError
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except (OSError, ValueError):
        pass
if hasattr(sys.stderr, 'reconfigure'):
    try:
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except (OSError, ValueError):
        pass

# 配置常量 
# 服务目录上一级为后端入口目录
SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SERVICE_DIR) # _studio/
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')
DB_PATH = os.path.join(DATA_DIR, 'gallery.db')

# 图片存储路径
BASE_IMAGE_DIR = 'photos/images'
THUMB_DIR      = 'photos/thumbnails'
PREVIEW_DIR    = 'photos/previews'

# 静态JS文件路径
GALLERY_JSON_FILE = os.path.join(DATA_DIR, 'photos-data.json')

# 测试沙盒可将该开关设为 True 以跳过后台 R2 异步同步
DISABLE_R2_SYNC = False


# 外部调用仍经过图库入口；子模块不反向导入 photos。
media_component = photo_paths.media_component
normalize_media_reference = photo_paths.normalize_media_reference
media_references = photo_paths.media_references
get_exif_datetime = photo_images.get_exif_datetime
new_upload_name = photo_images.new_upload_name
open_upload_image = photo_images.open_upload_image


def media_path(key):
    return photo_paths.media_path(key, PROJECT_ROOT)


_images = photo_images.ImagePipeline(media_path)
_gallery = GalleryStore(lambda: DB_PATH, lambda: GALLERY_JSON_FILE, media_path)
rebuild_cache = _gallery.rebuild_cache
get_db = _gallery.get_db
sync_gallery_js = _gallery.sync_gallery_js

# ================= 数据库工具 =================


def gallery_operation(function):
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        with storage.LOCK:
            rebuild_cache()
            try:
                return function(*args, **kwargs)
            except Exception:
                rebuild_cache()
                raise
    return wrapped


# ================= 业务逻辑 =================

def to_web_path(path):
    return path.replace('\\', '/')


def _submit_upload(path, thumb=None, preview=None, *, keep_original=False, bucket_id=None):
    operation_status.update('正在同步公开图片到媒体存储')
    if DISABLE_R2_SYNC:
        return {'state': 'disabled'}
    from . import media_jobs
    return media_jobs.submit('upload', [key for key in (path, thumb, preview) if key],
                             only_if_missing=path if keep_original else None, bucket_id=bucket_id)


def _reuse_existing_upload(connection, row, category, need_convert):
    print(f"  [ PHOTOS ] ♻️  检测到重复图片 ({row['hash']}) | Duplicate found, skipping upload.")
    connection.execute("UPDATE photos SET sort_order=? WHERE id=?", (top_order(connection, category), row['id']))
    connection.commit()
    sync_gallery_js()
    path = row['path']
    if need_convert and not path.endswith('.avif') and (row['preview'] or '').endswith('.avif'):
        path = row['preview']
    return {'status': 'success', 'msg': 'duplicate_found', 'path': path,
            'id': row['id'], 'name': row['name'], 'thumb': row['thumb'],
            'preview': row['preview'], 'sync': _submit_upload(row['path'], row['thumb'], row['preview'],
                                                              bucket_id=row['bucket_id'] or None)}


@gallery_operation
@storage.transactional
def handle_upload(query: Query, file_data: bytes) -> JsonObject:
    """处理图片上传请求"""
    operation_status.update('正在检查图片和重复文件')
    category = media_component(query.get('category', ['default'])[0])
    import urllib.parse
    raw_name_input = urllib.parse.unquote(query.get('name', ['temp.jpg'])[0])
    ext = os.path.splitext(raw_name_input)[1].lower()
    if not ext: ext = '.jpg'
    
    file_hash = hashlib.md5(file_data).hexdigest()
    need_convert = query.get('convert', [''])[0] == 'avif'

    with closing(get_db()) as conn:
        cursor = conn.cursor()

        # 1. 查重逻辑 (秒级)
        cursor.execute("SELECT * FROM photos WHERE hash=? AND category=?", (file_hash, category))
        existing_row = cursor.fetchone()
    
        if existing_row and os.path.exists(media_path(existing_row['path'])):
            return _reuse_existing_upload(conn, existing_row, category, need_convert)

        is_restore = existing_row is not None
        if is_restore:
            safe_name = existing_row['name']
            bucket_id = existing_row['bucket_id']
            print(f"  [ PHOTOS ] ⚠️  数据库记录存在但物理文件丢失 | Repairing missing file: {existing_row['path']}")
        else:
            from . import media_store
            bucket_id = query.get('bucketId', [''])[0]
            if not bucket_id and not DISABLE_R2_SYNC:
                bucket_id = media_store.write_buckets(media_store.load_config())['public_photo']
            if bucket_id == media_store.DEFAULT_BUCKET:
                bucket_id = ''
            if bucket_id:
                media_store.get_store().bucket_target(bucket_id)
            print(f"  [ PHOTOS ] 📤 上传图片中 | Uploading to category: {category}")
            new_id, safe_name, exif_timestamp = new_upload_name(file_data, ext, need_convert, query.get('dateLabel', [None])[0])

        _images.prepare_directories(category, safe_name)
        rel_path = to_web_path(f'{BASE_IMAGE_DIR}/{category}/{safe_name}')
        operation_status.update('正在生成缩略图和预览图')
        rel_thumb, rel_prev = _images.write_upload_images(file_data, category, safe_name, need_convert, is_restore)

        # 4. 插入或更新数据库
    
        new_order = top_order(conn, category)

        if is_restore:
            # 修复原记录并置顶，保持原图片 ID
            cursor.execute("UPDATE photos SET sort_order=? WHERE id=?", (new_order, existing_row['id']))
        else:
            # 优先使用拍摄时间，缺失时使用当前时间
            created_at = exif_timestamp if exif_timestamp else time.time()
            cursor.execute('''
                INSERT INTO photos (id, category, name, path, thumb, preview, hash, created_at, sort_order, bucket_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (new_id, category, safe_name, rel_path, rel_thumb, rel_prev, file_hash, created_at, new_order, bucket_id))
    
        conn.commit()
    
        operation_status.update('正在保存图片索引')
        sync_gallery_js()
        print(f"  [ PHOTOS ] ✅ 处理完成 | Processed: {safe_name}")

        # 同步任务先落盘，与加锁迁移共用写锁，失败时返回待同步状态。
        sync = _submit_upload(rel_path, rel_thumb, rel_prev, bucket_id=bucket_id or None)

        return {
            "status": "success",
            "id": existing_row['id'] if is_restore else new_id,
            "sync": sync,
            "path": rel_path,
            "name": safe_name,
            "thumb": rel_thumb,
            "preview": rel_prev,
            **({'bucketId': bucket_id} if bucket_id else {})
        }

@gallery_operation
@storage.transactional
def handle_delete(body: JsonObject) -> JsonObject:
    """删除图库记录与三级文件，远端删除留待本地事务提交后执行。"""
    target_path = body.get('path')
    media_path(target_path)
    print(f"  [ PHOTOS ] 🗑️  请求删除文件 | Request delete: {target_path}")
    with closing(get_db()) as connection, connection:
        row = connection.execute("SELECT * FROM photos WHERE path=?", (target_path,)).fetchone()
        if not row:
            return {}
        keys = dict.fromkeys(row[field] for field in ('path', 'thumb', 'preview') if row[field])
        if not DISABLE_R2_SYNC:
            from . import media_jobs
            for key in keys:
                media_jobs.enqueue('delete', key, row['bucket_id'] or None)
        for key in keys:
            storage.remove(media_path(key))
        connection.execute("DELETE FROM photos WHERE id=?", (row['id'],))
    sync_gallery_js()

    result = {}
    if not DISABLE_R2_SYNC:
        storage.on_commit(lambda: result.update(sync=media_jobs.retry(keys)))
    return result

@gallery_operation
def handle_reorder(query: Query, body: list[JsonObject]) -> JsonObject:
    """处理排序请求"""
    cat_id = query.get('category', [None])[0]
    if not cat_id: return {}
    
    print(f"  [ PHOTOS ] ↕️  图库重排序 | Reordering gallery: {cat_id}")
    
    with closing(get_db()) as connection, connection:
        connection.executemany("UPDATE photos SET sort_order=? WHERE path=? AND category=?",
                               ((index, item.get('path'), cat_id) for index, item in enumerate(body)))
    sync_gallery_js()
    return {}

@gallery_operation
def update_tags(photo_id: str, tags: list[str]) -> bool:
    """更新指定图片的标签，数据库异常时回滚并释放连接。"""
    if not photo_id:
        raise ValueError("Photo ID is required")
        
    with closing(get_db()) as connection, connection:
        row = connection.execute("SELECT id FROM photos WHERE id=?", (photo_id,)).fetchone()
        if not row:
            raise ValueError(f"Photo not found: {photo_id}")
        connection.execute("UPDATE photos SET tags=? WHERE id=?", (json.dumps(tags, ensure_ascii=False), photo_id))
    
    print(f"  [ PHOTOS ] 🏷️  Tags Updated: {photo_id} -> {tags}")
    sync_gallery_js()
    return True

@gallery_operation
def update_tags_by_path(path: str, tags: list[str]) -> bool:
    """按原图路径更新标签：云端草稿无法预知本地分配的图片 ID，以路径定位。"""
    media_path(path)
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM photos WHERE path=?", (path,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise ValueError(f"Photo not found: {path}")
    return update_tags(row['id'], tags)


def _download_r2_image(key):
    """从配置的公开媒体存储读取原图。"""
    from . import media_store
    return media_store.get_store().read('public', key)


def _registration_image(path):
    """优先使用已落盘原图，本地读取失败时从公开存储恢复。"""
    local = media_path(path)
    if os.path.exists(local):
        try:
            with open(local, 'rb') as source:
                data = source.read()
            if data:
                return data
        except OSError as error:
            print(f"  [ PHOTOS ] ⚠️ 本地原图读取失败，尝试云端 | Local image unavailable: {type(error).__name__}")
    return _download_r2_image(path)


def _registered_derivative_stem(path, category, name):
    """衍生图沿用原图主文件名，同名冲突使用完整路径摘要。"""
    fallback = hashlib.sha256(path.encode('utf-8')).hexdigest()
    stem = os.path.splitext(name)[0]

    thumb = f'{THUMB_DIR}/{category}/{stem}.webp'
    preview = f'{PREVIEW_DIR}/{category}/{stem}.avif'
    with closing(get_db()) as connection:
        existing = connection.execute('SELECT thumb, preview FROM photos WHERE path=?', (path,)).fetchone()
        if existing and (existing['thumb'] == f'{THUMB_DIR}/{category}/{fallback}.webp' or
                         existing['preview'] == f'{PREVIEW_DIR}/{category}/{fallback}.avif'):
            return fallback
        collision = connection.execute(
            'SELECT 1 FROM photos WHERE path<>? AND (thumb=? COLLATE NOCASE OR preview=? COLLATE NOCASE) LIMIT 1',
            (path, thumb, preview)).fetchone()
    if collision or any((not existing or existing[field] != key) and os.path.exists(media_path(key))
                        for field, key in (('thumb', thumb), ('preview', preview))):
        return fallback
    return stem


def complete_public_derivatives(row, category):
    """公开索引不能用仅存于图片桶的原图替代缩略图或预览图。"""
    path = row['path']
    if all(row.get(field) and row[field] != path for field in ('thumb', 'preview')):
        return row
    operation_status.update('正在生成公开缩略图和预览图')
    stem = _registered_derivative_stem(path, category, path.rsplit('/', 1)[1])
    with open(media_path(path), 'rb') as source, open_upload_image(source.read()) as image:
        thumb, preview = _images.generate_derivatives(image, category, stem)
    from . import media_jobs
    draft = media_jobs.drafts([path]).get(path)
    keys = [thumb, preview]
    if draft:
        for key in keys:
            media_jobs.enqueue('ensure', key, draft['bucketId'], deferred=True)
    elif not DISABLE_R2_SYNC:
        for key in keys:
            media_jobs.enqueue('upload', key, row.get('bucketId') or row.get('bucket_id'))
        # 原图迁回公开的事务提交后再发布新生成的衍生图，失败可重试。
        storage.on_commit(lambda: media_jobs.retry(keys))
    return {**row, 'thumb': thumb, 'preview': preview}


def _save_registered_photo(record):
    """重复登记只修复文件信息，保留既有 ID、标签和排序。"""
    with closing(get_db()) as connection, connection:
        existing = connection.execute("SELECT id FROM photos WHERE path=?", (record['path'],)).fetchone()
        if existing:
            connection.execute("UPDATE photos SET thumb=?, preview=?, hash=?, bucket_id=? WHERE id=?",
                               (record['thumb'], record['preview'], record['hash'], record['bucket_id'], existing['id']))
            return existing['id']
        record['id'] = str(uuid.uuid4())
        record['sort_order'] = top_order(connection, record['category'])
        connection.execute('''INSERT INTO photos
            (id, category, name, path, thumb, preview, hash, created_at, sort_order, tags, bucket_id)
            VALUES (:id, :category, :name, :path, :thumb, :preview, :hash, :created_at, :sort_order, :tags, :bucket_id)''', record)
        return record['id']


@gallery_operation
@storage.transactional
def register_photo(body: JsonObject) -> JsonObject:
    """登记原图并生成衍生图。KV 草稿在本机入库，正式存储留到 Git 发布。"""
    category = media_component(body.get('category') or 'arch')
    raw_path = body.get('path', '')
    safe_name = body.get('name')
    tags = body.get('tags', [])
    from .validation import strings
    strings(tags)

    if not safe_name:
        safe_name = os.path.basename(raw_path.split('?')[0]) if raw_path else f"{int(time.time())}.jpg"
    media_component(safe_name)

    rel_path = to_web_path(f"{BASE_IMAGE_DIR}/{category}/{safe_name}")
    from . import local_media, media_store, media_jobs
    if local_media.is_private(rel_path):
        raise ValueError('图片已设为私密，请先解除私密状态再登记为公开图片')
    operation_status.update('正在拉取云端原图并校验')
    store = media_store.get_store()
    draft = None
    if relay_media.active():
        if raw_path != rel_path:
            raise ValueError('图片草稿路径与分类或文件名不一致')
        draft = relay_media.read(rel_path)
        if draft is None:
            raise ValueError(relay_media.MISSING)
        draft.check_bucket(store)
        assigned = draft.bucket_id
    else:
        # 本地登记可以修复已发布的图片索引。
        assigned = store.bucket_id(rel_path)
    if body.get('bucketId') and body['bucketId'] != assigned:
        raise ValueError('图片的桶代号与存储配置不一致')
    bucket_id = '' if assigned == media_store.DEFAULT_BUCKET else assigned

    _images.prepare_directories(category, safe_name)

    save_path = media_path(rel_path)
    file_data = draft.data if draft else _registration_image(rel_path)
    if not photo_images.HAS_PIL:
        raise RuntimeError('Pillow is required to register cloud images')
    file_hash = hashlib.md5(file_data).hexdigest()
    exif_info = get_exif_datetime(file_data)
    created_at = exif_info[1] if exif_info and exif_info[1] else time.time()
    derived_stem = _registered_derivative_stem(rel_path, category, safe_name)
    with open_upload_image(file_data) as image:
        storage.write_bytes(save_path, file_data)
        operation_status.update('正在生成缩略图和预览图')
        rel_thumb, rel_prev = _images.generate_derivatives(image, category, derived_stem)

    photo_id = _save_registered_photo({
        'category': category, 'name': safe_name, 'path': rel_path, 'thumb': rel_thumb, 'preview': rel_prev,
        'hash': file_hash, 'created_at': created_at, 'tags': json.dumps(tags, ensure_ascii=False),
        'bucket_id': bucket_id
    })

    sync_gallery_js()
    if draft:
        for key in (rel_path, rel_thumb, rel_prev):
            media_jobs.enqueue('ensure', key, assigned, deferred=True, store=store)
        sync = {'state': 'deferred'}
    else:
        sync = _submit_upload(rel_path, rel_thumb, rel_prev, keep_original=True, bucket_id=bucket_id or None)
    print(f"  [ PHOTOS ] ✅ 图片已登记入库: {safe_name}")

    return {
        "status": "success",
        "id": photo_id,
        "path": rel_path,
        "name": safe_name,
        "thumb": rel_thumb,
        "preview": rel_prev,
        "sync": sync,
        **({'bucketId': bucket_id} if bucket_id else {})
    }
