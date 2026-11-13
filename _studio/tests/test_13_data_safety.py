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
from services import local_media
from services import storage, storage_journal, media_store, media_jobs, data_safety, crypto_keyring, crypto_rotation

_REAL_GET_STORE = media_store.get_store


# 子进程的所有真源、缓存与媒体路径都指向当前测试沙盒。
_CHILD_SETUP = '''
import os, sys
sys.path.insert(0, sys.argv[1])
import config
root = sys.argv[2]
config.PROJECT_ROOT = root
config.DATA_DIR = os.path.join(root, 'data')
config.MARKDOWN_ROOT = os.path.join(root, 'markdown')
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


def _fail_json_write(target, message):
    """只在指定 JSON 写入点注入磁盘故障，其他写入继续走真实存储。"""
    original = storage.write_json
    def write(path, value):
        if path == target:
            raise OSError(message)
        return original(path, value)
    return write


def _capture_thread_error(errors, action):
    """将线程异常交回主线程断言，避免后台失败被测试运行器遗漏。"""
    try:
        action()
    except Exception as error:
        errors.append(error)


class Test13_DataSafety(SandboxTestCase):
    def test_rejected_keyring_save_preserves_keys_and_media_permissions(self):
        """结构错误、旧版本和受保护密钥改写均在任何文件或媒体权限变更前被拒绝。"""
        from services import media_groups
        slot = {'salt': 'YQ==', 'iter': 100000, 'wrap': 'enc:YQ==.Yg=='}
        identity = 'g_' + 'a' * 32
        group = {'v': 1, 'name': '人像', 'dek_id': '0101010101010101',
                 'pw': slot, 'master_wrap': 'enc:YQ==.Yg=='}
        ring = {'v': 1, 'master_only': True, 'dek_id': '0123456789abcdef', 'pw': slot, 'rc': slot, 'media_base': '',
                'groups': {identity: group}, 'content': {'v': 1, 'dek_id': '0202020202020202',
                'pw': slot, 'master_wrap': 'enc:YQ==.Yg==', 'wraps': {identity: 'enc:YQ==.Yg=='}}}
        crypto_keyring.write_ring(ring)
        paths = [Path(crypto_keyring.KEYRING_FILE), Path(crypto_keyring.local_keyring_file())]
        before = [path.read_bytes() for path in paths]
        second = 'g_' + 'b' * 32
        duplicates = {**ring, 'groups': {identity: group, second: {**group, 'dek_id': '0303030303030303'}},
                      'content': {**ring['content'], 'wraps': {identity: 'enc:YQ==.Yg==', second: 'enc:YQ==.Yg=='}}}
        without_content = {key: value for key, value in ring.items() if key != 'content'}
        cases = [
            (400, duplicates),
            (400, {**ring, 'content': {**ring['content'], 'dek_id': group['dek_id']}}),
            (400, {**ring, 'groups': {identity: {**group, 'master_wrap': 'invalid'}}}),
            (409, {**ring, 'groups': {}, 'content': {**ring['content'], 'wraps': {}}, '_expected': 'stale'}),
            (409, without_content),
            (409, {**ring, 'groups': {identity: {**group, 'master_wrap': 'enc:Yw==.ZA=='}}}),
        ]
        for status, body in cases:
            with self.subTest(status=status, fields=list(body)), \
                    mock.patch.object(media_groups, 'revoke') as revoke, \
                    mock.patch.object(media_groups, 'assign') as assign:
                self.assertEqual(crypto_keyring.save(body)[0], status)
                self.assertEqual([path.read_bytes() for path in paths], before)
                revoke.assert_not_called()
                assign.assert_not_called()

    def test_album_row_restore_rolls_back_partial_cache_and_closes_connection(self):
        """恢复图片行中途失败时，已执行的缓存修改回滚，连接仍被关闭。"""
        import sqlite3
        from services import album_lock
        image = self.upload_png('travel', 'kept.png', 'blue')
        original = album_lock.rows_by_paths([image['path']])[0]
        connect = photos.get_db
        connections = []
        def track_connection():
            connection = connect()
            connections.append(connection)
            return connection
        invalid = {**original, 'id': 'invalid', 'tags': object()}
        with mock.patch.object(photos, 'get_db', side_effect=track_connection), self.assertRaises(TypeError):
            album_lock.insert_rows([{**original, 'name': 'CHANGED'}, invalid])
        self.assertEqual(album_lock.rows_by_paths([image['path']]), [original])
        self.assertEqual(len(connections), 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            connections[0].execute('SELECT 1')

    def test_recovery_validates_all_remote_targets_before_writing(self):
        """恢复计划后部越界时，前面的有效目标也不能先被写回。"""
        backup = data_safety.create_backup('local')
        store = media_store.get_store()
        record = {'id': backup['id'], 'backend': store.identity(),
                  'targets': [('public', 'photos/images/travel/valid.png'), ('public', '../outside')]}
        with mock.patch.object(media_store, 'get_store', return_value=store), \
                mock.patch.object(store, 'delete') as remove, mock.patch.object(store, 'write') as write, \
                self.assertRaises(ValueError):
            data_safety.recover_backup(record)
        remove.assert_not_called()
        write.assert_not_called()

    def test_24_keyring_projection_migration_backup_and_rollback(self):
        """恢复材料不进入公开文件，迁移故障可回滚，完整备份可恢复本机密钥环。"""
        ring = {'v': 1, 'dek_id': '0123456789abcdef',
                'pw': {'salt': 'YQ==', 'iter': 600000, 'wrap': 'enc:password'},
                'rc': {'salt': 'Yg==', 'iter': 100000, 'wrap': 'enc:recovery'},
                'media_base': '', 'updated': 'private-timestamp'}
        storage.write_json(crypto_keyring.KEYRING_FILE, ring)
        failure = _fail_json_write(crypto_keyring.KEYRING_FILE, 'simulated public write failure')
        with mock.patch.object(storage, 'write_json', side_effect=failure), self.assertRaises(OSError):
            crypto_keyring.migrate()
        self.assertEqual(crypto_keyring._load(), ring)
        self.assertFalse(os.path.exists(crypto_keyring.local_keyring_file()))
        crypto_keyring.migrate()
        migrated = {**ring, 'master_only': True, 'groups': {}}
        self.assertEqual(set(self.load_json(crypto_keyring.KEYRING_FILE)),
                         {'v', 'dek_id', 'pw', 'media_base', 'master_only', 'groups'})
        self.assertEqual(crypto_keyring._load(), migrated)
        backup = data_safety.create_backup('local')
        storage.remove(crypto_keyring.local_keyring_file())
        with self.assertRaises(ValueError):
            crypto_keyring._load()
        data_safety.restore_backup(backup['id'])
        self.assertEqual(crypto_keyring._load(), migrated)
        # 旧格式备份恢复后也应再次分离，不能把恢复材料重新公开。
        storage.write_json(crypto_keyring.KEYRING_FILE, ring)
        legacy = data_safety.create_backup('local')
        legacy_path = Path(storage_journal.local_root()) / 'backups' / legacy['id'] / 'manifest.json'
        old_manifest = json.loads(legacy_path.read_text(encoding='utf-8'))
        old_manifest.pop('scope')
        storage.write_json(legacy_path, {**old_manifest, 'remote': False})
        crypto_keyring.migrate()
        data_safety.restore_backup(legacy['id'])
        self.assertNotIn('rc', self.load_json(crypto_keyring.KEYRING_FILE))
        self.assertEqual(crypto_keyring._load(), migrated)


    def _assert_private_access_denial(self, operation):
        """读权限和写权限分别失败，核对同一组文件、索引和公开错误。"""
        from botocore.exceptions import ClientError
        storage.write_json(config.ALBUM_CONFIG_JSON, [{'id': 'travel', 'title': 'test'}])
        image = self.upload_png('travel', 'private-denied.png', 'red')
        originals = {image[field]: Path(self.root_path(image[field])).read_bytes()
                     for field in ('path', 'thumb', 'preview')}
        for key, data in originals.items():
            self.mock_s3.put_object(Bucket='pub-bucket', Key=key, Body=data)
        album, gallery = self.album_config(), self.gallery_json()
        original = getattr(self.mock_s3, operation)
        def denied(*args, **kwargs):
            if kwargs['Bucket'] == 'priv-bucket':
                raise ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'internal-secret-marker'},
                                   'ResponseMetadata': {'HTTPStatusCode': 403}}, operation)
            return original(*args, **kwargs)
        with mock.patch.object(self.mock_s3, operation, side_effect=denied):
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

    def test_18_denied_private_access_preserves_album_sources(self):
        """私有桶读取被拒绝时保留原数据，响应隐藏内部存储信息。"""
        self._assert_private_access_denial('head_object')

    def test_denied_private_upload_preserves_album_sources(self):
        """私有桶上传被拒绝时保留原数据，后台任务给出明确结果。"""
        self._assert_private_access_denial('put_object')

    def local_store(self):
        """将可替换媒体后端限定在当前测试的私有目录。"""
        return media_store.MediaStore(settings={'provider': 'local', 'root': self.root_path('_studio/.local/media')})

    def child(self, body):
        """在独立进程内执行沙盒脚本，模拟崩溃与跨进程互斥。"""
        return subprocess.run([sys.executable, '-B', '-c', _CHILD_SETUP + body, STUDIO_DIR, self.temp_root],
                              capture_output=True, timeout=20)

    def test_01_missing_sources_stop_cleanup_without_removing_content(self):
        """关键索引缺失时必须停止清理，已有正文保持可恢复。"""
        self.add_node('safe', 'important')
        self.cms('update', {'id': 'safe', 'data': {'content': 'IMPORTANT'}})
        md = self.root_path('markdown', 'notes', 'root-important.md')
        for filename in ('notes-tree.json', 'photos-data.json', 'album-config.json', 'music-data.json', 'space-tree.json'):
            path = self.data_path(filename)
            original = Path(path).read_bytes()
            os.remove(path)
            self.assertEqual(self.call_post('/api/admin/clean_data')[0], 500)
            self.assertEqual(Path(md).read_text(encoding='utf-8'), 'IMPORTANT')
            storage.write_bytes(path, original)

    def test_02_cleanup_quarantines_and_restores_without_overwriting_new_files(self):
        """孤立文件先进入回收区，恢复时不能覆盖后来创建的同名文件。"""
        orphan = self.root_path('markdown', 'notes', 'orphan.md')
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

    def test_03_process_exit_during_protect_restores_index_and_keeps_markdown(self):
        """设为私密中途退出后，第一次读取必须先恢复一致的索引，本地正文始终完好。"""
        self.add_node('n', 'private')
        self.cms('update', {'id': 'n', 'data': {'content': 'PRIVATE TEXT'}})
        process = self.child("\nsave = cms.save_module_tree\ndef crash(module, tree):\n    save(module, tree)\n    os._exit(73)\ncms.save_module_tree = crash\ncms_nodes.lock_node('notes', 'n', cms.get_context())\n")
        self.assertEqual(process.returncode, 73, process.stderr)
        self.assertTrue(storage_journal.pending())
        # 普通读接口首先恢复，不会留下半完成的私密标记。
        tree = self.fetch_tree()
        self.assertNotIn('_private', tree['root'][0])
        self.assertEqual(Path(self.root_path(tree['root'][0]['content'])).read_text(encoding='utf-8'), 'PRIVATE TEXT')
        self.assertFalse(storage_journal.pending())

    def test_04_replacement_filesystem_store_supports_private_migration(self):
        """切换为文件系统媒体后端时，加锁与解锁仍迁移正确的图片副本。"""
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
        """远程上传失败必须留存待同步任务，重试成功后验证原图字节一致。"""
        store = self.local_store()
        with mock.patch.object(media_store, 'get_store', return_value=store), mock.patch.object(photos, 'DISABLE_R2_SYNC', False):
            with mock.patch.object(store, 'write', side_effect=OSError('offline')):
                image = self.upload_png('travel', 'a.png', 'red')
            self.assertEqual(image['sync']['state'], 'pending')
            self.assertEqual(len(media_jobs.pending()), 3)
            self.assertEqual(media_jobs.retry()['state'], 'complete')
            self.assertFalse(media_jobs.pending())
            for field in ('path', 'thumb', 'preview'):
                self.assertEqual(store.read('public', image[field]), Path(self.root_path(image[field])).read_bytes())

    def test_06_inflight_upload_and_lock_are_serialized(self):
        """进行中的上传与加锁串行执行，结束后只留下正确的私密副本。"""
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
            shared['image'] = self.upload_png('_notes', 'a.png', 'red')
        def lock():
            attempted.set()
            self.cms('update', {'id': 'n', 'data': {'coverImage': shared['key']}})
            shared['lock'] = self.cms('lock', {'id': 'n', 'enc': 'enc:test', 'covers': [shared['key']]})
        with mock.patch.object(media_store, 'get_store', return_value=store), \
                mock.patch.object(photos, 'DISABLE_R2_SYNC', False), mock.patch.object(store, 'write', side_effect=delayed):
            first = threading.Thread(target=_capture_thread_error, args=(errors, upload))
            second = threading.Thread(target=_capture_thread_error, args=(errors, lock))
            first.start()
            try:
                self.assertTrue(started.wait(5))
                second.start()
                self.assertTrue(attempted.wait(5))
            finally:
                # 即使同步点断言失败，也释放后台线程，防止影响后续沙盒。
                release.set()
                first.join(10)
                if second.ident is not None:
                    second.join(10)
            self.assertFalse(first.is_alive() or second.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(shared['lock'][0], 200, shared['lock'])
            self.assertFalse(store.exists('public', shared['key']))
            self.assertTrue(store.exists('private', shared['key']))
            self.assertFalse(media_jobs.pending())

    def test_07_stale_body_and_lock_snapshot_cannot_overwrite_new_data(self):
        """旧正文版本和过期加锁快照都不能覆盖外部编辑器的新内容。"""
        self.add_node('n', 'important')
        self.cms('update', {'id': 'n', 'data': {'content': 'OLD'}})
        tree = self.fetch_tree()
        sources = cms.cms_nodes.lock_sources(tree['root'][0], cms.get_context())
        path = self.root_path(tree['root'][0]['content'])
        storage.write_text(path, 'NEW EXTERNAL EDIT')
        revision = hashlib.sha256(b'OLD').hexdigest()
        code, result = self.cms('update', {'id': 'n', 'data': {'content': 'OLD', 'expectedRevision': revision}})
        self.assertEqual((code, result['code']), (409, 'markdown_conflict'))
        self.assertEqual(result['currentRevision'], hashlib.sha256(b'NEW EXTERNAL EDIT').hexdigest())
        self.assertEqual(self.cms('lock', {'id': 'n', 'enc': 'enc:stale', 'sources': sources})[0], 400)
        self.assertEqual(Path(path).read_text(encoding='utf-8'), 'NEW EXTERNAL EDIT')
        self.assertEqual(self.cms('update', {'id': 'n', 'data': {'title': 'renamed'}})[0], 200)
        self.assertEqual(Path(self.root_path('markdown', 'notes', 'root-renamed.md')).read_text(encoding='utf-8'), 'NEW EXTERNAL EDIT')

    def test_08_backup_restore_isolated_local_and_cloud_scopes(self):
        """两份备份分别恢复，云端包含 Markdown 和原有对象头。"""
        store = media_store.get_store()
        self.add_node('n', 'important')
        self.cms('update', {'id': 'n', 'data': {'content': 'ORIGINAL'}})
        path = Path(self.root_path('markdown', 'notes', 'root-important.md'))
        public, private = 'photos/images/travel/a.png', 'photos/images/secret/b.png'
        note, private_note = 'markdown/notes/root-important.md', 'markdown/notes/root-secret.md'
        with mock.patch.object(media_store, 'get_store', return_value=store):
            store.write('public', public, b'PUBLIC')
            store.write('private', private, b'PRIVATE')
            store.write_content(note, b'CLOUD MARKDOWN')
            store.write_content(private_note, b'PRIVATE MARKDOWN', 'private')
            local_media.keep(private, b'PRIVATE')
            local_media.set_private([private])
            cached = local_media.path(private)
            local = data_safety.create_backup('local')
            cloud = data_safety.create_backup('cloud')
            self.assertEqual(data_safety.verify_backup(cloud['id'])['scope'], 'cloud')

            storage.write_text(path, 'CORRUPTED')
            store.write('public', public, b'CHANGED')
            store._delete_remote('private', private)
            store.delete_content(note)
            store.delete_content(private_note, 'private')
            cached.unlink()
            extra = self.root_path('markdown', 'notes', 'later.md')
            storage.write_text(extra, 'NEWER CONTENT')
            cloud_extra = 'photos/images/travel/later.png'
            store.write('public', cloud_extra, b'NEWER CLOUD')

            put = self.mock_s3.put_object
            def fail_restore(**kwargs):
                if kwargs['Key'] == private_note:
                    raise OSError('restore write failed')
                return put(**kwargs)

            with mock.patch.object(self.mock_s3, 'put_object', side_effect=fail_restore), \
                    self.assertRaisesRegex(OSError, 'restore write failed'):
                data_safety.restore_backup(cloud['id'])
            self.assertEqual(store.read('public', public), b'CHANGED')
            self.assertEqual(store.read('public', cloud_extra), b'NEWER CLOUD')
            self.assertEqual(path.read_text(encoding='utf-8'), 'CORRUPTED')

            result = data_safety.restore_backup(cloud['id'])
            self.assertEqual(data_safety.verify_backup(result['safety_backup'])['scope'], 'cloud')
            self.assertEqual(path.read_text(encoding='utf-8'), 'CORRUPTED')
            self.assertFalse(cached.exists())
            self.assertTrue(os.path.exists(extra))
            self.assertEqual(store.read('public', public), b'PUBLIC')
            self.assertEqual(store.read('private', private), b'PRIVATE')
            self.assertEqual(store._read_content(note), b'CLOUD MARKDOWN')
            self.assertEqual(store._read_content(private_note, 'private'), b'PRIVATE MARKDOWN')
            self.assertFalse(store.exists('public', cloud_extra))

            store.write('public', public, b'CLOUD AFTER RESTORE')
            with mock.patch.object(media_store, 'get_store', side_effect=AssertionError('本机恢复访问了桶')):
                result = data_safety.restore_backup(local['id'])
            self.assertEqual(data_safety.verify_backup(result['safety_backup'])['scope'], 'local')
            self.assertEqual(path.read_text(encoding='utf-8'), 'ORIGINAL')
            self.assertEqual(cached.read_bytes(), b'PRIVATE')
            self.assertFalse(os.path.exists(extra))
            self.assertEqual(store.read('public', public), b'CLOUD AFTER RESTORE')
            self.assertTrue(data_safety.list_recovery()['trash'])

    def test_09_corrupt_backup_is_rejected_before_any_restore(self):
        """损坏的备份在写入前被拒绝，当前索引保持原样。"""
        self.add_node('n', 'important')
        backup = data_safety.create_backup('local')
        directory = Path(storage_journal.local_root()) / 'backups' / backup['id']
        manifest = json.loads((directory / 'manifest.json').read_text())
        (directory / manifest['files'][0]['blob']).write_bytes(b'BROKEN')
        before = Path(self.data_path('notes-tree.json')).read_bytes()
        with self.assertRaises(ValueError):
            data_safety.restore_backup(backup['id'])
        self.assertEqual(Path(self.data_path('notes-tree.json')).read_bytes(), before)

    def test_legacy_combined_backup_is_not_restored(self):
        """旧合并备份保留在列表里，恢复入口在任何写入前拒绝它。"""
        backup = data_safety.create_backup('local')
        path = Path(storage_journal.local_root()) / 'backups' / backup['id'] / 'manifest.json'
        manifest = json.loads(path.read_text(encoding='utf-8'))
        manifest.pop('scope')
        storage.write_json(path, {**manifest, 'remote': True})
        self.assertEqual(data_safety.list_recovery()['backups'][0]['scope'], 'legacy')
        with mock.patch.object(media_store, 'get_store', side_effect=AssertionError('访问了云端')), \
                self.assertRaisesRegex(ValueError, '旧合并备份'):
            data_safety.restore_backup(backup['id'])

    def test_10_rotation_is_complete_version_checked_and_failure_atomic(self):
        """密钥轮换发生写入故障时整体回滚，成功后仍须确认正确的令牌版本。"""
        slot = {'salt': 'AAAAAAAAAAAAAAAAAAAAAA==', 'iter': 10000, 'wrap': 'enc:wrapped'}
        group = 'g_' + 'a' * 32
        linked = {'v': 1, 'dek_id': '0101010101010101', 'name': '分享组', 'pw': slot, 'rc': slot,
                  'master_wrap': 'enc:YQ==.Yg=='}
        old = {'v': 1, 'dek_id': '0123456789abcdef', 'pw': slot, 'rc': slot, 'media_base': 'https://private.example',
               'groups': {group: linked}}
        self.assertEqual(crypto_keyring.save(dict(old))[0], 200)
        public_group = self.load_json(crypto_keyring.KEYRING_FILE)['groups'][group]
        self.assertNotIn('rc', public_group)
        self.assertEqual(public_group['master_wrap'], linked['master_wrap'])
        self.assertEqual(crypto_keyring.save({**old, 'groups': {group: {k: v for k, v in linked.items() if k != 'master_wrap'}}})[0], 409)
        # 轮换只处理旧版密文；方案 3 不再生成 _enc，因此直接写入历史密文节点。
        storage.write_json(self.data_path('notes-tree.json'), {'root': [
            {'id': 'n', 'type': 'locked', 'children': None, 'mediaVersion': 1, '_enc': 'enc:old'}]})
        source = crypto_rotation.export_snapshots()
        files = json.loads(json.dumps(source['files']))
        for item in files:
            if item['path'] == 'notes-tree.json':
                item['data']['root'][0]['_enc'] = 'enc:new'
        new = {**old, 'dek_id': 'fedcba9876543210'}
        body = {'expected_dek_id': old['dek_id'], 'expected_keyring_revision': source['keyring_revision'],
                'keyring': new, 'files': files, 'token_hash': 'a' * 64}
        with self.assertRaisesRegex(ValueError, 'rewrap linked groups'):
            crypto_rotation.rotate(body)
        new['groups'] = {group: {**linked, 'master_wrap': 'enc:Yw==.ZA=='}}
        failure = _fail_json_write(crypto_keyring.KEYRING_FILE, 'disk failure')
        with mock.patch.object(storage, 'write_json', side_effect=failure), self.assertRaises(OSError):
            crypto_rotation.rotate(body)
        self.assertEqual(self.fetch_tree()['root'][0]['_enc'], 'enc:old')
        self.assertEqual(crypto_keyring._load()['dek_id'], old['dek_id'])
        result = crypto_rotation.rotate(body)
        self.assertTrue(result['token_pending'])
        self.assertTrue(crypto_rotation.pending()['pending'])
        self.assertEqual(self.fetch_tree()['root'][0]['_enc'], 'enc:new')
        self.assertEqual(crypto_keyring._load()['groups'][group], crypto_keyring.clean_ring(new)['groups'][group])
        self.assertEqual(crypto_keyring.save({**old, 'force': True})[0], 409)
        with self.assertRaises(ValueError):
            crypto_rotation.finalize({'dek_id': new['dek_id'], 'token_hash': 'b' * 64})
        crypto_rotation.finalize({'dek_id': new['dek_id'], 'token_hash': 'a' * 64})
        self.assertFalse(crypto_rotation.pending()['pending'])

    def test_empty_default_becomes_master_only_and_never_encrypts_new_content(self):
        """空默认组自动退出内容列表，保留主密码密钥，内容组需要自行创建。"""
        slot = {'salt': 'YQ==', 'iter': 100000, 'wrap': 'enc:YQ==.Yg=='}
        old = {'v': 1, 'name': '默认组', 'dek_id': '0123456789abcdef', 'pw': slot, 'rc': slot,
               'media_base': 'https://private.example'}
        self.assertEqual(crypto_keyring.save(dict(old))[0], 200)
        crypto_keyring.migrate()
        ring = crypto_keyring._load()
        self.assertTrue(ring['master_only'])
        self.assertEqual(ring['groups'], {})
        self.assertNotIn('name', ring)
        self.assertEqual(ring['dek_id'], old['dek_id'])
        with self.assertRaisesRegex(ValueError, '创建并选择'):
            crypto_keyring.require_content_group('default')
        self.assertEqual(crypto_keyring.save(old)[0], 409)
        self.assertTrue(self.load_json(crypto_keyring.KEYRING_FILE)['master_only'])
        self.assertNotIn('rc', self.load_json(crypto_keyring.KEYRING_FILE))

    def test_master_only_rotation_rewraps_groups_without_media_token_revocation(self):
        """主密钥只包裹自建组，轮换时保持组数据密钥和图片令牌。"""
        slot = {'salt': 'YQ==', 'iter': 100000, 'wrap': 'enc:YQ==.Yg=='}
        identity = 'g_' + 'a' * 32
        group = {'v': 1, 'name': '人像', 'dek_id': '0101010101010101', 'pw': slot, 'rc': slot,
                 'master_wrap': 'enc:YQ==.Yg=='}
        ring = {'v': 1, 'master_only': True, 'dek_id': '0123456789abcdef', 'pw': slot, 'rc': slot,
                'media_base': 'https://private.example', 'groups': {identity: group},
                'content': {'v': 1, 'dek_id': '0202020202020202', 'pw': slot,
                            'master_wrap': 'enc:YQ==.Yg==', 'wraps': {identity: 'enc:YQ==.Yg=='}}}
        self.assertEqual(crypto_keyring.save(ring)[0], 200)
        source = crypto_rotation.export_snapshots()
        replacement = {**ring, 'dek_id': 'fedcba9876543210',
                       'groups': {identity: {**group, 'master_wrap': 'enc:Yw==.ZA=='}},
                       'content': {**ring['content'], 'master_wrap': 'enc:Yw==.ZA=='}}
        result = crypto_rotation.rotate({'expected_dek_id': ring['dek_id'],
            'expected_keyring_revision': source['keyring_revision'], 'keyring': replacement, 'files': source['files']})
        self.assertFalse(result['token_pending'])
        self.assertFalse(crypto_rotation.pending()['pending'])
        self.assertEqual(crypto_keyring._load()['groups'][identity]['dek_id'], group['dek_id'])
        self.assertEqual(crypto_keyring._load()['content']['pw'], ring['content']['pw'])
        self.assertEqual(crypto_keyring._load()['content']['wraps'], ring['content']['wraps'])

    def test_legacy_default_content_and_unlinked_groups_block_automatic_conversion(self):
        """迁移不得遗失旧默认组密文，也不能把尚未接入主密码的组声明为全解锁。"""
        slot = {'salt': 'YQ==', 'iter': 100000, 'wrap': 'enc:YQ==.Yg=='}
        identity = 'g_' + 'b' * 32
        group = {'v': 1, 'name': '旧自建组', 'dek_id': '0101010101010101', 'pw': slot, 'rc': slot}
        ring = {'v': 1, 'dek_id': '0123456789abcdef', 'pw': slot, 'rc': slot,
                'media_base': '', 'groups': {identity: group}}
        crypto_keyring.write_ring(ring)
        crypto_keyring.migrate()
        self.assertNotIn('master_only', crypto_keyring._load())
        self.assertEqual(crypto_keyring.save({**ring, 'master_only': True})[0], 400)
        ring['groups'][identity]['master_wrap'] = 'enc:YQ==.Yg=='
        crypto_keyring.write_ring(ring)
        path = self.root_path('data/music-data.json')
        storage.write_json(path, [{'_enc': 'enc:kept'}])
        crypto_keyring.migrate()
        self.assertNotIn('master_only', crypto_keyring._load())
        self.assertEqual(crypto_keyring.save({**ring, 'master_only': True})[0], 409)
        crypto_keyring.require_content_group('default')
        moved = [{'_enc': 'enc:kept', '_group': identity}]
        storage.write_json(path, moved)
        crypto_keyring.migrate()
        self.assertTrue(crypto_keyring._load()['master_only'])
        self.assertEqual(crypto_keyring._load()['pw'], ring['pw'])
        self.assertEqual(crypto_keyring._load()['groups'], crypto_keyring.clean_ring(ring)['groups'])
        self.assertNotIn('rc', crypto_keyring._load()['groups'][identity])
        self.assertEqual(self.load_json(path), moved)
        crypto_keyring.require_content_group(identity)

    def test_11_interrupted_media_purge_restores_disk_backend_before_serving(self):
        """清除公开媒体时进程异常退出，恢复必须先于下一次内容读取。"""
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
save = cms.save_module_tree
def interrupted(module, tree):
    save(module, tree)
    os._exit(74)
cms.save_module_tree = interrupted
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
        """过期的相册导出不能删除导出后才上传的照片。"""
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
        """未完成同步、恢复或密钥轮换时，发布检查必须阻止上线。"""
        from .test_03_data_integrity import publication_issues
        outbox = self.root_path('_studio/.local/media-outbox.json')
        storage.write_json(outbox, [{'key': 'photos/images/travel/a.png', 'action': 'upload'}])
        self.assertTrue(publication_issues(self.temp_root))
        self.assertTrue(publication_issues(self.temp_root, preparing=True))
        storage.write_json(outbox, [{'key': 'photos/images/travel/a.png', 'action': 'ensure', 'deferred': True}])
        self.assertTrue(publication_issues(self.temp_root))
        self.assertFalse(publication_issues(self.temp_root, preparing=True))
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
        """后台占有项目锁时拒绝独立工具写入，释放后允许再次取得锁。"""
        script = '\nfrom services import storage_journal\nwith storage_journal.process_lock():\n    print("acquired")\n'
        with storage_journal.process_lock():
            blocked = self.child(script)
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn(b'already using', blocked.stderr)
        self.assertEqual(self.child(script).returncode, 0)

    def test_recovery_checkpoints_each_completed_remote_policy(self):
        """恢复中再次断连时保留剩余项，下一次仅继续尚未恢复的权限。"""
        store = media_store.get_store()
        journal = storage_journal.Journal()
        keys = ['_maers/media-groups/' + char * 64 + '.json' for char in ('a', 'b')]
        for key in keys:
            store.write_policy(key, b'new')
            journal.remote({'kind': 'media-policy', 'backend': store.identity(), 'key': key, 'before': b'old'.hex()})
        original = media_store.recover
        calls = []
        def interrupted(record):
            calls.append(record['key'])
            if len(calls) == 2:
                raise OSError('temporary disconnect')
            original(record)
        with mock.patch.object(media_store, 'recover', side_effect=interrupted), self.assertRaises(OSError):
            storage.recover()
        remaining = json.loads(Path(journal.path).read_text(encoding='utf-8'))['remote']
        self.assertEqual([item['key'] for item in remaining], keys[:1])
        with mock.patch.object(media_store, 'recover', wraps=original) as replay:
            storage.recover()
        self.assertEqual(replay.call_count, 1)
        self.assertFalse(storage_journal.pending())
        self.assertEqual([store.read_policy(key) for key in keys], [b'old', b'old'])

    def test_15_failed_local_derivative_does_not_publish_partial_files(self):
        """预览图生成失败时撤回原图和缩略图，图库索引不得发布半成品。"""
        from services import photo_images
        original = photo_images.write_generated
        def fail_preview(image, path, image_format=None, **options):
            if '/previews/' in path.replace('\\', '/'):
                raise OSError('disk full')
            return original(image, path, image_format, **options)
        from .helpers import make_test_png_bytes
        with mock.patch.object(photo_images, 'write_generated', side_effect=fail_preview):
            code, result = self.call_post('/upload', {'category': ['travel'], 'name': ['a.png']},
                                          file_data=make_test_png_bytes('red'))
        self.assertEqual(code, 400, result)
        self.assertEqual(self.gallery_json(), {})
        self.assertEqual([p for p in Path(self.temp_photos).rglob('*') if p.is_file()], [])

    def test_16_invalid_storage_config_preserves_local_upload_and_pending_task(self):
        """媒体配置无效时保留本地上传和待同步任务，修复后允许补传。"""
        with mock.patch.object(photos, 'DISABLE_R2_SYNC', False):
            with mock.patch.object(media_store, 'get_store', side_effect=ValueError('missing credentials')):
                image = self.upload_png('travel', 'a.png', 'red')
            self.assertEqual(image['sync']['state'], 'pending')
            self.assertIsNone(media_jobs.pending()[0]['backend'])
            self.assertEqual(media_jobs.retry()['state'], 'complete')
            self.assertFalse(media_jobs.pending())
            self.assertIn(image['path'], self.mock_s3.buckets['pub-bucket'])

    def test_17_migrated_cdn_prefix_and_literal_cover_key_are_private(self):
        """不同 CDN 地址仍指向同一封面键，加锁时必须迁移真实图片。"""
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

    def test_legacy_private_photos_migrate_once_and_keep_scope(self):
        key = 'photos/images/secret/old.png'
        legacy = Path(self.root_path('_studio/.local/private-media'))
        for identity in ('a' * 64, 'b' * 64):
            source = legacy / identity / key
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b'PRIVATE')
        self.assertEqual(local_media.migrate_legacy(), 2)
        self.assertEqual(local_media.path(key).read_bytes(), b'PRIVATE')
        self.assertTrue(local_media.is_private(key))
        self.assertFalse(legacy.exists())
        self.assertEqual(local_media.migrate_legacy(), 0)
        backup = data_safety.create_backup('local')
        self.assertEqual(data_safety.verify_backup(backup['id'])['scope'], 'local')

    def test_legacy_photo_conflict_stops_before_any_move_or_marker(self):
        root = Path(self.root_path('_studio/.local/private-media')) / ('a' * 64)
        for name in ('first.png', 'conflict.png'):
            source = root / 'photos/images/secret' / name
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(b'OLD')
        target = local_media.path('photos/images/secret/conflict.png')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b'NEW')
        with self.assertRaisesRegex(ValueError, '同名冲突'):
            local_media.migrate_legacy()
        self.assertEqual(target.read_bytes(), b'NEW')
        self.assertFalse(local_media.path('photos/images/secret/first.png').exists())
        self.assertFalse(local_media.private_keys())
        self.assertEqual(len(list(root.rglob('*.png'))), 2)

    def test_private_local_photos_survive_cleanup_and_reject_public_queue(self):
        from services import janitor
        key = 'photos/images/secret/retained.png'
        local_media.keep(key, b'PRIVATE')
        local_media.set_private([key])
        janitor.run_cleanup()
        self.assertEqual(local_media.path(key).read_bytes(), b'PRIVATE')
        media_jobs.enqueue('upload', key)
        self.assertEqual(media_jobs.retry()['state'], 'pending')
        self.assertFalse(media_store.get_store().exists('public', key))

    def test_storage_mode_switch_and_deploy_snippets_roundtrip(self):
        """未配桶可复制部署代码与构建命令；已配云存储支持一键切回纯本机并无损恢复原云存储。"""
        Path(self.root_path('_studio/tools/r2_config.json')).unlink(missing_ok=True)
        site_path = Path(self.root_path('custom/config.js'))
        storage.write_text(
            site_path,
            "window.MAERS.Config = {\n    MEDIA_PUBLIC_BASE: '',\n    CONTENT_PUBLIC_BASE: ''\n};\n"
        )
        for name, expected in (('PAGES_BUILD_OUTPUT', 'dist'), ('PAGES_BUILD_COMMAND', 'build-site.mjs'),
                               ('WORKER_SCRIPT', 'MAERS_SYNC_KV')):
            code, res = self.call_post('/api/storage/worker-setting', body={'name': name})
            self.assertEqual(code, 200, res)
            self.assertIn(expected, res['value'])

        endpoint = 'https://s3.us-west-004.backblazeb2.com'
        b2_pair = {
            'id': 'default', 'create': False,
            'public': {'provider': 'b2', 'endpoint_url': endpoint, 'bucket_name': 'pub-bucket',
                       'access_key_id': 'key1', 'secret_access_key': 'sec1'},
            'private': {'provider': 'b2', 'endpoint_url': endpoint, 'bucket_name': 'priv-bucket',
                        'access_key_id': 'key1', 'secret_access_key': 'sec1'},
            'site': {'MEDIA_PUBLIC_BASE': 'https://images.example.com',
                     'CONTENT_PUBLIC_BASE': 'https://content.example.com'}
        }
        with (mock.patch.object(media_store, 'get_store', _REAL_GET_STORE),
              mock.patch('boto3.client', return_value=self.mock_s3)):
            code, saved = self.call_post('/api/storage/config', body=b2_pair)
            self.assertEqual(code, 200, saved)
            self.mock_s3.put_object(Bucket='priv-bucket', Key='_maers/private-token.json', Body=b'{"hash":"abc"}')
            self.assertEqual(
                self.call_post('/api/storage/worker-setting', body={'name': 'CDN_CONTENT_HOST_RULE'})[1]['value'],
                '(http.host eq "content.example.com")'
            )
            self.assertEqual(
                self.call_post('/api/storage/worker-setting', body={'name': 'CDN_CONTENT_REWRITE_EXPR'})[1]['value'],
                'concat("/file/pub-bucket", http.request.uri.path)'
            )

            outbox = Path(self.root_path('_studio/.local/media-outbox.json'))
            storage.write_json(outbox, [{'key': 'photos/images/t/a.png', 'action': 'upload'}])
            self.assertEqual(self.call_post('/api/storage/mode', body={'mode': 'local'})[0], 400)
            storage.write_json(outbox, [])

            code, local_view = self.call_post('/api/storage/mode', body={'mode': 'local'})
            self.assertEqual(code, 200, local_view)
            self.assertEqual(local_view['mode'], 'local')
            self.assertTrue(local_view['hasSavedCloud'])
            self.assertEqual(local_view['site'], {'MEDIA_PUBLIC_BASE': '', 'CONTENT_PUBLIC_BASE': ''})
            local_token = Path(self.root_path('_studio/.local/media/private/_maers/private-token.json'))
            self.assertEqual(local_token.read_bytes(), b'{"hash":"abc"}')

            code, restored_view = self.call_post('/api/storage/mode', body={'mode': 'cloud'})
            self.assertEqual(code, 200, restored_view)
            self.assertEqual(restored_view['mode'], 'cloud')
            self.assertFalse(restored_view['hasSavedCloud'])
            self.assertEqual(restored_view['site'], b2_pair['site'])
            self.assertEqual(restored_view['groups'][0]['public']['bucket_name'], 'pub-bucket')

    def test_custom_backup_location_and_external_import_validation(self):
        """支持指定项目外异盘目录保存备份，并可从外部目录校验 SHA-256 后导入恢复。"""
        import tempfile
        ext_root = tempfile.mkdtemp(prefix='maers_ext_backup_')
        self.addCleanup(lambda: __import__('shutil').rmtree(ext_root, ignore_errors=True))

        self.assertEqual(self.call_post('/api/admin/backup_location', body={'path': 'relative/dir'})[0], 400)
        self.assertEqual(self.call_post('/api/admin/backup_location', body={'path': self.root_path('data/backups')})[0], 400)

        target_dir = os.path.join(ext_root, 'vault')
        code, info = self.call_post('/api/admin/backup_location', body={'path': target_dir})
        self.assertEqual(code, 200, info)
        self.assertTrue(info['is_custom_dir'])
        self.add_node('ext-note', '异盘备份测试')
        self.cms('update', {'id': 'ext-note', 'data': {'content': 'EXTERNAL_BACKUP_BODY'}})

        code, created = self.call_post('/api/admin/backup', body={'scope': 'local'})
        self.assertEqual(code, 200, created)
        self.assertTrue(os.path.isfile(os.path.join(target_dir, created['id'], 'manifest.json')))

        code, reset = self.call_post('/api/admin/backup_location', body={'path': ''})
        self.assertEqual(code, 200, reset)
        self.assertFalse(reset['is_custom_dir'])
        self.assertEqual(reset['backups'], [])

        broken_dir = os.path.join(ext_root, 'broken', created['id'])
        os.makedirs(broken_dir, exist_ok=True)
        for item in Path(target_dir, created['id']).iterdir():
            data = b'corrupted' if item.name != 'manifest.json' else item.read_bytes()
            Path(broken_dir, item.name).write_bytes(data)
        self.assertEqual(self.call_post('/api/admin/import_backup', body={'path': broken_dir})[0], 400)
        self.assertEqual(self.call_get('/api/admin/recovery')[1]['backups'], [])

        self.cms('delete', {'id': 'ext-note'})
        code, imported = self.call_post('/api/admin/import_backup', body={'path': target_dir})
        self.assertEqual(code, 200, imported)
        self.assertEqual(imported['imported'], 1)
        imported_id = imported['ids'][0]
        self.assertEqual(self.call_post('/api/admin/verify_backup', body={'id': imported_id})[0], 200)
        self.assertEqual(self.call_post('/api/admin/restore_backup', body={'id': imported_id})[0], 200)
        self.assertEqual(
            Path(self.root_path('markdown/notes/root-异盘备份测试.md')).read_text(encoding='utf-8'),
            'EXTERNAL_BACKUP_BODY'
        )
