/**
 * MAERS Secret Unlock Module (secret-unlock.module.js)
 * 职责：线上（访客页）的隐藏解锁入口 + 加密记录的内存还原
 *
 * 设计要点：
 * 1. 入口完全隐藏：页面上没有任何按钮或提示，只有知道手势的人才能唤出密码框。
 * 2. 只读还原：解密仅发生在浏览器内存中，不写回任何数据；
 *    还原后的记录与公开数据结构一致，因此沿用各模块原有的渲染与交互。
 * 3. 会话级有效：密钥存于 sessionStorage，关闭标签页即失效；再次触发手势可主动锁回。
 * 4. Admin 页面一律不还原：否则保存时会把明文写回仓库。
 *
 * 对外接口：
 * - initSecretUnlock()               安装隐藏触发手势（由 layout 统一调用）
 * - revealInPlace(list, options)     将列表中的密文记录原地解密为普通记录
 * - pageGuardHash(url)               页面守卫哈希（首页卡片加锁时写入 _guard）
 * - guardCurrentPage()               未解锁访客直接访问被守卫的页面时显示 404
 */

import { getSessionKey, getSessionKeysRaw, isEncryptedRecord, unwrapRecord, sha256Hex } from './crypto.module.js';

// ══════════════════════════════════════════════
// 0. 触发手势配置（需要改手势时只改这里）
// ══════════════════════════════════════════════

/** 鼠标和触屏统一长按 Logo 1.5 秒。 */
const HOLD_MS = 1500;
const LOGO = '[data-logo-unlock]';

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

    if (!Object.keys(getSessionKeysRaw()).length) return 0;

    const stats = { ok: 0, fail: 0 };
    await _walk(list, options.getChildren || null, options.transform || null, stats);

    if (stats.fail > 0) {
        console.warn(`[SecretUnlock] ${stats.fail} 条记录无法解密（密钥不匹配或数据损坏）`);
    }
    return stats.ok;
}

async function _walk(list, getChildren, transform, stats, privateParent = false) {
    for (let i = 0; i < list.length; i++) {
        if (isEncryptedRecord(list[i])) {
            const group = list[i]._group || 'default';
            const scoped = await getSessionKey(group);
            if (!scoped) continue;
            const plain = await unwrapRecord(list[i], scoped);
            if (!plain) { stats.fail++; continue; }
            list[i] = transform ? await transform(plain, group) : plain;
            if (list[i] && typeof list[i] === 'object') { list[i]._private = true; list[i]._private_group = group; }
            stats.ok++;
        }
        if (privateParent && list[i] && typeof list[i] === 'object') list[i]._private = true;
        const kids = getChildren ? getChildren(list[i]) : undefined;
        if (Array.isArray(kids)) {
            await _walk(kids, getChildren, transform, stats, list[i]._private === true);
        }
    }
}

// ══════════════════════════════════════════════
// 3. 隐藏触发入口
// ══════════════════════════════════════════════

let _installed = false;
let _jumpPromptOpen = false;

async function _openVisitorUnlock(openFormModal) {
    const abort = new AbortController();
    const cancelled = new Promise(resolve => {
        abort.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    const loading = openFormModal({
        icon: 'password-group', title: '输入密码', focusDialog: true,
        bodyHtml: '<div class="mlock-sub" role="status">加载中...</div>',
        confirmText: '解锁', cancelText: '关闭', onCancel: () => abort.abort()
    });
    loading.el.querySelector('.mlock-box').classList.add('mlock-box--settings');
    loading.el.querySelector('[data-act="ok"]').disabled = true;

    let prepared;
    try {
        prepared = await Promise.race([
            Promise.all([
                import('./group-unlock.module.js'),
                import('./keyring.module.js').then(({ loadKeyring }) =>
                    loadKeyring(true, { signal: abort.signal }))
            ]),
            cancelled
        ]);
    } finally {
        abort.abort();
        loading.close();
    }
    if (!prepared) return;
    const [{ openGroupUnlock }, keyring] = prepared;
    if (keyring) return openGroupUnlock({ keyring, onMaster: () => window.location.reload() });

    const { Toast } = await import('../../shared/toast.module.js');
    Toast.info('无法读取密码配置，请检查网络或确认主密码已发布');
}

async function _trigger() {
    if (_isAdminPage() || _jumpPromptOpen) return;
    _jumpPromptOpen = true;
    try {
        const { openFormModal } = await import('./lock-dialog.module.js');
        const confirmed = await new Promise(resolve => openFormModal({
            title: '是否跳转后台？',
            confirmText: '是', cancelText: '', focusDialog: true,
            alternate: { text: '否', onClick: () => resolve(false) },
            onSubmit: () => { resolve(true); return true; },
            onCancel: () => resolve(null)
        }));
        if (confirmed === null) return;
        if (confirmed) {
            window.location.href = '/admin-portal';
            return;
        }
        await _openVisitorUnlock(openFormModal);
    } catch (error) {
        console.error('[SecretUnlock] 无法打开密码入口', error);
        const { Toast } = await import('../../shared/toast.module.js');
        Toast.error('无法打开密码入口，请刷新后重试');
    } finally {
        _jumpPromptOpen = false;
    }
}

/**
 * 安装隐藏触发手势（幂等）
 */
export function initSecretUnlock() {
    if (_installed || _isAdminPage() || /admin/i.test(window.location.pathname)) return;
    _installed = true;
    let press = null;
    let consumed = null;
    const cancel = () => { clearTimeout(press?.timer); press = null; };
    document.addEventListener('pointerdown', event => {
        const holding = Boolean(press);
        cancel();
        if (event.isPrimary) consumed = null;
        const target = event.target.closest?.(LOGO);
        if (holding || !target || !event.isPrimary || event.button !== 0) return;
        press = { id: event.pointerId, x: event.clientX, y: event.clientY, target };
        press.timer = setTimeout(() => {
            const visible = target.isConnected && !document.hidden;
            cancel();
            if (visible) {
                consumed = target;
                void _trigger();
            }
        }, HOLD_MS);
    }, { passive: true, capture: true });
    document.addEventListener('pointermove', event => {
        if (press && event.pointerId === press.id &&
            (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10 || !press.target.contains(event.target))) cancel();
    }, { passive: true });
    document.addEventListener('pointerleave', event => {
        if (event.target === press?.target) cancel();
    }, { passive: true, capture: true });
    for (const type of ['pointerup', 'pointercancel', 'scroll']) {
        document.addEventListener(type, cancel, { passive: true, capture: true });
    }
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', cancel);
    document.addEventListener('contextmenu', event => {
        if (event.target.closest?.(LOGO)) event.preventDefault();
    });
    // 长按后的松手不触发首页缩放或导航栏的返回首页。
    document.addEventListener('click', event => {
        if (consumed && consumed.contains(event.target)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            consumed = null;
        }
    }, true);
}

// ══════════════════════════════════════════════
// 4. 页面守卫（首页卡片加锁后，其目标页面对未解锁访客显示 404）
// ══════════════════════════════════════════════

const GUARD_TIMEOUT_MS = 2000;

/** 统一页面名：去掉目录、查询串与 .html 后缀（兼容 cleanUrls） */
function _pageName(url) {
    if (/(?:^|\/)photos\/[^/?#]+\/?(?:[?#]|$)/.test(String(url || ''))) return 'photos';
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
        const res = await fetch('data/index-cards.json', { cache: 'no-cache', signal: abort.signal });
        const cards = res.ok ? await res.json() : [];
        const guards = (Array.isArray(cards) ? cards : []).map(c => c?._guard).filter(Boolean);
        const hash = await pageGuardHash(name);
        const matching = cards.filter(card => card?._guard === hash);
        if (guards.includes(hash)) {
            const allowed = await Promise.all(matching.map(async card => {
                const key = await getSessionKey(card._group || 'default');
                return key ? await unwrapRecord(card, key) : null;
            }));
            if (!allowed.some(Boolean)) _blockPage();
        }
    } catch { /* 保持原有网络异常与超时放行行为。 */ }
    finally {
        clearTimeout(timer);
        document.dispatchEvent(new Event('maers:page-guard-ready'));
    }
}
