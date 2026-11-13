/**
 * MAERS Crypto Settings (crypto-settings.module.js)
 * 职责：加密设置面板（主密码 / 恢复码 / 私密图片地址 / Worker 令牌同步）
 *
 * 对外接口：
 * - openCryptoSettings() → 打开设置面板
 * - syncTokenToWorker({ silent }) → 将私密图片令牌哈希写入 Worker KV，返回 boolean
 */

import { getSessionKey, getSessionKeysRaw, getSessionKeyRaw, getAccessTokenHash } from './crypto.module.js';
import { activatePasswordGroup } from './auth-flow.module.js';
import {
    loadKeyring, saveKeyring, unlockWithPassword, rewrapPassword, regenerateRecovery, passwordGroups, createContentAccess
} from './keyring.module.js';
import {
    ensureUnlocked, openFormModal, showRecoveryCodeModal, recoverWithCodeFlow,
    validateNewPassword, canWriteKeyring, escapeHtml
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
        if (!Object.keys(getSessionKeysRaw()).length) {
            if (silent) return false;
            if (!(await ensureUnlocked())) return false;
        }
        const ring = await loadKeyring(true);
        const ids = Object.keys(getSessionKeysRaw()).filter(id => id !== 'default' || !ring.master_only);
        if (!ids.length) {
            if (!silent) Toast.info('请先创建并解锁密码组');
            return true;
        }
        if (Object.keys(ring.groups || {}).length) {
            const capability = await _workerFetch('/api/ping');
            if (capability.password_groups_version !== 1) throw Error('请先更新 Worker 中继代码，再同步密码组令牌');
        }
        for (const group of ids) {
            const path = '/api/private-token' + (group === 'default' ? '' : '?g=' + encodeURIComponent(group));
            const hash = await getAccessTokenHash(group);
            const cur = await _workerFetch(path).catch(() => null);
            if (cur?.hash !== hash) {
                const result = await _workerFetch(path, { method: 'POST', body: JSON.stringify({ hash }) });
                if (result.overridden_by_env) throw Error('Worker 的 PRIVATE_TOKEN_HASH 覆盖了自动同步值，请更新或删除该变量');
                if ((await _workerFetch(path)).hash !== hash) throw Error('Worker 令牌核验失败，请重新同步');
            }
            if (group === 'default') await finishRotation(hash);
        }
        if (!silent) Toast.success('已同步所有已解锁组的图片令牌');
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
        const ring = await loadKeyring();
        const groups = passwordGroups(ring);
        const keys = getSessionKeysRaw();
        const matches = [];
        for (const group of groups.filter(group => keys[group.id])) {
            const query = group.id === 'default' ? '' : '?g=' + encodeURIComponent(group.id);
            const cur = await _workerFetch('/api/private-token' + query).catch(() => null);
            matches.push(!!cur && cur.hash === await getAccessTokenHash(group.id));
        }
        return { ok: true, bucket: !!ping.private_r2_ready, noGroups: !groups.length,
            tokenReady: !!ping.private_token_ready, tokenMatch: matches.length ? matches.every(Boolean) : null };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ══════════════════════════════════════════════
// 2. 设置面板
// ══════════════════════════════════════════════

const flag = (ok, yes, no) => ok ? `<span class="mlock-ok">✔ ${yes}</span>` : `<span class="mlock-bad">✘ ${no}</span>`;

async function localAccess(enabled) {
    const response = await localFetch('/api/crypto/local-access', enabled === undefined ? { cache: 'no-store' } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled })
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '无法读取本机免密管理状态，请重启后台');
    return data;
}

async function _renderStatus(el) {
    const keyring = await loadKeyring(true);
    const unlocked = !!(await getSessionKey());
    const box = el.closest('.mlock-box');
    const unlockBtn = box?.querySelector('[data-op="unlock"]');
    if (unlockBtn) {
        const access = await localAccess();
        unlockBtn.disabled = false;
        unlockBtn.textContent = access.enabled ? '免密管理√' : '启用免密管理';
        unlockBtn.title = access.enabled ? '关闭免密管理' : '启用后进入本地后台无需输入主密码';
    }
    const lines = [
        `<b>主密码</b>：${flag(!!keyring, '已设置 · ID ' + escapeHtml(keyring?.dek_id?.slice(0, 8) || ''), '未设置')}`,
        `<b>后台管理</b>：${flag(unlocked, '已验证', '未验证')}`,
        `<b>私密图片地址</b>：${keyring?.media_base ? escapeHtml(keyring.media_base) : '<span class="mlock-bad">未设置</span>'}`,
        `<b>Worker</b>：检测中...`,
        `<b>副密码</b>：${flag(!!keyring?.content, '已设置 · 仅解锁内容', '未设置')}`
    ];
    el.innerHTML = lines.join('<br>');

    const ws = await _workerStatus();
    lines[3] = !ws.ok
        ? `<b>Worker</b>：<span class="mlock-bad">✘ ${escapeHtml(ws.error)}</span>`
        : `<b>Worker</b>：${flag(ws.bucket, '私密桶已绑定', '未绑定 PRIVATE_PHOTOS_BUCKET')} · ` +
          (ws.noGroups ? '尚无密码组' : ws.tokenMatch === null
              ? flag(ws.tokenReady, '令牌已配置', '令牌未同步')
              : flag(ws.tokenMatch, '令牌一致', '令牌不一致，请同步'));
    if (el.isConnected) el.innerHTML = lines.join('<br>');
}

export async function openCryptoSettings() {
    if (!canWriteKeyring()) return;
    let finish;
    const closed = new Promise(resolve => { finish = resolve; });
    const actions = [
        ['unlock', '免密管理'],
        ['content', '副密码'],
        ['groups', '密码组'],
        ['pwd', '修改主密码'],
        ['reset', '用恢复码重置'],
        ['rc', '重置恢复码'],
        ['sync', 'Worker同步'],
        ['media', '私密图片地址'],
        ['rotate', '轮换主密钥']
    ];

    const modal = openFormModal({
        icon: 'secret-key',
        title: '加密设置',
        sub: '主密码可进入线上后台，副密码仅解锁全部内容',
        bodyHtml: `
            <div class="mlock-status" data-role="status">读取中...</div>
            <div class="mlock-actions mlock-crypto-actions">
                ${actions.map(([k, t]) => `<button type="button" class="mlock-btn-secondary" data-op="${k}" ${k === 'unlock' ? 'disabled' : ''}>${t}</button>`).join('')}
            </div>
        `,
        confirmText: '关闭',
        cancelText: '', closeButton: true,
        onSubmit: () => { finish(); return true; },
        onCancel: finish
    });

    modal.el.querySelector('.mlock-box').classList.add('mlock-box--settings');
    const statusEl = modal.el.querySelector('[data-role="status"]');
    const refresh = async () => {
        try { await _renderStatus(statusEl); }
        catch (error) { statusEl.textContent = error.message; }
    };
    refresh();

    const ops = {
        groups: async () => { await (await import('./password-groups.module.js')).openPasswordGroups(); },
        unlock: _toggleLocalAccessFlow,
        sync: async () => { await syncTokenToWorker(); },
        content: _contentPasswordFlow,
        pwd: _changePasswordFlow,
        rc: _regenerateRecoveryFlow,
        reset: async () => {
            const keyring = await loadKeyring(true);
            if (!keyring) return Toast.error('尚未设置主密码');
            await recoverWithCodeFlow(keyring);
        },
        media: _editMediaBaseFlow,
        rotate: _rotateFlow
    };

    let working = false;
    modal.el.querySelectorAll('[data-op]').forEach(btn => {
        btn.onclick = async () => {
            if (working || !modal.el.isConnected) return;
            working = true;
            // 子流程使用独立弹窗，期间隐藏设置面板
            modal.el.style.display = 'none';
            try {
                if (['sync', 'unlock'].includes(btn.dataset.op)) {
                    await ops[btn.dataset.op]();
                } else {
                    // 需要已设置主密码的操作统一先确保密钥环存在
                    if (!(await loadKeyring(true))) {
                        await ensureUnlocked(); // 未设置时走首次设置流程
                    } else {
                        await ops[btn.dataset.op]();
                    }
                }
            } catch (error) {
                Toast.error(error.message);
            } finally {
                working = false;
                if (modal.el.isConnected) {
                    modal.el.style.display = '';
                    refresh();
                    modal.el.querySelector('.mlock-box').focus();
                }
            }
        };
    });
    return closed;
}

// ══════════════════════════════════════════════
// 3. 子流程
// ══════════════════════════════════════════════

/** 本机免密开关：保留当前管理状态，下次进入后台时应用新设置。 */
async function _toggleLocalAccessFlow() {
    const { enabled } = await localAccess();
    return new Promise(resolve => openFormModal({
        title: enabled ? '关闭免密管理？' : '启用免密管理？',
        sub: enabled ? '关闭后，下次进入本地后台需要输入主密码。' : '启用后，在这台电脑进入本地后台无需输入主密码。',
        confirmText: enabled ? '关闭免密管理' : '启用免密管理',
        focusDialog: true,
        onSubmit: async () => {
            if (!enabled && !(await ensureUnlocked())) return '请先验证主密码';
            await (await import('./admin-session.module.js')).ensureAdminSession();
            await localAccess(!enabled);
            Toast.success(enabled ? '已关闭免密管理' : '已启用免密管理');
            resolve();
            return true;
        },
        onCancel: resolve
    }));
}

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
                if (keyring.content && await unlockWithPassword(keyring.content, pwd)) return '主密码不能与副密码相同';
                const raw = await unlockWithPassword(keyring, old);
                if (!raw) return '当前主密码不正确';
                await saveKeyring(await rewrapPassword(keyring, raw, pwd), keyring);
                await activatePasswordGroup(keyring, 'default', raw);
                Toast.success('✅ 主密码已修改，请提交 data/crypto-keyring.json 后发布');
                resolve();
                return true;
            },
            onCancel: resolve
        });
    });
}

/** 设置或更换全局副密码，保留各组自己的密码及内容密文。 */
async function _contentPasswordFlow() {
    if (!(await ensureUnlocked())) return;
    const current = await loadKeyring(true);
    return new Promise(resolve => openFormModal({
        title: current.content ? '修改副密码' : '设置副密码',
        sub: '解锁全部内容，不能进入线上后台；新建密码组也会自动纳入',
        fields: [
            { name: 'pwd', type: 'password', placeholder: current.content ? '新副密码（至少 8 位）' : '副密码（至少 8 位）', autocomplete: 'new-password' },
            { name: 'again', type: 'password', placeholder: current.content ? '再次输入新副密码' : '再次输入副密码', autocomplete: 'new-password' }
        ],
        confirmText: '保存',
        onSubmit: async ({ pwd, again }) => {
            const error = validateNewPassword(pwd, again);
            if (error) return error;
            const ring = await loadKeyring(true);
            const next = await createContentAccess(ring, pwd, getSessionKeyRaw());
            await saveKeyring(next, ring);
            Toast.success('副密码已保存，发布后生效');
            resolve();
            return true;
        },
        onCancel: resolve
    }));
}

/** 更新当前密钥环的恢复槽；撤销历史凭据需要完整轮换。 */
function _regenerateRecoveryFlow() {
    return new Promise((resolve) => {
        openFormModal({
            icon: '🧩',
            title: '重置恢复码',
            sub: '更新主密码的恢复码。已有密钥环副本仍保留原来的包裹密钥。',
            fields: [{ name: 'old', type: 'password', placeholder: '当前主密码', autocomplete: 'current-password' }],
            confirmText: '生成',
            onSubmit: async ({ old }) => {
                const keyring = await loadKeyring(true);
                const raw = await unlockWithPassword(keyring, old);
                if (!raw) return '当前主密码不正确';
                const { keyring: next, recoveryCode } = await regenerateRecovery(keyring, raw);
                await saveKeyring(next, keyring);
                await activatePasswordGroup(keyring, 'default', raw);
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
        icon: '🔐', title: '轮换主密钥',
        sub: '重新包裹各组密钥并保留本机备份。各组保留自己的数据密钥，旧主密码曾解出的组密钥仍有效。',
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
                await saveKeyring({ ...keyring, media_base: clean }, keyring);
                Toast.success('已保存，发布后生效');
                resolve();
                return true;
            },
            onCancel: resolve
        });
    });
}
