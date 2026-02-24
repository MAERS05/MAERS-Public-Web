import http.server
import socketserver
import os
import json
import urllib.parse
import sys
import routes

# ================= 1. 根目录锚定逻辑 =================
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
os.chdir(project_root)
sys.path.append(project_root)

# ================= 2. 配置 =================
PORT = 8000

# ================= 3. 请求处理 =================

class Handler(http.server.SimpleHTTPRequestHandler):

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        # 🔥 Disable Caching
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)

        # 委托给 Dispatcher
        code, data = routes.dispatch_get(parsed.path, query)
        
        if code != 404 or (data is not None):
            # 注意: 404 有时候也是 API 返回的明确错误，带有 error msg
            # 如果 data 是 None，才说明 API 没接管，交给 super() 查静态文件
            if data is not None:
                self._send_json(code, data)
                return

        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        
        # 读取 Body
        length = int(self.headers.get('Content-Length', 0))
        body_data = {}
        file_data = None
        
        # 特殊处理 /upload (它传输的是二进制图片数据，不是 JSON)
        if parsed.path == '/upload':
            if length > 0:
                file_data = self.rfile.read(length)
        elif length > 0:
            try:
                body_data = json.loads(self.rfile.read(length))
            except:
                pass

        try:
            code, data = routes.dispatch_post(parsed.path, query, body_data, file_data)
            self._send_json(code, data)
            
        except Exception as e:
            print(f"❌ Error: {e}")
            import traceback
            traceback.print_exc()
            self.send_error(500, str(e))

    # --- 辅助方法 ---

    def _send_json(self, code, data):
        self.send_response(code)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    print(f"🚀 服务器已启动: http://localhost:{PORT}")
    
    # Init Data Sync
    try:
        print("🔄 [Server] Syncing Gallery Data...")
        routes.photos.sync_gallery_js()
    except Exception as e:
        print(f"⚠️ [Server] Init Sync Failed: {e}")
        
    try: httpd = socketserver.TCPServer(("", PORT), Handler); httpd.serve_forever()
    except KeyboardInterrupt: pass
