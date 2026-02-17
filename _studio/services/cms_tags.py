import os
import json
import sqlite3

# ================= 策略基类 =================

class TagStrategy:
    def __init__(self, context):
        self.context = context

    def get_categories(self, module):
        raise NotImplementedError

    def save_categories(self, data, module):
        raise NotImplementedError

    def rename_tag(self, module, old_name, new_name):
        raise NotImplementedError

    def delete_tag(self, module, tag_name):
        raise NotImplementedError

    def cleanup_tags(self, module):
        raise NotImplementedError

# ================= CMS 具体策略实现 =================

class CmsTagStrategy(TagStrategy):
    def _get_tags_file(self, module):
        DATA_DIR = self.context['DATA_DIR']
        tags_dir = os.path.join(DATA_DIR, 'tags')
        if not os.path.exists(tags_dir):
            os.makedirs(tags_dir)
        return os.path.join(tags_dir, f'cms-{module}-tag-categories.json')

    def get_categories(self, module):
        filepath = self._get_tags_file(module)
        if not os.path.exists(filepath):
            return []
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error reading tag categories for {module}: {e}")
            return []

    def save_categories(self, data, module):
        filepath = self._get_tags_file(module)
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            print(f"Error saving tag categories for {module}: {e}")
            return False

    def rename_tag(self, module, old_name, new_name):
        conn = self.context['get_db']()
        cursor = conn.cursor()
        updated_count = 0
        
        cursor.execute("SELECT id, tags FROM nodes WHERE module=?", (module,))
        rows = cursor.fetchall()
        
        for row in rows:
            if row['tags']:
                tags = json.loads(row['tags'])
                if old_name in tags:
                    # Replace then deduplicate (handles case where node has both old and new tag)
                    renamed = [new_name if t == old_name else t for t in tags]
                    seen = set()
                    deduped = []
                    for t in renamed:
                        if t not in seen:
                            seen.add(t)
                            deduped.append(t)
                    cursor.execute("UPDATE nodes SET tags=? WHERE id=?", 
                                 (json.dumps(deduped, ensure_ascii=False), row['id']))
                    updated_count += 1
        
        conn.commit()
        conn.close()
        
        # Sync JS
        if self.context.get('sync_js_file'):
            self.context['sync_js_file'](module)
            
        return updated_count

    def delete_tag(self, module, tag_name):
        conn = self.context['get_db']()
        cursor = conn.cursor()
        updated_count = 0
        
        cursor.execute("SELECT id, tags FROM nodes WHERE module=?", (module,))
        rows = cursor.fetchall()
        
        for row in rows:
            if row['tags']:
                tags = json.loads(row['tags'])
                if tag_name in tags:
                    tags = [t for t in tags if t != tag_name]
                    cursor.execute("UPDATE nodes SET tags=? WHERE id=?", 
                                 (json.dumps(tags, ensure_ascii=False), row['id']))
                    updated_count += 1
        
        conn.commit()
        conn.close()
        
        # Sync JS
        if self.context.get('sync_js_file'):
            self.context['sync_js_file'](module)
            
        return updated_count

    def cleanup_tags(self, module):
        used_tags = set()
        print(f"  [ CMS ] 📝 查询 cms.db, module={module}")
        conn = self.context['get_db']()
        cursor = conn.cursor()
        cursor.execute("SELECT tags FROM nodes WHERE module=?", (module,))
        rows = cursor.fetchall()
        conn.close()
        
        for row in rows:
            if row['tags']:
                used_tags.update(json.loads(row['tags']))
        return used_tags
