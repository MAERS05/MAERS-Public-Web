# -*- coding: utf-8 -*-
"""套件 02：PWA 清单、Service Worker 三级版本控制与离线下载契约（只读）"""

import os
import re
import unittest

from .helpers import OFFLINE_DOWNLOAD_JS, VISITOR_PAGES, abs_path, exists, read_json, read_text

SW_FILE = 'maers-version-controller.js'
# 可选文件：未配置加密时不存在，允许缺失
OPTIONAL_OFFLINE_ASSETS = {'data/crypto-keyring.json'}


def _framework_assets():
    """解析 offline-download.js 中 FRAMEWORK 数组的全部资源路径"""
    match = re.search(r'const\s+FRAMEWORK\s*=\s*\[([\s\S]*?)\];', read_text(OFFLINE_DOWNLOAD_JS))
    return re.findall(r'[\'"]([^\'"]+)[\'"]', match.group(1)) if match else None


class Test02_PwaAndCacheContracts(unittest.TestCase):
    """PWA 应用清单、Service Worker 三级版本控制与离线缓存契约"""

    @classmethod
    def setUpClass(cls):
        cls.sw = read_text(SW_FILE)
        cls.od = read_text(OFFLINE_DOWNLOAD_JS)

    def test_01_manifest_json_valid(self):
        """manifest.json 结构合法，声明的图标与 start_url 真实存在"""
        manifest = read_json('manifest.json')
        for key in ('name', 'icons', 'start_url'):
            self.assertIn(key, manifest)
        for icon in manifest['icons']:
            src = icon['src'].lstrip('./')
            with self.subTest(icon=src):
                self.assertTrue(exists(src), f"manifest.json 图标缺失: {src}")
        start = manifest['start_url'].split('?')[0].lstrip('./') or 'index.html'
        self.assertTrue(exists(start), f"manifest.json start_url 指向不存在的页面: {start}")

    def test_02_sw_version_config_structure(self):
        """Service Worker 包含完整的 default、groups、files 三级版本配置"""
        for token in ('const VERSION_CONFIG =', 'default:', 'groups:', 'files:', 'function resolveVersion(pathname)'):
            with self.subTest(token=token):
                self.assertIn(token, self.sw)

    def test_03_sw_group_paths_exist(self):
        """Service Worker groups 配置的所有路径前缀在磁盘上全部存在"""
        blocks = re.findall(r'paths:\s*\[([^\]]+)\]', self.sw)
        self.assertGreaterEqual(len(blocks), 10)
        for block in blocks:
            for p in re.findall(r'[\'"]([^\'"]+)[\'"]', block):
                with self.subTest(path=p):
                    self.assertTrue(exists(p.strip('/')), f"Service Worker 分组路径不存在: {p}")

    def test_04_sw_offline_fallback_contract(self):
        """Service Worker 包含 ignoreVary 与 ignoreSearch 离线缓存匹配回退逻辑"""
        for token in ('ignoreVary: true', 'ignoreSearch: true', "caches.match('/index.html'"):
            with self.subTest(token=token):
                self.assertIn(token, self.sw)

    def test_05_offline_framework_files_exist(self):
        """offline-download.js FRAMEWORK 列表中每一个静态资源 100% 真实存在且无重复"""
        assets = _framework_assets()
        self.assertIsNotNone(assets, "offline-download.js 未找到 FRAMEWORK 数组")
        self.assertGreaterEqual(len(assets), 90)
        dups = sorted({a for a in assets if assets.count(a) > 1})
        self.assertEqual(dups, [], f"FRAMEWORK 存在重复条目: {dups}")
        for rel in assets:
            rel_clean = 'index.html' if rel == '/' else rel.lstrip('/')
            if rel_clean in OPTIONAL_OFFLINE_ASSETS:
                continue
            with self.subTest(asset=rel):
                self.assertTrue(os.path.isfile(abs_path(rel_clean)), f"FRAMEWORK 包含不存在的文件: {rel}")

    def test_06_offline_visitor_pages_coverage(self):
        """所有前台访客 .html 页面均已纳入离线缓存列表"""
        missing = [p for p in VISITOR_PAGES if f"'/{p}'" not in self.od]
        self.assertEqual(missing, [], f"访客页面未加入离线缓存清单: {missing}")

    def test_07_offline_core_assets_coverage(self):
        """shared/、static-style/、移动端适配核心前台文件均已纳入离线缓存列表"""
        required = ('shared/flash-guard.js', 'shared/theme.module.js', 'static-style/theme.css',
                    'custom/zmobile adaptation/mobile-global.css')
        missing = [r for r in required if f"'/{r}'" not in self.od]
        self.assertEqual(missing, [], f"核心前台资产未加入离线缓存清单: {missing}")

    def test_08_offline_light_mode_adaptation(self):
        """offline-download.js 包含 html.light-mode 浅色模式按钮与面板样式适配"""
        self.assertIn('html.light-mode .od-btn', self.od)
        self.assertIn('html.light-mode .od-sheet', self.od)

    def test_09_offline_dual_key_caching(self):
        """offline-download.js 实现原始路径与版本化路径双 Key 缓存写入"""
        self.assertIn('await cache.put(u, r.clone())', self.od)
        self.assertIn('await cache.put(r.url, r)', self.od)

    def test_10_flash_guard_pwa_and_offline_injection(self):
        """shared/flash-guard.js 自动注入 manifest.json、Service Worker 与 offline-download.js"""
        fg = read_text('shared/flash-guard.js')
        for token in ('manifest.json', SW_FILE, 'offline-download.js'):
            with self.subTest(token=token):
                self.assertIn(token, fg)
