"""合并时从选定的同步 Worker 取回 KV 图片。访问凭据仅随当前请求留在内存。"""
import hashlib
import json
import os
import re
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import config
from . import media_store, private_session

MAX_BYTES = 25 * 1024 * 1024
USER_AGENT = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')
MISSING = 'KV 中未找到图片原图；刚上传的图片可稍后重试，原图丢失则需重新上传'
_source = ContextVar('relay_media_source', default=None)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@dataclass(frozen=True)
class DraftImage:
    data: bytes
    bucket_id: str
    bucket_target: str | None

    def check_bucket(self, store):
        if store.client is None:
            raise ValueError('请先在电脑的存储设置中配置 B2 或 R2，再合并图片草稿')
        target = store.bucket_target(self.bucket_id)
        if self.bucket_id != media_store.DEFAULT_BUCKET and target != self.bucket_target:
            raise ValueError('图片草稿所选的桶组与电脑配置不一致，请同步存储配置后重试')


@contextmanager
def bind(endpoint, secret):
    paths = []
    if not secret:
        yield paths
        return
    parsed = urlsplit(endpoint)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment):
        raise ValueError('同步 Worker 地址必须为有效的 HTTPS 地址')
    token = _source.set((endpoint.rstrip('/'), secret, paths))
    try:
        yield paths
    finally:
        _source.reset(token)


def active():
    return _source.get() is not None


def archive_upload(body):
    """停用的桶直传记录先落盘，成功后前端才确认移出云端队列。"""
    from . import storage
    source, item = body['source'], body['item']
    parsed = urlsplit(source)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment):
        raise ValueError('同步 Worker 地址必须为有效的 HTTPS 地址')
    key, draft = item.get('key'), item.get('data')
    if (not isinstance(key, str) or not re.fullmatch(r'sync_request_[0-9a-fA-F-]{36}', key)
            or not isinstance(draft, dict) or draft.get('module') != 'photos'
            or draft.get('action') != 'upload' or draft.get('awaitingPhoto') is not True):
        raise ValueError('只能清理已停用的旧上传记录')
    record = {'source': source.rstrip('/'), 'item': item}
    identity = hashlib.sha256(json.dumps([record['source'], key]).encode()).hexdigest()
    path = os.path.join(config.PROJECT_ROOT, '_studio', '.local', 'relay-retired', identity + '.json')
    with storage.transaction():
        if os.path.exists(path):
            with open(path, encoding='utf-8') as saved:
                if json.load(saved) != record:
                    raise ValueError('旧上传记录与已有备份不一致，已保留云端记录')
        else:
            storage.write_json(path, record)
    return {'archived': True}


def read(path, group=None):
    """区分文件不存在与权限、额度或网络错误，后者必须保留草稿等待重试。"""
    media_store._key(path)
    source = _source.get()
    if source is None:
        return None
    endpoint, secret, paths = source
    # 网关开启浏览器检查时会拒绝 urllib 的默认客户端标识。
    headers = {'x-sync-key': secret, 'User-Agent': USER_AGENT, 'Accept': 'application/octet-stream, application/json'}
    query = {'path': path}
    if group:
        query['g'] = group
        headers['x-private-media-token'] = private_session.group_token(group)
    request = Request(endpoint + '/api/drafts/media?' + urlencode(query), headers=headers)
    try:
        with build_opener(_NoRedirect()).open(request, timeout=60) as response:
            size = int(response.headers.get('X-Maers-Image-Size', '0'))
            if not 0 < size <= MAX_BYTES:
                raise ValueError('Worker 返回的图片大小无效，KV 单文件上限为 25 MiB')
            data = response.read(size + 1)
            if len(data) != size:
                raise ValueError('云端图片未完整下载，请重试合并')
            bucket = response.headers.get('X-Maers-Bucket', '')
            if not media_store.BUCKET_ID.fullmatch(bucket):
                raise ValueError('Worker 未返回有效的图片桶组')
            image = DraftImage(data, bucket, response.headers.get('X-Maers-Bucket-Target'))
    except HTTPError as error:
        with error:
            detail = b''
            try:
                detail = error.read(8192)
                result = json.loads(detail)
            except (ValueError, OSError):
                result = None
        if error.code == 403 and b'1010' in detail:
            raise ValueError('Cloudflare 浏览器检查拦截了电脑下载请求（1010），请检查同步网关的安全规则') from None
        if error.code == 404:
            if isinstance(result, dict) and result.get('code') == 'draft_image_missing':
                return None
            raise ValueError('请更新同步 Worker，再拉取 KV 图片草稿') from None
        message = result.get('error') if isinstance(result, dict) else None
        raise ValueError(message or f'图片草稿读取失败（HTTP {error.code}）') from None
    except (URLError, TimeoutError, ConnectionError, HTTPException):
        raise ValueError('连接同步 Worker 读取图片超时或失败，请重试合并') from None
    paths.append(path)
    return image
