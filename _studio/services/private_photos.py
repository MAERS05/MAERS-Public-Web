"""加密相册的内存编辑与私有上传，修改后直接重封装相册密文，不生成公开图片。"""
import copy
import hashlib
import io
import json
import os
import time
import uuid
from . import private_session, media_store, storage


def entry(category):
    return private_session.albums().get(category)


def _tags(row):
    value = row.get('tags', [])
    return json.loads(value) if isinstance(value, str) and value else value or []


def tags(category, value=None):
    found = entry(category)
    if not found:
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
    row = store_image(category, data, query.get('name', ['image.png'])[0])
    _save_rows(category, [row, *rows])
    return {**row, 'status': 'success', 'sync': {'state': 'complete'}}


def store_image(category, data, filename, owner=''):
    """原图与衍生图全部在内存处理，核验私有对象后返回待加密的图片行。"""
    extension = os.path.splitext(filename)[1].lower()
    if extension not in ('.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.bmp', '.heic', '.heif'):
        raise ValueError('Unsupported private image format')
    identity = uuid.uuid5(uuid.NAMESPACE_URL, category + '|' + owner + '|' + hashlib.sha256(data).hexdigest()).hex
    name = identity + extension
    path = f'photos/images/{category}/{name}'
    thumb = f'photos/thumbnails/{category}/{identity}.webp'
    preview = f'photos/previews/{category}/{identity}.avif'
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(data)) as source:
        image = ImageOps.exif_transpose(source)
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
    # 路径由内容确定，失败重试复用同一组私有对象；全部核验后才更新密文索引。
    for key, content in ((path, data), (thumb, small.getvalue()), (preview, big.getvalue())):
        store.write('private', key, content)
    row = {'id': identity, 'category': category, 'name': name, 'path': path,
           'thumb': thumb, 'preview': preview, 'hash': hashlib.md5(data).hexdigest(),
           'created_at': time.strftime('%Y-%m-%d %H:%M:%S'), 'tags': [], 'sort_order': -1}
    return row


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
