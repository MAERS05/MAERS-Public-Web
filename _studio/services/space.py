import os
import json
import urllib.request
import urllib.parse
import re
from html.parser import HTMLParser
from . import cms

# ================= 配置 =================
SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(SERVICE_DIR)  # _studio/
PROJECT_ROOT = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, 'data')
SPACE_JSON_PATH = os.path.join(DATA_DIR, 'space-collections.json')

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
        
    except Exception as e:
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
        except:
            return {
                'title': url,
                'description': '',
                'icon_url': 'ui/placeholder.svg',
                'google_icon': 'ui/placeholder.svg'
            }

# ================= JSON 数据操作 =================
def load_collections():
    """加载 space-collections.json"""
    if not os.path.exists(SPACE_JSON_PATH):
        return []
    try:
        with open(SPACE_JSON_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"  [ SPACE ] ❌ 加载失败 | Load failed: {e}")
        return []

def save_collections(data):
    """保存 space-collections.json"""
    try:
        os.makedirs(os.path.dirname(SPACE_JSON_PATH), exist_ok=True)
        
        # Atomic write
        temp_path = SPACE_JSON_PATH + '.tmp'
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            
        if os.path.exists(SPACE_JSON_PATH):
            os.remove(SPACE_JSON_PATH)
        os.rename(temp_path, SPACE_JSON_PATH)
        
        print(f"  [ SPACE ] 💾 数据已保存 | Data saved")
        return True
    except Exception as e:
        print(f"  [ SPACE ] ❌ 保存失败 | Save failed: {e}")
        if os.path.exists(temp_path):
            try: os.remove(temp_path)
            except: pass
        return False

# ================= CRUD 操作 =================
def add_collection(item_data):
    """添加新的收藏项"""
    collections = load_collections()
    
    # 检查 ID 是否已存在
    if any(c['id'] == item_data['id'] for c in collections):
        raise ValueError(f"ID '{item_data['id']}' already exists")
    
    # 添加到列表开头
    collections.insert(0, item_data)
    
    if save_collections(collections):
        print(f"  [ SPACE ] 🆕 已添加 | Added: {item_data['title']}")
        return True
    return False

def update_collection(item_id, update_data):
    """更新收藏项"""
    collections = load_collections()
    
    for item in collections:
        if item['id'] == item_id:
            # 更新字段
            for key, value in update_data.items():
                item[key] = value # 允许修改 ID
                    
            if save_collections(collections):
                print(f"  [ SPACE ] ✎  已更新 | Updated: {item_id}")
                return True
            return False
            
    raise ValueError(f"Item with ID '{item_id}' not found")

def delete_collection(item_id):
    """删除收藏项"""
    collections = load_collections()
    
    # 过滤掉要删除的项
    new_collections = [c for c in collections if c['id'] != item_id]
    
    if len(new_collections) == len(collections):
        raise ValueError(f"Item with ID '{item_id}' not found")
        
    if save_collections(new_collections):
        print(f"  [ SPACE ] 🗑️  已删除 | Deleted: {item_id}")
        return True
    return False

def reorder_collections(id_list):
    """重新排序收藏项"""
    collections = load_collections()
    
    # 创建 ID -> Item 映射
    items_map = {item['id']: item for item in collections}
    
    # 按新顺序重组
    reordered = []
    for item_id in id_list:
        if item_id in items_map:
            reordered.append(items_map[item_id])
            
    # 添加不在列表中的项（防止丢失）
    for item in collections:
        if item['id'] not in id_list:
            reordered.append(item)
            
    if save_collections(reordered):
        print(f"  [ SPACE ] ↕️  已重排序 | Reordered")
        return True
    return False

# ================= Tree Operations =================
def load_tree():
    """Load space-tree.json"""
    tree_path = os.path.join(DATA_DIR, 'space-tree.json')
    if not os.path.exists(tree_path):
        return {"root": []}
    try:
        with open(tree_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"  [ SPACE ] ❌ Load Tree failed: {e}")
        return {"root": []}

def save_tree(data):
    """Save space-tree.json"""
    tree_path = os.path.join(DATA_DIR, 'space-tree.json')
    try:
        cms.save_json(tree_path, data)
        return True
    except Exception as e:
        print(f"  [ SPACE ] ❌ Save Tree failed: {e}")
        return False

def update_node_tags(node_id, tags):
    """Recursively find node and update tags"""
    data = load_tree()
    
    def find_and_update(nodes):
        for node in nodes:
            if node.get('id') == node_id:
                node['tags'] = tags
                return True
            if node.get('children'):
                if find_and_update(node['children']):
                    return True
        return False

    if find_and_update(data.get('root', [])):
        if save_tree(data):
            print(f"  [ SPACE ] 🏷️  Tags Updated: {node_id} -> {tags}")
            return True
    return False
