"""HTTP 路由表：统一输入校验、读写锁及状态码映射，业务交给服务层。"""

from dataclasses import dataclass
from services.contracts import JsonValue, Query, Response, Validator, Handler
from services.errors import internal_error
from contextlib import nullcontext
import config
from services import cms, photos, music, album, space, music_api, git_service
from services import album_lock, crypto_keyring, pages, storage, validation as check
from services import private_session, private_photos, media_store


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


@route('GET', '/api/modules', '/api/save_modules')
def modules(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(cms.load_json(config.MODULES_JSON_FILE) or [])


@route('GET', '/api/music_data')
def music_data(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(cms.load_json(config.MUSIC_DATA) or [])


@route('GET', '/api/changelog')
def changelog(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(cms.load_json(config.CHANGELOG_JSON) or [])


@route('GET', '/api/space/collections')
def collections(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(space.load_collections())


@route('GET', '/api/git/status', locked=False)
def git_status(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(git_service.get_git_status())


@route('GET', '/api/get_bili_info')
def bili_info(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return music_api.get_video_info(q.get('bvid', [None])[0])


@route('GET', '/api/cms/fetch')
def cms_fetch(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(cms.fetch_module_tree(_module(q)))


@route('GET', '/api/cms/tag_categories', '/api/cms/get_categories')
def tag_categories(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _ok(cms.get_tag_categories(_module(q, 'cms')))


@route('POST', '/api/cms/save_tag_categories', '/api/cms/save_categories', validate=check.categories)
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
def cms_node(q: Query, b: JsonValue, f: bytes | None) -> Response:
    _module(q)
    return cms.handle_request('/api/cms/node', 'POST', q, b)


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


@route('POST', '/api/photos/register', '/api/photos/register_r2', validate=check.fields(category=str, path=str))
def register_photo(q: Query, b: JsonValue, f: bytes | None) -> Response:
    if private_photos.entry(b['category']):
        raise ValueError('私密相册请通过本地后台上传，以便图片直接写入私有存储')
    return _ok(photos.handle_register_r2(b))


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
route('POST', '/api/crypto/admin-session', validate=check.object_body)(
    lambda q, b, f: _ok(private_session.start(b)))
route('POST', '/api/crypto/admin-session/close', validate=check.object_body)(
    lambda q, b, f: _ok(private_session.close(b)))
route('GET', '/api/crypto/admin-protection')(
    lambda q, b, f: _ok(private_session.protection(q.get('source', [''])[0])))
route('POST', '/api/crypto/unprotect', validate=check.fields(reference=str))(
    lambda q, b, f: private_session.unprotect(b))


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


@route('POST', '/api/space/add', validate=check.fields(id=str, title=str))
def add_collection(q: Query, b: JsonValue, f: bytes | None) -> Response:
    space.add_collection(b)
    return _ok()


@route('POST', '/api/space/update', validate=check.fields(id=str, data=dict))
def update_collection(q: Query, b: JsonValue, f: bytes | None) -> Response:
    space.update_collection(b['id'], b['data'])
    return _ok()


@route('POST', '/api/space/delete', validate=check.fields(id=str))
def delete_collection(q: Query, b: JsonValue, f: bytes | None) -> Response:
    space.delete_collection(b['id'])
    return _ok()


@route('POST', '/api/space/reorder', validate=check.fields(ids=list))
def reorder_collections(q: Query, b: JsonValue, f: bytes | None) -> Response:
    check.strings(b['ids'])
    space.reorder_collections(b['ids'])
    return _ok()


@route('POST', '/api/space/save_tree', validate=check.tree)
def save_space(q: Query, b: JsonValue, f: bytes | None) -> Response:
    space.save_tree(b)
    return _ok()


@route('POST', '/api/space/update_tags', validate=check.tags)
def space_tags(q: Query, b: JsonValue, f: bytes | None) -> Response:
    return _changed(space.update_node_tags(b['id'], b['tags']))


@route('POST', '/api/git/commit_push', '/api/git/commit-push', validate=check.object_body)
def commit_push(q: Query, b: JsonValue, f: bytes | None) -> Response:
    result = git_service.commit_and_push(b.get('message'))
    return (200 if result.get('success') else 500), result


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
    return _ok({**data_safety.list_recovery(), 'pending_media': len(media_jobs.pending())})


@route('POST', '/api/admin/backup', validate=check.object_body)
def backup(q: Query, b: JsonValue, f: bytes | None) -> Response:
    from services import data_safety
    return _ok(data_safety.create_backup(include_remote=b.get('include_remote', True) is not False))


from services import data_safety as _safety
for _name, _operation in [('verify_backup', _safety.verify_backup), ('restore_backup', _safety.restore_backup),
                          ('restore_trash', _safety.restore_trash)]:
    route('POST', '/api/admin/' + _name, validate=check.fields(id=str))(
        lambda q, b, f, operation=_operation: _ok(operation(b['id'])))


@route('POST', '/api/media/retry', validate=check.object_body)
def retry_media(q: Query, b: JsonValue, f: bytes | None) -> Response:
    from services import media_jobs
    return _ok(media_jobs.retry())


def _dispatch(method: str, path: str, query: Query, body: JsonValue = None, file_data: bytes | None = None) -> Response:
    path = path.rstrip('/') or '/'
    entry = ROUTES[method].get(path)
    if entry is None:
        if path in ROUTES['GET' if method == 'POST' else 'POST']:
            return 405, {'error': 'Method not allowed'}
        return 404, None if method == 'GET' and not path.startswith('/api/') else {'error': 'API not found'}
    try:
        relay = body.get('_relay') if isinstance(body, dict) else None
        if relay is not None:
            check.fields(source=str, key=str)(relay)
            body = {key: value for key, value in body.items() if key != '_relay'}
        if entry.validate:
            entry.validate(body)
        with storage.LOCK if entry.locked else nullcontext():
            if entry.locked:
                storage._recover_if_needed()
            if method == 'POST':
                private_session.require_ready(path)
            if relay is not None:
                if method != 'POST' or path not in ('/api/cms/node', '/api/photos/register', '/api/photos/register_r2'):
                    raise ValueError('Relay metadata is not supported by this route')
                return storage.run_once(relay['source'], relay['key'], [path, query, body],
                                        lambda: entry.handler(query, body, file_data))
            return entry.handler(query, body, file_data)
    except media_store.MediaAccessError as error:
        return 403, {'error': str(error)}
    except PermissionError as error:
        return 403, {'error': str(error), 'code': 'private_admin_required'}
    except (ValueError, TypeError, KeyError, IndexError) as error:
        return 400, {'error': str(error)}
    except Exception as error:
        return internal_error(error, f'{method} {path}', 'Internal server error')


def dispatch_get(path: str, query_params: Query) -> Response:
    return _dispatch('GET', path, query_params)


def dispatch_post(path: str, query_params: Query, body_data: JsonValue, file_data: bytes | None = None) -> Response:
    return _dispatch('POST', path, query_params, body_data, file_data)
