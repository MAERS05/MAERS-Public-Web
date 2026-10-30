# -*- coding: utf-8 -*-
"""
测试共享工具：路径常量、文件枚举、JS 源码解析、ES6 导出符号分析、页面清单。

本模块不导入后端 routes/services；JavaScript 解析委托给 Node.js / Acorn。
"""

import functools
import io
import json
import os
import re
import sys

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
STUDIO_DIR = os.path.dirname(TESTS_DIR)
PROJECT_ROOT = os.path.dirname(STUDIO_DIR)

if STUDIO_DIR not in sys.path:
    sys.path.insert(0, STUDIO_DIR)


# ================= 页面与模块清单（单一数据源） =================

VISITOR_PAGES = (
    'index.html', 'notes.html', 'literature.html', 'record.html',
    'games.html', 'videos.html', 'music.html', 'album.html',
    'photos.html', 'space.html', 'me.html',
)
ADMIN_PAGES = (
    'admin-portal.html', 'admin-index.html', 'admin-cms.html',
    'admin-music.html', 'admin-album.html', 'admin-photos.html', 'admin-space.html',
)
CORE_HTML_PAGES = VISITOR_PAGES + ADMIN_PAGES

CMS_MODULES = ('notes', 'literature', 'record', 'games', 'videos')

# 前端 JS 源码根目录（plugins/ 为第三方资产，不纳入契约校验）
FRONTEND_JS_ROOTS = ('custom', 'shared', 'data-manage')

# 离线下载脚本是独立 IIFE，允许直接使用底层 API，架构边界守卫需豁免
OFFLINE_DOWNLOAD_JS = 'custom/zmobile localization/offline-download.js'

DEFAULT_EXCLUDE_DIRS = ('.git', '__pycache__', 'node_modules', 'plugins')

# 正则：ES6 import 语句与内联脚本块
INLINE_SCRIPT_RE = re.compile(r'<script\b[^>]*>([\s\S]*?)</script>', re.I)
_REMOTE_PREFIXES = ('http://', 'https://', '//')


# ================= 文件读取 =================

def abs_path(rel_path):
    """项目相对路径 -> 绝对路径"""
    return os.path.join(PROJECT_ROOT, rel_path)


def exists(rel_path):
    return os.path.exists(abs_path(rel_path))


@functools.lru_cache(maxsize=None)
def read_text(rel_path):
    """读取项目内文本文件（带缓存，UTF-8 优先，回退 UTF-16）"""
    full = abs_path(rel_path)
    try:
        with open(full, 'r', encoding='utf-8') as f:
            return f.read()
    except UnicodeDecodeError:
        with open(full, 'r', encoding='utf-16') as f:
            return f.read()


def read_json(path):
    """读取 JSON；相对路径视为项目内路径，绝对路径直接读取（不缓存，适用于沙盒）"""
    full = path if os.path.isabs(path) else abs_path(path)
    with open(full, 'r', encoding='utf-8') as f:
        return json.load(f)


def list_files_by_ext(base_rel, ext, exclude_dirs=DEFAULT_EXCLUDE_DIRS):
    """递归列出 base_rel 下指定后缀的文件（返回以 / 分隔的项目相对路径，已排序）"""
    exclude = set(exclude_dirs)
    start_dir = abs_path(base_rel) if base_rel else PROJECT_ROOT
    results = []
    for root, dirs, files in os.walk(start_dir):
        dirs[:] = [d for d in dirs if d not in exclude]
        for fname in files:
            if fname.endswith(ext):
                rel = os.path.relpath(os.path.join(root, fname), PROJECT_ROOT)
                results.append(rel.replace('\\', '/'))
    return sorted(results)


@functools.lru_cache(maxsize=None)
def frontend_js_files():
    """全部自研前端 JS 文件（custom/ + shared/ + data-manage/）"""
    files = []
    for root in FRONTEND_JS_ROOTS:
        files.extend(list_files_by_ext(root, '.js'))
    return tuple(files)


def business_js_files():
    """custom/ 业务模块 JS（排除离线下载独立脚本），用于架构边界守卫"""
    return [f for f in list_files_by_ext('custom', '.js') if f != OFFLINE_DOWNLOAD_JS]


# ================= JS 源码解析 =================

def strip_js_comments(code):
    from .js_analysis import analyze
    return analyze(code)['clean']


def is_remote_spec(spec):
    return spec.startswith(_REMOTE_PREFIXES) or spec.startswith('data:')


def resolve_js_spec(spec, base_dir):
    """
    将 import 说明符解析为绝对路径。
    - './x.js' / '../x.js' 相对 base_dir；
    - '/x.js' 或 'x/y.js' 相对项目根（HTML 内联脚本场景）；
    - 远程 URL 返回 None。
    """
    if is_remote_spec(spec):
        return None
    clean = spec.split('?')[0].split('#')[0]
    if clean.startswith('.'):
        return os.path.normpath(os.path.join(base_dir, clean))
    return os.path.normpath(os.path.join(PROJECT_ROOT, clean.lstrip('/')))


def iter_import_specs(clean_code):
    """从已去注释的 JS 中提取全部静态与动态 import 说明符"""
    from .js_analysis import analyze
    yield from analyze(clean_code)['imports']


def iter_html_inline_scripts(pages=CORE_HTML_PAGES):
    """遍历 HTML 页面内联 <script> 块，产出 (label, 去注释后的代码)"""
    for page in pages:
        for idx, block in enumerate(INLINE_SCRIPT_RE.findall(read_text(page))):
            if block.strip():
                yield f"{page}#inline[{idx}]", strip_js_comments(block)


def iter_js_sources():
    """
    遍历全部可解析 JS 源：自研 JS 文件 + HTML 内联脚本。
    产出 (label, base_dir, 去注释后的代码)。
    """
    for rel in frontend_js_files():
        yield rel, os.path.dirname(abs_path(rel)), strip_js_comments(read_text(rel))
    for label, code in iter_html_inline_scripts():
        yield label, PROJECT_ROOT, code


def module_exports(module_abs_path):
    """静态解析 ES6 模块导出的全部具名符号集合（支持 export * from 重导出链，带缓存）"""
    return _cached_exports(os.path.normpath(module_abs_path))


@functools.lru_cache(maxsize=None)
def _cached_exports(norm):
    return frozenset(_collect_exports(norm, set()))


def _collect_exports(norm, visited):
    if norm in visited or not os.path.isfile(norm):
        return set()
    visited.add(norm)

    with open(norm, 'r', encoding='utf-8') as f:
        clean = strip_js_comments(f.read())

    from .js_analysis import analyze
    result = analyze(clean)
    exports = set(result['exports'])

    base_dir = os.path.dirname(norm)
    for spec in result['stars']:
        spec = spec.split('?')[0].split('#')[0]
        if spec.startswith('.'):
            exports |= _collect_exports(os.path.normpath(os.path.join(base_dir, spec)), visited)
    return exports


# ================= 媒体夹具 =================

def make_test_png_bytes(color=(64, 128, 255), size=(800, 600)):
    """生成内存测试 PNG 字节流"""
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', size, color=color).save(buf, format='PNG')
    return buf.getvalue()
