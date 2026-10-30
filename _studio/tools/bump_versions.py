"""提交时按暂存区自动递增前端版本；不把未暂存内容混入提交。"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '_studio'))
from tests import standards

FILE = 'maers-version-controller.js'


def git(*args: str) -> str:
    return standards._git(*args)


def next_version(value: str) -> str:
    match = re.search(r'\d+$', value)
    if not match:
        raise ValueError('版本必须以数字结尾: ' + value)
    return value[:match.start()] + str(int(match.group()) + 1).zfill(len(match.group()))


def bump_source(source: str, baseline: str, paths: list[str]) -> tuple[str, list[str]]:
    current = standards.parse_version_config(source)
    previous = standards.parse_version_config(baseline)
    changed = []
    for key in sorted({standards.resolve_version_key(path, current) for path in paths}, key=str):
        value = standards.version_value(current, key)
        if value != standards.version_value(previous, key):
            continue
        new = next_version(value)
        kind, name = key
        if kind == 'default':
            pattern = r"(default:\s*')" + re.escape(value) + "'"
        elif kind == 'groups':
            pattern = r"(\b" + re.escape(name) + r"\s*:\s*\{\s*version:\s*')" + re.escape(value) + "'"
        else:
            pattern = r"('" + re.escape(name) + r"'\s*:\s*')" + re.escape(value) + "'"
        source, count = re.subn(pattern, lambda m: m[1] + new + "'", source, count=1)
        if count != 1:
            raise ValueError('找不到版本键: ' + str(key))
        changed.append(f'{kind}.{name or "default"}: {value} -> {new}')
    return source, changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--staged', action='store_true')
    args = parser.parse_args()
    baseline = git('show', 'HEAD:' + FILE)
    path = ROOT / FILE
    working = path.read_text(encoding='utf-8')
    source = git('show', ':' + FILE) if args.staged else working
    paths = (git('diff', '--cached', '--name-only', '--diff-filter=AMR').splitlines()
             if args.staged else standards.changed_frontend_files('HEAD'))
    paths = [p for p in paths if p.endswith(standards.FRONTEND_EXTS) and p != FILE
             and (p.startswith(standards.FRONTEND_DIRS + ('plugins/',)) or '/' not in p)]
    updated, changes = bump_source(source, baseline, paths)
    if not changes:
        return 0
    if args.staged and source != working:
        raise RuntimeError('版本文件存在未暂存改动，请先暂存或整理该文件，避免自动覆盖。')
    path.write_text(updated, encoding='utf-8', newline='\n')
    if args.staged:
        git('add', '--', FILE)
    print('\n'.join(changes))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
