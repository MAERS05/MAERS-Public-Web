/** 主密钥轮换：重新包裹自建组的密钥，兼容重加密旧默认组记录。 */
import { localFetch } from '../api-client.module.js';
import { createKeyring, loadKeyring, unlockWithPassword, unwrapMasterGroups, wrapMasterGroup } from './keyring.module.js';
import { importDataKey, decryptRecord, encryptRecord, fingerprintRecord, accessTokenHashForRaw } from './crypto.module.js';
import { activatePasswordGroup } from './auth-flow.module.js';
import { showRecoveryCodeModal } from './lock-dialog.module.js';
import { Toast } from '../../shared/toast.module.js';

async function request(path, body) {
    const response = await localFetch(path, body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    } : { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || '密钥轮换失败');
    return result;
}

/** 任何一条记录无法解密就整批停止；包含加密文件夹中的嵌套密文。 */
export async function rotateSnapshots(snapshots, oldKey, newKey) {
    const rotate = async value => {
        if (Array.isArray(value)) {
            const items = [];
            for (const item of value) items.push(await rotate(item));
            return items;
        }
        if (!value || typeof value !== 'object') return value;
        if (typeof value._enc === 'string') {
            if (value._group && value._group !== 'default') return value;
            const plain = await decryptRecord(value._enc, oldKey);
            if (plain === null) throw new Error('存在无法解密的记录，轮换已停止，原数据未改动');
            const next = await rotate(plain);
            const encrypted = await encryptRecord(next, newKey);
            if (JSON.stringify(await decryptRecord(encrypted, newKey)) !== JSON.stringify(next)) {
                throw new Error('重加密校验失败，原数据未改动');
            }
            return { ...value, _enc: encrypted };
        }
        const result = {};
        for (const [key, item] of Object.entries(value)) result[key] = await rotate(item);
        return result;
    };
    const result = [];
    for (const snapshot of snapshots) result.push({ ...snapshot, data: await rotate(snapshot.data) });
    return result;
}

export async function rotateDataKey(currentPassword, newPassword) {
    const ring = await loadKeyring(true);
    if (ring.content && await unlockWithPassword(ring.content, newPassword)) throw Error('主密码不能与副密码相同');
    const raw = await unlockWithPassword(ring, currentPassword);
    if (!raw) throw new Error('当前主密码不正确');
    const snapshot = await request('/api/crypto/rotation/export');
    if (snapshot.keyring_revision !== await fingerprintRecord(ring)) throw new Error('密钥环已变化，请重新打开设置');
    const { keyring, recoveryCode, dekRaw } = await createKeyring(newPassword, ring.media_base || '');
    if (ring.master_only) keyring.master_only = true;
    const newKey = await importDataKey(dekRaw);
    if (ring.groups) {
        keyring.groups = { ...ring.groups };
        for (const [id, rawGroupKey] of await unwrapMasterGroups(ring, raw)) {
            const group = ring.groups[id];
            keyring.groups[id] = { ...group, master_wrap: await wrapMasterGroup(id, group, rawGroupKey, newKey) };
        }
    }
    if (ring.name) keyring.name = ring.name;
    if (ring.content) {
        const linked = await unwrapMasterGroups({ groups: { content: ring.content } }, raw);
        keyring.content = { ...ring.content,
            master_wrap: await wrapMasterGroup('content', ring.content, linked.get('content'), newKey) };
    }
    const files = await rotateSnapshots(snapshot.files, await importDataKey(raw), newKey);
    // 用户先保存新的恢复码，随后才修改持久化数据。
    await showRecoveryCodeModal(recoveryCode);
    keyring.updated = new Date().toISOString();
    const result = await request('/api/crypto/rotation', {
        expected_dek_id: snapshot.dek_id, expected_keyring_revision: snapshot.keyring_revision,
        keyring, files, token_hash: await accessTokenHashForRaw(dekRaw)
    });
    await activatePasswordGroup(keyring, 'default', dekRaw);
    await loadKeyring(true);
    await (await import('./admin-session.module.js')).ensureAdminSession();
    if (result.token_pending) {
        const { syncTokenToWorker } = await import('./crypto-settings.module.js');
        if (!(await syncTokenToWorker({ silent: true }))) {
            Toast.error('密文和新密钥环已保存；私密图片令牌撤销未完成，发布已暂停，请重试同步令牌');
            return { ...result, pending: true };
        }
    }
    Toast.success('主密钥已轮换，发布新版本后使用新密码');
    return result;
}
