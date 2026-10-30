#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MAERS 自动化测试入口 (_studio/tests/run_tests.py)

本文件与各测试套件同位于 _studio/tests/ 包，仅提供：
  - 命令行运行器（套件汇总、过滤、快速模式）
  - run_pre_push_check()：供 git_service 推送前调用的只读契约门禁

用法：
  python -B _studio/tests/run_tests.py              # 全量
  python -B _studio/tests/run_tests.py --fast       # 仅只读契约与规范守卫套件（与推送前门禁一致）
  python -B _studio/tests/run_tests.py -k janitor   # 按用例名子串过滤（可多次指定）
  python -B _studio/tests/run_tests.py -x           # 首个失败即停止
  python -B _studio/tests/run_tests.py --debt       # 打印代码规范技术债台账
  python -B _studio/tests/run_tests.py --shrink-baseline  # 修复欠账后收缩基线
"""

import argparse
import io
import os
import sys
import time
import unittest
import subprocess
from collections import Counter

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

STUDIO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if STUDIO_DIR not in sys.path:
    sys.path.insert(0, STUDIO_DIR)

import tests as maers_tests  # noqa: E402

_LINE = '=' * 72


def build_suite(readonly_only=False, patterns=None):
    """按注册表构建测试套件，返回 (suite, 测试类列表)"""
    loader = unittest.TestLoader()
    if patterns:
        loader.testNamePatterns = [f'*{p}*' for p in patterns]
    classes = maers_tests.load_suite_classes(readonly_only=readonly_only)
    suite = unittest.TestSuite(loader.loadTestsFromTestCase(cls) for cls in classes)
    return suite, classes


def _short_error(test_case, tb):
    desc = test_case.shortDescription() or str(test_case)
    lines = [line.strip() for line in tb.strip().splitlines() if line.strip()]
    return f"{desc} -> {lines[-1] if lines else '未知错误'}"


def run_pre_push_check():
    """
    推送前极速门禁：仅运行只读契约套件，不加载后端服务。
    返回 {'passed': bool, 'total': int, 'errors': list[str]}
    """
    # 独立进程避免常驻后台复用之前的源码缓存，确保每次检查当前文件。
    suite, _ = build_suite(readonly_only=True)
    result = subprocess.run([sys.executable, '-B', os.path.abspath(__file__), '--fast', '-q'],
                            capture_output=True, text=True, encoding='utf-8', timeout=120)
    return {'passed': result.returncode == 0, 'total': suite.countTestCases(),
            'errors': [] if result.returncode == 0 else [(result.stderr or result.stdout)[-6000:]]}



def _count_by_class(suite):
    """必须在运行前调用：TestSuite 执行后会释放内部用例引用"""
    def walk(s):
        for item in s:
            if isinstance(item, unittest.TestSuite):
                yield from walk(item)
            else:
                yield item
    return Counter(type(t).__name__ for t in walk(suite))


def _print_summary(classes, totals, result, elapsed):
    """按套件汇总通过 / 失败 / 跳过数量"""
    failed = Counter(type(t).__name__ for t, _ in result.failures + result.errors)
    skipped = Counter(type(t).__name__ for t, _ in result.skipped)

    print(f"\n{_LINE}\n  {'套件':<46}{'用例':>6}{'失败':>6}{'跳过':>6}\n{'-' * 72}")
    for cls in classes:
        name = cls.__name__
        if not totals[name]:
            continue
        mark = '❌' if failed[name] else '✅'
        print(f"  {mark} {name:<44}{totals[name]:>6}{failed[name]:>6}{skipped[name]:>6}")
    print(_LINE)

    n_fail = len(result.failures) + len(result.errors)
    n_skip = len(result.skipped)
    if result.wasSuccessful():
        skip_note = f"，跳过 {n_skip} 项" if n_skip else ''
        print(f"  [ TEST ] ✅ 全部 {result.testsRun} 项测试通过{skip_note}，耗时 {elapsed:.2f}s")
    else:
        print(f"  [ TEST ] ❌ 共 {result.testsRun} 项，失败 {n_fail} 项，耗时 {elapsed:.2f}s")
        for tc, tb in result.failures + result.errors:
            print(f"    - {_short_error(tc, tb)}")
    print(_LINE + "\n")


def _print_debt():
    """打印棘轮规则当前欠账（文件数 / 违规总量）"""
    from tests import standards
    print(f"\n{_LINE}\n  [ TEST ] 📒 代码规范技术债台账（见 {standards.DOC_LINK}）\n{'-' * 72}")
    debt_ids = {'STD-JS-03', 'STD-JS-04', 'STD-JS-06', 'STD-CSS-01', 'STD-CSS-02'}
    for rule in standards.HARD_RULES + standards.RATCHET_RULES:
        if rule.id not in debt_ids:
            continue
        current = rule.scan()
        print(f"  {rule.id:<12}{rule.title:<30}{len(current):>4} 个文件")
        for path, count in sorted(current.items()):
            print(f"      {path}: {count}")
    print(_LINE + "\n")


def _print_accessibility_audit():
    """输出可访问性静态审计，只读检查，不重写页面或主题。"""
    from tests import standards
    findings = 0
    for rule in standards.AUDIT_RULES:
        current = rule.scan()
        print(f"{rule.id} {rule.title}")
        for path, count in sorted(current.items()):
            print(f"  {path}: {count}")
            findings += count
    print(f"共 {findings} 处待审查项；本命令不修改任何文件。")
    return 1 if findings else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description='MAERS 全量自动化测试')
    parser.add_argument('--fast', action='store_true', help='仅运行只读套件 (与推送前门禁一致)')
    parser.add_argument('-k', dest='patterns', action='append', metavar='PATTERN', help='按用例名子串过滤，可多次指定')
    parser.add_argument('-x', '--failfast', action='store_true', help='首个失败即停止')
    parser.add_argument('-q', '--quiet', action='store_true', help='精简输出（不逐项打印用例）')
    parser.add_argument('--a11y', action='store_true', help='只读输出可访问性静态审计；有待审查项时退出码为 1')
    parser.add_argument('--debt', action='store_true', help='打印代码规范技术债台账后退出')
    parser.add_argument('--shrink-baseline', action='store_true', help='按当前代码收缩规范基线（只减不增）后退出')
    args = parser.parse_args(argv)

    if args.a11y:
        return _print_accessibility_audit()
    if args.debt:
        _print_debt()
        return 0
    if args.shrink_baseline:
        from tests import standards
        print(f"  [ TEST ] ✂️ 规范基线已收缩 {standards.shrink_baseline()} 条")
        return 0

    print(f"\n{_LINE}\n  [ TEST ] 🧪 启动 MAERS 自动化测试{'（快速模式）' if args.fast else ''}\n{_LINE}")

    suite, classes = build_suite(readonly_only=args.fast, patterns=args.patterns)
    totals = _count_by_class(suite)
    start = time.time()
    # buffer=True：捕获用例（含后台线程）期间的业务日志，仅在失败时回显
    runner = unittest.TextTestRunner(verbosity=1 if args.quiet else 2, buffer=True, failfast=args.failfast)
    result = runner.run(suite)
    _print_summary(classes, totals, result, time.time() - start)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
