/** 密码组内容窗口：查看关联项、选择迁移目标及提交批量迁移。 */
import { loadKeyring, passwordGroups } from './keyring.module.js';
import { ensureUnlocked } from './auth-flow.module.js';
import { openFormModal, escapeHtml } from './lock-dialog.module.js';
import { groupChoices, bindGroupChoices } from './password-group-choice.module.js';
import { request, form } from './password-group-actions.module.js';
import { Toast } from '../../shared/toast.module.js';

export async function groupContents(id, migrate = false) {
    if (!(await ensureUnlocked(id))) return false;
    const { items } = await request('/api/crypto/groups/catalog');
    const rows = items.filter((item) => item.group === id);
    const contentHtml = `<div class="mlock-group-items">${rows.length ? rows.map((item, i) => {
        const tag = migrate ? 'label' : 'div';
        const checkbox = migrate ? `<input type="checkbox" data-item="${i}" ${item.locked ? 'disabled' : ''}>` : '';
        return `<${tag} class="mlock-check">${checkbox}<span>${escapeHtml(item.title)}` +
            `<small class="mlock-help"> · ${escapeHtml(item.source)}</small></span></${tag}>`;
    }).join('') : '<p class="mlock-help">暂无关联内容</p>'}</div>`;
    if (!migrate) return form({
        title: '查看内容', confirmText: '关闭', cancelText: '', bodyHtml: contentHtml,
        submit: async () => false
    });
    const ring = await loadKeyring(true);
    const choices = passwordGroups(ring);
    return new Promise((resolve) => {
        const modal = openFormModal({
            title: '迁移内容',
            sub: '勾选内容后可批量迁移到其他密码组',
            focusDialog: true,
            confirmText: '迁移',
            cancelText: '关闭',
            bodyHtml:
                contentHtml + '<span class="mlock-help">目标密码组</span>' +
                `<input type="hidden" data-target-group value="${escapeHtml(id)}">` +
                `<div class="mlock-unlocked-groups" data-group-choices role="group" aria-label="目标密码组">${groupChoices(choices, id, id)}</div>`,
            onCancel: () => resolve(false),
            onSubmit: async () => {
                const selected = [...modal.el.querySelectorAll('[data-item]:checked')].map(
                    (el) => rows[+el.dataset.item]
                );
                if (!selected.length) return '请先勾选内容；锁定项需先解锁所属组';
                const target = modal.el.querySelector('[data-target-group]').value;
                if (target === id) return '请选择另一个密码组';
                modal.el.style.display = 'none';
                try {
                    if (!(await ensureUnlocked(target))) return '目标组尚未解锁';
                    const { changePasswordGroups } = await import('./admin-session.module.js');
                    await changePasswordGroups({
                        group: target,
                        items: selected.map((item) => ({ reference: item.reference, revision: item.revision }))
                    });
                    Toast.success(`已调整 ${selected.length} 项内容`);
                    resolve(true);
                    return true;
                } finally {
                    modal.el.style.display = '';
                }
            }
        });
        bindGroupChoices(modal, modal.el.querySelector('[data-target-group]'),
            modal.el.querySelector('[data-group-choices]'));
        modal.el.querySelector('.mlock-box').classList.add('mlock-box--settings');
    });
}
