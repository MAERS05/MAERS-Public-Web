"""Git 推送门禁：核对当前提交、干净工作区与正文同步记录，再运行完整测试。"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '_studio'))

from services import content_sync


def check_content_sync() -> bool:
    try:
        synced = content_sync.is_synced()
    except Exception:
        print('正文同步状态无法确认，推送已停止；请在本机后台检查正文和存储配置，再执行“提交并推送”。', file=sys.stderr)
        return False
    if not synced:
        print('正文新增、改名、修改、删除或公私状态变化尚未完成云端同步，推送已停止；请先在本机后台执行“提交并推送”。', file=sys.stderr)
    return synced


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
    if not check_content_sync():
        return 1
    result = subprocess.call([sys.executable, '-B', '_studio/tests/run_tests.py'], cwd=ROOT)
    # 正文不受 Git 跟踪，测试运行期间仍可能被外部编辑器改动。
    return result if result else (0 if check_content_sync() else 1)


if __name__ == '__main__':
    raise SystemExit(main())
