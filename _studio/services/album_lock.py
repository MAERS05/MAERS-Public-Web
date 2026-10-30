"""
相册分类私密化服务 (album_lock.py)

职责：将相册分类的图片迁移至私有 R2 桶（加锁），或迁回公开桶与仓库（解锁）。
加密载荷由前端生成（主密码不经过后端），后端只负责：
  - 导出分类的数据库行与标签文件（供前端打包加密）
  - 迁移物理文件（原图 / 缩略图 / 预览图）并更新数据库、配置、标签文件
  - 提供可复用的「迁入私有桶 / 迁回公开侧」函数（CMS 封面图共用）

安全顺序：先上传 -> 校验 -> 再删除；删除或发布失败则回滚并保留私有副本供重试。
大分类以后台任务执行，前端轮询 /api/album/job 获取进度。
"""

from .errors import internal_error
import os
import json
import hashlib
import time
import uuid
from . import storage
import threading
from concurrent.futures import ThreadPoolExecutor

from . import cms, photos, media_store
import config

IMAGE_PREFIX = 'photos/images/'


# ================= 内部工具 =================

def _storage():
    return media_store.get_store()


def _local_path(key):
    return photos.media_path(key)


def collect_keys(rows):
    """汇总图片行涉及的全部文件键（去重，保持顺序）"""
    keys = []
    for r in rows:
        for k in (r.get('path'), r.get('thumb'), r.get('preview')):
            if k and k not in keys:
                keys.append(k)
    return keys


def _tag_file(cat_id):
    return os.path.join(config.DATA_DIR, 'tags', f'photos-{cat_id}-tag-categories.json')


def _run_parallel(fn, items, progress=None, workers=8):
    """并发执行，任一失败则抛出首个异常；每完成一项调用 progress()"""
    def _wrapped(item):
        fn(item)
        if progress:
            progress()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for _ in ex.map(_wrapped, items):
            pass


def _rows_of(cat_id):
    conn = photos.get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM photos WHERE category=? ORDER BY sort_order ASC", (cat_id,))
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def rows_by_paths(paths):
    """按原图路径查询图片行（CMS 封面图用）"""
    paths = [p for p in (paths or []) if p]
    if not paths:
        return []
    conn = photos.get_db()
    try:
        cur = conn.cursor()
        marks = ','.join('?' * len(paths))
        cur.execute(f"SELECT * FROM photos WHERE path IN ({marks})", paths)
        return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def insert_rows(rows, category=None, prepend=False):
    """恢复图片行；prepend 时排在该分类最前（CMS 封面图恢复用）"""
    if not rows:
        return
    conn = photos.get_db()
    try:
        for r in rows:
            cat = category or r.get('category')
            sort_order = r.get('sort_order')
            if prepend:
                cur = conn.execute("SELECT MIN(sort_order) FROM photos WHERE category=?", (cat,))
                m = cur.fetchone()[0]
                sort_order = (m if m is not None else 0) - 1
            conn.execute("DELETE FROM photos WHERE id=?", (r.get('id'),))
            conn.execute(
                "INSERT INTO photos (id, category, name, path, thumb, preview, hash, created_at, sort_order, tags) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (r.get('id'), cat, r.get('name'), r.get('path'), r.get('thumb'), r.get('preview'),
                 r.get('hash'), r.get('created_at') or time.strftime('%Y-%m-%d %H:%M:%S'),
                 sort_order, r.get('tags') if isinstance(r.get('tags'), str) else json.dumps(r.get('tags') or [], ensure_ascii=False))
            )
        conn.commit()
    finally:
        conn.close()


def delete_rows(ids):
    ids = [i for i in (ids or []) if i is not None]
    if not ids:
        return
    conn = photos.get_db()
    try:
        conn.executemany("DELETE FROM photos WHERE id=?", [(i,) for i in ids])
        conn.commit()
    finally:
        conn.close()


# ================= 可复用：文件迁移 =================

def move_to_private(store, keys, progress=None, reuse_private=False):
    """校验私有副本内容后才允许清除公开源；支持可替换的媒体后端。"""
    def push(key):
        local = _local_path(key)
        if os.path.isfile(local):
            with open(local, 'rb') as source:
                data = source.read()
        else:
            try:
                data = store.read('public', key)
            except FileNotFoundError:
                if reuse_private and store.exists('private', key):
                    return
                raise
        store.write('private', key, data)
    _run_parallel(push, keys, progress)


def purge_public(store, keys, remove_local=True):
    """在共享写锁内删除公开对象，并撤销尚未完成的公开上传任务。"""
    from . import media_jobs
    if remove_local:
        media_jobs.cancel(keys)
    errors = []
    for key in keys:
        if key.startswith(IMAGE_PREFIX):
            try:
                store.delete('public', key)
            except Exception as error:
                errors.append(error)
        if remove_local:
            storage.remove(_local_path(key))
    if errors:
        raise errors[0]


def restore_from_private(store, keys, progress=None, public_attempts=None, restore_local=True):
    """先验证所有路径，从私有副本恢复，最后才由外层提交安排清理。"""
    local_paths = {key: _local_path(key) for key in keys}
    def pull(key):
        data = store.read('private', key)
        if key.startswith(IMAGE_PREFIX):
            if public_attempts is not None:
                public_attempts.append(key)
            store.write('public', key, data)
        return key, data
    with ThreadPoolExecutor(max_workers=8) as executor:
        for offset in range(0, len(keys), 8):
            for key, data in executor.map(pull, keys[offset:offset + 8]):
                if restore_local:
                    local = local_paths[key]
                    if not (key.startswith(IMAGE_PREFIX) and os.path.exists(local)):
                        storage.write_bytes(local, data)
                if progress:
                    progress()


def rollback_to_public(store, keys):
    """本地文件回滚后恢复公开原图，保留私有副本供重试。"""
    try:
        restore_from_private(store, [key for key in keys if key.startswith(IMAGE_PREFIX)], restore_local=False)
    finally:
        photos.rebuild_cache()


def rollback_to_private(store, public_attempts):
    try:
        purge_public(store, public_attempts, remove_local=False)
    finally:
        photos.rebuild_cache()


def purge_private(store, keys):
    for key in keys:
        try:
            store.delete('private', key)
        except Exception as error:
            print(f"  [ ALBUM-LOCK ] ⚠️ 私有副本清理待重试 | Private cleanup pending: {error}")


# ================= 后台任务 =================

_jobs = {}
_job_lock = threading.Lock()   # 同一时间只允许一个迁移任务


def _start_job(total, fn):
    """启动后台任务，fn(progress) 返回 (code, data)"""
    if not _job_lock.acquire(blocking=False):
        return 409, {"error": "已有迁移任务在进行，请稍候"}
    job_id = uuid.uuid4().hex[:12]
    job = {"id": job_id, "done": 0, "total": total, "state": "running", "result": None}
    _jobs[job_id] = job
    counter = threading.Lock()

    def progress():
        with counter:
            job["done"] += 1

    def runner():
        try:
            with storage.LOCK:
                photos.rebuild_cache()
                code, data = fn(progress)
        except media_store.MediaAccessError as e:
            code, data = 403, {'error': str(e)}
        except Exception as e:
            code, data = internal_error(e, "album background job")
        job["result"] = data
        job["state"] = "success" if code == 200 else "error"
        job["finished_at"] = time.time()
        _job_lock.release()

    threading.Thread(target=runner, daemon=True).start()
    return 200, {"status": "started", "job": job_id, "total": total}


def job_status(job_id):
    job = _jobs.get(job_id)
    if not job:
        return 404, {"error": "任务不存在"}
    # 清理 10 分钟前完成的任务
    now = time.time()
    for k in [k for k, j in _jobs.items() if j.get('finished_at') and now - j['finished_at'] > 600]:
        if k != job_id:
            _jobs.pop(k, None)
    return 200, job


# ================= 对外：导出 / 加锁 / 解锁 =================

@storage.serialized
def export_category(cat_id):
    """导出分类的配置记录、图片行与标签文件内容，供前端加密打包"""
    conf = cms.load_json(config.ALBUM_CONFIG_JSON) or []
    record = next((c for c in conf if c.get('id') == cat_id), None)
    if not record:
        return 404, {"error": f"分类不存在: {cat_id}"}

    tags_file = None
    tf = _tag_file(cat_id)
    if os.path.exists(tf):
        with open(tf, 'r', encoding='utf-8') as f:
            tags_file = f.read()

    photos.rebuild_cache()
    rows = _rows_of(cat_id)
    snapshot = {"category": record, "photos": rows, "tags_file": tags_file}
    revision = hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, sort_keys=True,
                                         separators=(',', ':')).encode('utf-8')).hexdigest()
    return 200, {"status": "success", **snapshot, "revision": revision, "file_count": len(collect_keys(rows))}


@storage.serialized
def lock_category(cat_id, enc, expected_revision):
    """加锁：文件迁入私有桶，校验后清除公开侧数据，并以 {_enc} 替换配置记录（后台任务）"""
    if not cat_id or not enc or not expected_revision:
        return 400, {"error": "缺少分类、密文或内容版本，请刷新后重试"}
    conf = cms.load_json(config.ALBUM_CONFIG_JSON) or []
    if not any(c.get('id') == cat_id for c in conf):
        return 404, {"error": f"分类不存在: {cat_id}"}
    try:
        store = _storage()
    except (OSError, ValueError, RuntimeError) as e:
        return internal_error(e, "album_lock.py")

    photos.rebuild_cache()
    keys = collect_keys(_rows_of(cat_id))
    # 必须能够读取私有副本才能校验上传；权限不足时不启动迁移任务。
    if keys:
        try:
            store.exists('private', keys[0])
        except media_store.MediaAccessError as e:
            return 403, {'error': str(e)}

    @storage.transactional
    def work(progress):
        status, snapshot = export_category(cat_id)
        if status != 200 or snapshot['revision'] != expected_revision:
            raise ValueError('分类内容已变化，请重新打包加锁；原数据未删除')
        keys = collect_keys(_rows_of(cat_id))
        print(f"  [ ALBUM-LOCK ] 🔒 开始迁移 {cat_id}: {len(keys)} 个文件 -> 私有存储")
        try:
            move_to_private(store, keys, progress, reuse_private=True)
        except media_store.MediaAccessError as e:
            return 403, {'error': str(e)}
        except Exception as e:
            return internal_error(e, "album lock", "迁移失败，原始数据已保留")

        storage.compensate(store.recovery_record('restore_public', keys), lambda: rollback_to_public(store, keys))
        purge_public(store, keys)
        conn = photos.get_db()
        conn.execute("DELETE FROM photos WHERE category=?", (cat_id,))
        conn.commit()
        conn.close()
        tf = _tag_file(cat_id)
        storage.remove(tf)

        # 重新读取配置，避免覆盖任务期间的其他修改
        cur = cms.load_json(config.ALBUM_CONFIG_JSON) or []
        idx = next((i for i, c in enumerate(cur) if c.get('id') == cat_id), -1)
        if idx < 0:
            raise ValueError('分类记录已改变，请刷新后重试')
        cur[idx] = {"_enc": enc}
        cms.save_json(config.ALBUM_CONFIG_JSON, cur)
        photos.sync_gallery_js()
        print(f"  [ ALBUM-LOCK ] ✅ 已加锁 {cat_id}")
        return 200, {"status": "success", "moved": len(keys)}

    return _start_job(len(keys), work)


@storage.serialized
def unlock_category(enc, payload):
    """解锁：文件迁回公开桶与仓库，恢复数据库行、标签文件与配置记录，清除私有桶副本（后台任务）"""
    record = (payload or {}).get('category') or {}
    rows = (payload or {}).get('photos') or []
    tags_file = (payload or {}).get('tags_file')
    cat_id = record.get('id')
    if not enc or not cat_id:
        return 400, {"error": "载荷无效"}
    conf = cms.load_json(config.ALBUM_CONFIG_JSON) or []
    if not any(c.get('_enc') == enc for c in conf):
        return 404, {"error": "未找到对应的加密分类记录"}
    try:
        store = _storage()
    except (OSError, ValueError, RuntimeError) as e:
        return internal_error(e, "album_lock.py")

    keys = collect_keys(rows)

    @storage.transactional
    def work(progress):
        print(f"  [ ALBUM-LOCK ] 🔓 开始恢复 {cat_id}: {len(keys)} 个文件")
        public_attempts = []
        storage.compensate(store.recovery_record('retract_public', keys), lambda: rollback_to_private(store, public_attempts))
        restore_from_private(store, keys, progress, public_attempts=public_attempts)

        conn = photos.get_db()
        conn.execute("DELETE FROM photos WHERE category=?", (cat_id,))
        conn.commit()
        conn.close()
        insert_rows(rows, category=cat_id)

        if tags_file is not None:
            os.makedirs(os.path.dirname(_tag_file(cat_id)), exist_ok=True)
            storage.write_text(_tag_file(cat_id), tags_file)
        cur = cms.load_json(config.ALBUM_CONFIG_JSON) or []
        idx = next((i for i, c in enumerate(cur) if c.get('_enc') == enc), -1)
        if idx < 0:
            raise ValueError('加密分类记录已改变，请刷新后重试')
        cur[idx] = record
        cms.save_json(config.ALBUM_CONFIG_JSON, cur)
        photos.sync_gallery_js()

        # 最后才清理私有桶副本
        storage.on_commit(lambda: purge_private(store, keys))
        print(f"  [ ALBUM-LOCK ] ✅ 已解锁 {cat_id}")
        return 200, {"status": "success", "restored": len(keys)}

    return _start_job(len(keys), work)


def handle(path, body):
    """路由分发"""
    try:
        if path == '/api/album/export_category':
            return export_category(body.get('id'))
        if path == '/api/album/lock_category':
            return lock_category(body.get('id'), body.get('enc'), body.get('expected_revision'))
        if path == '/api/album/unlock_category':
            return unlock_category(body.get('enc'), body.get('payload'))
        if path == '/api/album/job':
            return job_status(body.get('id'))
    except (OSError, ValueError, RuntimeError) as e:
        return internal_error(e, "album_lock.py")
    return 404, {"error": "unknown"}
