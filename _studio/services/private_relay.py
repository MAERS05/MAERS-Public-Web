"""云端私密编辑合并：同组密文替换、版本检查和私有图片引用验证。"""
import hashlib
import json
import re

import config
from . import cms, cms_nodes, cms_store, media_groups, media_store, private_cms, private_session, storage, validation
from . import local_media, media_jobs, photos, relay_media
from .contracts import JsonObject, Response

_CIPHER = re.compile(r'enc:[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+')
_HASH = re.compile(r'[a-f0-9]{64}')
_GROUP = re.compile(r'default|g_[a-f0-9]{32}')
_NODE_ID = re.compile(r'[\w.-]{1,160}')


def _group(envelope):
    return envelope.get('_group', 'default')


def _decrypt(cipher, group):
    if not isinstance(cipher, str) or not _CIPHER.fullmatch(cipher):
        raise ValueError('私密草稿密文格式无效')
    if not private_session.group_unlocked(group):
        raise PermissionError('请在电脑本地后台解锁草稿所属密码组后重新合并')
    payload = private_session.decrypt(cipher, group)
    if not isinstance(payload, dict) or private_session.has_private_markers(payload):
        raise ValueError('私密草稿载荷格式无效')
    return payload


def _slots(value):
    """只定位可独立替换的外层密文，密文中嵌套的记录留在原有保护边界内。"""
    return list(private_session.outer_envelopes(value))


def _nested_keys(value):
    return {(item['_enc'], _group(item)) for item in _slots(value)}


def _check_nested_cms(before, after):
    original = {item['id']: item for item in _slots(before)}
    edited = {item['id']: item for item in _slots(after)}
    if original.keys() != edited.keys():
        raise ValueError('加密范围变更请在电脑本地后台操作')
    for identity, envelope in original.items():
        other = edited[identity]
        if envelope == other:
            continue
        if _group(envelope) != _group(other):
            raise ValueError('密码组变更请在电脑本地后台操作')
        group = _group(envelope)
        _check_cms(_decrypt(envelope['_enc'], group), _decrypt(other['_enc'], group), envelope)


def _check_media(before, after, group):
    previous = set(private_session.media_keys(before))
    added = set(private_session.media_keys(after)) - previous
    if not added:
        return
    store = media_store.get_store()
    pending = media_jobs.drafts(added)
    for key in sorted(added):
        if key in pending:
            job = pending[key]
            if group not in media_jobs.draft_groups(job):
                raise ValueError('私密草稿引用的图片未就绪或不属于此密码组')
            media_jobs.check_target(store, job)
            if not local_media.path(key).is_file():
                raise FileNotFoundError('本机私密图片草稿缺失')
            continue
        if key.startswith('photos/images/_cloud_private/'):
            draft = relay_media.read(key, group)
            if draft:
                draft.check_bucket(store)
                with photos.open_upload_image(draft.data) as image:
                    image.load()
                local_media.keep(key, draft.data)
                media_jobs.enqueue('ensure', key, draft.bucket_id, deferred=True, group=group, store=store)
                continue
        policy = store.read_policy(media_groups.policy_key(key))
        allowed = json.loads(policy) if policy else {}
        if allowed.get('key') != key or group not in allowed.get('groups', ()) or not store.exists('private', key):
            message = relay_media.MISSING if key.startswith('photos/images/_cloud_private/') and relay_media.active() else (
                '私密草稿引用的图片未就绪或不属于此密码组')
            raise ValueError(message)
        if not local_media.path(key).is_file():
            local_media.keep(key, store.read('private', key))
    local_media.set_private(added)


def _check_cms(before, after, envelope):
    if before.get('id') != after.get('id') or envelope.get('id') != after.get('id') or before.get('type') != after.get('type'):
        raise ValueError('私密草稿与原文档不匹配')
    cms_store.validate({'root': [after]})
    cms_nodes.validate_tree_names([after])
    _check_nested_cms(before, after)
    for node in cms_store.walk([after]):
        if not _NODE_ID.fullmatch(node['id']):
            raise ValueError('私密文档编号无效')
        if node.get('_enc'):
            continue
        if node['type'] == 'note' and not isinstance(node.get('md'), str):
            raise ValueError('私密正文格式无效')
        private_cms.validate_edit(node.copy(), {'content': node.get('md', ''), 'coverImage': node.get('coverImage')})
    _check_media(before, after, _group(envelope))


def _check_album(before, after):
    from . import album
    validation.fields(category=dict, photos=list)(after)
    category = after['category']
    validation.fields(id=str, title=str)(category)
    if category['id'] != before.get('category', {}).get('id'):
        raise ValueError('私密草稿与原相册不匹配')
    album.validate_category_slug(cms.load_json(config.ALBUM_CONFIG_JSON) or [], category)
    identities = set()
    for row in after['photos']:
        validation.fields(id=str, path=str)(row)
        if not row['id'] or row['id'] in identities:
            raise ValueError('私密图片编号重复或无效')
        identities.add(row['id'])
        for field in ('path', 'thumb', 'preview'):
            if row.get(field):
                media_store._key(row[field])
        tags = row.get('tags', [])
        validation.strings(json.loads(tags or '[]') if isinstance(tags, str) else tags)
    if after.get('tags_file') is not None:
        validation.categories(json.loads(after['tags_file']))


@storage.transactional
def replace(body: JsonObject) -> Response:
    if (set(body) != {'source', 'group', 'revision', 'enc'} or not _HASH.fullmatch(body['revision'])
            or not _GROUP.fullmatch(body['group'])):
        raise ValueError('私密草稿格式无效')
    source, group = body['source'], body['group']
    if source == 'album':
        path = config.ALBUM_CONFIG_JSON
    elif source in cms.JS_SYNC_MAP:
        path = cms._tree_path(source)
    else:
        raise ValueError('不支持的私密草稿来源')
    with private_session.context(False):
        current = cms.load_json(path)
    slots = [item for item in _slots(current) if _group(item) == group]
    matches = [item for item in slots if hashlib.sha256(item['_enc'].encode()).hexdigest() == body['revision']]
    if not matches and any(item['_enc'] == body['enc'] for item in slots):
        return 200, {'status': 'success'}
    if len(matches) != 1:
        return 409, {'error': '加密内容的电脑版本已变化，草稿已保留'}
    envelope = matches[0]
    before, after = _decrypt(envelope['_enc'], group), _decrypt(body['enc'], group)
    if source == 'album':
        _check_album(before, after)
        _check_media(before, after, group)
    else:
        _check_cms(before, after, envelope)
        view = private_session.read(path, current)
        siblings = cms_nodes._find(view, after['id'])[0]
        cms_nodes.unique_title(siblings, after['title'], after['id'])
    envelope['_enc'] = body['enc']
    with private_session.context(False):
        if source == 'album':
            storage.write_json(path, current)
        else:
            cms.save_module_tree(source, current)
    return 200, {'status': 'success'}


def validate_document(before, after):
    """音乐、空间快照只能修改本机可解锁的加密记录。"""
    if private_session.has_private_markers(after):
        raise ValueError('请保存重新加密后的内容')
    old, new = _nested_keys(before), _nested_keys(after)
    if old != new:
        validate_document([_decrypt(cipher, group) for cipher, group in old - new],
                          [_decrypt(cipher, group) for cipher, group in new - old])
