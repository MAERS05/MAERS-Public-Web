"""基于 Acorn 的批量 JavaScript 分析；不使用正则猜测注释、模板与正则字面量。"""

import functools
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_CACHE = {}


def _analyze(sources: list[str]) -> list[dict]:
    node = shutil.which('node')
    if not node:
        raise RuntimeError('需要 Node.js；规范与运行时检查不能跳过。')
    result = subprocess.run([node, str(ROOT / '_studio/tooling/js-analyze.mjs')],
                            input=json.dumps(sources), text=True, encoding='utf-8',
                            capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError('Acorn 分析失败；请先 npm ci --prefix _studio/tooling\n' + result.stderr)
    return json.loads(result.stdout)


@functools.lru_cache(maxsize=1)
def _prime() -> None:
    paths = [path for base in ('custom', 'shared', 'data-manage') for path in (ROOT / base).rglob('*.js')]
    paths.append(ROOT / 'maers-version-controller.js')
    sources = [path.read_text(encoding='utf-8') for path in paths]
    for source, result in zip(sources, _analyze(sources)):
        _CACHE[source] = result
        _CACHE[result['clean']] = result


def analyze(source: str) -> dict:
    _prime()
    if source not in _CACHE:
        result = _analyze([source])[0]
        _CACHE[source] = result
        _CACHE[result['clean']] = result
    return _CACHE[source]
