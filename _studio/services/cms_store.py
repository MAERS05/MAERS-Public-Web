"""CMS JSON 真源的结构校验、遍历与一次性 SQLite 缓存重建。"""

from __future__ import annotations
from .contracts import JsonObject

import json
import os
import sqlite3


def walk(nodes):
    for node in nodes:
        yield node
        yield from walk(node.get('children') or [])


def validate(tree: JsonObject) -> JsonObject:
    if not isinstance(tree, dict) or not isinstance(tree.get('root'), list):
        raise ValueError('CMS tree must contain a root array')
    seen = set()

    def visit(nodes, depth=0):
        if depth > 100:
            raise ValueError('CMS tree is too deep')
        for node in nodes:
            if not isinstance(node, dict) or not isinstance(node.get('id'), str) or not node['id']:
                raise ValueError('Invalid node id')
            if node['id'] in seen or node['id'] == 'root':
                raise ValueError('Duplicate or reserved node id')
            seen.add(node['id'])
            if node.get('_enc'):
                if not isinstance(node['_enc'], str) or not node['_enc'].startswith('enc:'):
                    raise ValueError('Invalid encrypted node')
                continue
            if node.get('type') not in ('note', 'folder') or not isinstance(node.get('title'), str):
                raise ValueError('Invalid node type or title')
            if not isinstance(node.get('tags', []), list) or any(not isinstance(t, str) for t in node.get('tags', [])):
                raise ValueError('Node tags must be strings')
            content = node.get('content', '')
            if not isinstance(content, str) and not (node['type'] == 'folder' and content is None):
                raise ValueError('Invalid node content')
            if node.get('coverImage') is not None and not isinstance(node['coverImage'], str):
                raise ValueError('Invalid cover image')
            children = node.get('children')
            if children is not None:
                if not isinstance(children, list) or (children and node['type'] != 'folder'):
                    raise ValueError('Only folders can contain children')
                visit(children, depth + 1)
    visit(tree['root'])
    return tree


def load(path: str) -> JsonObject:
    if not os.path.exists(path):
        raise FileNotFoundError('CMS source is missing; restore it before continuing')
    with open(path, encoding='utf-8') as source:
        return validate(json.load(source))


def rebuild(database: str, trees: dict[str, JsonObject]) -> None:
    """在临时库完整建好索引后替换旧缓存，失败时不修改真源或原缓存。"""
    import tempfile
    os.makedirs(os.path.dirname(database), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.cms-cache-', suffix='.db', dir=os.path.dirname(database))
    os.close(fd)
    connection = None
    try:
        connection = sqlite3.connect(temporary)
        connection.execute('''CREATE TABLE nodes (
            id TEXT PRIMARY KEY, module TEXT, parent_id TEXT, type TEXT, title TEXT,
            content TEXT, tags TEXT, created_at REAL, sort_order INTEGER, coverImage TEXT)''')

        def insert(module, nodes, parent='root'):
            for order, node in enumerate(nodes):
                locked = bool(node.get('_enc'))
                connection.execute('INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', (
                    node['id'], module, parent, 'locked' if locked else node['type'],
                    '' if locked else node['title'], node['_enc'] if locked else node.get('content', ''),
                    json.dumps([] if locked else node.get('tags', []), ensure_ascii=False),
                    node.get('created_at', 0), order, None if locked else node.get('coverImage')))
                if not locked:
                    insert(module, node.get('children') or [], node['id'])
        for module, tree in trees.items():
            insert(module, validate(tree)['root'])
        connection.commit()
        connection.close()
        connection = None
        os.replace(temporary, database)
    finally:
        if connection:
            connection.close()
        if os.path.exists(temporary):
            os.remove(temporary)
