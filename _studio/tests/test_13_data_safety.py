"""数据保障回归：缺失真源、回收恢复、进程中断、媒体替换与完整密钥轮换。"""

import hashlib
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from unittest import mock
from .sandbox import SandboxTestCase, cms, photos, config
from .helpers import STUDIO_DIR
from services import storage, storage_journal, media_store, media_jobs, data_safety, crypto_keyring, crypto_rotation
from services import private_session, private_photos, private_cms, cms_nodes


class Test13_DataSafety(SandboxTestCase):
    def test_24_keyring_projection_migration_backup_and_rollback(self):
        """恢复材料不进入公开文件，迁移故障可回滚，完整备份可恢复本机密钥环。"""
        ring = {'v': 1, 'dek_id': '0123456789abcdef',
                'pw': {'salt': 'YQ==', 'iter': 600000, 'wrap': 'enc:password'},
                'rc': {'salt': 'Yg==', 'iter': 100000, 'wrap': 'enc:recovery'},
                'media_base': '', 'updated': 'private-timestamp'}
        storage.write_json(crypto_keyring.KEYRING_FILE, ring)
        original = storage.write_json
        def fail_public(path, value):
            if path == crypto_keyring.KEYRING_FILE:
                raise OSError('simulated public write failure')
            return original(path, value)
        with mock.patch.object(storage, 'write_json', side_effect=fail_public):
            with self.assertRaises(OSError):
                crypto_keyring.migrate()
        self.assertEqual(crypto_keyring._load(), ring)
        self.assertFalse(os.path.exists(crypto_keyring.local_keyring_file()))
        crypto_keyring.migrate()
        self.assertEqual(set(self.load_json(crypto_keyring.KEYRING_FILE)), {'v', 'dek_id', 'pw', 'media_base'})
        self.assertEqual(crypto_keyring._load(), ring)
        backup = data_safety.create_backup(include_remote=False)
        storage.remove(crypto_keyring.local_keyring_file())
        with self.assertRaises(ValueError):
            crypto_keyring._load()
        data_safety.restore_backup(backup['id'])
        self.assertEqual(crypto_keyring._load(), ring)
        # 旧格式备份恢复后也应再次分离，不能把恢复材料重新公开。
        storage.write_json(crypto_keyring.KEYRING_FILE, ring)
        legacy = data_safety.create_backup(include_remote=False)
        crypto_keyring.migrate()
        data_safety.restore_backup(legacy['id'])
        self.assertNotIn('rc', self.load_json(crypto_keyring.KEYRING_FILE))
        self.assertEqual(crypto_keyring._load(), ring)


    def test_18_denied_private_access_preserves_album_sources(self):
        """私有桶读取或上传被拒绝时保留本地、公开副本和索引，并返回明确提示。"""
        from botocore.exceptions import ClientError
        storage.write_json(config.ALBUM_CONFIG_JSON, [{'id': 'travel', 'title': 'test'}])
        image = self.upload_png('travel', 'private-denied.png', 'red')
        originals = {image[field]: Path(self.root_path(image[field])).read_bytes()
                     for field in ('path', 'thumb', 'preview')}
        for key, data in originals.items():
            self.mock_s3.put_object(Bucket='pub-bucket', Key=key, Body=data)
        album, gallery = self.album_config(), self.gallery_json()
        for operation in ('head_object', 'put_object'):
            original = getattr(self.mock_s3, operation)
            def denied(*args, **kwargs):
                if kwargs['Bucket'] == 'priv-bucket':
                    raise ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'internal-secret-marker'},
                                       'ResponseMetadata': {'HTTPStatusCode': 403}}, operation)
                return original(*args, **kwargs)
            with self.subTest(operation=operation), mock.patch.object(self.mock_s3, operation, side_effect=denied):
                code, result = self.call_post('/api/album/lock_category', body={'id': 'travel', 'enc': 'enc:test'})
                if operation == 'head_object':
                    self.assertEqual(code, 403)
                    self.assertNotIn('job', result)
                else:
                    self.assertEqual(code, 200)
                    job = self.wait_album_job(result['job'])
                    self.assertEqual(job['state'], 'error')
                    result = job['result']
                self.assertIn('私有存储访问被拒绝', result['error'])
                self.assertNotIn('internal-secret-marker', result['error'])
            self.assertEqual(self.album_config(), album)
            self.assertEqual(self.gallery_json(), gallery)
            self.assertEqual(self.mock_s3.buckets['priv-bucket'], {})
            for key, data in originals.items():
                self.assertEqual(Path(self.root_path(key)).read_bytes(), data)
                self.assertEqual(self.mock_s3.buckets['pub-bucket'][key]['data'], data)

    def local_store(self):
        return media_store.MediaStore(settings={'provider': 'local', 'root': self.root_path('_studio/.local/media')})

    def child(self, body):
        setup = '''
import os, sys
sys.path.insert(0, sys.argv[1])
import config
root = sys.argv[2]
config.PROJECT_ROOT = root
config.DATA_DIR = os.path.join(root, 'data')
config.PHOTOS_ROOT = os.path.join(root, 'photos')
config.CMS_DB = os.path.join(root, 'data', 'cms.db')
config.GALLERY_DB = os.path.join(root, 'data', 'gallery.db')
config.ALBUM_CONFIG_JSON = os.path.join(root, 'data', 'album-config.json')
from services import cms, photos, cms_nodes, album_lock, storage
cms.PROJECT_ROOT = photos.PROJECT_ROOT = root
cms.DATA_DIR = photos.DATA_DIR = config.DATA_DIR
cms.DB_PATH = config.CMS_DB
photos.DB_PATH = config.GALLERY_DB
photos.GALLERY_JSON_FILE = os.path.join(root, 'data', 'photos-data.json')
'''
        return subprocess.run([sys.executable, '-B', '-c', setup + body, STUDIO_DIR, self.temp_root],
                              capture_output=True, timeout=20)

    def test_01_missing_sources_stop_cleanup_without_removing_content(self):
        self.add_node('safe', 'important')
        self.cms('update', {'id': 'safe', 'data': {'content': 'IMPORTANT'}})
        md = self.data_path('notes', 'important.md')
        for filename in ('notes-tree.json', 'photos-data.json', 'album-config.json', 'music-data.json', 'space-tree.json'):
            path = self.data_path(filename)
            original = Path(path).read_bytes()
            os.remove(path)
            self.assertEqual(self.call_post('/api/admin/clean_data')[0], 500)
            self.assertEqual(Path(md).read_text(encoding='utf-8'), 'IMPORTANT')
            storage.write_bytes(path, original)

    def test_02_cleanup_quarantines_and_restores_without_overwriting_new_files(self):
        orphan = self.data_path('notes', 'orphan.md')
        storage.write_text(orphan, 'RECOVER ME')
        code, result = self.call_post('/api/admin/clean_data')
        self.assertEqual(code, 200, result)
        self.assertFalse(os.path.exists(orphan))
        storage.write_text(orphan, 'NEW FILE')
        with self.assertRaises(ValueError):
            data_safety.restore_trash(result['quarantine_batch'])
        self.assertEqual(Path(orphan).read_text(encoding='utf-8'), 'NEW FILE')
        os.remove(orphan)
        data_safety.restore_trash(result['quarantine_batch'])
        self.assertEqual(Path(orphan).read_text(encoding='utf-8'), 'RECOVER ME')

    def test_03_process_exit_during_lock_restores_index_and_markdown_before_read(self):
        self.add_node('n', 'private')
        self.cms('update', {'id': 'n', 'data': {'content': 'PRIVATE TEXT'}})
        process = self.child("\ncms_nodes._remove_markdown = lambda *args: os._exit(73)\ncms_nodes.lock_node('notes', 'n', 'enc:test', cms.get_context())\n")
        self.assertEqual(process.returncode, 73, process.stderr)
        self.assertTrue(storage_journal.pending())
        # 普通读接口首先恢复，不会让锁定索引与残留明文同时对外可见。
        tree = self.fetch_tree()
        self.assertNotIn('_enc', tree['root'][0])
        self.assertEqual(Path(self.data_path(tree['root'][0]['content'])).read_text(encoding='utf-8'), 'PRIVATE TEXT')
        self.assertFalse(storage_journal.pending())

    def test_04_replacement_filesystem_store_supports_private_migration(self):
        store = self.local_store()
        with mock.patch.object(media_store, 'get_store', return_value=store):
            image = self.upload_png('_notes', 'a.png', 'red')
            self.add_node('n', 'private')
            self.cms('update', {'id': 'n', 'data': {'content': 'BODY', 'coverImage': image['path']}})
            from services import album_lock
            row = album_lock.rows_by_paths([image['path']])[0]
            self.assertEqual(self.cms('lock', {'id': 'n', 'enc': 'enc:test', 'covers': [image['path']]})[0], 200)
            for field in ('path', 'thumb', 'preview'):
                self.assertTrue(store.exists('private', image[field]))
            self.assertFalse(store.exists('public', image['path']))
            self.assertEqual(self.cms('unlock', {'id': 'n', 'tree': {'id': 'n', 'title': 'private',
                'type': 'note', 'md': 'BODY', 'coverImage': image['path'], 'coverRow': row}})[0], 200)
            self.assertTrue(store.exists('public', image['path']))

    def test_05_upload_failure_is_persisted_and_retry_is_verified(self):
        store = self.local_store()
        with mock.patch.object(media_store, 'get_store', return_value=store), mock.patch.object(photos, 'DISABLE_R2_SYNC', False):
            with mock.patch.object(store, 'write', side_effect=OSError('offline')):
                image = self.upload_png('travel', 'a.png', 'red')
            self.assertEqual(image['sync']['state'], 'pending')
            self.assertEqual(len(media_jobs.pending()), 1)
            self.assertEqual(media_jobs.retry()['state'], 'complete')
            self.assertFalse(media_jobs.pending())
            self.assertEqual(store.read('public', image['path']), Path(self.root_path(image['path'])).read_bytes())

    def test_06_inflight_upload_and_lock_are_serialized(self):
        store = self.local_store()
        original_write = store.write
        started, release, attempted = threading.Event(), threading.Event(), threading.Event()
        shared, errors = {}, []
        self.add_node('n', 'private')
        def delayed(scope, key, data):
            if scope == 'public' and not started.is_set():
                shared['key'] = key
                started.set()
                if not release.wait(5):
                    raise RuntimeError('test timeout')
            return original_write(scope, key, data)
        def upload():
            try:
                shared['image'] = self.upload_png('_notes', 'a.png', 'red')
            except Exception as error:
                errors.append(error)
        def lock():
            try:
                attempted.set()
                self.cms('update', {'id': 'n', 'data': {'coverImage': shared['key']}})
                shared['lock'] = self.cms('lock', {'id': 'n', 'enc': 'enc:test', 'covers': [shared['key']]})
            except Exception as error:
                errors.append(error)
        with mock.patch.object(media_store, 'get_store', return_value=store), \
                mock.patch.object(photos, 'DISABLE_R2_SYNC', False), mock.patch.object(store, 'write', side_effect=delayed):
            first = threading.Thread(target=upload)
            second = threading.Thread(target=lock)
            first.start()
            self.assertTrue(started.wait(5))
            second.start()
            self.assertTrue(attempted.wait(5))
            release.set()
            first.join(10)
            second.join(10)
            self.assertFalse(first.is_alive() or second.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(shared['lock'][0], 200, shared['lock'])
            self.assertFalse(store.exists('public', shared['key']))
            self.assertTrue(store.exists('private', shared['key']))
            self.assertFalse(media_jobs.pending())

    def test_07_stale_body_and_lock_snapshot_cannot_overwrite_new_data(self):
        self.add_node('n', 'important')
        self.cms('update', {'id': 'n', 'data': {'content': 'OLD'}})
        tree = self.fetch_tree()
        sources = cms.cms_nodes.lock_sources(tree['root'][0], cms.get_context())
        path = self.data_path(tree['root'][0]['content'])
        storage.write_text(path, 'NEW EXTERNAL EDIT')
        revision = hashlib.sha256(b'OLD').hexdigest()
        self.assertEqual(self.cms('update', {'id': 'n', 'data': {'content': 'OLD', 'expectedRevision': revision}})[0], 400)
        self.assertEqual(self.cms('lock', {'id': 'n', 'enc': 'enc:stale', 'sources': sources})[0], 400)
        self.assertEqual(Path(path).read_text(encoding='utf-8'), 'NEW EXTERNAL EDIT')
        self.assertEqual(self.cms('update', {'id': 'n', 'data': {'title': 'renamed'}})[0], 200)
        self.assertEqual(Path(self.data_path('notes', 'renamed.md')).read_text(encoding='utf-8'), 'NEW EXTERNAL EDIT')

    def test_08_full_backup_verify_and_restore_local_and_both_media_scopes(self):
        store = self.local_store()
        self.add_node('n', 'important')
        self.cms('update', {'id': 'n', 'data': {'content': 'ORIGINAL'}})
        public, private = 'photos/images/travel/a.png', 'photos/images/secret/b.png'
        with mock.patch.object(media_store, 'get_store', return_value=store):
            store.write('public', public, b'PUBLIC')
            store.write('private', private, b'PRIVATE')
            backup = data_safety.create_backup()
            self.assertTrue(data_safety.verify_backup(backup['id'])['includes_remote'])
            storage.write_text(self.data_path('notes', 'important.md'), 'CORRUPTED')
            store.write('public', public, b'CHANGED')
            store.delete('private', private)
            extra = self.data_path('notes', 'later.md')
            storage.write_text(extra, 'NEWER CONTENT')
            result = data_safety.restore_backup(backup['id'])
            self.assertTrue(result['safety_backup'])
            self.assertEqual(Path(self.data_path('notes', 'important.md')).read_text(encoding='utf-8'), 'ORIGINAL')
            self.assertEqual(store.read('public', public), b'PUBLIC')
            self.assertEqual(store.read('private', private), b'PRIVATE')
            self.assertFalse(os.path.exists(extra))
            self.assertTrue(data_safety.list_recovery()['trash'])

    def test_09_corrupt_backup_is_rejected_before_any_restore(self):
        self.add_node('n', 'important')
        backup = data_safety.create_backup(include_remote=False)
        directory = Path(storage_journal.local_root()) / 'backups' / backup['id']
        manifest = json.loads((directory / 'manifest.json').read_text())
        (directory / manifest['files'][0]['blob']).write_bytes(b'BROKEN')
        before = Path(self.data_path('notes-tree.json')).read_bytes()
        with self.assertRaises(ValueError):
            data_safety.restore_backup(backup['id'])
        self.assertEqual(Path(self.data_path('notes-tree.json')).read_bytes(), before)

    def test_10_rotation_is_complete_version_checked_and_failure_atomic(self):
        slot = {'salt': 'AAAAAAAAAAAAAAAAAAAAAA==', 'iter': 10000, 'wrap': 'enc:wrapped'}
        old = {'v': 1, 'dek_id': '0123456789abcdef', 'pw': slot, 'rc': slot, 'media_base': 'https://private.example'}
        self.assertEqual(crypto_keyring.save(dict(old))[0], 200)
        self.add_node('n', 'private')
        self.cms('lock', {'id': 'n', 'enc': 'enc:old'})
        source = crypto_rotation.export_snapshots()
        files = json.loads(json.dumps(source['files']))
        for item in files:
            if item['path'] == 'notes-tree.json':
                item['data']['root'][0]['_enc'] = 'enc:new'
        new = {**old, 'dek_id': 'fedcba9876543210'}
        body = {'expected_dek_id': old['dek_id'], 'keyring': new, 'files': files, 'token_hash': 'a' * 64}
        original = storage.write_json
        def fail_keyring(path, value):
            if path == crypto_keyring.KEYRING_FILE:
                raise OSError('disk failure')
            return original(path, value)
        with mock.patch.object(storage, 'write_json', side_effect=fail_keyring):
            with self.assertRaises(OSError):
                crypto_rotation.rotate(body)
        self.assertEqual(self.fetch_tree()['root'][0]['_enc'], 'enc:old')
        self.assertEqual(crypto_keyring._load()['dek_id'], old['dek_id'])
        result = crypto_rotation.rotate(body)
        self.assertTrue(result['token_pending'])
        self.assertTrue(crypto_rotation.pending()['pending'])
        self.assertEqual(self.fetch_tree()['root'][0]['_enc'], 'enc:new')
        self.assertEqual(crypto_keyring.save({**old, 'force': True})[0], 409)
        with self.assertRaises(ValueError):
            crypto_rotation.finalize({'dek_id': new['dek_id'], 'token_hash': 'b' * 64})
        crypto_rotation.finalize({'dek_id': new['dek_id'], 'token_hash': 'a' * 64})
        self.assertFalse(crypto_rotation.pending()['pending'])

    def test_11_interrupted_media_purge_restores_disk_backend_before_serving(self):
        store = self.local_store()
        from services import album_lock
        with mock.patch.object(media_store, 'get_store', return_value=store):
            image = self.upload_png('_notes', 'a.png', 'blue')
            store.write('public', image['path'], Path(self.root_path(image['path'])).read_bytes())
            self.add_node('n', 'private')
            self.cms('update', {'id': 'n', 'data': {'coverImage': image['path'], 'content': 'BODY'}})
            cfg = self.root_path('_studio/tools/media_config.json')
            storage.write_json(cfg, store.settings)
            sources = cms.cms_nodes.lock_sources(self.fetch_tree()['root'][0], cms.get_context())
            body = {'id': 'n', 'enc': 'enc:test', 'covers': [image['path']], 'sources': sources}
            script = '''
original_remove = storage.remove
def interrupted(path):
    original_remove(path)
    if str(path).replace('\\\\', '/').find('/photos/images/') >= 0:
        os._exit(74)
storage.remove = interrupted
'''
            script += "\ncms.handle_request('/api/cms/node', 'POST', {'module':['notes'],'action':['lock']}, " + repr(body) + ')\n'
            process = self.child(script)
            self.assertEqual(process.returncode, 74, process.stderr)
            self.assertTrue(storage_journal.pending())
            self.assertFalse(store.exists('public', image['path']))
            self.assertNotIn('_enc', self.fetch_tree()['root'][0])
            self.assertTrue(store.exists('public', image['path']))
            for field in ('path', 'thumb', 'preview'):
                self.assertTrue(os.path.isfile(self.root_path(image[field])))
            self.assertFalse(storage_journal.pending())

    def test_12_stale_album_export_cannot_discard_later_photos(self):
        from services import album_lock
        self.call_post('/api/add_category', body={'id': 'travel', 'title': '相册'})
        first = self.upload_png('travel', 'a.png', 'red')
        _, exported = album_lock.export_category('travel')
        second = self.upload_png('travel', 'b.png', 'blue')
        code, start = self.call_post('/api/album/lock_category', body={
            'id': 'travel', 'enc': 'enc:old-snapshot', 'expected_revision': exported['revision']})
        self.assertEqual(code, 200, start)
        self.assertEqual(self.wait_album_job(start['job'])['state'], 'error')
        self.assertEqual(len(self.gallery_json()['travel']), 2)
        self.assertTrue(os.path.isfile(self.root_path(first['path'])))
        self.assertTrue(os.path.isfile(self.root_path(second['path'])))

    def test_13_pending_sync_recovery_and_rotation_block_publication(self):
        from .test_03_data_integrity import publication_issues
        outbox = self.root_path('_studio/.local/media-outbox.json')
        storage.write_json(outbox, [{'key': 'photos/images/travel/a.png', 'action': 'upload'}])
        self.assertTrue(publication_issues(self.temp_root))
        storage.write_json(outbox, [])
        self.assertFalse(publication_issues(self.temp_root))
        marker = self.root_path('_studio/.local/rotation-pending.json')
        storage.write_json(marker, {'dek_id': 'test'})
        self.assertTrue(publication_issues(self.temp_root))
        os.remove(marker)
        journal = storage_journal.Journal()
        journal.remember(self.data_path('notes-tree.json'))
        self.assertTrue(publication_issues(self.temp_root))
        storage.recover()
        self.assertFalse(publication_issues(self.temp_root))

    def test_14_independent_tools_cannot_write_while_studio_owns_project(self):
        script = '\nfrom services import storage_journal\nwith storage_journal.process_lock():\n    print("acquired")\n'
        with storage_journal.process_lock():
            blocked = self.child(script)
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn(b'already using', blocked.stderr)
        self.assertEqual(self.child(script).returncode, 0)

    def test_15_failed_local_derivative_does_not_publish_partial_files(self):
        original = photos._write_generated
        def fail_preview(image, path, image_format=None, **options):
            if '/previews/' in path.replace('\\', '/'):
                raise OSError('disk full')
            return original(image, path, image_format, **options)
        from .helpers import make_test_png_bytes
        with mock.patch.object(photos, '_write_generated', side_effect=fail_preview):
            code, result = self.call_post('/upload', {'category': ['travel'], 'name': ['a.png']},
                                          file_data=make_test_png_bytes('red'))
        self.assertEqual(code, 400, result)
        self.assertEqual(self.gallery_json(), {})
        self.assertEqual([p for p in Path(self.temp_photos).rglob('*') if p.is_file()], [])

    def test_16_invalid_storage_config_preserves_local_upload_and_pending_task(self):
        with mock.patch.object(photos, 'DISABLE_R2_SYNC', False):
            with mock.patch.object(media_store, 'get_store', side_effect=ValueError('missing credentials')):
                image = self.upload_png('travel', 'a.png', 'red')
            self.assertEqual(image['sync']['state'], 'pending')
            self.assertIsNone(media_jobs.pending()[0]['backend'])
            self.assertEqual(media_jobs.retry()['state'], 'complete')
            self.assertFalse(media_jobs.pending())
            self.assertIn(image['path'], self.mock_s3.buckets['pub-bucket'])

    def test_17_migrated_cdn_prefix_and_literal_cover_key_are_private(self):
        from urllib.parse import quote
        from .helpers import make_test_png_bytes
        key = 'photos/images/_notes/literal#1.png'
        storage.write_bytes(self.root_path(key), make_test_png_bytes('red'))
        self.insert_gallery_row(id='image', category='_notes', name='literal#1.png', path=key,
                                thumb=key, preview=key, hash='h', sort_order=0, created_at=0)
        photos.sync_gallery_js()
        self.add_node('n', 'private')
        for cover in (key, 'https://cdn.example/assets/' + quote(key)):
            self.cms('update', {'id': 'n', 'data': {'coverImage': cover}})
            self.assertEqual(self.cms('lock', {'id': 'n', 'enc': 'enc:test', 'covers': []})[0], 400)
        self.assertEqual(self.cms('lock', {'id': 'n', 'enc': 'enc:test', 'covers': [key]})[0], 200)
        self.assertNotIn(key, self.mock_s3.buckets['pub-bucket'])
        self.assertIn(key, self.mock_s3.buckets['priv-bucket'])


class Test13_PrivateAdmin(SandboxTestCase):
    """真实 AES-GCM 的后台内存编辑回归，所有文件和图片仅使用独立沙盒。"""

    def setUp(self):
        import base64
        private_session.close({})
        super().setUp()
        self.addCleanup(private_session.close, {})
        raw = base64.b64encode(os.urandom(32)).decode()
        storage.write_json(crypto_keyring.KEYRING_FILE, {
            'dek_id': hashlib.sha256(('maers-dek-id|' + raw).encode()).hexdigest()[:16]})
        private_session.start({'key': raw})
        self.private_context = private_session.context()
        self.private_context.__enter__()
        self.addCleanup(self.private_context.__exit__, None, None, None)

    def protected_note(self, identity='secret'):
        payload = {'id': identity, 'type': 'note', 'title': 'PRIVATE_TITLE', 'md': 'PRIVATE_BODY',
                   'tags': [], 'coverImage': None, 'children': None}
        cipher = private_session.crypt('encrypt', [payload])[0]
        storage.write_json(self.data_path('notes-tree.json'), {'root': [
            {'id': identity, 'type': 'locked', 'children': None, 'mediaVersion': 1, '_enc': cipher}]})
        return cms.fetch_module_tree('notes')['root'][0]

    def assert_private_source(self, *markers):
        for name in ('notes-tree.json', 'album-config.json', 'photos-data.json'):
            text = Path(self.data_path(name)).read_text(encoding='utf-8')
            for marker in markers:
                self.assertNotIn(marker, text)
        self.assertFalse(list(Path(self.temp_data).rglob('*.md')))

    def test_private_cms_edit_upload_and_public_view(self):
        from .helpers import make_test_png_bytes
        node = self.protected_note()
        virtual = self.data_path(node['content'])
        self.assertEqual(private_session.static(virtual)[1], b'PRIVATE_BODY')
        self.assertFalse(Path(virtual).exists())
        result = private_cms.upload({'module': ['notes'], 'node_id': ['secret'],
            'category': ['_notes'], 'name': ['new.png'], 'cover': ['1']}, make_test_png_bytes('red'))
        self.assertIn(result['path'], self.mock_s3.buckets['priv-bucket'])
        self.assertFalse(self.mock_s3.buckets['pub-bucket'])
        self.assertEqual(self.gallery_json(), {})
        self.assertFalse([p for p in Path(self.temp_photos).rglob('*') if p.is_file()])
        content = f"PRIVATE_EDIT\n![]({result['path']})"
        cms_nodes.update_node('notes', 'secret', {'title': 'PRIVATE_RENAME', 'content': content,
            'expectedRevision': hashlib.sha256(b'PRIVATE_BODY').hexdigest()}, cms.get_context())
        node = cms.fetch_module_tree('notes')['root'][0]
        self.assertEqual(private_session.document(self.data_path(node['content'])), content)
        before = self.load_json(self.data_path('notes-tree.json'))
        with mock.patch.object(storage, '_replace', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                cms_nodes.update_node('notes', 'secret', {'content': 'FAILED_EDIT'}, cms.get_context())
        self.assertEqual(private_session.document(self.data_path(node['content'])), content)
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
        self.assertEqual(private_session.document(self.data_path(node['content'])), content)

    def test_private_album_upload_tags_and_failure_keep_cipher(self):
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

    def test_folder_move_and_unprotect_preserve_private_content(self):
        cms_nodes.add_node('notes', 'root', 'folder', 'PRIVATE_FOLDER', cms.get_context(), node_id='folder')
        private_cms.protect('notes', 'folder')
        cms_nodes.add_node('notes', 'folder', 'folder', 'PRIVATE_CHILD', cms.get_context(), node_id='child')
        cms_nodes.add_node('notes', 'child', 'note', 'PRIVATE_NEW', cms.get_context(), node_id='inside')
        cms_nodes.update_node('notes', 'inside', {'content': 'PRIVATE_CREATED'}, cms.get_context())
        cms_nodes.move_node('notes', 'inside', 'root', cms.get_context())
        self.assertTrue(cms_nodes._find(cms.fetch_module_tree('notes'), 'inside')[2]['_private_id'])
        cms_nodes.add_node('notes', 'root', 'note', 'PUBLIC_MOVED', cms.get_context(), node_id='public')
        cms_nodes.update_node('notes', 'public', {'content': 'PRIVATE_MOVED'}, cms.get_context())
        cms_nodes.move_node('notes', 'public', 'folder', cms.get_context())
        self.assert_private_source('PRIVATE_FOLDER', 'PRIVATE_CHILD', 'PRIVATE_NEW', 'PRIVATE_CREATED', 'PRIVATE_MOVED')
        node = cms_nodes._find(cms.fetch_module_tree('notes'), 'inside')[2]
        self.assertEqual(private_session.unprotect({'reference': node['_private_id']})[0], 200)
        public = cms_nodes._find(cms.fetch_module_tree('notes'), 'inside')[2]
        self.assertNotIn('_private', public)
        self.assertEqual(Path(self.data_path(public['content'])).read_text(encoding='utf-8'), 'PRIVATE_CREATED')

    def test_nested_records_and_closed_backend_cannot_publish_plaintext(self):
        payload = {'title': 'PRIVATE_CATEGORY', 'collections': [{'title': 'PRIVATE_COLLECTION', 'albums': []}]}
        storage.write_json(config.MUSIC_DATA, [{'_enc': private_session.crypt('encrypt', [payload])[0]}])
        data = cms.load_json(config.MUSIC_DATA)
        child = data[0]['collections'].pop()
        data.append(child)
        storage.write_json(config.MUSIC_DATA, data)
        self.assertTrue(all('_enc' in row for row in self.load_json(config.MUSIC_DATA)))
        self.protected_note()
        lease = private_session._lease
        self.assertEqual(private_session.close({'lease': 'previous-page'})['status'], 'ignored')
        self.assertTrue(private_session.active())
        private_session.close({'lease': lease})
        code, result = self.call_post('/upload', {'category': ['secret'], 'name': ['leak.png']}, file_data=b'not an image')
        self.assertEqual((code, result['code']), (403, 'private_admin_required'))
        self.assertFalse(private_session.media_authorized('maers_private=old'))
        self.assertFalse(self.mock_s3.buckets['pub-bucket'])

    def test_private_space_tags_remain_encrypted_and_out_of_logs(self):
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
        import http.client
        import routes
        import server
        from .helpers import make_test_png_bytes
        node = self.protected_note()
        image = make_test_png_bytes('red')
        photo = private_cms.upload({'module': ['notes'], 'node_id': ['secret'],
            'category': ['_notes'], 'name': ['image.png']}, image)
        cookie = private_session.cookie_header().split(';')[0]
        with mock.patch.object(server, 'routes', routes), mock.patch.object(server.Handler, 'log_message'):
            with server.LocalServer(0) as httpd:
                worker = threading.Thread(target=httpd.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
                worker.start()
                try:
                    def request(path, headers=None, method='GET', body=None):
                        client = http.client.HTTPConnection(*httpd.server_address, timeout=5)
                        try:
                            client.request(method, path, body=body, headers=headers or {})
                            response = client.getresponse()
                            return response.status, dict(response.getheaders()), response.read()
                        finally:
                            client.close()
                    auth = {'X-MAERS-Token': httpd.session_token}
                    self.assertNotIn(b'PRIVATE_TITLE', request('/api/cms/fetch?module=notes')[2])
                    code, headers, body = request('/api/cms/fetch?module=notes', auth)
                    self.assertEqual(code, 200)
                    self.assertIn(b'PRIVATE_TITLE', body)
                    self.assertIn('no-store', headers['Cache-Control'])
                    path = '/data/' + node['content']
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
                finally:
                    httpd.shutdown()
                    worker.join(timeout=2)
