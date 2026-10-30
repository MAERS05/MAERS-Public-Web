"""浏览器测试专用服务：生产 HTTP/路由逻辑，所有业务数据隔离到临时目录。"""
import http.server
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / '_studio'))
from tests.sandbox import SandboxTestCase, cms, photos, config
from tests.helpers import make_test_png_bytes
from services import storage, private_session
import routes
import server


def seed() -> None:
    private_session.close({})
    storage.remove(Path(config.DATA_DIR) / 'crypto-keyring.json')
    for module in cms.JS_SYNC_MAP:
        cms.save_json(Path(config.DATA_DIR) / f'{module}-tree.json', {'root': []})
    storage.write_text(Path(config.DATA_DIR) / 'notes/browser.md', '# 浏览器测试\n\n正文内容与 [[第二篇]]。\n\n## 小节\n\n- [ ] 未完成任务\n')
    storage.write_text(Path(config.DATA_DIR) / 'notes/second.md', '# 第二篇\n\n链接导航成功。')
    cms.save_module_tree('notes', {'root': [
        {'id': 'browser-note', 'type': 'note', 'title': '浏览器测试', 'content': 'notes/browser.md', 'tags': []},
        {'id': 'second-note', 'type': 'note', 'title': '第二篇', 'content': 'notes/second.md', 'tags': []}]})
    for name, data in [('index-cards', [{'id': 'notes', 'title': '笔记', 'url': 'notes.html', 'icon': '📝'}]),
                       ('admin-portal', []), ('changelog', []), ('album-config', []), ('music-data', []),
                       ('space-tree', {'root': []}), ('space-collections', []), ('photos-data', {})]:
        cms.save_json(Path(config.DATA_DIR) / f'{name}.json', data)
    for scope in ['cms-' + m for m in cms.JS_SYNC_MAP] + ['cms', 'photos', 'space']:
        cms.save_json(Path(config.DATA_DIR) / 'tags' / f'{scope}-tag-categories.json', [])
    photos.rebuild_cache()


class BrowserHandler(server.Handler):
    def translate_path(self, path: str) -> str:
        self.directory = config.PROJECT_ROOT if urlsplit(path).path.startswith(('/data/', '/photos/')) else str(ROOT)
        return http.server.SimpleHTTPRequestHandler.translate_path(self, path)

    def do_POST(self) -> None:
        if self.path == '/__test/reset':
            seed()
            self._send_json(200, {'status': 'success'})
            return
        if self.path == '/__test/cloud-covers':
            result = {}
            for module, category in [('literature', 'literaturecovers'), ('games', 'gamecovers'), ('videos', 'videocovers')]:
                name = '20261028_120000_42.png'
                key = f'photos/images/{category}/{name}'
                storage.write_bytes(Path(config.PROJECT_ROOT) / key, make_test_png_bytes('blue'))
                row = photos.handle_register_r2({'category': category, 'path': key, 'name': name})
                node_id = f'cloud-{module}'
                cover = f'https://media.example.com/{key}' if module == 'literature' else key
                cms.save_module_tree(module, {'root': [{'id': node_id, 'type': 'note', 'title': '手机上传封面',
                    'content': '', 'tags': [], 'coverImage': cover}]})
                result[module] = {'nodeId': node_id, **row}
            self._send_json(200, result)
            return
        super().do_POST()

    def log_message(self, fmt: str, *args: object) -> None:
        pass


if __name__ == '__main__':
    sandbox = SandboxTestCase()
    sandbox.setUp()
    server.routes = routes
    try:
        seed()
        with server.LocalServer(port=int(os.environ.get('MAERS_E2E_PORT', '8765')), handler=BrowserHandler) as httpd:
            httpd.serve_forever()
    finally:
        sandbox.doCleanups()
