"""
CMS 节点操作：增删改移与排序、.md 文件联动、加解锁、外部编辑器打开。
"""

from __future__ import annotations
from .contracts import JsonObject, CmsContext

import os
import json
import hashlib
import re
import subprocess
import uuid
from . import storage, cms_store

# 沙盒测试钩子：用于在自动化测试中拦截外部软件唤醒调用，避免弹窗阻塞测试
_EXTERNAL_OPEN_HOOK = None


def _ensure_photos_junction(module_dir, project_root):
    """在 data/{module}/ 下按需创建指向项目根目录 photos 的目录联接，使外部编辑器直接解析 photos/... 相对图片路径"""
    if not module_dir or not project_root:
        return
    photos_root = os.path.abspath(os.path.join(project_root, 'photos'))
    link_path = os.path.abspath(os.path.join(module_dir, 'photos'))
    if not os.path.isdir(photos_root) or os.path.exists(link_path) or os.path.islink(link_path):
        return
    try:
        if os.name == 'nt':
            subprocess.run(
                ['cmd', '/c', 'mklink', '/J', link_path, photos_root],
                capture_output=True,
                timeout=3
            )
        else:
            os.symlink(photos_root, link_path, target_is_directory=True)
    except (OSError, subprocess.SubprocessError):
        pass


@storage.serialized
def open_external_node(module: str, node_id: str, context: CmsContext) -> bool:
    """调用系统默认关联的外部软件（如 Typora / Obsidian）直接打开节点对应的物理 .md 文件"""
    if not node_id or not isinstance(node_id, str):
        raise ValueError("Invalid node id")

    DATA_DIR = os.path.abspath(context['DATA_DIR'])
    PROJECT_ROOT = os.path.abspath(context['PROJECT_ROOT'])
    tree = context['load_tree'](module)
    row = next((node for node in cms_store.walk(tree['root']) if node['id'] == node_id), None)

    if not row:
        raise ValueError("Node not found")
    if row.get('_enc'):
        raise ValueError("Node is locked")
    if row.get('_private'):
        raise ValueError('私密正文仅在浏览器内编辑，避免外部编辑器另存明文副本')

    rel_path = row['content']
    if not rel_path or not isinstance(rel_path, str) or not rel_path.endswith('.md'):
        raise ValueError("Node has no valid markdown file")

    # 严格校验路径边界，防止路径穿越攻击
    norm_parts = rel_path.replace('\\', '/').split('/')
    if '..' in norm_parts:
        raise ValueError("Path traversal detected")

    full_md_path = os.path.abspath(os.path.join(DATA_DIR, rel_path))
    try:
        common = os.path.commonpath([DATA_DIR, full_md_path])
    except ValueError:
        raise ValueError("Path traversal detected")

    if common != DATA_DIR or not full_md_path.startswith(DATA_DIR + os.sep):
        raise ValueError("Path traversal detected")

    if not os.path.isfile(full_md_path):
        raise ValueError("Markdown file not found on disk")

    # 按需创建 photos 目录联接，保障外部软件原生预览相对路径图片
    _ensure_photos_junction(os.path.dirname(full_md_path), PROJECT_ROOT)

    # 唤醒外部默认 Markdown 软件（支持沙盒测试拦截）
    if _EXTERNAL_OPEN_HOOK is not None:
        _EXTERNAL_OPEN_HOOK(full_md_path)
    elif os.environ.get('MAERS_NO_STARTFILE') == '1':
        pass
    elif hasattr(os, 'startfile'):
        os.startfile(full_md_path)
    else:
        subprocess.Popen(['xdg-open', full_md_path])

    print(f"  [ CMS ] 🖥️ 已调用外部软件打开文档: {rel_path}")
    return True


def sanitize_filename(title):
    return re.sub(r'[\\/*?:"<>|]', '', title).strip().rstrip('.') or 'Untitled'


def _find(tree, node_id):
    def search(nodes):
        for index, node in enumerate(nodes):
            if node['id'] == node_id:
                return nodes, index, node
            found = search(node.get('children') or [])
            if found:
                return found
        return None
    found = search(tree['root'])
    if not found:
        raise ValueError('Node not found')
    return found


def _children(tree, parent_id):
    if parent_id == 'root':
        return tree['root']
    node = _find(tree, parent_id)[2]
    if node.get('type') != 'folder' or node.get('_enc'):
        raise ValueError('Parent must be an unlocked folder')
    return node.setdefault('children', [])


def _md_path(context, relative):
    root = os.path.realpath(context['DATA_DIR'])
    path = os.path.realpath(os.path.join(root, relative))
    if not relative.endswith('.md') or os.path.commonpath([root, path]) != root:
        raise ValueError('Invalid markdown path')
    return path


def _new_md(module, title, content, context):
    base = sanitize_filename(title)
    relative = f'{module}/{base}.md'
    index = 1
    while os.path.exists(_md_path(context, relative)):
        relative = f'{module}/{base} ({index}).md'
        index += 1
    storage.write_text(_md_path(context, relative), content)
    return relative


@storage.transactional
def add_node(module: str, parent_id: str, node_type: str, title: str, context: CmsContext, node_id: str | None = None) -> bool:
    if node_type not in ('note', 'folder') or not isinstance(title, str) or not title.strip():
        raise ValueError('Invalid node type or title')
    tree = context['load_tree'](module)
    node_id = node_id or f'{node_type[0]}_{uuid.uuid4().hex}'
    if any(node['id'] == node_id for node in cms_store.walk(tree['root'])):
        raise ValueError('Node id already exists')
    children = _children(tree, parent_id)
    node = {'id': node_id, 'type': node_type, 'title': title, 'tags': [],
            'content': '', 'coverImage': None, 'children': [] if node_type == 'folder' else None}
    private = parent_id != 'root' and _find(tree, parent_id)[2].get('_private')
    if private:
        node['_private'] = True
    if node_type == 'note':
        if private:
            from . import private_session
            node['_private'] = True
            node['content'] = private_session.new_document(module, node_id)
        else:
            node['content'] = _new_md(module, title, '', context)
    children.insert(0, node)
    context['save_tree'](module, tree)
    return True


def _remove_markdown(nodes, context):
    for node in cms_store.walk(nodes):
        if not node.get('_enc') and str(node.get('content') or '').endswith('.md'):
            storage.remove(_md_path(context, node['content']))


@storage.transactional
def delete_node(module: str, node_id: str, context: CmsContext) -> bool:
    tree = context['load_tree'](module)
    siblings, index, node = _find(tree, node_id)
    del siblings[index]
    context['save_tree'](module, tree)
    _remove_markdown([node], context)
    # 图片可能被其他正文或封面复用，解除引用后统一交由垃圾清理回收。
    return True


@storage.transactional
def update_node(module: str, node_id: str, update_data: JsonObject, context: CmsContext) -> bool:
    if not isinstance(update_data, dict):
        raise ValueError('data must be an object')
    tree = context['load_tree'](module)
    node = _find(tree, node_id)[2]
    if node.get('_enc'):
        raise ValueError('Node is locked')
    old_path = node.get('content') or ''
    expected = update_data.get('expectedRevision')
    if node.get('_private'):
        from . import private_session, private_cms, photos
        private_cms.validate_edit(node, update_data)
        path = _md_path(context, old_path) if node['type'] == 'note' else None
        if 'content' in update_data:
            if path is None or not isinstance(update_data['content'], str):
                raise ValueError('Invalid private markdown')
            original = private_session.document(path)
            if original is None:
                raise ValueError('私密正文未载入，保存已停止')
            if expected is not None and hashlib.sha256(original.encode()).hexdigest() != expected:
                raise ValueError('正文已变化，请重新读取后保存')
            private_session.write_document(path, update_data['content'])
        for key in ('title', 'tags', 'coverImage'):
            if key in update_data:
                node[key] = photos.normalize_media_reference(update_data[key]) if key == 'coverImage' and update_data[key] else update_data[key]
        context['save_tree'](module, tree)
        return True
    if expected is not None and 'content' in update_data and old_path.endswith('.md'):
        with open(_md_path(context, old_path), 'rb') as source:
            if expected != hashlib.sha256(source.read()).hexdigest():
                raise ValueError('正文已被其他编辑更新，请重新读取后合并；本次保存未覆盖原文')
    renamed = 'title' in update_data and update_data['title'] != node['title'] and old_path.endswith('.md')
    if 'title' in update_data and (not isinstance(update_data['title'], str) or not update_data['title'].strip()):
        raise ValueError('Title must be non-empty')
    content = update_data.get('content')
    if content is not None and not isinstance(content, str):
        raise ValueError('Content must be text')
    if renamed:
        if content is None:
            with open(_md_path(context, old_path), encoding='utf-8', newline='') as source:
                content = source.read()
        node['content'] = _new_md(module, update_data['title'], content, context)
    elif content is not None:
        if old_path.endswith('.md'):
            storage.write_text(_md_path(context, old_path), content)
        elif node['type'] == 'note':
            node['content'] = _new_md(module, node['title'], content, context)
        else:
            raise ValueError('Folder cannot contain markdown content')
    for key in ('title', 'tags', 'coverImage'):
        if key in update_data:
            node[key] = update_data[key]
    context['save_tree'](module, tree)
    if renamed:
        storage.remove(_md_path(context, old_path))
    return True


@storage.transactional
def reorder_nodes(module: str, ids: list[str], context: CmsContext) -> bool:
    tree = context['load_tree'](module)
    if not ids:
        return True
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate node ids')
    siblings = _find(tree, ids[0])[0]
    if any(_find(tree, node_id)[0] is not siblings for node_id in ids):
        raise ValueError('Reordering requires sibling nodes')
    order = {node_id: index for index, node_id in enumerate(ids)}
    siblings.sort(key=lambda node: order.get(node['id'], len(ids)))
    context['save_tree'](module, tree)
    return True


@storage.transactional
def move_node(module: str, node_id: str, target_parent_id: str, context: CmsContext) -> bool:
    tree = context['load_tree'](module)
    siblings, index, node = _find(tree, node_id)
    if target_parent_id in {child['id'] for child in cms_store.walk([node])}:
        raise ValueError('Circular reference')
    if target_parent_id != 'root' and _find(tree, target_parent_id)[2].get('_private') and not node.get('_private'):
        from . import private_cms
        private_cms.protect(module, node_id)
        tree = context['load_tree'](module)
        siblings, index, node = _find(tree, node_id)
    destination = _children(tree, target_parent_id)
    del siblings[index]
    destination.append(node)
    context['save_tree'](module, tree)
    return True


@storage.transactional
def update_node_tags(module, node_id, tags, context):
    tree = context['load_tree'](module)
    try:
        node = _find(tree, node_id)[2]
    except ValueError:
        return False
    if node.get('_enc'):
        raise ValueError('Node is locked')
    node['tags'] = tags
    context['save_tree'](module, tree)
    return True


def lock_sources(node, context):
    """以正文与结构计算加锁前置版本，拒绝打包后已发生的外部修改。"""
    result = []
    for item in cms_store.walk([node]):
        if item.get('_enc'):
            data = {'id': item['id'], '_enc': item['_enc']}
        else:
            content = item.get('content') or ''
            if content.endswith('.md'):
                from . import private_session
                path = _md_path(context, content)
                memory = private_session.document(path)
                if memory is None:
                    with open(path, encoding='utf-8', newline='') as source:
                        memory = source.read()
                content = memory
            data = {'id': item['id'], 'type': item['type'], 'title': item['title'],
                    'tags': item.get('tags') or [], 'coverImage': item.get('coverImage'),
                    'md': content, 'children': [child['id'] for child in item.get('children') or []]}
        encoded = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
        result.append({'id': item['id'], 'revision': hashlib.sha256(encoded).hexdigest()})
    return result


def verify_lock_sources(module, node_id, sources, context):
    tree = context['load_tree'](module)
    node = _find(tree, node_id)[2]
    if sources != lock_sources(node, context):
        raise ValueError('加锁前内容已变化，请重新读取后重试；原文未删除')


@storage.transactional
def lock_node(module: str, node_id: str, enc: str, context: CmsContext) -> bool:
    if not isinstance(enc, str) or not enc.startswith('enc:'):
        raise ValueError('Invalid lock payload')
    tree = context['load_tree'](module)
    siblings, index, node = _find(tree, node_id)
    if node.get('_enc'):
        raise ValueError('Node already locked')
    media_version = 0 if any(child.get('_enc') and child.get('mediaVersion') != 1
                             for child in cms_store.walk([node])) else 1
    siblings[index] = {'id': node_id, 'type': 'locked', '_enc': enc, 'children': None,
                       'mediaVersion': media_version}
    # 先发布完整密文，再移除明文；异常时恢复 JSON 和正文。
    context['save_tree'](module, tree)
    _remove_markdown([node], context)
    return True


@storage.transactional
def unlock_node(module: str, node_id: str, tree: JsonObject, context: CmsContext) -> bool:
    if not isinstance(tree, dict) or tree.get('id') != node_id:
        raise ValueError('Invalid unlock payload')
    current = context['load_tree'](module)
    siblings, index, node = _find(current, node_id)
    if not node.get('_enc'):
        raise ValueError('Node is not locked')

    def restore(source):
        if source.get('_enc'):
            return {'id': source['id'], 'type': 'locked', '_enc': source['_enc'], 'children': None}
        target = {key: source[key] for key in ('id', 'type', 'title', 'tags', 'coverImage') if key in source}
        target.setdefault('type', 'note')
        target.setdefault('title', 'Untitled')
        target.setdefault('tags', [])
        target['content'] = ''
        if source.get('md') is not None:
            target['content'] = _new_md(module, target['title'], source['md'], context)
        target['children'] = [restore(child) for child in source.get('children') or []] if target['type'] == 'folder' else None
        return target
    siblings[index] = restore(tree)
    context['save_tree'](module, current)
    return True
