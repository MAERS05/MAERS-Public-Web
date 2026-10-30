"""
照片服务：上传与三级图像流水线、查重、删除、排序、标签与 R2 直传登记。
"""

from __future__ import annotations
from .contracts import JsonObject, Query

import os
import sys
import time
import hashlib
import sqlite3
import json
import uuid
import functools
import re
import posixpath
from urllib.parse import unquote, urlsplit, quote
from . import storage

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
# Moved to services, so go up one level
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


def media_component(value):
    """拒绝路径分隔符、父目录、绝对路径及 Windows 特殊文件名。"""
    if (not isinstance(value, str) or not value or value != value.strip()
            or '..' in value or value.endswith('.') or re.search(r'[\\/:*?"<>|\x00-\x1f]', value)
            or value.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL',
                                            *[f'COM{i}' for i in range(10)],
                                            *[f'LPT{i}' for i in range(10)]}):
        raise ValueError('Invalid media name')
    return value


def media_path(key):
    """所有本地媒体读写都限制在三级图片目录，解析联接后再次检查边界。"""
    if not isinstance(key, str) or '\\' in key:
        raise ValueError('Invalid media path')
    parts = key.split('/')
    if len(parts) != 4 or parts[0] != 'photos' or parts[1] not in ('images', 'thumbnails', 'previews'):
        raise ValueError('Invalid media path')
    media_component(parts[2])
    media_component(parts[3])
    root = os.path.realpath(os.path.join(PROJECT_ROOT, 'photos'))
    boundary = os.path.realpath(os.path.join(PROJECT_ROOT, *parts[:2]))
    path = os.path.realpath(os.path.join(PROJECT_ROOT, *parts))
    if (os.path.commonpath([root, boundary]) != root
            or os.path.commonpath([boundary, path]) != boundary):
        raise ValueError('Media path escapes storage directory')
    return path


def normalize_media_reference(value):
    """按浏览器 URL 语义统一图片引用：先去参数，再解码并消除相对路径片段。"""
    if not value:
        return ''
    path = urlsplit(str(value).replace('\\', '/')).path
    path = posixpath.normpath(unquote(path)).lstrip('/')
    media = re.search(r'(?:^|/)(photos/(?:images|previews|thumbnails)/.*)$', path)
    return media.group(1) if media else path


def media_references(text):
    """收集正文及配置中的图片引用，保留编码空格直至单个 URL 解码。"""
    return re.findall(r'photos/(?:images|thumbnails|previews)/[^\s<>"\x27)\]]+', text)

try:
    from PIL import Image, ImageOps 
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("  [ PHOTOS ] ⚠️ 未检测到 Pillow 库，图片处理功能受限 | Pillow not found")

# ================= 数据库工具 =================

@storage.serialized
def rebuild_cache() -> None:
    """photos-data.json 是图库索引真源；替换式重建丢失、损坏或过期的缓存。"""
    import tempfile
    data = {}
    if os.path.exists(GALLERY_JSON_FILE):
        with open(GALLERY_JSON_FILE, encoding='utf-8') as source:
            data = json.load(source)
    if not isinstance(data, dict) or any(not isinstance(rows, list) for rows in data.values()):
        raise ValueError('Invalid gallery source')
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.gallery-cache-', suffix='.db', dir=os.path.dirname(DB_PATH))
    os.close(fd)
    connection = sqlite3.connect(temporary)
    try:
        connection.execute('''CREATE TABLE photos (id TEXT PRIMARY KEY, category TEXT, name TEXT,
            path TEXT, thumb TEXT, preview TEXT, hash TEXT, created_at REAL, sort_order INTEGER, tags TEXT)''')
        for category, rows in data.items():
            for order, row in enumerate(rows):
                for key in ('path', 'thumb', 'preview'):
                    if row.get(key):
                        media_path(row[key])
                connection.execute('INSERT INTO photos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', (
                    row['id'], category, row['name'], row['path'], row.get('thumb', ''),
                    row.get('preview', ''), row.get('hash', ''), row.get('created_at', 0), order,
                    json.dumps(row.get('tags', []), ensure_ascii=False)))
        connection.commit()
        connection.close()
        os.replace(temporary, DB_PATH)
    finally:
        connection.close()
        if os.path.exists(temporary):
            os.remove(temporary)


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


def get_db():
    if not os.path.exists(DB_PATH):
        rebuild_cache()
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


@storage.serialized
def sync_gallery_js() -> None:
    """从数据库生成静态 JSON 数据供前端读取"""
    conn = get_db()
    cursor = conn.cursor()
    
    # 获取所有图片，按分类分组
    cursor.execute("SELECT * FROM photos ORDER BY sort_order ASC")
    rows = cursor.fetchall()
    conn.close()
    
    data = {}
    for row in rows:
        cat = row['category']
        if cat not in data: data[cat] = []
        
        item = {
            "id": row['id'],
            "path": row['path'],
            "name": row['name'],
            "thumb": row['thumb'],
            "preview": row['preview'],
            "hash": row['hash'],
            "created_at": row['created_at'],
            "tags": json.loads(row['tags']) if row['tags'] else []
        }
        data[cat].append(item)
    
    storage.write_json(GALLERY_JSON_FILE, data)

# ================= 业务逻辑 =================

def to_web_path(path):
    return path.replace('\\', '/')

def get_exif_datetime(file_data):
    """从图片二进制数据中读取 EXIF 拍摄时间，返回 (time_struct, timestamp) 或 None"""
    if not HAS_PIL:
        return None
    try:
        import io
        img = Image.open(io.BytesIO(file_data))
        exif_data = img._getexif()
        if not exif_data:
            return None
        # Tag 36867 = DateTimeOriginal, 36868 = DateTimeDigitized, 306 = DateTime
        for tag_id in (36867, 36868, 306):
            raw = exif_data.get(tag_id)
            if raw:
                t_struct = time.strptime(raw, '%Y:%m:%d %H:%M:%S')
                timestamp = time.mktime(t_struct)
                return (t_struct, timestamp)
    except (OSError, ValueError, TypeError, AttributeError) as e:
        print(f"  [ PHOTOS ] ⚠️  EXIF 读取失败，使用当前时间: {e}")
    return None

def _write_generated(image, path, image_format=None, **options):
    """在内存中完整编码后原子落盘，不把半张衍生图发布到真源。"""
    import io
    image_format = image_format or Image.registered_extensions().get(os.path.splitext(path)[1].lower())
    if not image_format:
        raise ValueError('Unsupported image format')
    output = io.BytesIO()
    image.save(output, image_format, **options)
    storage.write_bytes(path, output.getvalue())


@gallery_operation
@storage.transactional
def handle_upload(query: Query, file_data: bytes) -> JsonObject:
    """处理图片上传请求"""
    category = media_component(query.get('category', ['default'])[0])
    import urllib.parse
    raw_name_input = urllib.parse.unquote(query.get('name', ['temp.jpg'])[0])
    ext = os.path.splitext(raw_name_input)[1].lower()
    if not ext: ext = '.jpg'
    
    file_hash = hashlib.md5(file_data).hexdigest()
    need_convert = query.get('convert', [''])[0] == 'avif'

    conn = get_db()
    try:
        cursor = conn.cursor()

        # 1. 查重逻辑 (秒级)
        cursor.execute("SELECT * FROM photos WHERE hash=? AND category=?", (file_hash, category))
        existing_row = cursor.fetchone()
    
        is_restore = False
        safe_name = ""
    
        if existing_row:
            # Check if physical file exists
            full_existing_path = media_path(existing_row['path'])
        
            if os.path.exists(full_existing_path):
                print(f"  [ PHOTOS ] ♻️  检测到重复图片 ({file_hash}) | Duplicate found, skipping upload.")
                # 移到第一位 (更新 sort_order)
                # 获取当前最小 order
                cursor.execute("SELECT MIN(sort_order) FROM photos WHERE category=?", (category,))
                min_order = cursor.fetchone()[0]
                new_order = (min_order if min_order is not None else 0) - 1
            
                cursor.execute("UPDATE photos SET sort_order=? WHERE id=?", (new_order, existing_row['id']))
                conn.commit()
                conn.close()
            
                sync_gallery_js()
            
                return_path = existing_row['path']
                # 如果要求使用 avif，但数据库原图不是 avif，则直接返回早就作为 preview 生成并落地的 avif 路径。
                if need_convert and not return_path.endswith('.avif'):
                    if existing_row['preview'] and existing_row['preview'].endswith('.avif'):
                        return_path = existing_row['preview']
                    
                sync = {'state': 'disabled'}
                if not DISABLE_R2_SYNC:
                    from . import media_jobs
                    sync = media_jobs.submit('upload', existing_row['path'])
                return {"status": "success", "msg": "duplicate_found", "path": return_path,
                        "id": existing_row['id'], "name": existing_row['name'],
                        "thumb": existing_row['thumb'], "preview": existing_row['preview'], "sync": sync}
            else:
                print(f"  [ PHOTOS ] ⚠️  数据库记录存在但物理文件丢失 | DB record exists but file missing, repairing: {existing_row['path']}")
                safe_name = existing_row['name']
                is_restore = True

        # 2. 生成新文件 (如果不是修复模式)
        if not is_restore:
            print(f"  [ PHOTOS ] 📤 上传图片中 | Uploading to category: {category}")
        
            # 优先使用 EXIF 拍摄时间，降级使用当前系统时间
            exif_result = get_exif_datetime(file_data)
            if exif_result:
                t_struct, exif_timestamp = exif_result
                base_time_str = time.strftime('%Y%m%d_%H%M%S', t_struct)
                print(f"  [ PHOTOS ] 📅 使用 EXIF 拍摄时间: {base_time_str}")
            else:
                t_struct = time.localtime()
                exif_timestamp = None
                base_time_str = time.strftime('%Y%m%d_%H%M%S', t_struct)
                print(f"  [ PHOTOS ] 📅 EXIF 不可用，使用当前时间: {base_time_str}")
        
            # 同一图片的三级文件共用 UUID；扩展名不同也不能复用衍生图编号。
            new_id = str(uuid.uuid4())
            final_ext = '.avif' if need_convert else ext
            safe_name = f"{base_time_str}_{new_id.replace('-', '')}{final_ext}"

        # 3. 创建目录并保存文件 (Disk IO)
        for d in [BASE_IMAGE_DIR, THUMB_DIR, PREVIEW_DIR]:
            os.makedirs(os.path.dirname(media_path(f'{d}/{category}/{safe_name}')), exist_ok=True)
    
        save_path = media_path(f'{BASE_IMAGE_DIR}/{category}/{safe_name}')
        rel_path = to_web_path(f"{BASE_IMAGE_DIR}/{category}/{safe_name}")
        rel_thumb = rel_path
        rel_prev = rel_path

        # 图片处理逻辑 (保持原有)
        if HAS_PIL:
            try:
                import io
                # 如果是修复模式，强行检查是否需要 convert (根据文件名)
                if is_restore and safe_name.endswith('.avif'):
                     # Ensure we try to convert if target is avif, regardless of param (though usually param matches)
                     pass 

                if need_convert:
                    try: import pillow_avif 
                    except ImportError: pass

                img = Image.open(io.BytesIO(file_data))
                img = ImageOps.exif_transpose(img) 

                # A. 原图
                if need_convert or (is_restore and safe_name.endswith('.avif')):
                    _write_generated(img, save_path, "AVIF", quality=70)
                else:
                    # If restoring a non-avif file or just uploading raw
                    if is_restore and not safe_name.endswith('.avif'):
                         # Just write bytes, assuming original was same format
                         storage.write_bytes(save_path, file_data)
                    elif not need_convert:
                         storage.write_bytes(save_path, file_data)
                    else: 
                         # Fallback
                         _write_generated(img, save_path)

                # B. WebP 缩略图
                thumb_name = os.path.splitext(safe_name)[0] + ".webp"
                thumb_disk_path = media_path(f'{THUMB_DIR}/{category}/{thumb_name}')
                thumb_img = img.copy()
                thumb_img.thumbnail((600, 600))
                if thumb_img.mode in ("RGBA", "P"): thumb_img = thumb_img.convert("RGB")
                _write_generated(thumb_img, thumb_disk_path, "WEBP", quality=80)
                rel_thumb = to_web_path(f"{THUMB_DIR}/{category}/{thumb_name}")
            
                # C. 预览大图
                prev_name = os.path.splitext(safe_name)[0] + ".avif"
                prev_disk_path = media_path(f'{PREVIEW_DIR}/{category}/{prev_name}')
                prev_img = img.copy()
                prev_img.thumbnail((2560, 2560))
                _write_generated(prev_img, prev_disk_path, "AVIF", quality=70)
                rel_prev = to_web_path(f"{PREVIEW_DIR}/{category}/{prev_name}")

            except (OSError, ValueError, SyntaxError) as error:
                raise ValueError('图片处理失败，原有数据未改动，请检查图片与本机存储后重试') from error
        else:
            storage.write_bytes(save_path, file_data)

        # 4. 插入或更新数据库
    
        # 获取最小 order 用于置顶
        cursor.execute("SELECT MIN(sort_order) FROM photos WHERE category=?", (category,))
        min_order = cursor.fetchone()[0]
        new_order = (min_order if min_order is not None else 0) - 1
    
        if is_restore:
            # Update existing record to bump to top (and ensure paths are correct if we want)
            cursor.execute("UPDATE photos SET sort_order=? WHERE id=?", (new_order, existing_row['id']))
        else:
            # 优先用 EXIF 时间作为 created_at，降级用当前时间
            created_at = exif_timestamp if exif_timestamp else time.time()
            cursor.execute('''
                INSERT INTO photos (id, category, name, path, thumb, preview, hash, created_at, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (new_id, category, safe_name, rel_path, rel_thumb, rel_prev, file_hash, created_at, new_order))
    
        conn.commit()
        conn.close()
    
        sync_gallery_js()
        print(f"  [ PHOTOS ] ✅ 处理完成 | Processed: {safe_name}")

        # 同步任务先落盘，与加锁迁移共用写锁，失败时返回待同步状态。
        sync = {'state': 'disabled'}
        if not DISABLE_R2_SYNC:
            from . import media_jobs
            sync = media_jobs.submit('upload', rel_path)

        return {
            "status": "success",
            "id": existing_row['id'] if is_restore else new_id,
            "sync": sync,
            "path": rel_path,
            "name": safe_name,
            "thumb": rel_thumb,
            "preview": rel_prev
        }
    finally:
        conn.close()

@gallery_operation
@storage.transactional
def handle_delete(body: JsonObject) -> JsonObject:
    """处理删除请求"""
    target_path = body.get('path')
    media_path(target_path)
    print(f"  [ PHOTOS ] 🗑️  请求删除文件 | Request delete: {target_path}")
    
    conn = get_db()
    cursor = conn.cursor()
    
    # 1. 查是否存在
    cursor.execute("SELECT * FROM photos WHERE path=?", (target_path,))
    row = cursor.fetchone()
    
    if not row:
        print(f"  [ PHOTOS ] ❌ 数据库未找到记录 | Record not found in DB")
        conn.close()
        return {}

    if not DISABLE_R2_SYNC:
        from . import media_jobs
        media_jobs.enqueue('delete', target_path)

    # 2. 物理删除文件
    try:
        full_path = media_path(target_path)
        
        # 删除原图
        if os.path.exists(full_path):
            storage.remove(full_path)
            
        # 删除关联图
        # 这里逻辑稍微优化下，直接从 DB 拿 thumb/preview 路径更稳
        for key in ['thumb', 'preview']:
            if row[key] and row[key] != target_path:
                derived_full = media_path(row[key])
                if os.path.exists(derived_full):
                    storage.remove(derived_full)
        print(f"  [ PHOTOS ] 🔥 物理文件已粉碎 | Physical files purged: {target_path}")
                    
    except OSError as e:
        conn.close()
        print(f"  [ PHOTOS ] ❌ 删除出错 | Delete Error: {e}")
        raise
        
    # 3. 数据库删除
    cursor.execute("DELETE FROM photos WHERE id=?", (row['id'],))
    conn.commit()
    conn.close()
    
    sync_gallery_js()

    result = {}
    if not DISABLE_R2_SYNC:
        storage.on_commit(lambda: result.update(sync=media_jobs.retry([target_path])))
    return result

@gallery_operation
def handle_reorder(query: Query, body: list[JsonObject]) -> JsonObject:
    """处理排序请求"""
    cat_id = query.get('category', [None])[0]
    if not cat_id: return {}
    
    print(f"  [ PHOTOS ] ↕️  图库重排序 | Reordering gallery: {cat_id}")
    
    # body: [ {path: '...'}, ... ]
    # 这意味着前端给的是一个新的顺序列表
    
    conn = get_db()
    cursor = conn.cursor()
    
    # 开启事务加速
    try:
        # 遍历前端发来的列表，直接更新 sort_order
        for index, item in enumerate(body):
            path = item.get('path')
            # 这里的 index 就是新的顺序，0, 1, 2...
            # 我们直接更新数据库
            cursor.execute("UPDATE photos SET sort_order=? WHERE path=? AND category=?", (index, path, cat_id))
        
        conn.commit()
        print(f"  [ PHOTOS ] ✅ 排序完成 | Reorder complete ({len(body)} items)")
        
    except sqlite3.Error as e:
        print(f"  [ PHOTOS ] ❌ 排序错误 | Reorder Error: {e}")
        conn.rollback()
        conn.close()
        raise
        
    conn.close()
    sync_gallery_js()
    return {}

@gallery_operation
def update_tags(photo_id: str, tags: list[str]) -> bool:
    """Update tags for a specific photo"""
    if not photo_id:
        raise ValueError("Photo ID is required")
        
    conn = get_db()
    cursor = conn.cursor()
    
    # Verify existence
    cursor.execute("SELECT id FROM photos WHERE id=?", (photo_id,))
    if not cursor.fetchone():
        conn.close()
        raise ValueError(f"Photo not found: {photo_id}")
        
    tags_json = json.dumps(tags, ensure_ascii=False)
    cursor.execute("UPDATE photos SET tags=? WHERE id=?", (tags_json, photo_id))
    conn.commit()
    conn.close()
    
    print(f"  [ PHOTOS ] 🏷️  Tags Updated: {photo_id} -> {tags}")
    sync_gallery_js()
    return True

def _download_r2_image(key):
    """旧接口名称保留兼容客户端；存取交给可配置的媒体后端。"""
    from . import media_store
    return media_store.get_store().read('public', key)


@gallery_operation
@storage.transactional
def handle_register_r2(body: JsonObject) -> JsonObject:
    """
    处理手机端上传至 Cloudflare R2 后的登记入库请求
    参数: body = {"category": str, "path": str, "name": str, "scope": "public"}
    """
    category = body.get('category')
    raw_path = body.get('path', '')
    safe_name = body.get('name')

    if not category:
        category = 'arch'

    if not safe_name:
        if raw_path:
            safe_name = os.path.basename(raw_path.split('?')[0])
        else:
            safe_name = f"{int(time.time())}.jpg"

    media_component(category)
    media_component(safe_name)

    rel_path = to_web_path(f"{BASE_IMAGE_DIR}/{category}/{safe_name}")

    for d in [BASE_IMAGE_DIR, THUMB_DIR, PREVIEW_DIR]:
        os.makedirs(os.path.dirname(media_path(f'{d}/{category}/{safe_name}')), exist_ok=True)

    save_path = media_path(rel_path)
    rel_thumb = rel_path
    rel_prev = rel_path
    file_hash = ''
    created_at = time.time()

    file_data = None
    if os.path.exists(save_path):
        try:
            with open(save_path, 'rb') as f:
                file_data = f.read()
        except OSError:
            pass

    if not file_data:
        file_data = _download_r2_image(rel_path)
    if not HAS_PIL:
        raise RuntimeError('Pillow is required to register cloud images')
    import io
    file_hash = hashlib.md5(file_data).hexdigest()
    exif_info = get_exif_datetime(file_data)
    if exif_info and exif_info[1]:
        created_at = exif_info[1]
    # 完整原图键（含扩展名）决定衍生编号，旧云端同名混合格式也相互独立。
    # 编号稳定，重复登记不会新增一组文件，也不需要改写已经上传的原图键。
    derived_stem = hashlib.sha256(rel_path.encode('utf-8')).hexdigest()
    with Image.open(io.BytesIO(file_data)) as source:
        img = ImageOps.exif_transpose(source)
        storage.write_bytes(save_path, file_data)
        for directory, extension, size, quality in (
                (THUMB_DIR, 'webp', 600, 80), (PREVIEW_DIR, 'avif', 2560, 70)):
            derived = img.copy()
            derived.thumbnail((size, size))
            if extension == 'webp' and derived.mode in ('RGBA', 'P'):
                derived = derived.convert('RGB')
            buffer = io.BytesIO()
            derived.save(buffer, extension.upper(), quality=quality)
            derived_path = f'{directory}/{category}/{derived_stem}.{extension}'
            storage.write_bytes(media_path(derived_path), buffer.getvalue())
            if extension == 'webp':
                rel_thumb = derived_path
            else:
                rel_prev = derived_path

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM photos WHERE path=?", (rel_path,))
    existing = cursor.fetchone()

    if existing:
        cursor.execute("UPDATE photos SET thumb=?, preview=?, hash=? WHERE id=?", 
                       (rel_thumb, rel_prev, file_hash, existing['id']))
        photo_id = existing['id']
    else:
        cursor.execute("SELECT MIN(sort_order) FROM photos WHERE category=?", (category,))
        min_order = cursor.fetchone()[0]
        new_order = (min_order if min_order is not None else 0) - 1
        photo_id = str(uuid.uuid4())
        cursor.execute('''
            INSERT INTO photos (id, category, name, path, thumb, preview, hash, created_at, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (photo_id, category, safe_name, rel_path, rel_thumb, rel_prev, file_hash, created_at, new_order))

    conn.commit()
    conn.close()

    sync_gallery_js()
    print(f"  [ PHOTOS ] ✅ 已将 R2 图片登记入库: {safe_name}")

    return {
        "status": "success",
        "id": photo_id,
        "path": rel_path,
        "name": safe_name,
        "thumb": rel_thumb,
        "preview": rel_prev
    }
