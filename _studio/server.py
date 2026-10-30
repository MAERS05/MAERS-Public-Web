"""
本地管理后端入口：启动 HTTP 服务、托管静态文件、转交 routes 分发，并在启动时执行数据对齐。
"""

import http.server
import os
import json
import urllib.parse
import sys
import subprocess
import importlib.util
import importlib.metadata
import secrets
import socket
import mimetypes
from services import private_session

import config

# ================= 0. 依赖库自动检测与安装 =================
REQUIRED_PACKAGES = [
    ("Pillow", "PIL"),
    ("pillow-avif-plugin", "pillow_avif"),
    ("boto3", "boto3"),
]

def ensure_dependencies():
    """只安装已锁定的依赖；安装失败时停止启动，避免使用不确定的环境。"""
    requirements = os.path.join(config.BASE_DIR, 'requirements.txt')
    with open(requirements, encoding='utf-8') as source:
        pinned = [line.strip().split('==') for line in source
                  if line.strip() and not line.lstrip().startswith('#')]
    for package, version in pinned:
        try:
            installed = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            installed = None
        if installed != version:
            print("  [ DEPS ] 📦 安装锁定版本依赖 | Installing pinned dependencies...")
            subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-r', requirements])
            break
    for package, module in REQUIRED_PACKAGES:
        if importlib.util.find_spec(module) is None:
            raise RuntimeError(f'Missing dependency: {package}')

# 导入测试时不安装依赖、不改变工作目录；业务模块在正式启动时加载。
routes = None

# ================= 1. 根目录锚定逻辑 =================
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)

# ================= 2. 配置 =================
PORT = config.PORT


class LocalServer(http.server.ThreadingHTTPServer):
    """每次启动生成独立令牌，仅在 IPv4 回环地址提供服务。"""

    def __init__(self, port=PORT, handler=None):
        self.session_token = secrets.token_urlsafe(32)
        super().__init__((config.HOST, port), handler or Handler)

    @property
    def allowed_hosts(self):
        port = self.server_address[1]
        return {f'localhost:{port}', f'127.0.0.1:{port}'}

    @property
    def allowed_origins(self):
        return {f'http://{host}' for host in self.allowed_hosts}

# ================= 3. 请求处理 =================

def _is_private_static_path(path):
    """按 Windows 路径语义拒绝内部目录、隐藏文件、凭据及数据流别名。"""
    parts = [part.casefold().rstrip(' .') for part in path.replace('\\', '/').split('/') if part]
    return any(not part or part.startswith('.') or ':' in part for part in parts) or bool(
        parts and (parts[0] == '_studio' or parts[-1] in ('r2_config.json', 'media_config.json')))


class Handler(http.server.SimpleHTTPRequestHandler):

    timeout = 15

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=config.PROJECT_ROOT, **kwargs)

    def parse_request(self):
        if not super().parse_request():
            return False
        # Host 白名单阻止 DNS 重绑定；来源检查在静态文件和所有 API 分发前执行。
        hosts = self.headers.get_all('Host', [])
        if len(hosts) != 1 or hosts[0] not in self.server.allowed_hosts:
            self._reject(403, 'Untrusted Host')
            return False
        decoded_path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path).replace('\\', '/')
        try:
            target = os.path.normcase(os.path.realpath(self.translate_path(self.path)))
            root = os.path.normcase(os.path.realpath(self.directory))
            relative = os.path.relpath(target, root).replace('\\', '/')
            private = os.path.commonpath([root, target]) != root or _is_private_static_path(decoded_path)
            private = private or (relative != '.' and _is_private_static_path(relative))
        except (OSError, ValueError):
            private = True
        if private:
            self._reject(403, 'Private local file')
            return False
        if routes is not None and relative.split('/')[0].casefold() in ('data', 'photos'):
            try:
                with routes.storage.LOCK:
                    routes.storage._recover_if_needed()
            except Exception:
                self._reject(503, 'Data recovery is pending; check Studio logs')
                return False
        origins = self.headers.get_all('Origin', [])
        if len(origins) > 1 or (origins and origins[0] not in self.server.allowed_origins):
            self._reject(403, 'Untrusted Origin')
            return False
        if not origins and self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self._reject(403, 'Cross-site request denied')
            return False
        return True

    def end_headers(self):
        origin = getattr(self, 'headers', {}).get('Origin')
        if origin in self.server.allowed_origins:
            self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Vary', 'Origin')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-MAERS-App', 'MAERS-Public-Web')
        # 🔥 Disable Caching
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)

        if parsed.path == '/api/session':
            # 自定义请求头使跨源读取必须经过预检；令牌不写入文件或 URL。
            if self.headers.get('X-MAERS-Client') != 'studio':
                return self._reject(403, 'Session client header required')
            return self._send_json(200, {'token': self.server.session_token})

        # 友好的无扩展名路由映射
        if parsed.path in ('/admin', '/admin-portal'):
            self.path = '/admin-portal.html'
            return super().do_GET()

        private = private_session
        trusted = secrets.compare_digest(self.headers.get('X-MAERS-Token', ''), self.server.session_token)
        if parsed.path == '/api/crypto/keyring' and not trusted:
            return self._reject(403, 'Invalid session token', 'invalid_session')
        if parsed.path.startswith('/api/private/media/'):
            if not private.media_authorized(self.headers.get('Cookie')):
                return self._reject(403, 'Private media authorization required')
            key = urllib.parse.unquote(parsed.path[len('/api/private/media/'):])
            try:
                with routes.storage.LOCK, private.context():
                    content = private.media_bytes(key)
                return self._send_bytes(mimetypes.guess_type(key)[0] or 'application/octet-stream', content)
            except ConnectionError:
                self.close_connection = True
                return
            except (ValueError, OSError):
                return self._reject(403, 'Private media is not available')
        try:
            with private.context(trusted):
                if trusted:
                    private.require_ready(parsed.path)
                code, data = routes.dispatch_get(parsed.path, query)
                if data is not None:
                    return self._send_json(code, data)
                if trusted:
                    with routes.storage.LOCK:
                        content = private.static(self.translate_path(self.path))
                    if content is not None:
                        return self._send_bytes(*content)
        except ConnectionError:
            self.close_connection = True
            return
        except PermissionError:
            return self._reject(403, '请先验证主密码', 'private_admin_required')
        except (ValueError, OSError):
            return self._reject(503, '私密内容读取失败，请检查主密码或恢复备份')

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)

        if self.headers.get('Origin') not in self.server.allowed_origins:
            return self._reject(403, 'Trusted Origin required')
        token = self.headers.get('X-MAERS-Token', '')
        if not secrets.compare_digest(token.encode('utf-8'), self.server.session_token.encode('ascii')):
            return self._reject(403, 'Invalid session token', 'invalid_session')

        is_upload = parsed.path.rstrip('/') == '/upload'
        if not is_upload and self.headers.get_content_type() != 'application/json':
            return self._reject(415, 'Content-Type must be application/json')
        if self.headers.get('Transfer-Encoding') is not None:
            return self._reject(400, 'Transfer-Encoding is not supported')
        lengths = self.headers.get_all('Content-Length', [])
        if not lengths:
            return self._reject(411, 'Content-Length required')
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            return self._reject(400, 'Invalid Content-Length')
        if len(lengths[0]) > 20:
            return self._reject(413, 'Request body too large')
        length = int(lengths[0])
        limit = config.MAX_UPLOAD_BYTES if is_upload else config.MAX_JSON_BYTES
        if length > limit:
            return self._reject(413, 'Request body too large')
        try:
            raw = self.rfile.read(length)
        except (TimeoutError, socket.timeout):
            return self._reject(408, 'Request body timeout')
        if len(raw) != length:
            return self._reject(400, 'Incomplete request body')

        body_data = {}
        file_data = None
        if is_upload:
            if not raw:
                return self._reject(400, 'Empty upload')
            file_data = raw
        else:
            try:
                body_data = json.loads(raw)
            except (ValueError, UnicodeDecodeError, RecursionError):
                return self._reject(400, 'Invalid JSON body')
            if not isinstance(body_data, (dict, list)):
                return self._reject(400, 'JSON body must be an object or array')

        try:
            with private_session.context():
                code, data = routes.dispatch_post(parsed.path, query, body_data, file_data)
                self._send_json(code, data)
            
        except ConnectionError:
            self.close_connection = True
        except Exception as e:
            print(f"  [ SERVER ] ❌ 请求处理异常 | Request error: {e}")
            import traceback
            traceback.print_exc()
            self._send_json(500, {'error': 'Internal server error'})

    def do_OPTIONS(self):
        if self.headers.get('Origin') not in self.server.allowed_origins:
            return self._reject(403, 'Trusted Origin required')
        if self.headers.get('Access-Control-Request-Method') not in ('GET', 'POST'):
            return self._reject(405, 'Method not allowed')
        requested = {value.strip().lower() for value in
                     self.headers.get('Access-Control-Request-Headers', '').split(',') if value.strip()}
        if not requested <= {'content-type', 'x-maers-token', 'x-maers-client'}:
            return self._reject(403, 'Request headers not allowed')
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-MAERS-Token, X-MAERS-Client')
        self.send_header('Content-Length', '0')
        self.end_headers()

    # --- 辅助方法 ---

    def _reject(self, code, message, error_code=None):
        # 拒绝请求时不继续读取请求体，也不复用可能仍有未读数据的连接。
        self.close_connection = True
        data = {'error': message}
        if error_code:
            data['code'] = error_code
        self._send_json(code, data)

    def _send_json(self, code, data):
        private = private_session
        if private and private.active():
            data = private.view(data)
        payload = json.dumps(data).encode('utf-8')
        self.send_response(code)
        if private and urllib.parse.urlsplit(self.path).path in ('/api/crypto/admin-session', '/api/crypto/admin-session/close') and code == 200:
            self.send_header('Set-Cookie', private.cookie_header())
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(payload)

    def _send_bytes(self, content_type, content):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(content)

if __name__ == '__main__':
    if sys.stdout is None:
        sys.stdout = open(os.devnull, 'w', encoding='utf-8')
    elif hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    if sys.stderr is None:
        sys.stderr = open(os.devnull, 'w', encoding='utf-8')
    elif hasattr(sys.stderr, 'reconfigure'):
        try:
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

    ensure_dependencies()
    import routes
    print(f"  [ SERVER ] 🚀 服务器已启动 | Server started: http://localhost:{PORT}")
    
    from services import storage_journal
    with storage_journal.process_lock():
        # 先恢复未完成事务，再允许静态读取或业务写入。
        try:
            routes.storage.recover()
            routes.crypto_keyring.migrate()
            print("  [ SERVER ] 🔄 从 JSON 重建图库缓存 | Rebuilding gallery cache...")
            routes.photos.rebuild_cache()
            print("  [ SERVER ] 🔄 从 JSON 重建 CMS 缓存 | Rebuilding CMS cache...")
            routes.cms.rebuild_cache()
        except Exception as e:
            print(f"  [ SERVER ] ❌ 缓存重建失败，停止启动 | Cache rebuild failed; startup aborted: {e}")
            raise
        
        try:
            with LocalServer() as httpd:
                httpd.serve_forever()
        except KeyboardInterrupt:
            pass

