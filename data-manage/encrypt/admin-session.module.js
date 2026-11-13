/** 后台会话：Windows 本机登记后免密管理全部，线上按主密码验证；明文密钥只驻留内存。 */
import { isAdminAddress, isStudioAdminPage, isOnlineAdminPage, localFetch, STUDIO_ENTRY_KEY } from '../api-client.module.js';
import { getSessionKeysRaw, getSessionKeyRaw, setSessionKeyRaw, fromB64, clearSessionKey } from './crypto.module.js';
import { loadKeyring, matchesDataKey } from './keyring.module.js';
import { ensureUnlocked } from './auth-flow.module.js';
import { openFormModal, openProgress } from './lock-dialog.module.js';
import { operationFetch, waitForStudioIdle } from '../operation-progress.module.js';

let pending = null;
let fingerprint;
let lease = null;
let starting = false;
let entryChecked = false;
let entryCancelled = false;
let onlineEntry;

/** 线上入口共用密码组窗口；只有本次验证主密码才能进入，组密码只解锁访客内容。 */
export function ensureOnlineAdminEntry() {
    if (!onlineEntry) onlineEntry = openOnlineEntry();
    return onlineEntry;
}

async function openOnlineEntry() {
    const entry = sessionStorage.getItem(STUDIO_ENTRY_KEY);
    clearAdminEntry();
    const master = getSessionKeyRaw();
    const continuation = !window.opener && entry === 'active' && master &&
        await matchesDataKey(await loadKeyring(true), master);
    if (!continuation) {
        clearSessionKey('default');
        let verified = false;
        const { openGroupUnlock } = await import('./group-unlock.module.js');
        const result = await openGroupUnlock({ reload: false, onMaster: () => { verified = true; } });
        if (result === null) throw new Error('请先在电脑本地设置并发布主密码');
        if (!verified) throw new Error('已取消主密码验证', { cause: 'admin_entry_cancelled' });
    }
    sessionStorage.setItem(STUDIO_ENTRY_KEY, 'active');
}

export function clearAdminEntry() { sessionStorage.removeItem(STUDIO_ENTRY_KEY); }

function checkEntry() {
    const entry = sessionStorage.getItem(STUDIO_ENTRY_KEY);
    clearAdminEntry();
    const referrer = document.referrer ? new URL(document.referrer) : null;
    const fromAdmin = referrer?.origin === window.location.origin && isAdminAddress(referrer);
    const reloading = performance.getEntriesByType('navigation')[0]?.type === 'reload';
    const withinAdmin = entry === 'active' && (fromAdmin || reloading);
    if (window.opener || !withinAdmin) clearSessionKey();
}

export function ensureAdminSession() {
    if (entryCancelled) return Promise.reject(new Error('已取消主密码验证', { cause: 'admin_entry_cancelled' }));
    if (pending && starting) return pending;
    if (!entryChecked) {
        checkEntry();
        entryChecked = true;
    }
    const keys = getSessionKeysRaw();
    const current = JSON.stringify(Object.entries(keys).sort());
    if (!pending || current !== fingerprint) {
        fingerprint = current;
        starting = true;
        const next = start(keys);
        pending = next;
        next.then(() => { if (pending === next) starting = false; }, () => {
            if (pending === next) { pending = null; starting = false; }
        });
    }
    return pending;
}

export function resetAdminSession() {
    pending = null;
    fingerprint = undefined;
    lease = null;
    starting = false;
}

async function start(keys) {
    await waitForStudioIdle();
    if (!keys.default) {
        const response = await localFetch('/api/crypto/local-session', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        if (response.ok) {
            const result = await response.json();
            if (!result.configured) return;
            for (const [id, raw] of Object.entries(result.keys)) setSessionKeyRaw(fromB64(raw), id);
            fingerprint = JSON.stringify(Object.entries(getSessionKeysRaw()).sort());
            lease = result.lease;
            sessionStorage.setItem(STUDIO_ENTRY_KEY, 'active');
            return;
        }
        if (response.status !== 428) throw Error('无法恢复本机免密管理，请重启后台');
        if (!(await ensureUnlocked())) {
            entryCancelled = true;
            throw new Error('已取消主密码验证', { cause: 'admin_entry_cancelled' });
        }
        keys = getSessionKeysRaw();
        fingerprint = JSON.stringify(Object.entries(keys).sort());
    }
    const response = await localFetch('/api/crypto/admin-session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys, remember: true })
    });
    const result = await response.json();
    if (!response.ok) {
        if (response.status === 400) {
            clearAdminEntry();
            clearSessionKey();
        }
        throw Error(result.error || '本机私密管理初始化失败');
    }
    lease = result.lease;
    sessionStorage.setItem(STUDIO_ENTRY_KEY, 'active');
}

export async function closeAdminSession() {
    const previous = lease;
    resetAdminSession();
    if (previous) await localFetch('/api/crypto/admin-session/close', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lease: previous }), keepalive: true
    });
}

window.addEventListener?.('pagehide', () => { closeAdminSession().catch(() => {}); });
window.addEventListener?.('pageshow', event => {
    if (event.persisted && (isStudioAdminPage() || isOnlineAdminPage())) window.location.reload();
});

async function request(path, body, progress = null) {
    const jobPoll = path === '/api/album/job';
    if (!jobPoll) await ensureAdminSession();
    const options = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) } : { cache: 'no-store' };
    if (jobPoll) options.signal = AbortSignal.timeout(10000);
    const response = progress ? await operationFetch(path, options, progress) : await localFetch(path, options);
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '对外加密状态修改失败', {
        cause: jobPoll && response.status >= 500 ? 'job_poll_retry' : 'request_rejected'
    });
    return result;
}

export async function changePasswordGroups(body) {
    const progress = openProgress('正在更换密码组', 'encryption');
    try {
        return await request('/api/crypto/groups/assign', body, progress);
    } finally { progress.close(); }
}

export async function protectCmsNode(module, id, group) {
    if (!group) return false;
    const progress = openProgress('正在对外加密', 'encryption');
    try {
        await request(`/api/cms/node?module=${encodeURIComponent(module)}&action=protect`, { id, group });
        return true;
    } finally { progress.close(); }
}

/** 方案 3 的 CMS 节点：正文留在本地，只有标记与私有图片，解密与换组走本地节点接口。 */
async function cmsNodeAction(module, action, body, label, kind) {
    const progress = openProgress(label, kind);
    try {
        await request(`/api/cms/node?module=${encodeURIComponent(module)}&action=${action}`, body);
        return true;
    } finally { progress.close(); }
}

async function finish(result, progress, label) {
    if (!result.job) return result;
    progress.update(0, result.total, label);
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 800));
        let state;
        try { state = await request('/api/album/job', { id: result.job }); }
        catch (error) {
            if (error.cause !== 'job_poll_retry' && !(error instanceof TypeError) &&
                !['AbortError', 'TimeoutError'].includes(error.name)) throw error;
            progress.update(0, 0, `${label}：正在重新连接后台`);
            continue;
        }
        progress.update(state.done, state.total, state.message || label);
        if (state.state === 'success') return state.result;
        if (state.state === 'error') throw Error(state.result?.error || '取消加密失败');
    }
}

export const PROTECTION_ACTION_TITLE = '解密或更换加密组';

function chooseProtectionAction() {
    return new Promise(resolve => openFormModal({
        icon: 'decryption', title: PROTECTION_ACTION_TITLE,
        focusDialog: true,
        confirmText: '更换密码组',
        alternate: { text: '解密', onClick: () => resolve('decrypt') },
        onSubmit: () => { resolve('change-group'); return true; },
        onCancel: () => resolve(null)
    }));
}

export async function cancelProtection(record, module = null) {
    const action = await chooseProtectionAction();
    if (!action) return null;
    const local = !record._private_id && module;
    if (action === 'change-group') {
        const { choosePasswordGroup } = await import('./password-groups.module.js');
        const selected = await choosePasswordGroup({ changeFrom: record._group || record._private_group || 'default' });
        if (!selected) return null;
        if (local) return cmsNodeAction(module, 'regroup', { id: record.id, group: selected }, '正在更换密码组', 'encryption');
        const { items } = await request('/api/crypto/groups/catalog');
        const item = items.find(item => item.reference === record._private_id);
        if (!item) throw Error('内容已变化，请刷新后重试');
        await changePasswordGroups({ group: selected,
            items: [{ reference: item.reference, revision: item.revision }] });
        window.location.reload();
        return null;
    }
    if (!confirm('解密后内容将恢复公开。确定继续？')) return null;
    if (local) return cmsNodeAction(module, 'unprotect', { id: record.id }, '正在解密', 'decryption');
    const progress = openProgress('正在解密', 'decryption');
    try {
        const result = await finish(await request('/api/crypto/unprotect', { reference: record._private_id }), progress, '恢复公开内容');
        if (result.record) return result.record;
        const clean = { ...record };
        delete clean._private;
        delete clean._private_id;
        delete clean._private_group;
        return clean;
    } finally { progress.close(); }
}

export async function cancelSourceEncryption(source) {
    let count = 0;
    const seen = new Set();
    const progress = openProgress('取消全部加密', 'decryption');
    try {
        while (true) {
            const { references } = await request('/api/crypto/admin-protection?source=' + encodeURIComponent(source));
            if (!references.length) return count;
            const reference = references[0];
            if (seen.has(reference)) throw Error('加密状态未更新，已停止重复操作');
            const label = `取消全部加密：第 ${count + 1}/${count + references.length} 项`;
            progress.update(0, 0, label);
            await finish(await request('/api/crypto/unprotect', { reference }), progress, label);
            seen.add(reference);
            count++;
        }
    } finally { progress.close(); }
}
