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
import { setupTagDragAndMenu } from '../../cms/admin/tag-interactions.module.js';

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
            // Sync manager with fresh data after save to clear _deleted flags and update indices
            if (manager && manager.setList) {
                manager.setList(Controller.State.loadedData);
            }

            if (View?.render) {
                View.render();
            }
            return true;
        } else throw res.error;
    } catch (e) {
        console.error(e);
        // Let InitUnified handle failure notification if we return false/undefined
        return false;
    }
}

export async function performSave() {
    return await handleSave();
}

export async function performCancel() {
    if (manager) manager.reset();
}

function bindAdminEvents() {
    const upBtn = document.getElementById('upload-btn');
    const fileInput = document.getElementById('file-input');

    if (upBtn) upBtn.style.display = 'flex';

    if (fileInput) {
        Utils.bindEvent(fileInput, 'change', async (e) => {
            const res = await Controller.uploadFiles(e.target.files);
            const totalCount = e.target.files.length;
            const successCount = totalCount - res.dupCount;

            if (successCount > 0) {
                showToast(`成功上传 ${successCount} 张图片`, 'success');
            }
            if (res.dupCount > 0) {
                showToast(`发现 ${res.dupCount} 张重复图片`, 'warning');
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
    isReordering: () => manager && manager.selectedIndices.length > 0,
    addTag,
    bindTagEvents,
    performSave,
    performCancel
};

// --- Tagging Features (Space-Style) ---

async function addTag(photo) {
    if (!photo) return;
    const tag = prompt("添加标签 (Add Tag):");
    if (!tag || !tag.trim()) return;

    const cleanTag = tag.trim();

    // Optimistic update
    if (!photo.tags) photo.tags = [];
    if (photo.tags.includes(cleanTag)) return;

    const newTags = [...photo.tags, cleanTag];

    await updateTagsAPI(photo, newTags, true); // Silent add
}

function bindTagEvents(span, photo, tag) {
    // Only bind once per container
    const container = span.parentNode;
    if (container.dataset.tagSetup) return;

    container.dataset.tagSetup = "true";

    setupTagDragAndMenu({
        tagsContainer: container,
        getTags: () => photo.tags || [],
        onTagsUpdate: async (newTags) => {
            await updateTagsAPI(photo, newTags, true); // Silent
            // Since updateTagsAPI calls View.render(), the DOM is replaced.
            // Returning false prevents tag-interactions from trying to update stale DOM elements.
            return false;
        }
    });
}

async function updateTagsAPI(photo, newTags, silent = false) {
    try {
        const res = await fetch('/api/photos/update_tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: photo.id, tags: newTags })
        });
        const data = await res.json();

        if (data.status === 'success') {
            photo.tags = newTags;
            // Refresh View to show new state
            if (View?.render) View.render();
            if (!silent && window.MAERS?.Toast) window.MAERS.Toast.success("标签已更新");
        } else {
            alert("Error: " + (data.error || "Unknown"));
        }
    } catch (e) {
        console.error(e);
        alert("Network Error during tag update");
    }
}

// Auto-init when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
