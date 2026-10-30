/**
 * MAERS Admin Lock Module (admin-lock.module.js)
 * 职责：加解密业务门面与管理控件；密码验证委托 auth-flow，后台会话委托 admin-session。
 *
 * 对外接口：
 * - ensureUnlocked() → 若无会话密钥则弹出密码框（首次使用时引导设置主密码），返回 CryptoKey | null
 * - lockRecord(record) → 加密整条记录，返回 { _enc: "enc:..." } | null
 * - unlockRecord(encRecord) → 解密记录，返回原始对象 | null
 * - openFormModal / showRecoveryCodeModal / validateNewPassword → 供加密设置面板复用
 */
import { localFetch } from '../api-client.module.js';

import {
    getSessionKey,
    clearSessionKey,
    wrapRecord,
    unwrapRecord,
    fingerprintRecord
} from './crypto.module.js';
import { ensureUnlocked, canWriteKeyring, invalidateUnlockFlow } from './auth-flow.module.js';
export { ensureUnlocked, canWriteKeyring, validateNewPassword, recoverWithCodeFlow } from './auth-flow.module.js';

import { escapeHtml, cryptoIconHtml, openProgress, injectLockStyles as _injectLockStyles } from './lock-dialog.module.js';
export { openProgress } from './lock-dialog.module.js';
export { escapeHtml, cryptoIconHtml, openFormModal, showRecoveryCodeModal } from './lock-dialog.module.js';
export { cancelProtection, protectCmsNode } from './admin-session.module.js';
import { cancelProtection, cancelSourceEncryption } from './admin-session.module.js';

import { Toast } from '../../shared/toast.module.js';
import { cmsMediaReferences } from './private-media.module.js';

/**
 * 统一配置卡片上的加锁/开锁操作按钮
 * 本地管理环境下正常绑定交互；非本地环境置灰并拦截点击，提示仅本地可用
 * @param {HTMLElement} btn - 按钮 DOM
 * @param {Object} options
 * @param {boolean} [options.isLocked] - 是否已加密
 * @param {string} [options.title] - 本地正常情况下的 title 提示
 * @param {Function} [options.onClick] - 本地正常情况下的点击处理函数
 */
export function setupLockActionButton(btn, { isLocked = false, title = '', onClick = null } = {}) {
    if (!btn) return;
    btn.innerHTML = cryptoIconHtml(isLocked ? 'decryption' : 'encryption');
    if (canWriteKeyring()) {
        btn.classList.remove('maers-admin-btn--disabled');
        btn.removeAttribute('aria-disabled');
        if (title) btn.title = title;
        if (onClick) btn.onclick = onClick;
    } else {
        btn.classList.add('maers-admin-btn--disabled');
        btn.setAttribute('aria-disabled', 'true');
        btn.title = '加密功能仅支持在本地桌面端管理';
        btn.onclick = (e) => {
            e.stopPropagation();
            Toast.warning('加密功能仅支持在本地桌面端管理');
        };
    }
}

/**
 * 加锁：将普通记录加密为 { _enc: "enc:..." }
 * @param {Object} record - 原始记录
 * @returns {Promise<Object|null>} 取消则 null
 */
export async function lockRecord(record) {
    if (record?._private_id) return cancelProtection(record);
    if (record?._private) { Toast.info('该内容随上级对外加密，后台可正常编辑'); return null; }
    const key = await ensureUnlocked();
    if (!key) return null;
    return wrapRecord(record, key);
}

/**
 * 解锁：将加密记录解密为原始对象
 * 主密码在解锁时已校验，此处失败只可能是数据损坏或属于另一把密钥
 * @param {Object} encRecord - { _enc: "enc:..." }
 * @returns {Promise<Object|null>}
 */
export async function unlockRecord(encRecord) {
    if (encRecord?._private_id) return cancelProtection(encRecord);
    const key = await ensureUnlocked();
    if (!key) return null;

    const result = await unwrapRecord(encRecord, key);
    if (!result) {
        Toast.error('❌ 解密失败：数据损坏，或不是用当前密钥加密的');
    }
    return result;
}

/** 打开加密设置面板（保留旧名称以兼容调用方） */
export async function showWorkerTokenHashDialog() {
    if (!canWriteKeyring()) return;
    const { openCryptoSettings } = await import('./crypto-settings.module.js');
    openCryptoSettings();
}

/** 主动清除会话密钥（用于退出加密会话按钮） */
export async function logoutSession() {
    invalidateUnlockFlow();
    await (await import('./admin-session.module.js')).closeAdminSession();
    clearSessionKey();
    window.location.reload?.();
    Toast.success('已清除解锁状态');
}

// ══════════════════════════════════════════════
// 1.5 一键解锁全部（共用浮动按钮）
// ══════════════════════════════════════════════

let _unlockAllHandlers = null;
let _unlockAllBusy = false;
let _unlockAllExpanded = false;

/**
 * 挂载「解锁全部」浮动按钮。每个页面只应由一个模块注册。
 * @param {Object} handlers
 * @param {() => number} handlers.getCount - 返回当前页面加密记录数量
 * @param {() => Promise<number>} handlers.onUnlockAll - 执行解锁，返回成功解锁数量
 */
export function mountUnlockAllButton(handlers) {
    _unlockAllHandlers = handlers;
    _injectLockStyles();
    mountCryptoSettingsButton();
    refreshUnlockAllButton();
}

/** 按需创建浮动控件容器，供首页设置与模块批量操作分别使用。 */
function _ensureCryptoControls() {
    let controls = document.getElementById('maers-crypto-controls');
    if (!controls) {
        controls = document.createElement('div');
        controls.id = 'maers-crypto-controls';
        controls.className = 'mlock-crypto-controls';
        document.body.appendChild(controls);
    }
    return controls;
}

/** 加密设置入口（左下角小图标，仅后台首页） */
export function mountCryptoSettingsButton() {
    if (!document.documentElement.classList.contains('admin-portal-page')) return;
    if (document.getElementById('maers-crypto-settings-btn')) return;
    _injectLockStyles();
    const canLock = canWriteKeyring();
    const btn = document.createElement('button');
    btn.id = 'maers-crypto-settings-btn';
    btn.className = 'mlock-settings-btn' + (canLock ? '' : ' mlock-settings-btn--disabled');
    btn.title = canLock ? '加密设置（主密码 / 恢复码 / 私密图片）' : '加密设置（仅支持本地桌面端管理）';
    btn.type = 'button';
    btn.setAttribute('aria-label', '加密设置');
    btn.innerHTML = cryptoIconHtml('secret-key', 22);
    btn.onclick = async () => {
        if (!canLock) {
            Toast.warning('加密设置仅支持在本地桌面端管理');
            return;
        }
        const { openCryptoSettings } = await import('./crypto-settings.module.js');
        openCryptoSettings();
    };
    const controls = _ensureCryptoControls();
    controls.classList.toggle('mlock-crypto-controls--disabled', !canLock);
    controls.appendChild(btn);
}

/** 根据当前加密记录数量刷新按钮显示（各模块在渲染后调用） */
export function refreshUnlockAllButton() {
    if (!_unlockAllHandlers) return;

    let count = 0;
    try { count = _unlockAllHandlers.getCount() || 0; } catch { count = 0; }

    let btn = document.getElementById('maers-unlock-all-btn');
    let toggle = document.getElementById('maers-unlock-all-toggle');
    let panel = document.getElementById('maers-unlock-all-panel');
    let controls = document.getElementById('maers-crypto-controls');
    if (count <= 0 || !canWriteKeyring()) {
        if (btn) btn.remove();
        if (toggle) toggle.remove();
        if (panel) panel.remove();
        controls?.classList.remove('mlock-crypto-controls--actions');
        if (controls && !document.getElementById('maers-crypto-settings-btn')) controls.remove();
        _unlockAllExpanded = false;
        return;
    }

    controls = controls || _ensureCryptoControls();
    controls.classList.add('mlock-crypto-controls--actions');
    if (!toggle) {
        toggle = document.createElement('button');
        toggle.id = 'maers-unlock-all-toggle';
        toggle.type = 'button';
        toggle.className = 'mlock-unlock-toggle';
        toggle.setAttribute('aria-controls', 'maers-unlock-all-btn');
        toggle.onclick = () => {
            _unlockAllExpanded = !_unlockAllExpanded;
            refreshUnlockAllButton();
        };
        controls.appendChild(toggle);
    }
    toggle.title = _unlockAllExpanded ? '收起取消加密操作' : '展开取消加密操作';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-expanded', String(_unlockAllExpanded));

    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'maers-unlock-all-panel';
        panel.className = 'mlock-unlock-panel';
        controls.insertBefore(panel, toggle);
    }
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'maers-unlock-all-btn';
        btn.type = 'button';
        btn.className = 'mlock-unlock-all';
        btn.onclick = _runUnlockAll;
        panel.appendChild(btn);
    }
    btn.textContent = `取消全部加密 (${count})`;
    btn.title = '将当前模块的加密记录转回明文，用于恢复公开';
    btn.disabled = _unlockAllBusy || !_unlockAllExpanded;
    panel.inert = !_unlockAllExpanded;
    panel.setAttribute('aria-hidden', String(!_unlockAllExpanded));
    panel.classList.toggle('is-expanded', _unlockAllExpanded);
    panel.style.width = _unlockAllExpanded ? `${btn.offsetWidth}px` : '0px';
}

async function _runUnlockAll() {
    if (_unlockAllBusy || !_unlockAllHandlers) return;
    const total = _unlockAllHandlers.getCount();
    if (!confirm(`确定取消当前模块全部 ${total} 项记录的加密吗？\n\n这会将记录转回明文，用于恢复公开；不是临时查看。`)) return;

    _unlockAllBusy = true;
    refreshUnlockAllButton();
    try {
        const done = _unlockAllHandlers.source
            ? await cancelSourceEncryption(_unlockAllHandlers.source)
            : await _unlockAllHandlers.onUnlockAll();
        if (done > 0) Toast.success(`已处理 ${done} 项取消加密操作`);
        if (done > 0 && _unlockAllHandlers.source) window.location.reload();
    } catch (e) {
        Toast.error('取消加密失败: ' + e.message);
    } finally {
        _unlockAllBusy = false;
        refreshUnlockAllButton();
    }
}

/**
 * 通用递归解锁：遍历列表，将加密记录原地替换为明文记录，并继续深入子层级
 * 一旦解密失败（密码错误/取消）立即中止，已解锁的部分保留
 * @param {Array} list - 待处理列表（原地修改）
 * @param {(record:Object)=>Array|undefined} getChildren - 获取子列表的函数，无子层返回 undefined
 * @param {(record:Object)=>boolean} isEnc - 判断是否为加密记录
 * @returns {Promise<number>} 成功解锁数量
 */
export async function unlockListDeep(list, getChildren, isEnc) {
    let count = 0;
    if (!Array.isArray(list)) return count;

    for (let i = 0; i < list.length; i++) {
        if (isEnc(list[i])) {
            const original = await unlockRecord(list[i]);
            if (!original) return count; // 失败即中止
            list[i] = original;
            count++;
        }
        const kids = getChildren ? getChildren(list[i]) : undefined;
        if (Array.isArray(kids)) {
            count += await unlockListDeep(kids, getChildren, isEnc);
        }
    }
    return count;
}

/**
 * 深度统计加密记录数量
 */
export function countEncryptedDeep(list, getChildren, isEnc) {
    let n = 0;
    if (!Array.isArray(list)) return n;
    for (const item of list) {
        if (isEnc(item) || item?._private_id) { n++; continue; } // 加密记录内部不可见，只计一项
        const kids = getChildren ? getChildren(item) : undefined;
        if (Array.isArray(kids)) n += countEncryptedDeep(kids, getChildren, isEnc);
    }
    return n;
}

// ══════════════════════════════════════════════
// 1.8 跨模块业务加解锁与锁定占位卡片渲染
// ══════════════════════════════════════════════

/**
 * 统一渲染加密记录的锁定占位卡片 / 列表项
 * @param {Object} opts
 * @param {string} [opts.className='locked-card'] - 卡片类名
 * @param {string} [opts.label='私密内容'] - 提示文案
 * @param {'card'|'cms'|'list'} [opts.variant='card'] - 渲染变体
 * @param {Object} [opts.dataset] - 附加 data-* 属性
 * @param {Function} [opts.onUnlock] - 点击解锁回调
 * @param {Function} [opts.onDelete] - 点击内置删除按钮回调（无 deleteEl 时生效）
 * @param {HTMLElement} [opts.deleteEl] - 外部传入的自定义删除按钮组元素
 * @returns {HTMLElement}
 */
export function renderLockedCard(opts = {}) {
    const {
        className = 'locked-card',
        label = '私密内容',
        variant = 'card',
        dataset = {},
        onUnlock,
        onDelete,
        deleteEl
    } = opts;

    const el = document.createElement('div');
    el.className = variant === 'list' ? 'list-item locked-item' : className;
    Object.entries(dataset).forEach(([k, v]) => { el.dataset[k] = v; });

    if (variant === 'list') {
        el.style.cssText = 'opacity:0.6; cursor:pointer; border-left: 2px solid rgba(100,150,255,0.4);';
        el.title = '取消此项加密';
        el.innerHTML = `<span style="flex:1; font-size:13px; color:var(--text-sub,#888);">${cryptoIconHtml('encryption')} ${escapeHtml(label)}</span>`;
        if (onUnlock) el.onclick = onUnlock;
        if (deleteEl) {
            const w = document.createElement('div');
            w.className = 'item-actions';
            w.appendChild(deleteEl);
            el.appendChild(w);
        }
        return el;
    }

    if (variant === 'cms') {
        el.title = '取消此项加密';
        el.innerHTML = `
            <div class="locked-card__icon">${cryptoIconHtml('encryption', 32)}</div>
            <div class="locked-card__label">${escapeHtml(label)}</div>
            <div class="locked-card__hint">取消加密</div>
        `;
        if (onUnlock) {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                onUnlock(e);
            });
        }
        if (onDelete) {
            const delBtn = document.createElement('span');
            delBtn.className = 'maers-admin-btn locked-card__delete';
            delBtn.title = '删除此加密内容';
            delBtn.textContent = '✕';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                onDelete(e);
            });
            el.appendChild(delBtn);
        }
        return el;
    }

    // 默认卡片变体 (Album / Index / Space)
    el.style.cssText = `
        position: relative;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        gap: 8px; cursor: pointer;
        border: 1.5px dashed rgba(100, 150, 255, 0.35);
        background: rgba(100, 150, 255, 0.04);
    `;
    el.innerHTML = `
        <div style="font-size:2rem; opacity:0.6;">${cryptoIconHtml('encryption', 32)}</div>
        <div style="font-size:12px; font-weight:600; color:var(--text-sub,#888);">${escapeHtml(label)}</div>
        <div style="font-size:11px; color:var(--text-sub,#666);">取消加密</div>
    `;
    if (onUnlock) el.onclick = onUnlock;

    if (deleteEl) {
        el.appendChild(deleteEl);
    } else if (onDelete) {
        const delContainer = document.createElement('div');
        delContainer.className = 'maers-admin-action-group nav-card-actions';
        delContainer.style.cssText = 'position:absolute; top:8px; right:8px;';
        const delBtn = document.createElement('span');
        delBtn.className = 'maers-admin-btn';
        delBtn.title = '删除此加密记录';
        delBtn.textContent = '✕';
        delBtn.onclick = (e) => { e.stopPropagation(); onDelete(e); };
        delContainer.appendChild(delBtn);
        el.appendChild(delContainer);
    }
    return el;
}

/**
 * 首页导航卡片加锁：加密记录并为站内 HTML 页面自动附加 _guard 路由守卫哈希
 * @param {Object} original - 原始卡片对象
 * @returns {Promise<Object|null>}
 */
export async function lockIndexCardRecord(original) {
    if (!original) return null;
    if (original._private_id) return cancelProtection(original);
    const encRecord = await lockRecord(original);
    if (!encRecord) return null;

    if (original.url && /^[^/:?#]+\.html?$/i.test(original.url)) {
        const { pageGuardHash } = await import('./secret-unlock.module.js');
        encRecord._guard = await pageGuardHash(original.url);
    }
    return encRecord;
}

async function _postAlbumJson(url, body) {
    const res = await localFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false || data.error) throw new Error(data.error || data.msg || `HTTP ${res.status}`);
    return data;
}

async function _runAlbumJob(url, body, label, icon) {
    const progress = openProgress(label, icon);
    try {
        const start = await _postAlbumJson(url, body);
        progress.update(0, start.total);
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 800));
            const job = await _postAlbumJson('/api/album/job', { id: start.job });
            progress.update(job.done, job.total);
            if (job.state === 'success') return job.result;
            if (job.state === 'error') throw new Error(job.result?.error || '任务失败');
        }
        throw new Error('等待迁移结果超时，后台任务可能仍在运行，请确认状态后再操作');
    } finally {
        progress.close();
    }
}

/**
 * 相册分类加锁完整流程：导出分类 -> 前端加密 -> 服务端迁移至私有桶 -> 同步 Worker 令牌
 * @param {string} categoryId - 相册分类 ID
 * @returns {Promise<boolean>}
 */
const _albumMigrations = new Map();
function runAlbumMigration(key, action) {
    if (_albumMigrations.has(key)) return _albumMigrations.get(key);
    const pending = action().finally(() => _albumMigrations.delete(key));
    _albumMigrations.set(key, pending);
    return pending;
}
export function lockAlbumCategoryFlow(categoryId) {
    return runAlbumMigration(categoryId, () => _lockAlbumCategory(categoryId));
}
async function _lockAlbumCategory(categoryId) {
    const exp = await _postAlbumJson('/api/album/export_category', { id: categoryId });
    const payload = { category: exp.category, photos: exp.photos, tags_file: exp.tags_file };
    const enc = await lockRecord(payload);
    if (!enc) return false;

    await _runAlbumJob('/api/album/lock_category', { id: categoryId, enc: enc._enc, expected_revision: exp.revision }, '迁入私有存储', 'encryption');
    Toast.success('相册已加密并迁入私有桶');

    const { syncTokenToWorker } = await import('./crypto-settings.module.js');
    await syncTokenToWorker({ silent: true });
    return true;
}

/**
 * 相册分类解锁完整流程：前端解密载荷 -> 服务端迁回公开桶与仓库
 * @param {Object} encRecord - 加密相册分类条目
 * @returns {Promise<boolean>}
 */
export function unlockAlbumCategoryFlow(encRecord) {
    return runAlbumMigration(encRecord.id || encRecord._enc, () => _unlockAlbumCategory(encRecord));
}
async function _unlockAlbumCategory(encRecord) {
    const payload = await unlockRecord(encRecord);
    if (!payload) return false;
    if (!payload.category || !Array.isArray(payload.photos)) {
        Toast.error('加密载荷格式不正确（可能是旧版仅加密配置的记录）');
        return false;
    }
    await _runAlbumJob('/api/album/unlock_category', { enc: encRecord._enc, payload }, '迁回公开存储', 'decryption');
    Toast.success('相册已恢复公开');
    return true;
}

/** 读取公开图片索引（原图路径 -> 图片行），用于把 CMS 封面行打包进密文 */
async function _loadCmsCoverIndex() {
    const map = new Map();
    try {
        const res = await fetch('data/photos-data.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error(`读取封面索引失败 (${res.status})`);
        const data = await res.json();
        Object.entries(data || {}).forEach(([category, rows]) => {
            (Array.isArray(rows) ? rows : []).forEach(r => {
                if (r?.path) [r.path, r.thumb, r.preview].filter(Boolean)
                    .forEach(path => map.set(path, { ...r, category }));
            });
        });
    } catch (error) { throw new Error('无法读取封面索引，已停止加密以避免遗漏公开图片迁移: ' + error.message); }
    return map;
}

/** 递归打包 CMS 节点子树（包含 .md 正文与封面行） */
async function _packCmsNode(node, getIndex, lockedNodes = []) {
    if (node._enc) return { id: node.id, type: 'locked', _enc: node._enc };
    const cover = node._origCover ?? node.coverImage ?? null;
    const packed = {
        id: node.id,
        type: node.type,
        title: node.title,
        tags: node.tags || [],
        coverImage: cover
    };
    let coverKey = typeof cover === 'string' ? cover : null;
    if (coverKey && /^https?:\/\//i.test(coverKey)) {
        coverKey = decodeURIComponent(new URL(coverKey).pathname).replace(/^\/+/, '');
        const media = coverKey.match(/(?:^|\/)(photos\/(?:images|previews|thumbnails)\/.*)$/);
        if (media) coverKey = media[1];
    }
    const coverRow = node._coverRow || (coverKey && /^(photos|images)\//.test(coverKey)
        ? (await getIndex()).get(coverKey) : null);
    if (coverRow) packed.coverRow = coverRow;
    else if (coverKey && /^(photos|images)\//.test(coverKey)) throw new Error('封面不在图片索引中，无法迁入私有桶: ' + coverKey);

    if (node._draftContent !== undefined) {
        packed.md = String(node._draftContent ?? '');
    } else if (typeof node._rawMd === 'string') {
        packed.md = node._rawMd;
    } else if (typeof node.content === 'string' && node.content.endsWith('.md')) {
        if (node._pendingRelay) {
            packed.md = '';
        } else {
            const res = await (node._private ? localFetch : fetch)('data/' + node.content.split('/').map(encodeURIComponent).join('/'), { cache: 'no-cache' });
            if (!res.ok) throw new Error(`读取正文失败: ${node.content} (${res.status})`);
            packed.md = await res.text();
        }
    } else if (typeof node.content === 'string') {
        packed.md = node.content;
    }

    const references = cmsMediaReferences(packed.md);
    if (references.length) {
        const index = node._mediaRows ? new Map(node._mediaRows.flatMap(row =>
            [row.path, row.thumb, row.preview].filter(Boolean).map(path => [path, row]))) : await getIndex();
        const rows = new Map();
        for (const { key } of references) {
            const row = index.get(key);
            if (!row) throw new Error('正文图片不在图片索引中，已停止加密: ' + key);
            rows.set(row.path, row);
        }
        packed.mediaRows = [...rows.values()];
    }

    if (Array.isArray(node.children)) {
        packed.children = [];
        for (const child of node.children) {
            packed.children.push(await _packCmsNode(child, getIndex, lockedNodes));
        }
        (lockedNodes || [])
            .filter(n => n.parentId === node.id)
            .sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))
            .forEach(n => {
                const item = { id: n.id, type: 'locked', _enc: n._enc };
                const at = Math.min(n.index ?? packed.children.length, packed.children.length);
                packed.children.splice(at, 0, item);
            });
    }
    return packed;
}

function _collectCmsCoverPaths(packed, out = []) {
    if (!packed || packed._enc) return out;
    if (packed.coverRow?.path) out.push(packed.coverRow.path);
    (packed.mediaRows || []).forEach(row => out.push(row.path));
    (packed.children || []).forEach(c => _collectCmsCoverPaths(c, out));
    return out;
}

function _collectCmsCoverKeys(packed, out = []) {
    if (!packed || packed._enc) return out;
    [packed.coverRow, ...(packed.mediaRows || [])].filter(Boolean)
        .forEach(r => [r.path, r.thumb, r.preview].forEach(k => k && out.push(k)));
    (packed.children || []).forEach(c => _collectCmsCoverKeys(c, out));
    return out;
}

/**
 * 打包并加密 CMS 节点子树，返回密文与需迁入私有桶的封面原图路径列表
 * @param {Object} node - 目标 CMS 节点
 * @param {Array} [lockedNodes] - 当前 AppState.lockedNodes
 * @returns {Promise<{enc:string, covers:Array<string>}|null>}
 */
export async function packCmsNodeForLock(node, lockedNodes = []) {
    let index;
    const getIndex = () => (index ||= _loadCmsCoverIndex());
    const tree = await _packCmsNode(node, getIndex, lockedNodes);
    const sources = [];
    const visit = async item => {
        const source = item._enc ? { id: item.id, _enc: item._enc } : {
            id: item.id, type: item.type, title: item.title, tags: item.tags || [],
            coverImage: item.coverImage ?? null, md: item.md ?? '',
            children: (item.children || []).map(child => child.id)
        };
        sources.push({ id: item.id, revision: await fingerprintRecord(source) });
        for (const child of item.children || []) await visit(child);
    };
    await visit(tree);
    const enc = await lockRecord(tree);
    if (!enc) return null;
    return { enc: enc._enc, covers: [...new Set(_collectCmsCoverPaths(tree))], sources };
}

/**
 * 若当前会话已解锁，解密 CMS 锁定节点并提取其私有桶封面文件键（原图/缩略图/预览图）供彻底清理
 * @param {Object} locked - 锁定节点占位对象 { id, _enc }
 * @returns {Promise<Array<string>>}
 */
export async function collectCmsPrivateCoverKeys(locked) {
    if (!locked?._enc) return [];
    const key = await getSessionKey();
    if (!key) return [];
    const tree = await unwrapRecord({ _enc: locked._enc }, key);
    return tree ? [...new Set(_collectCmsCoverKeys(tree))] : [];
}
