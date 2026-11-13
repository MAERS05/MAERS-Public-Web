"""媒体存储边界：可配置的 S3 兼容或本机文件后端，统一校验和故障恢复。"""

import hashlib
import json
import mimetypes
import os
import re
from pathlib import Path
from threading import Lock
from botocore.exceptions import ClientError
import config
from . import local_media, photo_paths, storage, storage_journal


B2_ENDPOINT = re.compile(r'https://s3\.([a-z0-9-]+)\.backblazeb2\.com/?')
R2_ENDPOINT = re.compile(r'https://([0-9a-f]{32})(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com/?')
SPLIT_BUCKET_NAMES = {'b2': r'[A-Za-z0-9-]{6,63}', 'r2': r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]'}
BUCKET_ID = re.compile(r'[a-z0-9][a-z0-9_-]{0,31}')
DEFAULT_BUCKET = 'default'


def write_buckets(settings):
    content = settings.get('content_bucket', DEFAULT_BUCKET)
    defaults = {'public_content': content, 'private_content': content,
                'public_photo': DEFAULT_BUCKET, 'private_photo': DEFAULT_BUCKET}
    configured = settings.get('write_buckets', {})
    if not isinstance(configured, dict) or configured.keys() - defaults.keys():
        raise ValueError('写入桶配置无效')
    return {**defaults, **configured}


def load_config():
    tools = os.path.join(config.PROJECT_ROOT, '_studio', 'tools')
    for filename in ('media_config.json', 'r2_config.json'):
        path = os.path.join(tools, filename)
        if os.path.isfile(path):
            with open(path, encoding='utf-8') as source:
                value = json.load(source)
            if not isinstance(value, dict):
                raise ValueError('Invalid media configuration')
            return value
    return {'provider': 'local'}


def _key(key):
    photo_paths.media_parts(key)
    return key


class MediaAccessError(PermissionError):
    """可向用户展示的存储权限错误，不包含 SDK 请求或凭据。"""


def _endpoint(settings):
    return settings.get('endpoint_url') or (
        f"https://{settings['account_id']}.r2.cloudflarestorage.com" if settings.get('account_id') else '')


def _target_id(settings, bucket):
    endpoint = _endpoint(settings).lower().rstrip('/')
    if B2_ENDPOINT.fullmatch(endpoint):
        return 'b2', bucket.lower()
    r2 = R2_ENDPOINT.fullmatch(endpoint)
    if r2:
        return 'r2', r2.group(1), bucket
    return 's3', endpoint, bucket


def _pair_signature(pair):
    targets = (_target_id(target, target['bucket_name']) for target in (pair['public'], pair['private']))
    return '|'.join(f'{provider}:{"/".join(parts)}' for provider, *parts in targets)


def _route_key(key):
    if key.startswith('markdown/'):
        MediaStore.content_key(key)
        return '_maers/content-buckets/' + hashlib.sha256(key.encode()).hexdigest() + '.json'
    return '_maers/photo-buckets/' + hashlib.sha256(_key(key).encode()).hexdigest() + '.json'


class MediaStore:
    """业务仅依赖 read/write/delete/exists；SDK 类型和存储桶名封装在这里。"""
    def __init__(self, client=None, public=None, private=None, settings=None, *,
                 private_client=None, private_settings=None):
        self.client = client
        self.public = public
        self.private = private
        self.settings = settings or {}
        self._private_client = client if private_client is None else private_client
        self._private_settings = self.settings if private_settings is None else private_settings
        self.bucket_groups = {}
        self.content_bucket = DEFAULT_BUCKET
        self.write_buckets = write_buckets({})
        self.metadata_bucket = DEFAULT_BUCKET
        self._group_stores = {}
        self._group_lock = Lock()
        self._routes = {}
        if client is not None and (not public or not private or
                                   _target_id(self.settings, public) == _target_id(self._private_settings, private)):
            raise ValueError('Public and private media stores must be separate')

    def identity(self):
        endpoint = _endpoint(self.settings)
        safe = {'provider': 'local' if self.client is None else 's3', 'endpoint': endpoint,
                'root': os.path.normcase(os.path.realpath(self.settings['root'])) if self.client is None else '',
                'public': self.public, 'private': self.private}
        private_endpoint = _endpoint(self._private_settings)
        if private_endpoint != endpoint:
            safe['private_endpoint'] = private_endpoint
        return hashlib.sha256(json.dumps(safe, sort_keys=True).encode()).hexdigest()

    def _bucket(self, scope):
        if scope not in ('public', 'private'):
            raise ValueError('Invalid media scope')
        return self.public if scope == 'public' else self.private

    def _client_for(self, scope):
        return self._private_client if scope == 'private' else self.client

    def bucket_target(self, bucket_id):
        if bucket_id == DEFAULT_BUCKET:
            return self.identity()
        if not isinstance(bucket_id, str) or bucket_id not in self.bucket_groups:
            raise ValueError('未知的存储桶代号')
        return _pair_signature(self.bucket_groups[bucket_id])

    def bucket_id(self, key):
        if not self.bucket_groups or not key.startswith(('photos/', 'markdown/')):
            return DEFAULT_BUCKET
        route = _route_key(key)
        if route in self._routes:
            return self._routes[route]
        value = self.read_policy(route)
        if value is None:
            return DEFAULT_BUCKET
        identity = self._decode_route(value)
        self._routes[route] = identity
        return identity

    def _decode_route(self, data):
        record = json.loads(data)
        identity = record['bucketId']
        if identity == DEFAULT_BUCKET or record['target'] != self.bucket_target(identity):
            raise ValueError('文件所属桶的配置已变更，请恢复原桶')
        return identity

    def claim_bucket(self, key, bucket_id):
        """首次写入前登记归属。重试与以后更新继续使用同一存储位置。"""
        if bucket_id == DEFAULT_BUCKET and not self.bucket_groups:
            return
        target = self.bucket_target(bucket_id)
        route = _route_key(key)
        current = self.bucket_id(key)
        if current != DEFAULT_BUCKET:
            if current != bucket_id:
                raise ValueError('文件已登记到其他桶')
            return
        if bucket_id != DEFAULT_BUCKET:
            self.write_policy(route, json.dumps({'bucketId': bucket_id, 'target': target}).encode())
            self._routes[route] = bucket_id

    def verify_photo_rows(self, rows):
        from . import media_jobs
        drafts = media_jobs.drafts(row[field] for row in rows for field in ('path', 'thumb', 'preview') if row.get(field))
        for row in rows:
            bucket_id = row.get('bucketId') or row.get('bucket_id') or DEFAULT_BUCKET
            if bucket_id != DEFAULT_BUCKET:
                self.bucket_target(bucket_id)
            for field in ('path', 'thumb', 'preview'):
                key = row.get(field)
                draft = drafts.get(key)
                if draft:
                    media_jobs.check_target(self, draft)
                    assigned = draft['bucketId']
                elif key and bucket_id != DEFAULT_BUCKET:
                    assigned = self.bucket_id(key)
                else:
                    continue
                if assigned != bucket_id:
                    raise ValueError('图片索引与云端桶归属不一致，请先完成同步或恢复原配置')

    def _group(self, bucket_id):
        if bucket_id == DEFAULT_BUCKET:
            return self
        with self._group_lock:
            if bucket_id not in self._group_stores:
                self._group_stores[bucket_id] = _split_store(self.bucket_groups[bucket_id])
            return self._group_stores[bucket_id]

    def _object_request(self, operation, scope, key, *, bucket_id=None, **options):
        store = self._group(self.bucket_id(key) if bucket_id is None else bucket_id)
        try:
            return getattr(store._client_for(scope), operation)(Bucket=store._bucket(scope), Key=key, **options)
        except ClientError as error:
            code = error.response.get('Error', {}).get('Code')
            status = error.response.get('ResponseMetadata', {}).get('HTTPStatusCode')
            if status in (401, 403) or code in ('401', '403', 'AccessDenied', 'UnauthorizedAccess'):
                label = '私有存储' if scope == 'private' else '公开存储'
                raise MediaAccessError(f'{label}访问被拒绝，请检查媒体凭据是否具有对应存储桶的对象读写权限') from error
            raise

    def read(self, scope, key):
        _key(key)
        if self.client is None:
            if local_media.is_private(key) != (scope == 'private'):
                raise FileNotFoundError(key)
            return local_media.path(key).read_bytes()
        try:
            response = self._object_request('get_object', scope, key)
        except KeyError as error:
            raise FileNotFoundError(key) from error
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound'):
                raise FileNotFoundError(key) from error
            raise
        stream = response['Body']
        try:
            return stream.read()
        finally:
            stream.close()

    def write(self, scope, key, data):
        _key(key)
        if self.client is None:
            local_media.keep(key, data)
            local_media.set_private([key], scope == 'private')
            return
        content_type = mimetypes.guess_type(key)[0] or 'application/octet-stream'
        self._object_request('put_object', scope, key, Body=data, ContentType=content_type)
        # 删除唯一源之前必须校验内容，而不只是检查对象存在。
        if hashlib.sha256(self.read(scope, key)).digest() != hashlib.sha256(data).digest():
            raise RuntimeError('Media checksum verification failed')

    def read_private(self, key):
        """本机管理会话优先读图库原目录；缺失时读取私有桶。"""
        if self.client is not None:
            try:
                return local_media.path(key).read_bytes()
            except FileNotFoundError:
                pass
        return self.read('private', key)

    def delete(self, scope, key):
        _key(key)
        if self.client is None:
            if local_media.is_private(key) == (scope == 'private'):
                storage.remove(local_media.path(key))
                local_media.set_private([key], False)
        else:
            self._delete_remote(scope, key)

    def _delete_remote(self, scope, key, *, bucket_id=None):
        bucket_id = self.bucket_id(key) if bucket_id is None else bucket_id
        store = self._group(bucket_id)
        settings = store._private_settings if scope == 'private' else store.settings
        if settings.get('provider') != 'b2':
            self._object_request('delete_object', scope, key, bucket_id=bucket_id)
            return
        # B2 始终保留版本；只插入删除标记仍能按旧版本地址读取公开图片。
        paginator = store._client_for(scope).get_paginator('list_object_versions')
        pages = paginator.paginate(Bucket=store._bucket(scope), Prefix=key)
        versions = [entry for page in pages for field in ('Versions', 'DeleteMarkers')
                    for entry in page.get(field, []) if entry['Key'] == key]
        for entry in versions:
            self._object_request('delete_object', scope, key, bucket_id=bucket_id, VersionId=entry['VersionId'])

    def exists(self, scope, key):
        _key(key)
        if self.client is None:
            return local_media.is_private(key) == (scope == 'private') and local_media.path(key).is_file()
        try:
            self._object_request('head_object', scope, key)
            return True
        except KeyError:
            return False
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound'):
                return False
            raise

    @staticmethod
    def content_key(key):
        """正文镜像只允许 markdown/<模块>/<文件>.md，拒绝越界、隐藏段与反斜杠。"""
        if not isinstance(key, str) or '\\' in key or not key.endswith('.md'):
            raise ValueError('Invalid content key')
        parts = key.split('/')
        if len(parts) < 3 or parts[0] != 'markdown' or parts[1] == 'private' or any(part in ('', '.', '..') or ':' in part for part in parts):
            raise ValueError('Invalid content key')
        return key

    def write_content(self, key, data, scope='public'):
        """把正文写入指定存储桶（公开或私有）并校验内容；Cache-Control 要求每次回源校验。"""
        self.content_key(key)
        if self.client is None:
            raise RuntimeError('Content mirror requires remote storage')
        self._object_request('put_object', scope, key, Body=data,
                             ContentType='text/markdown; charset=utf-8',
                             CacheControl='private, max-age=0, must-revalidate' if scope == 'private' else 'public, max-age=0, must-revalidate')
        if hashlib.sha256(self._read_content(key, scope=scope)).digest() != hashlib.sha256(data).digest():
            raise RuntimeError('Content checksum verification failed')

    def _read_content(self, key, scope='public'):
        response = self._object_request('get_object', scope, key)
        try:
            return response['Body'].read()
        finally:
            response['Body'].close()

    def delete_content(self, key, scope='public'):
        self.content_key(key)
        if self.client is None:
            raise RuntimeError('Content mirror requires remote storage')
        # 与图片一致永久移除全部版本：正文被修改或删除后，B2 不能继续保留可读的旧版本。
        self._delete_remote(scope, key)

    def content_keys(self, scope='public'):
        """列出指定存储桶（公开或私有）中全部正文镜像对象，用于清理已删除的正文。"""
        if self.client is None:
            raise RuntimeError('Content mirror requires remote storage')
        return sorted({key for key in self._list_keys(scope, 'markdown/') if key.endswith('.md')})

    def _list_keys(self, scope, prefix, *, bucket_id=None):
        if bucket_id is not None:
            groups = (bucket_id,)
        elif prefix.startswith('_maers/'):
            groups = tuple(dict.fromkeys((DEFAULT_BUCKET, self.metadata_bucket)))
        else:
            groups = (DEFAULT_BUCKET, *self.bucket_groups)
        for bucket_id in groups:
            store = self._group(bucket_id)
            paginator = store._client_for(scope).get_paginator('list_objects_v2')
            for page in paginator.paginate(Bucket=store._bucket(scope), Prefix=prefix):
                yield from (item['Key'] for item in page.get('Contents', []))

    def keys(self, scope, include_policies=False):
        def allowed(key):
            if key.startswith('photos/'):
                return True
            if scope == 'private' and include_policies:
                if key.startswith(('_maers/content-buckets/', '_maers/content-groups/')):
                    return False
                try:
                    self._policy_key(key)
                    return True
                except ValueError:
                    pass
            return False
        if self.client is None:
            private = local_media.private_keys()
            keys = [key for key, _ in local_media.files(Path(config.PROJECT_ROOT).resolve())
                    if local_media.is_private(key, private) == (scope == 'private')]
            if scope == 'private' and include_policies:
                root = Path(self.settings['root']) / scope
                keys.extend(key for p in (root / '_maers').rglob('*.json')
                            if p.is_file() and allowed(key := p.relative_to(root).as_posix()))
            return sorted(keys)
        prefixes = ['photos/'] + (['_maers/'] if include_policies and scope == 'private' else [])
        return sorted({key for prefix in prefixes for key in self._list_keys(scope, prefix) if allowed(key)})

    def recovery_record(self, action, keys):
        record = {'kind': 'media', 'backend': self.identity(), 'action': action, 'keys': list(keys)}
        if self.bucket_groups:
            record['bucketTargets'] = {bucket_id: self.bucket_target(bucket_id) for bucket_id in self.bucket_groups}
            record['metadataBucket'] = self.metadata_bucket
        return record

    @staticmethod
    def _policy_key(key):
        if not re.fullmatch(r'_maers/(?:(?:media-groups|content-groups|photo-buckets|content-buckets)/[0-9a-f]{64}|'
                            r'private-token|private-tokens/(?:default|g_[0-9a-f]{32}))\.json', key):
            raise ValueError('Invalid private media policy key')
        return key

    def read_policy(self, key):
        """组权限旁路文件只位于私有存储，不允许借此读取任意对象。"""
        self._policy_key(key)
        if self.client is None:
            path = self._policy_path(key)
            return path.read_bytes() if path.is_file() else None
        metadata = self._group(self.metadata_bucket)
        value = metadata._read_remote_policy(key)
        return self._read_remote_policy(key) if metadata is not self and value is None else value

    def _read_remote_policy(self, key):
        try:
            response = self._object_request('get_object', 'private', key)
        except (KeyError, FileNotFoundError):
            return None
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound'):
                return None
            raise
        try:
            return response['Body'].read()
        finally:
            response['Body'].close()

    def write_policy(self, key, data):
        self._policy_key(key)
        if key.startswith(('_maers/photo-buckets/', '_maers/content-buckets/')):
            self._decode_route(data)
        self._routes.pop(key, None)
        if self.client is None:
            storage_journal.atomic(str(self._policy_path(key)), data)
        else:
            self._group(self.metadata_bucket)._object_request('put_object', 'private', key, Body=data,
                                                              ContentType='application/json')
        if self.read_policy(key) != data:
            raise RuntimeError('Private media policy verification failed')

    def delete_policy(self, key):
        self._policy_key(key)
        self._routes.pop(key, None)
        if self.client is None:
            path = self._policy_path(key)
            if path.is_file():
                path.unlink()
        else:
            metadata = self._group(self.metadata_bucket)
            # 先移除旧位置，避免删除新记录后又读到旧权限。
            self._delete_remote('private', key)
            if metadata is not self:
                metadata._delete_remote('private', key)

    def _policy_path(self, key):
        self._policy_key(key)
        root = Path(self.settings['root']).resolve()
        target = (root / 'private' / key).resolve()
        if not target.is_relative_to(root / 'private'):
            raise ValueError('Private policy path escapes storage root')
        return target


def _s3_client(settings):
    provider = settings.get('provider', 's3')
    if provider not in ('s3', 'r2', 'b2'):
        raise ValueError('Unsupported media provider')
    import boto3
    from botocore.config import Config
    endpoint = _endpoint(settings)
    if not isinstance(endpoint, str) or not endpoint.startswith('https://'):
        raise ValueError('Media endpoint_url must use HTTPS')
    region = settings.get('region', 'auto')
    if provider == 'b2':
        match = B2_ENDPOINT.fullmatch(endpoint)
        if not match:
            raise ValueError('Use the B2 bucket S3 endpoint_url')
        region = match.group(1)
    key_id = settings.get('access_key_id')
    secret_key = settings.get('secret_access_key')
    if any(not isinstance(value, str) or not value.strip() for value in (key_id, secret_key)):
        raise RuntimeError('Media credentials are not configured')
    return boto3.client('s3', endpoint_url=endpoint, region_name=region,
        aws_access_key_id=key_id.strip(), aws_secret_access_key=secret_key.strip(),
        config=Config(signature_version='s3v4', retries={'max_attempts': 2}, connect_timeout=10, read_timeout=30,
                      request_checksum_calculation='when_required', response_checksum_validation='when_required'))


def _validate_pair(pair):
    if not isinstance(pair, dict):
        raise ValueError('Invalid storage bucket group')
    for target in (pair.get('public'), pair.get('private')):
        if not isinstance(target, dict) or target.get('provider') not in ('b2', 'r2'):
            raise ValueError('Configure B2 or R2 for both public and private media')
        provider, bucket = target['provider'], target.get('bucket_name')
        if not isinstance(bucket, str) or not re.fullmatch(SPLIT_BUCKET_NAMES[provider], bucket):
            raise ValueError('Invalid media bucket_name')
        endpoint = target.get('endpoint_url')
        if not isinstance(endpoint, str) or not (B2_ENDPOINT if provider == 'b2' else R2_ENDPOINT).fullmatch(endpoint):
            raise ValueError('Use the bucket S3 endpoint_url for the configured provider')


def _split_store(pair):
    public, private = pair['public'], pair['private']
    return MediaStore(_s3_client(public), public['bucket_name'], private['bucket_name'], public,
                      private_client=_s3_client(private), private_settings=private)


def legacy_bucket_names(settings):
    return (settings.get('public_bucket_name') or settings.get('bucket_name') or 'maers-photos-public',
            settings.get('private_bucket_name') or 'maers-photos-private')


def _default_store(settings):
    if 'public' in settings or 'private' in settings:
        _validate_pair(settings)
        return _split_store(settings)
    if settings.get('provider') == 'local':
        root = settings.get('root') or os.path.join(storage_journal.local_root(), 'media')
        if not os.path.isabs(root):
            root = os.path.join(config.PROJECT_ROOT, root)
        return MediaStore(settings={**settings, 'provider': 'local', 'root': os.path.realpath(root)})
    public, private = legacy_bucket_names(settings)
    return MediaStore(_s3_client(settings), public, private, settings)


def get_store(settings=None):
    settings = load_config() if settings is None else settings
    if settings.get('metadata_bucket', DEFAULT_BUCKET) != DEFAULT_BUCKET:
        raise ValueError('归属与权限记录固定使用默认私密桶；旧配置请先迁移记录，再将 metadata_bucket 改为 default')
    store = _default_store(settings)
    groups = settings.get('bucket_groups', {})
    if not isinstance(groups, dict) or (groups and store.client is None):
        raise ValueError('Additional bucket groups require a remote default store')
    targets = {_target_id(store.settings, store.public), _target_id(store._private_settings, store.private)} if groups else set()
    for identity, pair in groups.items():
        if not isinstance(identity, str) or not BUCKET_ID.fullmatch(identity) or identity == DEFAULT_BUCKET:
            raise ValueError('Invalid storage bucket group ID')
        _validate_pair(pair)
        for scope in ('public', 'private'):
            target = _target_id(pair[scope], pair[scope]['bucket_name'])
            if target in targets:
                raise ValueError('每个存储位置必须使用独立的桶')
            targets.add(target)
    store.bucket_groups = groups
    store.content_bucket = settings.get('content_bucket', DEFAULT_BUCKET)
    store.write_buckets = write_buckets(settings)
    for bucket in (store.content_bucket, store.metadata_bucket, *store.write_buckets.values()):
        store.bucket_target(bucket)
    return store


def recover(record):
    if record.get('kind') == 'backup':
        from . import data_safety
        return data_safety.recover_backup(record)
    store = get_store()
    if record.get('kind') == 'media-policy' and record.get('backend') == store.identity():
        if record.get('before') is None:
            store.delete_policy(record['key'])
        else:
            store.write_policy(record['key'], bytes.fromhex(record['before']))
        return
    if record.get('kind') != 'media' or record.get('backend') != store.identity():
        raise RuntimeError('Restore the original media configuration before recovery')
    if (record.get('metadataBucket', store.metadata_bucket) != store.metadata_bucket or
            any(store.bucket_target(bucket_id) != target for bucket_id, target in record.get('bucketTargets', {}).items())):
        raise RuntimeError('Restore the original bucket groups before recovery')
    keys = record['keys']
    for key in keys:
        _key(key)
    if record['action'] == 'restore_public':
        for key in keys:
            store.write('public', key, store.read_private(key))
    elif record['action'] == 'retract_public':
        for key in keys:
            store.delete('public', key)
    elif record['action'] == 'retract_private':
        for key in keys:
            store.delete('private', key)
    else:
        raise ValueError('Invalid media compensation')
