# -*- coding: utf-8 -*-
"""
Node.js 运行时夹具：在 PROJECT_ROOT 下以原生 ESM 执行断言脚本。

未安装 Node.js 时失败，禁止将未执行的加密验证报告为通过。
"""

import shutil
import subprocess
import unittest

from .helpers import PROJECT_ROOT

NODE_BIN = shutil.which('node')

# 脚本以该标记结尾才视为执行完整（防止中途 return / 未捕获的 Promise 被误判为通过）
_OK_MARKER = '__MAERS_NODE_OK__'

# ---------- 可组合的浏览器环境 mock 片段 ----------

MOCK_SESSION_STORAGE = """
const __ss = new Map();
globalThis.sessionStorage = {
    getItem: (k) => __ss.has(k) ? __ss.get(k) : null,
    setItem: (k, v) => __ss.set(k, String(v)),
    removeItem: (k) => __ss.delete(k)
};
"""

MOCK_LOCAL_STORAGE = """
const __ls = new Map();
globalThis.localStorage = {
    getItem: (k) => __ls.has(k) ? __ls.get(k) : null,
    setItem: (k, v) => __ls.set(k, String(v)),
    removeItem: (k) => __ls.delete(k)
};
"""

MOCK_DOM = """
const __mockEl = () => ({
    style: {},
    classList: { add(){}, remove(){}, contains(){ return false; } },
    appendChild(){}, remove(){}, addEventListener(){},
    querySelector(){ return __mockEl(); }
});
globalThis.document = {
    getElementById: () => null,
    createElement: () => __mockEl(),
    head: __mockEl(),
    body: __mockEl()
};
"""


def mock_window(pathname, *, hostname='localhost', is_admin=None):
    """生成 globalThis.window mock 片段"""
    admin = '' if is_admin is None else f", IS_ADMIN: {'true' if is_admin else 'false'}"
    origin = f'http://{hostname}:8000' if hostname == 'localhost' else f'https://{hostname}'
    return (
        f"globalThis.window = {{ location: {{ hostname: '{hostname}', search: '', "
        f"origin: '{origin}', href: '{origin}{pathname}', pathname: '{pathname}' }}{admin} }};\n"
    )


class NodeTestCase(unittest.TestCase):
    """提供 run_node_esm()：组合 mock 前置片段 + 断言主体，并校验完成标记"""

    @classmethod
    def setUpClass(cls):
        if not NODE_BIN:
            raise RuntimeError("未检测到 Node.js，无法执行前端与加密测试")

    timeout = 30

    def run_node_esm(self, body, *, preamble=(), node_args=()):
        """
        body 中应使用动态 import()，确保在 preamble 注入全局 mock 之后才加载被测模块
        （静态 import 会被提升到脚本最前执行）。
        """
        script = '\n'.join((
            "import assert from 'node:assert/strict';",
            *preamble,
            body,
            f"console.log('{_OK_MARKER}');",
        ))
        proc = subprocess.run(
            [NODE_BIN, *node_args, '--input-type=module', '-e', script],
            cwd=PROJECT_ROOT, capture_output=True, text=True,
            encoding='utf-8', errors='replace', timeout=self.timeout,
        )
        if proc.returncode != 0 or _OK_MARKER not in proc.stdout:
            self.fail(
                f"Node.js 运行时测试失败 (exit={proc.returncode}):\n"
                f"STDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"
            )
        return proc.stdout.replace(_OK_MARKER, '').strip()
