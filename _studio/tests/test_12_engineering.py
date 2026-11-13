"""工程门禁回归：AST 误报、版本暂存隔离、必需运行时及内部错误边界。"""
import json
import os
import shutil
import subprocess
import sys
import time
import threading
from pathlib import Path
from unittest import mock

from .sandbox import SandboxTestCase, cms
from .js_analysis import analyze
from . import standards, node_runtime
from .helpers import PROJECT_ROOT
from services import git_service
from tools import bump_versions, build_desktop_app


class Test12_Engineering(SandboxTestCase):
    def test_desktop_launcher_adopts_running_server_and_waits_for_writes(self):
        """编译启动器，覆盖依赖检测、窗口接管及等待写入结束后的鉴权退出。"""
        compiler = build_desktop_app.find_csc_compiler()
        if os.name != 'nt' or not compiler:
            self.skipTest('桌面启动器运行回归仅在安装系统 C# 编译器的 Windows 执行')
        source = Path(self.root_path('launcher.cs'))
        source.write_text(build_desktop_app.generate_launcher_cs_source(self.temp_root, sys.executable), encoding='utf-8-sig')
        probe = Path(self.root_path('probe.cs'))
        probe.write_text('''using System;
using System.IO;
using System.Reflection;
class LauncherProbe {
    static Type app = typeof(MAERSLauncher.Program);
    static object Call(string name, params object[] args) {
        return app.GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args);
    }
    static void Check(bool value) { if (!value) throw new Exception("lifecycle regression"); }
    public static void Main(string[] args) {
        if (args[0] == "lifecycle") {
            int ticks = 0;
            Func<IntPtr> find = delegate { return ticks < 2 ? new IntPtr(1) : ticks < 4 ? new IntPtr(2) : IntPtr.Zero; };
            Func<IntPtr, bool> alive = delegate(IntPtr handle) { return handle.ToInt32() == (ticks < 2 ? 1 : ticks < 4 ? 2 : 0); };
            Action<int> pause = delegate(int delay) { ticks++; Check(ticks < 20); };
            Check((bool)Call("WaitForWindowClose", IntPtr.Zero, find, alive, new Func<bool>(delegate { return true; }), pause));
            Check(ticks >= 5);
            ticks = 0;
            Check((bool)Call("WaitForWindowClose", new IntPtr(1),
                new Func<IntPtr>(delegate { return IntPtr.Zero; }),
                new Func<IntPtr, bool>(delegate(IntPtr handle) { return false; }),
                new Func<bool>(delegate { return true; }), pause));
            ticks = 0;
            Check(!(bool)Call("WaitForWindowClose", IntPtr.Zero,
                new Func<IntPtr>(delegate { return IntPtr.Zero; }), alive,
                new Func<bool>(delegate { return false; }), pause));
            Check(ticks == 0);
            app.GetField("DefaultPort", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, 8000);
            Check((bool)Call("IsMaersStandaloneWindowTitle", "MAERS Admin - Portal [Local:8000]", true));
            Check((bool)Call("IsMaersStandaloneWindowTitle", "MAERS Admin - Portal [Local:8000]", false));
            Check((bool)Call("IsMaersStandaloneWindowTitle", "MAERS Space [Local:8000]", true));
            Check((bool)Call("IsMaersStandaloneWindowTitle", "404 [Local:8000]", true));
            Check(!(bool)Call("IsMaersStandaloneWindowTitle", "MAERS Admin - Portal [Local:8001]", true));
            Check(!(bool)Call("IsMaersStandaloneWindowTitle", "MAERS Admin - Portal", true));
            Check(!(bool)Call("IsMaersStandaloneWindowTitle", "MAERS Space", true));
            Check(!(bool)Call("IsMaersStandaloneWindowTitle", "MAERS Space - Google Chrome", false));
            Check(!(bool)Call("IsMaersStandaloneWindowTitle", "MAERS Space - 个人 - Microsoft\u200B Edge", false));
            Check(!(bool)Call("IsMaersStandaloneWindowTitle", "MAERS Admin - Portal [Local:8000] - Google Chrome", false));
        } else if (args[0] == "dependencies") {
            Type runtime = typeof(MAERSLauncher.DesktopRuntime);
            var find = runtime.GetMethod("FindRuntime", BindingFlags.NonPublic | BindingFlags.Static);
            var candidates = new[] { Path.Combine(args[1], "missing.exe"), args[2] };
            Check((string)find.Invoke(null, new object[] { candidates, "Python ", new Version(3, 10) }) == args[2]);
            Check(find.Invoke(null, new object[] { candidates, "Python ", new Version(99, 0) }) == null);
            var ready = runtime.GetMethod("ToolingReady", BindingFlags.NonPublic | BindingFlags.Static);
            var tooling = new object[] { args[1] };
            string lockfile = Path.Combine(args[1], "package-lock.json");
            string modules = Path.Combine(args[1], "node_modules");
            Directory.CreateDirectory(Path.Combine(modules, "acorn"));
            File.WriteAllText(lockfile, "{}");
            Check(!(bool)ready.Invoke(null, tooling));
            File.WriteAllText(Path.Combine(modules, ".package-lock.json"), "{}");
            Check(!(bool)ready.Invoke(null, tooling));
            File.WriteAllText(Path.Combine(modules, "acorn", "package.json"), "{}");
            Check((bool)ready.Invoke(null, tooling));
            File.SetLastWriteTimeUtc(lockfile, DateTime.UtcNow.AddMinutes(1));
            Check(!(bool)ready.Invoke(null, tooling));
        } else {
            app.GetField("DefaultPort", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, int.Parse(args[1]));
            string token = args[0] == "stale" ? "previous-server-session" : (string)Call("ReadServerToken");
            Check(!string.IsNullOrEmpty(token));
            Call("StopServerProcess", null, token);
        }
        Console.WriteLine("ok");
    }
}''', encoding='utf-8')
        executable = self.root_path('probe.exe')
        compiled = subprocess.run([compiler, '/nologo', '/target:exe', '/main:LauncherProbe',
            f'/out:{executable}', '/r:System.dll', '/r:System.Windows.Forms.dll',
            '/r:System.Web.Extensions.dll', str(source), str(probe)], capture_output=True, timeout=30)
        self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
        result = subprocess.run([executable, 'dependencies', self.temp_root, sys.executable],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        result = subprocess.run([executable, 'lifecycle'], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        import server
        from services import operation_status
        with mock.patch.object(server.Handler, 'log_message'):
            httpd = server.LocalServer(0)
            def serve():
                try:
                    httpd.serve_forever(poll_interval=0.01)
                finally:
                    httpd.server_close()
            thread = threading.Thread(target=serve, daemon=True)
            thread.start()
            identity = operation_status.start()
            try:
                stale = subprocess.run([executable, 'stale', str(httpd.server_address[1])], capture_output=True, timeout=10)
                self.assertEqual(stale.returncode, 0, stale.stdout + stale.stderr)
                self.assertFalse(httpd.status()['draining'], '旧窗口不能关闭重启后的新会话')
                child = subprocess.Popen([executable, 'shutdown', str(httpd.server_address[1])],
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 5
                    while not httpd.status()['draining'] and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue(httpd.status()['draining'], '复用的服务也应收到安全退出请求')
                    self.assertIsNone(child.poll(), '尚有写入时启动器必须继续等待')
                finally:
                    operation_status.finish(identity, True)
                    output, errors = child.communicate(timeout=10)
                self.assertEqual(child.returncode, 0, output + errors)
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
            finally:
                operation_status.finish(identity, True)
                httpd.shutdown()
                thread.join(timeout=3)

    def test_public_build_retains_password_groups_and_excludes_recovery_slots(self):
        """发布保留解锁需要的组密码和主密码包裹槽，恢复槽留在源数据。"""
        relative = '_studio/tooling/build-site.mjs'
        script = Path(self.root_path(relative))
        script.parent.mkdir(parents=True)
        shutil.copyfile(Path(PROJECT_ROOT) / relative, script)
        slot = {'salt': 'YQ==', 'iter': 100000, 'wrap': 'enc:YQ==.Yg=='}
        group_id = 'g_' + 'a' * 32
        group = {'v': 1, 'name': '分享组', 'dek_id': '0123456789abcdef', 'pw': slot, 'rc': slot,
                 'master_wrap': 'enc:Yw==.ZA=='}
        ring = {'v': 1, 'master_only': True, 'dek_id': 'fedcba9876543210', 'pw': slot, 'rc': slot, 'groups': {group_id: group}}
        ring['content'] = {'v': 1, 'dek_id': '0101010101010101', 'pw': slot, 'rc': slot,
                           'master_wrap': 'enc:Yw==.ZA==', 'wraps': {group_id: 'enc:Yw==.ZA=='}}
        Path(self.data_path('crypto-keyring.json')).write_text(json.dumps(ring), encoding='utf-8')
        subprocess.run([node_runtime.NODE_BIN, str(script)], check=True, capture_output=True, timeout=20)
        published = self.load_json(self.root_path('dist/data/crypto-keyring.json'))
        self.assertNotIn('rc', published)
        self.assertTrue(published['master_only'])
        self.assertEqual(published['content'], {key: val for key, val in ring['content'].items() if key != 'rc'})
        self.assertEqual(published['groups'][group_id], {key: val for key, val in group.items() if key != 'rc'})

    def test_01_nested_templates_and_regex_literals(self):
        result = analyze(r'''const regex = /alert\(x\)\/\/console.log/;
const text = `文字 ${`内层 ${console.log('real')}`} ${/debugger/.test('x')}`;
const comment = '/* var hidden */'; // alert('hidden')
window.alert('real');''')
        self.assertEqual(result['counts'], {'debugger': 0, 'var': 0, 'console': 1, 'alert': 1})
        self.assertIn('/alert', result['clean'])
        self.assertNotIn("alert('hidden')", result['clean'])

    def test_02_import_and_destructuring_exports_are_parsed(self):
        result = analyze('''const fake = "import x from './not-real.js'";
import { x } from './real.js'; export const { a, b: c } = x;
export { x as renamed }; export * from './other.js';''')
        self.assertEqual(result['imports'], ['./real.js', './other.js'])
        self.assertEqual(set(result['exports']), {'a', 'c', 'renamed'})
        self.assertEqual(result['stars'], ['./other.js'])

        result = analyze('''import('./dynamic.js'); export * as ns from './namespace.js';
export default class Example {};
export const { nested: { deep }, value = 3, ...rest } = source;
export let [first, , third = 1, ...tail] = values;
export { deep as "named-export" };''')
        self.assertEqual(result['imports'], ['./dynamic.js', './namespace.js'])
        self.assertEqual(set(result['exports']),
                         {'ns', 'default', 'deep', 'value', 'rest', 'first', 'third', 'tail', 'named-export'})
        self.assertEqual(result['stars'], [])

    def test_03_missing_node_fails_instead_of_skipping(self):
        with mock.patch.object(node_runtime, 'NODE_BIN', None):
            with self.assertRaises(RuntimeError):
                node_runtime.NodeTestCase.setUpClass()

    def test_04_group_versions_increment_once(self):
        source = "const VERSION_CONFIG = {default: '2026-001', groups: {cms: {version: '9', paths: ['custom/cms/']}}, files: {}};"
        updated, changes = bump_versions.bump_source(source, source, ['custom/cms/a.js', 'custom/cms/b.js', 'index.html'])
        self.assertEqual(len(changes), 2)
        config = standards.parse_version_config(updated)
        self.assertEqual(config['default'], '2026-002')
        self.assertEqual(config['groups']['cms'][0], '10')
        self.assertEqual(bump_versions.bump_source(updated, source, ['custom/cms/a.js'])[1], [])

    def _git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.temp_root, text=True, encoding='utf-8').strip()

    def _version_repo(self):
        self._git('init', '-q')
        self._git('config', 'user.name', 'MAERS test')
        self._git('config', 'user.email', 'test@example.invalid')
        hook_dir = Path(self.temp_root) / 'empty-hooks'
        hook_dir.mkdir()
        self._git('config', 'core.hooksPath', str(hook_dir))
        source = "const VERSION_CONFIG = {default: '1', groups: {}, files: {}};\n"
        version = Path(self.temp_root) / bump_versions.FILE
        version.write_text(source, encoding='utf-8')
        script = Path(self.temp_root) / 'app.js'
        script.write_text('const value = 1;\n', encoding='utf-8')
        self._git('add', bump_versions.FILE, 'app.js')
        self._git('commit', '-qm', 'fixture')
        script.write_text('const value = 2;\n', encoding='utf-8')
        self._git('add', 'app.js')
        script.write_text('const value = 3;\n', encoding='utf-8')
        return version, script

    def _bump_staged(self):
        with mock.patch.object(bump_versions, 'ROOT', Path(self.temp_root)), \
             mock.patch.object(standards, 'PROJECT_ROOT', self.temp_root), \
             mock.patch.object(sys, 'argv', ['bump_versions.py', '--staged']):
            return bump_versions.main()

    def test_05_commit_bump_preserves_unstaged_changes(self):
        version, script = self._version_repo()
        self.assertEqual(self._bump_staged(), 0)
        self.assertIn("default: '2'", self._git('show', ':' + bump_versions.FILE))
        self.assertIn('value = 2', self._git('show', ':app.js'))
        self.assertIn('value = 3', script.read_text(encoding='utf-8'))
        self.assertIn("default: '2'", version.read_text(encoding='utf-8'))

    def test_06_partial_version_staging_is_not_overwritten(self):
        version, _ = self._version_repo()
        changed = version.read_text(encoding='utf-8').replace("'1'", "'8'")
        version.write_text(changed, encoding='utf-8')
        with self.assertRaises(RuntimeError):
            self._bump_staged()
        self.assertEqual(version.read_text(encoding='utf-8'), changed)
        self.assertIn("default: '1'", self._git('show', ':' + bump_versions.FILE))

    def test_commit_rejects_tracked_bodies_and_keeps_them_after_untracking(self):
        self._version_repo()
        body = Path(self.temp_root) / 'markdown/notes/private.md'
        body.parent.mkdir(parents=True, exist_ok=True)
        body.write_text('PRIVATE BODY', encoding='utf-8')
        self._git('add', 'markdown/notes/private.md')
        with self.assertRaisesRegex(RuntimeError, '正文文件'):
            self._bump_staged()
        self._git('rm', '--cached', '--', 'markdown/notes/private.md')
        self.assertEqual(self._bump_staged(), 0)
        self.assertEqual(body.read_text(encoding='utf-8'), 'PRIVATE BODY')

    def test_07_internal_details_never_reach_api(self):
        with mock.patch.object(cms, 'save_json', side_effect=OSError('secret-token-and-private-path')):
            code, body = self.call_post('/api/save_modules', body=[{'title': '正常', 'url': 'notes.html'}])
        self.assertEqual(code, 500)
        self.assertNotIn('secret-token', json.dumps(body))

    def test_08_git_gate_failure_never_runs_git(self):
        with mock.patch.object(git_service.subprocess, 'run'), \
             mock.patch('tests.run_tests.run_pre_push_check', side_effect=RuntimeError('private marker')), \
             mock.patch.object(git_service, '_run_git_cmd') as run_git:
            result = git_service.commit_and_push('test')
        self.assertFalse(result['success'])
        self.assertEqual(result['step'], 'pre_check')
        self.assertNotIn('private marker', json.dumps(result))
        run_git.assert_not_called()

    def test_09_vendor_outputs_match_reviewable_sources(self):
        result = subprocess.run([node_runtime.NODE_BIN, '_studio/tooling/vendor-build.mjs', '--check'],
                                cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_10_git_status_preserves_unicode_and_rename_paths(self):
        self._version_repo()
        self._git('add', '.')
        self._git('commit', '-qm', 'rename fixture')
        self._git('mv', 'app.js', ' 新名称 中文.js')
        with mock.patch.object(git_service, 'PROJECT_ROOT', self.temp_root):
            status = git_service.get_git_status()
        self.assertEqual(status['change_count'], 1)
        self.assertEqual(status['changes'][0], {'status': 'R', 'file': ' 新名称 中文.js'})

    def test_11_git_timeout_stops_descendants(self):
        marker = Path(self.temp_root) / 'unexpected-push.txt'
        ready = Path(self.temp_root) / 'started.txt'
        child = (f'from pathlib import Path; import time; Path({str(ready)!r}).touch(); '
                 f'time.sleep(2); Path({str(marker)!r}).touch()')
        parent = f'import subprocess, sys, time; subprocess.Popen([sys.executable, "-c", {child!r}]); time.sleep(30)'
        real_popen = subprocess.Popen

        def launch(args, **kwargs):
            if args[0] == 'git':
                args = [sys.executable, '-c', parent]
            return real_popen(args, **kwargs)

        with mock.patch.object(git_service, 'PROJECT_ROOT', self.temp_root), \
             mock.patch.object(git_service.subprocess, 'Popen', side_effect=launch):
            result = git_service._run_git_cmd(['push'], timeout=1)
        self.assertTrue(ready.exists(), '子进程必须实际启动，不能空跑此用例')
        self.assertTrue(result['timed_out'])
        time.sleep(2)
        self.assertFalse(marker.exists(), '超时后子进程不能继续执行推送')

    def test_12_git_stages_and_push_failure_preserve_local_commit(self):
        for push_result in ({'code': 0, 'stdout': '', 'stderr': 'ok'},
                            {'code': 1, 'stdout': '', 'stderr': 'rejected'},
                            {'code': -1, 'stdout': '', 'stderr': '', 'timed_out': True}):
            with self.subTest(push_result=push_result):
                calls = []

                def run_git(args, timeout=30):
                    calls.append((args, timeout, git_service.get_git_progress()['step']))
                    output = {'status': 'M file', 'rev-parse': 'abc123\n'}.get(args[0], '')
                    return push_result if args[0] == 'push' else {'code': 0, 'stdout': output, 'stderr': ''}

                with mock.patch.object(git_service.subprocess, 'run'), \
                     mock.patch('tests.run_tests.run_pre_push_check', return_value={'passed': True}), \
                     mock.patch.object(git_service, '_run_git_cmd', side_effect=run_git):
                    result = git_service.commit_and_push()
                self.assertEqual(result['commit_hash'], 'abc123')
                self.assertEqual(result['success'], push_result['code'] == 0)
                self.assertEqual(git_service.get_git_progress()['step'], result['step'])
                commit = next(call for call in calls if call[0][0] == 'commit')
                self.assertIn('本地改动', commit[0][2])
                self.assertEqual(commit[2], 'commit')
                self.assertEqual(calls[-1], (['push', 'origin', 'HEAD'], 600, 'push'))
                if push_result.get('timed_out'):
                    self.assertEqual(result['step'], 'push_unknown')

    def test_13_git_progress_does_not_wait_for_storage_lock(self):
        import routes
        self.assertFalse(routes.ROUTES['GET']['/api/git/progress'].locked)
        git_service._set_progress('push', '正在校验并推送')
        code, body = routes.dispatch_get('/api/git/progress', {})
        self.assertEqual(code, 200)
        self.assertEqual(body['step'], 'push')
