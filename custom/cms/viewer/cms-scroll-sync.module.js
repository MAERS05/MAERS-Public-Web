/** 阅读器与源码双向滚动同步：按标题、表格行和代码块定位，块内插值，不修改正文。 */
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
    const rowText = line => line.replace(/\r$/, '').replace(/^(?: {0,3}>[ \t]?)+/, '');
    const tableDivider = text => text.includes('|') && text.trim().replace(/^\||\|$/g, '').split('|')
        .every(cell => /^\s*:?-+:?\s*$/.test(cell));
    let fence = null, inComment = false;
    for (let line = 0; line < lines.length; line++) {
        const text = rowText(lines[line]);
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
            const rawLang = match[2].trim().split(/\s/)[0].replace(/^(mindmap|markmap)-(?:both|lr|tb)$/i, '$1');
            fence = { char: match[1][0], size: match[1].length, language: rawLang, line };
        } else if (/^ {0,3}#{1,6}\s+\S/.test(text)) {
            anchors.push({ kind: 'heading', line });
        } else if (text.includes('|') && line + 1 < lines.length && tableDivider(rowText(lines[line + 1]))) {
            const rows = [line];
            let end = line + 2;
            while (end < lines.length && rowText(lines[end]).includes('|') && !/^\s*#/.test(rowText(lines[end]))) rows.push(end++);
            anchors.push({ kind: 'table', line, end, rows });
            line = end - 1;
        } else if (line > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(text) && lines[line - 1].trim()) {
            anchors.push({ kind: 'heading', line: line - 1 });
        }
    }
    if (fence) anchors.push({ kind: 'fence', language: fence.language, line: fence.line, end: lines.length });
    return anchors.sort((a, b) => a.line - b.line);
}

export function createReaderScrollSync({ preview, content, source, drawer }) {
    if (!preview || !content || !source || !drawer) return null;
    const scrollSource = source.scrollElement;
    if (!scrollSource) return null;
    const doc = scrollSource.ownerDocument;
    // 源码框统一使用 LF，避免文件换行符被误判为待预览编辑。
    const normalizeNewlines = text => text.replace(/\r\n?/g, '\n');
    let rendered = normalizeNewlines(source.value), frame = 0, cache = null, leader = preview;
    let markdownAnchors = scanScrollAnchors(rendered), lineCount = rendered.split('\n').length;
    let previewCache = null, layoutLine = null, layoutTimer = 0, measureTimer = 0;
    let layoutPending = false, destroyed = false;
    const expected = new WeakMap();
    const open = () => !drawer.classList.contains('collapsed');
    const max = el => Math.max(0, el.scrollHeight - el.clientHeight);
    const write = (el, value) => {
        const next = Math.max(0, Math.min(max(el), value));
        if (Math.abs(el.scrollTop - next) < 1) return;
        expected.set(el, next);
        el.scrollTop = next;
    };
    function previewAnchors() {
        if (previewCache) return previewCache;
        const result = [{ line: 0, preview: 0 }];
        const headings = Array.from(content.querySelectorAll('h1,h2,h3,h4,h5,h6'))
            .filter(el => !el.closest('.cms-diagram-card'));
        const tables = Array.from(content.querySelectorAll('table')).filter(el => !el.closest('.cms-diagram-card'));
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
        for (const anchor of markdownAnchors) {
            const el = anchor.kind === 'heading' ? headings[heading++] : anchor.kind === 'table' ? tables.shift() :
                fences.get(anchor.language)?.shift();
            if (!el) continue;
            const top = position(el);
            if (anchor.kind === 'table') {
                const rows = Array.from(el.querySelectorAll('tr'));
                anchor.rows.forEach((line, index) => { if (rows[index]) result.push({ line, preview: position(rows[index]) }); });
            } else result.push({ line: anchor.line, preview: top });
            if (anchor.end !== undefined) result.push({ line: anchor.end, preview: top + el.getBoundingClientRect().height });
        }
        result.push({ line: lineCount, preview: preview.scrollHeight });
        previewCache = result.sort((a, b) => a.line - b.line);
        return previewCache;
    }
    function measure() {
        if (cache) return cache;
        const anchors = previewAnchors();
        const previewMax = max(preview), sourceMax = max(scrollSource);
        const points = [{ preview: 0, source: 0 }];
        for (const anchor of anchors) {
            const point = { preview: Math.min(previewMax, Math.max(0, anchor.preview)),
                source: Math.min(sourceMax, Math.max(0, source.lineTop(anchor.line))) };
            const previous = points[points.length - 1];
            if (point.preview > previous.preview && point.source > previous.source &&
                point.preview < previewMax && point.source < sourceMax) points.push(point);
        }
        points.push({ preview: previewMax, source: sourceMax });
        cache = { points, anchors };
        return cache;
    }
    function sync() {
        frame = 0;
        if (destroyed || layoutPending || source.value !== rendered) return;
        if (layoutLine !== null) {
            const anchors = previewAnchors();
            write(preview, interpolateScroll(anchors, layoutLine, 'line', 'preview'));
        }
        if (!open() || scrollSource.clientWidth <= 0) return;
        const { points } = measure();
        // 源码工具栏占据额外高度，以两边共同可见区域的顶部对齐内容。
        const previewTop = preview.getBoundingClientRect().top, sourceTop = scrollSource.getBoundingClientRect().top;
        const sharedTop = Math.max(previewTop, sourceTop);
        const previewOffset = sharedTop - previewTop, sourceOffset = sharedTop - sourceTop;
        if (layoutLine !== null || leader === preview) {
            write(scrollSource, interpolateScroll(points, preview.scrollTop + previewOffset, 'preview', 'source') - sourceOffset);
        } else write(preview, interpolateScroll(points, scrollSource.scrollTop + sourceOffset, 'source', 'preview') - previewOffset);
    }
    const schedule = () => { if (!destroyed && !frame) frame = requestAnimationFrame(sync); };
    const onScroll = event => {
        const el = event.currentTarget;
        const wanted = expected.get(el);
        if (wanted !== undefined && Math.abs(el.scrollTop - wanted) < 2) { expected.delete(el); return; }
        expected.delete(el);
        if (!open() || layoutLine !== null) return;
        leader = el;
        cache = null;
        schedule();
    };
    const onUserInput = event => { layoutLine = null; leader = event.currentTarget; };
    const onSourceLayout = () => { cache = null; if (open() && !layoutPending) schedule(); };
    const invalidate = () => {
        cache = null; previewCache = null;
        clearTimeout(measureTimer);
        if (destroyed || layoutPending || (!open() && layoutLine === null)) return;
        // 合并异步图表、字体和尺寸通知，避免一次布局变化引发多轮长文测量。
        measureTimer = setTimeout(() => { measureTimer = 0; schedule(); }, 80);
    };
    const finishLayout = () => {
        clearTimeout(layoutTimer); clearTimeout(measureTimer);
        layoutPending = false; cache = null; previewCache = null;
        cancelAnimationFrame(frame); frame = 0;
        sync();
        layoutLine = null;
    };
    const onLayoutEnd = event => {
        if (layoutPending && event.target === drawer && event.propertyName === 'width') finishLayout();
    };
    drawer.addEventListener('transitionend', onLayoutEnd);
    for (const el of [preview, scrollSource]) {
        el.addEventListener('scroll', onScroll, { passive: true });
        el.addEventListener('wheel', onUserInput, { passive: true });
        el.addEventListener('pointerdown', onUserInput, { passive: true });
        el.addEventListener('keydown', onUserInput);
    }
    source.host.addEventListener('sourcechange', invalidate);
    source.host.addEventListener('sourcelayout', onSourceLayout);
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(invalidate) : null;
    [preview, content, scrollSource].forEach(el => resize?.observe(el));
    const mutation = typeof MutationObserver !== 'undefined' ? new MutationObserver(records => {
        // 图表内部增删绘制节点不影响正文锚点；整体高度由尺寸观察器处理。
        if (records.some(record => !record.target.closest?.('.cms-diagram-card'))) invalidate();
    }) : null;
    mutation?.observe(content, { childList: true, subtree: true });
    window.addEventListener('resize', invalidate);
    content.addEventListener('load', invalidate, true);
    doc.fonts?.ready.then(() => { if (!destroyed) invalidate(); });
    return {
        refresh(element, markdown) {
            if (element !== content) return;
            const next = normalizeNewlines(markdown);
            if (next !== rendered) {
                rendered = next;
                markdownAnchors = scanScrollAnchors(rendered);
                lineCount = rendered.split('\n').length;
            }
            invalidate();
        },
        capture() { return interpolateScroll(previewAnchors(), preview.scrollTop, 'preview', 'line'); },
        drawerChanged(line, focus) {
            layoutLine = line;
            layoutPending = true;
            leader = preview;
            cache = null; previewCache = null;
            clearTimeout(measureTimer);
            cancelAnimationFrame(frame); frame = 0;
            if (focus) {
                const lines = source.value.split('\n');
                const index = lines.slice(0, Math.max(0, Math.floor(line))).reduce((sum, text) => sum + text.length + 1, 0);
                source.setSelectionRange(index, index);
                source.focus({ preventScroll: true });
            }
            clearTimeout(layoutTimer);
            // 无动画或过渡被取消时，使用兜底调度完成一次最终定位。
            layoutTimer = setTimeout(finishLayout, 320);
        },
        destroy() {
            destroyed = true;
            cancelAnimationFrame(frame); clearTimeout(layoutTimer); clearTimeout(measureTimer);
            resize?.disconnect(); mutation?.disconnect();
            window.removeEventListener('resize', invalidate);
            content.removeEventListener('load', invalidate, true);
            drawer.removeEventListener('transitionend', onLayoutEnd);
            source.host.removeEventListener('sourcechange', invalidate);
            source.host.removeEventListener('sourcelayout', onSourceLayout);
            for (const el of [preview, scrollSource]) {
                el.removeEventListener('scroll', onScroll);
                el.removeEventListener('wheel', onUserInput);
                el.removeEventListener('pointerdown', onUserInput);
                el.removeEventListener('keydown', onUserInput);
            }
            previewCache = null;
        }
    };
}
