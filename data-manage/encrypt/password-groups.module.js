/** 密码组管理入口：列表展示、展开状态与操作调度，具体操作和子窗口各自封装。 */
import { getSessionKeysRaw, clearSessionKey } from './crypto.module.js';
import { loadKeyring, passwordGroups, groupKeyring } from './keyring.module.js';
import { ensureUnlocked, recoverWithCodeFlow } from './auth-flow.module.js';
import { openGroupUnlock } from './group-unlock.module.js';
import { openFormModal, escapeHtml } from './lock-dialog.module.js';
import { createPasswordGroup, connectToMaster, editName, editPassword, deletePasswordGroup, request } from './password-group-actions.module.js';
import { groupContents } from './password-group-content.module.js';
import { Toast } from '../../shared/toast.module.js';

export { createPasswordGroup } from './password-group-actions.module.js';
export { choosePasswordGroup } from './password-group-choice.module.js';

export async function openPasswordGroups() {
    if (!(await ensureUnlocked())) return;
    let reload = false;
    let finish;
    const closed = new Promise(resolve => { finish = resolve; });
    const complete = () => {
        finish();
        if (reload) window.location.reload();
    };
    const modal = openFormModal({
        title: '密码组',
        sub: '主密码用于解锁所有组，加密内容使用各组自己的密码',
        confirmText: '完成',
        cancelText: '', closeButton: true,
        bodyHtml:
            '<div data-role="groups"></div><div class="mlock-actions">' +
            '<button class="mlock-btn-secondary" type="button" data-action="create">＋新建密码组</button>' +
            '<button class="mlock-btn-secondary" type="button" data-action="unlock">解锁其他组</button></div>',
        onSubmit: () => {
            complete();
            return true;
        },
        onCancel: complete
    });
    modal.el.querySelector('.mlock-box').classList.add('mlock-box--settings');
    const refresh = async () => {
        const host = modal.el.querySelector('[data-role="groups"]');
        const expanded = new Set([...host.querySelectorAll('[data-password-group][open]')]
            .map(group => group.dataset.passwordGroup));
        host.textContent = '正在更新密码组…';
        const ring = await loadKeyring(true),
            { items } = await request('/api/crypto/groups/catalog');
        const keys = getSessionKeysRaw();
        host.innerHTML = passwordGroups(ring)
            .map((group) => {
                const count = items.filter((item) => item.group === group.id).length;
                const status = group.id === 'default' ? '主密码' : group.master_wrap ? '主密码可解锁' : '待接入主密码';
                return (
                    `<details class="mlock-status mlock-password-group" data-password-group="${escapeHtml(group.id)}" ${expanded.has(group.id) ? 'open' : ''}>` +
                    `<summary><b>${escapeHtml(group.name || '默认组')}</b> · ${status} · ${count} 项 · ${keys[group.id] ? '已解锁' : '未解锁'}</summary>` +
                    '<div class="mlock-actions mlock-group-actions">' +
                    [
                        ...(group.id !== 'default' && !group.master_wrap ? [['connect', '接入主密码']] : []),
                        ['name', '重命名'],
                        ['password', '重设密码'],
                        ['lock', group.id === 'default' ? '退出后台验证' : '锁回内容'],
                        ['contents', '查看内容'],
                        ['migrate', '迁移内容'],
                        ...(group.id !== 'default' && !group.master_wrap && group.rc ? [['recover', '接入旧组恢复码']] : []),
                        ['delete', '删除组']
                    ]
                        .map(
                            ([action, text]) =>
                                `<button type="button" class="mlock-btn-secondary" data-action="${action}" data-group="${escapeHtml(group.id)}" ${action === 'delete' && count ? 'title="存在加密内容，无法删除"' : ''} ${action === 'delete' && (count || group.id === 'default') ? 'disabled' : ''}>${text}</button>`
                        )
                        .join('') +
                    '</div></details>'
                );
            })
            .join('') || '<p class="mlock-help">尚无密码组，请先新建</p>';
    };
    let working = false;
    modal.el.onclick = async (event) => {
        const button = event.target.closest('[data-action]');
        if (!button || button.disabled || working || !modal.el.isConnected) return;
        working = true;
        const id = button.dataset.group,
            action = button.dataset.action;
        modal.el.style.display = 'none';
        try {
            if (action === 'create') await createPasswordGroup();
            if (action === 'unlock') {
                reload = !!(await openGroupUnlock({ reload: false })) || reload;
            }
            if (action === 'connect') reload = !!(await connectToMaster(id)) || reload;
            if (action === 'name') await editName(id);
            if (action === 'password') await editPassword(id);
            if (action === 'contents') await groupContents(id);
            if (action === 'migrate') reload = !!(await groupContents(id, true)) || reload;
            if (action === 'lock') {
                clearSessionKey(id);
                reload = true;
            }
            if (action === 'recover') {
                const ring = await loadKeyring(true),
                    raw = await recoverWithCodeFlow(groupKeyring(ring, id), id);
                if (raw) { await connectToMaster(id); reload = true; }
            }
            if (action === 'delete') await deletePasswordGroup(id);
            if (!getSessionKeysRaw().default) {
                const { logoutSession } = await import('./admin-lock.module.js');
                modal.close();
                finish();
                await logoutSession();
                return;
            }
            await refresh();
        } catch (error) {
            Toast.error(error.message);
        } finally {
            working = false;
            if (modal.el.isConnected) modal.el.style.display = '';
        }
    };
    try {
        await refresh();
    } catch (error) {
        modal.close();
        finish();
        Toast.error(error.message);
    }
    return closed;
}
