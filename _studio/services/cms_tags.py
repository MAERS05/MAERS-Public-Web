"""
标签策略基类与 CMS 模块标签分类（data/tags/）读写。
"""

import os
import json
from . import cms_store, storage

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
        return os.path.join(self.context['DATA_DIR'], 'tags', f'cms-{module}-tag-categories.json')

    def get_categories(self, module):
        path = self._get_tags_file(module)
        if not os.path.exists(path):
            return []
        with open(path, encoding='utf-8') as source:
            return json.load(source)

    def save_categories(self, data, module):
        storage.write_json(self._get_tags_file(module), data)
        return True

    def _update(self, module, transform):
        tree = self.context['load_tree'](module)
        count = 0
        for node in cms_store.walk(tree['root']):
            if node.get('_enc'):
                continue
            original = node.get('tags', [])
            updated = transform(original)
            if original != updated:
                node['tags'] = updated
                count += 1
        if count:
            self.context['save_tree'](module, tree)
        return count

    def rename_tag(self, module, old_name, new_name):
        return self._update(module, lambda tags: list(dict.fromkeys(new_name if tag == old_name else tag for tag in tags)))

    def delete_tag(self, module, tag_name):
        return self._update(module, lambda tags: [tag for tag in tags if tag != tag_name])

    def cleanup_tags(self, module):
        tree = self.context['load_tree'](module)
        return {tag for node in cms_store.walk(tree['root']) for tag in node.get('tags', [])}
