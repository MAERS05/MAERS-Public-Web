/** MAERS 阅读器生命周期：目录监听、外部编辑文件刷新与资源清理。 */
import { sha256Hex } from '../../../data-manage/encrypt/crypto.module.js';
import { localFetch } from '../../../data-manage/api-client.module.js';

let _outlineUserToggled = false;
let _outlineScrollHandler = null;
let _outlineScrollArea = null;
function disposeOutlineListener() {
    _outlineScrollArea?.removeEventListener('scroll', _outlineScrollHandler);
    _outlineScrollArea = null;
    _outlineScrollHandler = null;
}
export function resetReaderOutline() {
    disposeOutlineListener();
    _outlineUserToggled = false;
}

// ─── 目录大纲切换与动态生成 (H1-H6) ───
export function bindOutlineToggle() {
    const btn = document.querySelector('.outline-btn');
    const outline = document.getElementById('reader-outline');
    if (btn && outline) {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _outlineUserToggled = true;
            outline.classList.toggle('collapsed');
            newBtn.classList.toggle('active', !outline.classList.contains('collapsed'));
        });
    }
}

export function generateOutline() {
    const outlinePanel = document.getElementById('reader-outline');
    const contentContainer = document.getElementById('reader-content');
    const outlineBtn = document.querySelector('.outline-btn');
    if (!outlinePanel || !contentContainer) return;

    disposeOutlineListener();
    const headings = contentContainer.querySelectorAll('h1, h2, h3, h4, h5, h6');
    outlinePanel.innerHTML = '<div class="outline-title">目录大纲</div>';

    if (headings.length === 0) {
        outlinePanel.innerHTML += '<div class="outline-item outline-empty" style="color:var(--text-sub);cursor:default;">暂无章节目录</div>';
        if (!_outlineUserToggled) {
            outlinePanel.classList.add('collapsed');
        }
        outlineBtn?.classList.toggle('active', !outlinePanel.classList.contains('collapsed'));
        return;
    }

    outlineBtn?.classList.toggle('active', !outlinePanel.classList.contains('collapsed'));

    const items = [];
    headings.forEach((heading, index) => {
        const level = parseInt(heading.tagName.substring(1), 10);
        const item = document.createElement('div');
        item.className = `outline-item outline-level-${level}${index === 0 ? ' active' : ''}`;

        let rawText = heading.innerText || heading.textContent || 'Untitled';
        rawText = rawText.replace(/^#+\s*/g, '').replace(/\u200B/g, '').trim();
        item.textContent = rawText;
        item.title = rawText;

        if (!heading.id) heading.id = 'maers-heading-' + index;

        item.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            items.forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            heading.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
            if (window.innerWidth <= 1024) {
                outlinePanel.classList.add('collapsed');
                outlineBtn?.classList.remove('active');
            }
        });
        outlinePanel.appendChild(item);
        items.push(item);
    });

    // 绑定滚动跟随高亮当前章节
    const scrollArea = document.querySelector('#immersive-reader .reader-scroll-area');
    if (scrollArea) {
        _outlineScrollArea = scrollArea;
        _outlineScrollHandler = () => {
            const scrollTop = scrollArea.scrollTop;
            let activeIdx = 0;
            headings.forEach((h, idx) => {
                if (h.offsetTop - 120 <= scrollTop) {
                    activeIdx = idx;
                }
            });
            items.forEach((el, idx) => {
                el.classList.toggle('active', idx === activeIdx);
            });
        };
        scrollArea.addEventListener('scroll', _outlineScrollHandler, { passive: true });
    }
}


/** 用事件触发文件刷新；切换文档或关闭阅读器时中止旧请求。 */
export function createReaderFileWatcher({ getNode, isDirty, isLocal, onChange }) {
    let abort = null, active = false, pending = false, generation = 0;
    const refresh = async () => {
        const node = getNode();
        if (!active || pending || isDirty() || !node?._mdPath) return;
        const run = generation;
        const controller = new AbortController();
        abort = controller;
        pending = true;
        try {
            const path = node._mdPath.split('/').map(encodeURIComponent).join('/');
            const response = await (node._private ? localFetch : fetch)(`data/${path}?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
            if (!response.ok) return;
            const text = await response.text();
            const revision = await sha256Hex(text);
            if (!active || run !== generation || node !== getNode() || isDirty() || controller.signal.aborted) return;
            if (text !== node._rawMd) {
                node._rawMd = node._originalContent = node.content = text;
                node._sourceRevision = revision;
                node._loadFailed = false;
                onChange(node, text);
            }
        } catch (error) {
            if (error.name !== 'AbortError') console.warn('[MAERS.CMS] 外部文档刷新失败:', error);
        } finally {
            if (run === generation) { pending = false; abort = null; }
        }
    };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    const stop = () => {
        active = false; generation++; pending = false;
        abort?.abort(); abort = null;
        window.removeEventListener('focus', refresh);
        document.removeEventListener('visibilitychange', visible);
    };
    return {
        start() {
            stop();
            if (!isLocal() || !getNode()?._mdPath) return;
            active = true;
            window.addEventListener('focus', refresh);
            document.addEventListener('visibilitychange', visible);
        }, stop
    };
}
