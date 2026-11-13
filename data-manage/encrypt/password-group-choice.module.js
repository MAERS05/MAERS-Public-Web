/** 密码组选取组件：组按钮、选择校验，以及选择窗口内的新建与恢复流程。 */
import { getSessionKeysRaw } from './crypto.module.js';
import { loadKeyring, passwordGroups, groupKeyring, unlockWithPassword } from './keyring.module.js';
import { activatePasswordGroup, canWriteKeyring, ensureUnlocked, recoverWithCodeFlow, unlockGeneration } from './auth-flow.module.js';
import { openFormModal, escapeHtml, cryptoIconHtml } from './lock-dialog.module.js';
import { createPasswordGroup } from './password-group-actions.module.js';
import { Toast } from '../../shared/toast.module.js';

/** 与前端解锁窗口一致的紧凑方框按钮。 */
export function groupChoices(groups, selected, current) {
    return groups.map(group => {
        const active = group.id === (selected || current);
        const name = (group.id === current ? '当前:' : '') + (group.name || '默认组');
        return `<button type="button" class="mlock-unlocked-group mlock-group-choice" ` +
            `data-group-choice="${escapeHtml(group.id)}" aria-pressed="${active}" ` +
            `${group.id === current ? 'disabled' : ''}>${escapeHtml(name)}</button>`;
    }).join('');
}

export function bindGroupChoices(modal, value, host, onChange = () => {}) {
    host.onclick = event => {
        const button = event.target.closest('[data-group-choice]');
        if (!button || button.disabled || modal.el.querySelector('[data-act="ok"]').disabled) return;
        value.value = button.dataset.groupChoice;
        host.querySelectorAll('[data-group-choice]').forEach(choice => {
            choice.setAttribute('aria-pressed', String(choice === button));
        });
        onChange();
    };
}

/** 加密前选择自建组，没有内容组时先创建，换组时列出其余目标组。 */

export async function choosePasswordGroup({
    changeFrom,
    title = changeFrom ? '更换密码组' : '选择加密密码',
    sub = changeFrom ? '' : '文件夹或相册整体加密时，内部内容使用同一组'
} = {}) {
    let ring = await loadKeyring(true);
    if (!ring) {
        if (!(await ensureUnlocked())) return null;
        ring = await loadKeyring(true);
    }
    if (!passwordGroups(ring).length) return createPasswordGroup();
    const selected = changeFrom ? '' : passwordGroups(ring)[0].id;

    return new Promise((resolve) => {
        const modal = openFormModal({
            title,
            sub,
            focusDialog: true,
            confirmText: changeFrom ? '更换' : '加密',
            bodyHtml: `
                <span class="mlock-help">${cryptoIconHtml('password-group', 14)} 密码组</span>
                <input type="hidden" class="mlock-input" data-name="group" value="${escapeHtml(selected)}">
                <div class="mlock-unlocked-groups" data-group-choices role="group" aria-label="密码组">${groupChoices(passwordGroups(ring), selected, changeFrom)}</div>
                <input class="mlock-input" data-name="pwd" type="password" autocomplete="current-password"
                    aria-label="所选密码组的密码" placeholder="输入所选组的密码" hidden>
                <button type="button" class="mlock-btn-secondary" data-recover-group hidden>忘记密码？使用恢复码重置</button>
                <button type="button" class="mlock-btn-secondary" data-create-group>＋新建密码组</button>`,
            onCancel: () => resolve(null),
            onSubmit: async ({ group, pwd }) => {
                const slot = groupKeyring(ring, group);
                if (!slot || group === changeFrom) return '请选择密码组';
                if (canWriteKeyring() && !Object.hasOwn(getSessionKeysRaw(), group)) {
                    if (!(await ensureUnlocked(group))) return '无法恢复本机组密钥，请重新进入后台';
                }
                if (!Object.hasOwn(getSessionKeysRaw(), group)) {
                    if (!pwd) return '请输入所选组的密码';
                    const generation = unlockGeneration();
                    const raw = await unlockWithPassword(slot, pwd);
                    if (select.value !== group) return false;
                    if (generation !== unlockGeneration()) return '解锁状态已变化，请重试';
                    if (!raw) return '密码不正确';
                    if (!(await activatePasswordGroup(ring, group, raw, generation)).length) return '解锁状态已变化，请重试';
                }
                resolve(group);
                return true;
            }
        });
        const select = modal.el.querySelector('[data-name="group"]');
        const password = modal.el.querySelector('[data-name="pwd"]');
        const recovery = modal.el.querySelector('[data-recover-group]');
        const updatePasswordField = () => {
            password.value = '';
            password.hidden = canWriteKeyring() || !select.value || Object.hasOwn(getSessionKeysRaw(), select.value);
            recovery.hidden = password.hidden || !canWriteKeyring() || !groupKeyring(ring, select.value)?.rc;
            modal.el.querySelector('.mlock-hint').style.display = 'none';
        };
        const choices = modal.el.querySelector('[data-group-choices]');
        bindGroupChoices(modal, select, choices, updatePasswordField);
        updatePasswordField();

        const openChild = async (action) => {
            if (modal.el.querySelector('[data-act="ok"]').disabled || modal.el.style.display === 'none') return;
            modal.el.style.display = 'none';
            try {
                await action();
            } catch (error) {
                Toast.error(error.message);
            } finally {
                modal.el.style.display = '';
                updatePasswordField();
                if (modal.el.isConnected) modal.el.querySelector('.mlock-box').focus();
            }
        };
        modal.el.querySelector('[data-create-group]').onclick = () => openChild(async () => {
            const id = await createPasswordGroup();
            if (!id) return;
            ring = await loadKeyring();
            select.value = id;
            choices.innerHTML = groupChoices(passwordGroups(ring), id, changeFrom);
        });
        recovery.onclick = () => openChild(async () => {
            const id = select.value;
            const generation = unlockGeneration();
            const raw = await recoverWithCodeFlow(groupKeyring(ring, id), id);
            if (!raw || generation !== unlockGeneration()) return;
            ring = await loadKeyring();
        });
    });
}
