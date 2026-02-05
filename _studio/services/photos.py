
import os
import time
import hashlib
import sqlite3
import json
import uuid

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

# 静态JS文件路径
GALLERY_JSON_FILE = os.path.join(DATA_DIR, 'photos-data.json')

try:
    from PIL import Image, ImageOps 
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("⚠️ [Photos] 未检测到 Pillow 库，图片处理功能受限")

# ================= 数据库工具 =================

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def sync_gallery_js():
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
            "path": row['path'],
            "name": row['name'],
            "thumb": row['thumb'],
            "preview": row['preview'],
            "hash": row['hash']
        }
        data[cat].append(item)
    
    # 写入 JSON 文件
    try:
        with open(GALLERY_JSON_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"✅ [Photos] Gallery JSON 同步成功: {os.path.basename(GALLERY_JSON_FILE)}")
    except Exception as e:
        print(f"❌ [Photos] Gallery JSON 同步失败: {e}")

# ================= 业务逻辑 =================

def to_web_path(path):
    return path.replace('\\', '/')

def handle_upload(query, file_data):
    """处理图片上传请求"""
    category = os.path.basename(query.get('category', ['default'])[0])
    raw_name_input = query.get('name', ['temp.jpg'])[0]
    ext = os.path.splitext(raw_name_input)[1].lower()
    if not ext: ext = '.jpg'
    
    file_hash = hashlib.md5(file_data).hexdigest()
    need_convert = query.get('convert', [''])[0] == 'avif'

    conn = get_db()
    cursor = conn.cursor()

    # 1. 查重逻辑 (秒级)
    cursor.execute("SELECT * FROM photos WHERE hash=? AND category=?", (file_hash, category))
    existing_row = cursor.fetchone()
    
    is_restore = False
    safe_name = ""
    
    if existing_row:
        # Check if physical file exists
        full_existing_path = os.path.join(PROJECT_ROOT, existing_row['path'])
        
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
            return {"status": "success", "msg": "duplicate_found", "path": existing_row['path']}
        else:
            print(f"  [ PHOTOS ] ⚠️  数据库记录存在但物理文件丢失 | DB record exists but file missing, repairing: {existing_row['path']}")
            safe_name = existing_row['name']
            is_restore = True

    # 2. 生成新文件 (如果不是修复模式)
    if not is_restore:
        print(f"  [ PHOTOS ] 📤 上传图片中 | Uploading to category: {category}")
        t_struct = time.localtime()
        base_time_str = time.strftime('%Y%m%d_%H%M%S', t_struct)
        
        counter = 1
        while True:
            final_ext = '.avif' if need_convert else ext
            safe_name = f"{base_time_str}_{counter:02d}{final_ext}"
            
            # 物理路径检查
            check_path = os.path.join(BASE_IMAGE_DIR, category, safe_name)
            if not os.path.exists(check_path):
                break
            counter += 1

    # 3. 创建目录并保存文件 (Disk IO)
    for d in [BASE_IMAGE_DIR, THUMB_DIR, PREVIEW_DIR]:
        os.makedirs(os.path.join(d, category), exist_ok=True)
    
    save_path = os.path.join(BASE_IMAGE_DIR, category, safe_name)
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
                img.save(save_path, "AVIF", quality=70)
            else:
                # If restoring a non-avif file or just uploading raw
                if is_restore and not safe_name.endswith('.avif'):
                     # Just write bytes, assuming original was same format
                     with open(save_path, 'wb') as f: f.write(file_data)
                elif not need_convert:
                     with open(save_path, 'wb') as f: f.write(file_data)
                else: 
                     # Fallback
                     img.save(save_path)

            # B. WebP 缩略图
            thumb_name = os.path.splitext(safe_name)[0] + ".webp"
            thumb_disk_path = os.path.join(THUMB_DIR, category, thumb_name)
            thumb_img = img.copy()
            thumb_img.thumbnail((600, 600))
            if thumb_img.mode in ("RGBA", "P"): thumb_img = thumb_img.convert("RGB")
            thumb_img.save(thumb_disk_path, "WEBP", quality=80)
            rel_thumb = to_web_path(f"{THUMB_DIR}/{category}/{thumb_name}")
            
            # C. 预览大图
            prev_name = os.path.splitext(safe_name)[0] + ".avif"
            prev_disk_path = os.path.join(PREVIEW_DIR, category, prev_name)
            prev_img = img.copy()
            prev_img.thumbnail((2560, 2560))
            prev_img.save(prev_disk_path, "AVIF", quality=70)
            rel_prev = to_web_path(f"{PREVIEW_DIR}/{category}/{prev_name}")

        except Exception as e:
            print(f"⚠️ [Photos] 处理失败，回退到原图: {e}")
            if not os.path.exists(save_path):
                with open(save_path, 'wb') as f: f.write(file_data)
    else:
        with open(save_path, 'wb') as f: f.write(file_data)

    # 4. 插入或更新数据库
    
    # 获取最小 order 用于置顶
    cursor.execute("SELECT MIN(sort_order) FROM photos WHERE category=?", (category,))
    min_order = cursor.fetchone()[0]
    new_order = (min_order if min_order is not None else 0) - 1
    
    if is_restore:
        # Update existing record to bump to top (and ensure paths are correct if we want)
        cursor.execute("UPDATE photos SET sort_order=? WHERE id=?", (new_order, existing_row['id']))
    else:
        new_id = str(uuid.uuid4())
        created_at = time.time()
        cursor.execute('''
            INSERT INTO photos (id, category, name, path, thumb, preview, hash, created_at, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (new_id, category, safe_name, rel_path, rel_thumb, rel_prev, file_hash, created_at, new_order))
    
    conn.commit()
    conn.close()
    
    sync_gallery_js()
    print(f"  [ PHOTOS ] ✅ 处理完成 | Processed: {safe_name}")

    return {
        "status": "success",
        "path": rel_path,
        "name": safe_name,
        "thumb": rel_thumb,
        "preview": rel_prev
    }

def handle_delete(body):
    """处理删除请求"""
    target_path = body.get('path')
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

    # 2. 物理删除文件
    try:
        sys_path = target_path.replace('/', os.sep)
        full_path = os.path.abspath(os.path.join(PROJECT_ROOT, sys_path))
        
        # 删除原图
        if os.path.exists(full_path):
            os.remove(full_path)
            
        # 删除关联图
        # 这里逻辑稍微优化下，直接从 DB 拿 thumb/preview 路径更稳
        for key in ['thumb', 'preview']:
            if row[key] and row[key] != target_path:
                derived_sys = row[key].replace('/', os.sep)
                derived_full = os.path.abspath(os.path.join(PROJECT_ROOT, derived_sys))
                if os.path.exists(derived_full):
                    os.remove(derived_full)
        print(f"  [ PHOTOS ] 🔥 物理文件已粉碎 | Physical files purged: {target_path}")
                    
    except Exception as e:
        print(f"  [ PHOTOS ] ❌ 删除出错 | Delete Error: {e}")
        
    # 3. 数据库删除
    cursor.execute("DELETE FROM photos WHERE id=?", (row['id'],))
    conn.commit()
    conn.close()
    
    sync_gallery_js()
    return {}

def handle_reorder(query, body):
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
        
    except Exception as e:
        print(f"  [ PHOTOS ] ❌ 排序错误 | Reorder Error: {e}")
        conn.rollback()
        
    conn.close()
    sync_gallery_js()
    return {}
