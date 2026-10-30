"""数据架构回归：真源优先、缓存重建、并发串行化、失败回滚与独立工作目录。"""

import json
import os
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from unittest import mock

from .sandbox import SandboxTestCase, cms, photos, album_lock, space, config
from services import storage


class Test11_StorageArchitecture(SandboxTestCase):
    def test_44_media_restore_validates_paths_before_remote_transfer(self):
        """整批媒体路径必须先通过边界检查，不能发布非法路径对应的私有对象。"""
        with mock.patch.object(self.mock_s3, 'get_object') as get_object:
            with self.assertRaises(ValueError):
                album_lock.restore_from_private(album_lock._storage(),
                    ['photos/images/travel/valid.png', 'photos/images/../../secret.txt'])
            get_object.assert_not_called()

    def test_41_album_lock_metadata_failure_restores_files_and_cache(self):
        """公开删除完成后配置写入失败，也必须恢复三层图片、标签和缓存。"""
        self.call_post('/api/add_category', body={'id': 'travel', 'title': '相册'})
        images = [self.upload_png('travel', 'a.png', 'red'), self.upload_png('travel', 'b.png', 'blue')]
        before, gallery = self.album_config(), self.gallery_json()
        originals = {}
        for image in images:
            for field in ('path', 'thumb', 'preview'):
                with open(self.root_path(image[field]), 'rb') as source:
                    originals[image[field]] = source.read()
        write_json = storage.write_json
        def fail_config(path, data):
            write_json(path, data)
            if path == config.ALBUM_CONFIG_JSON:
                raise OSError('configuration publish failed')
        with mock.patch.object(storage, 'write_json', side_effect=fail_config):
            _, started = self.call_post('/api/album/lock_category', body={'id': 'travel', 'enc': 'enc:album'})
            self.assertEqual(self.wait_album_job(started['job'])['state'], 'error')
        self.assertEqual(self.album_config(), before)
        self.assertEqual(self.gallery_json(), gallery)
        self.assertTrue(os.path.isfile(self.data_path('tags', 'photos-travel-tag-categories.json')))
        self.assertEqual(len(album_lock._rows_of('travel')), 2)
        for path, expected in originals.items():
            with open(self.root_path(path), 'rb') as source:
                self.assertEqual(source.read(), expected)
        for image in images:
            self.assertIn(image['path'], self.mock_s3.buckets['pub-bucket'])
        _, started = self.call_post('/api/album/lock_category', body={'id': 'travel', 'enc': 'enc:album'})
        self.assertEqual(self.wait_album_job(started['job'])['state'], 'success')

    def test_42_album_unlock_publish_failure_retracts_public_files_and_retries(self):
        """相册解锁发布索引失败：密文和私有副本保留，公开侧撤回，随后可直接重试。"""
        self.call_post('/api/add_category', body={'id': 'travel', 'title': '相册'})
        image = self.upload_png('travel', 'a.png', 'green')
        _, exported = album_lock.export_category('travel')
        _, started = self.call_post('/api/album/lock_category', body={'id': 'travel', 'enc': 'enc:album'})
        self.assertEqual(self.wait_album_job(started['job'])['state'], 'success')
        body = {'enc': 'enc:album', 'payload': {
            'category': exported['category'], 'photos': exported['photos'], 'tags_file': exported['tags_file']}}
        write_json = storage.write_json
        def fail_gallery(path, data):
            write_json(path, data)
            if path == photos.GALLERY_JSON_FILE:
                raise OSError('gallery publish failed')
        with mock.patch.object(storage, 'write_json', side_effect=fail_gallery):
            _, started = self.call_post('/api/album/unlock_category', body=body)
            self.assertEqual(self.wait_album_job(started['job'])['state'], 'error')
        self.assertEqual(self.album_config(), [{'_enc': 'enc:album'}])
        self.assertNotIn('travel', self.gallery_json())
        self.assertEqual(album_lock._rows_of('travel'), [])
        self.assertNotIn(image['path'], self.mock_s3.buckets['pub-bucket'])
        for field in ('path', 'thumb', 'preview'):
            self.assertFalse(os.path.exists(self.root_path(image[field])))
            self.assertIn(image[field], self.mock_s3.buckets['priv-bucket'])
        _, started = self.call_post('/api/album/unlock_category', body=body)
        self.assertEqual(self.wait_album_job(started['job'])['state'], 'success')

    def test_43_unlock_lost_upload_response_compensates_before_retry(self):
        """恢复原图时上传已执行但响应丢失，仍能撤回公开对象并保留完整私有副本。"""
        image = self.upload_png('_notes', 'private.png', 'blue')
        self.add_node('private', '文章')
        row = album_lock.rows_by_paths([image['path']])[0]
        self.assertEqual(self.cms('lock', {'id': 'private', 'enc': 'enc:test', 'covers': [image['path']]})[0], 200)
        body = {'id': 'private', 'tree': {'id': 'private', 'title': '文章', 'md': '正文', 'coverRow': row}}
        before = self.fetch_tree()
        put = self.mock_s3.put_object
        def lose_response(Bucket, **kwargs):
            put(Bucket=Bucket, **kwargs)
            if Bucket == 'pub-bucket':
                raise OSError('upload response lost')
        with mock.patch.object(self.mock_s3, 'put_object', side_effect=lose_response):
            self.assertEqual(self.cms('unlock', body)[0], 500)
        self.assertEqual(self.fetch_tree(), before)
        self.assertNotIn(image['path'], self.mock_s3.buckets['pub-bucket'])
        for field in ('path', 'thumb', 'preview'):
            self.assertFalse(os.path.exists(self.root_path(image[field])))
            self.assertIn(image[field], self.mock_s3.buckets['priv-bucket'])
        self.assertEqual(self.cms('unlock', body)[0], 200)

    def test_39_media_regression_album_public_delete_failure_is_retryable(self):
        """公开删除响应丢失也必须报错、恢复分类与文件，并可复用私有副本重试。"""
        self.call_post('/api/add_category', body={'id': 'travel', 'title': '相册'})
        image = self.upload_png('travel', 'private.png', 'red')
        before, gallery = self.album_config(), self.gallery_json()
        with open(self.root_path(image['path']), 'rb') as source:
            self.mock_s3.put_object(Bucket='pub-bucket', Key=image['path'], Body=source.read())
        delete = self.mock_s3.delete_object
        def lose_response(Bucket, Key):
            delete(Bucket=Bucket, Key=Key)
            if Bucket == 'pub-bucket':
                raise OSError('public delete response lost')
        body = {'id': 'travel', 'enc': 'enc:album'}
        with mock.patch.object(self.mock_s3, 'delete_object', side_effect=lose_response):
            code, started = self.call_post('/api/album/lock_category', body=body)
            self.assertEqual(code, 200, started)
            self.assertEqual(self.wait_album_job(started['job'])['state'], 'error')
        self.assertEqual(self.album_config(), before)
        self.assertEqual(self.gallery_json(), gallery)
        self.assertIn(image['path'], self.mock_s3.buckets['pub-bucket'])
        for field in ('path', 'thumb', 'preview'):
            self.assertTrue(os.path.isfile(self.root_path(image[field])))
        code, started = self.call_post('/api/album/lock_category', body=body)
        self.assertEqual(code, 200, started)
        self.assertEqual(self.wait_album_job(started['job'])['state'], 'success')
        self.assertEqual(self.album_config(), [{'_enc': 'enc:album'}])
        self.assertNotIn(image['path'], self.mock_s3.buckets['pub-bucket'])
        for field in ('path', 'thumb', 'preview'):
            self.assertFalse(os.path.exists(self.root_path(image[field])))

    def test_40_media_regression_unlock_receipt_failure_preserves_private_backup(self):
        """解锁回执失败时回滚本地和公开侧；私有副本仅在外层提交成功后清理。"""
        image = self.upload_png('_notes', 'private.png', 'blue')
        self.add_node('private', '私密文章')
        self.cms('update', {'id': 'private', 'data': {'coverImage': image['path'], 'content': '正文'}})
        row = album_lock.rows_by_paths([image['path']])[0]
        tree = {'id': 'private', 'type': 'note', 'title': '私密文章', 'md': '正文',
                'coverImage': image['path'], 'coverRow': row}
        self.assertEqual(self.cms('lock', {'id': 'private', 'enc': 'enc:test', 'covers': [image['path']]})[0], 200)
        before, gallery = self.fetch_tree(), self.gallery_json()
        body = {'id': 'private', 'tree': tree,
                '_relay': {'source': 'https://relay.example', 'key': 'unlock-receipt'}}
        write_json = storage.write_json
        def fail_receipt(path, data):
            if path.endswith('.relay-receipts.json'):
                raise OSError('receipt failed')
            return write_json(path, data)
        with mock.patch.object(storage, 'write_json', side_effect=fail_receipt):
            self.assertEqual(self.cms('unlock', body)[0], 500)
        self.assertEqual(self.fetch_tree(), before)
        self.assertEqual(self.gallery_json(), gallery)
        for field in ('path', 'thumb', 'preview'):
            self.assertIn(image[field], self.mock_s3.buckets['priv-bucket'])
            self.assertFalse(os.path.exists(self.root_path(image[field])))
        self.assertNotIn(image['path'], self.mock_s3.buckets['pub-bucket'])
        self.assertFalse(os.path.exists(self.data_path('.relay-receipts.json')))
        delete = self.mock_s3.delete_object
        def committed_delete(Bucket, Key):
            if Bucket == 'priv-bucket':
                self.assertTrue(os.path.isfile(self.data_path('.relay-receipts.json')))
                self.assertNotIn('_enc', self.fetch_tree()['root'][0])
            delete(Bucket=Bucket, Key=Key)
        with mock.patch.object(self.mock_s3, 'delete_object', side_effect=committed_delete):
            self.assertEqual(self.cms('unlock', body)[0], 200)
        for field in ('path', 'thumb', 'preview'):
            self.assertNotIn(image[field], self.mock_s3.buckets['priv-bucket'])
            self.assertTrue(os.path.isfile(self.root_path(image[field])))
        self.assertEqual(self.cms('unlock', body)[0], 200, '回执重放不能重复解锁')

    def write_file(self, path, content):
        storage.write_bytes(path, content if isinstance(content, bytes) else content.encode('utf-8'))
        return path

    def test_01_cms_ignores_stale_cache_and_reads_external_json(self):
        self.add_node('n1', '原始标题')
        self._exec_sql(config.CMS_DB, "UPDATE nodes SET title='缓存错误'")
        self.assertEqual(self.fetch_tree()['root'][0]['title'], '原始标题')
        path = self.data_path('notes-tree.json')
        tree = self.load_json(path)
        tree['root'][0]['tags'] = ['外部更新']
        storage.write_json(path, tree)
        self.assertEqual(self.cms('update', {'id': 'n1', 'data': {'title': '新标题'}})[0], 200)
        self.assertEqual(self.fetch_tree()['root'][0]['tags'], ['外部更新'])

    def test_02_cms_cache_can_be_deleted_or_corrupted(self):
        self.add_node('n1', '缓存重建')
        source = self.load_json(self.data_path('notes-tree.json'))
        for corrupt in (False, True):
            os.remove(config.CMS_DB)
            if corrupt:
                self.write_file(config.CMS_DB, b'not a database')
            cms.rebuild_cache()
            with closing(sqlite3.connect(config.CMS_DB)) as connection:
                self.assertEqual(connection.execute('SELECT id FROM nodes').fetchone()[0], 'n1')
            self.assertEqual(self.load_json(self.data_path('notes-tree.json')), source)

    def test_03_cache_rebuild_updates_type_cover_and_deletions(self):
        self.add_node('n1', '第一篇')
        self.add_node('n2', '第二篇')
        storage.write_json(self.data_path('notes-tree.json'), {'root': [
            {'id': 'n1', 'type': 'locked', '_enc': 'enc:new-cipher', 'children': None}]})
        cms.rebuild_cache()
        with closing(sqlite3.connect(config.CMS_DB)) as connection:
            self.assertEqual(connection.execute('SELECT id,type,content,coverImage FROM nodes').fetchall(),
                             [('n1', 'locked', 'enc:new-cipher', None)])

    def test_04_gallery_rebuild_preserves_source_and_metadata(self):
        self.upload_png('travel', 'a.png', 'red')
        source = self.gallery_json()
        for corrupt in (False, True):
            os.remove(config.GALLERY_DB)
            if corrupt:
                self.write_file(config.GALLERY_DB, b'broken')
            photos.rebuild_cache()
            with closing(sqlite3.connect(config.GALLERY_DB)) as connection:
                rows = connection.execute('SELECT id,path,created_at FROM photos').fetchall()
            self.assertEqual(rows, [(source['travel'][0]['id'], source['travel'][0]['path'],
                                     source['travel'][0]['created_at'])])
            self.assertEqual(self.gallery_json(), source)

    def test_05_parallel_cms_updates_keep_every_change(self):
        for index in range(10):
            self.add_node(f'n{index}', f'文档{index}')
        def update(index):
            return self.cms('update', {'id': f'n{index}', 'data': {'tags': [f'tag{index}']}})[0]
        with ThreadPoolExecutor(max_workers=6) as pool:
            self.assertEqual(list(pool.map(update, range(10))), [200] * 10)
        nodes = {node['id']: node for node in self.fetch_tree()['root']}
        for index in range(10):
            self.assertEqual(nodes[f'n{index}']['tags'], [f'tag{index}'])

    def test_06_parallel_space_read_modify_write_keeps_all_items(self):
        def add(index):
            return space.add_collection({'id': str(index), 'title': f'收藏{index}'})
        with ThreadPoolExecutor(max_workers=6) as pool:
            self.assertTrue(all(pool.map(add, range(20))))
        self.assertEqual({row['id'] for row in space.load_collections()}, {str(i) for i in range(20)})

    def test_07_json_publish_failure_rolls_back_markdown_rename(self):
        self.add_node('n1', '原文件')
        self.cms('update', {'id': 'n1', 'data': {'content': '原正文'}})
        original = self.fetch_tree()
        replace = os.replace
        failed = False
        def fail_once(source, target):
            nonlocal failed
            if target.endswith('notes-tree.json') and not failed:
                failed = True
                raise OSError('simulated disk error')
            return replace(source, target)
        with mock.patch.object(storage.os, 'replace', side_effect=fail_once):
            code, _ = self.cms('update', {'id': 'n1', 'data': {'title': '新文件', 'content': '新正文'}})
        self.assertEqual(code, 500)
        self.assertEqual(self.fetch_tree(), original)
        with open(self.data_path('notes', '原文件.md'), encoding='utf-8') as source:
            self.assertEqual(source.read(), '原正文')
        self.assertFalse(os.path.exists(self.data_path('notes', '新文件.md')))

    def test_08_atomic_replace_failure_preserves_previous_snapshot(self):
        path = self.data_path('snapshot.json')
        storage.write_json(path, {'old': True})
        with mock.patch.object(storage.os, 'replace', side_effect=OSError('no space')):
            with self.assertRaises(OSError):
                storage.write_json(path, {'new': True})
        self.assertEqual(self.load_json(path), {'old': True})
        self.assertFalse(any(name.startswith('.maers-') for name in os.listdir(self.temp_data)))

    def test_09_invalid_snapshot_shapes_never_replace_data(self):
        cases = [('/api/save_modules', {}, config.MODULES_JSON_FILE),
                 ('/api/save_modules', [{'title': '缺少地址'}], config.MODULES_JSON_FILE),
                 ('/api/save_index_cards', [42], config.INDEX_CARDS_JSON),
                 ('/api/save_changelog', [{'date': 'bad', 'entries': []}], config.CHANGELOG_JSON),
                 ('/api/save_changelog', [{'date': '2026-10-26', 'entries': [42]}], config.CHANGELOG_JSON),
                 ('/api/space/save_tree', {'root': 'bad'}, config.SPACE_DATA)]
        for endpoint, body, path in cases:
            with self.subTest(endpoint=endpoint, body=body):
                storage.write_json(path, {'sentinel': True})
                self.assertEqual(self.call_post(endpoint, body=body)[0], 400)
                self.assertEqual(self.load_json(path), {'sentinel': True})

    def test_10_unknown_routes_methods_and_action_shapes(self):
        self.assertEqual(self.call_get('/api/does_not_exist')[0], 404)
        self.assertEqual(self.call_get('/api/space/save_tree')[0], 405)
        for action, body in [('add', {}), ('update', {'id': 'n', 'data': []}),
                             ('reorder', {'ids': [1]}), ('unknown', {})]:
            self.assertEqual(self.cms(action, body)[0], 400)
        self.assertEqual(self.call_post('/api/cms/save_tag_categories', {'module': ['../bad']}, [])[0], 400)

    def test_11_arbitrary_working_directory_is_safe(self):
        elsewhere = os.path.join(self.temp_root, 'unrelated')
        os.mkdir(elsewhere)
        previous = os.getcwd()
        try:
            os.chdir(elsewhere)
            self.add_node('n1', '绝对路径')
            self.upload_png('travel', 'a.png', 'blue')
            self.assertEqual(self.call_post('/api/ensure_page', body={'filename': 'new.html', 'title': '测试'})[0], 200)
            self.assertEqual(self.call_post('/api/save_music', body=[])[0], 200)
            self.assertTrue(os.path.isfile(self.root_path('new.html')))
            self.assertTrue(os.path.isfile(self.data_path('notes', '绝对路径.md')))
            self.assertEqual(os.listdir(elsewhere), [])
        finally:
            os.chdir(previous)

    def test_12_janitor_protects_source_references_without_cms_cache(self):
        self.add_node('n1', '有引用的正文')
        os.remove(config.CMS_DB)
        self.assertEqual(self.call_post('/api/admin/clean_data', body={})[0], 200)
        self.assertTrue(os.path.isfile(self.data_path('notes', '有引用的正文.md')))

    def test_13_corrupted_source_aborts_cleanup(self):
        path = self.write_file(self.data_path('notes', 'must-keep.md'), '正文')
        self.write_file(self.data_path('notes-tree.json'), '{broken')
        self.assertNotEqual(self.call_post('/api/admin/clean_data', body={})[0], 200)
        self.assertTrue(os.path.exists(path))

    def test_14_background_jobs_and_requests_share_lock(self):
        entered, release, saved = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def work(progress):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('Test timed out')
            return 200, {'status': 'success'}
        code, job = album_lock._start_job(0, work)
        self.assertEqual(code, 200)
        self.assertTrue(entered.wait(2))
        def save():
            cms.save_json(config.MODULES_JSON_FILE, [])
            saved.set()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(save)
            try:
                self.assertFalse(saved.wait(0.1))
                self.assertEqual(self.call_post('/api/album/job', body={'id': job['job']})[1]['state'], 'running')
            finally:
                release.set()
            pending.result(timeout=3)
        self.assertTrue(saved.is_set())

    def test_15_corrupt_sources_are_not_overwritten(self):
        valid_keyring = {'v': 1, 'dek_id': '0123456789abcdef',
                         'pw': {'salt': 'c2FsdA==', 'iter': 10000, 'wrap': 'enc:a'},
                         'rc': {'salt': 'c2FsdA==', 'iter': 10000, 'wrap': 'enc:b'}}
        cases = [('space-collections.json', '/api/space/add', {'id': 'new', 'title': '新增'}),
                 ('space-tree.json', '/api/space/update_tags', {'id': 'old', 'tags': []}),
                 ('crypto-keyring.json', '/api/crypto/keyring', valid_keyring)]
        for filename, endpoint, body in cases:
            with self.subTest(filename=filename):
                path = self.write_file(self.data_path(filename), '{broken')
                self.assertNotEqual(self.call_post(endpoint, body=body)[0], 200)
                with open(path, encoding='utf-8') as source:
                    self.assertEqual(source.read(), '{broken')

    def test_16_tag_category_failure_rolls_back_source_changes(self):
        self.add_node('n1', '标签回滚')
        self.cms('update', {'id': 'n1', 'data': {'tags': ['old']}})
        for module, strategy_type in [('notes', cms.cms_tags.CmsTagStrategy),
                                      ('photos-travel', cms.cms_other_tags.PhotosTagStrategy)]:
            if module.startswith('photos-'):
                self.upload_png('travel', 'a.png', 'green')
                photo_id = self.gallery_json()['travel'][0]['id']
                photos.update_tags(photo_id, ['old'])
            cms.save_tag_categories([{'name': '分类', 'tags': ['old']}], module)
            before = self.gallery_json() if module.startswith('photos-') else self.fetch_tree()
            with mock.patch.object(strategy_type, 'save_categories', side_effect=OSError('disk error')):
                self.assertEqual(self.call_post('/api/cms/rename_tag', {'module': [module]},
                                              {'old_name': 'old', 'new_name': 'new'})[0], 500)
            after = self.gallery_json() if module.startswith('photos-') else self.fetch_tree()
            self.assertEqual(before, after)
            self.assertEqual(cms.get_tag_categories(module)[0]['tags'], ['old'])

    def test_17_album_export_refreshes_external_gallery_changes(self):
        cms.save_json(config.ALBUM_CONFIG_JSON, [{'id': 'travel', 'title': '旅行'}])
        self.upload_png('travel', 'a.png', 'blue')
        source = self.gallery_json()
        source['travel'][0]['tags'] = ['外部更新']
        storage.write_json(self.data_path('photos-data.json'), source)
        code, result = album_lock.export_category('travel')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(result['photos'][0]['tags']), ['外部更新'])

    def test_18_legacy_folder_null_content_remains_editable(self):
        source = {'root': [{'id': 'f1', 'type': 'folder', 'title': '旧目录',
                            'content': None, 'tags': [], 'children': []}]}
        storage.write_json(self.data_path('notes-tree.json'), source)
        cms.rebuild_cache()
        self.assertEqual(self.fetch_tree(), source)
        self.assertEqual(self.cms('update', {'id': 'f1', 'data': {'title': '新目录'}})[0], 200)
        self.assertEqual(self.cms('add', {'parentId': 'f1', 'id': 'n1', 'type': 'note', 'title': '正文'})[0], 200)
        self.assertIsNone(self.fetch_tree()['root'][0]['content'])

    def test_19_locked_inline_media_survives_cleanup_and_unlock(self):
        from services import janitor
        image = self.upload_png('_notes', 'inline.png', 'red')
        row = self.gallery_json()['_notes'][0]
        keys = [image[field] for field in ('path', 'thumb', 'preview')]
        original = {key: open(self.root_path(key), 'rb').read() for key in keys}
        self.add_node('private', '私密插图')
        markdown = f'![插图]({image["thumb"]})'
        self.cms('update', {'id': 'private', 'data': {'content': markdown}})
        self.assertEqual(self.cms('lock', {'id': 'private', 'enc': 'enc:test', 'covers': []})[0], 400)
        self.assertEqual(self.cms('lock', {'id': 'private', 'enc': 'enc:test', 'covers': [image['path']]})[0], 200)
        for key in keys:
            self.assertFalse(os.path.exists(self.root_path(key)))
            self.assertIn(key, self.mock_s3.buckets['priv-bucket'])
        janitor.run_cleanup()
        self.assertTrue(all(key in self.mock_s3.buckets['priv-bucket'] for key in keys))
        packed = {'id': 'private', 'type': 'note', 'title': '私密插图', 'md': markdown, 'mediaRows': [row]}
        self.assertEqual(self.cms('unlock', {'id': 'private', 'tree': packed})[0], 200)
        for key in keys:
            with open(self.root_path(key), 'rb') as source:
                self.assertEqual(source.read(), original[key])
        self.assertEqual(self.gallery_json()['_notes'][0]['path'], image['path'])

    def test_20_shared_media_lock_is_rejected_without_deleting_public_files(self):
        image = self.upload_png('_notes', 'shared.png', 'green')
        for node_id in ('first', 'second'):
            self.add_node(node_id, node_id)
            self.cms('update', {'id': node_id, 'data': {'content': f'![shared]({image["path"]})'}})
        self.assertEqual(self.cms('lock', {'id': 'first', 'enc': 'enc:test', 'covers': [image['path']]})[0], 400)
        self.assertTrue(os.path.isfile(self.root_path(image['path'])))
        self.assertFalse(any(node.get('_enc') for node in self.fetch_tree()['root']))

    def test_21_legacy_ciphertext_conservatively_preserves_unknown_media(self):
        from services import janitor
        image = self.upload_png('_notes', 'legacy.png', 'blue')
        cms.save_module_tree('notes', {'root': [{'id': 'legacy', '_enc': 'enc:legacy', 'type': 'locked'}]})
        unknown = self.write_file(self.root_path('photos/thumbnails/_notes/unknown.webp'), b'legacy attachment')
        janitor.run_cleanup()
        self.assertTrue(os.path.isfile(unknown))
        self.assertTrue(os.path.isfile(self.root_path(image['thumb'])))
        self.assertEqual(self.gallery_json()['_notes'][0]['path'], image['path'])

    def test_22_media_paths_reject_traversal_and_poisoned_gallery_rows(self):
        target = self.write_file(self.root_path('outside.bin'), b'keep')
        for field in ('name', 'category'):
            for value in ('../outside.bin', '..\\outside.bin', 'C:\\outside.bin', '/outside.bin', '..', 'NUL'):
                body = {'category': 'arch', 'path': 'unused', 'name': 'safe.jpg', field: value}
                with self.subTest(field=field, value=value):
                    self.assertEqual(self.call_post('/api/photos/register_r2', body=body)[0], 400)
        self.assertEqual(self.call_post('/upload', {'category': ['../escape']}, file_data=b'image')[0], 400)
        poisoned = {'id': 'bad', 'name': 'bad', 'path': 'photos/images/arch/../../../outside.bin'}
        storage.write_json(self.data_path('photos-data.json'), {'arch': [poisoned]})
        self.assertEqual(self.call_post('/delete', body={'path': poisoned['path']})[0], 400)
        with open(target, 'rb') as source:
            self.assertEqual(source.read(), b'keep')

    def test_23_delete_publish_failure_restores_all_files_and_source(self):
        image = self.upload_png('travel', 'keep.png', 'blue')
        before = self.gallery_json()
        keys = [image[field] for field in ('path', 'thumb', 'preview')]
        with mock.patch.object(photos, 'sync_gallery_js', side_effect=OSError('publish failed')):
            self.assertEqual(self.call_post('/delete', body={'path': image['path']})[0], 500)
        self.assertEqual(self.gallery_json(), before)
        self.assertTrue(all(os.path.isfile(self.root_path(key)) for key in keys))
        with closing(photos.get_db()) as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM photos').fetchone()[0], 1)
        remove = storage.remove
        def fail_second(path):
            if path.endswith('.webp'):
                raise OSError('remove failed')
            remove(path)
        with mock.patch.object(storage, 'remove', side_effect=fail_second):
            self.assertEqual(self.call_post('/delete', body={'path': image['path']})[0], 500)
        self.assertTrue(all(os.path.isfile(self.root_path(key)) for key in keys))
        self.assertEqual(self.gallery_json(), before)
        photos.DISABLE_R2_SYNC = False
        with mock.patch('threading.Thread') as thread, mock.patch.object(photos, 'sync_gallery_js', side_effect=OSError('full')):
            self.assertEqual(self.call_post('/delete', body={'path': image['path']})[0], 500)
            thread.assert_not_called()

    def test_24_relay_receipts_are_durable_and_reject_key_reuse(self):
        body = {'id': 'relay-note', 'parentId': 'root', 'type': 'note', 'title': '中继正文',
                '_relay': {'source': 'https://relay.example', 'key': 'sync_1'}}
        first = self.cms('add', body)
        self.assertEqual(first[0], 200)
        self.assertTrue(os.path.isfile(self.data_path('.relay-receipts.json')))
        with mock.patch.object(cms.cms_nodes, 'add_node', side_effect=AssertionError('must not replay')):
            self.assertEqual(self.cms('add', body), first)
        self.assertEqual(self.cms('add', {**body, 'title': '另一个操作'})[0], 409)
        self.assertEqual(len(self.fetch_tree()['root']), 1)

    def test_25_receipt_publish_failure_rolls_back_note_before_retry(self):
        body = {'id': 'retry', 'parentId': 'root', 'type': 'note', 'title': '回执回滚',
                '_relay': {'source': 'https://relay.example', 'key': 'sync_2'}}
        write_json = storage.write_json
        def fail_receipt(path, value):
            if path.endswith('.relay-receipts.json'):
                raise OSError('receipt disk full')
            return write_json(path, value)
        with mock.patch.object(storage, 'write_json', side_effect=fail_receipt):
            self.assertEqual(self.cms('add', body)[0], 500)
        self.assertEqual(self.fetch_tree()['root'], [])
        self.assertFalse(os.path.exists(self.data_path('notes', '回执回滚.md')))
        self.assertEqual(self.cms('add', body)[0], 200)

    def test_26_shared_cover_survives_note_delete_and_cover_removal(self):
        from services import janitor
        image = self.upload_png('_notes', 'shared.png', 'red')
        for node_id in ('first', 'second'):
            self.add_node(node_id, node_id)
            self.assertEqual(self.cms('update', {'id': node_id, 'data': {'coverImage': image['path']}})[0], 200)
        self.assertEqual(self.cms('delete', {'id': 'first'})[0], 200)
        janitor.run_cleanup()
        for field in ('path', 'thumb', 'preview'):
            self.assertTrue(os.path.isfile(self.root_path(image[field])))
        self.add_node('third', 'third')
        self.cms('update', {'id': 'third', 'data': {'coverImage': image['path']}})
        self.assertEqual(self.cms('update', {'id': 'second', 'data': {'coverImage': None}})[0], 200)
        janitor.run_cleanup()
        self.assertTrue(os.path.isfile(self.root_path(image['thumb'])))
        self.cms('update', {'id': 'third', 'data': {'coverImage': None}})
        janitor.run_cleanup()
        self.assertFalse(os.path.exists(self.root_path(image['thumb'])))

    def test_27_lock_public_delete_failure_restores_note_and_allows_retry(self):
        image = self.upload_png('_notes', 'lock.png', 'blue')
        self.add_node('private', '可重试加锁')
        self.cms('update', {'id': 'private', 'data': {'coverImage': image['path'], 'content': '正文'}})
        before_tree, before_gallery = self.fetch_tree(), self.gallery_json()
        body = {'id': 'private', 'enc': 'enc:test', 'covers': [image['path']]}
        with mock.patch.object(self.mock_s3, 'delete_object', side_effect=OSError('public delete failed')):
            self.assertEqual(self.cms('lock', body)[0], 500)
        self.assertEqual(self.fetch_tree(), before_tree)
        self.assertEqual(self.gallery_json(), before_gallery)
        with open(self.data_path('notes', '可重试加锁.md'), encoding='utf-8') as source:
            self.assertEqual(source.read(), '正文')
        for field in ('path', 'thumb', 'preview'):
            self.assertTrue(os.path.isfile(self.root_path(image[field])))
        self.assertEqual(self.cms('lock', body)[0], 200)

    def test_28_lock_partial_remote_delete_and_publish_failure_restore_public_state(self):
        images = [self.upload_png('_notes', 'a.png', 'red'), self.upload_png('_notes', 'b.png', 'green')]
        for image in images:
            with open(self.root_path(image['path']), 'rb') as source:
                self.mock_s3.put_object(Bucket='pub-bucket', Key=image['path'], Body=source.read())
        self.add_node('private', '部分迁移')
        self.cms('update', {'id': 'private', 'data': {'content': '\n'.join(f'![x]({image["path"]})' for image in images)}})
        body = {'id': 'private', 'enc': 'enc:test', 'covers': [image['path'] for image in images]}
        before_tree, before_gallery = self.fetch_tree(), self.gallery_json()
        delete = self.mock_s3.delete_object
        def fail_second(Bucket, Key):
            if Bucket == 'pub-bucket' and Key == images[1]['path']:
                raise OSError('second delete failed')
            return delete(Bucket=Bucket, Key=Key)
        with mock.patch.object(self.mock_s3, 'delete_object', side_effect=fail_second):
            self.assertEqual(self.cms('lock', body)[0], 500)
        for image in images:
            self.assertIn(image['path'], self.mock_s3.buckets['pub-bucket'])
        self.assertEqual(self.fetch_tree(), before_tree)
        self.assertEqual(self.gallery_json(), before_gallery)
        with mock.patch.object(photos, 'sync_gallery_js', side_effect=OSError('gallery publish failed')):
            self.assertEqual(self.cms('lock', body)[0], 500)
        self.assertEqual(self.fetch_tree(), before_tree)
        self.assertEqual(self.gallery_json(), before_gallery)
        for image in images:
            for field in ('path', 'thumb', 'preview'):
                self.assertTrue(os.path.isfile(self.root_path(image[field])))
        self.assertEqual(self.cms('lock', body)[0], 200)

    def test_29_janitor_keeps_encoded_relative_and_cdn_media_references(self):
        from services import janitor
        from urllib.parse import quote
        image = self.upload_png('_notes', 'encoded.png', 'blue')
        self.add_node('encoded', '编码引用')
        for reference in (image['path'].replace('_notes', '%5Fnotes'),
                          '../' + image['path'] + '?v=1#image',
                          'https://media.example.com/' + image['thumb'].replace('_notes', '%5Fnotes')):
            self.cms('update', {'id': 'encoded', 'data': {'content': f'![x]({reference})'}})
            janitor.run_cleanup()
            self.assertTrue(os.path.isfile(self.root_path(image['path'])), reference)
            self.assertTrue(os.path.isfile(self.root_path(image['thumb'])), reference)
        named = self.write_file(self.root_path('photos/images/_notes/图片 空格.png'), b'image')
        self.cms('update', {'id': 'encoded', 'data': {'content': f'![x]({quote("photos/images/_notes/图片 空格.png")})'}})
        janitor.run_cleanup()
        self.assertTrue(os.path.isfile(named))
        literal = self.write_file(self.root_path('photos/images/_notes/literal%20.png'), b'literal percent')
        self.cms('update', {'id': 'encoded', 'data': {'content': '![x](photos/images/_notes/literal%2520.png)'}})
        janitor.run_cleanup()
        self.assertTrue(os.path.isfile(literal), 'URL 只能解码一次')

    def test_30_cloud_registration_downloads_under_desktop_import_layout(self):
        from .helpers import make_test_png_bytes
        image = make_test_png_bytes('blue')
        body = {'category': 'travel', 'path': 'photos/images/travel/cloud.png', 'name': 'cloud.png'}
        self.mock_s3.put_object(Bucket='pub-bucket', Key=body['path'], Body=image)
        with mock.patch.object(self.mock_s3, 'get_object', wraps=self.mock_s3.get_object) as request:
            code, result = self.call_post('/api/photos/register', body=body)
        self.assertEqual(code, 200, result)
        request.assert_called_once()
        for field in ('path', 'thumb', 'preview'):
            self.assertTrue(os.path.isfile(self.root_path(result[field])))
        self.assertTrue(self.gallery_json()['travel'][0]['hash'])

    def test_31_cloud_registration_failure_keeps_relay_unacknowledged_and_retries(self):
        from .helpers import make_test_png_bytes
        body = {'category': 'travel', 'path': 'photos/images/travel/retry.png', 'name': 'retry.png',
                '_relay': {'source': 'https://relay.example', 'key': 'cloud-retry'}}
        self.assertEqual(self.call_post('/api/photos/register', body=body)[0], 500)
        self.assertFalse(os.path.exists(self.data_path('.relay-receipts.json')))
        self.assertEqual(self.gallery_json(), {})
        self.mock_s3.put_object(Bucket='pub-bucket', Key=body['path'], Body=make_test_png_bytes('red'))
        code, result = self.call_post('/api/photos/register', body=body)
        self.assertEqual(code, 200, result)
        self.assertTrue(os.path.isfile(self.root_path(result['thumb'])))
        self.assertTrue(os.path.isfile(self.data_path('.relay-receipts.json')))

    def test_32_registration_derivative_failure_restores_files_and_can_retry(self):
        from .helpers import make_test_png_bytes
        original = self.write_file(self.root_path('photos/images/travel/local.png'), make_test_png_bytes('red'))
        body = {'category': 'travel', 'name': 'local.png', 'path': 'photos/images/travel/local.png',
                '_relay': {'source': 'https://relay.example', 'key': 'derive-retry'}}
        write_bytes = storage.write_bytes
        def fail_preview(path, data):
            if path.endswith('.avif'):
                raise OSError('preview disk error')
            return write_bytes(path, data)
        with mock.patch.object(storage, 'write_bytes', side_effect=fail_preview):
            self.assertEqual(self.call_post('/api/photos/register_r2', body=body)[0], 500)
        self.assertTrue(os.path.isfile(original))
        self.assertFalse(os.path.exists(self.data_path('.relay-receipts.json')))
        self.assertEqual(os.listdir(self.root_path('photos/thumbnails/travel')), [],
                         '衍生图发布失败不能遗留任何新缩略图')
        self.assertEqual(self.call_post('/api/photos/register_r2', body=body)[0], 200)

    def test_33_lock_receipt_failure_compensates_remote_deletes(self):
        image = self.upload_png('_notes', 'receipt.png', 'blue')
        self.add_node('private', '加锁回执失败')
        self.cms('update', {'id': 'private', 'data': {'coverImage': image['path'], 'content': '正文'}})
        before_tree, before_gallery = self.fetch_tree(), self.gallery_json()
        body = {'id': 'private', 'enc': 'enc:test', 'covers': [image['path']],
                '_relay': {'source': 'https://relay.example', 'key': 'lock-receipt'}}
        write_json = storage.write_json
        def fail_receipt(path, data):
            if path.endswith('.relay-receipts.json'):
                raise OSError('receipt failed')
            return write_json(path, data)
        with mock.patch.object(storage, 'write_json', side_effect=fail_receipt):
            self.assertEqual(self.cms('lock', body)[0], 500)
        self.assertEqual(self.fetch_tree(), before_tree)
        self.assertEqual(self.gallery_json(), before_gallery)
        self.assertIn(image['path'], self.mock_s3.buckets['pub-bucket'])
        for field in ('path', 'thumb', 'preview'):
            self.assertTrue(os.path.isfile(self.root_path(image[field])))
        self.assertEqual(self.cms('lock', body)[0], 200)

    def test_34_lock_retries_from_private_backup_when_public_restore_failed(self):
        image = self.upload_png('_notes', 'recovery.png', 'green')
        with open(self.root_path(image['path']), 'rb') as source:
            self.mock_s3.put_object(Bucket='pub-bucket', Key=image['path'], Body=source.read())
        os.remove(self.root_path(image['path']))
        self.add_node('private', '私有副本重试')
        self.cms('update', {'id': 'private', 'data': {'coverImage': image['path']}})
        body = {'id': 'private', 'enc': 'enc:test', 'covers': [image['path']]}
        before = self.fetch_tree()
        delete, put = self.mock_s3.delete_object, self.mock_s3.put_object
        def lose_delete_response(Bucket, Key):
            delete(Bucket=Bucket, Key=Key)
            raise OSError('delete response lost')
        def reject_restore(Bucket, **kwargs):
            if Bucket == 'pub-bucket':
                raise OSError('public restore unavailable')
            return put(Bucket=Bucket, **kwargs)
        with mock.patch.object(self.mock_s3, 'delete_object', side_effect=lose_delete_response), \
                mock.patch.object(self.mock_s3, 'put_object', side_effect=reject_restore):
            self.assertEqual(self.cms('lock', body)[0], 500)
        from services import storage_journal
        self.assertTrue(storage_journal.pending())
        self.assertEqual(self.fetch_tree(), before)
        self.assertFalse(storage_journal.pending(), '读取前必须完成持久化补偿')
        self.assertTrue(image['path'] in self.mock_s3.buckets['priv-bucket'])
        self.assertTrue(image['path'] in self.mock_s3.buckets['pub-bucket'])
        self.assertEqual(self.cms('lock', body)[0], 200)

    def test_35_janitor_keeps_literal_hash_and_percent_markdown_paths(self):
        from services import janitor
        titles = ['C#入门', 'URL%20编码', '百分号%23与#井号']
        for index, title in enumerate(titles):
            self.add_node(f'special-{index}', title)
            self.cms('update', {'id': f'special-{index}', 'data': {'content': f'正文 {title}'}})
        before = self.fetch_tree()
        orphans = [self.write_file(self.data_path('notes', name), '真实孤儿')
                   for name in ('C.md', 'URL 编码.md', '未引用.md')]
        for _ in range(2):
            janitor.run_cleanup()
            self.assertEqual(self.fetch_tree(), before)
            for title in titles:
                with open(self.data_path('notes', title + '.md'), encoding='utf-8') as source:
                    self.assertEqual(source.read(), f'正文 {title}')
        self.assertTrue(all(not os.path.exists(path) for path in orphans))

    def test_36_janitor_keeps_literal_gallery_paths_in_all_three_tiers(self):
        from services import janitor
        rows = []
        originals = {}
        for index, name in enumerate(('literal%20', 'C#相片', '图片%23', 'literal%2520')):
            row = {'id': f'literal-{index}', 'name': name + '.png',
                   'path': f'photos/images/travel/{name}.png',
                   'thumb': f'photos/thumbnails/travel/{name}.webp',
                   'preview': f'photos/previews/travel/{name}.avif'}
            rows.append(row)
            for field in ('path', 'thumb', 'preview'):
                key = row[field]
                originals[key] = key.encode('utf-8')
                self.write_file(self.root_path(key), originals[key])
        storage.write_json(self.data_path('photos-data.json'), {'travel': rows})
        orphan = self.write_file(self.root_path('photos/images/travel/unreferenced.png'), b'orphan')
        for _ in range(2):
            janitor.run_cleanup()
            self.assertEqual([row['path'] for row in self.gallery_json()['travel']], [row['path'] for row in rows])
            for key, expected in originals.items():
                with open(self.root_path(key), 'rb') as source:
                    self.assertEqual(source.read(), expected)
        self.assertFalse(os.path.exists(orphan))

    def test_37_janitor_distinguishes_literal_cover_paths_from_encoded_body_urls(self):
        from services import janitor
        cover = self.write_file(self.root_path('photos/images/_notes/封面#literal%20.png'), b'cover')
        body_image = self.write_file(self.root_path('photos/images/_notes/body%20.png'), b'body')
        orphan = self.write_file(self.root_path('photos/images/_notes/body .png'), b'orphan')
        self.add_node('special', '封面与链接')
        self.cms('update', {'id': 'special', 'data': {
            'coverImage': 'photos/images/_notes/封面#literal%20.png',
            'content': '![正文](photos/images/%5Fnotes/body%2520.png?v=1#preview)'}})
        janitor.run_cleanup()
        self.assertTrue(os.path.isfile(cover))
        self.assertTrue(os.path.isfile(body_image))
        self.assertFalse(os.path.exists(orphan))

    def test_38_janitor_keeps_config_file_keys_and_decodes_explicit_remote_urls(self):
        from services import janitor
        paths = ['photos/images/_notes/music#literal%20.png',
                 'photos/images/_notes/tag#literal%20.png',
                 'photos/images/_notes/space#literal%20.png',
                 'photos/images/_notes/remote literal.png']
        for key in paths:
            self.write_file(self.root_path(key), b'config image')
        storage.write_json(config.MUSIC_DATA, [{'cover': paths[0],
            'remote': 'https://media.example.com/photos/images/%5Fnotes/remote%20literal.png?v=1#preview'}])
        storage.write_json(self.data_path('tags', 'cms-notes-tag-categories.json'),
                           [{'name': '分类', 'tags': [], 'cover': paths[1]}])
        storage.write_json(config.SPACE_DATA, {'root': [{'id': 'icon', 'icon': paths[2]}]})
        for _ in range(2):
            janitor.run_cleanup()
            self.assertTrue(all(os.path.isfile(self.root_path(key)) for key in paths))
