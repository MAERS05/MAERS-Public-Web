/** 密码组解锁：多个密码分别校验、会话累积与逐组锁回，沿用同一个线上隐藏入口。 */
import { getSessionKeysRaw, clearSessionKey } from './crypto.module.js';
import { loadKeyring, passwordGroups, unlockWithPassword, unwrapContentGroups } from './keyring.module.js';
import { setSessionKeyRaw } from './crypto.module.js';
import { openFormModal, escapeHtml, cryptoIconHtml } from './lock-dialog.module.js';
import { activatePasswordGroup, unlockGeneration } from './auth-flow.module.js';

/** 独立校验每个密码，单项失败不会撤销之前成功的组。 */
export async function unlockPasswords(passwords, ring, generation = unlockGeneration()) {
    const result = [];
    const groups = [{ ...ring, id: 'default' }, ...passwordGroups(ring).filter(group => group.id !== 'default')];
    for (const password of passwords) {
        const ids = [];
        if (password) {
            for (const group of groups) {
                if (ids.includes(group.id) || generation !== unlockGeneration()) continue;
                const raw = await unlockWithPassword(group, password);
                if (raw) ids.push(...await activatePasswordGroup(ring, group.id, raw, generation));
            }
            if (ring.content && generation === unlockGeneration()) {
                const raw = await unlockWithPassword(ring.content, password);
                if (raw) {
                    const content = await unwrapContentGroups(ring, raw);
                    if (generation === unlockGeneration()) {
                        for (const [id, key] of content) setSessionKeyRaw(key, id);
                        ids.push('content', ...content.keys());
                    }
                }
            }
        }
        result.push(ids);
    }
    return result;
}

let pending;
export function openGroupUnlock({ reload = true, onMaster, keyring } = {}) {
    if (!pending)
        pending = show(reload, onMaster, keyring).finally(() => {
            pending = null;
        });
    return pending;
}

async function show(reload, onMaster, keyring) {
    const ring = keyring ?? await loadKeyring(true);
    if (!ring) return null;
    const generation = unlockGeneration();
    let changed = false;
    let processing = false;
    let masterVerified = false;
    return new Promise((resolve) => {
        const finish = (submitted = false) => {
            const hasKeys = Object.keys(getSessionKeysRaw()).length > 0;
            resolve(hasKeys);
            if (submitted && masterVerified && onMaster) onMaster();
            else if (changed && reload) window.location.reload();
        };
        const modal = openFormModal({
            icon: 'password-group',
            title: onMaster ? '输入密码' : '密码组',
            confirmText: '解锁',
            cancelText: '关闭',
            bodyHtml:
                '<div class="mlock-unlocked-groups" data-role="unlocked-groups"></div><div data-role="password-rows"></div>' +
                '<button type="button" class="mlock-btn-secondary" data-op="add-password">＋添加密码</button>',
            onCancel: finish,
            onSubmit: async () => {
                const rows = [...modal.el.querySelectorAll('[data-password-row]')];
                const passwords = rows.map((row) => row.querySelector('input').value);
                if (!passwords.some(Boolean)) {
                    if (!changed) return '请输入密码';
                    finish(true);
                    return true;
                }
                processing = true;
                let results;
                try {
                    results = await unlockPasswords(passwords, ring, generation);
                } finally {
                    processing = false;
                }
                if (generation !== unlockGeneration()) return '解锁操作已失效，请重新打开';
                masterVerified ||= results.some((ids) => ids.includes('default'));
                let failures = 0;
                rows.forEach((row, i) => {
                    const input = row.querySelector('input'),
                        error = row.querySelector('[role="alert"]');
                    if (!passwords[i]) return;
                    if (results[i].length) {
                        input.value = '';
                        input.removeAttribute('aria-invalid');
                        error.textContent = '';
                        changed = true;
                    } else {
                        failures++;
                        input.setAttribute('aria-invalid', 'true');
                        error.textContent = '密码不正确';
                    }
                });
                renderUnlocked();
                if (failures)
                    return changed
                        ? '正确的密码已生效。修正标记的输入栏，或关闭窗口查看已解锁内容'
                        : '请修正标记的输入栏';
                finish(true);
                return true;
            }
        });
        modal.el.querySelector('.mlock-box').classList.add('mlock-box--settings');
        const renderUnlocked = () => {
            const ids = getSessionKeysRaw();
            const groups = passwordGroups(ring).filter((group) => ids[group.id]);
            const chips = groups.map(group => {
                const name = escapeHtml(group.name || '默认组');
                return `<button type="button" class="mlock-unlocked-group" data-lock-group="${escapeHtml(group.id)}" ` +
                    `aria-label="锁回${name}" title="锁回${name}">${name}</button>`;
            });
            if (groups.length || ids.default) {
                chips.push('<button type="button" class="mlock-btn-secondary mlock-lock-all" data-lock-group="all" ' +
                    `aria-label="全部锁回" title="全部锁回">${cryptoIconHtml('encryption', 16)}</button>`);
            }
            modal.el.querySelector('[data-role="unlocked-groups"]').innerHTML = chips.join('');
        };
        const addRow = () => {
            if (processing) return;
            const host = modal.el.querySelector('[data-role="password-rows"]');
            if (host.children.length >= 20) return;
            const row = document.createElement('div');
            row.dataset.passwordRow = '';
            row.className = 'mlock-password-row';
            row.innerHTML =
                '<input type="password" class="mlock-input" autocomplete="current-password" aria-label="解锁密码" placeholder="输入密码">' +
                '<button type="button" class="mlock-btn-secondary" aria-label="移除此密码栏">×</button><span class="mlock-bad" role="alert"></span>';
            row.querySelector('button').onclick = () => {
                if (processing) return;
                if (host.children.length > 1) {
                    row.querySelector('input').value = '';
                    row.remove();
                }
            };
            host.append(row);
            row.querySelector('input').focus();
        };
        modal.el.querySelector('[data-op="add-password"]').onclick = addRow;
        modal.el.querySelector('[data-role="unlocked-groups"]').onclick = (event) => {
            const button = event.target.closest('[data-lock-group]');
            if (!button || processing) return;
            const group = button.dataset.lockGroup;
            if (group === 'default' || group === 'all') masterVerified = false;
            clearSessionKey(group === 'all' ? undefined : group);
            changed = true;
            if (reload) {
                modal.close();
                finish();
            } else renderUnlocked();
        };
        renderUnlocked();
        addRow();
        requestAnimationFrame(() => modal.el.querySelector('[data-password-row] input')?.focus());
    });
}
