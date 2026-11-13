"""正文发布镜像回归：增量上传、清理已删除正文、密文跳过、故障续传与路径边界。"""

import hashlib
import io
import json
import os
import shutil
from pathlib import Path
from unittest import mock
from .sandbox import SandboxTestCase, config
from .helpers import STUDIO_DIR
from services import content_sync, media_store, storage_journal
from services.media_store import get_store as configured_media_store
from tools import check_push


class Test16_ContentSync(SandboxTestCase):

    def _note(self, node_id, title, text, module='notes'):
        self.add_node(node_id, title, module=module)
        code, result = self.cms('update', {'id': node_id, 'data': {'content': text}}, module)
        self.assertEqual(code, 200, result)

    def _mirror(self, scope='public'):
        bucket = 'pub-bucket' if scope == 'public' else 'priv-bucket'
        return {key: value for key, value in self.mock_s3.buckets[bucket].items() if key.startswith('markdown/')}

    def test_push_requires_sync_after_add_rename_move_and_edit(self):
        """新增、同字节改名、移动与正文编辑必须重新同步后才能推送。"""
        self._note('a', '甲', '正文')
        self.assertFalse(content_sync.is_synced())
        content_sync.sync()
        self.assertTrue(content_sync.is_synced())
        self.add_node('folder', '目录', 'folder')
        for action, body in (
            ('update', {'id': 'a', 'data': {'title': '乙'}}),
            ('move', {'id': 'a', 'targetParentId': 'folder'}),
            ('update', {'id': 'a', 'data': {'content': '修改后的正文'}}),
        ):
            with self.subTest(action=action, body=body):
                self.assertEqual(self.cms(action, body)[0], 200)
                self.assertFalse(content_sync.is_synced())
                content_sync.sync()
                self.assertTrue(content_sync.is_synced())

    def test_push_requires_sync_after_visibility_change_or_deletion(self):
        """私密正文不能用公开桶的记录冒充已同步，删除也须完成云端清理。"""
        self._note('a', '甲', '正文')
        self._note('b', '保留', '保留正文')
        content_sync.sync()
        self.assertEqual(self.cms('lock', {'id': 'a', 'enc': 'enc:abc.def'})[0], 200)
        self.assertFalse(content_sync.is_synced())
        content_sync.sync()
        self.assertTrue(content_sync.is_synced())
        self.assertEqual(self.cms('delete', {'id': 'a'})[0], 200)
        self.assertFalse(content_sync.is_synced())
        content_sync.sync()
        self.assertTrue(content_sync.is_synced())

    def test_failed_remote_cleanup_cannot_leave_a_passing_push_record(self):
        """即使剩余正文的哈希全部匹配，未完成的云端删除也必须阻止推送。"""
        self._note('a', '甲', '正文')
        self._note('b', '保留', '保留正文')
        content_sync.sync()
        self.cms('delete', {'id': 'a'})
        with mock.patch.object(self.mock_s3, 'delete_object', side_effect=RuntimeError('network down')):
            with self.assertRaises(RuntimeError):
                content_sync.sync()
        self.assertFalse(content_sync.is_synced())
        content_sync.sync()
        self.assertTrue(content_sync.is_synced())

    def test_push_rejects_missing_corrupt_old_or_foreign_sync_records(self):
        """缺失、损坏、旧版及属于其他存储位置的记录均不能证明正文已同步。"""
        self._note('a', '甲', '正文')
        content_sync.sync()
        path = Path(content_sync._manifest_path())
        original = json.loads(path.read_text(encoding='utf-8'))
        for record in (None, '{', {**original, 'complete': False},
                       {key: value for key, value in original.items() if key != 'complete'},
                       {**original, 'backend': 'another-storage'},
                       {**original, 'bucketTargets': {'default': 'another-target'}}):
            with self.subTest(record=record):
                if record is None:
                    path.unlink()
                else:
                    path.write_text(record if isinstance(record, str) else json.dumps(record), encoding='utf-8')
                self.assertFalse(content_sync.is_synced())
        content_sync.sync()
        self.assertTrue(content_sync.is_synced())

    def test_push_sync_check_is_readonly_and_does_not_recover_transactions(self):
        """检查失败不能修改同步记录、访问云端或自动恢复真实文件。"""
        self._note('a', '甲', '正文')
        content_sync.sync()
        before = Path(content_sync._manifest_path()).read_bytes()
        self.cms('update', {'id': 'a', 'data': {'content': '新正文'}})
        with mock.patch.object(storage_journal, 'recover') as recover, \
                mock.patch.object(self.mock_s3, 'get_object') as get, \
                mock.patch.object(self.mock_s3, 'put_object') as put:
            self.assertFalse(content_sync.is_synced())
        recover.assert_not_called()
        get.assert_not_called()
        put.assert_not_called()
        self.assertEqual(Path(content_sync._manifest_path()).read_bytes(), before)

    def test_actual_push_hook_blocks_unsynced_content_and_rechecks_after_tests(self):
        """真实 pre-push 入口拒绝漏同步，并捕获测试期间被外部编辑器修改的正文。"""
        self._note('a', '甲', '正文')
        head = 'a' * 40
        source = f'refs/heads/main {head} refs/heads/main {"b" * 40}\n'
        for state in ('unsynced', 'synced', 'edited_during_tests'):
            with self.subTest(state=state):
                if state != 'unsynced':
                    content_sync.sync()
                def run_tests(*args, **kwargs):
                    if state == 'edited_during_tests':
                        Path(self.root_path('markdown/notes/root-甲.md')).write_text('外部编辑', encoding='utf-8')
                    return 0
                with mock.patch('sys.stdin', io.StringIO(source)), \
                        mock.patch('sys.stderr', io.StringIO()), \
                        mock.patch.object(check_push.subprocess, 'check_output', side_effect=[head, '']), \
                        mock.patch.object(check_push.subprocess, 'call', side_effect=run_tests) as tests:
                    self.assertEqual(check_push.main(), 0 if state == 'synced' else 1)
                self.assertEqual(tests.call_count, 0 if state == 'unsynced' else 1)

    def test_push_sync_check_errors_stop_push_without_exposing_internal_details(self):
        """无法确认同步状态时保持拦截，错误提示不透传内部配置。"""
        with mock.patch.object(content_sync, 'is_synced', side_effect=RuntimeError('private-marker')), \
                mock.patch('sys.stderr', io.StringIO()) as errors:
            self.assertFalse(check_push.check_content_sync())
        self.assertNotIn('private-marker', errors.getvalue())
        self.assertIn('推送已停止', errors.getvalue())

    def test_selecting_new_content_bucket_keeps_previously_mirrored_files(self):
        """公私正文分别设置首次写入桶，编辑既有正文仍写回原桶。"""
        endpoint = f"https://{'a' * 32}.r2.cloudflarestorage.com"
        target = {'provider': 'r2', 'endpoint_url': endpoint,
                  'access_key_id': 'fixture', 'secret_access_key': 'fixture'}
        settings = {**target, 'public_bucket_name': 'pub-bucket', 'private_bucket_name': 'priv-bucket',
                    'bucket_groups': {'docs': {'public': {**target, 'bucket_name': 'docs-public'},
                                               'private': {**target, 'bucket_name': 'docs-private'}}},
                    'write_buckets': {'public_content': 'docs', 'private_content': 'default'}}
        old, new = 'markdown/notes/root-甲.md', 'markdown/notes/root-乙.md'
        with mock.patch('boto3.client', return_value=self.mock_s3):
            store = configured_media_store(settings)
            with mock.patch.object(media_store, 'get_store', return_value=store):
                self._note('a', '甲', '正文甲')
                self.assertEqual(content_sync.sync(bucket_id='default')['uploaded'], 1)
                self._note('b', '乙', '正文乙')
                self._note('c', '私密', '私密正文')
                self.assertEqual(self.cms('lock', {'id': 'c', 'enc': 'enc:abc.def'})[0], 200)
                self.assertEqual(content_sync.sync()['uploaded'], 2)
                self.cms('update', {'id': 'b', 'data': {'content': '更新'}})
                self.assertEqual(content_sync.sync(bucket_id='default')['uploaded'], 1)
                self.assertTrue(content_sync.is_synced())
                target = store.bucket_groups['docs']['public']
                original_bucket = target['bucket_name']
                target['bucket_name'] = 'docs-public-changed'
                self.assertFalse(content_sync.is_synced())
                target['bucket_name'] = original_bucket
                self.assertTrue(content_sync.is_synced())
        self.assertEqual(set(self._mirror()), {old})
        self.assertEqual(set(self.mock_s3.buckets['docs-public']), {new})
        self.assertEqual(set(self._mirror('private')), {'markdown/notes/root-私密.md'})
        self.assertEqual(self.mock_s3.buckets['docs-public'][new]['data'], '更新'.encode())

    def test_first_sync_uploads_all_public_markdown_with_revalidating_cache_headers(self):
        """首次发布上传全部公开正文，内容类型为 Markdown，缓存头要求每次回源校验。"""
        self._note('a', '甲', '正文甲')
        self._note('b', '乙', '正文乙', module='literature')
        result = content_sync.sync()
        self.assertEqual(result, {'enabled': True, 'uploaded': 2, 'deleted': 0})
        mirror = self._mirror()
        self.assertEqual(sorted(mirror), ['markdown/literature/root-乙.md', 'markdown/notes/root-甲.md'])
        entry = mirror['markdown/notes/root-甲.md']
        self.assertEqual(entry['data'], '正文甲'.encode('utf-8'))
        self.assertEqual(entry['content_type'], 'text/markdown; charset=utf-8')
        self.assertIn('must-revalidate', entry['cache_control'])

    def test_second_sync_only_uploads_changed_and_removes_deleted_markdown(self):
        """未变化的正文不重复上传；修改的重传；本机删除的从云端移除。"""
        self._note('a', '甲', '正文甲')
        self._note('b', '乙', '正文乙')
        content_sync.sync()
        with mock.patch.object(self.mock_s3, 'put_object', wraps=self.mock_s3.put_object) as put:
            self.assertEqual(content_sync.sync(), {'enabled': True, 'uploaded': 0, 'deleted': 0})
            put.assert_not_called()
            self.cms('update', {'id': 'a', 'data': {'content': '新正文'}})
            self.assertEqual(content_sync.sync()['uploaded'], 1)
            self.assertEqual([call.kwargs['Key'] for call in put.call_args_list], ['markdown/notes/root-甲.md'])
        code, result = self.cms('delete', {'id': 'b'})
        self.assertEqual(code, 200, result)
        self.assertEqual(content_sync.sync(), {'enabled': True, 'uploaded': 0, 'deleted': 1})
        self.assertEqual(sorted(self._mirror()), ['markdown/notes/root-甲.md'])

    def test_lost_manifest_reconciles_against_remote_objects(self):
        """本机同步记录丢失后按云端对象与哈希对账，补传缺失或不一致的正文。"""
        self._note('a', '甲', '正文甲')
        content_sync.sync()
        self.mock_s3.buckets['pub-bucket']['markdown/notes/root-甲.md']['data'] = b'tampered'
        os.remove(os.path.join(storage_journal.local_root(), 'content-sync.json'))
        self.assertEqual(content_sync.sync()['uploaded'], 1)
        self.assertEqual(self._mirror()['markdown/notes/root-甲.md']['data'], '正文甲'.encode('utf-8'))

    def test_encrypted_nodes_are_never_mirrored(self):
        """密文节点不含明文正文路径，镜像不得上传其内容。"""
        self._note('a', '公开', '公开正文')
        tree_path = self.data_path('notes-tree.json')
        tree = self.load_json(tree_path)
        tree['root'].append({'id': 'locked', '_enc': 'enc:abc.def'})
        with open(tree_path, 'w', encoding='utf-8') as target:
            json.dump(tree, target, ensure_ascii=False)
        self.assertEqual(content_sync.sync()['uploaded'], 1)
        self.assertEqual(sorted(self._mirror()), ['markdown/notes/root-公开.md'])

    def test_failed_upload_keeps_confirmed_objects_and_retry_finishes_the_rest(self):
        """上传中途失败时保留已确认记录并向上抛出，重试只补传剩余正文。"""
        self._note('a', '甲', '正文甲')
        self._note('b', '乙', '正文乙')
        original = self.mock_s3.put_object
        calls = []

        def flaky(**kwargs):
            calls.append(kwargs['Key'])
            if len(calls) == 2:
                raise RuntimeError('network down')
            return original(**kwargs)

        with mock.patch.object(self.mock_s3, 'put_object', side_effect=flaky), self.assertRaises(RuntimeError):
            content_sync.sync()
        with open(os.path.join(storage_journal.local_root(), 'content-sync.json'), encoding='utf-8') as source:
            manifest = json.load(source)
            self.assertEqual(len(manifest.get('files') or manifest.get('public', {})), 1)
        self.assertEqual(content_sync.sync()['uploaded'], 1)
        self.assertEqual(len(self._mirror()), 2)

    def test_missing_markdown_stops_sync_before_touching_remote(self):
        """树中引用的正文缺失时中止同步，不能用残缺快照覆盖云端。"""
        self._note('a', '甲', '正文甲')
        os.remove(self.root_path('markdown', 'notes', 'root-甲.md'))
        with self.assertRaises(FileNotFoundError):
            content_sync.sync()
        self.assertEqual(self._mirror(), {})

    def test_empty_local_tree_refuses_to_clear_remote_mirror(self):
        """本机没有任何公开正文而云端有镜像时拒绝清空，防止数据目录异常导致云端被误清。"""
        self._note('a', '甲', '正文甲')
        content_sync.sync()
        self.cms('delete', {'id': 'a'})
        with self.assertRaises(RuntimeError):
            content_sync.sync()
        self.assertEqual(len(self._mirror()), 1)

    def test_local_directory_backend_needs_no_mirror(self):
        """本机目录后端读取的就是本机文件，不做镜像。"""
        self._note('a', '甲', '正文甲')
        local = media_store.MediaStore(settings={'provider': 'local', 'root': self.root_path('media')})
        with mock.patch.object(media_store, 'get_store', lambda: local):
            self.assertEqual(content_sync.sync(), {'enabled': False, 'uploaded': 0, 'deleted': 0})
            with self.assertRaisesRegex(content_sync.PublishConfigurationError, '云端存储桶'):
                content_sync.sync(for_publish=True)

    def test_content_keys_reject_traversal_and_foreign_prefixes(self):
        """镜像键只接受 markdown/<模块>/<文件>.md，拒绝越界、隐藏段与其他前缀。"""
        for key in ('markdown/notes/a.md', 'markdown/notes/子目录/a b.md'):
            self.assertEqual(media_store.MediaStore.content_key(key), key)
        for key in ('photos/images/a/b.md', 'markdown/a.md', 'markdown/private/notes/a.md', 'markdown/../a/b.md',
                    'markdown/notes//a.md', 'markdown/notes/a.txt', 'markdown\\notes\\a.md', 'markdown/notes/c:/a.md', 'markdown/./notes/a.md'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                media_store.MediaStore.content_key(key)

    def test_manifest_is_ignored_when_storage_target_changes(self):
        """更换存储目标后旧同步记录失效，所有正文在新目标上重新上传。"""
        self._note('a', '甲', '正文甲')
        content_sync.sync()
        with open(os.path.join(storage_journal.local_root(), 'content-sync.json'), encoding='utf-8') as source:
            record = json.load(source)
        files = record.get('files') or record.get('public', {})
        self.assertEqual(files['markdown/notes/root-甲.md'], hashlib.sha256('正文甲'.encode('utf-8')).hexdigest())
        record['backend'] = 'other-target'
        with open(os.path.join(storage_journal.local_root(), 'content-sync.json'), 'w', encoding='utf-8') as target:
            json.dump(record, target)
        self.mock_s3.buckets['pub-bucket'].clear()
        self.assertEqual(content_sync.sync()['uploaded'], 1)

    def test_publish_stops_before_git_when_content_sync_fails(self):
        """正文同步失败时发布中止，不执行 git add / commit / push。"""
        from services import git_service
        with mock.patch.object(git_service.subprocess, 'run'), \
                mock.patch.object(git_service, '_run_git_cmd') as git, \
                mock.patch('tests.run_tests.run_pre_push_check', return_value={'passed': True, 'total': 1}), \
                mock.patch.object(content_sync, 'sync', side_effect=RuntimeError('storage down')):
            result = git_service._commit_and_push('测试')
        self.assertEqual((result['success'], result['step']), (False, 'content'))
        git.assert_not_called()

    def test_publish_requires_explicit_content_address_even_with_image_address(self):
        """发布时，只有图片地址不能替代正文地址。"""
        self._note('a', '公开', '正文')
        site = Path(self.root_path('custom/config.js'))
        site.parent.mkdir()
        site.write_text("window.MAERS.Config = {\n    MEDIA_PUBLIC_BASE: 'https://images.example',\n"
                        "    CONTENT_PUBLIC_BASE: ''\n};\n", encoding='utf-8')
        with self.assertRaisesRegex(content_sync.PublishConfigurationError, '公开正文地址'):
            content_sync.sync(for_publish=True)
        self.assertEqual(self._mirror(), {})

    def test_encrypted_subtree_with_plaintext_children_is_skipped(self):
        """密文节点即使携带明文 children，整棵子树的正文也不得上传。"""
        self._note('a', '公开', '公开正文')
        self._note('hidden', '残留', '不应上传')
        tree_path = self.data_path('notes-tree.json')
        tree = self.load_json(tree_path)
        child = next(node for node in tree['root'] if node['id'] == 'hidden')
        tree['root'] = [node for node in tree['root'] if node['id'] != 'hidden']
        tree['root'].append({'id': 'locked', '_enc': 'enc:abc.def', 'children': [child]})
        with open(tree_path, 'w', encoding='utf-8') as target:
            json.dump(tree, target, ensure_ascii=False)
        content_sync.sync()
        self.assertEqual(sorted(self._mirror()), ['markdown/notes/root-公开.md'])

    def test_removed_markdown_purges_all_b2_versions(self):
        """正文被加密或删除后，B2 的当前与历史版本都被永久移除，不留可读旧明文。"""
        client = mock.Mock()
        key = 'markdown/notes/root-甲.md'
        client.get_paginator.return_value.paginate.return_value = [{
            'Versions': [{'Key': key, 'VersionId': 'new'}, {'Key': key, 'VersionId': 'old'}],
            'DeleteMarkers': []}]
        store = media_store.MediaStore(client, 'public', 'private', {'provider': 'b2'})
        store.delete_content(key)
        self.assertEqual(client.delete_object.call_args_list, [
            mock.call(Bucket='public', Key=key, VersionId=version) for version in ('new', 'old')])

    def test_locking_a_synced_note_removes_its_mirrored_plaintext_and_syncs_to_private(self):
        """已同步的公开笔记设为私密后，下次发布从公开桶移除，并同步至私有桶；本地物理文件保留。"""
        self._note('a', '甲', '正文甲')
        self._note('b', '乙', '正文乙')
        content_sync.sync()
        self.assertEqual(sorted(self._mirror('public')), ['markdown/notes/root-乙.md', 'markdown/notes/root-甲.md'])
        self.assertEqual(self._mirror('private'), {})

        code, result = self.cms('lock', {'id': 'a', 'enc': 'enc:abc.def'})
        self.assertEqual(code, 200, result)

        # 本地物理文件依然完整存在
        self.assertTrue(os.path.isfile(self.root_path('markdown', 'notes', 'root-甲.md')))
        self.assertEqual(Path(self.root_path('markdown', 'notes', 'root-甲.md')).read_text(encoding='utf-8'), '正文甲')

        content_sync.sync()
        # 公开桶中已剔除，私有桶中已包含
        self.assertEqual(sorted(self._mirror('public')), ['markdown/notes/root-乙.md'])
        self.assertEqual(sorted(self._mirror('private')), ['markdown/notes/root-甲.md'])

    def test_build_site_purges_private_nodes_completely(self):
        """build-site.mjs 净化静态目录树，彻底剔除带 _private 的节点，公开访客端无痕。"""
        import subprocess
        from . import node_runtime
        if not node_runtime.NODE_BIN:
            return
        # 创建公开与私密节点（文件夹结构验证树净化）
        tree_path = self.data_path('notes-tree.json')
        tree = {
            'root': [
                {'id': 'pub_folder', 'type': 'folder', 'title': '公开目录', 'children': []},
                {'id': 'priv_folder', 'type': 'folder', 'title': '私密日记', '_private': True, 'children': []}
            ]
        }
        with open(tree_path, 'w', encoding='utf-8') as f:
            json.dump(tree, f, ensure_ascii=False)

        tooling_dir = Path(self.temp_root) / '_studio/tooling'
        tooling_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(STUDIO_DIR) / 'tooling/build-site.mjs', tooling_dir / 'build-site.mjs')

        script = tooling_dir / 'build-site.mjs'
        res = subprocess.run([node_runtime.NODE_BIN, str(script)], cwd=self.temp_root, capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)

        dist_tree_path = self.root_path('dist/data/notes-tree.json')
        self.assertTrue(os.path.isfile(dist_tree_path))
        with open(dist_tree_path, encoding='utf-8') as f:
            dist_tree = json.load(f)

        ids = [node['id'] for node in dist_tree['root']]
        self.assertIn('pub_folder', ids)
        self.assertNotIn('priv_folder', ids)

    def test_build_site_omits_all_markdown_without_content_address(self):
        """正文地址为空时，公开和私密 Markdown 都排除，目录索引照常生成。"""
        import subprocess
        from . import node_runtime
        if not node_runtime.NODE_BIN:
            return
        Path(self.root_path('markdown', 'notes')).mkdir(parents=True, exist_ok=True)
        for name, text in (('pub.md', '公开正文'), ('priv.md', '私密正文'), ('child.md', '私密子文档')):
            Path(self.root_path('markdown', 'notes', name)).write_text(text, encoding='utf-8')
        tree = {'root': [
            {'id': 'pub', 'type': 'note', 'title': '公开', 'content': 'markdown/notes/pub.md', 'children': None},
            {'id': 'priv', 'type': 'note', 'title': '私密', 'content': 'markdown/notes/priv.md', '_private': True, 'children': None},
            {'id': 'folder', 'type': 'folder', 'title': '私密目录', '_private': True, 'children': [
                {'id': 'child', 'type': 'note', 'title': '子文档', 'content': 'markdown/notes/child.md', 'children': None}]},
        ]}
        Path(self.data_path('notes-tree.json')).write_text(json.dumps(tree, ensure_ascii=False), encoding='utf-8')
        tooling_dir = Path(self.temp_root) / '_studio/tooling'
        tooling_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(STUDIO_DIR) / 'tooling/build-site.mjs', tooling_dir / 'build-site.mjs')
        env = {**os.environ, 'GIT_CEILING_DIRECTORIES': str(Path(self.temp_root).parent)}
        result = subprocess.run([node_runtime.NODE_BIN, str(tooling_dir / 'build-site.mjs')],
                                cwd=self.temp_root, capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        dist = Path(self.root_path('dist'))
        self.assertFalse(list(dist.rglob('*.md')))
        self.assertFalse((dist / 'data/search-manifest.json').exists())
        self.assertEqual([row['id'] for row in self.load_json(dist / 'data/notes-tree.json')['root']], ['pub'])
        self.assertTrue(Path(self.root_path('markdown/notes/pub.md')).is_file())

    def test_build_site_from_source_checkout_without_markdown_or_node_dependencies(self):
        import subprocess
        from . import node_runtime
        if not node_runtime.NODE_BIN:
            return
        tree = {'root': [{'id': 'pub', 'type': 'note', 'title': '目录条目', 'content': 'markdown/notes/missing.md'}]}
        Path(self.data_path('notes-tree.json')).write_text(json.dumps(tree), encoding='utf-8')
        tooling = Path(self.root_path('_studio/tooling'))
        tooling.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(STUDIO_DIR) / 'tooling/build-site.mjs', tooling / 'build-site.mjs')
        env = {**os.environ, 'GIT_CEILING_DIRECTORIES': str(Path(self.temp_root).parent)}
        result = subprocess.run([node_runtime.NODE_BIN, str(tooling / 'build-site.mjs')],
                                cwd=self.temp_root, capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.load_json(self.root_path('dist/data/notes-tree.json')), tree)
        self.assertFalse(list(Path(self.root_path('dist')).rglob('*.md')))
