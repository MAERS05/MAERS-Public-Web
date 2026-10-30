# -*- coding: utf-8 -*-
"""套件 04：前端零全局污染、适配器双轨权限、架构边界守卫与 E2EE 门面契约（只读）"""

import re
import unittest

from .helpers import abs_path, business_js_files, list_files_by_ext, module_exports, read_text, strip_js_comments


def _clean(rel):
    return strip_js_comments(read_text(rel))


class Test04_FrontendArchitectureContracts(unittest.TestCase):
    """前端零全局污染、适配器双轨权限、三模标签筛选、内链拦截与 E2EE 契约"""

    ALLOWED_GLOBAL_MOUNT = {'Toast', 'Theme', 'ModuleConfig', 'Config'}

    # 业务层禁止直接触达的底层实现（必须经由 data-manage 门面）
    FORBIDDEN_CRYPTO_TOKENS = ('crypto.subtle', 'keyring.module.js', "startsWith('enc:')", 'startsWith("enc:")')
    FORBIDDEN_SYNC_MODULES = ('cloudflare-relay.module.js', 'github-sync.module.js',
                              'git-commit.module.js', 'cloudflare-worker-sync.js')

    def test_01_zero_global_pollution_contract(self):
        """业务模块 custom/ 不向 window.MAERS 违规挂载未授权属性"""
        mount_re = re.compile(r'window\.MAERS\.([A-Za-z0-9_]+)\s*=(?!=)')
        for rel in list_files_by_ext('custom', '.js'):
            if rel == 'custom/config.js':
                continue
            for prop in mount_re.findall(_clean(rel)):
                with self.subTest(file=rel, prop=prop):
                    self.assertIn(prop, self.ALLOWED_GLOBAL_MOUNT, f"{rel} 违规向 window.MAERS 挂载了属性: {prop}")

    def test_02_adapter_dual_permission_lock(self):
        """访客端 Photos 与 Space 初始化适配器时显式锁定 IS_ADMIN: false"""
        for rel in ('custom/photos/main.module.js', 'custom/space/viewer/space-view.module.js'):
            with self.subTest(file=rel):
                self.assertRegex(_clean(rel), r'IS_ADMIN\s*:\s*false', f"{rel} 访客端未显式锁定 IS_ADMIN: false")

    def test_03_tag_filter_three_modes(self):
        """标签筛选引擎与两个适配器完整支持 AND、OR、DEL 三种筛选模式"""
        for rel in ('custom/cms/viewer/tags/cms-tags-filter.module.js',
                    'custom/photos/admin/photos-cms-adapter.module.js',
                    'custom/space/admin/space-cms-adapter.module.js'):
            with self.subTest(file=rel):
                self.assertIn("'DEL'", read_text(rel), f"{rel} 缺少 DEL 排除模式支持")

    def test_04_md_internal_link_interceptor(self):
        """cms-reader.module.js 包含 _interceptMdLinks 本地 .md 链接无刷新拦截逻辑"""
        code = read_text('custom/cms/viewer/cms-reader.module.js')
        self.assertIn('_interceptMdLinks', code)
        self.assertIn(".endsWith('.md')", code)

    def test_05_cross_module_open_note_support(self):
        """CMS 各模块访客入口与管理入口均支持 ?openNote= 跨模块深度链接跳转"""
        for rel in ('custom/cms/main.module.js', 'custom/cms/admin-main.module.js',
                    'custom/literature/main.module.js', 'custom/games/main.module.js',
                    'custom/videos/main.module.js'):
            with self.subTest(file=rel):
                self.assertIn('openNote', read_text(rel), f"{rel} 缺少 ?openNote= 跨模块跳转支持")

    def test_06_reader_dynamic_outline_support(self):
        """阅读器生命周期模块包含 H1-H6 动态目录大纲提取与平滑跳转逻辑"""
        code = read_text('custom/cms/viewer/cms-reader-lifecycle.module.js')
        self.assertIn('h1, h2, h3, h4, h5, h6', code.lower())
        self.assertIn('scrollIntoView', code)

    def test_07_web_crypto_e2ee_contract(self):
        """crypto.module.js 采用 AES-GCM 256 位与 PBKDF2 SHA-256 并导出 ENC_FIELD"""
        code = read_text('data-manage/encrypt/crypto.module.js')
        for token in ("'AES-GCM'", '256', "'PBKDF2'", "export const ENC_FIELD = '_enc'"):
            with self.subTest(token=token):
                self.assertIn(token, code)

    def test_08_private_media_blob_decryption_contract(self):
        """private-media.module.js 实现私密相册分类解密与私有桶签名 URL 构造"""
        code = read_text('data-manage/encrypt/private-media.module.js')
        for token in ('revealPrivateCategory', 'unwrapRecord', '/private/'):
            with self.subTest(token=token):
                self.assertIn(token, code)

    def test_09_centralized_save_bar_coordination(self):
        """BatchItemManager 支持 autoSaveBar: false 中央保存条调度机制"""
        self.assertIn('autoSaveBar', read_text('data-manage/admin/admin-manager.module.js'))
        self.assertIn('autoSaveBar: false', read_text('custom/cms/viewer/cms-admin.module.js'))
        self.assertIn('checkGlobalDirty', read_text('custom/cms/admin-main.module.js'))

    def test_10_native_lazy_loading_contract(self):
        """核心网格渲染器均使用浏览器原生 loading='lazy' 属性"""
        for rel in ('custom/cms/viewer/render/cms-render-grid.module.js',
                    'custom/photos/viewer/photos-view.module.js'):
            with self.subTest(file=rel):
                self.assertRegex(read_text(rel), r'loading\s*[=:]\s*[\'"]?lazy', f"{rel} 未使用原生懒加载")

    def test_11_crypto_boundary_guard(self):
        """架构边界守卫：custom/ 业务模块严禁直接调用 crypto.subtle、keyring.module.js 或硬编码 enc: 前缀"""
        for rel in business_js_files():
            clean = _clean(rel)
            for token in self.FORBIDDEN_CRYPTO_TOKENS:
                if token in clean:
                    with self.subTest(file=rel, token=token):
                        self.fail(f"{rel} 违规直接使用底层加密实现: {token}")

    def test_12_sync_boundary_guard(self):
        """架构边界守卫：custom/ 业务模块严禁绕过 sync-manager 门面直接引用底层同步实现"""
        for rel in business_js_files():
            clean = _clean(rel)
            for mod in self.FORBIDDEN_SYNC_MODULES:
                if mod in clean:
                    with self.subTest(file=rel, module=mod):
                        self.fail(f"{rel} 违规绕过 sync-manager 门面直接引用: {mod}")

    def test_13_encrypt_and_sync_facades_contract(self):
        """高内聚门面契约：private-media、admin-lock 与 sync-manager 完整导出跨模块接口"""
        expectations = {
            'data-manage/encrypt/private-media.module.js': {
                'getPrivateUrlBuilder', 'revealPrivateCategory', 'revealPrivateTagCategories',
                'unpackRevealedNode', 'getRevealTransform', 'extractLockedNodes', 'applyLockActionLocally',
            },
            'data-manage/encrypt/admin-lock.module.js': {
                'ensureUnlocked', 'lockRecord', 'unlockRecord', 'mountUnlockAllButton', 'refreshUnlockAllButton',
                'unlockListDeep', 'countEncryptedDeep', 'renderLockedCard', 'lockIndexCardRecord',
                'lockAlbumCategoryFlow', 'unlockAlbumCategoryFlow', 'packCmsNodeForLock', 'collectCmsPrivateCoverKeys',
            },
            'data-manage/sync/sync-manager.module.js': {'SyncManager', 'syncManager'},
        }
        for rel, expected in expectations.items():
            with self.subTest(module=rel):
                missing = expected - module_exports(abs_path(rel))
                self.assertFalse(missing, f"{rel} 缺失导出: {sorted(missing)}")

        sm_code = read_text('data-manage/sync/sync-manager.module.js')
        self.assertIn('initPhotosSyncBar(', sm_code)
        self.assertIn('uploadPhotosBatch(', sm_code)

    def test_14_pure_reader_contract(self):
        """CMS 纯粹阅读器契约：移除重型 new Vditor 实例，支持双链、GitHub Alerts、源码抽屉与本地热刷新"""
        code = _clean('custom/cms/viewer/cms-reader.module.js')
        self.assertNotIn('new Vditor(', code, "cms-reader.module.js 禁止残留重型 new Vditor() 编辑器实例")
        code += _clean('custom/cms/viewer/cms-reader-content.module.js')
        code += _clean('custom/cms/viewer/cms-reader-lifecycle.module.js')
        for sym in ('preprocessMarkdown', 'enhanceGitHubAlerts', 'openExternal', 'createReaderFileWatcher',
                    'cms-source-drawer', 'cms-wikilink', 'cms-alert'):
            with self.subTest(symbol=sym):
                self.assertIn(sym, code, f"cms-reader.module.js 缺少核心能力标识: {sym}")
