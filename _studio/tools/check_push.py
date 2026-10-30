"""Git 推送门禁：要求受推送分支是当前 HEAD 且工作区干净，再运行完整测试。"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    updates = [line.split() for line in sys.stdin if line.strip()]
    refs = [row[1] for row in updates if set(row[1]) != {'0'}]
    if not refs:
        return 0
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if any(ref != head for ref in refs):
        print('请切换到待推送的提交运行门禁；不能用当前工作区代替其他提交的验证。', file=sys.stderr)
        return 1
    dirty = subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True)
    if dirty.strip():
        print('推送前请提交或整理工作区，保证验证的内容与推送提交一致。', file=sys.stderr)
        return 1
    return subprocess.call([sys.executable, '-B', '_studio/tests/run_tests.py'], cwd=ROOT)


if __name__ == '__main__':
    raise SystemExit(main())
