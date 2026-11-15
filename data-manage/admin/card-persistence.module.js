/** 首页与门户卡片持久化：页面创建、列表保存及保存后的关联页面删除。 */
import { requestText } from "./admin-confirm.module.js";

import { localFetch } from '../api-client.module.js';
import { Feedback } from './admin-base.module.js';

export async function readCardList(source) {
    const response = await localFetch(source, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`读取卡片失败（HTTP ${response.status}）`);
    const items = await response.json();
    if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error('卡片数据格式无效');
    }
    return items;
}

export function isLocalPage(url) {
    return typeof url === 'string' && url.endsWith('.html') && !url.startsWith('http') && !url.includes('/');
}

export async function ensureCardPage(url, title) {
    if (!isLocalPage(url)) return null;
    const response = await localFetch('/api/ensure_page', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: url, title })
    });
    if (!response.ok) throw new Error(`HTML 页面创建失败（HTTP ${response.status}）`);
    const result = await response.json();
    if (result.success === false || result.status === 'error') throw new Error('HTML 页面创建失败');
    if (result.status === 'created') Feedback.notifySuccess('HTML文件创建成功');
    if (result.status === 'exists') Feedback.toast('HTML文件已存在', 'info');
}

async function persistCardList(endpoint, items) {
    const body = JSON.stringify(items);
    const response = await localFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body
    });
    if (!response.ok) throw new Error(`保存失败（HTTP ${response.status}）`);
    return JSON.parse(body);
}

/** 新增即时写入，已标记删除的旧卡片留到批量保存时确认。 */
export async function appendSavedCard(endpoint, items, added) {
    const saved = await persistCardList(endpoint, [...items, added].map(({ _deleted, ...item }) => item));
    items.push(added);
    return saved;
}

/** 界面刷新失败单独提示，已经落盘的操作仍视为成功。 */
export function refreshSavedCards(refresh, notifySuccess) {
    try {
        refresh();
    } catch (error) {
        console.warn('[MAERS.Admin] 卡片列表保存后刷新失败:', error);
        Feedback.toast('列表已保存，请手动刷新页面', 'warning');
        return;
    }
    notifySuccess();
}

async function confirmPageDeletions(items, label) {
    const confirmed = [];
    for (const item of items) {
        if (!isLocalPage(item.url)) continue;
        const name = await requestText({
            title: '同时删除页面文件：' + item.url,
            value: '', confirmText: '删除页面文件', cancelText: '只移除入口'
        });
        if (name === item.url) confirmed.push(item.url);
        else if (name !== null) Feedback.notifyError('文件名不匹配，文件未删除。');
    }
    return confirmed;
}

async function deleteConfirmedPages(pages) {
    for (const filename of pages) {
        try {
            const response = await localFetch('/api/delete_page', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            Feedback.notifySuccess('HTML文件已同步删除');
        } catch (error) {
            console.error('[MAERS.Admin] 页面删除失败:', error);
            Feedback.notifyError(`列表已保存，但文件删除失败: ${filename}`);
        }
    }
}

export async function saveCardChanges(endpoint, items, label) {
    const kept = items.filter(item => !item._deleted);
    const pages = confirmPageDeletions(items.filter(item => item._deleted), label);
    // 列表保存失败时不触碰物理页面，避免旧卡片仍在而页面已经被删。
    await persistCardList(endpoint, kept);
    await deleteConfirmedPages(pages);
    return kept;
}
