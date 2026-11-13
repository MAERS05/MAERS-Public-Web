/** 密码验证流程：主密码验证、首次设置与恢复码重置；独立于后台管理会话。 */
import { getSessionKey, setSessionKeyRaw, fromB64 } from './crypto.module.js';
import { localFetch } from '../api-client.module.js';
import { canWriteKeyring, loadKeyring, unlockWithPassword, unlockWithRecovery, createKeyring, saveKeyring, rewrapPassword, groupKeyring, updateGroup, unwrapMasterGroups } from './keyring.module.js';
import { openFormModal, showRecoveryCodeModal } from './lock-dialog.module.js';
import { Toast } from '../../shared/toast.module.js';

const MIN_PASSWORD_LEN = 8;

// ══════════════════════════════════════════════
// 1. 核心操作
// ══════════════════════════════════════════════

export { canWriteKeyring } from './keyring.module.js';

/** 校验新主密码，返回错误文字或 null */
export function validateNewPassword(p1, p2) {
    if (!p1 || p1.length < MIN_PASSWORD_LEN) return `密码至少 ${MIN_PASSWORD_LEN} 位`;
    if (p1 !== p2) return '两次输入的密码不一致';
    return null;
}

const _pendingUnlock = new Map();
let _sessionGeneration = 0;

/** 主密码打开所有已接入的组；单组凭据只打开该组。 */
export async function activatePasswordGroup(ring, group, raw, generation = _sessionGeneration) {
    const linked = group === 'default' ? await unwrapMasterGroups(ring, raw) : new Map();
    if (generation !== _sessionGeneration) return [];
    setSessionKeyRaw(raw, group);
    for (const [id, key] of linked) setSessionKeyRaw(key, id);
    return [group, ...linked.keys()];
}

/**
 * 确保当前会话已解锁（有密钥）
 * - 已有会话：直接返回
 * - 已设置主密码：弹出密码框，密码错误当场提示
 * - 未设置（仅本地后台）：引导设置主密码并生成恢复码
 * @returns {Promise<CryptoKey|null>} 取消则返回 null
 */
export async function ensureUnlocked(group = 'default') {
    const existing = await getSessionKey(group);
    if (existing) return existing;
    // 并发调用共用同一个弹窗
    if (!_pendingUnlock.has(group)) {
        _pendingUnlock.set(group, _unlockFlow(group).finally(() => { _pendingUnlock.delete(group); }));
    }
    return _pendingUnlock.get(group);
}

async function _unlockFlow(group) {
    const generation = _sessionGeneration;
    let enrollment = false;
    if (canWriteKeyring()) {
        const response = await localFetch('/api/crypto/local-session', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        if (response.ok) {
            const data = await response.json();
            if (data.keys?.[group] && generation === _sessionGeneration) {
                for (const [id, raw] of Object.entries(data.keys)) setSessionKeyRaw(fromB64(raw), id);
                return getSessionKey(group);
            }
        } else if (response.status === 428) enrollment = (await response.json()).code === 'local_enrollment_required';
        else throw Error('无法恢复本机免密管理，请重启后台');
    }
    const keyring = await loadKeyring(true);
    if (!keyring) {
        if (!canWriteKeyring()) {
            Toast.error('尚未设置主密码，请先在电脑端本地后台完成设置');
            return null;
        }
        return _setupFlow();
    }
    const slot = groupKeyring(keyring, group);
    if (!slot) { Toast.error('密码组不存在，请刷新后重试'); return null; }
    const label = group === 'default' ? '主密码' : '密码';

    const dek = await new Promise((resolve) => {
        openFormModal({
            icon: '🔐',
            title: enrollment ? '登记本机免密管理' : group === 'default' ? '输入主密码' : `解锁「${slot.name}」`,
            sub: enrollment ? '验证一次现有主密码，今后在这台电脑自动管理全部内容' : group === 'default' ? '解锁所有已接入的密码组' : '验证后可以管理该组内容',
            fields: [{ name: 'pwd', type: 'password', placeholder: `输入${label}...`, autocomplete: 'current-password' }],
            confirmText: '确定',
            onSubmit: async ({ pwd }) => {
                if (!pwd) return '密码不能为空';
                const raw = await unlockWithPassword(slot, pwd);
                if (!raw) return `${label}不正确`;
                if (!(await activatePasswordGroup(keyring, group, raw, generation)).length) return '解锁状态已变化，请重试';
                resolve(raw);
                return true;
            },
            onCancel: () => resolve(null),
            link: canWriteKeyring()
                ? { text: '忘记密码？使用恢复码重置', onClick: async () => resolve(await recoverWithCodeFlow(slot, group)) }
                : null
        });
    });
    if (!dek || generation !== _sessionGeneration) return null;

    return getSessionKey(group);
}

/** 首次设置主密码：生成随机数据密钥与恢复码并写入密钥环 */
async function _setupFlow() {
    const generation = _sessionGeneration;
    const pwd = await new Promise((resolve) => {
        openFormModal({
            icon: 'secret-key',
            title: '设置主密码',
            sub: '用于解锁全部内容并进入线上后台，本机登记后免密管理',
            fields: [
                { name: 'pwd', type: 'password', placeholder: `主密码（至少 ${MIN_PASSWORD_LEN} 位）`, autocomplete: 'new-password' },
                { name: 'pwd2', type: 'password', placeholder: '再次输入主密码', autocomplete: 'new-password' }
            ],
            confirmText: '创建',
            onSubmit: async ({ pwd, pwd2 }) => {
                const err = validateNewPassword(pwd, pwd2);
                if (err) return err;
                resolve(pwd);
                return true;
            },
            onCancel: () => resolve(null)
        });
    });
    if (!pwd) return null;

    try {
        // 私密图片地址默认使用已配置的中继 Worker
        const { syncManager } = await import('../sync/sync-manager.module.js');
        const mediaBase = syncManager.getConfig().relay?.endpoint || '';
        const { keyring, recoveryCode, dekRaw } = await createKeyring(pwd, mediaBase);
        await saveKeyring({ ...keyring, master_only: true, groups: {} });
        await showRecoveryCodeModal(recoveryCode);
        if (generation !== _sessionGeneration) return null;
        setSessionKeyRaw(dekRaw);
        await (await import('./admin-session.module.js')).ensureAdminSession();
        Toast.success('主密码已设置，本机已启用免密管理');
        // 令牌由数据密钥派生，只需在创建时同步一次；失败不影响后续操作（可在加密设置中重试）
        import('./crypto-settings.module.js')
            .then(m => m.syncTokenToWorker({ silent: true }))
            .catch(() => { });
        return getSessionKey();
    } catch (e) {
        Toast.error('设置失败: ' + e.message);
        return null;
    }
}

/**
 * 使用恢复码重置主密码
 * @returns {Promise<Uint8Array|null>} 成功时返回 DEK 原始字节
 */
export function recoverWithCodeFlow(keyring, group = 'default') {
    const generation = _sessionGeneration;
    const label = group === 'default' ? '主密码' : '密码组密码';
    return new Promise((resolve) => {
        openFormModal({
            icon: '🧩',
            title: `使用恢复码重置${label}`,
            sub: '已加密的数据不受影响，重置后用新密码解锁',
            fields: [
                { name: 'code', type: 'text', placeholder: '恢复码 XXXX-XXXX-...' },
                { name: 'pwd', type: 'password', placeholder: `新${label}（至少 ${MIN_PASSWORD_LEN} 位）`, autocomplete: 'new-password' },
                { name: 'pwd2', type: 'password', placeholder: `再次输入新${label}`, autocomplete: 'new-password' }
            ],
            confirmText: '重置',
            onSubmit: async ({ code, pwd, pwd2 }) => {
                const err = validateNewPassword(pwd, pwd2);
                if (err) return err;
                const raw = await unlockWithRecovery(keyring, code);
                if (!raw) return '恢复码不正确';
                try {
                    const ring = await loadKeyring(true);
                    if (group === 'default' && ring.content && await unlockWithPassword(ring.content, pwd)) {
                        return '主密码不能与副密码相同';
                    }
                    const current = groupKeyring(ring, group);
                    if (!current || current.dek_id !== keyring.dek_id || current.rc?.wrap !== keyring.rc?.wrap) {
                        return '恢复设置已变化，请重新打开';
                    }
                    await saveKeyring(updateGroup(ring, group, await rewrapPassword(current, raw, pwd)), ring,
                        group === 'default' ? { masterRaw: raw } : {});
                    if (!(await activatePasswordGroup(ring, group, raw, generation)).length) return '解锁状态已变化，请重新打开';
                } catch (e) {
                    return '保存失败: ' + e.message;
                }
                Toast.success(`${label}已重置`);
                resolve(raw);
                return true;
            },
            onCancel: () => resolve(null)
        });
    });
}

/** 使尚未结束的密码弹窗失效，防止退出后重新写入密钥。 */
export function invalidateUnlockFlow() { _sessionGeneration++; }
export function unlockGeneration() { return _sessionGeneration; }
