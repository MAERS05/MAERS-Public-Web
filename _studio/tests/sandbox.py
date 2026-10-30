# -*- coding: utf-8 -*-
"""
沙盒夹具：内存级 R2/S3 客户端 + 与真实 data/、photos/ 完全隔离的临时环境。

仅沙盒套件导入本模块（会加载后端 routes/services 与 Pillow）。
"""

import io
import os
import shutil
import sqlite3
import tempfile
import time
import unittest
from unittest import mock

from . import helpers  # noqa: F401  确保 STUDIO_DIR 已注入 sys.path

import config
import routes
from services import cms, photos, album_lock, space, music, crypto_keyring, media_store


class MockS3Client:
    """内存级 Cloudflare R2 / S3 兼容客户端，用于沙盒测试公私桶迁移与故障回滚"""

    def __init__(self):
        self.buckets = {'pub-bucket': {}, 'priv-bucket': {}}
        self.fail_on_upload = False

    def _guard_upload(self, op):
        if self.fail_on_upload:
            raise RuntimeError(f"模拟 R2 S3 {op} 网络中断")

    def upload_file(self, local_path, bucket, key, ExtraArgs=None):
        self._guard_upload('upload_file')
        with open(local_path, 'rb') as f:
            data = f.read()
        ctype = (ExtraArgs or {}).get('ContentType', 'application/octet-stream')
        self.buckets.setdefault(bucket, {})[key] = {'data': data, 'content_type': ctype}

    def put_object(self, Bucket, Key, Body, ContentType='application/octet-stream'):
        self._guard_upload('put_object')
        data = Body.read() if hasattr(Body, 'read') else bytes(Body)
        self.buckets.setdefault(Bucket, {})[Key] = {'data': data, 'content_type': ContentType}

    def _entry(self, Bucket, Key):
        bucket = self.buckets.get(Bucket, {})
        if Key not in bucket:
            raise KeyError(f"NoSuchKey: {Bucket}/{Key}")
        return bucket[Key]

    def get_object(self, Bucket, Key):
        entry = self._entry(Bucket, Key)
        return {'Body': io.BytesIO(entry['data']), 'ContentType': entry['content_type']}

    def head_object(self, Bucket, Key):
        return {'ContentType': self._entry(Bucket, Key)['content_type']}

    def delete_object(self, Bucket, Key):
        self.buckets.get(Bucket, {}).pop(Key, None)

    def get_paginator(self, operation):
        if operation != 'list_objects_v2':
            raise ValueError('Unsupported mock operation')
        buckets = self.buckets
        class Paginator:
            def paginate(self, Bucket, Prefix=''):
                yield {'Contents': [{'Key': key} for key in sorted(buckets.get(Bucket, {})) if key.startswith(Prefix)]}
        return Paginator()


_CMS_SCHEMA = '''
    CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, module TEXT, parent_id TEXT, type TEXT, title TEXT,
        content TEXT, tags TEXT, created_at REAL, sort_order INTEGER, coverImage TEXT
    )
'''
_GALLERY_SCHEMA = '''
    CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY, category TEXT, name TEXT, path TEXT, thumb TEXT,
        preview TEXT, hash TEXT, created_at REAL, sort_order INTEGER, tags TEXT
    )
'''


class SandboxTestCase(unittest.TestCase):
    """
    每个用例拥有独立临时根目录；全部全局路径通过 mock.patch.object 重定向，
    并以 addCleanup 注册还原，即使 setUp 中途失败也不会污染真实数据或残留补丁。
    """

    def setUp(self):
        self.temp_root = tempfile.mkdtemp(prefix='maers_sandbox_')
        self.addCleanup(shutil.rmtree, self.temp_root, ignore_errors=True)

        self.temp_data = os.path.join(self.temp_root, 'data')
        self.temp_photos = os.path.join(self.temp_root, 'photos')
        os.makedirs(os.path.join(self.temp_data, 'tags'), exist_ok=True)
        os.makedirs(self.temp_photos, exist_ok=True)
        self.mock_s3 = MockS3Client()

        for target, attr, value in self._sandbox_patches():
            patcher = mock.patch.object(target, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        orig_cwd = os.getcwd()
        os.chdir(self.temp_root)
        self.addCleanup(os.chdir, orig_cwd)

        for name in ('notes', 'record', 'literature', 'games', 'videos', 'space'):
            cms.save_json(self.data_path(f'{name}-tree.json'), {'root': []})
        for name, value in [('photos-data', {}), ('album-config', []), ('music-data', [])]:
            cms.save_json(self.data_path(f'{name}.json'), value)

        self._exec_sql(config.CMS_DB, _CMS_SCHEMA)
        self._exec_sql(config.GALLERY_DB, _GALLERY_SCHEMA)

    def _sandbox_patches(self):
        d = self.data_path
        return [
            (config, 'PROJECT_ROOT', self.temp_root),
            (config, 'DATA_DIR', self.temp_data),
            (config, 'MODULES_JSON_FILE', d('admin-portal.json')),
            (config, 'ALBUM_CONFIG_JSON', d('album-config.json')),
            (config, 'INDEX_CARDS_JSON', d('index-cards.json')),
            (config, 'CHANGELOG_JSON', d('changelog.json')),
            (config, 'PHOTOS_ROOT', self.temp_photos),
            (config, 'CMS_DB', d('cms.db')),
            (config, 'GALLERY_DB', d('gallery.db')),
            (config, 'MUSIC_DATA', d('music-data.json')),
            (config, 'SPACE_DATA', d('space-tree.json')),
            (cms, 'PROJECT_ROOT', self.temp_root),
            (cms, 'DATA_DIR', self.temp_data),
            (cms, 'DB_PATH', d('cms.db')),
            (photos, 'PROJECT_ROOT', self.temp_root),
            (photos, 'DATA_DIR', self.temp_data),
            (photos, 'DB_PATH', d('gallery.db')),
            (photos, 'GALLERY_JSON_FILE', d('photos-data.json')),
            (photos, 'DISABLE_R2_SYNC', True),
            (media_store, 'get_store', lambda: media_store.MediaStore(self.mock_s3, 'pub-bucket', 'priv-bucket')),
            (space, 'PROJECT_ROOT', self.temp_root),
            (space, 'DATA_DIR', self.temp_data),
            (space, 'SPACE_JSON_PATH', d('space-collections.json')),
            (music, 'MUSIC_JSON_FILE', d('music-data.json')),
            (crypto_keyring, 'KEYRING_FILE', d('crypto-keyring.json')),
        ]

    # ---------- 路径与数据访问 ----------

    def data_path(self, *parts):
        return os.path.join(self.temp_data, *parts)

    def root_path(self, rel):
        return os.path.join(self.temp_root, rel)

    def load_json(self, abs_file):
        return helpers.read_json(abs_file)

    def gallery_json(self):
        return self.load_json(photos.GALLERY_JSON_FILE)

    def album_config(self):
        return self.load_json(config.ALBUM_CONFIG_JSON)

    @staticmethod
    def _exec_sql(db_path, sql, params=()):
        conn = sqlite3.connect(db_path)
        try:
            conn.execute(sql, params)
            conn.commit()
        finally:
            conn.close()

    def insert_cms_row(self, **row):
        cols = ', '.join(row)
        marks = ', '.join('?' for _ in row)
        self._exec_sql(config.CMS_DB, f'INSERT INTO nodes ({cols}) VALUES ({marks})', tuple(row.values()))

    def insert_gallery_row(self, **row):
        cols = ', '.join(row)
        marks = ', '.join('?' for _ in row)
        self._exec_sql(config.GALLERY_DB, f'INSERT INTO photos ({cols}) VALUES ({marks})', tuple(row.values()))

    # ---------- 路由调用（日志由 runner 的 buffer=True 统一捕获） ----------

    def call_get(self, path, query=None):
        return routes.dispatch_get(path, query or {})

    def call_post(self, path, query=None, body=None, file_data=None):
        if path == '/api/album/lock_category' and isinstance(body, dict) and 'expected_revision' not in body:
            code, snapshot = album_lock.export_category(body.get('id'))
            if code == 200:
                body['expected_revision'] = snapshot['revision']
        return routes.dispatch_post(path, query or {}, body if body is not None else {}, file_data=file_data)

    def cms(self, action, body, module='notes'):
        """CMS 节点操作快捷入口：POST /api/cms/node?module=..&action=.."""
        if action == 'lock' and 'sources' not in body:
            tree = cms.fetch_module_tree(module)
            node = next((node for node in cms.cms_store.walk(tree['root']) if node['id'] == body.get('id')), None)
            if node:
                body = {**body, 'sources': cms.cms_nodes.lock_sources(node, cms.get_context())}
        return self.call_post('/api/cms/node', {'module': [module], 'action': [action]}, body)

    def add_node(self, node_id, title, node_type='note', parent='root', module='notes'):
        code, res = self.cms('add', {'id': node_id, 'parentId': parent, 'type': node_type, 'title': title}, module)
        self.assertEqual(code, 200, f"新建节点失败: {res}")
        return res

    def fetch_tree(self, module='notes'):
        code, tree = self.call_get('/api/cms/fetch', {'module': [module]})
        self.assertEqual(code, 200, f"拉取 {module} 树失败: {tree}")
        return tree

    def upload_png(self, category, name, color):
        code, res = self.call_post('/upload', {'category': [category], 'name': [name]},
                                   file_data=helpers.make_test_png_bytes(color))
        self.assertEqual(code, 200, f"上传图片失败: {res}")
        return res

    def wait_album_job(self, job_id, timeout=5.0):
        """轮询相册后台迁移任务直至完成 (success / error)"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            code, job = self.call_post('/api/album/job', body={'id': job_id})
            self.assertEqual(code, 200, f"查询相册任务状态失败: {job}")
            if job.get('state') in ('success', 'error'):
                return job
            time.sleep(0.01)
        self.fail(f"相册后台任务超时未完成: {job_id}")
