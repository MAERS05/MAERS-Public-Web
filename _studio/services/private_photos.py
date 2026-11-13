"""加密相册的内存编辑与私有上传，修改后直接重封装相册密文，不生成公开图片。"""
import copy
import hashlib
import io
import json
import os
import time
from . import private_session, media_store, storage, operation_status


def entry(category):
    return private_session.albums().get(category)


def check_upload_target(category):
    """部分解锁时，不能将未知的相册分类误作公开上传目标。"""
    from . import crypto_keyring
    if not private_session.active() or 'groups' not in (crypto_keyring._read(crypto_keyring.KEYRING_FILE) or {}):
        return
    if category in ('_notes', '_record', '_games', '_videos', '_literature', 'gamecovers', 'literaturecovers', 'videocovers'):
        return
    from . import cms
    from config import ALBUM_CONFIG_JSON
    categories = cms.load_json(ALBUM_CONFIG_JSON) or []
    if any(item.get('id') == category for item in categories):
        return
    if any(item.get('_enc') for item in categories):
        raise PermissionError('请先解锁相册所属密码组再上传')


def _tags(row):
    value = row.get('tags', [])
    return json.loads(value) if isinstance(value, str) and value else value or []


def tags(category, value=None):
    found = entry(category)
    if not found:
        check_upload_target(category)
        return None
    payload = copy.deepcopy(found['payload'])
    if value is None:
        return json.loads(payload.get('tags_file') or '[]')
    payload['tags_file'] = json.dumps(value, ensure_ascii=False)
    private_session.save_album(category, payload)
    return True


def _save_rows(category, rows):
    payload = copy.deepcopy(entry(category)['payload'])
    payload['photos'] = rows
    private_session.save_album(category, payload)


@storage.transactional
def upload(query, data):
    if query.get('module') or query.get('node_id'):
        from . import private_cms
        return private_cms.upload(query, data)
    from . import photos
    category = photos.media_component(query.get('category', [''])[0])
    found = entry(category)
    if not found:
        return None
    rows = copy.deepcopy(found['payload']['photos'])
    digest = hashlib.md5(data).hexdigest()
    duplicate = next((row for row in rows if row.get('hash') == digest), None)
    if duplicate:
        rows.remove(duplicate)
        rows.insert(0, duplicate)
        _save_rows(category, rows)
        return {**duplicate, 'status': 'success', 'msg': 'duplicate_found', 'sync': {'state': 'complete'}}
    row = store_image(category, data, query.get('name', ['image.png'])[0], group=found['group'],
                      bucket_id=query.get('bucketId', [None])[0], fallback_label=query.get('dateLabel', [None])[0])
    _save_rows(category, [row, *rows])
    return {**row, 'status': 'success', 'sync': {'state': 'complete'}}


@storage.transactional
def register(body):
    """将普通上传草稿合并到当前私密相册，正文索引与三级图片共用私密保存事务。"""
    from . import photos, relay_media
    from .validation import strings
    category = photos.media_component(body['category'])
    found = entry(category)
    if not found:
        return None
    if not relay_media.active():
        raise ValueError('此相册已加密，请通过本地上传或云端草稿合并添加图片')
    name = photos.media_component(body.get('name') or os.path.basename(body['path']))
    path = f'photos/images/{category}/{name}'
    if body['path'] != path:
        raise ValueError('图片草稿路径与分类或文件名不一致')
    tags = body.get('tags', [])
    strings(tags)
    draft = relay_media.read(path)
    if draft is None:
        raise ValueError(relay_media.MISSING)
    store = media_store.get_store()
    draft.check_bucket(store)
    if body.get('bucketId') and body['bucketId'] != draft.bucket_id:
        raise ValueError('图片草稿的桶组与登记信息不一致')
    rows = copy.deepcopy(found['payload']['photos'])
    digest = hashlib.md5(draft.data).hexdigest()
    row = next((item for item in rows if item.get('hash') == digest), None)
    if row:
        rows.remove(row)
        row['tags'] = list(dict.fromkeys([*_tags(row), *tags]))
    else:
        row = store_image(category, draft.data, name, group=found['group'], bucket_id=draft.bucket_id)
        row['tags'] = tags
    _save_rows(category, [row, *rows])
    return {**row, 'status': 'success', 'sync': {'state': 'complete'}}


def store_image(category, data, filename, group='default', existing=None, *, bucket_id=None, fallback_label=None):
    """原图与衍生图全部在内存处理，核验私有对象后返回待加密的图片行。"""
    from . import photos
    operation_status.update('正在生成私密图片的缩略图和预览图')
    extension = os.path.splitext(filename)[1].lower()
    if extension not in ('.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp', '.heic', '.heif'):
        raise ValueError('不支持该图片格式')
    if existing:
        if existing['hash'] != hashlib.md5(data).hexdigest():
            raise ValueError('Private image content changed')
        identity, name = existing['id'], existing['name']
        path, thumb, preview = (existing[field] for field in ('path', 'thumb', 'preview'))
        for key in (path, thumb, preview):
            photos.media_path(key)
            if key.split('/')[2] != category:
                raise ValueError('Private image category changed')
    else:
        photo_id, name, _ = photos.new_upload_name(data, extension, False, fallback_label)
        identity = photo_id.replace('-', '')
        stem = os.path.splitext(name)[0]
        path = f'photos/images/{category}/{name}'
        thumb = f'photos/thumbnails/{category}/{stem}.webp'
        preview = f'photos/previews/{category}/{stem}.avif'
    with photos.open_upload_image(data) as image:
        thumbnail = image.copy()
        thumbnail.thumbnail((600, 600))
        if thumbnail.mode in ('RGBA', 'P'):
            thumbnail = thumbnail.convert('RGB')
        small = io.BytesIO()
        thumbnail.save(small, 'WEBP', quality=80)
        large = image.copy()
        large.thumbnail((2560, 2560))
        big = io.BytesIO()
        large.save(big, 'AVIF', quality=70)
    store = media_store.get_store()
    if not existing and not bucket_id:
        bucket_id = store.write_buckets['private_photo']
    if not existing and bucket_id and bucket_id != media_store.DEFAULT_BUCKET:
        store.bucket_target(bucket_id)
        for key in (path, thumb, preview):
            store.claim_bucket(key, bucket_id)
    from . import local_media, media_groups
    if not existing:
        cleanup = store.recovery_record('retract_private', (path, thumb, preview))
        storage.compensate(cleanup, lambda: media_store.recover(cleanup))
    operation_status.update('正在登记私密图片权限')
    media_groups.assign([path, thumb, preview], group, replace=True, store=store)
    # 重复上传沿用已登记路径，新对象失败时由持久化补偿撤销。
    for index, (key, content) in enumerate(((path, data), (thumb, small.getvalue()), (preview, big.getvalue()))):
        operation_status.update('正在保存并校验私密图片', index, 3)
        store.write('private', key, content)
        if store.client is not None:
            local_media.keep(key, content)
    if store.client is not None:
        local_media.set_private([path, thumb, preview])
    operation_status.update('正在保存加密索引')
    row = {'id': identity, 'category': category, 'name': name, 'path': path,
           'thumb': thumb, 'preview': preview, 'hash': hashlib.md5(data).hexdigest(),
           'created_at': time.strftime('%Y-%m-%d %H:%M:%S'), 'tags': [], 'sort_order': -1}
    if bucket_id and bucket_id != media_store.DEFAULT_BUCKET and not existing:
        row['bucketId'] = bucket_id
    return {**row, **existing} if existing else row


def delete(body):
    from .photos import normalize_media_reference
    key = normalize_media_reference(body['path'])
    for category, found in private_session.albums().items():
        rows = found['payload']['photos']
        remaining = [row for row in rows if row['path'] != key]
        if len(remaining) != len(rows):
            _save_rows(category, remaining)
            # 普通移除只更新引用，私有副本保留，防止共享引用或失败重试造成数据丢失。
            return {'status': 'success'}
    return None


def reorder(category, ordered):
    from .photos import normalize_media_reference
    found = entry(category)
    if not found:
        return None
    rows = copy.deepcopy(found['payload']['photos'])
    order = {normalize_media_reference(row['path']): index for index, row in enumerate(ordered)}
    if any(key not in {row['path'] for row in rows} for key in order):
        raise ValueError('Unknown private photo')
    rows.sort(key=lambda row: order.get(row['path'], len(order)))
    for index, row in enumerate(rows):
        row['sort_order'] = index
    _save_rows(category, rows)
    return {'status': 'success'}


def update_tags(identity, value):
    for category, found in private_session.albums().items():
        rows = copy.deepcopy(found['payload']['photos'])
        row = next((row for row in rows if row['id'] == identity), None)
        if row is not None:
            row['tags'] = value
            _save_rows(category, rows)
            return True
    return None


def transform_tags(category, transform=None):
    found = entry(category)
    if not found:
        return None
    rows = copy.deepcopy(found['payload']['photos'])
    used, changed = set(), 0
    for row in rows:
        current = _tags(row)
        updated = transform(current) if transform else current
        used.update(updated)
        if updated != current:
            row['tags'] = updated
            changed += 1
    if transform:
        _save_rows(category, rows)
        return changed
    return used
