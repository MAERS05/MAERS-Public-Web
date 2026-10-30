"""媒体存储边界：可配置的 S3 兼容或本机文件后端，统一校验和故障恢复。"""

import hashlib
import json
import mimetypes
import os
from pathlib import Path
from botocore.exceptions import ClientError
import config
from . import storage_journal


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
    if not isinstance(key, str) or '\\' in key:
        raise ValueError('Invalid media key')
    parts = key.split('/')
    if len(parts) != 4 or parts[0] != 'photos' or parts[1] not in ('images', 'previews', 'thumbnails'):
        raise ValueError('Invalid media key')
    from .photos import media_component
    media_component(parts[2])
    media_component(parts[3])
    return key


class MediaAccessError(PermissionError):
    """可向用户展示的存储权限错误，不包含 SDK 请求或凭据。"""


class MediaStore:
    """业务仅依赖 read/write/delete/exists；SDK 类型和存储桶名封装在这里。"""
    def __init__(self, client=None, public=None, private=None, settings=None):
        if client is not None and (not public or not private or public == private):
            raise ValueError('Public and private media stores must be separate')
        self.client = client
        self.public = public
        self.private = private
        self.settings = settings or {}

    def identity(self):
        endpoint = self.settings.get('endpoint_url') or (
            f"https://{self.settings['account_id']}.r2.cloudflarestorage.com" if self.settings.get('account_id') else '')
        safe = {'provider': 'local' if self.client is None else 's3', 'endpoint': endpoint,
                'root': os.path.normcase(os.path.realpath(self.settings['root'])) if self.client is None else '',
                'public': self.public, 'private': self.private}
        return hashlib.sha256(json.dumps(safe, sort_keys=True).encode()).hexdigest()

    def _bucket(self, scope):
        if scope not in ('public', 'private'):
            raise ValueError('Invalid media scope')
        return self.public if scope == 'public' else self.private

    def _object_request(self, operation, scope, key, **options):
        try:
            return getattr(self.client, operation)(Bucket=self._bucket(scope), Key=key, **options)
        except ClientError as error:
            code = error.response.get('Error', {}).get('Code')
            status = error.response.get('ResponseMetadata', {}).get('HTTPStatusCode')
            if status in (401, 403) or code in ('401', '403', 'AccessDenied', 'UnauthorizedAccess'):
                label = '私有存储' if scope == 'private' else '公开存储'
                raise MediaAccessError(f'{label}访问被拒绝，请检查媒体凭据是否具有对应存储桶的对象读写权限') from error
            raise

    def _path(self, scope, key):
        _key(key)
        root = os.path.realpath(self.settings['root'])
        directory = os.path.realpath(os.path.join(root, scope))
        path = os.path.realpath(os.path.join(directory, key))
        if (os.path.normcase(directory) != os.path.normcase(os.path.join(root, scope))
                or os.path.commonpath([root, directory]) != root or os.path.commonpath([directory, path]) != directory):
            raise ValueError('Media path escapes backend')
        return path

    def read(self, scope, key):
        _key(key)
        if self.client is None:
            with open(self._path(scope, key), 'rb') as source:
                return source.read()
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
            storage_journal.atomic(self._path(scope, key), data)
        else:
            content_type = mimetypes.guess_type(key)[0] or 'application/octet-stream'
            self._object_request('put_object', scope, key, Body=data, ContentType=content_type)
        # 删除唯一源之前必须校验内容，而不只是检查对象存在。
        if hashlib.sha256(self.read(scope, key)).digest() != hashlib.sha256(data).digest():
            raise RuntimeError('Media checksum verification failed')

    def delete(self, scope, key):
        _key(key)
        if self.client is None:
            path = self._path(scope, key)
            if os.path.isfile(path):
                os.remove(path)
        else:
            self._object_request('delete_object', scope, key)

    def exists(self, scope, key):
        _key(key)
        if self.client is None:
            return os.path.isfile(self._path(scope, key))
        try:
            self._object_request('head_object', scope, key)
            return True
        except KeyError:
            return False
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound'):
                return False
            raise

    def keys(self, scope):
        if self.client is None:
            root = Path(self.settings['root']) / scope
            return sorted(str(p.relative_to(root)).replace('\\', '/') for p in root.rglob('*')
                          if p.is_file() and str(p.relative_to(root)).replace('\\', '/').startswith('photos/'))
        paginator = self.client.get_paginator('list_objects_v2')
        return [item['Key'] for page in paginator.paginate(Bucket=self._bucket(scope), Prefix='photos/')
                for item in page.get('Contents', [])]

    def recovery_record(self, action, keys):
        return {'kind': 'media', 'backend': self.identity(), 'action': action, 'keys': list(keys)}


def get_store():
    settings = load_config()
    provider = settings.get('provider', 's3')
    if provider == 'local':
        root = settings.get('root') or os.path.join(storage_journal.local_root(), 'media')
        if not os.path.isabs(root):
            root = os.path.join(config.PROJECT_ROOT, root)
        return MediaStore(settings={**settings, 'provider': 'local', 'root': os.path.realpath(root)})
    if provider not in ('s3', 'r2'):
        raise ValueError('Unsupported media provider')
    import boto3
    from botocore.config import Config
    endpoint = settings.get('endpoint_url')
    if not endpoint and settings.get('account_id'):
        endpoint = f"https://{settings['account_id']}.r2.cloudflarestorage.com"
    if not endpoint or not endpoint.startswith('https://'):
        raise ValueError('Media endpoint_url must use HTTPS')
    if not settings.get('access_key_id') or not settings.get('secret_access_key'):
        raise RuntimeError('Media credentials are not configured')
    client = boto3.client('s3', endpoint_url=endpoint, region_name=settings.get('region', 'auto'),
        aws_access_key_id=settings['access_key_id'].strip(), aws_secret_access_key=settings['secret_access_key'].strip(),
        config=Config(signature_version='s3v4', retries={'max_attempts': 2}, connect_timeout=10, read_timeout=30))
    return MediaStore(client, settings.get('public_bucket_name') or settings.get('bucket_name') or 'your-public-bucket',
                      settings.get('private_bucket_name') or 'your-private-bucket', settings)


def recover(record):
    if record.get('kind') == 'backup':
        from . import data_safety
        return data_safety.recover_backup(record)
    store = get_store()
    if record.get('kind') != 'media' or record.get('backend') != store.identity():
        raise RuntimeError('Restore the original media configuration before recovery')
    keys = record['keys']
    for key in keys:
        _key(key)
    if record['action'] == 'restore_public':
        for key in keys:
            if key.startswith('photos/images/'):
                store.write('public', key, store.read('private', key))
    elif record['action'] == 'retract_public':
        for key in keys:
            if key.startswith('photos/images/'):
                store.delete('public', key)
    else:
        raise ValueError('Invalid media compensation')
