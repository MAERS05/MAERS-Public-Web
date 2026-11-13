"""HTTP 路由表：统一输入校验、读写锁及状态码映射，业务交给服务层。"""

from dataclasses import dataclass
from services.contracts import JsonValue, Query, Response, Validator, Handler
from services.errors import internal_error
from contextlib import nullcontext
import config
import re
from services import cms, photos, music, album, space, music_api, git_service
from services import album_lock, crypto_keyring, pages, storage, validation as check
from services import private_session, private_photos, private_relay, media_store, media_settings
from services import relay_media, cms_nodes


@dataclass(frozen=True)
class Route:
    handler: Handler
    validate: Validator | None = None
    locked: bool = True


ROUTES = {'GET': {}, 'POST': {}}


def route(method, *paths, validate=None, locked=True):
    """注册路由及校验器；别名共享同一份处理逻辑。"""
    def register(function):
        for path in paths:
            if path in ROUTES[method]:
                raise RuntimeError(f'Duplicate route: {method} {path}')
            ROUTES[method][path] = Route(function, validate, locked)
        return function
    return register


def _module(query, default='notes'):
    return check.scope(query.get('module', [default])[0], cms.JS_SYNC_MAP)


def _ok(value=None):
    return 200, value if value is not None else {'status': 'success'}


def _changed(changed):
    return _ok() if changed else (404, {'error': 'Node not found'})


@route('GET', '/api/modules')
def modules(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(cms.load_json(config.MODULES_JSON_FILE) or [])


@route('GET', '/api/changelog')
def changelog(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(cms.load_json(config.CHANGELOG_JSON) or [])


@route('GET', '/api/git/status', locked=False)
def git_status(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(git_service.get_git_status())


@route('GET', '/api/get_bili_info')
def bili_info(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return music_api.get_video_info(q.get('bvid', [None])[0])


@route('GET', '/api/cms/fetch')
def cms_fetch(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(cms.fetch_module_tree(_module(q)))


@route('GET', '/api/cms/tag_categories')
def tag_categories(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(cms.get_tag_categories(_module(q, 'cms')))


@route('POST', '/api/cms/save_tag_categories', validate=check.categories)
def save_categories(q: Query, b: JsonValue, f: bytes | None) -> Response:
    cms.save_tag_categories(b, _module(q, 'cms'))
    return _ok()


@route('POST', '/api/cms/cleanup_tags', validate=check.object_body)
def cleanup_tags(q: Query, b: JsonValue, f: bytes | None) -> Response:
    result = cms.cleanup_unused_tags(_module(q, 'cms'))
    return (200 if result.get('success') else 500), result


@route('POST', '/api/cms/rename_tag', validate=check.fields(old_name=str, new_name=str))
def rename_tag(q: Query, b: JsonValue, f: bytes | None) -> Response:
    result = cms.rename_tag(_module(q, 'cms'), b['old_name'], b['new_name'])
    return (200 if result.get('success') else 400), result


@route('POST', '/api/cms/delete_tag', validate=check.fields(tag_name=str))
def delete_tag(q: Query, b: JsonValue, f: bytes | None) -> Response:
    result = cms.delete_tag(_module(q, 'cms'), b['tag_name'])
    return (200 if result.get('success') else 400), result


@route('POST', '/api/cms/node', validate=check.object_body)
def cms_node(q: Query, b: JsonValue, f: bytes | None, *, from_relay: bool = False, overwrite_revision=None) -> Response:
    _module(q)
    return cms.handle_request('/api/cms/node', 'POST', q, b, from_relay=from_relay, overwrite_revision=overwrite_revision)


@route('POST', '/api/cms/update_tags', validate=check.tags)
def cms_tags(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _changed(cms.update_node_tags(_module(q), b['id'], b['tags']))


@route('POST', '/upload', validate=check.object_body)
def upload(q: Query, b: JsonValue, f: bytes | None) -> Response:
    if not f:
        raise ValueError('No file data received')
    private = private_photos.upload(q, f)
    return _ok(private if private is not None else photos.handle_upload(q, f))


@route('POST', '/delete', validate=check.fields(path=str))
def delete_photo(q: Query, b: JsonValue, f: bytes | None) -> Response:
    private = private_photos.delete(b)
    return _ok(private if private is not None else photos.handle_delete(b))


@route('POST', '/reorder', validate=check.records)
def reorder_photos(q: Query, b: JsonValue, f: bytes | None) -> Response:
    for item in b:
        check.fields(path=str)(item)
    private = private_photos.reorder(q.get('category', [''])[0], b)
    return _ok(private if private is not None else photos.handle_reorder(q, b))


@route('POST', '/api/photos/update_tags', validate=check.tags)
def photo_tags(q: Query, b: JsonValue, f: bytes | None) -> Response:
    private = private_photos.update_tags(b['id'], b['tags'])
    return _changed(private if private is not None else photos.update_tags(b['id'], b['tags']))


@route('POST', '/api/photos/update_tags_by_path', validate=check.fields(path=str, tags=list))
def photo_tags_by_path(q: Query, b: JsonValue, f: bytes | None) -> Response:
    check.strings(b['tags'])
    return _changed(photos.update_tags_by_path(b['path'], b['tags']))


@route('POST', '/api/relay/archive-upload', validate=check.fields(source=str, item=dict))
def archive_relay_upload(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(relay_media.archive_upload(b))


@route('POST', '/api/photos/register', validate=check.fields(category=str, path=str))
def register_photo(q: Query, b: JsonValue, f: bytes | None) -> Response:
    private = private_photos.register(b)
    if private is not None:
        return _ok(private)
    private_photos.check_upload_target(b['category'])
    return _ok(photos.register_photo(b))


@route('POST', '/api/save_music', validate=check.records)
def save_music(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(music.save_music_data(b))


@route('POST', '/api/delete_track', validate=check.fields(catIdx=int, colIdx=int, albIdx=int, trackIdx=int))
def delete_track(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(music.delete_track(b))


@route('POST', '/api/reset_tracks', validate=check.fields(catIdx=int, colIdx=int, albIdx=int))
def reset_tracks(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(music.reset_tracks(b))


@route('POST', '/api/save_modules', validate=check.cards)
def save_modules(q: Query, b: JsonValue, f: bytes | None) -> Response:
    cms.save_json(config.MODULES_JSON_FILE, b)
    return _ok()


@route('POST', '/api/save_index_cards', validate=check.cards)
def save_cards(q: Query, b: JsonValue, f: bytes | None) -> Response:
    cms.save_json(config.INDEX_CARDS_JSON, b)
    return _ok()


@route('POST', '/api/save_changelog', validate=check.changelog)
def save_changelog(q: Query, b: JsonValue, f: bytes | None) -> Response:
    cms.save_json(config.CHANGELOG_JSON, b)
    return _ok()


@route('POST', '/api/ensure_page', validate=check.fields(filename=str))
def ensure_page(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return pages.ensure_page(b)


@route('POST', '/api/delete_page', validate=check.fields(filename=str))
def delete_page(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return pages.delete_page(b)


# 同类服务仅在注册时绑定路径，避免请求分发中的重复分支。
for _path in ('add_category', 'delete_category', 'update_category', 'reorder_category'):
    route('POST', '/api/' + _path,
          validate=check.strings if _path == 'reorder_category' else check.fields(id=str))(
        lambda q, b, f, path='/api/' + _path: album.handle_ops(path, b))

for _path in ('export_category', 'lock_category', 'unlock_category', 'job'):
    route('POST', '/api/album/' + _path, validate=check.object_body, locked=_path != 'job')(
        lambda q, b, f, path='/api/album/' + _path: album_lock.handle(path, b))


@route('GET', '/api/crypto/keyring')
def read_keyring(q: Query, b: JsonValue, f: bytes | None) -> Response:
    crypto_keyring.migrate()
    return 200, crypto_keyring._load() or {}


@route('POST', '/api/crypto/keyring', validate=check.object_body)
def keyring(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return crypto_keyring.save(b)


route('GET', '/api/crypto/admin-status')(lambda q, b, f: _ok(private_session.status()))
from services import local_crypto_access
route('GET', '/api/crypto/local-access')(lambda q, b, f: _ok(local_crypto_access.status()))
route('POST', '/api/crypto/local-access', validate=check.fields(enabled=bool))(
    lambda q, b, f: _ok(local_crypto_access.configure(b)))
route('POST', '/api/crypto/local-session', validate=check.object_body)(
    lambda q, b, f: local_crypto_access.open_session())
route('POST', '/api/crypto/admin-session', validate=check.object_body)(
    lambda q, b, f: _ok(private_session.start(b)))
route('POST', '/api/crypto/admin-session/close', validate=check.object_body)(
    lambda q, b, f: _ok(private_session.close(b)))
route('GET', '/api/crypto/admin-protection')(
    lambda q, b, f: _ok(private_session.protection(q.get('source', [''])[0])))
route('POST', '/api/crypto/unprotect', validate=check.fields(reference=str))(
    lambda q, b, f: private_session.unprotect(b))


from services import crypto_groups as _groups
route('GET', '/api/crypto/groups/catalog')(lambda q, b, f: _ok(_groups.catalog()))
route('POST', '/api/crypto/groups/assign', validate=check.fields(group=str, items=list))(
    lambda q, b, f: _ok(_groups.assign(b)))
route('POST', '/api/private/relay-edit', validate=check.fields(source=str, group=str, revision=str, enc=str))(
    lambda q, b, f: private_relay.replace(b))


@route('GET', '/api/crypto/rotation/export')
def rotation_export(q: Query, b: JsonValue, f: bytes | None) -> Response:
    from services import crypto_rotation
    return _ok(crypto_rotation.export_snapshots())


from services import crypto_rotation as _rotation
route('GET', '/api/crypto/rotation/pending')(lambda q, b, f: _ok(_rotation.pending()))
for _name, _operation in [('/api/crypto/rotation', _rotation.rotate),
                          ('/api/crypto/rotation/finalize', _rotation.finalize)]:
    route('POST', _name, validate=check.object_body)(
        lambda q, b, f, operation=_operation: _ok(operation(b)))


@route('POST', '/api/space/fetch_meta', validate=check.fields(url=str))
def fetch_meta(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(space.fetch_url_metadata(b['url']))


@route('POST', '/api/space/save_tree', validate=check.tree)
def save_space(q: Query, b: JsonValue, f: bytes | None) -> Response:
    space.save_tree(b)
    return _ok()


@route('POST', '/api/space/update_tags', validate=check.tags)
def space_tags(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _changed(space.update_node_tags(b['id'], b['tags']))


@route('POST', '/api/git/commit-push', validate=check.object_body)
def commit_push(q: Query, b: JsonValue, f: bytes | None) -> Response:
    content_bucket = b.get('contentBucket')
    if content_bucket is None:
        result = git_service.commit_and_push(b.get('message'))
    else:
        if not isinstance(content_bucket, str):
            raise ValueError('正文存储桶代号无效')
        result = git_service.commit_and_push(b.get('message'), content_bucket=content_bucket)
    return (200 if result.get('success') else 500), result


@route('GET', '/api/storage/buckets')
def storage_buckets(q: Query, b: JsonValue, f: bytes | None) -> Response:
    from services import media_store
    store = media_store.get_store()
    return _ok({'buckets': [media_store.DEFAULT_BUCKET, *store.bucket_groups], 'contentBucket': store.content_bucket})


@route('GET', '/api/storage/config')
def read_storage_config(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(media_settings.read())


@route('POST', '/api/storage/config', validate=check.object_body)
def save_storage_config(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(media_settings.save(b))


@route('POST', '/api/storage/worker-setting', validate=check.fields(name=str))
def storage_worker_setting(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok({'value': media_settings.worker_setting(b['name'])})


@route('POST', '/api/storage/group', validate=check.fields(id=str, action=str))
def storage_group(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(media_settings.edit_group(b))


@route('POST', '/api/storage/mode', validate=check.fields(mode=str))
def storage_mode(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(media_settings.switch_mode(b))


@route('GET', '/api/git/progress', locked=False)
def git_progress(q: Query, b: JsonValue, f: bytes | None) -> Response:
    # 只读取进度快照，不能等待提交任务持有的文件写锁。
    return _ok(git_service.get_git_progress())


@route('POST', '/api/admin/clean_data', validate=check.object_body)
def clean_data(q: Query, b: JsonValue, f: bytes | None) -> Response:
    from services import janitor
    return _ok(janitor.run_cleanup())


@route('GET', '/api/admin/recovery')
def recovery_list(q: Query, b: JsonValue, f: bytes | None) -> Response:
    from services import data_safety, media_jobs
    return _ok({**data_safety.list_recovery(), 'pending_media': sum(not job.get('deferred') for job in media_jobs.pending())})


@route('POST', '/api/admin/backup', validate=check.fields(scope=str))
def backup(q: Query, b: JsonValue, f: bytes | None) -> Response:
    from services import data_safety
    return _ok(data_safety.create_backup(b['scope']))


@route('POST', '/api/admin/backup_location', validate=check.object_body)
def backup_location(q: Query, b: JsonValue, f: bytes | None) -> Response:
    from services import data_safety
    return _ok({**data_safety.set_backup_location(b.get('path', '')), 'status': 'success'})


@route('POST', '/api/admin/import_backup', validate=check.fields(path=str))
def import_backup(q: Query, b: JsonValue, f: bytes | None) -> Response:
    from services import data_safety
    return _ok(data_safety.import_backup(b['path']))


@route('POST', '/api/admin/pick_directory', validate=check.object_body, locked=False)
def pick_directory(q: Query, b: JsonValue, f: bytes | None) -> Response:
    from services import data_safety
    return _ok(data_safety.pick_directory(b.get('title', '选择文件夹')))


from services import data_safety as _safety
for _name, _operation in [('verify_backup', _safety.verify_backup), ('restore_backup', _safety.restore_backup),
                          ('restore_trash', _safety.restore_trash)]:
    route('POST', '/api/admin/' + _name, validate=check.fields(id=str))(
        lambda q, b, f, operation=_operation: _ok(operation(b['id'])))


@route('POST', '/api/media/retry', validate=check.object_body)
def retry_media(q: Query, b: JsonValue, f: bytes | None) -> Response:
    from services import media_jobs
    return _ok(media_jobs.retry())


# 允许携带中继回执的写入口：同一草稿重放只执行一次，数组请求体只能通过查询参数携带回执。
RELAY_PATHS = frozenset((
    '/api/cms/node', '/api/photos/register', '/delete', '/reorder',
    '/api/photos/update_tags_by_path', '/api/cms/save_tag_categories',
    '/api/cms/rename_tag', '/api/cms/delete_tag', '/api/save_music', '/api/space/save_tree',
    '/api/space/update_tags', '/api/save_changelog',
    '/api/private/relay-edit',
))

# 快照的版本校验与写入共用同一把锁，旧客户端仍可发送原始请求体。
SNAPSHOT_READERS = {
    '/api/save_music': lambda q: cms.load_json(config.MUSIC_DATA) or [],
    '/api/space/save_tree': lambda q: space.load_tree(),
    '/api/save_changelog': lambda q: cms.load_json(config.CHANGELOG_JSON) or [],
    '/api/cms/save_tag_categories': lambda q: cms.get_tag_categories(_module(q, 'cms')),
}


def _take_relay(query: Query, body: JsonValue):
    """取出并移除中继回执：查询参数适用于任意请求体，对象请求体也可内嵌 _relay。返回 (回执, 查询, 请求体)。"""
    query = dict(query)
    # 进度编号每次请求重新生成，不属于草稿内容，也不能进入持久化回执指纹。
    query.pop('_operation', None)
    source, key = query.pop('_relay_source', [None])[0], query.pop('_relay_key', [None])[0]
    relay = {'source': source, 'key': key} if source is not None or key is not None else None
    if isinstance(body, dict) and '_relay' in body:
        if relay is not None:
            raise ValueError('Relay metadata must be supplied once')
        relay = body['_relay']
        body = {name: value for name, value in body.items() if name != '_relay'}
    if relay is not None:
        check.fields(source=str, key=str)(relay)
    return relay, query, body


def _relay_uses_raw_view(path: str, query: Query) -> bool:
    if path == '/api/cms/node':
        return query.get('action', [''])[0] in ('add', 'update', 'delete', 'move', 'reorder')
    if path in ('/api/cms/rename_tag', '/api/cms/delete_tag'):
        return not _module(query, 'cms').startswith('photos-')
    return path == '/api/space/update_tags'


def _dispatch(method: str, path: str, query: Query, body: JsonValue = None, file_data: bytes | None = None,
              *, relay_secret=None) -> Response:
    path = path.rstrip('/') or '/'
    entry = ROUTES[method].get(path)
    if entry is None:
        if path in ROUTES['GET' if method == 'POST' else 'POST']:
            return 405, {'error': 'Method not allowed'}
        return 404, None if method == 'GET' and not path.startswith('/api/') else {'error': 'API not found'}
    try:
        relay, query, body = _take_relay(query, body)
        overwrite_revision = None
        if isinstance(body, dict) and '_overwriteRevision' in body:
            overwrite_revision = body['_overwriteRevision']
            if (relay is None or method != 'POST' or path != '/api/cms/node' or
                    query.get('action') != ['update'] or not isinstance(overwrite_revision, str) or
                    not re.fullmatch(r'[0-9a-f]{64}', overwrite_revision)):
                raise ValueError('Invalid markdown overwrite confirmation')
            # 覆盖许可只针对用户刚确认的电脑版本，不改变草稿回执的内容指纹。
            body = {key: value for key, value in body.items() if key != '_overwriteRevision'}
        guarded = method == 'POST' and path in SNAPSHOT_READERS and isinstance(body, dict) and '_snapshot' in body
        if guarded:
            base, body = body['_base'], body['_snapshot']
        if entry.validate:
            entry.validate(body)

        def execute():
            if not guarded:
                if relay is not None and _relay_uses_raw_view(path, query):
                    with private_session.context(False):
                        if path == '/api/cms/node':
                            return cms_node(query, body, file_data, from_relay=True, overwrite_revision=overwrite_revision)
                        return entry.handler(query, body, file_data)
                return entry.handler(query, body, file_data)
            read_snapshot = SNAPSHOT_READERS[path]
            # 云端基线来自公开快照；本地编辑则校验编辑页实际可见的内容。
            with private_session.context(False) if relay is not None else nullcontext():
                current = read_snapshot(query)
                if private_session.active():
                    current = private_session.view(current)
                if current != base:
                    if relay is None and current == body:
                        return 200, {'snapshot': current}
                    return 409, {'code': 'snapshot_conflict', 'error': '数据已在别处修改，请重新加载后再保存'}
            if relay is not None:
                if path in ('/api/save_music', '/api/space/save_tree'):
                    private_relay.validate_document(current, body)
                    with private_session.context(False):
                        return entry.handler(query, body, file_data)
                return entry.handler(query, body, file_data)
            with storage.transaction():
                code, result = entry.handler(query, body, file_data)
                return (code, {'snapshot': read_snapshot(query)}) if 200 <= code < 300 else (code, result)

        with storage.LOCK if entry.locked else nullcontext():
            if entry.locked:
                storage._recover_if_needed()
            if method == 'POST':
                private_session.require_ready(path)
            if relay is not None:
                if method != 'POST' or path not in RELAY_PATHS:
                    raise ValueError('Relay metadata is not supported by this route')
                if path == '/api/photos/register' and not relay_secret:
                    raise ValueError('请刷新本地后台后再合并 KV 图片草稿')

                def apply_relay():
                    with relay_media.bind(relay['source'], relay_secret) as images:
                        code, result = execute()
                        if images and 200 <= code < 300:
                            result = {**result, '_draft_media': sorted(set(images))}
                        return code, result
                return storage.run_once(relay['source'], relay['key'], [path, query, body], apply_relay)
            return execute()
    except media_store.MediaAccessError as error:
        return 403, {'error': str(error)}
    except PermissionError as error:
        return 403, {'error': str(error), 'code': 'private_admin_required'}
    except cms_nodes.MarkdownConflictError as error:
        return 409, {'error': str(error), 'code': 'markdown_conflict', 'currentRevision': error.revision}
    except (ValueError, TypeError, KeyError, IndexError) as error:
        return 400, {'error': str(error)}
    except Exception as error:
        return internal_error(error, f'{method} {path}', 'Internal server error')


def dispatch_get(path: str, query_params: Query) -> Response:
    return _dispatch('GET', path, query_params)


def dispatch_post(path: str, query_params: Query, body_data: JsonValue, file_data: bytes | None = None,
                  *, relay_secret=None) -> Response:
    return _dispatch('POST', path, query_params, body_data, file_data, relay_secret=relay_secret)
