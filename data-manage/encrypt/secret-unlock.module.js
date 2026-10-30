/**
 * MAERS Secret Unlock Module (secret-unlock.module.js)
 * 职责：访客页已授权会话的加密记录内存还原与页面守卫
 *
 * 设计要点：
 * 1. 只读还原：解密仅发生在浏览器内存中，不写回任何数据；
 *    还原后的记录与公开数据结构一致，因此沿用各模块原有的渲染与交互。
 * 2. 会话级有效：密钥存于 sessionStorage，关闭标签页即失效。
 * 3. Admin 页面一律不还原：否则保存时会把明文写回仓库。
 *
 * 对外接口：
 * - revealInPlace(list, options)     将列表中的密文记录原地解密为普通记录
 * - pageGuardHash(url)               页面守卫哈希（首页卡片加锁时写入 _guard）
 * - guardCurrentPage()               未解锁访客直接访问被守卫的页面时显示 404
 */

import { getSessionKey, isEncryptedRecord, unwrapRecord, sha256Hex } from './crypto.module.js';

// ══════════════════════════════════════════════
// 1. 工具
// ══════════════════════════════════════════════

/** 是否为 Admin 页面（与 CMS 的 IS_ADMIN 判定保持一致） */
function _isAdminPage() {
    return window.IS_ADMIN === true ||
        new URLSearchParams(window.location.search).get('mode') === 'admin';
}

// ══════════════════════════════════════════════
// 2. 内存还原
// ══════════════════════════════════════════════

/**
 * 递归遍历列表，把密文记录原地替换为解密后的记录
 * - 没有会话密钥 / Admin 页面：什么都不做，返回 0
 * - 主密码在解锁时已校验，此处失败只可能是数据属于另一把密钥或已损坏，仅提示不清除会话
 *
 * @param {Array} list - 待还原列表（原地修改）
 * @param {Object} [options]
 * @param {(record:Object)=>Array|undefined} [options.getChildren] - 获取子列表，无子层返回 undefined
 * @param {(plain:Object)=>Object} [options.transform] - 解密后的结构转换（默认原样）
 * @returns {Promise<number>} 成功还原数量
 */
export async function revealInPlace(list, options = {}) {
    if (!Array.isArray(list) || _isAdminPage()) return 0;

    const key = await getSessionKey();
    if (!key) return 0;

    const stats = { ok: 0, fail: 0 };
    await _walk(list, key, options.getChildren || null, options.transform || null, stats);

    if (stats.fail > 0) {
        console.warn(`[SecretUnlock] ${stats.fail} 条记录无法解密（密钥不匹配或数据损坏）`);
    }
    return stats.ok;
}

async function _walk(list, key, getChildren, transform, stats, privateParent = false) {
    for (let i = 0; i < list.length; i++) {
        if (isEncryptedRecord(list[i])) {
            const plain = await unwrapRecord(list[i], key);
            if (!plain) { stats.fail++; continue; }
            list[i] = transform ? transform(plain) : plain;
            if (list[i] && typeof list[i] === 'object') list[i]._private = true;
            stats.ok++;
        }
        if (privateParent && list[i] && typeof list[i] === 'object') list[i]._private = true;
        const kids = getChildren ? getChildren(list[i]) : undefined;
        if (Array.isArray(kids)) {
            await _walk(kids, key, getChildren, transform, stats, list[i]._private === true);
        }
    }
}

// ══════════════════════════════════════════════
// 3. 页面守卫（首页卡片加锁后，其目标页面对未解锁访客显示 404）
// ══════════════════════════════════════════════

const GUARD_TIMEOUT_MS = 2000;

/** 统一页面名：去掉目录、查询串与 .html 后缀（兼容 cleanUrls） */
function _pageName(url) {
    const file = String(url || '').split(/[?#]/)[0].split('/').pop() || 'index';
    return file.replace(/\.html?$/i, '').toLowerCase();
}

/** 页面守卫哈希：只暴露哈希，不暴露卡片内容 */
export function pageGuardHash(url) {
    return sha256Hex('maers-guard|' + _pageName(url));
}

function _blockPage() {
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', _blockPage, { once: true });
        return;
    }
    document.title = '404';
    const style = document.createElement('style');
    style.textContent = 'body > *:not(#maers-404){display:none!important}' +
        '#maers-404{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
        'font:600 18px/1.6 system-ui,sans-serif;color:#888;background:inherit}';
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = 'maers-404';
    box.textContent = '404 · Page Not Found';
    document.body.appendChild(box);
}

/**
 * 未解锁访客直接访问被守卫的页面时显示 404
 * 检查期间沿用首屏开关，避免显示后再次隐藏；网络异常或超时则放行
 */
let _pageGuardRequest = null;
export function guardCurrentPage() {
    if (!_pageGuardRequest) _pageGuardRequest = _guardCurrentPage();
    return _pageGuardRequest;
}

async function _guardCurrentPage() {
    if (_isAdminPage() || /admin/i.test(window.location.pathname)) return;
    const name = _pageName(window.location.pathname);
    if (name === 'index' || name === '') return;

    // 在第一次 await 前通知首屏开关，避免页面已经显示后又整页隐藏。
    document.dispatchEvent(new Event('maers:page-guard-start'));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), GUARD_TIMEOUT_MS);
    try {
        if (await getSessionKey()) return;
        const res = await fetch('data/index-cards.json', { cache: 'no-cache', signal: abort.signal });
        const cards = res.ok ? await res.json() : [];
        const guards = (Array.isArray(cards) ? cards : []).map(c => c?._guard).filter(Boolean);
        if (guards.length && guards.includes(await pageGuardHash(name))) _blockPage();
    } catch { /* 保持原有网络异常与超时放行行为。 */ }
    finally {
        clearTimeout(timer);
        document.dispatchEvent(new Event('maers:page-guard-ready'));
    }
}
