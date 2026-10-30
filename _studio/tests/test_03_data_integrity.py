# -*- coding: utf-8 -*-
"""套件 03：data/ JSON 快照、SQLite Schema 与物理 .md 一致性（只读）"""

import os
import pathlib
import sqlite3
import unittest
import json

from .helpers import CMS_MODULES, abs_path, exists, list_files_by_ext, read_json


def publication_issues(root):
    """只读发布门禁：本机事务、云端待办及凭据撤销均须完成。"""
    local = pathlib.Path(root) / '_studio' / '.local'
    issues = []
    if list((local / 'transactions').glob('*/manifest.json')):
        issues.append('存在未恢复或未收尾的文件事务')
    if (local / 'rotation-pending.json').exists():
        issues.append('新数据密钥的私密图片令牌尚未确认撤销旧值')
    outbox = local / 'media-outbox.json'
    if outbox.exists():
        try:
            with outbox.open(encoding='utf-8') as source:
                jobs = json.load(source)
            if not isinstance(jobs, list) or jobs:
                issues.append('存在未完成的媒体同步任务')
        except (OSError, ValueError):
            issues.append('媒体待办无法读取')
    return issues


def _table_columns(db_rel, table):
    """只读方式打开 SQLite，返回表字段集合（避免误建空库）"""
    uri = pathlib.Path(abs_path(db_rel)).as_uri() + '?mode=ro'
    conn = sqlite3.connect(uri, uri=True)
    try:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    finally:
        conn.close()


def _local_url(url):
    """剥离 query，远程链接返回空串"""
    url = (url or '').split('?')[0]
    return '' if url.startswith(('http://', 'https://', '//')) else url


class Test03_DataAndStorageIntegrity(unittest.TestCase):
    """验证 data/ 目录下的 JSON 快照、SQLite 数据库 Schema 与物理 .md 文件的一致性"""

    def test_13_publication_requires_completed_recovery_and_media(self):
        self.assertEqual(publication_issues(abs_path('')), [], '数据恢复或同步未完成，禁止发布')

    def test_01_all_data_json_valid(self):
        """data/ 与 data/tags/ 下所有 .json 文件均为合法 UTF-8 JSON"""
        json_files = list_files_by_ext('data', '.json')
        self.assertGreaterEqual(len(json_files), 15)
        for rel in json_files:
            with self.subTest(file=rel):
                try:
                    read_json(rel)
                except Exception as e:
                    self.fail(f"{rel} JSON 解析失败: {e}")

    def test_02_cms_tree_snapshots_structure(self):
        """五大 CMS 模块的 *-tree.json 均具备合法的 {'root': [...]} 结构"""
        for mod in CMS_MODULES:
            with self.subTest(module=mod):
                tree = read_json(f"data/{mod}-tree.json")
                self.assertIsInstance(tree, dict)
                self.assertIsInstance(tree.get('root'), list, f"{mod}-tree.json 缺少 root 数组")

    def test_03_cms_tree_md_files_exist(self):
        """各模块 *-tree.json 中所有未加密笔记节点的 .md 路径在磁盘上真实存在，且节点 id 全局唯一"""
        for mod in CMS_MODULES:
            seen_ids = set()
            stack = list(read_json(f"data/{mod}-tree.json").get('root', []))
            while stack:
                node = stack.pop()
                node_id = node.get('id')
                if node_id:
                    with self.subTest(module=mod, id=node_id):
                        self.assertNotIn(node_id, seen_ids, f"[{mod}] 节点 id 重复: {node_id}")
                    seen_ids.add(node_id)
                if node.get('_enc') or node.get('type') == 'locked':
                    continue
                content = str(node.get('content') or '')
                if content.endswith('.md'):
                    with self.subTest(module=mod, md=content):
                        self.assertTrue(exists(f"data/{content}"),
                                        f"[{mod}] 节点 '{node.get('title')}' 引用的物理文件缺失: data/{content}")
                stack.extend(node.get('children') or [])

    def test_04_cms_sqlite_schema(self):
        """data/cms.db 的 nodes 表结构完整且可读"""
        if not exists('data/cms.db'):
            return  # 缓存可缺失；重建能力在隔离沙盒中验证。
        cols = _table_columns('data/cms.db', 'nodes')
        expected = {'id', 'module', 'parent_id', 'type', 'title', 'content', 'tags', 'sort_order', 'coverImage'}
        self.assertFalse(expected - cols, f"cms.db nodes 表缺少字段: {expected - cols}")

    def test_05_gallery_sqlite_schema(self):
        """data/gallery.db 的 photos 表结构完整且可读"""
        if not exists('data/gallery.db'):
            return
        cols = _table_columns('data/gallery.db', 'photos')
        expected = {'id', 'category', 'name', 'path', 'thumb', 'preview', 'hash', 'created_at', 'sort_order', 'tags'}
        self.assertFalse(expected - cols, f"gallery.db photos 表缺少字段: {expected - cols}")

    def test_06_tag_category_files_naming_and_format(self):
        """data/tags/ 下的配置文件符合命名规范且内容为合法分类列表"""
        tag_files = list_files_by_ext('data/tags', '.json')
        self.assertGreaterEqual(len(tag_files), 5)
        for rel in tag_files:
            with self.subTest(file=rel):
                self.assertTrue(os.path.basename(rel).endswith('-tag-categories.json'), f"标签配置文件命名不规范: {rel}")
                self.assertIsInstance(read_json(rel), list, f"{rel} 顶层应为数组")

    def _assert_cards_valid(self, rel):
        cards = read_json(rel)
        self.assertIsInstance(cards, list)
        self.assertGreater(len(cards), 0)
        for card in cards:
            if card.get('_enc'):
                continue
            for field in ('url', 'icon', 'style'):
                target = _local_url(card.get(field))
                if target:
                    with self.subTest(file=rel, field=field, target=target):
                        self.assertTrue(exists(target), f"{rel} 的 {field} 引用了不存在的文件: {target}")

    def test_07_admin_portal_cards_valid(self):
        """data/admin-portal.json 中所有卡片的 url / icon / style 均指向真实文件"""
        self._assert_cards_valid('data/admin-portal.json')

    def test_08_index_cards_valid(self):
        """data/index-cards.json 中所有首页卡片的 url / icon 均指向真实文件"""
        self._assert_cards_valid('data/index-cards.json')

    def test_09_album_config_valid(self):
        """data/album-config.json 格式合法，每个条目具备 id 或 _enc，且 id 不重复"""
        albums = read_json('data/album-config.json')
        self.assertIsInstance(albums, list)
        ids = [a.get('id') for a in albums if a.get('id')]
        self.assertEqual(len(ids), len(set(ids)), "album-config.json 存在重复 id")
        for item in albums:
            self.assertTrue(item.get('id') or item.get('_enc'), "album-config.json 存在既无 id 也无 _enc 的无效条目")

    def test_10_space_data_valid(self):
        """data/space-tree.json 与 data/tags/space-tag-categories.json 结构合法"""
        self.assertIsInstance(read_json('data/space-tree.json').get('root'), list)
        self.assertIsInstance(read_json('data/tags/space-tag-categories.json'), list)

    def test_11_music_data_valid(self):
        """data/music-data.json 结构合法"""
        self.assertIsInstance(read_json('data/music-data.json'), list)

    @unittest.skipUnless(exists('data/crypto-keyring.json'), "未配置加密密钥环")
    def test_12_keyring_json_contract(self):
        """data/crypto-keyring.json 只包含访客解锁需要的字段"""
        kr = read_json('data/crypto-keyring.json')
        self.assertEqual(kr.get('v'), 1)
        for key in ('dek_id', 'pw'):
            self.assertIn(key, kr)
