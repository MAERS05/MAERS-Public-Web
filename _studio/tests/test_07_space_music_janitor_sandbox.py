# -*- coding: utf-8 -*-
"""套件 07：隔离沙盒下 Space、Music、动态建页安全、密钥环防覆盖与 Janitor 垃圾清理"""

import os

from .sandbox import SandboxTestCase
from services import cms
import config


class Test07_SpaceMusicPortalAndJanitorSandbox(SandboxTestCase):
    """在隔离沙盒中测试 Space、Music、动态建页路径穿越防御、密钥环与 Janitor 垃圾清理"""

    def clean_data(self):
        code, res = self.call_post('/api/admin/clean_data')
        self.assertEqual(code, 200, res)
        self.assertTrue(res.get('success'), res)
        return res

    def write_file(self, abs_file, data):
        os.makedirs(os.path.dirname(abs_file), exist_ok=True)
        mode = 'wb' if isinstance(data, bytes) else 'w'
        with open(abs_file, mode, **({} if mode == 'wb' else {'encoding': 'utf-8'})) as f:
            f.write(data)
        return abs_file

    # ---------- Space ----------

    def test_01_space_collections_crud_and_reorder(self):
        """Space 收藏项新增、更新、排序、删除与持久化"""
        for sid, title, url in (('sp_1', 'GitHub', 'https://github.com'),
                                ('sp_2', 'MDN', 'https://developer.mozilla.org')):
            code, _ = self.call_post('/api/space/add', body={'id': sid, 'title': title, 'url': url, 'category': 'dev'})
            self.assertEqual(code, 200)

        self.assertEqual(self.call_post('/api/space/update', body={'id': 'sp_1', 'data': {'title': 'GitHub Code'}})[0], 200)
        self.assertEqual(self.call_post('/api/space/reorder', body={'ids': ['sp_2', 'sp_1']})[0], 200)

        _, cols = self.call_get('/api/space/collections')
        items = cols.get('items', cols) if isinstance(cols, dict) else cols
        self.assertGreaterEqual(len(items), 2)

        self.assertEqual(self.call_post('/api/space/delete', body={'id': 'sp_1'})[0], 200)

    def test_02_space_tree_and_tag_ops(self):
        """save_tree 与 update_tags 更新节点标签并支持标签清理"""
        tree = {'root': [{'id': 'sn_1', 'type': 'item', 'title': '工具站', 'tags': ['AI', '设计']}]}
        self.assertEqual(self.call_post('/api/space/save_tree', body=tree)[0], 200)
        self.assertEqual(self.call_post('/api/space/update_tags', body={'id': 'sn_1', 'tags': ['AI']})[0], 200)

        self.call_post('/api/cms/save_tag_categories', {'module': ['space']}, [{'name': '领域', 'tags': ['AI', '废弃标签']}])
        _, res = self.call_post('/api/cms/cleanup_tags', {'module': ['space']}, {})
        self.assertEqual(res['removed_tags'], ['废弃标签'])

    # ---------- Music ----------

    def test_03_music_save_delete_and_reset_tracks(self):
        """Music 保存、单曲剔除 (delete_track) 与专辑分 P 重置 (reset_tracks)"""
        sample = [{'category': 'OST', 'collections': [{'name': 'Game OST', 'albums': [{
            'title': 'Album 1', 'total': 3, 'bili_total': 3,
            'page_mapping': [1, 2, 3], 'custom_parts': ['Track 1', 'Track 2', 'Track 3'],
        }]}]}]
        idx = {'catIdx': 0, 'colIdx': 0, 'albIdx': 0}
        self.assertEqual(self.call_post('/api/save_music', body=sample)[0], 200)

        self.assertEqual(self.call_post('/api/delete_track', body={**idx, 'trackIdx': 1})[0], 200)
        alb = self.call_get('/api/music_data')[1][0]['collections'][0]['albums'][0]
        self.assertEqual((alb['total'], alb['page_mapping']), (2, [1, 3]))

        self.assertEqual(self.call_post('/api/reset_tracks', body=idx)[0], 200)
        self.assertEqual(self.call_get('/api/music_data')[1][0]['collections'][0]['albums'][0]['total'], 3)

    # ---------- 门户与建页 ----------

    def test_04_portal_modules_and_index_cards_save(self):
        """save_modules、save_index_cards 与 save_changelog 正常持久化"""
        self.assertEqual(self.call_post('/api/save_modules', body=[{'id': 'm1', 'title': 'Mod 1', 'url': 'notes.html'}])[0], 200)
        self.assertEqual(self.call_get('/api/modules')[1][0]['id'], 'm1')
        self.assertEqual(self.call_post('/api/save_index_cards', body=[{'id': 'c1', 'title': 'Card 1', 'url': 'notes.html'}])[0], 200)
        self.assertEqual(self.load_json(config.INDEX_CARDS_JSON)[0]['id'], 'c1')
        self.assertEqual(self.call_post('/api/save_changelog', body=[{'date': '2026-10-19', 'entries': ['Test']}])[0], 200)
        self.assertEqual(len(self.call_get('/api/changelog')[1]), 1)

    def test_05_page_provisioning_and_delete(self):
        """ensure_page 基于模板生成带 flash-guard.js 的 HTML，delete_page 物理删除"""
        code, res = self.call_post('/api/ensure_page', body={'filename': 'custom-page.html', 'title': 'Custom'})
        self.assertEqual((code, res['status']), (200, 'created'))
        page = self.root_path('custom-page.html')
        with open(page, encoding='utf-8') as f:
            self.assertIn('shared/flash-guard.js', f.read())

        self.assertEqual(self.call_post('/api/delete_page', body={'filename': 'custom-page.html'})[0], 200)
        self.assertFalse(os.path.exists(page))

    def test_06_page_provisioning_blocks_path_traversal(self):
        """ensure_page 与 delete_page 严格拦截路径穿越与非 .html 文件"""
        for bad in ('../evil.html', 'sub/page.html', '..\\hack.html', 'script.py', '', 'C:/evil.html'):
            with self.subTest(filename=bad):
                self.assertEqual(self.call_post('/api/ensure_page', body={'filename': bad})[0], 400)
                self.assertEqual(self.call_post('/api/delete_page', body={'filename': bad})[0], 400)

    # ---------- 密钥环 ----------

    def test_07_keyring_validation_and_overwrite_protection(self):
        """密钥环结构校验，未指定 force 时拦截更换 dek_id 的覆盖操作 (409)"""
        valid = {
            'v': 1, 'dek_id': '0123456789abcdef',
            'pw': {'salt': 'c2FsdDEyMzQ=', 'iter': 100000, 'wrap': 'enc:iv.cipher1'},
            'rc': {'salt': 'c2FsdDU2Nzg=', 'iter': 100000, 'wrap': 'enc:iv.cipher2'},
            'media_base': 'https://media.example.com', 'updated': 1700000000,
        }
        self.assertEqual(self.call_post('/api/crypto/keyring', body={'v': 1, 'dek_id': 'bad'})[0], 400)
        self.assertEqual(self.call_post('/api/crypto/keyring', body=dict(valid))[0], 200)
        conflict = dict(valid, dek_id='fedcba9876543210')
        self.assertEqual(self.call_post('/api/crypto/keyring', body=conflict)[0], 409)
        self.assertEqual(self.load_json(self.data_path('crypto-keyring.json'))['dek_id'], valid['dek_id'],
                         "409 拦截后原密钥环不得被改写")
        self.assertEqual(self.call_post('/api/crypto/keyring', body=dict(conflict, force=True))[0], 200)

    # ---------- Janitor ----------

    def test_08_janitor_preserves_referenced_assets(self):
        """Janitor 完整保留被 Markdown 正文引用的图片与正常 .md 文档"""
        self.add_node('n_keep', '保留笔记')
        kept = self.write_file(os.path.join(self.temp_photos, 'images', '_notes', 'referenced_diagram.png'), b'PNG_DATA')
        self.cms('update', {'id': 'n_keep', 'data': {'content': '![图](photos/images/_notes/referenced_diagram.png)'}})

        self.clean_data()
        self.assertTrue(os.path.isfile(kept), "被 Markdown 引用的图片不应被误删")
        self.assertTrue(os.path.isfile(self.data_path('notes', '保留笔记.md')))

    def test_09_janitor_purges_orphan_attachments(self):
        """Janitor 精确物理删除未被引用的 _notes 孤儿附件"""
        orphan = self.write_file(os.path.join(self.temp_photos, 'images', '_notes', 'unused_paste.png'), b'ORPHAN')
        res = self.clean_data()
        self.assertFalse(os.path.exists(orphan), "未被任何 .md 引用的孤儿附件应被清理")
        self.assertGreaterEqual(res['deleted_files_count'], 1)

    def test_10_janitor_purges_orphan_md_and_ghost_db_records(self):
        """Janitor 清理未在 cms.db 注册的孤儿 .md，并清除 gallery.db 幽灵记录"""
        orphan_md = self.write_file(self.data_path('notes', '孤儿文档.md'), '未被索引的内容')
        self.insert_gallery_row(id='ghost_1', category='travel', name='missing.jpg',
                                path='photos/images/travel/missing.jpg', thumb='', preview='',
                                hash='h1', created_at=0, sort_order=0)
        from services import photos
        photos.sync_gallery_js()
        res = self.clean_data()
        self.assertFalse(os.path.exists(orphan_md), "未在 cms.db 注册的孤儿 .md 应被清理")
        self.assertGreaterEqual(res['deleted_files_count'], 1)
        self.assertEqual(res['db_fixes_count'], 0)
        self.assertTrue(self.gallery_json(), '本地缺图不能删除图库真源')
        from services import data_safety
        data_safety.restore_trash(res['quarantine_batch'])
        self.assertTrue(os.path.isfile(orphan_md))

    def test_11_janitor_preserves_encrypted_data(self):
        """Janitor 完整保留加密 CMS 节点密文 (_enc) 与加密相册配置"""
        self.add_node('n_locked_jan', '加密笔记')
        self.cms('lock', {'id': 'n_locked_jan', 'enc': 'enc:iv_janitor.cipher_janitor_keep', 'covers': []})
        cms.save_json(config.ALBUM_CONFIG_JSON, [{'_enc': 'enc:iv_alb.cipher_alb'}])

        self.clean_data()
        root = self.fetch_tree()['root']
        self.assertEqual(len(root), 1)
        self.assertEqual((root[0]['type'], root[0]['_enc']), ('locked', 'enc:iv_janitor.cipher_janitor_keep'))
        self.assertEqual(self.album_config(), [{'_enc': 'enc:iv_alb.cipher_alb'}])

    def test_12_janitor_is_idempotent(self):
        """Janitor 连续执行两次：第二次不再删除任何文件或修复任何记录"""
        self.add_node('n_idem', '幂等笔记')
        self.write_file(os.path.join(self.temp_photos, 'images', '_notes', 'orphan.png'), b'X')
        self.clean_data()
        res = self.clean_data()
        self.assertEqual(res['deleted_files_count'], 0, "第二次清理不应再删除文件")
        self.assertEqual(res.get('db_fixes_count', 0), 0, "第二次清理不应再修复记录")
        self.assertTrue(os.path.isfile(self.data_path('notes', '幂等笔记.md')))
