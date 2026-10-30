/**
 * MAERS Crypto Settings (crypto-settings.module.js)
 * 职责：加密设置面板（主密码 / 恢复码 / 私密图片地址 / Worker 令牌同步）
 *
 * 对外接口：
 * - openCryptoSettings() → 打开设置面板
 * - syncTokenToWorker({ silent }) → 将私密图片令牌哈希写入 Worker KV，返回 boolean
 */

import { getSessionKey, setSessionKeyRaw, getAccessTokenHash } from './crypto.module.js';
import {
    loadKeyring, saveKeyring, unlockWithPassword, rewrapPassword, regenerateRecovery
} from './keyring.module.js';
import {
    ensureUnlocked, openFormModal, showRecoveryCodeModal, recoverWithCodeFlow,
    validateNewPassword, canWriteKeyring, logoutSession, escapeHtml
} from './admin-lock.module.js';
import { Toast } from '../../shared/toast.module.js';
import { localFetch } from '../api-client.module.js';

async function finishRotation(hash) {
    if (!canWriteKeyring()) return;
    const ring = await loadKeyring(true);
    const response = await localFetch('/api/crypto/rotation/finalize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dek_id: ring.dek_id, token_hash: hash })
    });
    if (!response.ok) throw new Error('令牌已更新，但本机轮换确认失败，请重试');
}

// ══════════════════════════════════════════════
// 1. Worker 通信
// ══════════════════════════════════════════════

async function _relay() {
    const { syncManager } = await import('../sync/sync-manager.module.js');
    const relay = syncManager.getConfig().relay || {};
    return { endpoint: (relay.endpoint || '').replace(/\/+$/, ''), secret: (relay.secret || '').trim() };
}

async function _workerFetch(path, init = {}) {
    const { endpoint, secret } = await _relay();
    if (!endpoint || !secret) throw new Error('未配置中继地址或 SECRET_KEY（同步设置中填写）');
    const res = await fetch(endpoint + path, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'x-sync-key': secret, ...(init.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

/**
 * 将当前会话对应的令牌哈希写入 Worker（需已解锁）
 * 令牌由数据密钥派生，更换主密码不会改变令牌，因此只需在首次设置或恢复后同步一次
 * @param {{silent?:boolean}} opts - silent 时仅在失败时提示
 */
export async function syncTokenToWorker({ silent = false } = {}) {
    if (!canWriteKeyring()) {
        if (!silent) Toast.error('请在本地后台同步私密图片令牌');
        return false;
    }
    try {
        if (!(await getSessionKey())) {
            if (silent) return false;
            if (!(await ensureUnlocked())) return false;
        }
        const hash = await getAccessTokenHash();
        // 已一致则跳过写入
        const cur = await _workerFetch('/api/private-token').catch(() => null);
        if (cur?.hash === hash) {
            await finishRotation(hash);
            if (!silent) Toast.success('Worker 令牌已是最新');
            return true;
        }
        const res = await _workerFetch('/api/private-token', { method: 'POST', body: JSON.stringify({ hash }) });
        if (res.overridden_by_env) {
            Toast.error('Worker 设置了环境变量 PRIVATE_TOKEN_HASH，会覆盖自动同步的值，请删除该变量');
            return false;
        }
        const verified = await _workerFetch('/api/private-token');
        if (verified.hash !== hash) throw new Error('Worker 仍使用旧令牌，发布保持暂停');
        await finishRotation(hash);
        if (!silent) Toast.success('✅ 令牌已同步到 Worker');
        return true;
    } catch (e) {
        Toast.error('同步 Worker 令牌失败: ' + e.message);
        return false;
    }
}

/** 查询 Worker 状态，用于面板展示 */
async function _workerStatus() {
    try {
        const ping = await _workerFetch('/api/ping');
        let tokenMatch = null;
        if (await getSessionKey()) {
            const cur = await _workerFetch('/api/private-token').catch(() => null);
            tokenMatch = cur ? cur.hash === (await getAccessTokenHash()) : null;
        }
        return { ok: true, bucket: !!ping.private_r2_ready, tokenReady: !!ping.private_token_ready, tokenMatch };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ══════════════════════════════════════════════
// 2. 设置面板
// ══════════════════════════════════════════════

const flag = (ok, yes, no) => ok ? `<span class="mlock-ok">✔ ${yes}</span>` : `<span class="mlock-bad">✘ ${no}</span>`;

async function _renderStatus(el) {
    const keyring = await loadKeyring(true);
    const unlocked = !!(await getSessionKey());
    const box = el.closest('.mlock-box');
    const unlockBtn = box?.querySelector('[data-op="unlock"]');
    const lockBtn = box?.querySelector('[data-op="lock"]');
    if (unlockBtn) {
        unlockBtn.disabled = unlocked;
        unlockBtn.textContent = unlocked ? '后台已验证' : keyring ? '管理加密内容' : '设置主密码';
        unlockBtn.title = unlocked
            ? '当前后台已验证，可正常管理加密内容，保存时自动重新加密'
            : '输入一次主密码，正常管理加密内容，不改变对外加密状态';
    }
    if (lockBtn) lockBtn.disabled = !unlocked;
    const lines = [
        `<b>主密码</b>：${flag(!!keyring, '已设置 · ID ' + escapeHtml(keyring?.dek_id?.slice(0, 8) || ''), '未设置')}`,
        `<b>后台管理</b>：${flag(unlocked, '已验证', '未验证')}`,
        `<b>私密图片地址</b>：${keyring?.media_base ? escapeHtml(keyring.media_base) : '<span class="mlock-bad">未设置</span>'}`,
        `<b>Worker</b>：检测中...`
    ];
    el.innerHTML = lines.join('<br>');

    const ws = await _workerStatus();
    lines[3] = !ws.ok
        ? `<b>Worker</b>：<span class="mlock-bad">✘ ${escapeHtml(ws.error)}</span>`
        : `<b>Worker</b>：${flag(ws.bucket, '私密桶已绑定', '未绑定 PRIVATE_PHOTOS_BUCKET')} · ` +
          (ws.tokenMatch === null
              ? flag(ws.tokenReady, '令牌已配置', '令牌未同步')
              : flag(ws.tokenMatch, '令牌一致', '令牌不一致，请同步'));
    if (el.isConnected) el.innerHTML = lines.join('<br>');
}

export async function openCryptoSettings() {
    if (!canWriteKeyring()) return;
    const actions = [
        ['unlock', '管理加密内容'],
        ['lock', '退出加密管理'],
        ['sync', '同步令牌到 Worker'],
        ['media', '私密图片地址'],
        ['pwd', '修改主密码'],
        ['rc', '重新生成恢复码'],
        ['reset', '用恢复码重置'],
        ['rotate', '更换数据密钥']
    ];

    const modal = openFormModal({
        icon: '🛡️',
        title: '加密设置',
        sub: '修改主密码不会改动任何已加密数据',
        bodyHtml: `
            <div class="mlock-status" data-role="status">读取中...</div>
            <div class="mlock-actions">
                ${actions.map(([k, t]) => `<button type="button" class="mlock-btn-secondary" data-op="${k}">${t}</button>`).join('')}
            </div>
        `,
        confirmText: '关闭',
        cancelText: '',
        onSubmit: () => true
    });

    modal.el.querySelector('.mlock-box').classList.add('mlock-box--settings');
    const statusEl = modal.el.querySelector('[data-role="status"]');
    const refresh = () => _renderStatus(statusEl);
    refresh();

    const ops = {
        unlock: async () => { if (await ensureUnlocked()) await (await import('./admin-session.module.js')).ensureAdminSession(); },
        sync: async () => { await syncTokenToWorker(); },
        lock: async () => { await logoutSession(); },
        pwd: _changePasswordFlow,
        rc: _regenerateRecoveryFlow,
        reset: async () => {
            const keyring = await loadKeyring(true);
            if (!keyring) return Toast.error('尚未设置主密码');
            const raw = await recoverWithCodeFlow(keyring);
            if (raw) setSessionKeyRaw(raw);
        },
        media: _editMediaBaseFlow,
        rotate: _rotateFlow
    };

    modal.el.querySelectorAll('[data-op]').forEach(btn => {
        btn.onclick = async () => {
            // 子流程使用独立弹窗，期间隐藏设置面板
            modal.el.style.display = 'none';
            try {
                if (['sync', 'lock', 'unlock'].includes(btn.dataset.op)) {
                    await ops[btn.dataset.op]();
                } else {
                    // 需要已设置主密码的操作统一先确保密钥环存在
                    if (!(await loadKeyring(true))) {
                        await ensureUnlocked(); // 未设置时走首次设置流程
                    } else {
                        await ops[btn.dataset.op]();
                    }
                }
            } finally {
                modal.el.style.display = '';
                refresh();
            }
        };
    });
}

// ══════════════════════════════════════════════
// 3. 子流程
// ══════════════════════════════════════════════

/** 修改主密码：验证旧密码 → 用新密码重新包裹数据密钥 */
function _changePasswordFlow() {
    return new Promise((resolve) => {
        openFormModal({
            icon: '🔑',
            title: '修改主密码',
            sub: '只更新密钥环文件，已加密内容与 Worker 令牌均不变',
            fields: [
                { name: 'old', type: 'password', placeholder: '当前主密码', autocomplete: 'current-password' },
                { name: 'pwd', type: 'password', placeholder: '新主密码（至少 8 位）', autocomplete: 'new-password' },
                { name: 'pwd2', type: 'password', placeholder: '再次输入新主密码', autocomplete: 'new-password' }
            ],
            confirmText: '保存',
            onSubmit: async ({ old, pwd, pwd2 }) => {
                const err = validateNewPassword(pwd, pwd2);
                if (err) return err;
                const keyring = await loadKeyring(true);
                const raw = await unlockWithPassword(keyring, old);
                if (!raw) return '当前主密码不正确';
                await saveKeyring(await rewrapPassword(keyring, raw, pwd));
                setSessionKeyRaw(raw);
                Toast.success('✅ 主密码已修改，请提交 data/crypto-keyring.json 后发布');
                resolve();
                return true;
            },
            onCancel: resolve
        });
    });
}

/** 更新当前密钥环的恢复槽；撤销历史凭据需要完整轮换。 */
function _regenerateRecoveryFlow() {
    return new Promise((resolve) => {
        openFormModal({
            icon: '🧩',
            title: '重新生成恢复码',
            sub: '更新当前密钥环；撤销历史恢复码请使用更换数据密钥',
            fields: [{ name: 'old', type: 'password', placeholder: '当前主密码', autocomplete: 'current-password' }],
            confirmText: '生成',
            onSubmit: async ({ old }) => {
                const keyring = await loadKeyring(true);
                const raw = await unlockWithPassword(keyring, old);
                if (!raw) return '当前主密码不正确';
                const { keyring: next, recoveryCode } = await regenerateRecovery(keyring, raw);
                await saveKeyring(next);
                setSessionKeyRaw(raw);
                // 先关闭当前弹窗再展示恢复码
                setTimeout(() => showRecoveryCodeModal(recoveryCode).then(resolve), 0);
                return true;
            },
            onCancel: resolve
        });
    });
}

function _rotateFlow() {
    return new Promise(resolve => openFormModal({
        icon: '🔐', title: '更换数据密钥',
        sub: '重新加密全部私密记录并保留本机备份。用于旧密码或恢复码泄露后的撤销；不能收回历史公开副本。',
        fields: [
            { name: 'old', type: 'password', placeholder: '当前主密码' },
            { name: 'pwd', type: 'password', placeholder: '新主密码（至少 8 位）' },
            { name: 'pwd2', type: 'password', placeholder: '再次输入新主密码' }
        ], confirmText: '开始轮换',
        onSubmit: async ({ old, pwd, pwd2 }) => {
            const error = validateNewPassword(pwd, pwd2);
            if (error) return error;
            const { rotateDataKey } = await import('./key-rotation.module.js');
            try { await rotateDataKey(old, pwd); resolve(); return true; }
            catch (failure) { return failure.message; }
        }, onCancel: resolve
    }));
}

/** 修改私密图片地址（Worker 公网地址 / 自定义域名） */
async function _editMediaBaseFlow() {
    const keyring = await loadKeyring(true);
    const { endpoint } = await _relay();
    return new Promise((resolve) => {
        openFormModal({
            icon: '🌐',
            title: '私密图片地址',
            sub: '访客解锁后从该地址加载私密图片，留空则使用中继地址',
            fields: [{ name: 'base', type: 'url', placeholder: endpoint || 'https://xxx.workers.dev', value: keyring.media_base || '' }],
            confirmText: '保存',
            onSubmit: async ({ base }) => {
                const clean = (base || endpoint || '').trim().replace(/\/+$/, '');
                if (clean && !/^https:\/\//.test(clean)) return '必须是 https:// 开头的地址';
                await saveKeyring({ ...keyring, media_base: clean });
                Toast.success('已保存，发布后生效');
                resolve();
                return true;
            },
            onCancel: resolve
        });
    });
}
