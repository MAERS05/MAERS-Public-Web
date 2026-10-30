# -*- coding: utf-8 -*-
"""套件 01：静态资源、关键渲染路径、ES6 模块引用与代码规范契约（只读）"""

import ast
import os
import re
import unittest
import urllib.parse

from .helpers import (
    CORE_HTML_PAGES, PROJECT_ROOT,
    abs_path, exists, frontend_js_files, is_remote_spec, iter_html_inline_scripts,
    iter_import_specs, iter_js_sources, list_files_by_ext, module_exports, read_json,
    read_text, resolve_js_spec, strip_js_comments,
)

_NAMED_IMPORT_RE = re.compile(
    r'\bimport\s+(?:([A-Za-z_$][A-Za-z0-9_$]*)\s*,\s*)?\{([^}]+)\}\s*from\s*[\'"]([^\'"]+)[\'"]'
)
_DEFAULT_IMPORT_RE = re.compile(r'\bimport\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*[\'"]([^\'"]+)[\'"]')
_HTML_ASSET_RE = re.compile(r'<(?:script|link|img)\b[^>]*?\b(?:src|href)="([^"#?]+)"')
_CSS_IMPORT_RE = re.compile(r'@import\s+(?:url\()?\s*[\'"]([^\'"]+)[\'"]')
_MD_LINK_RE = re.compile(r'\[[^\]]+\]\(([^()#?\s]+(?:\([^)]*\)[^()#?\s]*)?)\)')


class Test01_StaticContracts(unittest.TestCase):
    """静态资源、关键渲染路径、ES6 模块引用与代码规范契约"""

    def test_01_all_html_pages_exist(self):
        """全部核心访客端与管理端 HTML 页面真实存在"""
        missing = [p for p in CORE_HTML_PAGES if not os.path.isfile(abs_path(p))]
        self.assertEqual(missing, [], f"核心页面缺失: {missing}")

    def test_02_flash_guard_critical_path(self):
        """所有 HTML 页面均同步引入 shared/flash-guard.js 且未加 defer/module"""
        for page in CORE_HTML_PAGES:
            with self.subTest(page=page):
                match = re.search(r'<script\b[^>]*shared/flash-guard\.js[^>]*>', read_text(page))
                self.assertIsNotNone(match, f"{page} 未找到 flash-guard.js script 标签")
                tag = match.group(0)
                self.assertNotIn('defer', tag, f"{page} 的 flash-guard.js 禁止使用 defer")
                self.assertNotIn('async', tag, f"{page} 的 flash-guard.js 禁止使用 async")
                self.assertNotIn('type="module"', tag, f"{page} 的 flash-guard.js 禁止使用 type=module")

    def test_03_html_referenced_assets_exist(self):
        """全部 HTML 页面声明的本地 script、link、img 资源 100% 存在"""
        for page in CORE_HTML_PAGES:
            for ref in _HTML_ASSET_RE.findall(read_text(page)):
                if re.match(r'^(?:[a-z]+:)?//', ref, re.I) or ref.startswith('data:'):
                    continue
                with self.subTest(page=page, ref=ref):
                    self.assertTrue(exists(ref.lstrip('/')), f"{page} 引用了不存在的本地资源: {ref}")

    def test_04_js_imports_resolve(self):
        """全站 JS 文件与 HTML 内联脚本中的静态/动态 import 路径均能解析到真实文件"""
        for label, base_dir, code in iter_js_sources():
            is_inline = '#inline[' in label
            for spec in iter_import_specs(code):
                # JS 文件只校验相对路径（裸说明符可能为 import map）；内联脚本按站点根解析
                if not is_inline and not spec.startswith('.'):
                    continue
                resolved = resolve_js_spec(spec, base_dir)
                if resolved is None:
                    continue
                with self.subTest(source=label, spec=spec):
                    self.assertTrue(os.path.isfile(resolved), f"{label} 导入了不存在的模块: {spec}")

    def test_05_es6_named_exports_contract(self):
        """全部具名 / default import 的符号在目标模块中 100% 真实导出"""
        for label, base_dir, code in iter_js_sources():
            for m in _NAMED_IMPORT_RE.finditer(code):
                default_ident, braces, spec = m.groups()
                resolved = resolve_js_spec(spec, base_dir)
                if resolved is None:
                    continue
                exported = module_exports(resolved)
                wanted = {re.split(r'\s+as\s+', t.strip())[0].strip() for t in braces.split(',') if t.strip()}
                if default_ident:
                    wanted.add('default')
                with self.subTest(source=label, spec=spec):
                    self.assertTrue(os.path.isfile(resolved), f"{label} 导入了不存在的文件: {spec}")
                    missing = wanted - exported
                    self.assertFalse(missing, f"{label} 从 {spec} 导入了未导出的符号 {sorted(missing)}")

            for m in _DEFAULT_IMPORT_RE.finditer(code):
                resolved = resolve_js_spec(m.group(2), base_dir)
                if resolved is None:
                    continue
                with self.subTest(source=label, spec=m.group(2)):
                    self.assertIn('default', module_exports(resolved),
                                  f"{label} 从 {m.group(2)} 导入了 default，但目标未导出 default")

    def test_06_css_imports_resolve(self):
        """全站所有 CSS 文件中的 @import 相对路径 100% 真实存在"""
        css_files = list_files_by_ext('custom', '.css') + list_files_by_ext('static-style', '.css')
        for css_rel in css_files:
            base_dir = os.path.dirname(abs_path(css_rel))
            for ref in _CSS_IMPORT_RE.findall(read_text(css_rel)):
                if is_remote_spec(ref):
                    continue
                resolved = os.path.normpath(os.path.join(base_dir, urllib.parse.unquote(ref.split('?')[0])))
                with self.subTest(css=css_rel, ref=ref):
                    self.assertTrue(os.path.isfile(resolved), f"{css_rel} @import 了不存在的样式表: {ref}")

    def test_07_mobile_adaptation_isolation(self):
        """移动端适配目录 custom/zmobile adaptation/ 下的核心适配文件齐全"""
        expected = (
            'mobile-global.css', 'mobile-cms.css', 'mobile-index.css',
            'mobile-literature.css', 'mobile-literature.js', 'mobile-photos.css',
            'mobile-photos.js', 'mobile-album.css', 'mobile-music.css',
            'mobile-games.css', 'mobile-record.css', 'mobile-space.css',
            'mobile-admin.css', 'mobile-spatial-nav.css',
        )
        missing = [f for f in expected if not os.path.isfile(abs_path(f"custom/zmobile adaptation/{f}"))]
        self.assertEqual(missing, [], f"缺失移动端适配文件: {missing}")

    def test_08_no_deleted_legacy_references(self):
        """全站前端与后端代码不残留已废弃删除的历史文件引用"""
        forbidden = (
            'namespace.module.js', 'templates.module.js', 'linear-gallery.css',
            'clean-data.py', 'wipe-data.py', 'install_deps.py', 'open-file.py',
            'shared/private-media.module.js', 'shared/crypto.module.js', 'shared/keyring.module.js',
        )
        code_files = (
            list(CORE_HTML_PAGES) + list(frontend_js_files()) +
            list_files_by_ext('custom', '.css') +
            list_files_by_ext('_studio', '.py', exclude_dirs=('__pycache__', 'tools', 'tests'))
        )
        for rel in code_files:
            content = read_text(rel)
            for legacy in forbidden:
                if legacy in content:
                    with self.subTest(file=rel, legacy=legacy):
                        self.fail(f"{rel} 仍残留已删除的历史文件引用: {legacy}")

    def test_09_python_backend_syntax(self):
        """_studio/ 下全部 Python 源码通过 AST 语法树编译检查"""
        py_files = list_files_by_ext('_studio', '.py')
        self.assertGreaterEqual(len(py_files), 15)
        for py_rel in py_files:
            with self.subTest(file=py_rel):
                try:
                    ast.parse(read_text(py_rel), filename=py_rel)
                except SyntaxError as e:
                    self.fail(f"{py_rel} 存在 Python 语法错误: {e}")

    def test_10_svg_icons_integrity(self):
        """ui/ 目录下所有 SVG 图标文件非空且包含合法 <svg 根节点"""
        svg_files = list_files_by_ext('ui', '.svg')
        self.assertGreater(len(svg_files), 5)
        invalid = [s for s in svg_files if '<svg' not in read_text(s).lower()]
        self.assertEqual(invalid, [], f"无效的 SVG 文件: {invalid}")

    def test_11_vditor_local_assets_integrity(self):
        """本地化 Vditor 核心资产与依赖目录完整存在"""
        required = (
            'plugins/vditor-assets/index.min.js',
            'plugins/vditor-assets/index.css',
            'plugins/vditor-assets/dist/js/lute/lute.min.js',
            'plugins/vditor-assets/dist/js/katex/katex.min.js',
            'plugins/vditor-assets/dist/js/markmap/markmap.min.js',
        )
        missing = [r for r in required if not os.path.isfile(abs_path(r))]
        self.assertEqual(missing, [], f"缺失本地 Vditor 核心资产: {missing}")

    def test_12_desktop_launcher_and_builder(self):
        """桌面启动器 Maersy.exe 与构建脚本满足单实例静默启动与透明图标契约"""
        exe_path = abs_path('Maersy.exe')
        self.assertTrue(os.path.isfile(exe_path), "根目录缺失 Maersy.exe")
        self.assertGreater(os.path.getsize(exe_path), 2048, "Maersy.exe 文件大小异常")
        builder_code = read_text('_studio/tools/build_desktop_app.py')
        for token in ('CreateNoWindow = true', 'FindMaersAppWindow', 'ensure_transparent_icon',
                      'EntryPath = "/admin"', '--app='):
            with self.subTest(token=token):
                self.assertIn(token, builder_code)

    def test_13_server_auto_dependency_guard(self):
        """_studio/server.py 在导入 routes 之前定义并执行 ensure_dependencies() 自检"""
        server_code = read_text('_studio/server.py')
        idx_def = server_code.find('def ensure_dependencies():')
        idx_call = server_code.find('ensure_dependencies()', idx_def + 1 if idx_def >= 0 else 0)
        idx_routes = server_code.find('import routes')
        self.assertNotEqual(idx_def, -1, "server.py 缺失 ensure_dependencies 定义")
        self.assertNotEqual(idx_call, -1, "server.py 未调用 ensure_dependencies()")
        self.assertLess(idx_call, idx_routes, "ensure_dependencies() 必须在 import routes 之前执行")

    def test_14_docs_and_readme_links(self):
        """根目录 README.md 与 _说明/*.md 全部存在且内部 Markdown 链接有效"""
        doc_files = ['README.md'] + list_files_by_ext('_说明', '.md')
        self.assertGreaterEqual(len(doc_files), 9)
        for doc_rel in doc_files:
            # 剥离代码块与行内代码，避免示例模板链接被误判
            content = re.sub(r'```[\s\S]*?```|`[^`\n]*`', '', read_text(doc_rel))
            base_dir = os.path.dirname(abs_path(doc_rel))
            for href in _MD_LINK_RE.findall(content):
                if href.startswith(('http://', 'https://', 'mailto:', 'file://', '/')):
                    continue
                target = os.path.normpath(os.path.join(base_dir, urllib.parse.unquote(href)))
                with self.subTest(doc=doc_rel, href=href):
                    self.assertTrue(os.path.exists(target), f"{doc_rel} 包含失效的文档链接: {href}")

    def test_15_vercel_config_valid(self):
        """vercel.json 为合法 JSON 配置"""
        self.assertIsInstance(read_json('vercel.json'), dict)

    def test_16_global_config_contract(self):
        """custom/config.js 正确初始化 window.MAERS.Config"""
        cfg = strip_js_comments(read_text('custom/config.js'))
        self.assertRegex(cfg, r'window\.MAERS[\s\S]*Config')

    def test_16b_all_html_pages_load_global_config(self):
        """所有页面须同步加载 custom/config.js，否则 publicMediaUrl 无法解析原图域名"""
        for page in CORE_HTML_PAGES:
            with self.subTest(page=page):
                html = read_text(page)
                match = re.search(r'<script\b[^>]*custom/config\.js[^>]*>', html)
                self.assertIsNotNone(match, f"{page} 未加载 custom/config.js")
                self.assertNotIn('type="module"', match.group(0), f"{page} 的 config.js 不得使用 module")


    def test_16c_admin_card_buttons_contract(self):
        """管理按钮内图片不得触发大图预览；封面按钮须位于加锁按钮之前"""
        lightbox = read_text('custom/cms/viewer/cms-lightbox.module.js')
        self.assertIn('target.closest(".maers-admin-btn")', lightbox)
        grid = read_text('custom/cms/viewer/render/cms-render-grid.module.js')
        for part in grid.split('if (State.IS_ADMIN && Admin && AdminButtonHelper) {')[1:]:
            self.assertLess(part.index("'Remove Cover'"), part.index("Admin.uiLock) {"))
            self.assertLess(part.index("'Upload Cover'"), part.index("Admin.uiLock) {"))


    def test_16d_header_actions_toolbar_btn_has_no_extra_margin(self):
        """.header-actions 内的工具栏按钮不得叠加 margin-right，窄屏否则会提前换行"""
        css = read_text('static-style/sync-ui.css')
        self.assertRegex(css, r'\.header-actions\s*>\s*\.maers-toolbar-btn\s*\{[^}]*margin-right:\s*0')


    def test_17_inline_scripts_have_no_remote_esm(self):
        """HTML 内联脚本不从远程 CDN 加载 ES 模块（保证离线可用与本地化）"""
        for label, code in iter_html_inline_scripts():
            remote = [s for s in iter_import_specs(code) if s.startswith(('http://', 'https://', '//'))]
            with self.subTest(source=label):
                self.assertEqual(remote, [], f"{label} 从远程加载模块: {remote}")
