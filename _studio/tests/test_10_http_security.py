"""真实回环 HTTP 回归：来源、令牌、预检、请求体边界与沙盒写入。"""

import http.client
import json
import socket
import threading
from pathlib import Path
from unittest import mock

from .sandbox import SandboxTestCase, config, routes
from services import git_service
import server


class QuietHandler(server.Handler):
    """测试期间关闭访问日志，保留服务行为。"""

    def log_message(self, *_args):
        pass


class Test10_HttpSecurity(SandboxTestCase):
    def setUp(self):
        super().setUp()
        self.router = mock.Mock()
        self.router.dispatch_post.return_value = (200, {'success': True})
        self.router.dispatch_get.return_value = (404, None)
        patcher = mock.patch.object(server, 'routes', self.router)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.httpd = server.LocalServer(0, QuietHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.host = f'127.0.0.1:{self.httpd.server_address[1]}'
        self.origin = f'http://{self.host}'
        self.auth = {'Host': self.host, 'Origin': self.origin,
                     'X-MAERS-Token': self.httpd.session_token,
                     'Content-Type': 'application/json'}

    def stop_server(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, body=b'', headers=None):
        """不隐式补请求头，便于测试缺失或重复的 Content-Length。"""
        with socket.create_connection(self.httpd.server_address, timeout=3) as connection:
            # 头部和测试 body 一次发送，避免服务提前拒绝与客户端二次发送形成竞态。
            wire = f'{method} {path} HTTP/1.1\r\n'
            pairs = headers.items() if isinstance(headers, dict) else headers
            for key, value in pairs or [('Host', self.host)]:
                wire += f'{key}: {value}\r\n'
            connection.sendall((wire + '\r\n').encode('ascii') + body)
            response = http.client.HTTPResponse(connection, method=method)
            response.begin()
            return response.status, dict(response.getheaders()), response.read()

    def post(self, path='/api/save_modules', body=b'{}', overrides=None):
        headers = {**self.auth, 'Content-Length': str(len(body)), **(overrides or {})}
        headers = {key: value for key, value in headers.items() if value is not None}
        return self.request('POST', path, body, headers)

    def test_09_full_keyring_requires_local_session(self):
        """本机完整密钥环接口禁止匿名及伪造会话读取。"""
        for headers in ({}, {'X-MAERS-Token': 'invalid'}):
            self.assertEqual(self.request('GET', '/api/crypto/keyring', headers={'Host': self.host, **headers})[0], 403)
        with mock.patch.object(server, 'routes', routes):
            code, _, _ = self.request('GET', '/api/crypto/keyring', headers=self.auth)
            self.assertEqual(code, 200)

    def test_01_loopback_and_per_start_token(self):
        """监听仅限回环；每个服务实例生成新令牌。"""
        self.assertEqual(self.httpd.server_address[0], '127.0.0.1')
        with server.LocalServer(0, QuietHandler) as other:
            self.assertNotEqual(self.httpd.session_token, other.session_token)
        self.assertGreaterEqual(len(self.httpd.session_token), 40)

    def test_11_private_recovery_and_credentials_are_never_static_files(self):
        """同源 GET/HEAD 也拒绝私有文件及 Windows 大小写、尾点、数据流和路径别名。"""
        root = Path(self.temp_root)
        for name in ('_studio/tools/media_config.json', '_studio/tools/r2_config.json',
                     '_studio/server.py', 'public/media_config.json', '.git/config'):
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('FAKE_PRIVATE_MARKER', encoding='utf-8')
        (root / 'index.html').write_text('PUBLIC_PAGE', encoding='utf-8')
        for path in ('/_studio/.local/backups/test/manifest.json',
                     '/_studio/%2elocal/media/private/a.png', '/.git/config',
                     '/_studio/tools/media_config.json', '/_studio/tools/r2_config.json',
                     '/_STUDIO/TOOLS/MEDIA_CONFIG.JSON', '/_sTuDiO/tools/R2_cOnFiG.JsOn',
                     '/%5fstudio/tools/%6dedia_config.json', '/_studio/server.py',
                     '/_studio./tools/media_config.json.', '/_studio%20/tools/media_config.json%20',
                     '/_studio/tools/media_config.json::$DATA', '/_studio%5ctools%5cMEDIA_CONFIG.JSON',
                     '/public/MEDIA_CONFIG.JSON', '/public/MeDiA_CoNfIg.JsOn.',
                     '/public/media_config.json::$DATA'):
            for method in ('GET', 'HEAD'):
                with self.subTest(path=path, method=method):
                    code, headers, body = self.request(method, path, headers={'Host': self.host})
                    self.assertEqual(code, 403)
                    self.assertNotIn(b'FAKE_PRIVATE_MARKER', body)
        # 最终目标仍受保护，不能通过路径转换或链接别名绕过请求路径检查。
        for target in (root / '_studio/tools/media_config.json', root.parent / 'outside.json'):
            with mock.patch.object(QuietHandler, 'translate_path', return_value=str(target)):
                for method in ('GET', 'HEAD'):
                    self.assertEqual(self.request(method, '/public-alias.json')[0], 403)
        code, _, body = self.request('GET', '/index.html')
        self.assertEqual((code, body), (200, b'PUBLIC_PAGE'))

    def test_02_session_bootstrap_and_dns_rebinding_guard(self):
        """合法页面读取令牌；恶意来源、空来源、重绑定 Host 无法读取。"""
        headers = {'Host': self.host, 'X-MAERS-Client': 'studio'}
        code, response_headers, body = self.request('GET', '/api/session', headers=headers)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)['token'], self.httpd.session_token)
        self.assertIn('no-store', response_headers['Cache-Control'])
        self.assertEqual(response_headers['X-Content-Type-Options'], 'nosniff')
        self.assertNotIn('Access-Control-Allow-Origin', response_headers)
        cases = [
            {'Origin': 'https://evil.example'}, {'Origin': 'null'},
            {'Origin': 'http://localhost:1'}, {'Host': 'evil.example'},
            {'Sec-Fetch-Site': 'cross-site'}, {'X-MAERS-Client': ''},
        ]
        for extra in cases:
            with self.subTest(extra=extra):
                code, response_headers, body = self.request('GET', '/api/session', headers={**headers, **extra})
                self.assertEqual(code, 403)
                self.assertNotIn(self.httpd.session_token.encode(), body)
                self.assertNotIn('Access-Control-Allow-Origin', response_headers)
        # HEAD 静态读取同样经过 Host 校验。
        self.assertEqual(self.request('HEAD', '/manifest.json', headers={'Host': 'evil.example'})[0], 403)

    def test_03_write_routes_require_origin_and_token(self):
        """上传、落盘、推送、清理和外部编辑器入口统一拒绝未授权请求。"""
        paths = ['/upload', '/upload/', '/delete', '/reorder', '/api/admin/clean_data',
                 '/api/git/commit-push', '/api/photos/register_r2', '/api/crypto/keyring',
                 '/api/cms/node?module=notes&action=open_external']
        for path in paths:
            for extra in ({'X-MAERS-Token': None}, {'X-MAERS-Token': 'wrong'},
                          {'Origin': None}, {'Origin': 'null'}, {'Origin': 'https://evil.example'}):
                with self.subTest(path=path, extra=extra):
                    self.assertEqual(self.post(path, overrides=extra)[0], 403)
        self.router.dispatch_post.assert_not_called()

    def test_04_cors_preflight_is_limited_to_local_origins(self):
        """localhost 和 127.0.0.1 可互访；任意网站和未允许的请求头不可预检。"""
        origin = f'http://localhost:{self.httpd.server_address[1]}'
        headers = {'Host': self.host, 'Origin': origin,
                   'Access-Control-Request-Method': 'POST',
                   'Access-Control-Request-Headers': 'content-type, x-maers-token'}
        code, response_headers, _ = self.request('OPTIONS', '/api/save_modules', headers=headers)
        self.assertEqual(code, 204)
        self.assertEqual(response_headers['Access-Control-Allow-Origin'], origin)
        for extra, expected in (({'Origin': 'https://evil.example'}, 403),
                                ({'Access-Control-Request-Method': 'DELETE'}, 405),
                                ({'Access-Control-Request-Headers': 'x-untrusted'}, 403)):
            self.assertEqual(self.request('OPTIONS', '/api/save_modules', headers={**headers, **extra})[0], expected)
        self.assertEqual(self.post(overrides={'Origin': origin})[0], 200)

    def test_05_invalid_json_and_content_type_do_not_dispatch(self):
        """text/plain 简单请求、损坏 JSON、空 body 和标量均不会进入业务层。"""
        for content_type in ('text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', None):
            self.assertEqual(self.post(overrides={'Content-Type': content_type})[0], 415)
        for body in (b'{broken', b'', b'null', b'42', b'"text"', b'\xff'):
            self.assertEqual(self.post(body=body)[0], 400)
        self.router.dispatch_post.assert_not_called()
        self.assertEqual(self.post(body=b'[]', overrides={'Content-Type': 'application/json; charset=utf-8'})[0], 200)
        self.assertEqual(self.router.dispatch_post.call_args.args[2], [])

    def test_06_length_validation_and_limits_before_read(self):
        """异常长度和分块编码被拒绝；超限请求无需发送 body 即返回 413。"""
        for value, expected in ((None, 411), ('-1', 400), ('abc', 400), ('1, 1', 400), ('9' * 30, 413)):
            headers = {**self.auth}
            if value is not None:
                headers['Content-Length'] = value
            self.assertEqual(self.request('POST', '/api/save_modules', headers=headers)[0], expected)
        duplicate = list(self.auth.items()) + [('Content-Length', '2'), ('Content-Length', '2')]
        self.assertEqual(self.request('POST', '/api/save_modules', headers=duplicate)[0], 400)
        self.assertEqual(self.post(overrides={'Transfer-Encoding': 'chunked'})[0], 400)
        for path, limit in (('/api/save_modules', config.MAX_JSON_BYTES),
                            ('/upload', config.MAX_UPLOAD_BYTES), ('/upload/', config.MAX_UPLOAD_BYTES)):
            headers = {**self.auth, 'Content-Length': str(limit + 1)}
            self.assertEqual(self.request('POST', path, headers=headers)[0], 413)
        self.router.dispatch_post.assert_not_called()
        with mock.patch.object(config, 'MAX_UPLOAD_BYTES', 4):
            self.assertEqual(self.post('/upload', b'abcd', {'Content-Type': 'image/png'})[0], 200)
            self.assertEqual(self.router.dispatch_post.call_args.args[3], b'abcd')
            self.assertEqual(self.post('/upload/', b'abcde')[0], 413)

    def test_07_truncated_body_rejected(self):
        """客户端提前关闭写端时，不把不完整 JSON 当作成功请求。"""
        with socket.create_connection(self.httpd.server_address, timeout=3) as client:
            headers = {**self.auth, 'Content-Length': '10'}
            wire = 'POST /api/save_modules HTTP/1.1\r\n'
            wire += ''.join(f'{key}: {value}\r\n' for key, value in headers.items())
            client.sendall((wire + '\r\n{}').encode())
            client.shutdown(socket.SHUT_WR)
            response = http.client.HTTPResponse(client)
            response.begin()
            self.assertEqual(response.status, 400)
            response.read()
        self.router.dispatch_post.assert_not_called()

    def test_08_authenticated_real_route_writes_only_sandbox(self):
        """真实 HTTP 鉴权通过后，数组配置可经真实路由写入临时目录。"""
        self.router.dispatch_post.side_effect = routes.dispatch_post
        modules = [{'id': 'notes', 'title': '测试', 'url': 'notes.html'}]
        code, _, _ = self.post(body=json.dumps(modules).encode())
        self.assertEqual(code, 200)
        self.assertEqual(self.load_json(config.MODULES_JSON_FILE), modules)

    def test_09_expired_session_never_reaches_dispatch(self):
        """服务换令牌时返回明确错误码，允许客户端安全刷新后重试。"""
        self.httpd.session_token = 'new-session'
        code, _, body = self.post()
        self.assertEqual(code, 403)
        self.assertEqual(json.loads(body)['code'], 'invalid_session')
        self.router.dispatch_post.assert_not_called()
        self.assertEqual(self.post(overrides={'X-MAERS-Token': 'new-session'})[0], 200)

    def test_10_dependency_install_uses_lockfile(self):
        """依赖缺失时只按 requirements 安装，失败不能静默继续启动。"""
        with mock.patch.object(server.importlib.metadata, 'version', return_value='missing'), \
                mock.patch.object(server.subprocess, 'check_call') as install:
            server.ensure_dependencies()
            self.assertEqual(install.call_args.args[0][-2], '-r')
            self.assertTrue(install.call_args.args[0][-1].endswith('requirements.txt'))
            install.side_effect = RuntimeError('install failed')
            with self.assertRaises(RuntimeError):
                server.ensure_dependencies()

    def test_12_git_reads_respond_while_commit_holds_write_lock(self):
        """真实 HTTP 提交占锁期间，状态与进度请求仍能响应。"""
        entered, release = threading.Event(), threading.Event()

        def commit(_message):
            git_service._set_progress('push', '正在推送')
            entered.set()
            release.wait(3)
            return {'success': True, 'step': 'done', 'msg': '完成'}

        self.router.dispatch_post.side_effect = routes.dispatch_post
        self.router.dispatch_get.side_effect = routes.dispatch_get
        with mock.patch.object(git_service, 'commit_and_push', side_effect=commit), \
             mock.patch.object(git_service, 'get_git_status', return_value={'success': True, 'ahead_count': 1}):
            worker = threading.Thread(target=lambda: self.post('/api/git/commit-push'))
            worker.start()
            try:
                self.assertTrue(entered.wait(1))
                for path in ('/api/git/progress', '/api/git/status'):
                    code, _, body = self.request('GET', path, headers={'Host': self.host})
                    self.assertEqual(code, 200)
                    self.assertTrue(worker.is_alive(), '只读请求不能等到提交释放锁才返回')
                    if path.endswith('progress'):
                        self.assertEqual(json.loads(body)['api_version'], 1)
            finally:
                release.set()
                worker.join(timeout=3)
