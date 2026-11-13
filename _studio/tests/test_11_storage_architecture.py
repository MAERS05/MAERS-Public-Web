"""数据架构回归：真源优先、缓存重建、并发串行化、失败回滚与独立工作目录。"""

import json
import os
import sqlite3
import threading
import unittest
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from unittest import mock

from .helpers import make_test_png_bytes
from .sandbox import MockS3Client, SandboxTestCase, cms, photos, album_lock, config
from services import local_media
from services import data_safety, storage, media_store
from services.media_store import get_store as configured_media_store


class Test11_StorageArchitecture(SandboxTestCase):

    def test_bucket_group_names_and_removal_preserve_storage_targets(self):
        def target(bucket):
            return {'provider': 'r2', 'endpoint_url': f'https://{"a" * 32}.r2.cloudflarestorage.com',
                    'bucket_name': bucket, 'access_key_id': 'id', 'secret_access_key': 'secret'}

        settings = {'public': target('pub-bucket'), 'private': target('priv-bucket'),
                    'bucket_groups': {'archive': {'public': target('public-extra'), 'private': target('private-extra')}}}
        path = Path(self.root_path('_studio/tools/media_config.json'))
        storage.write_json(path, settings)
        endpoint = '/api/storage/group'
        with (mock.patch.object(media_store, 'get_store', configured_media_store),
              mock.patch('boto3.client', return_value=self.mock_s3)):
            for identity, name in [('default', '主存储'), ('archive', '归档')]:
                code, result = self.call_post(endpoint, body={'id': identity, 'action': 'rename', 'name': name})
                self.assertEqual(code, 200, result)
                self.assertEqual(next(row['name'] for row in result['groups'] if row['id'] == identity), name)
            stored = self.load_json(path)
            self.assertEqual(stored['bucket_groups'], settings['bucket_groups'])
            self.assertEqual(stored['public'], settings['public'])
            self.assertEqual(self.call_post(endpoint, body={'id': 'default', 'action': 'delete'})[0], 400)
            self.assertEqual(self.call_post(endpoint, body={'id': 'archive', 'action': 'rename', 'name': ' '})[0], 400)

            storage.write_json(path, {**stored, 'content_bucket': 'archive'})
            self.assertEqual(self.call_post(endpoint, body={'id': 'archive', 'action': 'delete'})[0], 400)
            storage.write_json(path, stored)
            self.mock_s3.put_object(Bucket='public-extra', Key='photos/images/x/a.png', Body=b'photo')
            self.assertEqual(self.call_post(endpoint, body={'id': 'archive', 'action': 'delete'})[0], 400)
            self.mock_s3.delete_object(Bucket='public-extra', Key='photos/images/x/a.png')
            route = media_store._route_key('photos/images/x/a.png')
            self.mock_s3.put_object(Bucket='priv-bucket', Key=route, Body=json.dumps({'bucketId': 'archive'}).encode())
            self.assertEqual(self.call_post(endpoint, body={'id': 'archive', 'action': 'delete'})[0], 400)
            self.mock_s3.delete_object(Bucket='priv-bucket', Key=route)
            jobs = Path(self.root_path('_studio/.local/media-outbox.json'))
            storage.write_json(jobs, [{'bucketId': 'archive'}])
            self.assertEqual(self.call_post(endpoint, body={'id': 'archive', 'action': 'delete'})[0], 400)
            storage.write_json(jobs, [])
            self.assertEqual(self.call_post(endpoint, body={'id': 'archive', 'action': 'delete'})[0], 200)
            self.assertEqual(self.load_json(path)['bucket_groups'], {})
            self.assertEqual(self.load_json(path)['bucket_group_names'], {'default': '主存储'})

    def test_storage_settings_save_groups_and_keep_credentials_out_of_reads(self):
        """本机设置支持从空配置新增桶组，旧桶和密钥在编辑时保留。"""
        config_path = Path(self.root_path('_studio/tools/media_config.json'))
        site_path = Path(self.root_path('custom/config.js'))
        storage.write_text(site_path, "window.MAERS.Config = {\n    MEDIA_PUBLIC_BASE: '',\n    CONTENT_PUBLIC_BASE: ''\n};\n")
        path = '/api/storage/config'
        self.assertEqual(self.call_get(path)[1]['groups'], [{'id': 'default', 'name': 'default'}])

        def target(name, account='a'):
            return {'provider': 'r2', 'endpoint_url': f'https://{account * 32}.r2.cloudflarestorage.com',
                    'bucket_name': name, 'access_key_id': f'key-{account}', 'secret_access_key': f'secret-{name}'}

        default = {'id': 'default', 'create': False, 'public': target('main-public'), 'private': target('main-private')}
        added = {'id': 'archive', 'create': True, 'public': target('archive-public', 'b'),
                 'private': target('archive-private', 'b')}
        site = {'MEDIA_PUBLIC_BASE': 'https://images.example.com', 'CONTENT_PUBLIC_BASE': 'https://docs.example.com'}
        with (mock.patch.object(media_store, 'get_store', configured_media_store),
              mock.patch('boto3.client', return_value=self.mock_s3)):
            self.assertEqual(self.call_post(path, body=added)[0], 400)
            self.assertFalse(config_path.exists())
            code, result = self.call_post(path, body=default)
            self.assertEqual(code, 400, result)
            self.assertEqual(result['error'], '公开图片地址不能为空')
            self.assertFalse(config_path.exists())
            self.assertEqual(self.call_post(path, body={**default, 'site': site})[0], 200)
            oversized = {**added, 'private': {**added['private'], 'secret_access_key': 's' * 5_000}}
            code, result = self.call_post(path, body=oversized)
            self.assertEqual(code, 400, result)
            self.assertIn('5 KB', result['error'])
            self.assertEqual([row['id'] for row in self.call_get(path)[1]['groups']], ['default'])
            code, result = self.call_post(path, body=added)
            self.assertEqual(code, 200, result)
            self.assertEqual([row['id'] for row in result['groups']], ['default', 'archive'])
            self.assertEqual(result['site'], site)
            self.assertNotIn('secret-', json.dumps(result))
            self.assertNotIn('key-a', json.dumps(result))
            self.assertEqual(self.call_post(path, body=added)[0], 400)
            for name, label in (('MEDIA_PUBLIC_BASE', '公开图片地址'), ('CONTENT_PUBLIC_BASE', '公开正文地址')):
                code, result = self.call_post(path, body={**default, 'site': {name: ''}})
                self.assertEqual(code, 400, result)
                self.assertEqual(result['error'], f'{label}不能为空')
            self.assertEqual(self.call_get(path)[1]['site'], site)

            edit = {**added, 'create': False, 'contentBucket': 'archive'}
            destinations = {'public_content': 'archive', 'private_content': 'default',
                            'public_photo': 'default', 'private_photo': 'archive'}
            edit['writeBuckets'] = destinations
            for scope in ('public', 'private'):
                edit[scope] = {**edit[scope], 'access_key_id': '', 'secret_access_key': ''}
            self.assertEqual(self.call_post(path, body=edit)[0], 200)
            self.assertEqual(self.call_get('/api/storage/buckets')[1],
                             {'buckets': ['default', 'archive'], 'contentBucket': 'archive'})
            stored = self.load_json(config_path)
            self.assertEqual(stored['bucket_groups']['archive']['private'], added['private'])
            self.assertEqual(stored['public'], default['public'])
            wrong = {**edit, 'public': {**edit['public'], 'bucket_name': 'another-bucket'}}
            self.assertEqual(self.call_post(path, body=wrong)[0], 400)
            self.assertEqual(self.call_post(path, body={**edit, 'metadataBucket': 'archive'})[0], 400)
            self.assertEqual(self.load_json(config_path), stored)
            self.assertEqual(self.call_get(path)[1]['metadataBucket'], 'default')
            self.assertNotIn('metadata_bucket', stored)
            self.assertEqual(self.call_get(path)[1]['writeBuckets'], destinations)
            code, result = self.call_post('/api/storage/worker-setting', body={'name': 'MEDIA_BUCKET_GROUPS'})
            self.assertEqual(code, 200, result)
            self.assertEqual(json.loads(result['value']), stored['bucket_groups'])
            self.assertEqual(self.call_get(path)[1]['workerBucketGroups'],
                             {'bytes': len(result['value'].encode('utf-8')), 'limit': 5_000})
            code, result = self.call_post(path, body={**edit, 'private': {
                **edit['private'], 'secret_access_key': 's' * 5_000}})
            self.assertEqual(code, 400, result)
            self.assertIn('5 KB', result['error'])
            self.assertEqual(self.load_json(config_path), stored)
            code, result = self.call_post('/api/storage/worker-setting', body={'name': 'MEDIA_PHOTO_BUCKETS'})
            self.assertEqual(code, 200, result)
            self.assertEqual(json.loads(result['value']), {'public': 'default', 'private': 'archive'})

    def test_storage_settings_rotate_legacy_credentials_without_repointing_default(self):
        """旧的共用密钥配置支持按桶改密钥，默认位置的标识保持一致。"""
        endpoint = 'https://s3.us-west-004.backblazeb2.com'
        initial = {'provider': 'b2', 'endpoint_url': endpoint, 'access_key_id': 'old-id',
                   'secret_access_key': 'old-secret', 'public_bucket_name': 'old-public', 'private_bucket_name': 'old-private'}
        storage.write_json(self.root_path('_studio/tools/media_config.json'), initial)
        path = '/api/storage/config'
        with (mock.patch.object(media_store, 'get_store', configured_media_store),
              mock.patch('boto3.client', return_value=self.mock_s3)):
            original = configured_media_store().identity()
            group, = self.call_get(path)[1]['groups']
            group.update(create=False)
            group['private']['access_key_id'] = 'new-id'
            self.assertEqual(self.call_post(path, body=group)[0], 400)
            group['private']['secret_access_key'] = 'new-secret'
            self.assertEqual(self.call_post(path, body=group)[0], 200)
            self.assertEqual(configured_media_store().identity(), original)
            config = media_store.load_config()
            self.assertEqual(config['public']['secret_access_key'], 'old-secret')
            self.assertEqual(config['private']['secret_access_key'], 'new-secret')
            self.assertNotIn('secret_access_key', config)

    def test_additional_media_bucket_survives_backup_and_keeps_old_paths(self):
        """换桶仅改变新对象的写入位置，备份恢复保留原路径与私密归属。"""
        def target(account, name):
            return {'provider': 'r2', 'endpoint_url': f'https://{account * 32}.r2.cloudflarestorage.com',
                    'bucket_name': name, 'access_key_id': account, 'secret_access_key': 'fixture'}

        config = {'public': target('a', 'pub-bucket'), 'private': target('a', 'priv-bucket'),
                  'bucket_groups': {'archive': {'public': target('b', 'public-extra'),
                                                'private': target('b', 'private-extra')}},
                  'write_buckets': {'public_photo': 'archive', 'private_photo': 'archive'}}
        old = 'photos/images/travel/old.png'
        new = 'photos/images/travel/new.png'
        route = media_store._route_key(new)
        with mock.patch('boto3.client', return_value=self.mock_s3):
            with self.assertRaisesRegex(ValueError, '默认私密桶'):
                configured_media_store({**config, 'metadata_bucket': 'archive'})
            store = configured_media_store(config)
            store.write('public', old, b'old')
            store.claim_bucket(new, 'archive')
            store.write('private', new, b'private')
            self.assertEqual(store.bucket_id(old), 'default')
            self.assertEqual(store.bucket_id(new), 'archive')
            self.assertIn(route, self.mock_s3.buckets['priv-bucket'])
            self.assertNotIn(route, self.mock_s3.buckets['private-extra'])
            self.assertEqual(store.read('public', old), b'old')
            self.assertFalse(store.exists('public', new))
            with (mock.patch.object(media_store, 'get_store', return_value=store),
                  mock.patch.object(media_store, 'load_config', return_value=config),
                  mock.patch.object(photos, 'DISABLE_R2_SYNC', False)):
                code, uploaded = self.call_post('/upload', {'category': ['travel'], 'name': ['picked.png']},
                                                file_data=make_test_png_bytes('red'))
                self.assertEqual(code, 200, uploaded)
                self.assertEqual(self.gallery_json()['travel'][0]['bucketId'], 'archive')
                for field in ('path', 'thumb', 'preview'):
                    self.assertIn(uploaded[field], self.mock_s3.buckets['public-extra'])
                from services import private_photos
                with storage.transaction():
                    private = private_photos.store_image('travel', make_test_png_bytes('green'), 'private.png')
                self.assertEqual(private['bucketId'], 'archive')
                for field in ('path', 'thumb', 'preview'):
                    self.assertIn(private[field], self.mock_s3.buckets['private-extra'])
                cloud = 'photos/images/travel/cloud.png'
                store.claim_bucket(cloud, 'archive')
                store.write('public', cloud, make_test_png_bytes('blue'))
                with mock.patch.object(self.mock_s3, 'put_object', wraps=self.mock_s3.put_object) as put:
                    code, registered = self.call_post('/api/photos/register', body={
                        'category': 'travel', 'name': 'cloud.png', 'path': cloud, 'bucketId': 'archive'
                    })
                    self.assertEqual(code, 200, registered)
                    self.assertEqual(registered['path'], cloud)
                    self.assertEqual({call.kwargs['Key'] for call in put.call_args_list
                                      if call.kwargs['Bucket'] == 'public-extra'},
                                     {registered['thumb'], registered['preview']})
                backup = data_safety.create_backup('cloud')
                store.delete('private', new)
                store.delete_policy(route)
                data_safety.restore_backup(backup['id'])
            self.assertEqual(store.read('private', new), b'private')
            self.assertNotIn(new, self.mock_s3.buckets['priv-bucket'])


    def test_split_media_accounts_route_content_images_and_policies_by_scope(self):
        public = {'provider': 'r2', 'endpoint_url': f"https://{'a' * 32}.r2.cloudflarestorage.com",
                  'bucket_name': 'pub-bucket', 'access_key_id': 'public-id', 'secret_access_key': 'public-secret'}
        private = {'provider': 'b2', 'endpoint_url': 'https://s3.us-west-004.backblazeb2.com',
                   'bucket_name': 'priv-bucket', 'access_key_id': 'private-id', 'secret_access_key': 'private-secret'}
        private_client = MockS3Client()
        with mock.patch('boto3.client', side_effect=[self.mock_s3, private_client]) as connect:
            store = configured_media_store({'public': public, 'private': private})
        self.assertEqual([(call.kwargs['region_name'], call.kwargs['aws_access_key_id']) for call in connect.call_args_list],
                         [('auto', 'public-id'), ('us-west-004', 'private-id')])

        key = 'photos/images/travel/photo.png'
        policy = '_maers/private-token.json'
        store.write('public', key, b'public')
        store.write('private', key, b'private')
        local_media.keep(key, b'private')
        store.write_policy(policy, b'token')
        store.write_content('markdown/notes/note.md', b'public note')
        self.assertEqual(store.read('public', key), b'public')
        self.assertEqual(store.read_private(key), b'private')
        self.assertEqual(store.read_policy(policy), b'token')
        self.assertEqual(set(store.keys('private', include_policies=True)), {key, policy})
        self.assertEqual(store.content_keys(), ['markdown/notes/note.md'])
        self.assertFalse(self.mock_s3.buckets['priv-bucket'])
        self.assertFalse(private_client.buckets['pub-bucket'])

        with (mock.patch.object(private_client, 'get_paginator') as versions,
              mock.patch.object(private_client, 'delete_object') as delete):
            versions.return_value.paginate.return_value = [{'Versions': [{'Key': key, 'VersionId': 'old'}]}]
            store.delete('private', key)
        versions.assert_called_once_with('list_object_versions')
        delete.assert_called_once_with(Bucket='priv-bucket', Key=key, VersionId='old')
        self.assertTrue(local_media.path(key).exists())
        self.assertTrue(store.exists('public', key))

    def test_split_media_targets_keep_legacy_identity_and_reject_bucket_aliases(self):
        endpoint = f"https://{'a' * 32}.r2.cloudflarestorage.com"
        public = {'provider': 'r2', 'endpoint_url': endpoint, 'bucket_name': 'pub-bucket',
                  'access_key_id': 'id', 'secret_access_key': 'secret'}
        private = {**public, 'bucket_name': 'priv-bucket', 'access_key_id': 'other'}
        with mock.patch('boto3.client', return_value=self.mock_s3):
            legacy = configured_media_store({**public, 'private_bucket_name': private['bucket_name']})
            split = configured_media_store({'public': public, 'private': private})
            other_account = {**public, 'endpoint_url': f"https://{'b' * 32}.r2.cloudflarestorage.com"}
            cross_account = configured_media_store({'public': public, 'private': other_account})
            self.assertEqual(legacy.identity(), split.identity())
            self.assertNotEqual(split.identity(), cross_account.identity())
            alias = {**public, 'endpoint_url': endpoint.replace('.r2.', '.eu.r2.')}
            with self.assertRaisesRegex(ValueError, 'must be separate'):
                configured_media_store({'public': public, 'private': alias})
            with self.assertRaises(ValueError):
                configured_media_store({'public': public})

    def test_private_cleanup_reports_failed_files_and_continues(self):
        """清理失败保留待重试提示，后续文件仍被处理；重试成功才提示完成。"""
        keys = ['photos/images/travel/a.png', 'photos/images/travel/b.png']
        store = mock.Mock()
        store.delete.side_effect = [PermissionError('storage denied'), None]
        with mock.patch.object(album_lock.operation_status, 'update') as update:
            album_lock.purge_private(store, keys)
        self.assertEqual(store.delete.call_args_list, [mock.call('private', key) for key in keys])
        self.assertEqual(update.call_args.args, ('有 1 个私有副本清理待重试', 2, 2))
        store.delete.side_effect = None
        with mock.patch.object(album_lock.operation_status, 'update') as update:
            album_lock.purge_private(store, keys)
        self.assertEqual(update.call_args.args, ('私有副本清理完成', 2, 2))

    def test_local_photo_paths_reject_escape_and_preserve_same_location(self):
        key = 'photos/images/travel/photo.png'
        self.assertEqual(local_media.path(key), Path(self.root_path(key)))
        for invalid in ('photos/images/../photo.png', 'photos/images/travel/../../secret.png',
                        'photos/images/travel/photo.png/extra', 'photos/images/travel/CON.png'):
            with self.subTest(key=invalid), self.assertRaises(ValueError):
                local_media.path(invalid)

    def test_b2_delete_removes_exact_object_versions_without_hiding_or_touching_neighbours(self):
        """转私密或删除时永久移除 B2 当前及旧版本，同名前缀的另一张图片不受影响。"""
        client = mock.Mock()
        key = 'photos/images/travel/photo.png'
        client.get_paginator.return_value.paginate.return_value = [{
            'Versions': [{'Key': key, 'VersionId': 'new'}, {'Key': key, 'VersionId': 'old'},
                         {'Key': key + '.backup', 'VersionId': 'unrelated'}],
            'DeleteMarkers': [{'Key': key, 'VersionId': 'hidden'}]}]
        store = media_store.MediaStore(client, 'public', 'private', {'provider': 'b2'})
        store.delete('public', key)
        self.assertEqual(client.delete_object.call_args_list, [
            mock.call(Bucket='public', Key=key, VersionId=version) for version in ('new', 'old', 'hidden')])
        client.delete_object.reset_mock()
        client.get_paginator.return_value.paginate.return_value = [{}]
        store.delete('public', key)
        client.delete_object.assert_not_called()

    def test_album_job_creation_failure_releases_lock_for_retry(self):
        """任务编号生成失败时同样释放迁移锁，不留下幽灵任务，重试可完成。"""
        self.call_post('/api/add_category', body={'id': 'travel', 'title': '相册'})
        self.upload_png('travel', 'kept.png', 'blue')
        before = set(album_lock._jobs)
        with mock.patch.object(album_lock.uuid, 'uuid4', side_effect=OSError('entropy unavailable')):
            code, result = self.call_post('/api/album/lock_category', body={'id': 'travel', 'enc': 'enc:album'})
        self.assertEqual(code, 500, result)
        self.assertNotIn('entropy unavailable', result['error'])
        self.assertEqual(set(album_lock._jobs), before)
        self.assertFalse(album_lock._job_lock.locked())
        code, result = self.call_post('/api/album/lock_category', body={'id': 'travel', 'enc': 'enc:album'})
        self.assertEqual(code, 200, result)
        self.assertEqual(self.wait_album_job(result['job'])['state'], 'success')

    def test_failed_gallery_cache_rebuild_closes_connection_and_keeps_old_cache(self):
        """校验失败不能替换完整缓存，并应关闭临时数据库、删除残留文件。"""
        self.upload_png('travel', 'kept.png', 'blue')
        original_cache = Path(config.GALLERY_DB).read_bytes()
        source = self.gallery_json()
        source['travel'].append({'id': 'invalid', 'name': 'bad.png', 'path': '../outside.png'})
        storage.write_json(photos.GALLERY_JSON_FILE, source)
        connect = sqlite3.connect
        connections = []
        def track_connection(path):
            connection = connect(path)
            connections.append(connection)
            return connection
        with mock.patch.object(sqlite3, 'connect', side_effect=track_connection), self.assertRaises(ValueError):
            photos.rebuild_cache()
        self.assertEqual(Path(config.GALLERY_DB).read_bytes(), original_cache)
        self.assertEqual(len(connections), 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            connections[0].execute('SELECT 1')
        self.assertEqual(list(Path(self.temp_data).glob('.gallery-cache-*')), [])

    def test_album_job_start_failure_releases_lock_for_retry(self):
        """线程未启动时移除待办并释放任务锁，下次加锁能够正常完成。"""
        self.call_post('/api/add_category', body={'id': 'travel', 'title': '相册'})
        self.upload_png('travel', 'kept.png', 'green')
        jobs_before = set(album_lock._jobs)
        with mock.patch.object(threading.Thread, 'start', side_effect=RuntimeError('cannot start worker')):
            code, result = self.call_post('/api/album/lock_category', body={'id': 'travel', 'enc': 'enc:album'})
        self.assertEqual(code, 500, result)
        self.assertEqual(set(album_lock._jobs), jobs_before)
        code, result = self.call_post('/api/album/lock_category', body={'id': 'travel', 'enc': 'enc:album'})
        self.assertEqual(code, 200, result)
        self.assertEqual(self.wait_album_job(result['job'])['state'], 'success')

    def test_external_editor_rejects_resolved_markdown_outside_data(self):
        """编辑器打开路径也检查链接的真实目标，不能穿过 markdown 目录边界。"""
        self.add_node('linked', '链接文档')
        markdown = self.root_path('markdown', 'notes', 'root-链接文档.md')
        escaped = self.write_file(self.root_path('outside.md'), 'outside data')
        realpath = os.path.realpath
        def resolve_link(path):
            return escaped if os.path.abspath(path) == markdown else realpath(path)
        with mock.patch.object(os.path, 'realpath', side_effect=resolve_link), \
                mock.patch.object(cms.cms_nodes, '_EXTERNAL_OPEN_HOOK') as open_file:
            response = self.cms('open_external', {'id': 'linked'})
        self.assertEqual(response[0], 400, response)
        open_file.assert_not_called()

    def test_44_media_restore_validates_paths_before_remote_transfer(self):
        """整批媒体路径必须先通过边界检查，不能发布非法路径对应的私有对象。"""
        with mock.patch.object(self.mock_s3, 'get_object') as get_object, self.assertRaises(ValueError):
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
                originals[image[field]] = Path(self.root_path(image[field])).read_bytes()
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
            self.assertEqual(Path(self.root_path(path)).read_bytes(), expected)
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
            self.assertTrue(os.path.exists(self.root_path(image[field])))
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
            self.assertTrue(os.path.exists(self.root_path(image[field])))
            self.assertIn(image[field], self.mock_s3.buckets['priv-bucket'])
        self.assertEqual(self.cms('unlock', body)[0], 200)

    def test_39_media_regression_album_public_delete_failure_is_retryable(self):
        """公开删除响应丢失也必须报错、恢复分类与文件，并可复用私有副本重试。"""
        self.call_post('/api/add_category', body={'id': 'travel', 'title': '相册'})
        image = self.upload_png('travel', 'private.png', 'red')
        before, gallery = self.album_config(), self.gallery_json()
        self.mock_s3.put_object(Bucket='pub-bucket', Key=image['path'], Body=Path(self.root_path(image['path'])).read_bytes())
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
            self.assertTrue(os.path.exists(self.root_path(image[field])))

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
            self.assertTrue(os.path.exists(self.root_path(image[field])))
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
        self.assertEqual(Path(self.root_path('markdown', 'notes', 'root-原文件.md')).read_text(encoding='utf-8'), '原正文')
        self.assertFalse(os.path.exists(self.root_path('markdown', 'notes', 'root-新文件.md')))

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
            self.assertTrue(os.path.isfile(self.root_path('markdown', 'notes', 'root-绝对路径.md')))
            self.assertEqual(os.listdir(elsewhere), [])
        finally:
            os.chdir(previous)

    def test_12_janitor_protects_source_references_without_cms_cache(self):
        self.add_node('n1', '有引用的正文')
        os.remove(config.CMS_DB)
        self.assertEqual(self.call_post('/api/admin/clean_data', body={})[0], 200)
        self.assertTrue(os.path.isfile(self.root_path('markdown', 'notes', 'root-有引用的正文.md')))

    def test_13_corrupted_source_aborts_cleanup(self):
        path = self.write_file(self.root_path('markdown', 'notes', 'must-keep.md'), '正文')
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
        cases = [('space-tree.json', '/api/space/update_tags', {'id': 'old', 'tags': []}),
                 ('crypto-keyring.json', '/api/crypto/keyring', valid_keyring)]
        for filename, endpoint, body in cases:
            with self.subTest(filename=filename):
                path = self.write_file(self.data_path(filename), '{broken')
                self.assertNotEqual(self.call_post(endpoint, body=body)[0], 200)
                self.assertEqual(Path(path).read_text(encoding='utf-8'), '{broken')

    def test_16_tag_category_failure_rolls_back_source_changes(self):
        """CMS 标签分类发布失败，节点标签与分类文件一起回滚。"""
        self.add_node('n1', '标签回滚')
        self.cms('update', {'id': 'n1', 'data': {'tags': ['old']}})
        self._assert_tag_category_rollback('notes', cms.cms_tags.CmsTagStrategy, self.fetch_tree)

    def test_photo_tag_category_failure_rolls_back_gallery(self):
        """图库标签分类发布失败，图片标签与分类文件一起回滚。"""
        image = self.upload_png('travel', 'a.png', 'green')
        photos.update_tags(image['id'], ['old'])
        self._assert_tag_category_rollback('photos-travel', cms.cms_other_tags.PhotosTagStrategy, self.gallery_json)

    def _assert_tag_category_rollback(self, module, strategy_type, read_source):
        cms.save_tag_categories([{'name': '分类', 'tags': ['old']}], module)
        before = read_source()
        with mock.patch.object(strategy_type, 'save_categories', side_effect=OSError('disk error')):
            response = self.call_post('/api/cms/rename_tag', {'module': [module]},
                                      {'old_name': 'old', 'new_name': 'new'})
        self.assertEqual(response[0], 500, response)
        self.assertEqual(before, read_source())
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
            self.assertTrue(os.path.exists(self.root_path(key)))
            self.assertIn(key, self.mock_s3.buckets['priv-bucket'])
        janitor.run_cleanup()
        self.assertTrue(all(key in self.mock_s3.buckets['priv-bucket'] for key in keys))
        packed = {'id': 'private', 'type': 'note', 'title': '私密插图', 'md': markdown, 'mediaRows': [row]}
        self.assertEqual(self.cms('unlock', {'id': 'private', 'tree': packed})[0], 200)
        for key in keys:
            self.assertEqual(Path(self.root_path(key)).read_bytes(), original[key])
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
                    self.assertEqual(self.call_post('/api/photos/register', body=body)[0], 400)
        self.assertEqual(self.call_post('/upload', {'category': ['../escape']}, file_data=b'image')[0], 400)
        poisoned = {'id': 'bad', 'name': 'bad', 'path': 'photos/images/arch/../../../outside.bin'}
        storage.write_json(self.data_path('photos-data.json'), {'arch': [poisoned]})
        self.assertEqual(self.call_post('/delete', body={'path': poisoned['path']})[0], 400)
        self.assertEqual(Path(target).read_bytes(), b'keep')

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
        self.assertFalse(os.path.exists(self.root_path('markdown', 'notes', 'root-回执回滚.md')))
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
        self.assertEqual(Path(self.root_path('markdown', 'notes', 'root-可重试加锁.md')).read_text(encoding='utf-8'), '正文')
        for field in ('path', 'thumb', 'preview'):
            self.assertTrue(os.path.isfile(self.root_path(image[field])))
        self.assertEqual(self.cms('lock', body)[0], 200)

    def test_28_lock_partial_remote_delete_and_publish_failure_restore_public_state(self):
        images = [self.upload_png('_notes', 'a.png', 'red'), self.upload_png('_notes', 'b.png', 'green')]
        for image in images:
            for field in ('path', 'thumb', 'preview'):
                self.mock_s3.put_object(Bucket='pub-bucket', Key=image[field], Body=Path(self.root_path(image[field])).read_bytes())
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
            for field in ('path', 'thumb', 'preview'):
                self.assertIn(image[field], self.mock_s3.buckets['pub-bucket'])
        self.assertEqual(self.fetch_tree(), before_tree)
        self.assertEqual(self.gallery_json(), before_gallery)
        with mock.patch.object(photos, 'sync_gallery_js', side_effect=OSError('gallery publish failed')):
            self.assertEqual(self.cms('lock', body)[0], 500)
        self.assertEqual(self.fetch_tree(), before_tree)
        self.assertEqual(self.gallery_json(), before_gallery)
        for image in images:
            for field in ('path', 'thumb', 'preview'):
                self.assertTrue(os.path.isfile(self.root_path(image[field])))
                self.assertIn(image[field], self.mock_s3.buckets['pub-bucket'])
        self.assertEqual(self.cms('lock', body)[0], 200)
        for image in images:
            for field in ('path', 'thumb', 'preview'):
                self.assertNotIn(image[field], self.mock_s3.buckets['pub-bucket'])

    def test_29_janitor_keeps_encoded_relative_and_cdn_media_references(self):
        from services import janitor
        from urllib.parse import quote
        image = self.upload_png('_notes', 'encoded.png', 'blue')
        self.add_node('encoded', '编码引用')
        for reference in (image['path'].replace('_notes', '%5Fnotes'),
                          '../' + image['path'] + '?v=1#image',
                          'https://images.example.com/' + image['thumb'].replace('_notes', '%5Fnotes')):
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
        with (mock.patch.object(photos, 'DISABLE_R2_SYNC', False),
              mock.patch.object(self.mock_s3, 'get_object', wraps=self.mock_s3.get_object) as request,
              mock.patch.object(self.mock_s3, 'put_object', wraps=self.mock_s3.put_object) as publish):
            code, result = self.call_post('/api/photos/register', body=body)
        self.assertEqual(code, 200, result)
        self.assertEqual(sum(call.kwargs['Key'] == body['path'] for call in request.call_args_list), 1)
        self.assertEqual([call.kwargs['Key'] for call in publish.call_args_list],
                         [result['thumb'], result['preview']])
        for field in ('path', 'thumb', 'preview'):
            self.assertTrue(os.path.isfile(self.root_path(result[field])))
        self.assertTrue(self.gallery_json()['travel'][0]['hash'])

    def test_31_cloud_registration_failure_keeps_relay_unacknowledged_and_retries(self):
        import io
        import routes
        from urllib.error import HTTPError
        from urllib.parse import parse_qs, urlsplit
        from services import relay_media

        body = {'category': 'travel', 'path': 'photos/images/travel/retry.png', 'name': 'retry.png',
                '_relay': {'source': 'https://relay.example', 'key': 'cloud-retry'}}
        image = make_test_png_bytes('red')
        ready = False

        def download(request, timeout):
            parsed = urlsplit(request.full_url)
            self.assertEqual((parsed.scheme, parsed.netloc, parsed.path), ('https', 'relay.example', '/api/drafts/media'))
            self.assertEqual(parse_qs(parsed.query), {'path': [body['path']]})
            self.assertEqual(request.get_header('X-sync-key'), 'test-access')
            if not ready:
                raise HTTPError(request.full_url, 404, 'Not Found', {},
                                io.BytesIO(b'{"code":"draft_image_missing"}'))
            response = io.BytesIO(image)
            response.headers = {'X-Maers-Image-Size': str(len(image)), 'X-Maers-Bucket': 'default'}
            return response

        with mock.patch.object(relay_media, 'build_opener') as opener:
            opener.return_value.open.side_effect = download
            merge = lambda: routes.dispatch_post('/api/photos/register', {}, body, relay_secret='test-access')
            code, failure = merge()
            self.assertEqual(code, 400)
            self.assertIn('未找到图片原图', failure['error'])
            self.assertFalse(os.path.exists(self.data_path('.relay-receipts.json')))
            self.assertEqual(self.gallery_json(), {})
            ready = True
            code, result = merge()
        self.assertEqual(code, 200, result)
        self.assertEqual(result['_draft_media'], [body['path']])
        self.assertTrue(os.path.isfile(self.root_path(result['thumb'])))
        self.assertNotIn('test-access', Path(self.data_path('.relay-receipts.json')).read_text(encoding='utf-8'))
        self.assertNotIn(body['path'], self.mock_s3.buckets['pub-bucket'])

    def test_32_registration_derivative_failure_restores_files_and_can_retry(self):
        import routes
        from services import media_jobs, relay_media

        local_bytes = make_test_png_bytes('red')
        original = self.write_file(self.root_path('photos/images/travel/local.png'), local_bytes)
        body = {'category': 'travel', 'name': 'local.png', 'path': 'photos/images/travel/local.png',
                '_relay': {'source': 'https://relay.example', 'key': 'derive-retry'}}
        write_bytes = storage.write_bytes
        def fail_preview(path, data):
            if path.endswith('.avif'):
                raise OSError('preview disk error')
            return write_bytes(path, data)
        staged = relay_media.DraftImage(make_test_png_bytes('blue'), 'default', None)
        with mock.patch.object(relay_media, 'read', return_value=staged):
            merge = lambda: routes.dispatch_post('/api/photos/register', {}, body, relay_secret='test-access')
            with mock.patch.object(storage, 'write_bytes', side_effect=fail_preview):
                self.assertEqual(merge()[0], 500)
            self.assertEqual(Path(original).read_bytes(), local_bytes)
            self.assertFalse(os.path.exists(self.data_path('.relay-receipts.json')))
            self.assertFalse(media_jobs.pending())
            self.assertEqual(os.listdir(self.root_path('photos/thumbnails/travel')), [])
            self.assertEqual(merge()[0], 200)
        self.assertNotIn(body['path'], self.mock_s3.buckets['pub-bucket'])
        self.assertEqual(media_jobs.retry(for_publish=True)['completed'], 3)
        self.assertEqual(self.mock_s3.buckets['pub-bucket'][body['path']]['data'], staged.data)

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
        self.mock_s3.put_object(Bucket='pub-bucket', Key=image['path'], Body=Path(self.root_path(image['path'])).read_bytes())
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
        orphans = [self.write_file(self.root_path('markdown', 'notes', name), '真实孤儿')
                   for name in ('C.md', 'URL 编码.md', '未引用.md')]
        for _ in range(2):
            janitor.run_cleanup()
            self.assertEqual(self.fetch_tree(), before)
            for title in titles:
                self.assertEqual(Path(self.root_path('markdown', 'notes', 'root-' + title + '.md')).read_text(encoding='utf-8'), f'正文 {title}')
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
                self.assertEqual(Path(self.root_path(key)).read_bytes(), expected)
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
            'remote': 'https://images.example.com/photos/images/%5Fnotes/remote%20literal.png?v=1#preview'}])
        storage.write_json(self.data_path('tags', 'cms-notes-tag-categories.json'),
                           [{'name': '分类', 'tags': [], 'cover': paths[1]}])
        storage.write_json(config.SPACE_DATA, {'root': [{'id': 'icon', 'icon': paths[2]}]})
        for _ in range(2):
            janitor.run_cleanup()
            self.assertTrue(all(os.path.isfile(self.root_path(key)) for key in paths))
