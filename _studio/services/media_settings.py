"""本机后台的桶组配置和 Worker 配置复制。"""

import json
import re
from pathlib import Path
from urllib.parse import urlsplit
import config
from . import media_store, storage, storage_journal, validation as check


DEFAULT = media_store.DEFAULT_BUCKET
WORKER_VARIABLE_MAX_BYTES = 5_000
SCOPES = ('public', 'private')
TARGET_FIELDS = ('provider', 'endpoint_url', 'bucket_name')
CREDENTIALS = ('access_key_id', 'secret_access_key')
LEGACY_FIELDS = {*TARGET_FIELDS, *CREDENTIALS, 'account_id', 'region', 'root',
                 'public_bucket_name', 'private_bucket_name'}
SITE_FIELD = re.compile(
    r"""^(?P<prefix>[ \t]*(?P<name>MEDIA_PUBLIC_BASE|CONTENT_PUBLIC_BASE)[ \t]*:[ \t]*)"""
    r"""(?P<quote>['"])(?P<value>[^'"\r\n]*)(?P=quote)(?=\s*[,}])""", re.MULTILINE)


def _default_pair(settings):
    if 'public' in settings or 'private' in settings:
        return {scope: settings[scope] for scope in SCOPES}
    if settings.get('provider') == 'local':
        return None
    endpoint = media_store._endpoint(settings)
    provider = settings.get('provider', 's3')
    if media_store.B2_ENDPOINT.fullmatch(endpoint):
        provider = 'b2'
    elif media_store.R2_ENDPOINT.fullmatch(endpoint):
        provider = 'r2'
    common = {name: settings[name] for name in (*CREDENTIALS, 'region') if name in settings}
    return {scope: {**common, 'provider': provider, 'endpoint_url': endpoint, 'bucket_name': name}
            for scope, name in zip(SCOPES, media_store.legacy_bucket_names(settings))}


def _site_path():
    return Path(config.PROJECT_ROOT, 'custom', 'config.js')


def _site_source():
    try:
        return _site_path().read_text(encoding='utf-8')
    except FileNotFoundError:
        return ''


def _site_values(source):
    return {field['name']: field['value'] for field in SITE_FIELD.finditer(source)}


def published_addresses():
    return _site_values(_site_source())


def _export_bucket_groups(settings):
    return json.dumps(settings.get('bucket_groups', {}), separators=(',', ':'))


def _saved_cloud_path():
    return Path(storage_journal.local_root(), 'saved-cloud-media.json')


def _replace_site(source, updates):
    return SITE_FIELD.sub(lambda field: (
        f"{field['prefix']}'{updates[field['name']]}'"
        if field['name'] in updates and updates[field['name']] != field['value'] else field[0]), source)


def _view(settings, site_source):
    pairs = {DEFAULT: _default_pair(settings), **settings.get('bucket_groups', {})}
    groups = []
    for identity, pair in pairs.items():
        name = settings.get('bucket_group_names', {}).get(identity)
        row = {'id': identity, 'name': name or (pair['public']['bucket_name'] if pair and identity == DEFAULT else identity)}
        if pair:
            for scope in SCOPES:
                target = pair[scope]
                row[scope] = {name: target[name] for name in TARGET_FIELDS}
                row[scope]['savedCredentials'] = all(target.get(name) for name in CREDENTIALS)
        groups.append(row)
    return {'mode': 'cloud' if pairs[DEFAULT] else 'local',
            'hasSavedCloud': _saved_cloud_path().is_file(),
            'groups': groups, 'contentBucket': settings.get('content_bucket', DEFAULT),
            'writeBuckets': media_store.write_buckets(settings),
            'metadataBucket': settings.get('metadata_bucket', DEFAULT), 'site': _site_values(site_source),
            'workerBucketGroups': {'bytes': len(_export_bucket_groups(settings).encode('utf-8')),
                                   'limit': WORKER_VARIABLE_MAX_BYTES}}


def read():
    return _view(media_store.load_config(), _site_source())


def _references_group(value, identity):
    if isinstance(value, dict):
        bucket_ids = value.get('bucketIds')
        return (value.get('bucketId') == identity or value.get('bucket_id') == identity or
                isinstance(bucket_ids, dict) and identity in bucket_ids.values() or
                any(_references_group(item, identity) for item in value.values()))
    return isinstance(value, list) and any(_references_group(item, identity) for item in value)


def _ensure_unused_group(settings, identity):
    if identity in (settings.get('content_bucket'), *media_store.write_buckets(settings).values()):
        raise ValueError('此桶组仍是新文件的写入位置，请先选择其他桶组并保存')
    files = [*Path(config.DATA_DIR).glob('*.json'),
             *(Path(storage_journal.local_root(), name) for name in ('content-sync.json', 'media-outbox.json'))]
    for path in files:
        if path.is_file() and _references_group(json.loads(path.read_text(encoding='utf-8')), identity):
            raise ValueError('此桶组仍有文件索引或待同步任务引用，请先迁移或清理相关记录')
    store = media_store.get_store(settings)
    target = store._group(identity)
    for scope in SCOPES:
        values = target._private_settings if scope == 'private' else target.settings
        versioned = values.get('provider') == 'b2'
        operation = 'list_object_versions' if versioned else 'list_objects_v2'
        fields = ('Versions', 'DeleteMarkers') if versioned else ('Contents',)
        for page in target._client_for(scope).get_paginator(operation).paginate(Bucket=target._bucket(scope), Prefix=''):
            if any(page.get(field) for field in fields):
                raise ValueError('此桶组仍保存文件或历史版本，请先迁移或清空后再删除配置')
    for prefix in ('_maers/photo-buckets/', '_maers/content-buckets/'):
        for key in store._list_keys('private', prefix, bucket_id=DEFAULT):
            data = store.read_policy(key)
            if data and json.loads(data).get('bucketId') == identity:
                raise ValueError('此桶组仍有文件归属记录，请先迁移或清理相关记录')


@storage.transactional
def edit_group(body):
    check.fields(id=str, action=str)(body)
    identity, action = body['id'], body['action']
    settings = media_store.load_config()
    groups = settings.get('bucket_groups', {})
    if identity != DEFAULT and identity not in groups:
        raise ValueError('桶组不存在，请刷新后重试')
    names = dict(settings.get('bucket_group_names', {}))
    if action == 'rename':
        check.fields(name=str)(body)
        name = body['name'].strip()
        if len(name) > 64 or any(ord(char) < 32 for char in name):
            raise ValueError('桶组名称最多 64 个字符，不能包含控制字符')
        names[identity] = name
    elif action == 'delete':
        if identity == DEFAULT:
            raise ValueError('默认桶组用于保存归属和权限记录，不能删除')
        _ensure_unused_group(settings, identity)
        del groups[identity]
        names.pop(identity, None)
    else:
        raise ValueError('未知的桶组操作')
    settings['bucket_group_names'] = names
    storage.write_json(Path(config.PROJECT_ROOT, '_studio', 'tools', 'media_config.json'), settings)
    return _view(settings, _site_source())


def _target(values, saved):
    if any(not isinstance(values.get(name), str) or not values[name].strip() for name in TARGET_FIELDS):
        raise ValueError('请填写两个桶的服务商、桶名和 S3 端点')
    placement = {name: values[name].strip() for name in TARGET_FIELDS}
    if saved and any(placement[name] != saved[name] for name in TARGET_FIELDS):
        raise ValueError('已保存的桶组需要保留原桶。请新增桶组来接入其他桶。')
    target = {**(saved or {}), **placement}
    credentials = {name: values.get(name, '') for name in CREDENTIALS}
    if any(not isinstance(value, str) for value in credentials.values()):
        raise ValueError('存储凭据格式无效')
    key_id, secret = (credentials[name].strip() for name in CREDENTIALS)
    if saved and key_id and key_id != saved.get('access_key_id') and not secret:
        raise ValueError('更新 Access Key ID 时，请同时填写对应的 Secret Access Key')
    target.update(access_key_id=key_id or target.get('access_key_id', ''),
                  secret_access_key=secret or target.get('secret_access_key', ''))
    if (not re.fullmatch(r'[A-Za-z0-9_-]+', target['access_key_id']) or
            not target['secret_access_key']):
        raise ValueError('请填写有效的 Access Key ID 和 Secret Access Key')
    return target


def _publish_source(source, updates):
    check.object_body(updates)
    existing = _site_values(source)
    for name, value in updates.items():
        if name not in existing or not isinstance(value, str) or len(value) > 2048:
            raise ValueError('发布地址配置格式无效')
        if value and value != existing[name]:
            url = urlsplit(value)
            if (url.scheme != 'https' or not url.hostname or url.username is not None or
                    re.search(r"""[\s\\'"<>?#]""", value)):
                raise ValueError('发布地址请填写有效的 HTTPS URL')
    for name, label in (('MEDIA_PUBLIC_BASE', '公开图片地址'), ('CONTENT_PUBLIC_BASE', '公开正文地址')):
        if name in existing and not updates.get(name, existing[name]).strip():
            raise ValueError(f'{label}不能为空')
    return SITE_FIELD.sub(lambda field: (
        f"{field['prefix']}'{updates[field['name']]}'"
        if field['name'] in updates and updates[field['name']] != field['value'] else field[0]), source)


def save(body):
    check.fields(id=str, create=bool, public=dict, private=dict)(body)
    if body.get('metadataBucket', DEFAULT) != DEFAULT:
        raise ValueError('文件归属和访问权限记录固定保存在默认私密桶')
    identity = body['id']
    if not media_store.BUCKET_ID.fullmatch(identity):
        raise ValueError('桶组代号须由 1 到 32 个小写字母、数字、短横线或下划线组成，以字母或数字开头')
    settings = media_store.load_config()
    groups = settings.get('bucket_groups', {})
    default_pair = _default_pair(settings)
    if body['create']:
        if not default_pair:
            raise ValueError('请先配置默认桶组')
        if identity == DEFAULT or identity in groups:
            raise ValueError('这个桶组代号已存在')
    elif identity != DEFAULT and identity not in groups:
        raise ValueError('桶组不存在，请刷新后重试')
    old = default_pair if identity == DEFAULT else groups.get(identity)
    pair = {scope: _target(body[scope], old[scope] if old else None) for scope in SCOPES}
    media_store._validate_pair(pair)
    if identity != DEFAULT:
        settings['bucket_groups'] = {**groups, identity: pair}
    elif pair != old:
        settings = {key: value for key, value in settings.items() if key not in LEGACY_FIELDS}
        settings.update(pair)

    if len(_export_bucket_groups(settings).encode('utf-8')) > WORKER_VARIABLE_MAX_BYTES:
        raise ValueError('桶组配置已超过 Cloudflare 单个变量 5 KB 上限，请检查桶组代号和凭据长度')

    settings['content_bucket'] = body.get('contentBucket', settings.get('content_bucket', DEFAULT))
    if 'writeBuckets' in body:
        check.object_body(body['writeBuckets'])
        settings['write_buckets'] = {**media_store.write_buckets(settings), **body['writeBuckets']}
    media_store.get_store(settings)
    settings.pop('metadata_bucket', None)
    source = _site_source()
    updated = _publish_source(source, body.get('site', {}))
    path = Path(config.PROJECT_ROOT, '_studio', 'tools', 'media_config.json')
    saved_cloud = _saved_cloud_path()
    with storage.transaction():
        storage.write_json(path, settings)
        if saved_cloud.is_file():
            storage.remove(saved_cloud)
        if updated != source:
            storage.write_text(_site_path(), updated)
    return _view(settings, updated)


def _sync_policies_to_local(settings):
    """切回本机模式时尽量将云端私密权限记录落盘到本机媒体目录；云端已不可达时不阻断脱云。"""
    try:
        cloud = media_store.get_store(settings)
        if cloud.client is None:
            return
        local = media_store.get_store({'provider': 'local', 'root': '_studio/.local/media'})
        for key in cloud._list_keys('private', '_maers/', bucket_id=DEFAULT):
            try:
                cloud._policy_key(key)
            except ValueError:
                continue
            data = cloud.read_policy(key)
            if data is not None:
                local.write_policy(key, data)
    except (media_store.ClientError, OSError, ValueError):
        return


def switch_mode(body):
    """在已配置的云存储与纯本机目录后端之间一键切换，并保留原云存储凭据以便恢复。"""
    check.fields(mode=str)(body)
    mode = body['mode']
    if mode not in ('local', 'cloud'):
        raise ValueError('未知的存储模式')
    settings = media_store.load_config()
    source = _site_source()
    config_path = Path(config.PROJECT_ROOT, '_studio', 'tools', 'media_config.json')
    saved_cloud = _saved_cloud_path()

    if mode == 'local':
        if not _default_pair(settings):
            return _view(settings, source)
        from . import media_jobs
        if any(not job.get('deferred') for job in media_jobs.pending()):
            raise ValueError('仍有未完成的云端图片同步待办，请先在备份与恢复中完成重试')
        _sync_policies_to_local(settings)
        local_settings = {'provider': 'local', 'root': '_studio/.local/media'}
        updated = _replace_site(source, {'MEDIA_PUBLIC_BASE': '', 'CONTENT_PUBLIC_BASE': ''})
        legacy_path = Path(config.PROJECT_ROOT, '_studio', 'tools', 'r2_config.json')
        with storage.transaction():
            storage.write_json(saved_cloud, {'settings': settings, 'site': _site_values(source)})
            storage.write_json(config_path, local_settings)
            if legacy_path.is_file():
                storage.remove(legacy_path)
            if updated != source:
                storage.write_text(_site_path(), updated)
        return _view(local_settings, updated)

    if _default_pair(settings):
        return _view(settings, source)
    if not saved_cloud.is_file():
        raise ValueError('没有已保存的云存储配置，请先填写默认桶组')
    archived = json.loads(saved_cloud.read_text(encoding='utf-8'))
    cloud_settings = archived.get('settings') if isinstance(archived, dict) else None
    if not isinstance(cloud_settings, dict) or not _default_pair(cloud_settings):
        raise ValueError('已保存的云存储配置无效，请重新填写默认桶组')
    media_store.get_store(cloud_settings)
    archived_site = archived.get('site') if isinstance(archived.get('site'), dict) else {}
    updated = _publish_source(source, archived_site) if all(
        str(archived_site.get(k, '')).strip() for k in ('MEDIA_PUBLIC_BASE', 'CONTENT_PUBLIC_BASE')
    ) else source
    with storage.transaction():
        storage.write_json(config_path, cloud_settings)
        storage.remove(saved_cloud)
        if updated != source:
            storage.write_text(_site_path(), updated)
    return _view(cloud_settings, updated)


def _bucket_name_for(settings, pair, bucket_id, scope):
    if bucket_id == DEFAULT:
        return pair[scope]['bucket_name']
    return settings.get('bucket_groups', {}).get(bucket_id, {}).get(scope, {}).get('bucket_name', '')


def _host_rule(url_text, label):
    host = urlsplit((url_text or '').strip()).hostname
    if not host:
        raise ValueError(f'请先填写并保存{label}')
    return f'(http.host eq "{host}")'


def _worker_script_text():
    primary = Path(config.PROJECT_ROOT, 'data-manage', 'sync', 'cloudflare-worker-sync.js')
    source = primary if primary.is_file() else Path(__file__).resolve().parents[2].joinpath(
        'data-manage', 'sync', 'cloudflare-worker-sync.js')
    return source.read_text(encoding='utf-8')


def worker_setting(name):
    static_items = {
        'WORKER_SCRIPT': _worker_script_text,
        'PAGES_BUILD_COMMAND': lambda: 'npm ci --prefix _studio/tooling && node _studio/tooling/build-site.mjs',
        'PAGES_BUILD_OUTPUT': lambda: 'dist',
    }
    if name in static_items:
        return static_items[name]()

    settings = media_store.load_config()
    pair = _default_pair(settings)
    if not pair:
        raise ValueError('请先保存默认桶组')
    site = published_addresses()
    destinations = media_store.write_buckets(settings)
    if name == 'CDN_PHOTO_HOST_RULE':
        return _host_rule(site.get('MEDIA_PUBLIC_BASE'), '公开图片地址')
    if name == 'CDN_CONTENT_HOST_RULE':
        return _host_rule(site.get('CONTENT_PUBLIC_BASE'), '公开正文地址')
    if name == 'CDN_PHOTO_REWRITE_EXPR':
        bucket = _bucket_name_for(settings, pair, destinations['public_photo'], 'public')
        return f'concat("/file/{bucket}", http.request.uri.path)'
    if name == 'CDN_CONTENT_REWRITE_EXPR':
        bucket = _bucket_name_for(settings, pair, destinations['public_content'], 'public')
        return f'concat("/file/{bucket}", http.request.uri.path)'

    values = {'MEDIA_PUBLIC_S3': pair['public'], 'MEDIA_PRIVATE_S3': pair['private'],
              'MEDIA_BUCKET_GROUPS': _export_bucket_groups(settings),
              'MEDIA_PHOTO_BUCKETS': {scope: destinations[f'{scope}_photo'] for scope in SCOPES},
              'MEDIA_METADATA_BUCKET': DEFAULT,
              'PUBLIC_MEDIA_READS': 'true',
              'PUBLIC_CONTENT_READS': 'true' if site.get('CONTENT_PUBLIC_BASE') else 'false'}
    if name not in values:
        raise ValueError('未知的 Worker 配置项')
    value = values[name]
    return value if isinstance(value, str) else json.dumps(value, separators=(',', ':'))
