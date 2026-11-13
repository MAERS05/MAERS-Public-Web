"""预览或迁移 CMS 公开 Markdown 文件名，正文平铺在 markdown/<module>/ 目录中。"""

import argparse
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import cms, cms_markdown, cms_nodes, storage

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='执行迁移；默认只预览')
    args = parser.parse_args()
    context = cms.get_context()
    changes = {}
    expected_trees = {}
    originals = []
    for module in cms.JS_SYNC_MAP:
        tree = context['load_tree'](module)
        cms_nodes.validate_tree_names(tree['root'])
        rows = cms_markdown._plan(module, tree, context)
        for _, old, _, _ in rows:
            if not os.path.isfile(cms_markdown.md_path(context, old)):
                raise FileNotFoundError(f'Markdown source missing: {old}')
        changes[module] = {old: new for _, old, new, _ in rows if old != new}
        expected = copy.deepcopy(tree)
        for node in cms.cms_store.walk(expected['root']):
            if node.get('content') in changes[module]:
                node['content'] = changes[module][node['content']]
        expected_trees[module] = expected
        if args.apply:
            for _, old, new, _ in rows:
                with open(cms_markdown.md_path(context, old), 'rb') as source:
                    originals.append((old, new, source.read()))
    if args.apply:
        mapping = {old: new for rows in changes.values() for old, new in rows.items()}
        with storage.transaction():
            for module in cms.JS_SYNC_MAP:
                cms_nodes.migrate_markdown_names(module, context)
            for module, expected in expected_trees.items():
                if context['load_tree'](module) != expected:
                    raise RuntimeError(f'CMS metadata changed unexpectedly: {module}')
            for old, new, original in originals:
                expected = cms_markdown.rewrite_links(original.decode('utf-8'), old, mapping).encode('utf-8')
                with open(cms_markdown.md_path(context, new), 'rb') as source:
                    if source.read() != expected:
                        raise RuntimeError(f'Markdown verification failed: {new}')
    print(json.dumps({'applied': args.apply, 'renamed': {module: len(rows) for module, rows in changes.items()},
                      'verified': len(originals) if args.apply else None,
                      'examples': [pair for rows in changes.values() for pair in list(rows.items())[:2]]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
