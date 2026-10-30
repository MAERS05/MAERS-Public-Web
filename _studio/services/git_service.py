"""
Git 同步服务：状态查询、提交与推送（推送前执行只读测试门禁）。
"""

import sys
import os
import subprocess
import time
import signal

_progress = {'step': 'idle', 'msg': '尚未开始'}


def get_git_progress():
    return {'api_version': 1, **_progress}


def _set_progress(step, msg):
    global _progress
    _progress = {'step': step, 'msg': msg}

# ================= 根目录锚定 =================
SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
STUDIO_DIR = os.path.dirname(SERVICE_DIR)
PROJECT_ROOT = os.path.dirname(STUDIO_DIR)

def _run_git_cmd(args, timeout=30):
    """
    执行 Git 命令行工具的辅助封装
    """
    timed_out = False
    try:
        proc = subprocess.Popen(
            ['git'] + args,
            cwd=PROJECT_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            start_new_session=os.name != 'nt'
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            # Windows 的 kill() 只结束父进程；必须同时停止 hook 与网络传输子进程。
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                               capture_output=True, timeout=15)
            else:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate(timeout=5)
            return {'code': -1, 'stdout': '', 'stderr': f'Git 执行超时 ({timeout}s)', 'timed_out': True}
        if proc.returncode:
            print(f'  [ GIT ] ❌ 命令失败 | Command failed: {stderr}')
        return {
            'code': proc.returncode,
            'stdout': stdout or '',
            'stderr': (stderr or '').strip()
        }
    except subprocess.TimeoutExpired:
        return {
            'code': -1,
            'stdout': '',
            'stderr': f'执行命令超时 ({timeout}s): git {" ".join(args)}',
            'timed_out': True
        }
    except OSError as e:
        return {
            'code': -1,
            'stdout': '',
            'stderr': f'执行异常: {str(e)}',
            'timed_out': timed_out
        }

def get_git_status():
    """
    获取当前 Git 仓库的详细状态：分支、未暂存/未提交改动列表、最新提交
    """
    # 1. 当前分支
    branch_res = _run_git_cmd(['rev-parse', '--abbrev-ref', 'HEAD'])
    branch = branch_res['stdout'].strip() if branch_res['code'] == 0 else 'unknown'

    # 2. 变更状态 (porcelain 格式，易于机器解析)
    status_res = _run_git_cmd(['--no-optional-locks', 'status', '--porcelain', '-z'])
    changes = []
    if status_res['code'] == 0 and status_res['stdout']:
        entries = iter(status_res['stdout'].split('\0'))
        for line in entries:
            if line:
                status_code = line[:2].strip()
                file_path = line[3:]
                if 'R' in status_code or 'C' in status_code:
                    next(entries, None)  # -z 的重命名记录另附原路径。
                changes.append({
                    'status': status_code,
                    'file': file_path
                })

    # 3. 最新提交详情
    log_res = _run_git_cmd(['log', '-1', '--format=%h|%s|%an|%cr'])
    latest_commit = {}
    if log_res['code'] == 0 and log_res['stdout']:
        parts = log_res['stdout'].strip().split('|')
        if len(parts) >= 4:
            latest_commit = {
                'hash': parts[0],
                'message': parts[1],
                'author': parts[2],
                'time': parts[3]
            }

    # 4. 检查是否有未推送的 commits
    ahead_count = 0
    ahead_res = _run_git_cmd(['rev-list', '@{u}..HEAD', '--count'])
    if ahead_res['code'] == 0 and ahead_res['stdout'].strip().isdigit():
        ahead_count = int(ahead_res['stdout'])

    return {
        'success': True,
        'branch': branch,
        'has_changes': len(changes) > 0,
        'change_count': len(changes),
        'changes': changes,
        'latest_commit': latest_commit,
        'ahead_count': ahead_count
    }

def commit_and_push(commit_message=None):
    try:
        result = _commit_and_push(commit_message)
        _set_progress(result['step'], result['msg'])
        return result
    except Exception:
        _set_progress('error', '操作异常，请查看本地服务日志')
        raise


def _commit_and_push(commit_message=None):
    """
    一键将所有本地改动添加、提交并推送到远端 Git 仓库（内置推送前静态契约与数据完整性自检）
    """
    _set_progress('prepare', '正在准备本地提交与版本号…')
    from . import crypto_keyring
    crypto_keyring.migrate()
    # 提交前准备版本号；真正提交仍会经过 pre-commit 暂存区检查。
    try:
        subprocess.run([sys.executable, '-B', os.path.join(STUDIO_DIR, 'tools', 'bump_versions.py')],
                       cwd=PROJECT_ROOT, check=True, capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as error:
        print(f"  [ GIT ] ❌ 版本更新失败 | Version preparation failed: {error}")
        return {'success': False, 'step': 'version', 'msg': '版本更新失败，请查看服务日志'}

    _set_progress('pre_check', '正在执行提交前检查…')
    # 门禁异常也必须停止，不能绕过测试继续推送。
    try:
        try:
            from tests.run_tests import run_pre_push_check
        except ImportError:
            from _studio.tests.run_tests import run_pre_push_check

        check_res = run_pre_push_check()
        if not check_res.get('passed', True):
            err_list = check_res.get('errors') or ['未知契约校验异常']
            print(f"  [ GIT ] ❌ 推送前自检拦截 ({len(err_list)} 项未通过): {err_list[0]}")
            return {
                'success': False,
                'step': 'pre_check',
                'errors': ['测试未通过，请查看本地服务日志'],
                'msg': f'推送前自动化自检未通过 ({len(err_list)} 项异常)，请查看本地服务日志'
            }
        print(f"  [ GIT ] ✅ 推送前自检通过 ({check_res.get('total', 0)} 项契约校验正常)")
    except Exception as e:
        print(f"  [ GIT ] ❌ 推送前自检失败 | Pre-check failed: {e}")
        return {"success": False, "step": "pre_check", "msg": "测试门禁执行失败，推送已中止"}

    _set_progress('commit', '正在保存本地 Git 提交…')
    # 步骤 1：执行 git add .
    add_res = _run_git_cmd(['add', '.'])
    if add_res['code'] != 0:
        return {
            'success': False,
            'step': 'add',
            'msg': 'git add 失败: 请查看本地 Git 日志'
        }

    # 步骤 2：检查是否有待提交内容
    status_res = _run_git_cmd(['status', '--porcelain'])
    if status_res['code'] != 0:
        return {'success': False, 'step': 'status', 'msg': '读取暂存状态失败，操作已停止'}
    has_staged = bool(status_res['stdout'])

    commit_hash = None
    commit_msg = commit_message.strip() if (commit_message and commit_message.strip()) else None

    # 如果有暂存内容，则执行 commit
    if has_staged:
        if not commit_msg:
            timestamp_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())
            commit_msg = f'chore: 本地改动 {timestamp_str}'

        commit_res = _run_git_cmd(['commit', '-m', commit_msg], timeout=120)
        if commit_res['code'] != 0:
            return {
                'success': False,
                'step': 'commit',
                'msg': 'git commit 失败: 请查看本地 Git 日志'
            }
        
        # 获取刚刚生成的 commit hash
        hash_res = _run_git_cmd(['rev-parse', '--short', 'HEAD'])
        if hash_res['code'] == 0:
            commit_hash = hash_res['stdout'].strip()
    else:
        # 如果暂存区为空，但之前有 ahead 的 commit，仍然可以继续尝试 push
        ahead_res = _run_git_cmd(['rev-list', '@{u}..HEAD', '--count'])
        ahead_count = int(ahead_res['stdout']) if (ahead_res['code'] == 0 and ahead_res['stdout'].strip().isdigit()) else 0
        if ahead_count == 0:
            return {
                'success': True,
                'step': 'none',
                'msg': '工作区干净，无任何改动需要提交',
                'pushed': False
            }

    # 步骤 3：执行 git push origin HEAD
    _set_progress('push', '本地提交已保存，正在执行推送（含推送前完整测试）…')
    push_res = _run_git_cmd(['push', 'origin', 'HEAD'], timeout=600)
    if push_res['code'] != 0:
        return {
            'success': False,
            'step': 'push_unknown' if push_res.get('timed_out') else 'push',
            'commit_hash': commit_hash,
            'msg': ('本地提交已保留；推送超时，远端是否接收尚未确认，请核对远端后重试'
                    if push_res.get('timed_out') else '本地提交已保留，推送未完成，请查看本地 Git 日志')
        }

    return {
        'success': True,
        'step': 'done',
        'commit_hash': commit_hash,
        'commit_message': commit_msg,
        'push_output': push_res['stdout'] or push_res['stderr'],
        'msg': '所有改动已成功提交并推送到 GitHub 远端！'
    }
