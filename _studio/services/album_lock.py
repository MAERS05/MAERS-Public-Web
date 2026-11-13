"""
相册分类私密化服务 (album_lock.py)

职责：将相册分类的图片迁移至私有媒体桶（加锁），或迁回公开桶与本机（解锁）。
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
from contextlib import closing
from functools import partial
from pathlib import Path
from dataclasses import dataclass

from . import cms, local_media, photos, media_store, operation_status
import config

IMAGE_PREFIX = 'photos/images/'
MEDIA_FIELDS = ('path', 'thumb', 'preview')
JOB_RETENTION_SECONDS = 600


# ================= 内部工具 =================

def _storage():
    return media_store.get_store()


def _local_path(key):
    return photos.media_path(key)


def collect_keys(rows):
    """汇总图片行涉及的全部文件键（去重，保持顺序）"""
    return list(dict.fromkeys(row[field] for row in rows
                             for field in MEDIA_FIELDS if row.get(field)))


def _public_photo(source, category, read):
    """只为云端私密暂存图分配公开路径，其他图片保持原有地址。"""
    row = dict(source)
    key = row.get('path', '')
    if not key.startswith(f'{IMAGE_PREFIX}_cloud_private/'):
        return row, {}
    data = read(key)
    _, name, _ = photos.new_upload_name(data, os.path.splitext(key)[1].lower(), False)
    stem = os.path.splitext(name)[0]
    original = f'{IMAGE_PREFIX}{category}/{name}'
    mapping = {}
    for field in MEDIA_FIELDS:
        old = row.get(field)
        if not old:
            continue
        photos.media_path(old)
        target = original if old == key else f'photos/{old.split("/")[1]}/{category}/{stem}{os.path.splitext(old)[1]}'
        photos.media_path(target)
        mapping[old] = target
        row[field] = target
    row.update(name=name, category=category, hash=hashlib.md5(data).hexdigest())
    return row, mapping


def public_rows(rows, category, read):
    """云端私密上传解密后归回所属相册，三级文件统一采用时间与 UUID 命名。"""
    category = photos.media_component(category)
    result, mapping = [], {}
    for source in rows:
        row, targets = _public_photo(source, category, read)
        mapping.update(targets)
        result.append(row)
    return result, mapping


def _tag_file(category_id):
    return os.path.join(config.DATA_DIR, 'tags', f'photos-{category_id}-tag-categories.json')


def _media_batches(action, keys):
    with ThreadPoolExecutor(max_workers=8) as executor:
        for offset in range(0, len(keys), 8):
            yield from executor.map(action, keys[offset:offset + 8])


def _rows_of(category_id):
    with closing(photos.get_db()) as connection:
        rows = connection.execute("SELECT * FROM photos WHERE category=? ORDER BY sort_order ASC", (category_id,))
        return [dict(row) for row in rows]


def rows_by_paths(paths):
    """按原图路径查询图片行（CMS 封面图用）"""
    paths = [path for path in (paths or []) if path]
    if not paths:
        return []
    with closing(photos.get_db()) as connection:
        marks = ','.join('?' * len(paths))
        rows = connection.execute(f"SELECT * FROM photos WHERE path IN ({marks})", paths)
        return [dict(row) for row in rows]


def insert_rows(rows, category=None, prepend=False):
    """恢复图片行；prepend 时排在该分类最前（CMS 封面图恢复用）"""
    if not rows:
        return
    with closing(photos.get_db()) as connection, connection:
        for row in rows:
            _insert_photo(connection, row, category, prepend)


def _insert_photo(connection, row, category, prepend):
    category = category or row.get('category')
    row = photos.complete_public_derivatives(row, category)
    sort_order = photos.top_order(connection, category) if prepend else row.get('sort_order')
    tags = row.get('tags')
    if not isinstance(tags, str):
        tags = json.dumps(tags or [], ensure_ascii=False)
    connection.execute("DELETE FROM photos WHERE id=?", (row.get('id'),))
    connection.execute(
        "INSERT INTO photos (id, category, name, path, thumb, preview, hash, created_at, sort_order, tags, bucket_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (row.get('id'), category, row.get('name'), row.get('path'), row.get('thumb'), row.get('preview'),
         row.get('hash'), row.get('created_at') or time.strftime('%Y-%m-%d %H:%M:%S'), sort_order, tags,
         row.get('bucketId') or row.get('bucket_id') or '')
    )


def delete_rows(ids):
    ids = [identity for identity in (ids or []) if identity is not None]
    if not ids:
        return
    with closing(photos.get_db()) as connection, connection:
        connection.executemany("DELETE FROM photos WHERE id=?", [(identity,) for identity in ids])


# ================= 可复用：文件迁移 =================

def _push_private(store, reuse_private, key):
    path = local_media.path(key)
    if path.is_file():
        store.write('private', key, path.read_bytes())
        return key, None
    try:
        data = store.read('public', key)
    except FileNotFoundError:
        if reuse_private and store.exists('private', key):
            return key, store.read('private', key)
        raise
    store.write('private', key, data)
    return key, data


def move_to_private(store, keys, progress=None, reuse_private=False):
    """保留本机原路径，已发布对象迁到私有桶，草稿在发布时写入。"""
    from . import media_jobs
    drafts = media_jobs.drafts(keys)
    for key, job in drafts.items():
        media_jobs.check_target(store, job)
        if not local_media.path(key).is_file():
            raise FileNotFoundError('本机图片草稿缺失')
        # 已尝试公开发布的草稿可能留下对象，先清掉公开版本。
        if job.get('attemptedScope', 'public') == 'public':
            store._delete_remote('public', key, bucket_id=job['bucketId'])
        job['attemptedScope'] = None
        if progress:
            progress()
    media_jobs.replace_drafts(drafts)
    published = [key for key in keys if key not in drafts]
    media_jobs.cancel(published)
    if store.client is None:
        for key in published:
            if not local_media.path(key).is_file():
                raise FileNotFoundError('本机图片缺失')
            if progress:
                progress()
        published = []
    for key, data in _media_batches(partial(_push_private, store, reuse_private), published):
        if data is not None:
            storage.write_bytes(local_media.path(key), data)
        if progress:
            progress()
    local_media.set_private(keys)
    return published


def purge_public(store, keys):
    """删除公开桶里的对象，保留图库原文件。"""
    errors = []
    for key in keys:
        try:
            store.delete('public', key)
        except Exception as error:
            errors.append(error)
    if errors:
        raise errors[0]


def _pull_private(store, public_attempts, targets, key):
    data = store.read_private(key)
    target = targets.get(key, key)
    # 先登记尝试，再上传，响应丢失时也能撤销已公开的对象。
    if public_attempts is not None:
        public_attempts.append(target)
    store.write('public', target, data)
    return target, data


def restore_from_private(store, keys, progress=None, public_attempts=None, restore_local=True, targets=None):
    """先验证所有路径，从私有副本恢复，最后才由外层提交安排清理。"""
    from . import media_jobs
    targets = targets or {}
    for key in keys:
        local_media.path(key)
    drafts = media_jobs.drafts(keys)
    published = [key for key in keys if key not in drafts]
    if not restore_local and drafts:
        raise ValueError('待发布图片不能参与远端恢复')
    cleanup = []
    for key, job in drafts.items():
        media_jobs.check_target(store, job)
        target = targets.get(key, key)
        source = local_media.path(key)
        if not source.is_file():
            raise FileNotFoundError('本机图片草稿缺失')
        if target != key:
            local_media.keep(target, source.read_bytes())
            storage.remove(source)
        if job.get('attemptedScope', 'private') == 'private':
            cleanup.append(key)
        job.pop('group', None)
        job.pop('groups', None)
        job.pop('tokens', None)
        job.update(key=target, attemptedScope=None)
        if progress:
            progress()
    media_jobs.replace_drafts(drafts)
    if cleanup:
        storage.on_commit(lambda: purge_private(store, cleanup))
    for source, target in targets.items():
        if source not in drafts and store.bucket_groups:
            store.claim_bucket(target, store.bucket_id(source))
    if store.client is None:
        restored = ((targets.get(key, key), store.read('private', key)) for key in published)
    else:
        restored = _media_batches(partial(_pull_private, store, public_attempts, targets), published)
    for key, data in restored:
        if restore_local:
            path = local_media.path(key)
            if not path.is_file():
                storage.write_bytes(path, data)
        if progress:
            progress()
    if restore_local:
        local_media.set_private(keys, False)


def rollback_to_public(store, keys):
    """本地文件回滚后恢复公开三级图片，保留私有副本供重试。"""
    try:
        restore_from_private(store, keys, restore_local=False)
    finally:
        photos.rebuild_cache()


def rollback_to_private(store, public_attempts):
    try:
        purge_public(store, public_attempts)
    finally:
        photos.rebuild_cache()


def purge_private(store, keys, *, remove_local=False):
    from . import media_jobs
    drafts = {key: job for key, job in media_jobs.drafts(keys).items() if media_jobs.draft_groups(job)}
    media_jobs.cancel(drafts)
    protected = local_media.private_keys() if remove_local else {}
    removed = []
    failed = 0
    for index, key in enumerate(keys):
        operation_status.update('正在清理已迁回的私有副本', index, len(keys))
        try:
            if store.client is not None and (key not in drafts or drafts[key].get('attemptedScope', 'private') == 'private'):
                store.delete('private', key)
            if local_media.is_private(key, protected):
                storage.remove(local_media.path(key))
                removed.append(key)
        except Exception as error:
            failed += 1
            print(f"  [ ALBUM-LOCK ] ⚠️ 私有副本清理待重试 | Private cleanup pending: {error}")
    local_media.set_private(removed, False)
    message = f'有 {failed} 个私有副本清理待重试' if failed else '私有副本清理完成'
    operation_status.update(message, len(keys), len(keys))


# ================= 后台任务 =================

_jobs = {}
_job_lock = threading.Lock()   # 同一时间只允许一个迁移任务


def _run_job(action, progress):
    try:
        with storage.LOCK:
            photos.rebuild_cache()
            return action(progress)
    except media_store.MediaAccessError as error:
        return 403, {'error': str(error)}
    except Exception as error:
        return internal_error(error, "album background job")


class _AlbumJob:
    """单次迁移的进度和执行入口，任务成功或失败均释放互斥锁。"""

    def __init__(self, total, action, message):
        self.identity = uuid.uuid4().hex[:12]
        self.data = {"id": self.identity, "done": 0, "total": total, "state": "running", "result": None}
        self.action = action
        self.counter = threading.Lock()
        self.operation = operation_status.start()
        self.data['operation'] = self.operation
        self.message = message
        operation_status.update(message, 0, total, identity=self.operation)

    def progress(self):
        with self.counter:
            self.data['done'] += 1
            operation_status.update(self.message, self.data['done'], self.data['total'], identity=self.operation)

    def run(self):
        try:
            with operation_status.bind(self.operation):
                code, data = _run_job(self.action, self.progress)
            self.data.update(result=data, state="success" if code == 200 else "error", finished_at=time.time())
        finally:
            operation_status.finish(self.operation, self.data['state'] == 'success')
            _job_lock.release()


def _start_job(total, action, message='正在迁移相册图片'):
    """创建和启动共同构成失败边界，任务尚未进入线程也不能泄漏互斥锁。"""
    if not _job_lock.acquire(blocking=False):
        return 409, {"error": "已有迁移任务在进行，请稍候"}
    job = None
    try:
        job = _AlbumJob(total, action, message)
        _jobs[job.identity] = job.data
        threading.Thread(target=job.run).start()
    except Exception as error:
        if job is not None:
            _jobs.pop(job.identity, None)
            operation_status.finish(job.operation, False)
        _job_lock.release()
        return internal_error(error, "album background startup")
    return 200, {"status": "started", "job": job.identity, "total": total}


def _prune_jobs(keep_id):
    """回收过期的完成记录，保留正在查询的任务供前端读取结果。"""
    now = time.time()
    expired = [identity for identity, item in tuple(_jobs.items())
               if item.get('finished_at') and now - item['finished_at'] > JOB_RETENTION_SECONDS]
    for identity in expired:
        if identity != keep_id:
            _jobs.pop(identity, None)


def job_status(job_id):
    job = _jobs.get(job_id)
    if not job:
        return 404, {"error": "任务不存在"}
    _prune_jobs(job_id)
    result = {key: value for key, value in job.items() if key != 'operation'}
    progress = operation_status.snapshot(job.get('operation'))
    if progress:
        result.update({key: progress[key] for key in ('message', 'done', 'total')})
    return 200, result


# ================= 对外：导出 / 加锁 / 解锁 =================

@storage.serialized
def export_category(category_id):
    """导出分类的配置记录、图片行与标签文件内容，供前端加密打包"""
    categories = cms.load_json(config.ALBUM_CONFIG_JSON) or []
    record = next((item for item in categories if item.get('id') == category_id), None)
    if not record:
        return 404, {"error": f"分类不存在: {category_id}"}

    tags_path = Path(_tag_file(category_id))
    tags_file = tags_path.read_text(encoding='utf-8') if tags_path.exists() else None

    photos.rebuild_cache()
    rows = _rows_of(category_id)
    snapshot = {"category": record, "photos": rows, "tags_file": tags_file}
    revision = hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, sort_keys=True,
                                         separators=(',', ':')).encode('utf-8')).hexdigest()
    return 200, {"status": "success", **snapshot, "revision": revision, "file_count": len(collect_keys(rows))}


@dataclass(frozen=True)
class _CategoryLock:
    """后台加锁请求；发布时仍须校验导出版本，避免排队期间覆盖较新的内容。"""
    category_id: str
    envelope: dict
    expected_revision: str
    token_hash: str | None
    group_dek_id: str | None


def _category_lock_request(category_id, enc, expected_revision, group):
    """启动任务前验证密文归属，并记录任务提交时使用的组密钥版本。"""
    from . import crypto_keyring, private_session
    crypto_keyring.require_content_group(group)
    envelope = {"_enc": enc, **({'_group': group} if group != 'default' else {})}
    if group == 'default':
        return _CategoryLock(category_id, envelope, expected_revision, None, None)
    payload = private_session.crypt('decrypt', [enc], group)[0]
    if payload.get('category', {}).get('id') != category_id:
        raise ValueError('加密载荷与相册不匹配')
    token_hash = private_session.group_token_hash(group)
    group_dek_id = crypto_keyring.group_ring(group)['dek_id']
    return _CategoryLock(category_id, envelope, expected_revision, token_hash, group_dek_id)


@storage.serialized
def lock_category(category_id, enc, expected_revision, group='default'):
    """加锁：文件迁入私有桶，校验后清除公开侧数据，并以 {_enc} 替换配置记录（后台任务）"""
    if not category_id or not enc or not expected_revision:
        return 400, {"error": "缺少分类、密文或内容版本，请刷新后重试"}
    request = _category_lock_request(category_id, enc, expected_revision, group)
    categories = cms.load_json(config.ALBUM_CONFIG_JSON) or []
    if not any(item.get('id') == category_id for item in categories):
        return 404, {"error": f"分类不存在: {category_id}"}
    try:
        store = _storage()
    except (OSError, ValueError, RuntimeError) as error:
        return internal_error(error, "album storage initialization")

    photos.rebuild_cache()
    keys = collect_keys(_rows_of(category_id))
    from . import media_jobs
    drafts = media_jobs.drafts(keys)
    published = next((key for key in keys if key not in drafts), None)
    # 必须能够读取私有副本才能校验上传；权限不足时不启动迁移任务。
    if published:
        try:
            store.exists('private', published)
        except media_store.MediaAccessError as error:
            return 403, {'error': str(error)}

    work = partial(_lock_category, store, request)
    return _start_job(len(keys), work)


def _delete_category_rows(category):
    with closing(photos.get_db()) as connection, connection:
        connection.execute("DELETE FROM photos WHERE category=?", (category,))


def _replace_category(field, identity, record):
    """任务发布时重新读取配置，精确替换当前目标记录。"""
    current = cms.load_json(config.ALBUM_CONFIG_JSON) or []
    index = next((index for index, item in enumerate(current) if item.get(field) == identity), None)
    if index is None:
        raise ValueError('分类记录已改变，请刷新后重试')
    current[index] = record
    cms.save_json(config.ALBUM_CONFIG_JSON, current)


def _lock_snapshot(request):
    status, snapshot = export_category(request.category_id)
    if status != 200 or snapshot['revision'] != request.expected_revision:
        raise ValueError('分类内容已变化，请重新打包加锁；原数据未删除')
    return snapshot


def _publish_locked_category(category, envelope):
    _delete_category_rows(category)
    storage.remove(_tag_file(category))
    _replace_category('id', category, envelope)
    photos.sync_gallery_js()


@storage.transactional
def _lock_category(store, request, progress):
    category = request.category_id
    snapshot = _lock_snapshot(request)
    store.verify_photo_rows(snapshot['photos'])
    keys = collect_keys(snapshot['photos'])
    from . import media_groups, crypto_keyring
    group = request.envelope.get('_group', 'default')
    if request.group_dek_id is not None:
        current_group = crypto_keyring.group_ring(group) or {}
        if current_group.get('dek_id') != request.group_dek_id:
            return 409, {'error': '相册密码组已变化，请刷新后重新加密'}
    media_groups.assign(keys, group, token_hash=request.token_hash, replace=True, store=store)
    print(f"  [ ALBUM-LOCK ] 🔒 开始迁移 {category}: {len(keys)} 个文件 | Moving album to private storage")
    # 迁移异常必须穿过事务边界，先恢复权限记录，再由后台任务返回公开错误。
    published = move_to_private(store, keys, progress, reuse_private=True)

    if published:
        storage.compensate(store.recovery_record('restore_public', published), lambda: rollback_to_public(store, published))
        purge_public(store, published)
    _publish_locked_category(category, request.envelope)
    print(f"  [ ALBUM-LOCK ] ✅ 已加锁 | Album locked: {category}")
    return 200, {"status": "success", "moved": len(keys)}


@storage.serialized
def unlock_category(enc, payload):
    """解锁：文件迁回公开桶与仓库，恢复数据库行、标签文件与配置记录，清除私有桶副本（后台任务）"""
    record = (payload or {}).get('category') or {}
    rows = (payload or {}).get('photos') or []
    category_id = record.get('id')
    if not enc or not category_id:
        return 400, {"error": "载荷无效"}
    categories = cms.load_json(config.ALBUM_CONFIG_JSON) or []
    if not any(item.get('_enc') == enc for item in categories):
        return 404, {"error": "未找到对应的加密分类记录"}
    try:
        store = _storage()
    except (OSError, ValueError, RuntimeError) as error:
        return internal_error(error, "album storage initialization")

    return _start_job(len(collect_keys(rows)), partial(_unlock_category, store, enc, payload), '正在恢复公开图片')


def _publish_restored_category(enc, payload, rows):
    category = payload['category']['id']
    operation_status.update('正在保存相册与图片索引')
    _delete_category_rows(category)
    insert_rows(rows, category=category)
    if payload.get('tags_file') is not None:
        storage.write_text(_tag_file(category), payload['tags_file'])
    _replace_category('_enc', enc, payload['category'])
    photos.sync_gallery_js()


def _queue_old_public_cleanup(targets):
    """暂存地址的清理跟随外层事务提交，失败时不撤销可用于恢复的私有源。"""
    if not targets:
        return
    from . import media_jobs
    for old in targets:
        storage.remove(_local_path(old))
        media_jobs.enqueue('delete', old)
    storage.on_commit(lambda: media_jobs.retry(list(targets)))


@storage.transactional
def _unlock_category(store, enc, payload, progress):
    category = payload['category']['id']
    rows = payload.get('photos') or []
    store.verify_photo_rows(rows)
    keys = collect_keys(rows)
    from . import media_jobs
    drafts = media_jobs.drafts(keys)
    published = [key for key in keys if key not in drafts]
    rows, targets = public_rows(rows, category, store.read_private)
    public_keys = [targets.get(key, key) for key in published]
    print(f"  [ ALBUM-LOCK ] 🔓 开始恢复 {category}: {len(keys)} 个文件 | Restoring album")
    public_attempts = []
    if public_keys and store.client is not None:
        storage.compensate(store.recovery_record('retract_public', public_keys), lambda: rollback_to_private(store, public_attempts))
    restore_from_private(store, keys, progress, public_attempts=public_attempts, targets=targets)
    _publish_restored_category(enc, payload, rows)
    _queue_old_public_cleanup({key: targets[key] for key in published if key in targets})
    if published:
        storage.on_commit(lambda: purge_private(store, published))
    print(f"  [ ALBUM-LOCK ] ✅ 已解锁 | Album unlocked: {category}")
    return 200, {"status": "success", "restored": len(keys)}


def handle(path, body):
    """路由分发"""
    try:
        if path == '/api/album/export_category':
            return export_category(body.get('id'))
        if path == '/api/album/lock_category':
            return lock_category(body.get('id'), body.get('enc'), body.get('expected_revision'), body.get('group', 'default'))
        if path == '/api/album/unlock_category':
            return unlock_category(body.get('enc'), body.get('payload'))
        if path == '/api/album/job':
            return job_status(body.get('id'))
    except (OSError, ValueError, RuntimeError) as error:
        return internal_error(error, "album request")
    return 404, {"error": "unknown"}
