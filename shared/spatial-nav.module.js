/**
 * @version 2.0.0
 */
/** 应用侧栏：公开入口分组，与首页共用导航请求。 */
import { icon } from './icons.module.js';
import { isEncryptedRecord } from '../data-manage/encrypt/crypto.module.js';
import { Utils } from './utils.module.js';
import { revealInPlace } from '../data-manage/encrypt/secret-unlock.module.js';
let navDataRequest = null;
export function getNavData() {
    if (!navDataRequest) {
        navDataRequest = fetch('data/index-cards.json').then(async response => {
            if (!response.ok) throw new Error('导航暂时无法读取');
            const data = await response.json();
            if (!Array.isArray(data)) throw new Error('导航数据格式不正确');
            return data;
        }).catch(error => { navDataRequest = null; throw error; });
    }
    return navDataRequest.then(data => data.map(card => ({ ...card })));
}
const modules = {
    notes: ['笔记', 'note', '随手记录，慢慢整理'],
    record: ['记录', 'clock', '留下一些日常'],
    literature: ['文学', 'book', '读过的书与文字'],
    videos: ['影视', 'video', '看过与想看的作品'],
    album: ['相册', 'photo', '留住喜欢的瞬间'],
    photos: ['照片', 'photo', '打开这一刻'],
    music: ['音乐', 'music', '给此刻一点声音'],
    space: ['收藏', 'collection', '把喜欢的放在一起'],
    games: ['游戏', 'game', '玩过与正在玩的世界']
};
export function navigationInfo(item) {
    const url = new URL(item.url || 'index.html', location.href);
    const key = url.searchParams.get('module') || url.pathname.split('/').pop().replace(/^admin-/, '').replace(/\.html$/, '');
    const info = modules[key];
    return { title: info ? info[0] : item.title || '自定义入口', icon: info ? info[1] : 'link',
        description: info ? info[2] : item.description || '', key };
}
function navLink(item, current) {
    const info = navigationInfo(item);
    const active = current === info.key || info.key === 'album' && current === 'photos';
    return '<a class="app-nav-link' + (active ? ' is-current' : '') + '" href="' + Utils.escapeAttr(item.url) + '"' +
        (active ? ' aria-current="page"' : '') + '>' + icon(info.icon) + '<span>' + Utils.escapeHtml(info.title) + '</span></a>';
}
export async function initSpatialNav() {
    if (document.getElementById('spatial-nav-container')) return;
    const aside = document.createElement('aside');
    aside.id = 'spatial-nav-container';
    aside.className = 'app-sidebar';
    aside.setAttribute('aria-label', '应用导航');
    aside.innerHTML = '<a class="app-brand" href="index.html"><img src="ui/index.svg" alt="" data-logo-unlock draggable="false"><span>我的空间</span></a>' +
        '<nav class="app-nav" aria-label="主导航"><a class="app-nav-link" href="index.html">' + icon('home') + '<span>首页</span></a></nav>' +
        '<div class="app-sidebar-bottom"><a class="app-nav-link" href="me.html">' + icon('info') +
        '<span>关于</span></a><div class="app-sidebar-actions" aria-label="应用工具"></div></div>';
    document.body.prepend(aside);
    document.body.classList.add('app-shell');
    document.documentElement.classList.remove('shrink-view');
    const theme = document.querySelector('.theme-switch-wrapper');
    if (theme) aside.querySelector('.app-sidebar-actions').append(theme);
    document.querySelectorAll('.site-guide-wrapper, #whats-new-btn, .od-btn').forEach(button => aside.querySelector('.app-sidebar-actions').append(button));
    const sheet = document.createElement('link');
    sheet.rel = 'stylesheet';
    sheet.href = 'static-style/spatial-nav.css';
    document.head.append(sheet);
    const current = new URLSearchParams(location.search).get('module') ||
        location.pathname.split('/').pop().replace(/^admin-/, '').replace(/\.html$/, '') || 'index';
    if (current === 'index') aside.querySelector('.app-nav-link').setAttribute('aria-current', 'page');
    try {
        const cards = await getNavData();
        await revealInPlace(cards);
        const data = cards.filter(item => !isEncryptedRecord(item) && item.url);
        const groups = [
            ['阅读', 'book', ['notes', 'record', 'literature']],
            ['影像', 'photo', ['album', 'videos']],
            ['音乐', 'music', ['music']],
            ['收藏', 'collection', ['space', 'games']]
        ];
        const nav = aside.querySelector('.app-nav');
        for (const [label, symbol, keys] of groups) {
            const entries = data.filter(item => keys.includes(navigationInfo(item).key));
            if (!entries.length) continue;
            if (entries.length === 1) { nav.insertAdjacentHTML('beforeend', navLink(entries[0], current)); continue; }
            const open = keys.includes(current) || keys.includes('album') && current === 'photos';
            nav.insertAdjacentHTML('beforeend', '<details class="app-nav-group"' + (open ? ' open' : '') +
                '><summary>' + icon(symbol) + '<span>' + label + '</span>' + icon('forward', 14) +
                '</summary><div class="app-nav-children">' + entries.map(item => navLink(item, current)).join('') + '</div></details>');
        }
        const extra = data.filter(item => !Object.hasOwn(modules, navigationInfo(item).key));
        if (extra.length) nav.insertAdjacentHTML('beforeend', extra.map(item => navLink(item, current)).join(''));
    } catch (error) { console.warn('[MAERS.Nav] 导航读取失败：', error); }
}
