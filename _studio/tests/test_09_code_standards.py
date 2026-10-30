# -*- coding: utf-8 -*-
"""
套件 09：代码与文件规范守卫（规则即测试）。

规则定义见 tests/standards.py，规则说明见 _说明/开发规范.md。
  - 硬性规则：零容忍，任何违规直接失败；
  - 棘轮规则：对照 standards_baseline.json，禁止新增或增长；修复后要求收缩基线，
    防止已偿还的技术债被悄悄回退；
  - 版本号同步：改动前端文件后，对应 Service Worker 版本分组必须递增。

本套件只读、JS 规则依赖 Node / Acorn，纳入 Git 推送前门禁。
"""

import re
import unittest

from . import standards
from .helpers import exists, read_text

SHRINK_CMD = 'python -B _studio/tests/run_tests.py --shrink-baseline'


def _format(items, limit=30):
    lines = list(items)
    shown = '\n  - '.join(lines[:limit])
    more = f"\n  ……其余 {len(lines) - limit} 项" if len(lines) > limit else ''
    return f"\n  - {shown}{more}"


class Test09_CodeStandards(unittest.TestCase):
    """开发规范自动化守卫：文件命名 / 目录结构 / JS / CSS / Python / 版本号"""

    @classmethod
    def setUpClass(cls):
        cls.baseline = standards.load_baseline()

    def test_01_hard_rules(self):
        """硬性规则零违规（文件与目录、JS 关键约束、Python 后端规范）"""
        for rule in standards.HARD_RULES:
            with self.subTest(rule=rule.id):
                violations = rule.scan()
                self.assertFalse(
                    violations,
                    f"[{rule.id}] {rule.title} 违规（见 {standards.DOC_LINK}）：{_format(sorted(violations))}",
                )

    def test_02_ratchet_no_regression(self):
        """棘轮规则：禁止新增违规文件，禁止既有欠账增长"""
        for rule in standards.RATCHET_RULES:
            with self.subTest(rule=rule.id):
                regressions, _ = standards.diff_against_baseline(
                    rule, rule.scan(), self.baseline.get(rule.id, {}))
                self.assertFalse(
                    regressions,
                    f"[{rule.id}] {rule.title} 出现新增技术债（见 {standards.DOC_LINK}）：{_format(regressions)}",
                )

    def test_03_ratchet_baseline_shrunk(self):
        """棘轮规则：已修复的欠账必须从基线移除，锁定成果"""
        for rule in standards.RATCHET_RULES:
            with self.subTest(rule=rule.id):
                _, fixed = standards.diff_against_baseline(
                    rule, rule.scan(), self.baseline.get(rule.id, {}))
                self.assertFalse(fixed, f"[{rule.id}] 以下欠账已减少，请运行 {SHRINK_CMD}：{_format(fixed)}")

    def test_04_baseline_integrity(self):
        """基线文件只包含已注册的棘轮规则"""
        known = {r.id for r in standards.RATCHET_RULES}
        unknown = sorted(set(self.baseline) - known)
        self.assertFalse(unknown, f"standards_baseline.json 含未注册规则: {unknown}")

    def test_05_rules_documented(self):
        """每条自动化规则在 _说明/开发规范.md 中都有对应条目"""
        self.assertTrue(exists(standards.DOC_LINK), f"缺少规范文档 {standards.DOC_LINK}")
        doc_ids = set(re.findall(r'STD-[A-Z]+-\d{2}', read_text(standards.DOC_LINK)))
        rule_ids = {r.id for r in standards.HARD_RULES + standards.RATCHET_RULES} | {'STD-VER-01'}
        missing = sorted(rule_ids - doc_ids)
        self.assertFalse(missing, f"{standards.DOC_LINK} 未记录规则: {missing}")

    def test_06_version_bumped_for_changed_frontend(self):
        """STD-VER-01：相对上游合并基点（无上游时为 HEAD）改动的前端文件，其版本键已递增"""
        try:
            missing = standards.scan_version_bump()
        except (RuntimeError, OSError) as exc:
            self.skipTest(f"Git 不可用，跳过版本号同步检查: {exc}")
        details = [f"{path} → 需递增 {key}" for path, key in sorted(missing.items())]
        self.assertFalse(
            missing,
            f"[STD-VER-01] 前端文件已改动但版本号未更新（maers-version-controller.js）：{_format(details)}",
        )


if __name__ == '__main__':
    unittest.main()
