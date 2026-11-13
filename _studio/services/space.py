"""
空间模块服务：外链元数据抓取与 space 数据维护。
"""

from __future__ import annotations
from .contracts import JsonObject

import os
import urllib.request
import urllib.parse
from html.parser import HTMLParser
from . import cms, storage

# ================= 配置 =================
SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SERVICE_DIR)  # _studio/
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')

# ================= HTML Parser for Metadata =================
class MetaParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = None
        self.description = None
        self.icon_url = None
        self.in_title = False
        
    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        
        # Title tag
        if tag == 'title':
            self.in_title = True
            
        # Meta description
        if tag == 'meta':
            name = attrs_dict.get('name', '').lower()
            property_attr = attrs_dict.get('property', '').lower()
            
            if name == 'description' or property_attr == 'og:description':
                self.description = attrs_dict.get('content', '')
                
        # Favicon
        if tag == 'link':
            rel = attrs_dict.get('rel', '').lower()
            if 'icon' in rel:
                self.icon_url = attrs_dict.get('href', '')
                
    def handle_data(self, data):
        if self.in_title and not self.title:
            self.title = data.strip()
            
    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False

# ================= URL Metadata Fetcher =================
def fetch_url_metadata(url):
    """
    抓取网站的 Title, Description, Favicon
    返回: { 'title': str, 'description': str, 'icon_url': str }
    """
    try:
        # 确保 URL 有协议
        if not url.startswith(('http://', 'https://')):
            url = 'https://' + url
            
        # 解析域名
        parsed = urllib.parse.urlparse(url)
        domain = parsed.netloc
        
        # 设置请求头
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        
        req = urllib.request.Request(url, headers=headers)
        
        # 获取页面内容
        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode('utf-8', errors='ignore')
            
        # 解析 HTML
        parser = MetaParser()
        parser.feed(html)
        
        # 处理 Favicon URL
        icon_url = parser.icon_url
        if icon_url:
            # 相对路径转绝对路径
            if icon_url.startswith('//'):
                icon_url = parsed.scheme + ':' + icon_url
            elif icon_url.startswith('/'):
                icon_url = f"{parsed.scheme}://{domain}{icon_url}"
            elif not icon_url.startswith('http'):
                icon_url = f"{parsed.scheme}://{domain}/{icon_url}"
        else:
            # 默认尝试 /favicon.ico
            icon_url = f"{parsed.scheme}://{domain}/favicon.ico"
            
        # 使用 Google Favicon API 作为备选
        google_icon = f"https://www.google.com/s2/favicons?sz=128&domain={domain}"
        
        return {
            'title': parser.title or domain,
            'description': parser.description or '',
            'icon_url': icon_url,
            'google_icon': google_icon  # 提供备选方案
        }
        
    except (OSError, ValueError, UnicodeError) as e:
        print(f"  [ SPACE ] ⚠️  URL 抓取失败 | Fetch failed: {url} - {e}")
        # 返回基础信息
        try:
            parsed = urllib.parse.urlparse(url if url.startswith('http') else 'https://' + url)
            domain = parsed.netloc
            return {
                'title': domain,
                'description': '',
                'icon_url': f"https://www.google.com/s2/favicons?sz=128&domain={domain}",
                'google_icon': f"https://www.google.com/s2/favicons?sz=128&domain={domain}"
            }
        except ValueError:
            return {
                'title': url,
                'description': '',
                'icon_url': 'ui/placeholder.svg',
                'google_icon': 'ui/placeholder.svg'
            }

# ================= Tree Operations =================
def load_tree() -> JsonObject:
    """Load space-tree.json"""
    tree_path = os.path.join(DATA_DIR, 'space-tree.json')
    if not os.path.exists(tree_path):
        return {"root": []}
    data = cms.load_json(tree_path)
    from . import validation
    validation.tree(data)
    return data

@storage.serialized
def save_tree(data: JsonObject) -> bool:
    from . import validation
    validation.tree(data)
    cms.save_json(os.path.join(DATA_DIR, 'space-tree.json'), data)
    return True

@storage.serialized
def update_node_tags(node_id, tags):
    """Recursively find node and update tags"""
    data = load_tree()
    
    def find_and_update(nodes):
        for node in nodes:
            if node.get('id') == node_id:
                if node.get('_enc'):
                    raise ValueError('请先解锁网站所属密码组')
                node['tags'] = tags
                return True
            if node.get('children'):
                if find_and_update(node['children']):
                    return True
        return False

    if find_and_update(data.get('root', [])):
        if save_tree(data):
            print(f"  [ SPACE ] 🏷️  Tags Updated: {node_id} ({len(tags)})")
            return True
    return False
