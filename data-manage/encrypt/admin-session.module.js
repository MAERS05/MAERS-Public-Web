/** 本地后台统一验证：一次输入主密码，管理密钥仅驻留当前标签页和本机服务内存。 */
import { localFetch } from '../api-client.module.js';
import { getSessionKeyRaw, toB64, clearSessionKey } from './crypto.module.js';
import { ensureUnlocked, canWriteKeyring } from './auth-flow.module.js';
import { openProgress } from './lock-dialog.module.js';

let pending = null;
let fingerprint;
let lease = null;
let starting = false;

export function ensureAdminSession() {
    if (pending && starting) return pending;
    const raw = getSessionKeyRaw();
    const current = raw ? toB64(raw) : null;
    if (!pending || current !== fingerprint) {
        fingerprint = current;
        starting = true;
        const next = start(current);
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

async function start(key) {
    if (!key) {
        const response = await fetch('/api/crypto/admin-status', { cache: 'no-store' });
        if (!response.ok) throw Error('无法检查本机加密管理状态');
        const status = await response.json();
        if (!status.has_encrypted) return;
        if (!(await ensureUnlocked())) throw Error('后台私密内容尚未验证，请输入主密码后重试');
        key = toB64(getSessionKeyRaw());
        fingerprint = key;
    }
    const response = await localFetch('/api/crypto/admin-session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key })
    });
    const result = await response.json();
    if (!response.ok) {
        if (response.status === 400) clearSessionKey();
        throw Error(result.error || '本机私密管理初始化失败');
    }
    lease = result.lease;
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
    if (event.persisted && canWriteKeyring()) window.location.reload();
});

async function request(path, body) {
    await ensureAdminSession();
    const response = await localFetch(path, body ? { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '对外加密状态修改失败');
    return result;
}

export async function protectCmsNode(module, id) {
    if (!(await ensureUnlocked())) return false;
    const progress = openProgress('正在对外加密', 'encryption');
    try {
        await request(`/api/cms/node?module=${encodeURIComponent(module)}&action=protect`, { id });
        return true;
    } finally { progress.close(); }
}

async function finish(result, progress, label) {
    if (!result.job) return result;
    progress.update(0, result.total, label);
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 800));
        const state = await request('/api/album/job', { id: result.job });
        progress.update(state.done, state.total, label);
        if (state.state === 'success') return state.result;
        if (state.state === 'error') throw Error(state.result?.error || '取消加密失败');
    }
    throw Error('迁移仍在后台执行，请确认结果后再操作');
}

export async function cancelProtection(record) {
    if (!confirm('取消对外加密会将内容恢复为公开状态，确定继续？')) return null;
    const progress = openProgress('取消对外加密', 'decryption');
    try {
        const result = await finish(await request('/api/crypto/unprotect', { reference: record._private_id }), progress, '恢复公开内容');
        if (result.record) return result.record;
        const clean = { ...record };
        delete clean._private;
        delete clean._private_id;
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
