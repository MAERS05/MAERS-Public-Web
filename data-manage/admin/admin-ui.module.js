/**
 * @module data-manage/admin/admin-ui.module.js
 * @description UI组件 - SaveButton + Feedback 反馈系统
 * @version 1.0.0 - ES6 Module
 */

import { Toast } from '../../shared/toast.module.js';

export const SaveButton = {
    element: null,
    onSave: null,
    onCancel: null,
    RESET_DELAY: 1000,

    init(container, onSave, onCancel) {
        const old = document.querySelectorAll('.global-save-bar');
        old.forEach(el => el.remove());

        this.onSave = onSave;
        this.onCancel = onCancel;

        this.element = document.createElement('div');
        this.element.className = 'global-save-bar';
        this.element.innerHTML = `
            <button id="global-cancel-btn" class="cancel-btn">放弃修改</button>
            <button id="global-save-btn" class="save-btn" disabled>保存修改</button>
        `;

        if (!document.getElementById('admin-core-style')) {
            const style = document.createElement('style');
            style.id = 'admin-core-style';
            style.innerHTML = `
                .global-save-bar { position: fixed; bottom: 24px; left: calc(50% + 112px); transform: translate(-50%, 80px); opacity: 0; visibility: hidden; pointer-events: none; padding: 8px; border: 0; border-radius: 12px; background: var(--surface); color: var(--text-main); box-shadow: 0 8px 30px #00000024; z-index: 4000; display: flex; gap: 8px; transition: opacity 180ms ease-out, transform 180ms ease-out; }
                .global-save-bar.active { transform: translate(-50%, 0); opacity: 1; visibility: visible; pointer-events: auto; }
                .global-save-bar button { min-height: 38px; padding: 8px 18px; border: 0; border-radius: 8px; font: inherit; font-weight: 500; }
                .global-save-bar .save-btn { color: var(--on-accent); background: var(--accent); }
                .global-save-bar .save-btn:hover { background: var(--accent-strong); }
                .global-save-bar .save-btn:disabled { color: var(--text-sub); background: var(--surface-soft); }
                .global-save-bar .cancel-btn { color: var(--text-sub); background: var(--surface-soft); }
                .global-save-bar .cancel-btn:hover { color: var(--text-main); background: var(--surface-hover); }
                .is-selected { outline: 2px solid var(--accent); outline-offset: 2px; position: relative; }
                .is-selected[data-order-num]::before { content: attr(data-order-num); position: absolute; top: 6px; left: 6px; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; background: var(--accent); color: var(--on-accent); font-size: 12px; z-index: 10; }
                .is-deleted { opacity: .48; position: relative; }
                .is-deleted .card-title, .is-deleted .item-title, .is-deleted .space-title, .is-deleted .name { text-decoration: line-through; }
            `;
            document.head.appendChild(style);
        }
        document.body.appendChild(this.element);

        const saveBtn = document.getElementById('global-save-btn');
        const cancelBtn = document.getElementById('global-cancel-btn');

        saveBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            if (!this.onSave) return;
            saveBtn.textContent = '保存中...';
            saveBtn.disabled = true;
            // 回调返回 false 或抛出异常均视为失败：保留保存条与编辑内容，允许重试
            let ok = false;
            try {
                ok = (await this.onSave()) !== false;
            } catch (error) {
                console.error('[SaveButton] 保存失败:', error);
                Feedback.notifySaveFail('保存失败: ' + error.message);
            }
            if (!ok) {
                saveBtn.textContent = '保存修改';
                saveBtn.disabled = false;
                return;
            }
            saveBtn.textContent = '已保存';
            setTimeout(() => { this.hide(); saveBtn.textContent = '保存修改'; saveBtn.disabled = false; }, this.RESET_DELAY);
        };

        cancelBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            if (this.onCancel) await this.onCancel();
            this.hide();
        };
    },

    show() {
        if (this.element && !this.element.classList.contains('active')) {
            this.element.classList.add('active');
            document.getElementById('global-save-btn').disabled = false;
        }
    },

    hide() {
        if (this.element) this.element.classList.remove('active');
    },

    /**
     * Initialize Unified Save Logic for Multiple Managers
     * @param {Array<Function>} getManagers - Array of functions returning manager instances
     * @param {Function} onJointSave - Async function to save all contents
     * @param {Function} onJointCancel - Async function to cancel all contents
     */
    initUnified(getManagers, onJointSave, onJointCancel) {
        this.init(document.body, async () => {
            try {
                const result = await onJointSave();
                this.checkUnifiedDirty(getManagers);
                return result;
            } catch (e) {
                console.error("[DEBUG] Unified Save Failed", e);
                Feedback.notifySaveFail("保存失败: " + e.message);
                return false;
            }
        }, async () => {
            try {
                await onJointCancel();
                this.checkUnifiedDirty(getManagers);
            } catch (e) {
                console.error("[DEBUG] Unified Cancel Failed", e);
                Feedback.toast("取消失败: " + e.message, 'error');
            }
        });

        // Hook into managers
        setTimeout(() => {
            getManagers.forEach(getManager => {
                const manager = getManager();
                if (manager) {
                    this._hookManager(manager, () => this.checkUnifiedDirty(getManagers));
                }
            });
        }, 500);

        // Expose a helper to re-hook lazy loaded managers (like Tags)
        this.reHook = () => {
            getManagers.forEach(getManager => {
                const manager = getManager();
                if (manager) {
                    this._hookManager(manager, () => this.checkUnifiedDirty(getManagers));
                }
            });
        };
    },

    _hookManager(manager, checkFn) {
        if (manager._unifiedHook) return;
        manager._unifiedHook = true;
        const originalOnChange = manager.onChange;
        manager.onChange = () => {
            if (originalOnChange) originalOnChange();
            checkFn();
        };
    },

    checkUnifiedDirty(getManagers) {
        let isDirty = false;
        getManagers.forEach(getManager => {
            const m = getManager();
            if (m && m.getSnapshot() !== m.initialSnapshot) isDirty = true;
        });

        if (isDirty) this.show();
        else this.hide();
    }
};

export const Feedback = {
    toast(msg, type = 'info') {
        if (Toast) {
            Toast[type](msg);
        } else if (window.MAERS?.Toast) {
            window.MAERS.Toast[type](msg);
        } else {
            console.warn(`[MAERS.Feedback] ${type}: ${msg}`);
        }
    },

    notifySuccess(msg) { this.toast(msg || "操作成功", 'success'); },
    notifyError(msg) { this.toast(msg || "操作失败", 'error'); },

    notifySaveSuccess(msg) { this.toast(msg || "保存成功", 'success'); },
    notifySaveFail(msg) { this.toast(msg || "保存失败", 'error'); },

    notifyAddSuccess(msg) { this.toast(msg || "创建成功", 'success'); },
    notifyAddFail(msg) { this.toast(msg || "添加失败", 'error'); },

    notifyDeleteSuccess(msg) { this.toast(msg || "删除成功", 'success'); },

    notifyEditSuccess(msg) { this.toast(msg || "修改成功", 'success'); },

    notifyCancel(msg) { this.toast(msg || "修改已取消", 'info'); }
};
