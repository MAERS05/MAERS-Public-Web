/** 密码验证流程：主密码验证、首次设置与恢复码重置；独立于后台管理会话。 */
import { getSessionKey, setSessionKeyRaw } from './crypto.module.js';
import { canWriteKeyring, loadKeyring, unlockWithPassword, unlockWithRecovery, createKeyring, saveKeyring, rewrapPassword } from './keyring.module.js';
import { openFormModal, showRecoveryCodeModal } from './lock-dialog.module.js';
import { Toast } from '../../shared/toast.module.js';

const MIN_PASSWORD_LEN = 8;

// ══════════════════════════════════════════════
// 1. 核心操作
// ══════════════════════════════════════════════

export { canWriteKeyring } from './keyring.module.js';

/** 校验新主密码，返回错误文字或 null */
export function validateNewPassword(p1, p2) {
    if (!p1 || p1.length < MIN_PASSWORD_LEN) return `主密码至少 ${MIN_PASSWORD_LEN} 位`;
    if (p1 !== p2) return '两次输入的密码不一致';
    return null;
}

let _pendingUnlock = null;
let _sessionGeneration = 0;

/**
 * 确保当前会话已解锁（有密钥）
 * - 已有会话：直接返回
 * - 已设置主密码：弹出密码框，密码错误当场提示
 * - 未设置（仅本地后台）：引导设置主密码并生成恢复码
 * @returns {Promise<CryptoKey|null>} 取消则返回 null
 */
export async function ensureUnlocked() {
    const existing = await getSessionKey();
    if (existing) return existing;
    // 并发调用共用同一个弹窗
    if (!_pendingUnlock) {
        _pendingUnlock = _unlockFlow().finally(() => { _pendingUnlock = null; });
    }
    return _pendingUnlock;
}

async function _unlockFlow() {
    const generation = _sessionGeneration;
    const keyring = await loadKeyring(true);
    if (!keyring) {
        if (!canWriteKeyring()) {
            Toast.error('尚未设置主密码，请先在电脑端本地后台完成设置');
            return null;
        }
        return _setupFlow();
    }

    const dek = await new Promise((resolve) => {
        openFormModal({
            icon: '🔐',
            title: '输入主密码',
            sub: '验证后，本标签页内无需重复输入；不会自动取消文件加密',
            fields: [{ name: 'pwd', type: 'password', placeholder: '输入主密码...', autocomplete: 'current-password' }],
            confirmText: '确定',
            onSubmit: async ({ pwd }) => {
                if (!pwd) return '密码不能为空';
                const raw = await unlockWithPassword(keyring, pwd);
                if (!raw) return '主密码不正确';
                resolve(raw);
                return true;
            },
            onCancel: () => resolve(null),
            link: canWriteKeyring()
                ? { text: '忘记主密码？使用恢复码重置', onClick: async () => resolve(await recoverWithCodeFlow(keyring)) }
                : null
        });
    });
    if (!dek || generation !== _sessionGeneration) return null;

    setSessionKeyRaw(dek);
    Toast.success('已验证主密码，本标签页内无需重复输入');
    return getSessionKey();
}

/** 首次设置主密码：生成随机数据密钥与恢复码并写入密钥环 */
async function _setupFlow() {
    const generation = _sessionGeneration;
    const pwd = await new Promise((resolve) => {
        openFormModal({
            icon: '🛡️',
            title: '设置主密码',
            sub: '首次使用加密功能。主密码用于解锁全部私密内容',
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
        await saveKeyring(keyring);
        await showRecoveryCodeModal(recoveryCode);
        if (generation !== _sessionGeneration) return null;
        setSessionKeyRaw(dekRaw);
        Toast.success('🛡️ 主密码已设置');
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
export function recoverWithCodeFlow(keyring) {
    return new Promise((resolve) => {
        openFormModal({
            icon: '🧩',
            title: '使用恢复码重置主密码',
            sub: '已加密的数据不受影响，重置后用新密码解锁',
            fields: [
                { name: 'code', type: 'text', placeholder: '恢复码 XXXX-XXXX-...' },
                { name: 'pwd', type: 'password', placeholder: `新主密码（至少 ${MIN_PASSWORD_LEN} 位）`, autocomplete: 'new-password' },
                { name: 'pwd2', type: 'password', placeholder: '再次输入新主密码', autocomplete: 'new-password' }
            ],
            confirmText: '重置',
            onSubmit: async ({ code, pwd, pwd2 }) => {
                const err = validateNewPassword(pwd, pwd2);
                if (err) return err;
                const raw = await unlockWithRecovery(keyring, code);
                if (!raw) return '恢复码不正确';
                try {
                    await saveKeyring(await rewrapPassword(keyring, raw, pwd));
                } catch (e) {
                    return '保存失败: ' + e.message;
                }
                Toast.success('主密码已重置');
                resolve(raw);
                return true;
            },
            onCancel: () => resolve(null)
        });
    });
}

/** 使尚未结束的密码弹窗失效，防止退出后重新写入密钥。 */
export function invalidateUnlockFlow() { _sessionGeneration++; }
