/**
 * MAERS Album Admin (photos-admin.module.js)
 * 职责：管理员功能 - 选择、排序、删除、上传
 * 依赖：Controller, View, AdminCore
 * @version 3.0.0 - ES6 Module
 */

// 依赖声明
let Controller, View, AdminCore;

// 依赖注入
export function initAdmin(controller, view, adminCore) {
    Controller = controller;
    View = view;
    AdminCore = adminCore;
    init(); // Explicitly init features when dependencies are ready
}

import { Utils } from '../../../shared/utils.module.js';

let container = null;
let manager = null;

// Initialize admin features
function init() {
    if (!Controller?.State.isAdmin) return;

    container = document.getElementById('gallery-container');

    bindAdminEvents();
    setupGlobalRightClickCancel();
}

// Called by View after data is loaded
export function initManager(dataList) {
    if (!Controller?.State.isAdmin) return;

    if (!AdminCore?.BatchItemManager) {
        console.error('AdminCore.BatchItemManager not found!');
        return;
    }

    manager = new AdminCore.BatchItemManager({
        list: dataList,
        onUpdate: (newList) => {
            // Fix: BatchItemManager might call onUpdate without args
            if (newList) {
                Controller.State.loadedData = newList;
            } else if (manager && manager.list) {
                Controller.State.loadedData = manager.list;
            }

            if (View?.render) {
                View.render();
            }
        }
    });

    // Init Save Button
    if (AdminCore?.SaveButton) {
        AdminCore.SaveButton.init(
            document.body,
            handleSave,
            async () => {
                if (manager) {
                    manager.reset();
                    if (AdminCore.Feedback) AdminCore.Feedback.notifyCancel();
                }
            }
        );
    }
}

// --- Selection & Reordering ---

export function togglePick(path) {
    if (!manager) return;
    const index = Controller.State.loadedData.findIndex(i => i.path === path);
    if (index !== -1) {
        manager.toggleSelect(index);
    }
}

export function cancelMove() {
    if (manager) {
        manager.clearSelection();
    }
}

export function executeMove(targetPath) {
    if (!manager) return;
    const targetIndex = Controller.State.loadedData.findIndex(i => i.path === targetPath);
    if (targetIndex !== -1) {
        manager.moveTo(targetIndex);
    }
}

// --- Deletion ---

export function stageDelete(arg) {
    if (!manager) return;
    if (manager.selectedIndices.length > 0) return;

    // Support passing Event object (from inline onclick)
    let el = arg;
    if (arg instanceof Event || (arg && arg.target && arg.stopPropagation)) {
        arg.stopPropagation();
        el = arg.target.closest('.photo-item');
    }

    if (el) {
        const path = el.getAttribute('data-path');
        const index = Controller.State.loadedData.findIndex(i => i.path === path);
        if (index !== -1) {
            manager.toggleDelete(index);
        }
    }
}


// --- Upload & Save ---

async function handleSave() {
    if (!manager) return;

    try {
        // 1. Delete Items marked as _deleted
        const toDelete = Controller.State.loadedData.filter(i => i._deleted);
        const dels = toDelete.map(i => i.path);

        // 2. Reorder remaining
        const remaining = Controller.State.loadedData.filter(i => !i._deleted);
        const newOrder = remaining.map(i => ({ path: i.path }));

        const res = await Controller.saveChanges(dels, newOrder);
        if (res.success) {
            await Controller.reloadData();
            // Fix: Sync manager with fresh data after save to clear _deleted flags and update indices
            if (manager && manager.setList) {
                manager.setList(Controller.State.loadedData);
            }
            if (AdminCore.Feedback) {
                const msg = dels.length > 0 ? "保存成功，关联物理图片已同步删除" : "保存成功";
                AdminCore.Feedback.notifySaveSuccess(msg);
            }
            if (View?.render) {
                View.render();
            }
        } else throw res.error;
    } catch (e) {
        console.error(e);
        if (AdminCore.Feedback) AdminCore.Feedback.notifySaveFail();
    }
}

function bindAdminEvents() {
    const upBtn = document.getElementById('upload-btn');
    const fileInput = document.getElementById('file-input');

    if (upBtn) upBtn.style.display = 'flex';

    if (fileInput) {
        Utils.bindEvent(fileInput, 'change', async (e) => {
            const res = await Controller.uploadFiles(e.target.files);
            if (res.dupCount > 0) {
                showToast(`发现 ${res.dupCount} 张重复图片`, 'warning');
            } else {
                showToast("上传成功", 'success');
            }
            await Controller.reloadData();
            if (manager && manager.setList) {
                manager.setList(Controller.State.loadedData);
            }
            if (View?.render) {
                View.render();
            }
            // Explicitly hide SaveBar as upload is auto-saved
            if (AdminCore?.SaveButton) AdminCore.SaveButton.hide();
        });
    }
}

function setupGlobalRightClickCancel() {
    document.addEventListener('contextmenu', (e) => {
        if (manager && manager.selectedIndices.length > 0) {
            e.preventDefault();
            cancelMove();
        }
    });
}

function showToast(msg, type = 'success') {
    if (window.MAERS?.Toast) {
        type === 'error' ? window.MAERS.Toast.error(msg) : window.MAERS.Toast.success(msg);
    } else {
        alert(msg);
    }
}

// --- Public API ---

export const Admin = {
    init,
    initManager,
    togglePick,
    stageDelete,
    executeMove,
    getManager: () => manager,
    isReordering: () => manager && manager.selectedIndices.length > 0
};

// Auto-init when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
