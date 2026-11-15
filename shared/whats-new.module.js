/** 更新日志：侧栏入口、非阻塞信息面板与真实日志的已读状态。 */
import { icon } from './icons.module.js';
const STORAGE_KEY = 'maers_changelog_seen';

export function initWhatsNew() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
}

function mount() {
    if (document.getElementById('whats-new-btn')) return;
    const sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = new URL('../static-style/whats-new.css', import.meta.url).href;
    document.head.append(sheet);
    const button = document.createElement('button');
    button.id = 'whats-new-btn';
    button.type = 'button';
    button.className = 'wn-trigger-btn app-icon-button';
    button.title = '更新日志';
    button.setAttribute('aria-label', '更新日志');
    button.setAttribute('aria-controls', 'whats-new-panel');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = icon('clock', 18) + '<span class="wn-unread-dot" hidden aria-hidden="true"></span>';
    const panel = document.createElement('section');
    panel.id = 'whats-new-panel';
    panel.className = 'wn-log-panel';
    panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '更新日志');
    panel.innerHTML = '<header class="wn-log-header"><h2>更新日志</h2><button type="button" class="app-icon-button" data-close title="关闭更新日志" aria-label="关闭更新日志">' + icon('close', 18) + '</button></header><div class="wn-log-content" aria-live="polite"></div>';
    (document.querySelector('.app-sidebar-actions') || document.body).append(button);
    document.body.append(panel);
    const content = panel.querySelector('.wn-log-content');
    const dot = button.querySelector('.wn-unread-dot');
    const nativePopover = typeof panel.showPopover === 'function';
    let latestDate = '', generation = 0;
    const markRead = () => {
        dot.hidden = true;
        button.setAttribute('aria-label', '更新日志');
        if (latestDate) try { localStorage.setItem(STORAGE_KEY, latestDate); } catch { /* 阅读入口不依赖存储权限。 */ }
    };
    const setOpen = open => {
        panel.classList.toggle('is-open', open);
        button.setAttribute('aria-expanded', String(open));
        if (open) { markRead(); reload(); }
        else if (panel.contains(document.activeElement)) button.focus();
    };
    const close = () => {
        if (nativePopover) panel.hidePopover();
        else setOpen(false);
    };
    if (nativePopover) panel.addEventListener('toggle', event => setOpen(event.newState === 'open'));
    button.onclick = () => {
        const open = !panel.classList.contains('is-open');
        if (nativePopover) { if (open) panel.showPopover(); else panel.hidePopover(); }
        else setOpen(open);
    };
    panel.querySelector('[data-close]').onclick = close;
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    });
    document.addEventListener('click', event => {
        if (!nativePopover && !panel.contains(event.target) && !button.contains(event.target)) setOpen(false);
    });
    content.addEventListener('click', event => { if (event.target.closest('[data-retry]')) reload(); });
    async function reload() {
        const request = ++generation;
        if (!content.children.length) content.innerHTML = '<p class="wn-log-state" role="status">正在读取更新…</p>';
        try {
            const response = await fetch(new URL('../data/changelog.json', import.meta.url), { cache: 'no-cache' });
            if (!response.ok) throw new Error('读取失败');
            const logs = await response.json();
            if (!Array.isArray(logs) || !logs.every(group => typeof group?.date === 'string' && Array.isArray(group.entries) && group.entries.every(entry => typeof entry === 'string'))) throw new Error('日志格式无效');
            if (request !== generation) return;
            const sorted = logs.filter(group => group.entries.length).slice().sort((a, b) => b.date.localeCompare(a.date));
            latestDate = sorted[0]?.date || '';
            content.innerHTML = renderLogs(sorted);
            let seen = '';
            try { seen = localStorage.getItem(STORAGE_KEY) || ''; } catch { /* 无存储时只展示当前内容。 */ }
            dot.hidden = !latestDate || latestDate <= seen;
            button.setAttribute('aria-label', dot.hidden ? '更新日志' : '更新日志，有未读更新');
            if (panel.classList.contains('is-open')) markRead();
        } catch (error) {
            if (request !== generation) return;
            content.innerHTML = '<div class="wn-log-state"><p>暂时无法读取更新日志</p><button type="button" data-retry>重新加载</button></div>';
            console.warn('[MAERS.Changelog] 日志读取失败：', error);
        }
    }
    reload();
}

function renderLogs(logs) {
    if (!logs.length) return '<div class="wn-log-state wn-log-empty">' + icon('clock', 28) + '<p>还没有发布更新</p></div>';
    return logs.map(group => '<section class="wn-log-group"><h3><time datetime="' + escapeHtml(group.date) + '">' + escapeHtml(formatDate(group.date)) + '</time></h3><ul>' + group.entries.map(entry => '<li>' + escapeHtml(entry) + '</li>').join('') + '</ul></section>').join('');
}
function formatDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? match[1] + '年' + Number(match[2]) + '月' + Number(match[3]) + '日' : value;
}
function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
}
