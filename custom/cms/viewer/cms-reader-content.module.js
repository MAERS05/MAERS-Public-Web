/** MAERS 阅读器内容：Markdown 预处理、链接增强、任务状态和锚点导航。 */
import { Utils } from '../../../shared/utils.module.js';
import { Toast } from '../../../shared/toast.module.js';
import { mountDiagramFullscreenButton as _mountDiagramFullscreenButton } from './cms-diagrams.module.js';

// 现代文档胶囊 SVG 图标
const DOC_PILL_ICON = '<svg class="cms-pill-icon" width="15" height="15" style="width:15px;height:15px;min-width:15px;flex-shrink:0;" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 1.75H4.25A1.5 1.5 0 0 0 2.75 3.25v9.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 1.75Z"/><path d="M9.25 1.75V5.5H13"/><path d="M5.25 8.5h5.5M5.25 11.25h3.5"/></svg>';
const CROSS_PILL_ICON = '<svg class="cms-pill-icon" width="15" height="15" style="width:15px;height:15px;min-width:15px;flex-shrink:0;" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.75 3.25H3.75a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5v-3"/><path d="M9.75 2.25h4v4"/><path d="M13.5 2.5 7.25 8.75"/></svg>';

// GitHub Alerts 类型元数据配置
const ALERT_META = {
    note:      { icon: 'ℹ️', label: 'Note' },
    tip:       { icon: '💡', label: 'Tip' },
    important: { icon: '🟣', label: 'Important' },
    warning:   { icon: '⚠️', label: 'Warning' },
    caution:   { icon: '🚨', label: 'Caution' }
};

/**
 * Markdown 渲染前预处理管线（自动保护围栏代码块与行内代码）：
 * 1. 将 ](../../photos/ 或 ](/photos/ 等相对/根路径统一归一化为 ](photos/
 * 2. 将 [[目标笔记|显示名]] 或 [[目标笔记]] 转换为站内双链标签 <a href="目标笔记.md" class="cms-wikilink">显示名</a>
 * @param {string} mdText - 原始 Markdown 文本
 * @returns {string} 预处理后的 Markdown 文本
 */
export function preprocessMarkdown(mdText) {
    if (!mdText || typeof mdText !== 'string') return '';

    const codeSlots = [];
    const protectedText = mdText.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g, (match) => {
        const token = `\u0000CMS_CODE_SLOT_${codeSlots.length}\u0000`;
        codeSlots.push(match);
        return token;
    });

    const processed = protectedText
        // 1. Markdown 与 HTML 图片路径归一化，兼容 Typora 本地相对路径与网页端根路径
        .replace(/\]\((?:(?:\.\.\/)+|\/)photos\//g, '](photos/')
        .replace(/(<img\b[^>]*?\bsrc=["'])(?:(?:\.\.\/)+|\/)photos\//gi, '$1photos/')
        // 2. 站内双链语法转换（忽略 ![[图片]] 语法）
        .replace(/(!?)\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g, (full, bang, target, alias) => {
            if (bang === '!') return full;
            const cleanTarget = target.trim();
            if (!cleanTarget) return full;
            const displayText = (alias ? alias.trim() : cleanTarget);
            const hrefTarget = cleanTarget.endsWith('.md') ? cleanTarget : `${cleanTarget}.md`;
            return `<a href="${_escapeHtml(hrefTarget)}" class="cms-wikilink">${_escapeHtml(displayText)}</a>`;
        });

    return processed.replace(/\u0000CMS_CODE_SLOT_(\d+)\u0000/g, (_, idx) => codeSlots[Number(idx)]);
}

/**
 * 将渲染后 DOM 中的块级引用 [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
 * 转换为高亮 GitHub Alert 提示卡
 * @param {HTMLElement} container - 渲染容器元素
 */
export function enhanceGitHubAlerts(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;

    const blockquotes = container.querySelectorAll('blockquote');
    blockquotes.forEach((bq) => {
        if (bq.classList.contains('cms-alert')) return;

        const firstP = bq.querySelector('p') || bq.firstElementChild;
        if (!firstP) return;

        const rawText = (firstP.textContent || '').trim();
        const match = rawText.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+([^\n]*))?/i);
        if (!match) return;

        const alertType = match[1].toLowerCase();
        const meta = ALERT_META[alertType];
        if (!meta) return;

        // 移除首段中的 [!TYPE] 标记与紧随其后的换行
        firstP.innerHTML = firstP.innerHTML
            .replace(/^\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:<br\s*\/?>|\r?\n)?/i, '')
            .trim();

        if (!firstP.innerHTML) {
            firstP.remove();
        }

        bq.classList.add('cms-alert', `cms-alert-${alertType}`);

        const titleEl = container.ownerDocument
            ? container.ownerDocument.createElement('div')
            : document.createElement('div');
        titleEl.className = 'cms-alert-title';
        titleEl.innerHTML = `<span class="cms-alert-icon">${meta.icon}</span><span>${_escapeHtml(meta.label)}</span>`;
        bq.insertBefore(titleEl, bq.firstChild);
    });
}


// Task checkboxes are browser-local view state, just like a diagram's viewport.
// No source edits, controller writes, or network calls belong in this handler.
const _taskViewStates = new Map();
let _taskStorageWarningShown = false;

function _taskViewKey(label) {
    // Two independent hashes avoid putting task text into browser storage keys.
    let first = 2166136261, second = 5381;
    for (let i = 0; i < label.length; i++) {
        first = Math.imul(first ^ label.charCodeAt(i), 16777619);
        second = Math.imul(second, 33) ^ label.charCodeAt(i);
    }
    return (first >>> 0).toString(36) + '-' + (second >>> 0).toString(36);
}

export function bindInteractiveTasks(container, node, module) {
    const noteId = node?.id || node?._mdPath || node?.title;
    if (!noteId) return;
    const storageKey = 'maers.task-view.v1:' + JSON.stringify([module, noteId]);
    const readState = () => {
        let state = _taskViewStates.get(storageKey) || {};
        try {
            const stored = JSON.parse(localStorage.getItem(storageKey) || 'null');
            if (stored && typeof stored === 'object' && !Array.isArray(stored)) state = { ...stored, ...state };
        } catch (_) { /* Disabled storage falls back to state for this page session. */ }
        _taskViewStates.set(storageKey, state);
        return state;
    };
    const counts = new Map();
    const state = readState();
    container.querySelectorAll('li.vditor-task > input[type="checkbox"]').forEach(box => {
        const label = box.parentElement.cloneNode(true);
        label.querySelectorAll('ul, ol, input').forEach(child => child.remove());
        const fingerprint = _taskViewKey((label.textContent || '').replace(/\s+/g, ' ').trim());
        const occurrence = counts.get(fingerprint) || 0;
        counts.set(fingerprint, occurrence + 1);
        const taskKey = fingerprint + ':' + occurrence;
        if (box.dataset.taskBound) return;
        box.dataset.taskBound = 'true';
        if (typeof state[taskKey] === 'boolean') box.checked = state[taskKey];
        box.disabled = false;
        box.title = '仅记忆在当前浏览器，不修改 Markdown';
        box.parentElement.classList.toggle('vditor-task--done', box.checked);
        box.addEventListener('change', () => {
            box.parentElement.classList.toggle('vditor-task--done', box.checked);
            const next = { ...readState(), [taskKey]: box.checked };
            _taskViewStates.set(storageKey, next);
            try {
                localStorage.setItem(storageKey, JSON.stringify(next));
            } catch (_) {
                if (!_taskStorageWarningShown) {
                    _taskStorageWarningShown = true;
                    Toast.show('浏览器存储不可用，任务勾选仅在本次页面打开期间保留', 'info');
                }
            }
        });
    });
}

function _enhanceReaderLink(a) {
    const href = (a.getAttribute('href') || '').trim();
    if (!href) return;
    // A linked image is content, not a text-only document chip.
    if (a.querySelector('img, picture, video, audio')) {
        a.classList.add('cms-media-link');
        return;
    }
    const isWiki = a.classList.contains('cms-wikilink');
    const isMd = (/\.md(?:[?#]|$)/i.test(href) && !/^(?:https?:)?\/\//i.test(href)) || isWiki;
    const isCross = /[?&]openNote(?:Id)?=/.test(href);
    if (!isMd && !isCross) return;
    a.classList.add('cms-doc-pill');
    if (isWiki) a.classList.add('cms-doc-pill--wiki');
    if (isCross && !isMd) a.classList.add('cms-doc-pill--cross');
    if (a.querySelector('.cms-pill-icon')) return;
    const label = (a.textContent || '').trim().replace(/\.md$/i, '') || href;
    const badge = isWiki ? '<span class="cms-double-chain-icon" aria-hidden="true"></span>' : '';
    a.innerHTML = `${isCross && !isMd ? CROSS_PILL_ICON : DOC_PILL_ICON}${badge}<span class="cms-pill-text">${_escapeHtml(label)}</span>`;
    if (!a.getAttribute('title')) {
        let target = href;
        try { target = decodeURIComponent(href); } catch (_) { /* Keep malformed escapes literal. */ }
        a.setAttribute('title', `${isWiki ? '双链目标' : '链接目标'}：${target}`);
    }
}

// Turn Lute's TOC spans into keyboard-accessible links and route fragment clicks
// inside this reader (TOC, footnotes and handwritten anchors share one handler).
export function bindReaderFragmentNavigation(container) {
    container.querySelectorAll('.vditor-toc span[data-target-id]').forEach(entry => {
        const id = entry.getAttribute('data-target-id');
        if (!id) return;
        const link = container.ownerDocument.createElement('a');
        link.setAttribute('href', '#' + encodeURIComponent(id));
        link.className = 'cms-toc-link';
        while (entry.firstChild) link.appendChild(entry.firstChild);
        entry.replaceWith(link);
    });
    if (container.dataset.fragmentNavigationBound) return;
    container.dataset.fragmentNavigationBound = 'true';
    container.addEventListener('click', e => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button > 0) return;
        const link = e.target.closest('a[href^="#"]');
        if (!link || !container.contains(link)) return;
        const href = link.getAttribute('href');
        if (!href || href.length < 2) return;
        let id;
        try { id = decodeURIComponent(href.slice(1)); } catch (_) { return; }
        const target = Array.from(container.querySelectorAll('[id]')).find(el => el.id === id);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
        if (!target.hasAttribute('tabindex') && target.tabIndex < 0) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
    }, true);
}

/**
 * 增强阅读器渲染后的 DOM 元素：
 * 1. 将站内 .md 链接与跨模块 ?openNote= 链接转化为带 SVG 图标的现代文档胶囊 (.cms-doc-pill)，自动隐藏末尾 .md 后缀
 * 2. 为思维导图/流程图容器统一添加 .cms-diagram-card 圆角卡片类
 * 3. 为表格外层包裹 .cms-table-wrap 圆角滚动容器
 * @param {HTMLElement} container - 渲染容器元素
 */
export function enhanceReaderElements(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return;

    // 1. 升级站内文档链接与跨模块跳转链接为现代胶囊
    container.querySelectorAll('a').forEach(_enhanceReaderLink);

    // 2. 为导图与图表容器统一挂载圆角卡片类与右上角全屏切换按钮，并剥离外层 <pre> 的双框边框
    const diagrams = container.querySelectorAll(
        '.language-mindmap, .language-markmap, .language-mermaid, .language-echarts, .language-flowchart, .language-graphviz'
    );
    diagrams.forEach((el) => {
        el.classList.add('cms-diagram-card');
        if (el.parentElement && el.parentElement.tagName === 'PRE') {
            el.parentElement.classList.add('cms-diagram-pre');
        }
        _mountDiagramFullscreenButton(el);
    });

    // 3. 为表格包裹圆角卡片容器
    const tables = container.querySelectorAll('table');
    tables.forEach((table) => {
        const parent = table.parentElement;
        if (!parent || parent.classList.contains('cms-table-wrap')) return;
        const doc = container.ownerDocument || document;
        const wrap = doc.createElement('div');
        wrap.className = 'cms-table-wrap';
        parent.insertBefore(wrap, table);
        wrap.appendChild(table);
    });
}


const _escapeHtml = value => Utils.escapeHtml(value);
