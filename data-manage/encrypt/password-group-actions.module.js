/** 密码组操作：创建、改名、改密、接入主密码及空组删除；复用鉴权请求与表单。 */
import { localFetch } from '../api-client.module.js';
import { getSessionKeyRaw, setSessionKeyRaw, clearSessionKey, importDataKey } from './crypto.module.js';
import {
    loadKeyring,
    passwordGroups,
    groupKeyring,
    updateGroup,
    createKeyring,
    saveKeyring,
    rewrapPassword,
    matchesDataKey,
    wrapMasterGroup
} from './keyring.module.js';
import { activatePasswordGroup, ensureUnlocked, validateNewPassword } from './auth-flow.module.js';
import { openFormModal } from './lock-dialog.module.js';
import { Toast } from '../../shared/toast.module.js';

export async function request(path, body) {
    const { ensureAdminSession } = await import('./admin-session.module.js');
    await ensureAdminSession();
    const response = await localFetch(
        path,
        body
            ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : { cache: 'no-store' }
    );
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '密码组操作失败');
    return result;
}

export function form(options) {
    return new Promise((resolve) =>
        openFormModal({
            ...options,
            onSubmit: async (values) => {
                const result = await options.submit(values);
                if (typeof result === 'string') return result;
                resolve(result);
                return true;
            },
            onCancel: () => resolve(null)
        })
    );
}

/** 新建组可从管理菜单或加密选择窗口直接进入。 */

export async function createPasswordGroup() {
    if (!(await ensureUnlocked())) return null;
    await request('/api/crypto/groups/catalog');
    const created = await form({
        title: '新建密码组',
        sub: '主密码也能解锁此组，组密码仅解锁此组内容',
        confirmText: '创建密码组',
        fields: [
            { name: 'name', placeholder: '密码组名称（最多 64 字）' },
            { name: 'pwd', type: 'password', placeholder: '密码（至少 8 位）', autocomplete: 'new-password' },
            { name: 'again', type: 'password', placeholder: '再次输入密码', autocomplete: 'new-password' }
        ],
        submit: async ({ name, pwd, again }) => {
            name = name.trim();
            if (!name || name.length > 64) return '请输入 1 至 64 字的组名';
            const error = validateNewPassword(pwd, again);
            if (error) return error;
            const ring = await loadKeyring(true);
            if (passwordGroups(ring).some((g) => g.name === name)) return '组名已存在';
            const masterKey = await currentMasterKey(ring);
            const id = 'g_' + crypto.randomUUID().replaceAll('-', '');
            const { keyring, dekRaw } = await createKeyring(pwd, '', { recovery: false });
            const { v, dek_id, pw } = keyring;
            const master_wrap = await wrapMasterGroup(id, keyring, dekRaw, masterKey);
            await saveKeyring(updateGroup(ring, id, { v, dek_id, pw, name, master_wrap }), ring);
            setSessionKeyRaw(dekRaw, id);
            return { id };
        }
    });
    if (!created) return null;
    // 空组无需图片令牌；实际加密或迁移图片时由后端登记，创建结果立即交回选择窗口。
    return created.id;
}

async function currentMasterKey(ring) {
    const raw = getSessionKeyRaw();
    if (!(await matchesDataKey(ring, raw))) throw new Error('主密码验证已失效，请重新进入后台');
    return importDataKey(raw);
}

/** 用旧组已验证的密钥接入主密码，保留该组原有密码和密文。 */

export async function connectToMaster(id) {
    if (!(await ensureUnlocked()) || !(await ensureUnlocked(id))) return false;
    const ring = await loadKeyring(true);
    const group = groupKeyring(ring, id);
    if (!group) throw new Error('密码组已删除，请刷新');
    if (group.master_wrap) return false;
    const master_wrap = await wrapMasterGroup(id, group, getSessionKeyRaw(id), await currentMasterKey(ring));
    await saveKeyring(updateGroup(ring, id, { ...group, master_wrap }), ring);
    Toast.success('已接入主密码，发布后访客页生效');
    return true;
}

export async function editName(id) {
    const ring = await loadKeyring(true),
        group = groupKeyring(ring, id);
    return form({
        title: '重命名密码组',
        sub: '组名改变不影响密码和关联内容',
        confirmText: '保存修改',
        fields: [{ name: 'name', placeholder: '组名', value: group.name || '默认组' }],
        submit: async ({ name }) => {
            name = name.trim();
            if (!name || name.length > 64) return '请输入 1 至 64 字的组名';
            const current = await loadKeyring(true);
            if (passwordGroups(current).some((g) => g.id !== id && g.name === name)) return '组名已存在';
            if (!groupKeyring(current, id)) return '密码组已删除，请刷新';
            await saveKeyring(updateGroup(current, id, { ...groupKeyring(current, id), name }), current);
            return true;
        }
    });
}

export async function editPassword(id) {
    if (id === 'default') {
        const { openCryptoSettings } = await import('./crypto-settings.module.js');
        await openCryptoSettings();
        return false;
    }
    if (!(await ensureUnlocked(id))) return false;
    return form({
        title: '重设密码组密码',
        sub: '本地直接重设，无需旧密码；关联内容和组名保持不变',
        confirmText: '保存修改',
        fields: [
            { name: 'pwd', type: 'password', placeholder: '新密码（至少 8 位）', autocomplete: 'new-password' },
            { name: 'again', type: 'password', placeholder: '再次输入新密码', autocomplete: 'new-password' }
        ],
        submit: async ({ pwd, again }) => {
            const error = validateNewPassword(pwd, again);
            if (error) return error;
            const ring = await loadKeyring(true),
                slot = groupKeyring(ring, id);
            const raw = getSessionKeyRaw(id);
            if (!(await matchesDataKey(slot, raw))) return '本机管理密钥已变化，请重新进入后台';
            await saveKeyring(updateGroup(ring, id, await rewrapPassword(slot, raw, pwd)), ring);
            await activatePasswordGroup(ring, id, raw);
            return true;
        }
    });
}

export async function deletePasswordGroup(id) {
    const accepted = await form({
        title: '删除空密码组',
        sub: '确认删除此密码组？有关联内容的组不能删除',
        confirmText: '删除密码组', cancelText: '不删了',
        submit: async () => true
    });
    if (!accepted) return false;
    const ring = await loadKeyring(true);
    const groups = { ...ring.groups };
    delete groups[id];
    await saveKeyring({ ...ring, groups }, ring);
    clearSessionKey(id);
    return true;
}
