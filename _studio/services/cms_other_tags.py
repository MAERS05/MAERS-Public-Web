import os
import json
import sqlite3
from .cms_tags import TagStrategy

# ================= 特殊模块策略 (Photos, Space) =================

class PhotosTagStrategy(TagStrategy):
    def _get_tags_file(self, module):
        DATA_DIR = self.context['DATA_DIR']
        tags_dir = os.path.join(DATA_DIR, 'tags')
        if not os.path.exists(tags_dir):
            os.makedirs(tags_dir)
        return os.path.join(tags_dir, f'{module}-tag-categories.json')

    def get_categories(self, module):
        filepath = self._get_tags_file(module)
        if not os.path.exists(filepath): return []
        try:
            with open(filepath, 'r', encoding='utf-8') as f: return json.load(f)
        except: return []

    def save_categories(self, data, module):
        filepath = self._get_tags_file(module)
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except: return False

    def rename_tag(self, module, old_name, new_name):
        category = module.replace('photos-', '')
        gallery_db_path = os.path.join(self.context['DATA_DIR'], 'gallery.db')
        
        if not os.path.exists(gallery_db_path):
            return 0
            
        conn = sqlite3.connect(gallery_db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT id, tags FROM photos WHERE category=?", (category,))
        rows = cursor.fetchall()
        
        updated_count = 0
        for row in rows:
            if row['tags']:
                tags = json.loads(row['tags'])
                if old_name in tags:
                    tags = [new_name if t == old_name else t for t in tags]
                    cursor.execute("UPDATE photos SET tags=? WHERE id=?", 
                                 (json.dumps(tags, ensure_ascii=False), row['id']))
                    updated_count += 1
        conn.commit()
        conn.close()
        
        from . import photos
        photos.sync_gallery_js()
        return updated_count

    def delete_tag(self, module, tag_name):
        category = module.replace('photos-', '')
        gallery_db_path = os.path.join(self.context['DATA_DIR'], 'gallery.db')
        
        if not os.path.exists(gallery_db_path):
            return 0

        conn = sqlite3.connect(gallery_db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT id, tags FROM photos WHERE category=?", (category,))
        rows = cursor.fetchall()
        
        updated_count = 0
        for row in rows:
            if row['tags']:
                tags = json.loads(row['tags'])
                if tag_name in tags:
                    tags = [t for t in tags if t != tag_name]
                    cursor.execute("UPDATE photos SET tags=? WHERE id=?", 
                                 (json.dumps(tags, ensure_ascii=False), row['id']))
                    updated_count += 1
        conn.commit()
        conn.close()
        
        from . import photos
        photos.sync_gallery_js()
        return updated_count

    def cleanup_tags(self, module):
        category = module.replace('photos-', '')
        gallery_db_path = os.path.join(self.context['DATA_DIR'], 'gallery.db')
        print(f"  [ CMS ] 📸 连接 gallery.db, category={category}")
        
        used_tags = set()
        if not os.path.exists(gallery_db_path):
            return used_tags
        
        conn = sqlite3.connect(gallery_db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT tags FROM photos WHERE category=?", (category,))
        rows = cursor.fetchall()
        conn.close()
        
        for row in rows:
            if row['tags']:
                used_tags.update(json.loads(row['tags']))
        return used_tags


class SpaceTagStrategy(TagStrategy):
    def _get_tags_file(self, module):
        DATA_DIR = self.context['DATA_DIR']
        tags_dir = os.path.join(DATA_DIR, 'tags')
        if not os.path.exists(tags_dir): os.makedirs(tags_dir)
        return os.path.join(tags_dir, 'space-tag-categories.json')

    def get_categories(self, module):
        filepath = self._get_tags_file(module)
        if not os.path.exists(filepath): return []
        try:
            with open(filepath, 'r', encoding='utf-8') as f: return json.load(f)
        except: return []

    def save_categories(self, data, module):
        filepath = self._get_tags_file(module)
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except: return False

    def rename_tag(self, module, old_name, new_name):
        space_path = os.path.join(self.context['PROJECT_ROOT'], 'data', 'space-tree.json')
        if not os.path.exists(space_path): return 0
        
        with open(space_path, 'r', encoding='utf-8') as f:
            space_data = json.load(f)
        
        updated_count = 0
        def rename_in_nodes(nodes):
            nonlocal updated_count
            for node in nodes:
                if node.get('tags') and old_name in node['tags']:
                    node['tags'] = [new_name if t == old_name else t for t in node['tags']]
                    updated_count += 1
                if node.get('children'):
                    rename_in_nodes(node['children'])
        
        rename_in_nodes(space_data.get('root', []))
        
        with open(space_path, 'w', encoding='utf-8') as f:
            json.dump(space_data, f, ensure_ascii=False, indent=2)
        return updated_count

    def delete_tag(self, module, tag_name):
        space_path = os.path.join(self.context['PROJECT_ROOT'], 'data', 'space-tree.json')
        if not os.path.exists(space_path): return 0
        
        with open(space_path, 'r', encoding='utf-8') as f:
            space_data = json.load(f)
        
        updated_count = 0
        def delete_in_nodes(nodes):
            nonlocal updated_count
            for node in nodes:
                if node.get('tags') and tag_name in node['tags']:
                    node['tags'] = [t for t in node['tags'] if t != tag_name]
                    updated_count += 1
                if node.get('children'):
                    delete_in_nodes(node['children'])
        
        delete_in_nodes(space_data.get('root', []))
        
        with open(space_path, 'w', encoding='utf-8') as f:
            json.dump(space_data, f, ensure_ascii=False, indent=2)
        return updated_count

    def cleanup_tags(self, module):
        space_path = os.path.join(self.context['PROJECT_ROOT'], 'data', 'space-tree.json')
        print(f"  [ CMS ] 🌐 读取 space-tree.json")
        used_tags = set()
        
        if not os.path.exists(space_path): return used_tags
        
        with open(space_path, 'r', encoding='utf-8') as f:
            space_data = json.load(f)
            
        def collect_space_tags(nodes):
            for node in nodes:
                if node.get('tags'):
                    used_tags.update(node['tags'])
                if node.get('children'):
                    collect_space_tags(node['children'])
        
        collect_space_tags(space_data.get('root', []))
        return used_tags
