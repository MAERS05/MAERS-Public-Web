/** 阅读器与源码双向滚动同步：按标题和代码块定位，块内插值，不修改正文。 */
export function interpolateScroll(points, value, from, to) {
    if (!points.length) return 0;
    if (value <= points[0][from]) return points[0][to];
    for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1], next = points[i];
        if (value <= next[from]) {
            const span = next[from] - previous[from];
            const ratio = span > 0 ? (value - previous[from]) / span : 0;
            return previous[to] + ratio * (next[to] - previous[to]);
        }
    }
    return points[points.length - 1][to];
}

export function scanScrollAnchors(markdown) {
    const lines = markdown.split('\n');
    const anchors = [];
    let fence = null, inComment = false;
    for (let line = 0; line < lines.length; line++) {
        const text = lines[line].replace(/\r$/, '').replace(/^(?: {0,3}>[ \t]?)+/, '');
        const match = text.match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (fence) {
            if (match && match[1][0] === fence.char && match[1].length >= fence.size && !match[2].trim()) {
                anchors.push({ kind: 'fence', language: fence.language, line: fence.line, end: line + 1 });
                fence = null;
            }
            continue;
        }
        if (inComment) {
            if (text.includes('-->')) inComment = false;
            continue;
        }
        if (text.includes('<!--')) {
            inComment = !text.slice(text.indexOf('<!--') + 4).includes('-->');
            continue;
        }
        if (match) {
            fence = { char: match[1][0], size: match[1].length, language: match[2].trim().split(/\s/)[0], line };
        } else if (/^ {0,3}#{1,6}\s+\S/.test(text)) {
            anchors.push({ kind: 'heading', line });
        } else if (line > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(text) && lines[line - 1].trim()) {
            anchors.push({ kind: 'heading', line: line - 1 });
        }
    }
    if (fence) anchors.push({ kind: 'fence', language: fence.language, line: fence.line, end: lines.length });
    return anchors.sort((a, b) => a.line - b.line);
}

export function createReaderScrollSync({ preview, content, source, drawer }) {
    if (!preview || !content || !source || !drawer) return null;
    const doc = source.ownerDocument;
    // Textareas normalize CRLF/CR to LF, unlike Markdown read with fetch().text().
    // Compare equivalent text without treating file line endings as pending edits.
    const normalizeNewlines = text => text.replace(/\r\n?/g, '\n');
    let rendered = normalizeNewlines(source.value), frame = 0, cache = null, leader = preview;
    let layoutLine = null, layoutTimer = 0, destroyed = false;
    const expected = new WeakMap();
    let mirrorText = null, mirrorStyle = '', rows = [];
    const mirror = doc.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    mirror.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:break-word;border:0;';
    doc.body.appendChild(mirror);
    const open = () => !drawer.classList.contains('collapsed');
    const max = el => Math.max(0, el.scrollHeight - el.clientHeight);
    const write = (el, value) => {
        const next = Math.max(0, Math.min(max(el), value));
        if (Math.abs(el.scrollTop - next) < 1) return;
        expected.set(el, next);
        el.scrollTop = next;
    };
    function previewAnchors() {
        const result = [{ line: 0, preview: 0 }];
        const headings = Array.from(content.querySelectorAll('h1,h2,h3,h4,h5,h6'))
            .filter(el => !el.closest('.cms-diagram-card'));
        const fences = new Map();
        content.querySelectorAll('[class*="language-"], pre > code:not([class])').forEach(el => {
            const language = Array.from(el.classList).find(name => name.startsWith('language-'))?.slice(9) || '';
            const card = el.closest('.cms-diagram-card');
            if (card && card !== el) return;
            const list = fences.get(language) || [];
            list.push(el.closest('pre') || el);
            fences.set(language, list);
        });
        const origin = preview.getBoundingClientRect().top;
        const position = el => el.getBoundingClientRect().top - origin + preview.scrollTop;
        let heading = 0;
        for (const anchor of scanScrollAnchors(rendered)) {
            const el = anchor.kind === 'heading' ? headings[heading++] : fences.get(anchor.language)?.shift();
            if (!el) continue;
            const top = position(el);
            result.push({ line: anchor.line, preview: top });
            if (anchor.end !== undefined) result.push({ line: anchor.end, preview: top + el.getBoundingClientRect().height });
        }
        result.push({ line: rendered.split('\n').length, preview: preview.scrollHeight });
        return result.sort((a, b) => a.line - b.line);
    }
    function measure() {
        if (cache) return cache;
        const anchors = previewAnchors();
        const style = getComputedStyle(source);
        for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing',
            'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'tabSize', 'wordBreak']) mirror.style[name] = style[name];
        mirror.style.width = source.clientWidth + 'px';
        // 图表或图片布局变化时复用源码测量节点，只在正文或字体宽度变化时重建。
        if (mirrorText !== source.value || mirrorStyle !== mirror.style.cssText) {
            mirrorText = source.value; mirrorStyle = mirror.style.cssText;
            const fragment = doc.createDocumentFragment();
            rows = source.value.split('\n').map(text => {
                const row = doc.createElement('div');
                row.style.minHeight = style.lineHeight;
                row.textContent = text || '\u200b';
                fragment.appendChild(row);
                return row;
            });
            mirror.replaceChildren(fragment);
        }
        const origin = mirror.getBoundingClientRect().top;
        const points = [{ preview: 0, source: 0 }];
        for (const anchor of anchors) {
            const row = rows[anchor.line];
            if (!row) continue;
            const point = { preview: Math.min(max(preview), Math.max(0, anchor.preview)),
                source: Math.min(max(source), Math.max(0, row.getBoundingClientRect().top - origin)) };
            const previous = points[points.length - 1];
            if (point.preview > previous.preview && point.source > previous.source &&
                point.preview < max(preview) && point.source < max(source)) points.push(point);
        }
        points.push({ preview: max(preview), source: max(source) });
        cache = { points, anchors };
        return cache;
    }
    function sync() {
        frame = 0;
        if (destroyed || source.value !== rendered) return;
        if (layoutLine !== null) {
            const anchors = previewAnchors();
            write(preview, interpolateScroll(anchors, layoutLine, 'line', 'preview'));
        }
        if (!open() || source.clientWidth <= 0) return;
        const { points } = measure();
        if (layoutLine !== null || leader === preview) write(source, interpolateScroll(points, preview.scrollTop, 'preview', 'source'));
        else write(preview, interpolateScroll(points, source.scrollTop, 'source', 'preview'));
    }
    const schedule = () => { if (!destroyed && !frame) frame = requestAnimationFrame(sync); };
    const onScroll = event => {
        const el = event.currentTarget;
        const wanted = expected.get(el);
        if (wanted !== undefined && Math.abs(el.scrollTop - wanted) < 2) { expected.delete(el); return; }
        expected.delete(el);
        if (!open() || layoutLine !== null) return;
        leader = el;
        schedule();
    };
    const onUserInput = event => { layoutLine = null; leader = event.currentTarget; };
    const invalidate = () => { cache = null; schedule(); };
    for (const el of [preview, source]) {
        el.addEventListener('scroll', onScroll, { passive: true });
        el.addEventListener('wheel', onUserInput, { passive: true });
        el.addEventListener('pointerdown', onUserInput, { passive: true });
        el.addEventListener('keydown', onUserInput);
    }
    source.addEventListener('input', invalidate);
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(invalidate) : null;
    [preview, content, source].forEach(el => resize?.observe(el));
    const mutation = typeof MutationObserver !== 'undefined' ? new MutationObserver(invalidate) : null;
    mutation?.observe(content, { childList: true, subtree: true });
    window.addEventListener('resize', invalidate);
    content.addEventListener('load', invalidate, true);
    doc.fonts?.ready.then(() => { if (!destroyed) invalidate(); });
    return {
        refresh(element, markdown) {
            if (element !== content) return;
            rendered = normalizeNewlines(markdown);
            invalidate();
        },
        capture() { return interpolateScroll(previewAnchors(), preview.scrollTop, 'preview', 'line'); },
        drawerChanged(line, focus) {
            layoutLine = line;
            leader = preview;
            cache = null;
            if (focus) {
                const lines = source.value.split('\n');
                const index = lines.slice(0, Math.max(0, Math.floor(line))).reduce((sum, text) => sum + text.length + 1, 0);
                source.setSelectionRange(index, index);
                source.focus({ preventScroll: true });
            }
            clearTimeout(layoutTimer);
            layoutTimer = setTimeout(() => { cache = null; sync(); layoutLine = null; }, 320);
            schedule();
        },
        destroy() {
            destroyed = true;
            cancelAnimationFrame(frame); clearTimeout(layoutTimer);
            resize?.disconnect(); mutation?.disconnect();
            window.removeEventListener('resize', invalidate);
            content.removeEventListener('load', invalidate, true);
            source.removeEventListener('input', invalidate);
            for (const el of [preview, source]) {
                el.removeEventListener('scroll', onScroll);
                el.removeEventListener('wheel', onUserInput);
                el.removeEventListener('pointerdown', onUserInput);
                el.removeEventListener('keydown', onUserInput);
            }
            mirror.remove(); rows = []; mirrorText = null;
        }
    };
}
