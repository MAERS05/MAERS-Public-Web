"""
CMS 节点操作：增删改移与排序、.md 文件联动、加解锁、外部编辑器打开。
"""

from __future__ import annotations
from .contracts import JsonObject, CmsContext

import os
import json
import hashlib
import subprocess
import uuid
from . import storage, cms_store, cms_markdown
from .cms_markdown import md_path as _md_path

# 沙盒测试钩子：用于在自动化测试中拦截外部软件唤醒调用，避免弹窗阻塞测试
_EXTERNAL_OPEN_HOOK = None


class MarkdownConflictError(ValueError):
    def __init__(self, revision):
        super().__init__('正文已被其他编辑更新，请选择保留电脑版本或用云端草稿覆盖')
        self.revision = revision


def _ensure_photos_junction(module_dir, project_root):
    """在 markdown/{module}/ 下按需创建指向项目根目录 photos 的目录联接，使外部编辑器直接解析 photos/... 相对图片路径"""
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
                timeout=3,
                check=True,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)
            )
        else:
            os.symlink(photos_root, link_path, target_is_directory=True)
    except (OSError, subprocess.SubprocessError) as error:
        print(f"  [ CMS ] ⚠️ 图片目录联接未创建 | Photos link unavailable: {type(error).__name__}")


def _open_markdown(path):
    """统一外部编辑器入口，测试拦截和禁用开关优先于系统调用。"""
    if _EXTERNAL_OPEN_HOOK is not None:
        _EXTERNAL_OPEN_HOOK(path)
        return
    if os.environ.get('MAERS_NO_STARTFILE') == '1':
        return
    if hasattr(os, 'startfile'):
        os.startfile(path)
    else:
        subprocess.Popen(['xdg-open', path])


@storage.serialized
def open_external_node(module: str, node_id: str, context: CmsContext) -> bool:
    """调用系统默认关联的外部软件（如 Typora / Obsidian）直接打开节点对应的物理 .md 文件"""
    if not node_id or not isinstance(node_id, str):
        raise ValueError("Invalid node id")

    tree = context['load_tree'](module)
    row = next((node for node in cms_store.walk(tree['root']) if node['id'] == node_id), None)

    if not row:
        raise ValueError("Node not found")
    if row.get('_enc'):
        raise ValueError("Node is locked")
    if row.get('_private'):
        raise ValueError('私密正文仅在浏览器内编辑，避免外部编辑器另存明文副本')

    rel_path = row.get('content')
    if not rel_path or not isinstance(rel_path, str) or not rel_path.endswith('.md'):
        raise ValueError("Node has no valid markdown file")

    # 严格校验路径边界，防止路径穿越攻击
    norm_parts = rel_path.replace('\\', '/').split('/')
    if '..' in norm_parts:
        raise ValueError("Path traversal detected")

    full_md_path = _md_path(context, rel_path)
    if not os.path.isfile(full_md_path):
        raise ValueError("Markdown file not found on disk")

    # 按需创建 photos 目录联接，保障外部软件原生预览相对路径图片
    _ensure_photos_junction(os.path.dirname(full_md_path), os.path.abspath(context['PROJECT_ROOT']))
    _open_markdown(full_md_path)

    print(f"  [ CMS ] 🖥️ 已调用外部软件打开文档: {rel_path}")
    return True


def unique_title(siblings, title, node_id=None):
    """同级文档和文件夹共用名称空间，忽略首尾空白；密文标题不落盘。"""
    if not isinstance(title, str) or not title.strip():
        raise ValueError('名称不能为空')
    title = title.strip()
    if any(not node.get('_enc') and node['id'] != node_id and
           str(node.get('title', '')).strip() == title for node in siblings):
        raise ValueError('当前文件夹已存在同名文档或文件夹，请使用其他名称')
    return title


def validate_tree_names(nodes):
    for node in nodes:
        if node.get('_enc'):
            continue
        unique_title(nodes, node['title'], node['id'])
        validate_tree_names(node.get('children') or [])


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


def _new_md(module, title, content, context, parents=()):
    base = cms_markdown.filename(parents, title)
    relative = f'markdown/{module}/{base}.md'
    index = 1
    while os.path.exists(_md_path(context, relative)):
        relative = f'markdown/{module}/{base} ({index}).md'
        index += 1
    storage.write_text(_md_path(context, relative), content)
    return relative


def _group_of(node):
    """节点所属密码组：方案 3 落盘字段为 _group，旧版后台视图字段为 _private_group。"""
    return node.get('_private_group') or node.get('_group') or 'default'


def _new_note_content(module, node, context, parents=()):
    # 仅旧版密文目录的后台视图（带 _private_group）仍使用会话内存正文；方案 3 的私密节点与公开节点一样落盘。
    if node.get('_private_group'):
        from . import private_session
        return private_session.new_document(module, node['id'])
    return _new_md(module, node['title'], '', context, parents)


@storage.transactional
def add_node(module: str, parent_id: str, node_type: str, title: str, context: CmsContext, node_id: str | None = None) -> bool:
    if node_type not in ('note', 'folder') or not isinstance(title, str) or not title.strip():
        raise ValueError('Invalid node type or title')
    tree = context['load_tree'](module)
    node_id = node_id or f'{node_type[0]}_{uuid.uuid4().hex}'
    if any(node['id'] == node_id for node in cms_store.walk(tree['root'])):
        raise ValueError('Node id already exists')
    children = _children(tree, parent_id)
    title = unique_title(children, title)
    node = {'id': node_id, 'type': node_type, 'title': title, 'tags': [],
            'content': '', 'coverImage': None, 'children': [] if node_type == 'folder' else None}
    parent = _find(tree, parent_id)[2] if parent_id != 'root' else {}
    if parent.get('_private'):
        node['_private'] = True
        if parent.get('_private_group'):
            node['_private_group'] = parent['_private_group']
        elif _group_of(parent) != 'default':
            node['_group'] = _group_of(parent)
    children.insert(0, node)
    if node_type == 'note':
        node['content'] = _new_note_content(module, node, context, cms_markdown.parent_titles(tree, node_id))
    cms_markdown.save(module, tree, context)
    return True


def _remove_markdown(nodes, context):
    for node in cms_store.walk(nodes):
        if not node.get('_enc') and str(node.get('content') or '').endswith('.md'):
            storage.remove(_md_path(context, node['content']))


@storage.transactional
def delete_node(module: str, node_id: str, context: CmsContext, *, allow_protected: bool = True) -> bool:
    tree = context['load_tree'](module)
    siblings, index, node = _find(tree, node_id)
    if not allow_protected and any(child.get('_enc') or child.get('_private') for child in cms_store.walk([node])):
        raise ValueError('整项删除加密内容仅限电脑本地后台操作')
    del siblings[index]
    context['save_tree'](module, tree)
    _remove_markdown([node], context)
    # 图片可能被其他正文或封面复用，解除引用后统一交由垃圾清理回收。
    return True


def _set_metadata(node, update_data, normalize_cover=False):
    for key in ('title', 'tags', 'coverImage'):
        if key not in update_data:
            continue
        value = update_data[key]
        if key == 'coverImage' and normalize_cover and value:
            from .photos import normalize_media_reference
            value = normalize_media_reference(value)
        node[key] = value


def _update_private_node(module, tree, node, update_data, context):
    from . import private_session, private_cms
    private_cms.validate_edit(node, update_data)
    path = _md_path(context, node.get('content') or '') if node['type'] == 'note' else None
    if 'content' in update_data:
        if path is None or not isinstance(update_data['content'], str):
            raise ValueError('Invalid private markdown')
        # 方案 3：优先使用旧版会话内存正文；否则以本地物理文件为准，两者都没有则停止保存，避免凭空覆盖。
        original = private_session.document(path)
        if original is None:
            if not os.path.isfile(path):
                raise ValueError('私密正文未载入，保存已停止')
            with open(path, encoding='utf-8', newline='') as source:
                original = source.read()
        expected = update_data.get('expectedRevision')
        if expected is not None and hashlib.sha256(original.encode()).hexdigest() != expected:
            raise ValueError('正文已变化，请重新读取后保存')
        # storage.write_text 已优先写入会话内存工作区，其余情况落盘到本地 .md。
        storage.write_text(path, update_data['content'])
    _set_metadata(node, update_data, normalize_cover=True)
    if 'title' in update_data and not (node.get('_private_group') or node.get('_private_id')):
        cms_markdown.save(module, tree, context)
    else:
        context['save_tree'](module, tree)


def _check_public_revision(path, update_data, context, *, overwrite_revision=None):
    expected = update_data.get('expectedRevision')
    if expected is None or 'content' not in update_data or not path.endswith('.md'):
        return
    with open(_md_path(context, path), 'rb') as source:
        original = source.read()
    revision = hashlib.sha256(original).hexdigest()
    if overwrite_revision is not None:
        if overwrite_revision != revision:
            raise MarkdownConflictError(revision)
        from . import storage_journal
        backup = os.path.join(storage_journal.local_root(), 'markdown-conflicts', uuid.uuid4().hex, os.path.basename(path))
        storage.write_bytes(backup, original)
    elif expected != revision:
        raise MarkdownConflictError(revision)


def _write_public_markdown(module, node, update_data, context):
    """正文更新保留原路径，目录和标题引起的文件改名由统一保存流程处理。"""
    old_path = node.get('content') or ''
    if 'title' in update_data and (not isinstance(update_data['title'], str) or not update_data['title'].strip()):
        raise ValueError('Title must be non-empty')
    content = update_data.get('content')
    if content is not None and not isinstance(content, str):
        raise ValueError('Content must be text')
    if content is None:
        return None
    if old_path.endswith('.md'):
        storage.write_text(_md_path(context, old_path), content)
    elif node['type'] == 'note':
        node['content'] = _new_md(module, node['title'], content, context)
    else:
        raise ValueError('Folder cannot contain markdown content')
    return None


@storage.transactional
def update_node(module: str, node_id: str, update_data: JsonObject, context: CmsContext,
                *, from_relay: bool = False, overwrite_revision=None) -> bool:
    if not isinstance(update_data, dict):
        raise ValueError('data must be an object')
    tree = context['load_tree'](module)
    siblings, _, node = _find(tree, node_id)
    if overwrite_revision is not None and (not from_relay or node.get('_private') or
            not isinstance(update_data.get('expectedRevision'), str) or not isinstance(update_data.get('content'), str) or
            not str(node.get('content') or '').endswith('.md')):
        raise ValueError('仅可确认覆盖存在版本冲突的公开正文草稿')
    if node.get('_enc'):
        raise ValueError('Node is locked')
    if 'title' in update_data:
        update_data = {**update_data, 'title': unique_title(siblings, update_data['title'], node_id)}
    if node.get('_private'):
        _update_private_node(module, tree, node, update_data, context)
    else:
        _check_public_revision(node.get('content') or '', update_data, context, overwrite_revision=overwrite_revision)
        _write_public_markdown(module, node, update_data, context)
        if from_relay:
            from . import cms_covers, photos
            references = photos.media_references(update_data.get('content') or '')
            if update_data.get('coverImage'):
                references.append(update_data['coverImage'])
            cms_covers.restore_relay_attachments(references, from_relay=True)
        _set_metadata(node, update_data)
        cms_markdown.save(module, tree, context)
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
    target = _find(tree, target_parent_id)[2] if target_parent_id != 'root' else {}
    if not node.get('_enc'):
        unique_title(_children(tree, target_parent_id), node['title'], node_id)
    source_group = _group_of(node)
    if (node.get('_private') or node.get('_enc')) and target.get('_private') and source_group != _group_of(target):
        raise ValueError('两个文件夹使用不同密码组，请先调整内容所属组再移动')
    if target.get('_private') and not (node.get('_private') or node.get('_enc')):
        from . import private_cms
        private_cms.protect(module, node_id, _group_of(target))
        tree = context['load_tree'](module)
        siblings, index, node = _find(tree, node_id)
    destination = _children(tree, target_parent_id)
    del siblings[index]
    destination.append(node)
    cms_markdown.save(module, tree, context)
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


def _lock_source(node, context):
    if node.get('_enc'):
        return {'id': node['id'], '_enc': node['_enc']}
    content = node.get('content') or ''
    if content.endswith('.md'):
        from . import private_session
        path = _md_path(context, content)
        content = private_session.document(path)
        if content is None:
            with open(path, encoding='utf-8', newline='') as source:
                content = source.read()
    return {'id': node['id'], 'type': node['type'], 'title': node['title'],
            'tags': node.get('tags') or [], 'coverImage': node.get('coverImage'),
            'md': content, 'children': [child['id'] for child in node.get('children') or []]}


def lock_sources(node, context):
    """以正文与结构计算加锁前置版本，拒绝打包后已发生的外部修改。"""
    result = []
    for item in cms_store.walk([node]):
        encoded = json.dumps(_lock_source(item, context), ensure_ascii=False,
                             sort_keys=True, separators=(',', ':')).encode('utf-8')
        result.append({'id': item['id'], 'revision': hashlib.sha256(encoded).hexdigest()})
    return result


def verify_lock_sources(module, node_id, sources, context):
    tree = context['load_tree'](module)
    node = _find(tree, node_id)[2]
    if sources != lock_sources(node, context):
        raise ValueError('加锁前内容已变化，请重新读取后重试；原文未删除')


@storage.transactional
def lock_node(module: str, node_id: str, context: CmsContext, group='default') -> bool:
    """将节点标记为私密：只写 _private 标记，本地物理 .md 保持不变，不再生成密文。"""
    tree = context['load_tree'](module)
    node = _find(tree, node_id)[2]
    if node.get('_enc'):
        raise ValueError('Node already locked')
    node['_private'] = True
    if group != 'default':
        node['_group'] = group
    else:
        node.pop('_group', None)
    context['save_tree'](module, tree)
    return True


def _restore_node(source, module, context, parents=()):
    if source.get('_enc'):
        return {'id': source['id'], 'type': 'locked', '_enc': source['_enc'], 'children': None,
                **({'_group': source['_group']} if source.get('_group') else {})}
    target = {key: source[key] for key in ('id', 'type', 'title', 'tags', 'coverImage') if key in source}
    target.setdefault('type', 'note')
    target.setdefault('title', 'Untitled')
    target.setdefault('tags', [])
    target['content'] = source.get('content', '')
    if source.get('md') is not None and not target['content']:
        target['content'] = _new_md(module, target['title'], source['md'], context, parents)
    target['children'] = [_restore_node(child, module, context, (*parents, target['title']))
                          for child in source.get('children') or []] if target['type'] == 'folder' else None
    return target


@storage.transactional
def unlock_node(module: str, node_id: str, tree: JsonObject, context: CmsContext) -> bool:
    """解除节点的私密状态；保留本地物理文件，移除 _private 标记。"""
    current = context['load_tree'](module)
    siblings, index, node = _find(current, node_id)
    if node.get('_private'):
        node.pop('_private', None)
        node.pop('_group', None)
        context['save_tree'](module, current)
        return True
    if not node.get('_enc'):
        raise ValueError('Node is not locked')

    unique_title(siblings, tree.get('title'), node_id)
    validate_tree_names(tree.get('children') or [])
    siblings[index] = _restore_node(tree, module, context, cms_markdown.parent_titles(current, node_id))
    cms_markdown.save(module, current, context)
    return True


@storage.transactional
def migrate_markdown_names(module, context):
    """按当前逻辑目录整理已有公开正文，迁移失败时恢复正文、链接和索引。"""
    tree = context['load_tree'](module)
    validate_tree_names(tree['root'])
    return cms_markdown.save(module, tree, context, include_private=False)
