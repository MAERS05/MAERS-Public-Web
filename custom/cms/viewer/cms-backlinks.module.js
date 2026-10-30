/** 只读反向引用索引：仅扫描可访问笔记，最多四个请求并发。 */
export const BACKLINK_MODULES = ['notes', 'record', 'literature', 'games', 'videos'];
const MODULE_LABELS = { notes: '笔记', record: '记录', literature: '文学', games: '游戏', videos: '视频' };
const decode = value => { try { return decodeURIComponent(value); } catch (_) { return value; } };
export function notePath(node) {
    const path = node._mdPath || (typeof node.content === 'string' && node.content.endsWith('.md') ? node.content : '');
    return decode(path).replace(/^\/?data\//, '').replace(/^\//, '');
}
export function accessibleNotes(tree) {
    const notes = [];
    const walk = list => {
        for (const node of list || []) {
            if (!node || typeof node !== 'object' || '_enc' in node) continue;
            if (node.type === 'note' && node.id) notes.push(node);
            if (Array.isArray(node.children)) walk(node.children);
        }
    };
    walk(Array.isArray(tree) ? tree : tree?.root);
    return notes;
}
export function resolveBacklink(href, source, catalogue, origin = 'https://maers.invalid') {
    if (!href || href.startsWith('#')) return null;
    const unique = list => list.length === 1 ? list[0] : null;
    const raw = href.trim();
    let url;
    try { url = new URL(raw, origin + '/'); } catch (_) { return null; }
    if (url.origin !== new URL(origin).origin) return null;
    const module = url.pathname.split('/').pop().replace(/\.html$/, '');
    if (url.searchParams.has('openNote') || url.searchParams.has('openNoteId')) {
        const targetModule = module === 'admin-cms' ? url.searchParams.get('module') : module;
        const id = url.searchParams.get('openNoteId');
        return unique(catalogue.filter(item => item.module === targetModule && (id ? item.node.id === id : item.node.title === url.searchParams.get('openNote'))));
    }
    if (!url.pathname.toLowerCase().endsWith('.md')) return null;
    const path = decode(raw.split(/[?#]/)[0]);
    const sourcePath = notePath(source.node);
    const relative = new URL(path, origin + '/data/' + (sourcePath || source.module + '/note.md'));
    const relativePath = decode(relative.pathname).replace(/^\/data\//, '');
    const explicit = path.replace(/^\/?data\//, '').replace(/^\//, '');
    const candidates = catalogue.filter(item => {
        const targetPath = notePath(item.node);
        return targetPath && (targetPath === relativePath || (path.includes('/') && targetPath === explicit));
    });
    if (candidates.length) return unique(candidates);
    if (!path.includes('/')) {
        const title = path.replace(/\.md$/i, '');
        return unique(catalogue.filter(item => item.module === source.module && item.node.title === title));
    }
    return null;
}
export function backlinkUrl(item, admin = false) {
    const query = new URLSearchParams({ openNoteId: item.node.id, openNote: item.node.title });
    if (admin) query.set('module', item.module);
    return (admin ? 'admin-cms' : item.module) + '.html?' + query;
}

export function mountBacklinks({ host, module, getTarget, getNotes, preprocess, navigate }) {
    const doc = host.ownerDocument;
    let abort = null, generation = 0, dead = false, displayFrame = 0;
    let lute = null;
    const create = (tag, className, text) => {
        const el = doc.createElement(tag); el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    };
    const header = create('div', 'cms-backlinks-header');
    const heading = create('h2', '', '反向引用');
    const scope = create('select', 'cms-backlinks-scope');
    scope.setAttribute('aria-label', '反向引用统计范围');
    for (const [value, label] of [['module', '当前模块'], ['all', '全部模块']]) {
        const option = create('option', '', label); option.value = value; scope.appendChild(option);
    }
    const refresh = create('button', 'reader-admin-btn', '刷新'); refresh.type = 'button';
    const status = create('p', 'cms-backlinks-status', '正在查找引用…');
    status.setAttribute('role', 'status');
    const list = create('ul', 'cms-backlinks-list');
    header.append(heading, scope, refresh); host.replaceChildren(header, status, list);
    function extract(markdown) {
        lute ||= window.Lute?.New();
        if (!lute) throw new Error('Markdown renderer unavailable');
        lute.SetSanitize(true);
        const template = doc.createElement('template');
        template.innerHTML = lute.Md2HTML(preprocess(markdown));
        return Array.from(template.content.querySelectorAll('a[href]')).map(a => ({
            href: a.getAttribute('href'),
            snippet: (a.closest('p,li,blockquote,td')?.textContent || a.textContent || a.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim().slice(0, 180)
        }));
    }
    async function scan() {
        if (dead) return;
        abort?.abort(); cancelAnimationFrame(displayFrame); displayFrame = 0;
        abort = new AbortController();
        const signal = abort.signal, run = ++generation;
        const target = getTarget();
        if (!target) return;
        const current = () => !dead && run === generation && !signal.aborted;
        list.replaceChildren(); heading.textContent = '反向引用';
        status.textContent = '正在读取可访问笔记…'; host.setAttribute('aria-busy', 'true');
        let failures = 0, completed = 0;
        const catalogue = getNotes().filter(n => n.type === 'note' && !('_enc' in n)).map(node => ({ module, node }));
        if (scope.value === 'all') {
            await Promise.all(BACKLINK_MODULES.filter(name => name !== module).map(async name => {
                try {
                    const response = await fetch(`data/${name}-tree.json`, { signal, cache: 'no-cache' });
                    if (!response.ok) throw Error('Unreadable catalogue');
                    accessibleNotes(await response.json()).forEach(node => catalogue.push({ module: name, node }));
                } catch (error) { if (error.name !== 'AbortError') failures++; }
            }));
        }
        if (!current()) return;
        const sources = catalogue.filter(item => !(item.module === module && item.node.id === target.id));
        const results = [];
        let cursor = 0;
        const display = finished => {
            if (!current()) return;
            // 扫描期间被锁定或删除的来源也必须从显示结果移除。
            const visibleIds = new Set(getNotes().filter(n => n.type === 'note' && !('_enc' in n)).map(n => n.id));
            const visible = results.filter(item => item.module !== module || visibleIds.has(item.node.id));
            heading.textContent = `反向引用（${visible.length} 篇）`;
            list.replaceChildren();
            visible.sort((a, b) => a.module.localeCompare(b.module) || String(a.node.title || '').localeCompare(String(b.node.title || ''), 'zh-CN')).forEach(item => {
                const row = create('li', 'cms-backlink');
                const link = create('a', 'cms-backlink-title', item.node.title);
                link.href = backlinkUrl(item, window.IS_ADMIN === true);
                link.title = notePath(item.node) || item.node.title;
                link.addEventListener('click', event => {
                    if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault(); navigate(item);
                });
                const detail = create('span', 'cms-backlink-detail', `${MODULE_LABELS[item.module] || item.module}${notePath(item.node) ? ' · ' + notePath(item.node) : ''} · ${item.count} 处引用`);
                const snippet = create('p', 'cms-backlink-snippet', item.snippet);
                row.append(link, detail, snippet); list.appendChild(row);
            });
            status.textContent = finished
                ? `${scope.value === 'all' ? '全部模块' : '当前模块'}可访问笔记；已检查 ${completed} 篇。${failures ? `有 ${failures} 项读取失败，结果可能不完整。` : visible.length ? '' : '暂无其他笔记引用本篇。'}`
                : `已检查 ${completed}/${sources.length} 篇，正在继续查找…`;
        };
        await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
            while (current() && cursor < sources.length) {
                const item = sources[cursor++];
                try {
                    let markdown;
                    if (typeof item.node._draftContent === 'string') markdown = item.node._draftContent;
                    else if (notePath(item.node)) {
                        const path = notePath(item.node);
                        if (!path.startsWith(item.module + '/') || path.split('/').includes('..')) throw Error('Invalid note path');
                        const response = await fetch('data/' + path.split('/').map(encodeURIComponent).join('/'), { signal, cache: 'no-cache' });
                        if (!response.ok) throw Error('Unreadable note');
                        markdown = await response.text();
                    } else markdown = typeof item.node.content === 'string' ? item.node.content : '';
                    const matches = extract(markdown).filter(ref => {
                        const resolved = resolveBacklink(ref.href, item, catalogue, window.location.origin === 'null' ? 'https://maers.invalid' : window.location.origin);
                        return resolved?.module === module && resolved.node.id === target.id;
                    });
                    if (matches.length) results.push({ ...item, count: matches.length, snippet: matches[0].snippet });
                } catch (error) { if (error.name !== 'AbortError') failures++; }
                completed++;
                if (current() && !displayFrame) displayFrame = requestAnimationFrame(() => {
                    displayFrame = 0; display(false);
                });
            }
        }));
        if (current()) { cancelAnimationFrame(displayFrame); displayFrame = 0; display(true); host.removeAttribute('aria-busy'); }
    }
    scope.addEventListener('change', scan); refresh.addEventListener('click', scan);
    scan();
    return { refresh: scan, destroy() { dead = true; generation++; abort?.abort(); cancelAnimationFrame(displayFrame);
        scope.removeEventListener('change', scan); refresh.removeEventListener('click', scan); lute = null; } };
}
