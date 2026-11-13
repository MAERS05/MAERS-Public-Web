# -*- coding: utf-8 -*-
"""套件 05：隔离沙盒下 CMS 节点 CRUD、.md 联动、排序移动、加解锁、R2 私密封面与标签管理"""

import json
import os
from pathlib import Path
from unittest import mock

from .sandbox import SandboxTestCase
from services import album_lock, cms_nodes, cms


class Test05_CmsBackendSandbox(SandboxTestCase):
    """在隔离沙盒中测试 CMS 节点增删改查、物理 .md 同步、加锁解锁与标签系统"""

    def md_path(self, title, module='notes', parents=()):
        return self.root_path('markdown', module, '-'.join([*(parents or ['root']), title]) + '.md')

    def save_tag_categories(self, cats, module='notes'):
        code, res = self.call_post('/api/cms/save_tag_categories', {'module': [module]}, cats)
        self.assertEqual(code, 200, res)

    def tag_categories(self, module='notes'):
        code, cats = self.call_get('/api/cms/tag_categories', {'module': [module]})
        self.assertEqual(code, 200, cats)
        return cats

    def update_tags(self, node_id, tags, module='notes'):
        code, res = self.call_post('/api/cms/update_tags', {'module': [module]}, {'id': node_id, 'tags': tags})
        self.assertEqual(code, 200, res)

    # ---------- 节点 CRUD ----------

    def test_01_add_folder_and_note(self):
        """新建文件夹与笔记节点，自动生成物理 .md 文件并同步 notes-tree.json"""
        self.add_node('f_1', '研发归档', 'folder')
        self.add_node('n_1', '架构设计笔记', parent='f_1')

        self.assertTrue(os.path.isfile(self.md_path('架构设计笔记', parents=['研发归档'])), "新建笔记后未自动生成物理 .md 文件")
        tree = self.load_json(self.data_path('notes-tree.json'))
        self.assertEqual([n['id'] for n in tree['root']], ['f_1'])
        self.assertEqual(tree['root'][0]['children'][0]['id'], 'n_1')

    def test_02_fetch_tree_hierarchy(self):
        """GET /api/cms/fetch 返回准确的父子层级树结构"""
        self.add_node('f_root', '根目录', 'folder')
        self.add_node('n_child', '子文档', parent='f_root')
        tree = self.fetch_tree()
        self.assertEqual(tree['root'][0]['title'], '根目录')
        self.assertEqual(tree['root'][0]['children'][0]['title'], '子文档')

    def test_03_update_note_content(self):
        """更新正文时写入物理 .md，数据库 content 字段保持为相对路径"""
        self.add_node('n_content', '正文测试')
        md_body = "# 标题\n\n这是一段测试正文内容。"
        code, _ = self.cms('update', {'id': 'n_content', 'data': {'content': md_body, 'tags': ['技术', '架构']}})
        self.assertEqual(code, 200)

        with open(self.md_path('正文测试'), encoding='utf-8') as f:
            self.assertEqual(f.read(), md_body)
        node = self.fetch_tree()['root'][0]
        self.assertEqual(node['content'], 'markdown/notes/root-正文测试.md')
        self.assertEqual(node['tags'], ['技术', '架构'])

    def test_04_rename_note_syncs_md_file(self):
        """修改笔记标题时，物理 .md 文件自动同步重命名且旧文件被移除"""
        self.add_node('n_rename', '旧标题')
        self.assertTrue(os.path.exists(self.md_path('旧标题')))
        code, _ = self.cms('update', {'id': 'n_rename', 'data': {'title': '新标题'}})
        self.assertEqual(code, 200)
        self.assertFalse(os.path.exists(self.md_path('旧标题')), "重命名后旧 .md 文件未移除")
        self.assertTrue(os.path.exists(self.md_path('新标题')), "重命名后新 .md 文件未生成")

    def test_05_sibling_names_rejected_and_other_folders_allowed(self):
        """同级文件夹和文档不能同名，不同父目录和模块允许同名。"""
        self.add_node('n_dup1', '同名笔记')
        before = self.fetch_tree()
        for kind in ('note', 'folder'):
            code, result = self.cms('add', {'id': 'n_dup2', 'type': kind, 'parentId': 'root', 'title': ' 同名笔记 '})
            self.assertEqual(code, 400, result)
            self.assertIn('同名', result['error'])
        self.assertEqual(self.fetch_tree(), before)
        self.add_node('f_a', '目录A', 'folder')
        self.add_node('f_b', '目录B', 'folder')
        self.add_node('n_a', '同名笔记', parent='f_a')
        self.add_node('n_b', '同名笔记', parent='f_b')
        self.add_node('n_other', '同名笔记', module='record')
        self.assertTrue(os.path.isfile(self.md_path('同名笔记')))
        self.assertTrue(os.path.isfile(self.md_path('同名笔记', parents=['目录A'])))
        self.assertTrue(os.path.isfile(self.md_path('同名笔记', parents=['目录B'])))

    def test_sibling_rename_and_move_conflicts_keep_sources(self):
        """重命名及移入检查目标同级名称，拒绝时正文、路径和目录都不改变。"""
        self.add_node('a', '目录A', 'folder')
        self.add_node('b', '目录B', 'folder')
        self.add_node('one', '笔记', parent='a')
        self.add_node('two', '笔记', parent='b')
        self.add_node('three', '另一篇', parent='a')
        before = self.fetch_tree()
        for action, body in [
            ('update', {'id': 'three', 'data': {'title': '笔记', 'content': '不应覆盖'}}),
            ('update', {'id': 'a', 'data': {'title': '目录B'}}),
            ('move', {'id': 'one', 'targetParentId': 'b'}),
        ]:
            code, result = self.cms(action, body)
            self.assertEqual(code, 400, result)
            self.assertIn('同名', result['error'])
            self.assertEqual(self.fetch_tree(), before)
        self.assertEqual(Path(self.md_path('笔记', parents=['目录A'])).read_text(encoding='utf-8'), '')
        self.assertEqual(self.cms('update', {'id': 'one', 'data': {'title': ' 笔记 '}})[0], 200)
        self.assertEqual(self.cms('move', {'id': 'one', 'targetParentId': 'a'})[0], 200)

    def test_flat_names_follow_nested_folder_rename_and_move(self):
        """多级前缀随祖先改名及移动更新，只有根目录文档使用 root 前缀。"""
        self.add_node('a', 'Linux', 'folder')
        self.add_node('b', 'Shell', 'folder', parent='a')
        self.add_node('n', '基础命令', parent='b')
        self.cms('update', {'id': 'n', 'data': {'content': '保留正文\r\n第二行\r\n'}})
        original = self.md_path('基础命令', parents=['Linux', 'Shell'])
        self.assertTrue(os.path.isfile(original))
        self.assertEqual(self.cms('update', {'id': 'a', 'data': {'title': 'Unix'}})[0], 200)
        renamed = self.md_path('基础命令', parents=['Unix', 'Shell'])
        self.assertFalse(os.path.exists(original))
        self.assertEqual(Path(renamed).read_bytes(), '保留正文\r\n第二行\r\n'.encode())
        self.assertEqual(self.cms('move', {'id': 'b', 'targetParentId': 'root'})[0], 200)
        self.assertTrue(os.path.isfile(self.md_path('基础命令', parents=['Shell'])))
        self.assertFalse(os.path.exists(renamed))
        self.assertEqual(self.cms('move', {'id': 'n', 'targetParentId': 'root'})[0], 200)
        self.assertTrue(os.path.isfile(self.md_path('基础命令')))

    def test_flat_filename_collisions_do_not_overwrite(self):
        """连字符和非法字符清理造成的物理文件重名用编号兜底，保留各自正文。"""
        self.add_node('a', 'A-B', 'folder')
        self.add_node('b', 'A', 'folder')
        self.add_node('one', 'C', parent='a')
        self.cms('update', {'id': 'one', 'data': {'content': '第一篇'}})
        self.add_node('two', 'B-C', parent='b')
        self.cms('update', {'id': 'two', 'data': {'content': '第二篇'}})
        tree = self.fetch_tree()
        notes = {node['id']: node for node in cms.cms_store.walk(tree['root']) if node['type'] == 'note'}
        self.assertEqual(notes['one']['content'], 'markdown/notes/A-B-C.md')
        self.assertEqual(notes['two']['content'], 'markdown/notes/A-B-C (1).md')
        for identity, text in [('one', '第一篇'), ('two', '第二篇')]:
            self.assertEqual(Path(self.root_path(notes[identity]['content'])).read_text(encoding='utf-8'), text)

    def test_filename_changes_update_markdown_links_and_keep_code(self):
        """文件改名时更新普通链接、双链、引用式链接和跨模块路径，代码示例不变。"""
        self.add_node('folder', '旧目录', 'folder')
        self.add_node('target', '目标', parent='folder')
        self.add_node('source', '索引')
        body = ('[链接](旧目录-目标.md#段落)\n[[旧目录-目标]]\n'
                '[引用]: <旧目录-目标.md>\n<a href="旧目录-目标.md">目标</a>\n'
                '`[代码](旧目录-目标.md)`\n```md\n[[旧目录-目标]]\n```\n')
        self.cms('update', {'id': 'source', 'data': {'content': body}})
        self.add_node('cross', '跨模块', module='record')
        self.cms('update', {'id': 'cross', 'data': {'content': '[目标](../notes/旧目录-目标.md)'}}, module='record')
        self.assertEqual(self.cms('update', {'id': 'folder', 'data': {'title': '新目录'}})[0], 200)
        text = Path(self.md_path('索引')).read_text(encoding='utf-8')
        self.assertIn('[链接](新目录-目标.md#段落)', text)
        self.assertIn('[[新目录-目标|旧目录-目标]]', text)
        self.assertIn('[引用]: <新目录-目标.md>', text)
        self.assertIn('href="新目录-目标.md"', text)
        self.assertIn('`[代码](旧目录-目标.md)`', text)
        self.assertIn('```md\n[[旧目录-目标]]\n```', text)
        self.assertEqual(Path(self.md_path('跨模块', module='record')).read_text(encoding='utf-8'),
                         '[目标](../notes/新目录-目标.md)')

    def test_legacy_flat_names_migrate_once_and_roll_back_on_failure(self):
        """现有平铺文件按逻辑目录迁移，索引失败时恢复文件和链接，成功后重复执行不改路径。"""
        self.add_node('folder', 'Linux', 'folder')
        self.add_node('note', '命令', parent='folder')
        tree = self.fetch_tree()
        node = tree['root'][0]['children'][0]
        old = self.root_path('markdown/notes/命令.md')
        Path(old).write_bytes(b'original\r\n')
        os.remove(self.root_path(node['content']))
        node['content'] = 'markdown/notes/命令.md'
        cms.save_module_tree('notes', tree)
        with mock.patch.object(cms, 'save_module_tree', side_effect=OSError('index failed')):
            with self.assertRaises(OSError):
                cms_nodes.migrate_markdown_names('notes', cms.get_context())
        self.assertEqual(self.fetch_tree(), tree)
        self.assertEqual(Path(old).read_bytes(), b'original\r\n')
        self.assertFalse(os.path.exists(self.md_path('命令', parents=['Linux'])))
        changed = cms_nodes.migrate_markdown_names('notes', cms.get_context())
        self.assertEqual(changed, {'markdown/notes/命令.md': 'markdown/notes/Linux-命令.md'})
        self.assertFalse(os.path.exists(old))
        self.assertEqual(Path(self.md_path('命令', parents=['Linux'])).read_bytes(), b'original\r\n')
        self.assertEqual(cms_nodes.migrate_markdown_names('notes', cms.get_context()), {})

    def test_06_move_and_reorder_nodes(self):
        """节点跨文件夹移动 (move)、同级排序 (reorder) 及防循环引用校验"""
        self.add_node('f_a', '目录A', 'folder')
        self.add_node('n_1', '笔记1')
        self.add_node('n_2', '笔记2')

        self.assertEqual(self.cms('move', {'id': 'f_a', 'targetParentId': 'f_a'})[0], 400, "自我移动必须拦截")
        self.assertEqual(self.cms('move', {'id': 'n_1', 'targetParentId': 'f_a'})[0], 200)
        self.assertEqual(self.cms('reorder', {'ids': ['n_2', 'f_a']})[0], 200)

        tree = self.fetch_tree()
        self.assertEqual([n['id'] for n in tree['root']], ['n_2', 'f_a'])
        self.assertEqual(tree['root'][1]['children'][0]['id'], 'n_1')

    def test_07_move_into_descendant_rejected(self):
        """将文件夹移动到自己的子孙节点下必须被拦截，防止形成环"""
        self.add_node('f_parent', '父目录', 'folder')
        self.add_node('f_kid', '子目录', 'folder', parent='f_parent')
        code, _ = self.cms('move', {'id': 'f_parent', 'targetParentId': 'f_kid'})
        self.assertEqual(code, 400, "移动到子孙节点下未被拦截")
        self.assertEqual(self.fetch_tree()['root'][0]['id'], 'f_parent')

    def test_08_delete_folder_cascades(self):
        """删除文件夹时级联删除所有子孙节点及对应的物理 .md 文件"""
        self.add_node('f_del', '待删目录', 'folder')
        self.add_node('n_del', '待删子笔记', parent='f_del')
        self.assertTrue(os.path.exists(self.md_path('待删子笔记', parents=['待删目录'])))

        self.assertEqual(self.cms('delete', {'id': 'f_del'})[0], 200)
        self.assertFalse(os.path.exists(self.md_path('待删子笔记', parents=['待删目录'])))
        self.assertEqual(self.fetch_tree()['root'], [])

    def test_09_invalid_module_rejected(self):
        """非法 CMS 模块名请求返回 400"""
        for mod in ('invalid_mod', '../notes', ''):
            with self.subTest(module=mod):
                code, _ = self.call_get('/api/cms/fetch', {'module': [mod]})
                self.assertEqual(code, 400)

    # ---------- 加解锁 ----------

    def test_10_lock_and_unlock_node(self):
        """加锁保留本地明文 .md 并标记 _private；解锁清除 _private 标记"""
        self.add_node('n_sec', '机密文档')
        self.cms('update', {'id': 'n_sec', 'data': {'content': '机密正文内容'}})
        md = self.md_path('机密文档')
        self.assertTrue(os.path.exists(md))

        self.assertEqual(self.cms('lock', {'id': 'n_sec', 'enc': 'enc:iv123.cipher456', 'covers': []})[0], 200)
        self.assertTrue(os.path.exists(md), "方案3下加锁后本地物理 .md 文件必须保留")
        locked = self.fetch_tree()['root'][0]
        self.assertTrue(locked.get('_private'), "加锁节点应标记 _private")
        self.assertEqual(locked['title'], '机密文档')

        code, _ = self.cms('unlock', {'id': 'n_sec', 'tree': {
            'id': 'n_sec', 'type': 'note', 'title': '机密文档', 'tags': ['私密'], 'md': '机密正文内容'
        }})
        self.assertEqual(code, 200)
        unlocked = self.fetch_tree()['root'][0]
        self.assertFalse(unlocked.get('_private'), "解锁后清除 _private 标记")
        self.assertTrue(os.path.exists(md))
        with open(md, encoding='utf-8') as f:
            self.assertEqual(f.read(), '机密正文内容')

    def test_lock_media_check_ignores_unrelated_missing_markdown(self):
        """其他节点正文文件缺失不得阻断本节点加密；被加密节点自身缺失则明确拒绝。"""
        from services import cms_covers
        self.add_node('n_bad', '缺失正文')
        self.add_node('n_ok', '正常文档')
        self.cms('update', {'id': 'n_ok', 'data': {'content': '正文'}})
        os.remove(self.md_path('缺失正文'))
        cms_covers.validate_lock_media('notes', 'n_ok', [])
        with self.assertRaisesRegex(ValueError, '正文文件缺失'):
            cms_covers.validate_lock_media('notes', 'n_bad', [])

    def test_11_lock_and_unlock_with_private_cover_r2_migration(self):
        """加锁时封面三尺寸图像迁入私有 R2 桶并从公开库抹除，解锁时完整迁回"""
        up = self.upload_png('_notes', 'cover.png', (30, 140, 90))
        tiers = (up['path'], up['thumb'], up['preview'])

        self.add_node('n_cov', '带封面的私密笔记')
        self.cms('update', {'id': 'n_cov', 'data': {'content': '私密正文', 'coverImage': up['path']}})
        cover_rows = album_lock.rows_by_paths([up['path']])
        self.assertEqual(len(cover_rows), 1)

        self.assertEqual(self.cms('lock', {'id': 'n_cov', 'enc': 'enc:iv_cov.cipher_cov', 'covers': [up['path']]})[0], 200)
        for k in tiers:
            self.assertIn(k, self.mock_s3.buckets['priv-bucket'], f"封面文件未迁入私有桶: {k}")
        for k in tiers[1:]:
            self.assertTrue(os.path.exists(self.root_path(k)), f"加锁后本地封面文件保留原目录: {k}")
        self.assertEqual(album_lock.rows_by_paths([up['path']]), [], "加锁后 gallery.db 仍残留私密封面行")

        self.assertTrue(os.path.exists(self.root_path(up['path'])), 'CMS 加锁后本机原图保留原目录')
        code, _ = self.cms('unlock', {'id': 'n_cov', 'tree': {
            'id': 'n_cov', 'type': 'note', 'title': '带封面的私密笔记', 'tags': [],
            'coverImage': up['path'], 'coverRow': cover_rows[0], 'md': '私密正文'
        }})
        self.assertEqual(code, 200)
        self.assertIn(up['path'], self.mock_s3.buckets['pub-bucket'])
        for k in tiers:
            self.assertTrue(os.path.isfile(self.root_path(k)), f"解锁后本地封面文件未恢复: {k}")
            self.assertNotIn(k, self.mock_s3.buckets['priv-bucket'], f"解锁后私有桶未清理封面副本: {k}")
        self.assertEqual(len(album_lock.rows_by_paths([up['path']])), 1, "解锁后 gallery.db 未恢复封面记录")

    def test_12_delete_locked_node_purges_private_covers(self):
        """删除加锁节点时，purge_private 同步销毁私有 R2 桶中的封面副本"""
        priv_keys = ['photos/images/_notes/sec_1.avif',
                     'photos/thumbnails/_notes/sec_1.webp',
                     'photos/previews/_notes/sec_1.avif']
        for k in priv_keys:
            self.mock_s3.put_object(Bucket='priv-bucket', Key=k, Body=b'SECRET_IMG')

        self.add_node('n_del_sec', '待删私密节点')
        self.cms('lock', {'id': 'n_del_sec', 'enc': 'enc:iv.del', 'covers': []})
        self.assertEqual(self.cms('delete', {'id': 'n_del_sec', 'purge_private': priv_keys})[0], 200)
        leftover = [k for k in priv_keys if k in self.mock_s3.buckets['priv-bucket']]
        self.assertEqual(leftover, [], f"删除加密节点后私有桶残留文件: {leftover}")

    def test_13_open_external_and_path_traversal_guard(self):
        """open_external 唤起外部软件打开物理 .md，并拦截不存在节点与路径穿越"""
        self.add_node('n_ext', '外部软件直连测试')
        expected_md = os.path.abspath(self.md_path('外部软件直连测试'))
        tree = self.fetch_tree()
        tree['root'].append({'id': 'n_evil', 'type': 'note', 'title': 'Evil',
                             'content': '../../evil.md', 'tags': []})
        cms.save_module_tree('notes', tree)

        opened = []
        cms_nodes._EXTERNAL_OPEN_HOOK = opened.append
        self.addCleanup(setattr, cms_nodes, '_EXTERNAL_OPEN_HOOK', None)

        code, res = self.cms('open_external', {'id': 'n_ext'})
        self.assertEqual((code, res.get('status')), (200, 'success'))
        self.assertEqual(opened, [expected_md])

        self.assertEqual(self.cms('open_external', {'id': 'non_existent'})[0], 400)
        self.assertEqual(self.cms('open_external', {'id': 'n_evil'})[0], 400, "open_external 未拦截路径穿越")
        self.assertEqual(len(opened), 1, "恶意路径不应触发外部打开钩子")

    # ---------- 标签系统 ----------

    def test_14_granular_update_tags(self):
        """POST /api/cms/update_tags 精确更新单个节点的标签列表"""
        self.add_node('n_tag', '标签测试')
        self.update_tags('n_tag', ['Python', 'SQLite'])
        self.assertEqual(self.fetch_tree()['root'][0]['tags'], ['Python', 'SQLite'])

    def test_15_tag_categories_roundtrip(self):
        """标签分类配置读写往返一致"""
        cats = [{'name': '编程语言', 'tags': ['Python', 'JavaScript', 'Rust']}]
        self.save_tag_categories(cats)
        self.assertEqual(self.tag_categories(), cats)

    def test_16_rename_tag_globally(self):
        """全局重命名节点标签与分类配置，合并同名时自动去重"""
        self.save_tag_categories([{'name': '技术', 'tags': ['JS', 'ES6']}])
        self.add_node('n_rt', '标签重命名')
        self.update_tags('n_rt', ['JS', '前端'])

        code, res = self.call_post('/api/cms/rename_tag', {'module': ['notes']}, {'old_name': 'JS', 'new_name': 'ES6'})
        self.assertEqual(code, 200)
        self.assertTrue(res.get('success'))
        self.assertEqual(self.tag_categories()[0]['tags'], ['ES6'], "重命名合并同名标签时应自动去重")
        tags = self.fetch_tree()['root'][0]['tags']
        self.assertIn('ES6', tags)
        self.assertNotIn('JS', tags)

    def test_17_delete_tag_globally(self):
        """从所有节点与标签分类配置中移除指定标签"""
        self.save_tag_categories([{'name': '技术', 'tags': ['待删标签', '保留标签']}])
        self.add_node('n_dt', '标签删除测试')
        self.update_tags('n_dt', ['待删标签', '保留标签'])

        code, _ = self.call_post('/api/cms/delete_tag', {'module': ['notes']}, {'tag_name': '待删标签'})
        self.assertEqual(code, 200)
        self.assertEqual(self.tag_categories()[0]['tags'], ['保留标签'])
        self.assertEqual(self.fetch_tree()['root'][0]['tags'], ['保留标签'])

    def test_18_cleanup_unused_tags(self):
        """清理未被引用的闲置标签并保留空分类结构"""
        self.save_tag_categories([
            {'name': '常用', 'tags': ['在用标签', '闲置标签1']},
            {'name': '空分类测试', 'tags': ['闲置标签2']},
        ])
        self.add_node('n_clean', '在用节点')
        self.update_tags('n_clean', ['在用标签'])

        code, res = self.call_post('/api/cms/cleanup_tags', {'module': ['notes']}, {})
        self.assertEqual(code, 200)
        self.assertEqual(res['removed_count'], 2)
        cats = self.tag_categories()
        self.assertEqual(cats[0]['tags'], ['在用标签'])
        self.assertEqual(cats[1]['tags'], [], "空分类外壳应被保留")
