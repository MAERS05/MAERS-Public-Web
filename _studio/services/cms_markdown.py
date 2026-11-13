"""CMS 正文的扁平文件命名、路径迁移与站内 Markdown 链接联动。"""

import os
import posixpath
import re
from urllib.parse import quote, unquote, urlsplit, urlunsplit

from . import storage


def sanitize_filename(title):
    return re.sub(r'[\\/*?:"<>|\x00-\x1f]', '', title).strip().rstrip('.') or 'Untitled'


def filename(parents, title):
    """仅根目录使用 root 前缀，子目录从第一层逻辑文件夹开始拼接。"""
    return '-'.join(sanitize_filename(part) for part in (*(parents or ['root']), title))


def md_path(context, relative):
    if not isinstance(relative, str) or not relative.endswith('.md'):
        raise ValueError('Invalid markdown path')
    project_root = os.path.realpath(context.get('PROJECT_ROOT') or os.path.dirname(os.path.realpath(context['DATA_DIR'])))
    md_root = os.path.realpath(context.get('MARKDOWN_ROOT') or os.path.join(project_root, 'markdown'))
    path = os.path.realpath(os.path.join(project_root, relative))
    if os.path.commonpath([md_root, path]) != md_root:
        raise ValueError('Invalid markdown path')
    return path


def parent_titles(tree, identity):
    def find(nodes, parents):
        for node in nodes:
            if node['id'] == identity:
                return parents
            found = find(node.get('children') or [], [*parents, node.get('title', '')])
            if found is not None:
                return found
        return None
    result = find(tree['root'], [])
    if result is None:
        raise ValueError('Node not found')
    return result


def _notes(nodes, parents=(), *, include_private=False, inherited_private=False):
    for node in nodes:
        # 旧版密文节点和会话内虚拟正文不能参与物理文件迁移。
        if node.get('_enc') or node.get('_private_group') or node.get('_private_id'):
            continue
        private = inherited_private or bool(node.get('_private'))
        if private and not include_private:
            continue
        if node['type'] == 'note' and str(node.get('content') or '').endswith('.md'):
            yield node, parents, private
        yield from _notes(node.get('children') or [], (*parents, node['title']),
                          include_private=include_private, inherited_private=private)


def _key(path):
    return path.replace('\\', '/').casefold()


def _plan(module, tree, context, *, include_private=False):
    rows = [(node, node['content'], filename(parents, node['title']), private)
            for node, parents, private in _notes(tree['root'], include_private=include_private)]
    owned = {_key(old) for _, old, _, _ in rows}
    used = set()
    result = []
    # 分配顺序不受页面排序影响；分隔符或非法字符造成的碰撞仍保留编号兜底。
    for node, old, base, private in sorted(rows, key=lambda row: row[0]['id']):
        number = 0
        while True:
            suffix = f' ({number})' if number else ''
            target = f'markdown/{module}/{base}{suffix}.md'
            key = _key(target)
            if key not in used and (key in owned or not os.path.exists(md_path(context, target))):
                break
            number += 1
        used.add(key)
        result.append((node, old, target, private))
    return result


def rewrite_links(text, source, mapping):
    """只改可精确定位的站内正文路径，保留显示文字、锚点和代码示例。"""
    def target(href):
        try:
            url = urlsplit(href)
        except ValueError:
            return href
        if url.scheme or url.netloc or not url.path.lower().endswith('.md'):
            return href
        path = unquote(url.path)
        relative = posixpath.normpath(posixpath.join(posixpath.dirname(source), path))
        explicit = path.lstrip('/')
        previous = relative if relative in mapping else explicit
        if previous not in mapping:
            return href
        updated = mapping[previous]
        if path.startswith('/'):
            updated = '/' + updated
        elif previous == relative:
            updated = posixpath.relpath(updated, posixpath.dirname(source))
        if '%' in url.path:
            updated = quote(updated, safe='/()')
        else:
            updated = updated.replace('%', '%25').replace('#', '%23').replace('?', '%3F')
        return urlunsplit(('', '', updated, url.query, url.fragment))

    def wiki(match):
        bang, name, alias = match.groups()
        if bang:
            return match[0]
        href = name if name.endswith('.md') else name + '.md'
        updated = target(href)
        if updated == href:
            return match[0]
        label = alias if alias is not None else '|' + name
        return '[[' + updated.removesuffix('.md') + label + ']]'

    def links(part):
        part = re.sub(r'(\]\([ \t]*<?)([^<>\r\n]*?\.md(?:[?#][^<>\s)]*)?)(?=>?(?:[ \t]+[\'\"][^\r\n]*?[\'\"])?[ \t]*\))',
                      lambda match: match[1] + target(match[2]), part)
        part = re.sub(r'(?m)^([ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?)([^<>\r\n]*?\.md(?:[?#][^<>\s]*)?)(?=>?(?:[ \t]|$))',
                      lambda match: match[1] + target(match[2]), part)
        part = re.sub(r'(\bhref\s*=\s*)([\'\"])(.*?)(\2)',
                      lambda match: match[1] + match[2] + target(match[3]) + match[4], part)
        return re.sub(r'(!?)\[\[([^\]|\n]+?)(\|[^\]\n]*)?\]\]', wiki, part)

    parts = re.split(r'(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)', text)
    return ''.join(part if index % 2 else links(part) for index, part in enumerate(parts))


def save(module, tree, context, *, include_private=True):
    """先准备并写入完整新正文，再发布索引和清理旧路径；由调用方事务统一回滚。"""
    rows = _plan(module, tree, context, include_private=include_private)
    mapping = {old: new for _, old, new, _ in rows if old != new}
    if not mapping:
        context['save_tree'](module, tree)
        return {}
    # 公开正文只更新公开目标的链接，避免在发布时带出私密文件名。
    public_mapping = {old: new for _, old, new, private in rows if old != new and not private}
    writes = []
    for node, old, new, private in rows:
        with open(md_path(context, old), 'rb') as source:
            original = source.read()
        updated = rewrite_links(original.decode('utf-8'), old, mapping if private else public_mapping).encode('utf-8')
        if old != new or updated != original:
            writes.append((new, updated))
        node['content'] = new
    # 跨模块的普通 Markdown 路径引用也随目标文件一起改动。
    from . import cms
    for other in cms.JS_SYNC_MAP:
        if other == module:
            continue
        for node, _, private in _notes(context['load_tree'](other)['root'], include_private=include_private):
            links = mapping if private else public_mapping
            if not links:
                continue
            path = node['content']
            with open(md_path(context, path), 'rb') as source:
                original = source.read()
            updated = rewrite_links(original.decode('utf-8'), path, links).encode('utf-8')
            if updated != original:
                writes.append((path, updated))
    for path, content in writes:
        storage.write_bytes(md_path(context, path), content)
    context['save_tree'](module, tree)
    targets = {os.path.normcase(new) for _, _, new, _ in rows}
    for old in mapping:
        if os.path.normcase(old) not in targets:
            storage.remove(md_path(context, old))
    return mapping
