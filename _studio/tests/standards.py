# -*- coding: utf-8 -*-
"""
代码与文件规范扫描器（规则即测试）。

每条规则对应 _说明/开发规范.md 中的一个编号（STD-xxx-nn）。扫描函数只读、纯函数，
返回 {项目相对路径: 违规计数}，供 test_09_code_standards 与基线维护共同使用。

规则分两类：
  - 硬性规则 (HARD_RULES)：当前代码已 100% 合规，任何违规直接失败；
  - 棘轮规则 (RATCHET_RULES)：存在历史欠账，欠账登记在 standards_baseline.json，
    只允许减少、不允许新增或增长（新文件必须完全合规）。
"""

import ast
import json
import os
import re
import subprocess
from collections import namedtuple
from html.parser import HTMLParser

from .helpers import (
    CORE_HTML_PAGES, PROJECT_ROOT, TESTS_DIR, abs_path, frontend_js_files, list_files_by_ext, read_text,
    strip_js_comments,
)

BASELINE_FILE = os.path.join(TESTS_DIR, 'standards_baseline.json')
DOC_LINK = '_说明/开发规范.md'

Rule = namedtuple('Rule', 'id title scan tolerance')

# ================= 公共常量 =================

# 允许不使用 .module.js 后缀的 JS 文件（经典脚本 / Worker / 独立 IIFE）
NON_MODULE_JS_ALLOWLIST = frozenset({
    'custom/config.js',                                # 同步全局配置，须早于模块加载
    'shared/flash-guard.js',                           # 关键渲染路径同步脚本
    'custom/index/viewer/site-guide.js',               # 首页引导独立脚本
    'custom/zmobile adaptation/mobile-literature.js',  # 移动端适配补丁脚本
    'custom/zmobile adaptation/mobile-photos.js',
    'custom/zmobile localization/offline-download.js', # 离线下载独立 IIFE
    'data-manage/sync/cloudflare-worker-sync.js',      # 部署在 Cloudflare 的 Worker 源码
})

# 项目根目录允许存在的非 HTML 文件
ROOT_FILE_ALLOWLIST = frozenset({
    '.gitattributes', '.gitignore', 'README.md', 'LICENSE', 'Maersy.exe',
    'maers-version-controller.js', 'manifest.json', 'vercel.json',
})

# _studio/ 根目录允许的文件
STUDIO_ROOT_ALLOWLIST = frozenset({'config.py', 'routes.py', 'server.py', 'requirements.txt'})

# 允许在主样式文件中出现 @media 的全局响应式样式表
MEDIA_QUERY_ALLOWLIST = frozenset({'static-style/responsive.css'})

# 物理隔离目录（不受 custom/<module>/(viewer|admin)/ 结构约束）
CUSTOM_SPECIAL_DIRS = frozenset({'zmobile adaptation', 'zmobile localization'})

# 前端资源命名：小写 kebab-case
KEBAB_FILE_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.module)?\.[a-z0-9]+$')
SNAKE_PY_RE = re.compile(r'^(?:[a-z][a-z0-9_]*|__[a-z]+__)\.py$')
LOG_PREFIX_RE = re.compile(r'^\s*\[ [A-Z0-9][A-Z0-9-]* \]')

MAX_JS_LINES = 800
MAX_CSS_LINES = 1000
MAX_PY_LINES = 700

# 前端代码目录（受命名与版本号规则约束）
FRONTEND_DIRS = ('custom', 'shared', 'data-manage', 'static-style', 'ui')
FRONTEND_EXTS = ('.js', '.css', '.html', '.svg')

from .js_analysis import analyze


def _line_count(rel):
    return read_text(rel).count('\n') + 1


def _studio_py_files():
    return list_files_by_ext('_studio', '.py')


def _service_py_files():
    """业务后端源码（tools/ 为独立 CLI，tests/ 为测试，不受日志与体量规范约束）"""
    return [p for p in _studio_py_files() if not p.startswith(('_studio/tools/', '_studio/tests/'))]


def _parse_py(rel):
    return ast.parse(read_text(rel), filename=rel)


def _flag(paths):
    return {p: 1 for p in paths}


# ================= 文件与目录规则 =================

def scan_file_naming():
    """STD-FILE-01：前端资源 kebab-case，Python 模块 snake_case"""
    bad = []
    for base in FRONTEND_DIRS:
        for ext in FRONTEND_EXTS + ('.png', '.ico', '.json'):
            for rel in list_files_by_ext(base, ext):
                if not KEBAB_FILE_RE.match(os.path.basename(rel)):
                    bad.append(rel)
    for name in os.listdir(PROJECT_ROOT):
        if name.endswith('.html') and not KEBAB_FILE_RE.match(name):
            bad.append(name)
    bad += [p for p in _studio_py_files() if not SNAKE_PY_RE.match(os.path.basename(p))]
    return _flag(bad)


def scan_non_module_js():
    """STD-FILE-02：ES 模块必须使用 .module.js 后缀，例外需登记白名单"""
    return _flag(p for p in frontend_js_files()
                 if not p.endswith('.module.js') and p not in NON_MODULE_JS_ALLOWLIST)


def scan_root_files():
    """STD-FILE-03：项目根目录只允许页面 HTML 与登记的配置文件"""
    bad = []
    for name in os.listdir(PROJECT_ROOT):
        if os.path.isfile(abs_path(name)) and not name.endswith('.html') and name not in ROOT_FILE_ALLOWLIST:
            bad.append(name)
    return _flag(bad)


def scan_custom_layout():
    """STD-FILE-04：custom/<module>/ 根部只放入口与适配器，其余必须位于 viewer/ 或 admin/"""
    bad = []
    custom_root = abs_path('custom')
    for module in os.listdir(custom_root):
        mod_dir = os.path.join(custom_root, module)
        if not os.path.isdir(mod_dir) or module in CUSTOM_SPECIAL_DIRS:
            continue
        for root, dirs, files in os.walk(mod_dir):
            rel_dir = os.path.relpath(root, mod_dir).replace('\\', '/')
            for fname in files:
                rel = f"custom/{module}/{fname}" if rel_dir == '.' else f"custom/{module}/{rel_dir}/{fname}"
                if rel_dir == '.':
                    if not re.match(r'^(main|admin-main|[a-z0-9-]+-adapter)\.module\.js$', fname):
                        bad.append(rel)
                elif rel_dir.split('/')[0] not in ('viewer', 'admin'):
                    bad.append(rel)
    for fname in os.listdir(custom_root):
        if os.path.isfile(os.path.join(custom_root, fname)) and fname != 'config.js':
            bad.append(f"custom/{fname}")
    return _flag(bad)


def scan_studio_layout():
    """STD-FILE-05：_studio/ 根部仅 config/routes/server 与 requirements.txt，禁止批处理脚本，测试文件必须注册"""
    from . import SUITES
    bad = []
    studio = abs_path('_studio')
    for name in os.listdir(studio):
        if os.path.isfile(os.path.join(studio, name)) and name not in STUDIO_ROOT_ALLOWLIST:
            bad.append(f"_studio/{name}")
    for ext in ('.bat', '.cmd', '.ps1', '.sh'):
        bad += list_files_by_ext('_studio', ext)
    registered = {f"{s.module}.py" for s in SUITES}
    for name in os.listdir(TESTS_DIR):
        if name.startswith('test_') and name.endswith('.py') and name not in registered:
            bad.append(f"_studio/tests/{name}")
    return _flag(bad)


# ================= JavaScript 规则 =================

def _scan_js(rule):
    return {rel: hits for rel in frontend_js_files()
            if (hits := analyze(read_text(rel))['counts'][rule])}


def scan_js_debugger():
    return _scan_js('debugger')


def scan_js_var():
    return _scan_js('var')


def scan_js_console_log():
    return _scan_js('console')


def scan_js_alert():
    return _scan_js('alert')


def scan_js_header():
    """STD-JS-05：每个 JS 文件以 /** 文档注释开头，说明模块职责"""
    return _flag(p for p in frontend_js_files() if not read_text(p).lstrip('\ufeff \t\r\n').startswith('/**'))


def scan_js_size():
    """STD-JS-06：单个 JS 文件不超过 MAX_JS_LINES 行"""
    return {p: n for p in frontend_js_files() if (n := _line_count(p)) > MAX_JS_LINES}


def scan_js_hardcoded_host():
    """STD-JS-07：禁止在业务代码中硬编码本地服务地址，统一读取 window.MAERS.Config"""
    result = {}
    for rel in frontend_js_files():
        if rel == 'custom/config.js':
            continue
        hits = len(re.findall(r'(?:localhost|127\.0\.0\.1):\d{2,5}', read_text(rel)))
        if hits:
            result[rel] = hits
    return result


def scan_js_inline_svg():
    """STD-JS-12：应用图标使用 ui/ 资源，避免在 JS 中复制 SVG 形状。"""
    return {path: count for path in frontend_js_files()
            if (count := len(re.findall(r'<svg\b', strip_js_comments(read_text(path)), re.I)))}


class _PageAccessibility(HTMLParser):
    """检查原始页面的可确定语义；交互和实际颜色交给浏览器检测。"""
    def __init__(self):
        super().__init__()
        self.tags = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)


def scan_html_accessibility():
    """STD-HTML-05：语言、主地标、标题、图片替代文本与表单名称。"""
    result = {}
    for path in CORE_HTML_PAGES:
        page = _PageAccessibility()
        page.feed(read_text(path))
        tags = page.tags
        labels = {attrs['for'] for tag, attrs in tags if tag == 'label' and attrs.get('for')}
        errors = int(not any(tag == 'html' and attrs.get('lang') for tag, attrs in tags))
        errors += int(sum(tag == 'main' for tag, _ in tags) != 1)
        errors += int(not any(tag == 'h1' for tag, _ in tags))
        for tag, attrs in tags:
            if tag == 'img' and 'alt' not in attrs:
                errors += 1
            if tag in ('input', 'select', 'textarea') and attrs.get('type') not in ('hidden', 'submit', 'button'):
                if not (attrs.get('aria-label') or attrs.get('aria-labelledby') or attrs.get('id') in labels):
                    errors += 1
        if errors:
            result[path] = errors
    return result


# ================= CSS 规则 =================

def _css_files():
    return list_files_by_ext('custom', '.css') + list_files_by_ext('static-style', '.css')


def scan_css_media_outside_mobile():
    """STD-CSS-01：@media 查询必须物理隔离到 custom/zmobile adaptation/"""
    result = {}
    for rel in _css_files():
        if rel.startswith('custom/zmobile adaptation/') or rel in MEDIA_QUERY_ALLOWLIST:
            continue
        hits = len(re.findall(r'@media\b', re.sub(r'/\*[\s\S]*?\*/', '', read_text(rel))))
        if hits:
            result[rel] = hits
    return result


def scan_css_size():
    """STD-CSS-02：单个 CSS 文件不超过 MAX_CSS_LINES 行"""
    return {p: n for p in _css_files() if (n := _line_count(p)) > MAX_CSS_LINES}


# ================= Python 规则 =================

def scan_py_docstring():
    """STD-PY-01：每个 Python 模块必须有模块级 docstring 说明职责"""
    return _flag(p for p in _studio_py_files() if not ast.get_docstring(_parse_py(p)))


def scan_py_bare_except():
    """STD-PY-02：禁止裸 except:，必须捕获具体异常类型（至少 Exception）"""
    result = {}
    for rel in _studio_py_files():
        hits = sum(1 for n in ast.walk(_parse_py(rel)) if isinstance(n, ast.ExceptHandler) and n.type is None)
        if hits:
            result[rel] = hits
    return result


def _first_literal(node):
    """提取 print() 首个参数的字面量前缀（支持 f-string），无法静态确定时返回 None"""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr) and node.values and isinstance(node.values[0], ast.Constant):
        return str(node.values[0].value)
    return None


def scan_py_log_format():
    """STD-PY-03：后端日志统一为 '  [ MODULE ] 图标 中文 | English' 格式"""
    result = {}
    for rel in _service_py_files():
        hits = 0
        for n in ast.walk(_parse_py(rel)):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'print' and n.args:
                text = _first_literal(n.args[0])
                if text is not None and text.strip() and not LOG_PREFIX_RE.match(text):
                    hits += 1
        if hits:
            result[rel] = hits
    return result


def scan_py_size():
    """STD-PY-04：单个后端 Python 模块不超过 MAX_PY_LINES 行"""
    return {p: n for p in _service_py_files() if (n := _line_count(p)) > MAX_PY_LINES}


# ================= 规则注册表 =================

HARD_RULES = (
    Rule('STD-FILE-01', '文件命名（前端 kebab-case / Python snake_case）', scan_file_naming, 0),
    Rule('STD-FILE-02', 'ES 模块使用 .module.js 后缀', scan_non_module_js, 0),
    Rule('STD-FILE-03', '根目录文件白名单', scan_root_files, 0),
    Rule('STD-FILE-04', 'custom/ 模块目录结构', scan_custom_layout, 0),
    Rule('STD-FILE-05', '_studio/ 目录结构与测试注册', scan_studio_layout, 0),
    Rule('STD-JS-01', '禁止 debugger', scan_js_debugger, 0),
    Rule('STD-JS-02', '禁止 var', scan_js_var, 0),
    Rule('STD-JS-05', 'JS 文件头文档注释', scan_js_header, 0),
    Rule('STD-JS-07', '禁止硬编码本地服务地址', scan_js_hardcoded_host, 0),
    Rule('STD-PY-01', 'Python 模块 docstring', scan_py_docstring, 0),
    Rule('STD-PY-02', '禁止裸 except', scan_py_bare_except, 0),
    Rule('STD-PY-03', '后端日志格式', scan_py_log_format, 0),
    Rule('STD-PY-04', f'Python 单文件 ≤ {MAX_PY_LINES} 行', scan_py_size, 0),
)

# 棘轮规则：存量欠账登记在基线中，清零后应升级为硬性规则。
# tolerance：允许的单文件增长量（仅体量类规则放宽，避免小修复被阻断）
HARD_RULES += (
    Rule('STD-JS-03', '禁止 console.log', scan_js_console_log, 0),
    Rule('STD-JS-04', '禁止 alert()', scan_js_alert, 0),
    Rule('STD-JS-06', f'JS 单文件 ≤ {MAX_JS_LINES} 行', scan_js_size, 0),
    Rule('STD-CSS-01', '@media 物理隔离到移动端目录', scan_css_media_outside_mobile, 0),
    Rule('STD-CSS-02', f'CSS 单文件 ≤ {MAX_CSS_LINES} 行', scan_css_size, 0),
)
RATCHET_RULES = ()

# 只读审计保留现状问题清单，不以改动既有视觉样式作为普通回归的前置条件。
AUDIT_RULES = (
    Rule('STD-JS-12', 'JS 内联 SVG 使用情况', scan_js_inline_svg, 0),
    Rule('STD-HTML-05', '页面基础可访问性语义', scan_html_accessibility, 0),
)


# ================= 基线（技术债台账） =================

def load_baseline():
    if not os.path.isfile(BASELINE_FILE):
        return {}
    with open(BASELINE_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return {k: v for k, v in data.items() if not k.startswith('_')}


def _write_baseline(rules_map):
    payload = {
        '_说明': '代码规范技术债台账：只允许减少，禁止手工新增条目。修复后运行 '
                 'python -B _studio/tests/run_tests.py --shrink-baseline 自动收缩。',
    }
    for rule in RATCHET_RULES:
        entries = rules_map.get(rule.id) or {}
        if entries:
            payload[rule.id] = dict(sorted(entries.items()))
    with open(BASELINE_FILE, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write('\n')


def diff_against_baseline(rule, current, baseline_entries):
    """返回 (新增或增长的违规, 已修复可收缩的条目)"""
    regressions, fixed = [], []
    for path, count in sorted(current.items()):
        allowed = baseline_entries.get(path)
        if allowed is None:
            regressions.append(f"{path}（{count}）新增违规")
        elif count > allowed + rule.tolerance:
            regressions.append(f"{path}（{allowed} → {count}）违规增长")
    for path, allowed in sorted(baseline_entries.items()):
        if current.get(path, 0) < allowed:
            fixed.append(f"{path}（{allowed} → {current.get(path, 0)}）")
    return regressions, fixed


def shrink_baseline():
    """仅收缩基线：取当前值与基线的较小者，已清零条目删除；绝不新增条目。返回收缩条数"""
    baseline = load_baseline()
    shrunk, new_map = 0, {}
    for rule in RATCHET_RULES:
        old = baseline.get(rule.id, {})
        current = rule.scan()
        kept = {}
        for path, allowed in old.items():
            now = current.get(path, 0)
            if now <= 0:
                shrunk += 1
            elif now < allowed:
                kept[path] = now
                shrunk += 1
            else:
                kept[path] = allowed
        new_map[rule.id] = kept
    _write_baseline(new_map)
    return shrunk


def initialize_baseline():
    """首次建立基线（仅在引入新棘轮规则时由维护者调用，CLI 不暴露）"""
    _write_baseline({rule.id: rule.scan() for rule in RATCHET_RULES})


# ================= 版本号同步（基于 Git 工作区） =================

_SW_FILE = 'maers-version-controller.js'


def _git(*args):
    proc = subprocess.run(
        ['git', '-c', 'core.quotepath=false', *args], cwd=PROJECT_ROOT,
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=15,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"git {' '.join(args)} 失败")
    return proc.stdout


def parse_version_config(source):
    """从 Service Worker 源码解析 {'default': str, 'groups': {name: (version, [paths])}, 'files': {path: ver}}"""
    source = strip_js_comments(source)
    default = re.search(r"default:\s*'([^']*)'", source)
    groups = {}
    for m in re.finditer(r"(\w+):\s*\{\s*version:\s*'([^']*)'[^}]*?paths:\s*\[([^\]]*)\]", source):
        groups[m.group(1)] = (m.group(2), re.findall(r"'([^']+)'", m.group(3)))
    files_block = re.search(r"files:\s*\{([^}]*)\}", source)
    files = dict(re.findall(r"'([^']+)'\s*:\s*'([^']*)'", files_block.group(1))) if files_block else {}
    return {'default': default.group(1) if default else None, 'groups': groups, 'files': files}


def version_base_ref():
    """
    版本号对照基准：优先取当前分支与上游的合并基点（覆盖“已提交未推送”的改动，适配推送前门禁），
    无上游时回退到 HEAD（覆盖未提交改动）。
    """
    explicit = os.environ.get('MAERS_VERSION_BASE')
    if explicit and set(explicit) != {'0'}:
        _git('rev-parse', '--verify', explicit)
        return explicit
    try:
        _git('rev-parse', '--verify', '--quiet', '@{u}')
        return _git('merge-base', 'HEAD', '@{u}').strip()
    except RuntimeError:
        return 'HEAD'


def changed_frontend_files(base):
    """相对 base 新增 / 修改（不含删除）的前端代码文件（含工作区未提交改动与未跟踪新文件）"""
    tracked = _git('diff', '--name-only', '--diff-filter=AMR', base).splitlines()
    untracked = _git('ls-files', '--others', '--exclude-standard').splitlines()
    result = []
    for rel in tracked + untracked:
        rel = rel.strip().replace('\\', '/')
        if not rel.endswith(FRONTEND_EXTS) or rel == _SW_FILE:
            continue
        if rel.startswith(FRONTEND_DIRS + ('plugins/vditor-assets/',)) or '/' not in rel:
            result.append(rel)
    return sorted(set(result))


def resolve_version_key(rel, config):
    """复刻 Service Worker resolveVersion 的匹配顺序：files > groups > default"""
    for path in config['files']:
        if rel.endswith(path):
            return ('files', path)
    for name, (_, prefixes) in config['groups'].items():
        if any(rel.startswith(p) for p in prefixes):
            return ('groups', name)
    return ('default', None)


def version_value(config, key):
    kind, name = key
    if kind == 'files':
        return config['files'].get(name)
    if kind == 'groups':
        return config['groups'].get(name, (None, []))[0]
    return config['default']


def scan_version_bump():
    """STD-VER-01：改动前端文件后，其所属的版本分组必须相对基准已递增。返回 {文件: 需递增的键}"""
    base = version_base_ref()
    changed = changed_frontend_files(base)
    if not changed:
        return {}
    try:
        base_cfg = parse_version_config(_git('show', f'{base}:{_SW_FILE}'))
    except RuntimeError:
        return {}  # 首次提交或文件尚未入库，无对照基准
    with open(abs_path(_SW_FILE), 'r', encoding='utf-8') as f:
        work_cfg = parse_version_config(f.read())
    missing = {}
    for rel in changed:
        key = resolve_version_key(rel, work_cfg)
        if version_value(work_cfg, key) == version_value(base_cfg, key):
            missing[rel] = f"{key[0]}.{key[1] or 'default'}"
    return missing
