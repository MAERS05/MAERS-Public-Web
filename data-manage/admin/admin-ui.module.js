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
            <button id="global-cancel-btn" class="cancel-btn">取消修改</button>
            <button id="global-save-btn" class="save-btn" disabled>保存修改</button>
        `;

        if (!document.getElementById('admin-core-style')) {
            const style = document.createElement('style');
            style.id = 'admin-core-style';
            style.innerHTML = `
                .global-save-bar { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%) translateY(100px); background: #1e1e24; padding: 8px 10px; border-radius: 50px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); transition: 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); z-index: 2147483647 !important; display: flex; align-items: center; gap: 8px; border: 1px solid rgba(255,255,255,0.08); }
                .global-save-bar.active { transform: translateX(-50%) translateY(0); }
                .global-save-bar button { border: none; padding: 10px 20px; border-radius: 30px; font-weight: 600; cursor: pointer; font-size: 14px; transition: all 0.2s; }
                .save-btn { background: #2ed573; color: #111; }
                .save-btn:hover { box-shadow: 0 0 15px rgba(46, 213, 115, 0.4); transform: scale(1.05); }
                .save-btn:disabled { background: #333; color: #666; cursor: not-allowed; box-shadow: none; transform: none; }
                .cancel-btn { background: transparent; color: #ff6b81; border: 1px solid rgba(255, 107, 129, 0.3); }
                .cancel-btn:hover { background: rgba(255, 107, 129, 0.1); border-color: #ff6b81; }
                .is-selected { outline: 2px solid #78ffd6 !important; position: relative; }
                .is-selected::before { content: attr(data-order-num); position: absolute; top: 5px; left: 5px; background: #78ffd6; color: #111; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; z-index: 10; box-shadow: 0 2px 8px rgba(120, 255, 214, 0.4); }
                .is-deleted { filter: grayscale(100%); position: relative; }
                .is-deleted::after { content: ''; position: absolute; top: 50%; left: 0; right: 0; height: 2px; background: #ff4757; pointer-events: none; }
                .admin-edit-badge {
                    position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
                    background: #ffd32a; color: #000; padding: 4px 14px;
                    border-radius: 4px; font-weight: 900; font-size: 13px;
                    z-index: 9999; letter-spacing: 1px;
                    cursor: pointer; transition: all 0.3s ease; user-select: none;
                }
                .admin-edit-badge.minimized {
                    background: rgba(255, 211, 42, 0.15);
                    color: transparent;
                    box-shadow: none;
                }
                .admin-edit-badge.minimized:hover {
                    background: rgba(255, 211, 42, 0.5);
                }
                }
            `;
            document.head.appendChild(style);
        }
        document.body.appendChild(this.element);

        // Inject persistent EDIT badge with localStorage persistence
        if (!document.getElementById('admin-edit-badge')) {
            const badge = document.createElement('div');
            badge.id = 'admin-edit-badge';
            badge.className = 'admin-edit-badge';

            // Restore state
            const isMinimized = localStorage.getItem('maers_admin_badge_minimized') === 'true';
            if (isMinimized) badge.classList.add('minimized');

            badge.textContent = 'EDIT';
            badge.onclick = () => {
                const nowMinimized = badge.classList.toggle('minimized');
                localStorage.setItem('maers_admin_badge_minimized', nowMinimized);
            };
            badge.title = "点击隐藏/显示";
            document.body.appendChild(badge);
        }

        const saveBtn = document.getElementById('global-save-btn');
        const cancelBtn = document.getElementById('global-cancel-btn');

        saveBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            if (!this.onSave) return;
            saveBtn.textContent = '保存中...';
            saveBtn.disabled = true;
            await this.onSave();
            saveBtn.textContent = '✅ 已保存';
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
        console.log("[DEBUG] SaveButton.initUnified called");
        this.init(document.body, async () => {
            console.log("[DEBUG] SaveButton: onJointSave triggered");
            try {
                await onJointSave();
                console.log("[DEBUG] SaveButton: onJointSave completed");
                this.checkUnifiedDirty(getManagers);
            } catch (e) {
                console.error("[DEBUG] Unified Save Failed", e);
                Feedback.notifySaveFail("保存失败: " + e.message);
            }
        }, async () => {
            console.log("[DEBUG] SaveButton: onJointCancel triggered");
            try {
                await onJointCancel();
                console.log("[DEBUG] SaveButton: onJointCancel completed");
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
        console.log(`[DEBUG] Feedback.toast called: ${msg} (${type})`);
        if (Toast) {
            Toast[type](msg);
        } else if (window.MAERS?.Toast) {
            window.MAERS.Toast[type](msg);
        } else {
            console.log(`[${type}] ${msg}`);
            if (type === 'error') alert(msg);
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
