"""私密管理回归：真实加密的内存编辑、图片迁移、密码组权限及回环鉴权。"""

import base64
import contextlib
import hashlib
import json
import os
import threading
from functools import partial
from pathlib import Path
from unittest import mock

from .sandbox import SandboxTestCase, cms, photos, config
from services import local_media
from services import storage, media_store, data_safety, crypto_keyring
from services import private_session, private_photos, private_cms, cms_nodes, cms_store


@contextlib.contextmanager
def _private_http_server():
    """启动真实私密管理路由，并确保测试结束或失败后收回服务线程。"""
    import routes
    import server
    with mock.patch.object(server, 'routes', routes), mock.patch.object(server.Handler, 'log_message'), \
            server.LocalServer(0) as httpd:
        worker = threading.Thread(target=httpd.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        worker.start()
        try:
            yield httpd
        finally:
            httpd.shutdown()
            worker.join(timeout=2)


def _http_request(address, path, headers=None, method='GET', body=None):
    """发送单次回环请求并读完响应，始终关闭客户端连接。"""
    import http.client
    with contextlib.closing(http.client.HTTPConnection(*address, timeout=5)) as client:
        client.request(method, path, body=body, headers=headers or {})
        response = client.getresponse()
        return response.status, dict(response.getheaders()), response.read()


class Test13_PrivateAdmin(SandboxTestCase):
    """真实 AES-GCM 的后台内存编辑回归，所有文件和图片仅使用独立沙盒。"""

    def _merge_public_picture(self, category):
        import routes
        from .helpers import make_test_png_bytes
        from services import relay_media
        path = f'photos/images/{category}/20261110_120000_' + '1' * 32 + '.png'
        body = {'category': category, 'name': path.rsplit('/', 1)[1], 'path': path,
                '_relay': {'source': 'https://relay.example', 'key': f'kv-photo-{category}'}}
        draft = relay_media.DraftImage(make_test_png_bytes('blue'), 'default', None)
        with mock.patch.object(relay_media, 'read', return_value=draft):
            code, result = routes.dispatch_post('/api/photos/register', {}, body, relay_secret='test-access')
        self.assertEqual(code, 200, result)
        return result

    def test_public_kv_photo_merges_into_now_private_album_without_public_copy(self):
        from services import media_groups
        group, _, _, _ = self.group_fixture(register_token=False)
        payload = {'category': {'id': 'secret-album', 'title': 'PRIVATE_ALBUM'}, 'photos': [], 'tags_file': '[]'}
        cipher = private_session.crypt('encrypt', [payload], group)[0]
        storage.write_json(config.ALBUM_CONFIG_JSON, [{'_enc': cipher, '_group': group}])
        first = self._merge_public_picture('secret-album')
        second = self._merge_public_picture('secret-album')
        self.assertEqual(first, second, '同一草稿重试应复用回执')
        rows = private_photos.entry('secret-album')['payload']['photos']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['id'], first['id'])
        self.assertEqual(self.gallery_json(), {})
        self.assertFalse(self.mock_s3.buckets['pub-bucket'])
        store = media_store.get_store()
        for field in ('path', 'thumb', 'preview'):
            key = first[field]
            self.assertIn(key, self.mock_s3.buckets['priv-bucket'])
            self.assertEqual(json.loads(store.read_policy(media_groups.policy_key(key)))['groups'], [group])
            self.assertTrue(local_media.is_private(key))
        self.assertNotIn('PRIVATE_ALBUM', Path(config.ALBUM_CONFIG_JSON).read_text(encoding='utf-8'))

    def test_kv_album_photo_first_publishes_to_private_bucket(self):
        """手机合并后即可加锁，首次写正式存储时只写私密桶。"""
        from services import album_lock, media_groups, media_jobs
        group, _, _, _ = self.group_fixture(register_token=False)
        token = private_session.group_token_hash(group)
        self.call_post('/api/add_category', body={'id': 'travel', 'title': '相册'})
        image = self._merge_public_picture('travel')
        keys = [image[field] for field in ('path', 'thumb', 'preview')]
        _, snapshot = album_lock.export_category('travel')
        cipher = private_session.crypt('encrypt', [snapshot], group)[0]
        code, started = self.call_post('/api/album/lock_category', body={
            'id': 'travel', 'enc': cipher, 'group': group, 'expected_revision': snapshot['revision']})
        self.assertEqual(code, 200, started)
        job = self.wait_album_job(started['job'])
        self.assertEqual(job['state'], 'success', job)
        store = media_store.get_store()
        self.assertFalse(self.mock_s3.buckets['pub-bucket'])
        self.assertFalse(self.mock_s3.buckets['priv-bucket'])
        for key in keys:
            self.assertTrue(local_media.path(key).is_file())
            self.assertTrue(local_media.is_private(key))
        self.assertEqual(media_jobs.retry()['completed'], 0)

        private_session.close({})
        self.assertEqual(media_jobs.retry(for_publish=True)['completed'], 3)
        self.assertEqual(json.loads(store.read_policy(f'_maers/private-tokens/{group}.json')), {'hash': token})
        self.assertFalse(self.mock_s3.buckets['pub-bucket'])
        for key in keys:
            self.assertIn(key, self.mock_s3.buckets['priv-bucket'])
            self.assertEqual(json.loads(store.read_policy(media_groups.policy_key(key))), {'groups': [group], 'key': key})

    def test_private_sibling_name_conflicts_keep_cipher_and_public_note(self):
        """私密目录也禁止同级重名，公开文档移入冲突目录时不能先被转为私密。"""
        context = cms.get_context()
        cms_nodes.add_node('notes', 'root', 'folder', 'PRIVATE_FOLDER', context, node_id='folder')
        private_cms.protect('notes', 'folder')
        cms_nodes.add_node('notes', 'folder', 'note', '同名', context, node_id='one')
        cms_nodes.add_node('notes', 'folder', 'note', '另一篇', context, node_id='two')
        cms_nodes.add_node('notes', 'root', 'note', '同名', context, node_id='public')
        before = self.load_json(self.data_path('notes-tree.json'))
        for operation in [
            lambda: cms_nodes.add_node('notes', 'folder', 'note', '同名', context, node_id='bad'),
            lambda: cms_nodes.update_node('notes', 'two', {'title': '同名'}, context),
            lambda: cms_nodes.move_node('notes', 'public', 'folder', context),
        ]:
            with self.assertRaisesRegex(ValueError, '同名'):
                operation()
            self.assertEqual(self.load_json(self.data_path('notes-tree.json')), before)
        public = cms_nodes._find(cms.fetch_module_tree('notes'), 'public')[2]
        self.assertNotIn('_private', public)
        self.assertTrue(Path(self.root_path(public['content'])).is_file())

    def test_studio_status_reports_album_progress_without_waiting_for_data_lock(self):
        """迁移占用写锁时，重开的页面仍能读取真实进度，后台状态保持 ready。"""
        from services import album_lock
        entered, release = threading.Event(), threading.Event()
        def migrate(progress):
            progress()
            entered.set()
            release.wait(timeout=5)
            return 200, {'status': 'success'}
        with _private_http_server() as httpd:
            try:
                code, started = album_lock._start_job(2, migrate, '正在恢复公开图片')
                self.assertEqual(code, 200)
                self.assertTrue(entered.wait(timeout=3))
                code, _, body = _http_request(httpd.server_address, '/api/studio/status')
                self.assertEqual(code, 200)
                status = json.loads(body)
                self.assertEqual(status['state'], 'ready')
                self.assertEqual(status['operation'], {'message': '正在恢复公开图片', 'done': 1, 'total': 2})
            finally:
                release.set()
            self.assertEqual(self.wait_album_job(started['job'])['state'], 'success')

    def test_local_automatic_management_restores_all_groups_without_plaintext_on_disk(self):
        """本机登记后关闭会话可自动恢复全组，落盘只有用户保护后的密钥。"""
        from services import local_crypto_access
        root_raw = private_session.session_keys()['default']
        group_raw = base64.b64encode(os.urandom(32)).decode()
        identity = 'g_' + 'a' * 32
        slot = {'salt': 'YQ==', 'iter': 100000, 'wrap': 'enc:YQ==.Yg=='}
        wrap = private_session.crypt('encrypt', [{'purpose': 'master-group-v1', 'group': identity, 'k': group_raw}])[0]
        ring = {'v': 1, 'dek_id': private_session.key_identity(root_raw), 'pw': slot, 'rc': slot,
                'master_only': True, 'media_base': '', 'groups': {identity: {
                    'v': 1, 'dek_id': private_session.key_identity(group_raw), 'name': '自动管理组',
                    'pw': slot, 'rc': slot, 'master_wrap': wrap}}}
        crypto_keyring.write_ring(ring)
        # 非 Windows 只替换系统保护边界，业务恢复仍执行真实 AES-GCM。
        guard = contextlib.nullcontext() if os.name == 'nt' else mock.patch.object(
            local_crypto_access, '_protect', side_effect=lambda data, decrypt=False: data[::-1])
        with guard:
            self.assertEqual(local_crypto_access.open_session()[0], 428)
            local_crypto_access.remember({'default': root_raw})
            stored = Path(local_crypto_access._path()).read_bytes()
            self.assertNotIn(root_raw.encode(), stored)
            self.assertNotIn(group_raw.encode(), stored)
            private_session.close({})
            code, result = local_crypto_access.open_session()
            self.assertEqual(code, 200)
            self.assertEqual(result['keys'], {'default': root_raw, identity: group_raw})
            self.assertTrue(private_session.group_unlocked(identity))
            with self.assertRaises(ValueError):
                local_crypto_access.remember({'default': group_raw})
            self.assertEqual(Path(local_crypto_access._path()).read_bytes(), stored)
            self.assertTrue(local_crypto_access.status()['enabled'])
            self.assertEqual(self.call_post('/api/crypto/local-access', body={'enabled': 'false'})[0], 400)
            self.assertFalse(local_crypto_access.configure({'enabled': False})['enabled'])
            self.assertNotIn('protected', self.load_json(local_crypto_access._path()))
            # 后续正常登录仍可管理，但不能把用户关闭的免密登记自动打开。
            private_session.start({'keys': result['keys'], 'remember': True})
            self.assertFalse(local_crypto_access.status()['enabled'])
            private_session.close({})
            code, disabled = local_crypto_access.open_session()
            self.assertEqual(code, 428)
            self.assertEqual(disabled['code'], 'local_password_required')
            self.assertFalse(private_session.active())
            with self.assertRaises(PermissionError):
                local_crypto_access.configure({'enabled': True})
            private_session.start({'keys': result['keys']})
            self.assertTrue(local_crypto_access.configure({'enabled': True})['enabled'])
            private_session.close({})
            self.assertEqual(local_crypto_access.open_session()[0], 200)
            private_session.close({})
            storage.write_json(local_crypto_access._path(), {'v': 1, 'protected': 'broken'})
            self.assertEqual(local_crypto_access.open_session()[0], 428)
            self.assertFalse(private_session.active())

    def test_invalid_private_media_edit_keeps_existing_cover_metadata(self):
        """封面本身合法但正文含未知图片时，整次校验失败且不改动原封面。"""
        original = {'path': 'photos/images/_notes/original.png'}
        replacement = {'path': 'photos/images/_notes/replacement.png'}
        node = {'coverRow': original, 'mediaRows': [original, replacement]}
        changes = {'coverImage': replacement['path'], 'content': '![](photos/images/_notes/unknown.png)'}
        with self.assertRaisesRegex(ValueError, '上传按钮'):
            private_cms.validate_edit(node, changes)
        self.assertIs(node['coverRow'], original)
        private_cms.validate_edit(node, {'coverImage': replacement['path']})
        self.assertIs(node['coverRow'], replacement)
        private_cms.validate_edit(node, {'coverImage': None})
        self.assertNotIn('coverRow', node)

    def test_public_folder_with_missing_media_stops_before_migration(self):
        """公开目录缺少插图索引时，原目录与正文保持原样，私有存储没有半成品。"""
        self.add_node('folder', '公开目录', node_type='folder')
        self.add_node('note', '公开正文', parent='folder')
        self.cms('update', {'id': 'note', 'data': {'content': '![](photos/images/_notes/missing.png)'}})
        before = self.load_json(self.data_path('notes-tree.json'))
        note = cms_nodes._find(cms.fetch_module_tree('notes'), 'note')[2]
        markdown = Path(self.root_path(note['content'])).read_bytes()
        with self.assertRaisesRegex(ValueError, '图片未在公开索引'):
            private_cms.protect('notes', 'folder')
        self.assertEqual(self.load_json(self.data_path('notes-tree.json')), before)
        self.assertEqual(Path(self.root_path(note['content'])).read_bytes(), markdown)
        self.assertFalse(self.mock_s3.buckets['priv-bucket'])

    def test_public_folder_protect_rejects_nested_record_from_another_group(self):
        """已解锁的子记录仍保留原密码组，不能随父目录静默重新打包。"""
        group, _, _, _ = self.group_fixture()
        payload = {'id': 'child', 'type': 'note', 'title': 'PRIVATE_CHILD', 'md': 'PRIVATE_BODY', 'children': None}
        child = {'id': 'child', 'type': 'locked', 'children': None, '_group': group,
                 '_enc': private_session.crypt('encrypt', [payload], group)[0]}
        tree = {'root': [{'id': 'folder', 'type': 'folder', 'title': '公开目录', 'children': [child]}]}
        storage.write_json(self.data_path('notes-tree.json'), tree)
        private_before = dict(self.mock_s3.buckets['priv-bucket'])
        with self.assertRaisesRegex(ValueError, '其他密码组'):
            private_cms.protect('notes', 'folder')
        self.assertEqual(self.load_json(self.data_path('notes-tree.json')), tree)
        self.assertEqual(self.mock_s3.buckets['priv-bucket'], private_before)

    def test_failed_album_migration_restores_previous_password_group_policy(self):
        """私有图片上传失败必须回滚先前写入的权限，不能提交半完成的换组结果。"""
        from services import album_lock, media_groups
        group, _, _, _ = self.group_fixture(register_token=False)
        self.call_post('/api/add_category', body={'id': 'travel', 'title': '相册'})
        image = self.upload_png('travel', 'kept.png', 'blue')
        keys = [image[field] for field in ('path', 'thumb', 'preview')]
        store = media_store.get_store()
        with storage.transaction():
            media_groups.assign(keys, 'default')
        policies = {key: store.read_policy(media_groups.policy_key(key)) for key in keys}
        payload = {'category': {'id': 'travel'}, 'photos': [], 'tags_file': None}
        cipher = private_session.crypt('encrypt', [payload], group)[0]
        original_put = self.mock_s3.put_object
        def fail_private_image(Bucket, Key, **kwargs):
            if Bucket == 'priv-bucket' and Key.startswith('photos/'):
                raise OSError('private media upload failed')
            return original_put(Bucket=Bucket, Key=Key, **kwargs)
        with mock.patch.object(self.mock_s3, 'put_object', side_effect=fail_private_image):
            code, started = self.call_post('/api/album/lock_category', body={
                'id': 'travel', 'enc': cipher, 'group': group})
            self.assertEqual(code, 200, started)
            job = self.wait_album_job(started['job'])
        self.assertEqual(job['state'], 'error')
        self.assertNotIn('private media upload failed', job['result']['error'])
        self.assertIsNone(store.read_policy(f'_maers/private-tokens/{group}.json'))
        for key in keys:
            self.assertEqual(store.read_policy(media_groups.policy_key(key)), policies[key])
            self.assertTrue(Path(self.root_path(key)).is_file())
        self.assertEqual(self.album_config()[0]['id'], 'travel')
        self.assertEqual(len(album_lock.rows_by_paths([image['path']])), 1)

    def test_album_lock_registers_unsynced_group_token(self):
        """相册迁入私有存储时登记该组令牌和三种尺寸的访问权限。"""
        from services import album_lock, media_groups
        group, _, _, raw = self.group_fixture(register_token=False)
        with self.assertRaisesRegex(ValueError, 'Invalid private management keys'):
            private_session.start({'keys': {group: raw}})
        self.call_post('/api/add_category', body={'id': 'travel', 'title': '相册'})
        image = self.upload_png('travel', 'new.png', 'blue')
        _, snapshot = album_lock.export_category('travel')
        cipher = private_session.crypt('encrypt', [snapshot], group)[0]
        code, started = self.call_post('/api/album/lock_category', body={
            'id': 'travel', 'enc': cipher, 'group': group, 'expected_revision': snapshot['revision']})
        self.assertEqual(code, 200, started)
        job = self.wait_album_job(started['job'])
        self.assertEqual(job['state'], 'success', job)
        store = media_store.get_store()
        token = store.read_policy(f'_maers/private-tokens/{group}.json')
        self.assertEqual(json.loads(token), {'hash': private_session.group_token_hash(group)})
        self.assertEqual(self.album_config()[0]['_group'], group)
        for field in ('path', 'thumb', 'preview'):
            key = image[field]
            self.assertTrue(store.exists('private', key))
            self.assertEqual(json.loads(store.read_policy(media_groups.policy_key(key))), {'groups': [group], 'key': key})

    def test_malformed_media_cookie_is_denied(self):
        from http.cookies import CookieError, SimpleCookie
        with mock.patch.object(SimpleCookie, 'load', side_effect=CookieError('invalid cookie')):
            self.assertFalse(private_session.media_authorized('malformed'))

    def group_fixture(self, *, register_token=True):
        """为独立密码组准备真实数据密钥、密钥环和私密媒体访问令牌。"""
        raw = base64.b64encode(os.urandom(32)).decode()
        identity = 'g_' + 'a' * 32
        slot = {'salt': 'YQ==', 'iter': 100000, 'wrap': 'enc:wrapped'}
        default = private_session.session_keys()['default']
        ring = {'v': 1, 'dek_id': hashlib.sha256(('maers-dek-id|' + default).encode()).hexdigest()[:16],
                'pw': slot, 'rc': slot, 'media_base': '', 'updated': '',
                'groups': {identity: {'v': 1, 'name': '分享组', 'pw': slot, 'rc': slot,
                'dek_id': hashlib.sha256(('maers-dek-id|' + raw).encode()).hexdigest()[:16]}}}
        base = {key: value for key, value in ring.items() if key != 'groups'}
        crypto_keyring.write_ring(base)
        self.assertEqual(crypto_keyring.save({**ring, '_expected': crypto_keyring.revision(base)})[0], 200)
        private_session.start({'keys': {'default': default, identity: raw}})
        if register_token:
            media_store.get_store().write_policy(f'_maers/private-tokens/{identity}.json',
                json.dumps({'hash': private_session.group_token_hash(identity)}).encode())
        return identity, ring, default, raw

    def test_groups_partial_save_and_reassignment_preserve_other_cipher(self):
        """只解锁一组时另一组密文保持不变；批量换组连同图片权限迁移，仍有关联内容的组不能删除。"""
        from services import crypto_groups, media_groups
        group, ring, default, raw = self.group_fixture()
        key = 'photos/images/_notes/shared.png'
        store = media_store.get_store()
        store.write('private', key, b'image')
        def envelope(identity, title, scope):
            body = {'id': identity, 'type': 'note', 'title': title, 'md': title + '_BODY',
                    'mediaRows': [{'path': key}] if scope == 'default' else [], 'children': None}
            return {'id': identity, 'type': 'locked', 'children': None,
                    '_enc': private_session.crypt('encrypt', [body], scope)[0],
                    **({'_group': scope} if scope != 'default' else {})}
        a, b = envelope('a', 'TITLE_A', 'default'), envelope('b', 'TITLE_B', group)
        with storage.transaction():
            media_groups.assign([key], 'default')
            storage.write_json(self.data_path('notes-tree.json'), {'root': [a, b]})
        private_session.start({'keys': {'default': default}})
        tree = cms.fetch_module_tree('notes')
        self.assertEqual(tree['root'][1], b)
        cms_nodes.update_node('notes', 'a', {'title': 'EDIT_A'}, cms.get_context())
        self.assertEqual(self.load_json(self.data_path('notes-tree.json'))['root'][1], b)
        self.assertNotIn('TITLE_B', json.dumps(crypto_groups.catalog()))
        private_session.start({'keys': {'default': default, group: raw}})
        item = next(item for item in crypto_groups.catalog()['items'] if item['title'] == 'EDIT_A')
        result = crypto_groups.assign({'group': group, 'items': [item]})
        self.assertEqual(result['changed'], 1)
        saved = self.load_json(self.data_path('notes-tree.json'))['root']
        self.assertEqual(saved[0]['_group'], group)
        self.assertEqual(saved[1], b)
        self.assertEqual(private_session.crypt('decrypt', [saved[0]['_enc']], group)[0]['title'], 'EDIT_A')
        self.assertEqual(json.loads(store.read_policy(media_groups.policy_key(key)))['groups'], [group])
        self.assertEqual(crypto_keyring.save({**ring, 'groups': {}})[0], 409)
        self.assertNotIn('rc', crypto_keyring.public_ring(ring)['groups'][group])
        self.assert_private_source('TITLE_A', 'TITLE_B', 'EDIT_A')
        backup = data_safety.create_backup('cloud')
        store.delete_policy(media_groups.policy_key(key))
        data_safety.restore_backup(backup['id'])
        self.assertEqual(json.loads(store.read_policy(media_groups.policy_key(key)))['groups'], [group])

    def test_groups_stale_request_and_policy_failure_leave_sources_intact(self):
        """过期的内容版本和中途权限写入失败不能留下部分迁移。"""
        from services import crypto_groups, media_groups
        group, _, _, _ = self.group_fixture()
        node = self.protected_note()
        item = next(item for item in crypto_groups.catalog()['items'] if item['reference'] == node['_private_id'])
        before = self.load_json(self.data_path('notes-tree.json'))
        with self.assertRaises(ValueError):
            crypto_groups.assign({'group': group, 'items': [{**item, 'revision': 'stale'}]})
        self.assertEqual(self.load_json(self.data_path('notes-tree.json')), before)
        store = media_store.get_store()
        key = 'photos/images/_notes/a.png'
        with storage.transaction():
            media_groups.assign([key], 'default')
        original = store.read_policy(media_groups.policy_key(key))
        with self.assertRaises(RuntimeError), storage.transaction():
            media_groups.assign([key], group, remove='default')
            raise RuntimeError('simulate subsequent source failure')
        self.assertEqual(store.read_policy(media_groups.policy_key(key)), original)

    def setUp(self):
        private_session.close({})
        super().setUp()
        self.addCleanup(private_session.close, {})
        raw = base64.b64encode(os.urandom(32)).decode()
        storage.write_json(crypto_keyring.KEYRING_FILE, {
            'dek_id': hashlib.sha256(('maers-dek-id|' + raw).encode()).hexdigest()[:16]})
        private_session.start({'keys': {'default': raw}})
        self.enterContext(private_session.context())

    def protected_note(self, identity='secret'):
        """向沙盒写入笔记密文，再返回后台解密后的内存视图。"""
        payload = {'id': identity, 'type': 'note', 'title': 'PRIVATE_TITLE', 'md': 'PRIVATE_BODY',
                   'tags': [], 'coverImage': None, 'children': None}
        cipher = private_session.crypt('encrypt', [payload])[0]
        storage.write_json(self.data_path('notes-tree.json'), {'root': [
            {'id': identity, 'type': 'locked', 'children': None, 'mediaVersion': 1, '_enc': cipher}]})
        return cms.fetch_module_tree('notes')['root'][0]

    def assert_private_source(self, *markers):
        """检查索引不含明文标记，且没有落盘的 Markdown 明文副本。"""
        for name in ('notes-tree.json', 'album-config.json', 'photos-data.json'):
            text = Path(self.data_path(name)).read_text(encoding='utf-8')
            for marker in markers:
                self.assertNotIn(marker, text)
        self.assertFalse(list(Path(self.temp_data).rglob('*.md')))
        self.assertFalse(list(Path(self.temp_markdown).rglob('*.md')))

    def test_cloud_private_cms_receipt_preserves_cipher_and_rejects_stale_edit(self):
        self.protected_note()
        path = self.data_path('notes-tree.json')
        original = self.load_json(path)['root'][0]['_enc']
        relay = {'_relay_source': ['https://relay.invalid']}
        public_query = {**relay, '_relay_key': ['sync-public'], 'module': ['notes'], 'action': ['add']}
        self.assertEqual(self.call_post('/api/cms/node', public_query,
            {'id': 'public', 'parentId': 'root', 'type': 'folder', 'title': 'Public'})[0], 200)
        self.assertIn(original, [node.get('_enc') for node in self.load_json(path)['root']])

        before = private_session.crypt('decrypt', [original])[0]
        edited = {**before, 'md': 'CLOUD_PRIVATE_BODY', 'title': 'CLOUD_PRIVATE_TITLE'}
        cipher = private_session.crypt('encrypt', [edited])[0]
        body = {'source': 'notes', 'group': 'default',
                'revision': hashlib.sha256(original.encode()).hexdigest(), 'enc': cipher}
        query = {**relay, '_relay_key': ['sync-private'], '_operation': ['1' * 32]}
        endpoint = '/api/private/relay-edit'
        self.assertEqual(self.call_post(endpoint, query, {**body, 'content': 'PLAINTEXT'})[0], 400)
        self.assertEqual(self.call_post(endpoint, query, {**body, 'enc': 'not ciphertext'})[0], 400)
        self.assertEqual(self.call_post(endpoint, query, body)[0], 200)
        retry_query = {**query, '_operation': ['2' * 32]}
        self.assertEqual(self.call_post(endpoint, retry_query, body)[0], 200)
        stale = private_session.crypt('encrypt', [{**edited, 'md': 'STALE'}])[0]
        self.assertEqual(self.call_post(endpoint, retry_query, {**body, 'enc': stale})[0], 409)
        self.assertEqual(self.call_post(endpoint, {**relay, '_relay_key': ['sync-stale']},
                                       {**body, 'enc': stale})[0], 409)
        node = next(node for node in cms.fetch_module_tree('notes')['root'] if node['id'] == 'secret')
        self.assertEqual(private_session.document(self.root_path(node['content'])), edited['md'])
        self.assert_private_source('CLOUD_PRIVATE_BODY', 'CLOUD_PRIVATE_TITLE', 'STALE')

    def test_cloud_private_album_merges_kv_and_publishes_private_policy(self):
        from .helpers import make_test_png_bytes
        from services import media_groups, media_jobs, relay_media
        import routes
        payload = {'category': {'id': 'secret-album', 'title': 'Private'}, 'photos': [], 'tags_file': '[]'}
        original = private_session.crypt('encrypt', [payload])[0]
        storage.write_json(config.ALBUM_CONFIG_JSON, [{'_enc': original}])
        key = 'photos/images/_cloud_private/test.png'
        row = {'id': 'photo', 'path': key, 'thumb': key, 'preview': key, 'tags': ['PRIVATE_TAG']}
        new = private_session.crypt('encrypt', [{**payload, 'photos': [row]}])[0]
        body = {'source': 'album', 'group': 'default',
                'revision': hashlib.sha256(original.encode()).hexdigest(), 'enc': new}
        query = {'_relay_source': ['https://relay.invalid'], '_relay_key': ['sync-album']}
        endpoint = '/api/private/relay-edit'
        store = media_store.get_store()
        image = make_test_png_bytes('green')
        self.assertEqual(self.call_post(endpoint, query, body)[0], 400)
        self.assertEqual(self.load_json(config.ALBUM_CONFIG_JSON)[0]['_enc'], original)
        with mock.patch.object(relay_media, 'read', return_value=relay_media.DraftImage(image, 'default', None)) as read:
            self.assertEqual(routes.dispatch_post(endpoint, query, body, relay_secret='test-access')[0], 200)
            read.assert_called_once_with(key, 'default')
        self.assertEqual(private_photos.entry('secret-album')['payload']['photos'], [row])
        self.assertEqual(local_media.path(key).read_bytes(), image)
        self.assertEqual(self.gallery_json(), {})
        self.assert_private_source('PRIVATE_TAG')
        self.assertIsNone(store.read_policy(media_groups.policy_key(key)))
        self.assertFalse(store.exists('private', key))
        self.assertEqual(media_jobs.retry()['completed'], 0)
        self.assertEqual(media_jobs.draft_groups(media_jobs.drafts([key])[key]), {'default'})
        self.assertEqual(media_jobs.retry(for_publish=True)['completed'], 1)
        self.assertEqual(json.loads(store.read_policy(media_groups.policy_key(key))), {'key': key, 'groups': ['default']})
        self.assertEqual(store.read('private', key), image)
        self.assertFalse(store.exists('public', key))
        node = cms.load_json(config.ALBUM_CONFIG_JSON)[0]
        with mock.patch.object(photos, 'DISABLE_R2_SYNC', False):
            with mock.patch.object(photos, 'sync_gallery_js', side_effect=OSError('gallery publish failed')):
                code, result = private_session.unprotect({'reference': node['_private_id']})
                self.assertEqual(code, 200)
                self.assertEqual(self.wait_album_job(result['job'])['state'], 'error')
            self.assertFalse(self.mock_s3.buckets['pub-bucket'])
            code, result = private_session.unprotect({'reference': node['_private_id']})
            self.assertEqual(code, 200)
            self.assertEqual(self.wait_album_job(result['job'])['state'], 'success')
        published = self.gallery_json()['secret-album'][0]
        self.assertEqual(published['id'], row['id'])
        self.assertEqual(published['tags'], row['tags'])
        self.assertRegex(published['name'], r'^\d{8}_\d{6}_[0-9a-f]{32}\.png$')
        self.assertTrue(published['path'].startswith('photos/images/secret-album/'))
        for field in ('path', 'thumb', 'preview'):
            self.assertNotIn('_cloud_private', published[field])
            self.assertEqual(self.mock_s3.buckets['pub-bucket'][published[field]]['data'],
                             Path(self.root_path(published[field])).read_bytes())

    def test_cloud_private_space_snapshot_keeps_the_public_base_guard(self):
        original = {'root': [{'_enc': private_session.crypt('encrypt', [
            {'id': 'secret', 'name': 'PRIVATE_SITE', 'url': 'https://secret.invalid', 'tags': []}])[0]}]}
        path = self.data_path('space-tree.json')
        storage.write_json(path, original)
        changed = {'root': [{'_enc': private_session.crypt('encrypt', [
            {'id': 'secret', 'name': 'PRIVATE_SITE', 'url': 'https://secret.invalid', 'tags': ['PRIVATE_TAG']}])[0]}]}
        query = {'_relay_source': ['https://relay.invalid'], '_relay_key': ['sync-space']}
        self.assertEqual(self.call_post('/api/space/save_tree', query, {'_base': None, '_snapshot': changed})[0], 409)
        self.assertEqual(self.call_post('/api/space/save_tree', query, {'_base': original, '_snapshot': changed})[0], 200)
        self.assertEqual(self.load_json(path), changed)
        self.assertNotIn('PRIVATE_TAG', Path(path).read_text(encoding='utf-8'))

    def test_private_cms_edit_upload_and_public_view(self):
        """私密笔记只在内存编辑，保存失败恢复正文，匿名读取保持密文。"""
        from .helpers import make_test_png_bytes
        node = self.protected_note()
        virtual = self.root_path(node['content'])
        self.assertEqual(private_session.static(virtual)[1], b'PRIVATE_BODY')
        self.assertFalse(Path(virtual).exists())
        result = private_cms.upload({'module': ['notes'], 'node_id': ['secret'],
            'category': ['_notes'], 'name': ['new.png'], 'cover': ['1']}, make_test_png_bytes('red'))
        self.assertIn(result['path'], self.mock_s3.buckets['priv-bucket'])
        self.assertFalse(self.mock_s3.buckets['pub-bucket'])
        self.assertEqual(self.gallery_json(), {})
        self.assertEqual(len([p for p in Path(self.temp_photos).rglob('*') if p.is_file()]), 3)
        self.assertEqual(len(local_media.private_keys()), 3)
        content = f"PRIVATE_EDIT\n![]({result['path']})"
        cms_nodes.update_node('notes', 'secret', {'title': 'PRIVATE_RENAME', 'content': content,
            'expectedRevision': hashlib.sha256(b'PRIVATE_BODY').hexdigest()}, cms.get_context())
        node = cms.fetch_module_tree('notes')['root'][0]
        self.assertEqual(private_session.document(self.root_path(node['content'])), content)
        before = self.load_json(self.data_path('notes-tree.json'))
        with mock.patch.object(storage, '_replace', side_effect=OSError('disk full')), self.assertRaises(OSError):
            cms_nodes.update_node('notes', 'secret', {'content': 'FAILED_EDIT'}, cms.get_context())
        self.assertEqual(private_session.document(self.root_path(node['content'])), content)
        self.assertEqual(self.load_json(self.data_path('notes-tree.json')), before)
        self.assertTrue(private_session.view(node)['coverImage'].startswith('/api/private/media/'))
        self.assert_private_source('PRIVATE_TITLE', 'PRIVATE_BODY', 'PRIVATE_EDIT', 'PRIVATE_RENAME')
        cms.rebuild_cache()
        self.assertNotIn(b'PRIVATE_EDIT', Path(config.CMS_DB).read_bytes())
        with private_session.context(False):
            self.assertIn('_enc', cms.fetch_module_tree('notes')['root'][0])
            self.assertIsNone(private_session.static(virtual))
            self.assertIsNone(private_session.document(virtual))
        with self.assertRaisesRegex(ValueError, '正文已变化'):
            cms_nodes.update_node('notes', 'secret', {'content': 'OVERWRITE',
                'expectedRevision': 'outdated'}, cms.get_context())
        with self.assertRaisesRegex(ValueError, '上传按钮'):
            cms_nodes.update_node('notes', 'secret', {'content': '![](photos/images/public/leak.png)'}, cms.get_context())
        self.assertEqual(private_session.document(self.root_path(node['content'])), content)

    def test_private_upload_names_reuse_registered_paths_and_retract_partial_files(self):
        """私密上传沿用时间加 UUID，重复登记保留身份，部分上传失败撤销新对象。"""
        from .helpers import make_test_png_bytes
        self.protected_note()
        query = {'module': ['notes'], 'node_id': ['secret'], 'category': ['_notes'], 'name': ['new.png']}
        content = make_test_png_bytes('red')
        first = private_cms.upload(query, content)
        stems = {Path(first[field]).stem for field in ('path', 'thumb', 'preview')}
        self.assertEqual(len(stems), 1)
        self.assertRegex(stems.pop(), r'^\d{8}_\d{6}_[0-9a-f]{32}$')
        repeated = private_cms.upload({**query, 'name': ['renamed.png']}, content)
        for field in ('id', 'path', 'thumb', 'preview'):
            self.assertEqual(first[field], repeated[field])
        before_media = self.mock_s3.buckets['priv-bucket'].copy()
        before_tree = self.load_json(self.data_path('notes-tree.json'))
        write = media_store.MediaStore.write

        def fail_preview(store, scope, key, data):
            if scope == 'private' and key.startswith('photos/previews/'):
                raise OSError('simulated preview upload interruption')
            return write(store, scope, key, data)

        with mock.patch.object(media_store.MediaStore, 'write', autospec=True, side_effect=fail_preview):
            with self.assertRaises(OSError):
                private_cms.upload(query, make_test_png_bytes('blue'))
        self.assertEqual(self.mock_s3.buckets['priv-bucket'], before_media)
        self.assertEqual(self.load_json(self.data_path('notes-tree.json')), before_tree)
        self.assertFalse(self.mock_s3.buckets['pub-bucket'])

    def test_private_album_upload_tags_and_failure_keep_cipher(self):
        """私密相册上传与标签保持加密，失败保留原密文，取消加密后恢复公开副本。"""
        from .helpers import make_test_png_bytes
        payload = {'category': {'id': 'secret-album', 'title': 'PRIVATE_ALBUM'}, 'photos': [], 'tags_file': '[]'}
        storage.write_json(config.ALBUM_CONFIG_JSON, [{'_enc': private_session.crypt('encrypt', [payload])[0]}])
        result = private_photos.upload({'category': ['secret-album'], 'name': ['photo.png']}, make_test_png_bytes('blue'))
        self.assertTrue(private_photos.update_tags(result['id'], ['PRIVATE_TAG']))
        private_photos.tags('secret-album', [{'id': 'group', 'tags': ['PRIVATE_TAG']}])
        self.assertEqual(private_photos.tags('secret-album')[0]['tags'], ['PRIVATE_TAG'])
        private_photos.reorder('secret-album', [{'path': private_session.media_url(result['path'])}])
        gallery = json.loads(private_session.static(self.data_path('photos-data.json'))[1])
        self.assertEqual(gallery['secret-album'][0]['tags'], ['PRIVATE_TAG'])
        self.assertEqual(len(self.mock_s3.buckets['priv-bucket']), 3)
        self.assertFalse(self.mock_s3.buckets['pub-bucket'])
        store = media_store.get_store()
        with mock.patch.object(media_store, 'get_store', return_value=store), \
                mock.patch.object(store, '_object_request', side_effect=OSError('offline')):
            for field in ('path', 'thumb', 'preview'):
                key = result[field]
                self.assertEqual(private_session.media_bytes(key), self.mock_s3.buckets['priv-bucket'][key]['data'])
                with private_session.context(False), self.assertRaises(ValueError):
                    private_session.media_bytes(key)
        self.assertEqual(self.gallery_json(), {})
        self.assert_private_source('PRIVATE_ALBUM', 'PRIVATE_TAG')
        before = self.album_config()
        self.mock_s3.fail_on_upload = True
        with self.assertRaises(RuntimeError):
            private_photos.upload({'category': ['secret-album'], 'name': ['fail.png']}, make_test_png_bytes('green'))
        self.assertEqual(self.album_config(), before)
        self.mock_s3.fail_on_upload = False
        node = cms.load_json(config.ALBUM_CONFIG_JSON)[0]
        code, result = private_session.unprotect({'reference': node['_private_id']})
        self.assertEqual(code, 200)
        self.assertEqual(self.wait_album_job(result['job'])['state'], 'success')
        self.assertEqual(self.album_config()[0]['id'], 'secret-album')
        self.assertEqual(private_session.albums(), {})
        self.assertIn(gallery['secret-album'][0]['path'].split('/api/private/media/')[-1],
                      self.mock_s3.buckets['pub-bucket'])

    def test_protect_then_unprotect_folder_restores_media_and_whole_subtree(self):
        """加密文件夹迁走子文档图片并保存图库行；解密后整棵子树恢复公开，图片与图库行完整回归，正文始终在本地。"""
        from services import album_lock
        image = self.upload_png('_notes', 'cover.png', (30, 140, 90))
        keys = [image['path'], image['thumb'], image['preview']]
        context = cms.get_context()
        cms_nodes.add_node('notes', 'root', 'folder', 'FOLDER', context, node_id='folder')
        cms_nodes.add_node('notes', 'folder', 'note', 'INSIDE', context, node_id='inside')
        cms_nodes.update_node('notes', 'inside', {'content': f'![x]({image["path"]})'}, context)

        private_cms.protect('notes', 'folder')
        tree = cms.fetch_module_tree('notes')
        folder = cms_nodes._find(tree, 'folder')[2]
        self.assertTrue(folder['_private'])
        self.assertEqual([row['path'] for row in folder['_media']], [image['path']])
        for key in keys:
            self.assertIn(key, self.mock_s3.buckets['priv-bucket'])
        self.assertEqual(album_lock.rows_by_paths([image['path']]), [])

        private_cms.unprotect('notes', 'folder')
        tree = cms.fetch_module_tree('notes')
        for node in (cms_nodes._find(tree, 'folder')[2], cms_nodes._find(tree, 'inside')[2]):
            self.assertFalse({'_private', '_group', '_media'} & set(node), node)
        self.assertEqual(len(album_lock.rows_by_paths([image['path']])), 1)
        for key in keys:
            self.assertTrue(os.path.isfile(self.root_path(key)), key)
        inside = cms_nodes._find(tree, 'inside')[2]
        self.assertIn(image['path'], Path(self.root_path(inside['content'])).read_text(encoding='utf-8'))
        with self.assertRaisesRegex(ValueError, 'not locked'):
            private_cms.unprotect('notes', 'folder')

    def test_change_group_updates_subtree_flags_and_private_media_policy(self):
        """更换密码组：子树 _group 与私有图片授权一起改变，本地正文与 _media 不变。"""
        from services import media_groups
        group, _, _, _ = self.group_fixture()
        image = self.upload_png('_notes', 'regroup.png', (90, 30, 140))
        context = cms.get_context()
        cms_nodes.add_node('notes', 'root', 'folder', 'FOLDER', context, node_id='folder')
        cms_nodes.add_node('notes', 'folder', 'note', 'INSIDE', context, node_id='inside')
        cms_nodes.update_node('notes', 'inside', {'content': f'![x]({image["path"]})'}, context)
        private_cms.protect('notes', 'folder')
        private_cms.change_group('notes', 'folder', group)
        tree = cms.fetch_module_tree('notes')
        folder = cms_nodes._find(tree, 'folder')[2]
        self.assertEqual(folder['_group'], group)
        self.assertEqual([row['path'] for row in folder['_media']], [image['path']])
        store = media_store.get_store()
        policy = json.loads(store.read_policy(media_groups.policy_key(image['path'])))
        self.assertEqual(policy['groups'], [group])
        inside = cms_nodes._find(tree, 'inside')[2]
        self.assertTrue(Path(self.root_path(inside['content'])).is_file())

    def test_kv_cms_attachment_scope_changes_stay_local_until_publish(self):
        """同一篇正文混有待发布图和已发布图，加锁失败时恢复本机图片与发布目标。"""
        from services import media_groups, media_jobs
        group, _, _, _ = self.group_fixture()
        draft = self._merge_public_picture('_notes')
        with mock.patch.object(photos, 'DISABLE_R2_SYNC', False):
            published = self.upload_png('_notes', 'already-public.png', 'red')
        draft_keys = [draft[field] for field in ('path', 'thumb', 'preview')]
        self.add_node('draft-note', '图片草稿')
        content = f'![]({draft["path"]})\n![]({published["path"]})'
        self.assertEqual(self.cms('update', {'id': 'draft-note', 'data': {
            'content': content, 'coverImage': draft['path']}})[0], 200)
        before = media_jobs.pending()
        store = media_store.get_store()
        with mock.patch.object(cms, 'save_module_tree', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                private_cms.protect('notes', 'draft-note')
        self.assertEqual(media_jobs.pending(), before)
        for key in draft_keys:
            self.assertTrue(Path(self.root_path(key)).is_file())
            self.assertFalse(local_media.is_private(key))
        self.assertTrue(store.exists('public', published['path']))

        self.assertTrue(private_cms.protect('notes', 'draft-note'))
        self.assertTrue(private_cms.change_group('notes', 'draft-note', group))
        self.assertFalse(store.exists('public', published['path']))
        self.assertTrue(store.exists('private', published['path']))
        cms.fetch_module_tree('notes')
        self.assertEqual(private_session.media_bytes(draft['path']), local_media.path(draft['path']).read_bytes())
        self.assertTrue(private_cms.unprotect('notes', 'draft-note'))
        self.assertTrue(store.exists('public', published['path']))
        self.assertTrue(private_cms.protect('notes', 'draft-note', group))
        for key in draft_keys:
            self.assertTrue(local_media.path(key).is_file())
            self.assertTrue(local_media.is_private(key))
            self.assertFalse(store.exists('public', key))
            self.assertFalse(store.exists('private', key))
            self.assertEqual(media_jobs.draft_groups(media_jobs.drafts([key])[key]), {group})
        self.assertEqual(media_jobs.retry(for_publish=True)['completed'], 3)
        for key in draft_keys:
            self.assertFalse(store.exists('public', key))
            self.assertTrue(store.exists('private', key))
            self.assertEqual(json.loads(store.read_policy(media_groups.policy_key(key)))['groups'], [group])

    def test_rename_local_private_markdown_updates_paths_and_preserves_privacy(self):
        self.add_node('folder', '旧目录', 'folder')
        self.add_node('note', '旧标题', parent='folder')
        self.add_node('reference', '私密索引', parent='folder')
        self.add_node('public', '公开索引', module='record')
        link = '[正文](/markdown/notes/旧目录-旧标题.md#段落)'
        for node_id, content, module in [('note', '# 正文\r\n', 'notes'),
                                         ('reference', link, 'notes'), ('public', link, 'record')]:
            code, result = self.cms('update', {'id': node_id, 'data': {'content': content}}, module)
            self.assertEqual(code, 200, result)
        self.assertEqual(self.cms('protect', {'id': 'folder'})[0], 200)
        old = Path(self.root_path('markdown', 'notes', '旧目录-旧标题.md'))
        new = Path(self.root_path('markdown', 'notes', '新目录-新标题.md'))
        before = cms.fetch_module_tree('notes')
        with mock.patch.object(cms, 'save_module_tree', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                cms_nodes.update_node('notes', 'folder', {'title': '新目录'}, cms.get_context())
        self.assertEqual(cms.fetch_module_tree('notes'), before)
        self.assertEqual(old.read_bytes(), '# 正文\r\n'.encode())
        self.assertFalse(Path(self.root_path('markdown', 'notes', '新目录-旧标题.md')).exists())

        self.assertEqual(self.cms('update', {'id': 'folder', 'data': {'title': '新目录'}})[0], 200)
        self.assertEqual(self.cms('update', {'id': 'note', 'data': {'title': '新标题'}})[0], 200)
        folder = cms.fetch_module_tree('notes')['root'][0]
        self.assertTrue(folder['_private'])
        self.assertEqual(cms_nodes._find({'root': [folder]}, 'note')[2]['content'], 'markdown/notes/新目录-新标题.md')
        self.assertFalse(old.exists())
        self.assertEqual(new.read_bytes(), '# 正文\r\n'.encode())
        self.assertEqual(Path(self.root_path('markdown', 'notes', '新目录-私密索引.md')).read_text(encoding='utf-8'),
                         link.replace('旧目录-旧标题', '新目录-新标题'))
        self.assertEqual(Path(self.root_path('markdown', 'record', 'root-公开索引.md')).read_text(encoding='utf-8'), link)

    def test_folder_move_keeps_markdown_and_private_flag(self):
        """方案 3：私密目录内的新文档继承 _private，移动不丢标记；公开文档移入私密目录后同样转私密；正文始终是本地 .md。"""
        context = cms.get_context()
        cms_nodes.add_node('notes', 'root', 'folder', 'PRIVATE_FOLDER', context, node_id='folder')
        private_cms.protect('notes', 'folder')
        cms_nodes.add_node('notes', 'folder', 'folder', 'PRIVATE_CHILD', context, node_id='child')
        cms_nodes.add_node('notes', 'child', 'note', 'PRIVATE_NEW', context, node_id='inside')
        cms_nodes.update_node('notes', 'inside', {'content': 'PRIVATE_CREATED'}, context)
        cms_nodes.move_node('notes', 'inside', 'root', context)
        tree = cms.fetch_module_tree('notes')
        inside = cms_nodes._find(tree, 'inside')[2]
        self.assertTrue(inside['_private'], '移出目录后仍保持私密，需显式解除')
        self.assertEqual(Path(self.root_path(inside['content'])).read_text(encoding='utf-8'), 'PRIVATE_CREATED')

        cms_nodes.add_node('notes', 'root', 'note', 'PUBLIC_MOVED', context, node_id='public')
        cms_nodes.update_node('notes', 'public', {'content': 'PRIVATE_MOVED'}, context)
        cms_nodes.move_node('notes', 'public', 'folder', context)
        moved = cms_nodes._find(cms.fetch_module_tree('notes'), 'public')[2]
        self.assertTrue(moved['_private'])
        self.assertEqual(Path(self.root_path(moved['content'])).read_text(encoding='utf-8'), 'PRIVATE_MOVED')
        self.assertTrue(all('_enc' not in node for node in cms_store.walk(cms.fetch_module_tree('notes')['root'])))

        cms_nodes.unlock_node('notes', 'inside', {}, context)
        public = cms_nodes._find(cms.fetch_module_tree('notes'), 'inside')[2]
        self.assertNotIn('_private', public)
        self.assertEqual(Path(self.root_path(public['content'])).read_text(encoding='utf-8'), 'PRIVATE_CREATED')

    def test_nested_records_and_closed_backend_cannot_publish_plaintext(self):
        """脱离私密父项的子记录仍需加密，过期会话不能继续上传或读取。"""
        payload = {'title': 'PRIVATE_CATEGORY', 'collections': [{'title': 'PRIVATE_COLLECTION', 'albums': []}]}
        storage.write_json(config.MUSIC_DATA, [{'_enc': private_session.crypt('encrypt', [payload])[0]}])
        data = cms.load_json(config.MUSIC_DATA)
        child = data[0]['collections'].pop()
        data.append(child)
        storage.write_json(config.MUSIC_DATA, data)
        self.assertTrue(all('_enc' in row for row in self.load_json(config.MUSIC_DATA)))
        self.protected_note()
        lease = private_session.session_lease()
        self.assertEqual(private_session.close({'lease': 'previous-page'})['status'], 'ignored')
        self.assertTrue(private_session.active())
        private_session.close({'lease': lease})
        code, result = self.call_post('/upload', {'category': ['secret'], 'name': ['leak.png']}, file_data=b'not an image')
        self.assertEqual((code, result['code']), (403, 'private_admin_required'))
        self.assertFalse(private_session.media_authorized('maers_private=old'))
        self.assertFalse(self.mock_s3.buckets['pub-bucket'])

    def test_private_space_tags_remain_encrypted_and_out_of_logs(self):
        """私密网站标签增删后继续存为密文，业务日志不出现标签明文。"""
        import io
        path = self.data_path('space-tree.json')
        payload = {'id': 'secret-space', 'title': 'PRIVATE_SPACE', 'tags': ['PRIVATE_TAG']}
        storage.write_json(path, {'root': [{'_enc': private_session.crypt('encrypt', [payload])[0]}]})
        log = io.StringIO()
        with mock.patch('sys.stdout', log):
            self.assertEqual(cms.rename_tag('space', 'PRIVATE_TAG', 'PRIVATE_RENAMED')['updated_count'], 1)
            strategy = cms.get_strategy('space', cms.get_context())
            self.assertEqual(strategy.cleanup_tags('space'), {'PRIVATE_RENAMED'})
            self.assertNotIn('PRIVATE_RENAMED', Path(path).read_text(encoding='utf-8'))
            self.assertEqual(cms.delete_tag('space', 'PRIVATE_RENAMED')['updated_count'], 1)
            self.assertEqual(strategy.cleanup_tags('space'), set())
        self.assertNotIn('PRIVATE_', log.getvalue())
        self.assertIn('_enc', self.load_json(path)['root'][0])

    def test_private_http_view_requires_token_and_media_cookie(self):
        """后台正文需要本机会话，私密图片需要专用 Cookie，关闭会话后全部失效。"""
        from .helpers import make_test_png_bytes
        node = self.protected_note()
        image = make_test_png_bytes('red')
        photo = private_cms.upload({'module': ['notes'], 'node_id': ['secret'],
            'category': ['_notes'], 'name': ['image.png']}, image)
        cookie = private_session.cookie_header().split(';')[0]
        with _private_http_server() as httpd:
            request = partial(_http_request, httpd.server_address)
            auth = {'X-MAERS-Token': httpd.session_token}
            self.assertNotIn(b'PRIVATE_TITLE', request('/api/cms/fetch?module=notes')[2])
            code, headers, body = request('/api/cms/fetch?module=notes', auth)
            self.assertEqual(code, 200)
            self.assertIn(b'PRIVATE_TITLE', body)
            self.assertIn('no-store', headers['Cache-Control'])
            path = '/' + node['content']
            self.assertEqual(request(path)[0], 404)
            self.assertEqual(request(path, auth)[2], b'PRIVATE_BODY')
            media = private_session.media_url(photo['path'])
            self.assertEqual(request(media)[0], 403)
            self.assertEqual(request(media, {'Cookie': cookie})[2], image)
            self.assertNotIn(b'PRIVATE_TITLE', request('/data/notes-tree.json', {'Cookie': cookie})[2])
            origin = f'http://127.0.0.1:{httpd.server_address[1]}'
            code, _, _ = request('/api/crypto/admin-session/close',
                {**auth, 'Origin': origin, 'Content-Type': 'application/json'}, method='POST', body='{}')
            self.assertEqual(code, 200)
            self.assertEqual(request(media, {'Cookie': cookie})[0], 403)
            self.assertEqual(request('/api/cms/fetch?module=notes', auth)[0], 403)
