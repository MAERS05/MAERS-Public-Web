/**
 * MAERS CMS - Admin Logic (cms-admin.module.js)
 * 职责：负责所有的 CMS 管理操作（增删改查、标签管理）
 * 集成：使用 AdminCore.BatchItemManager 进行批量管理
 * @version 3.0.0 - ES6 Module
 */

import { Toast } from '../../../shared/toast.module.js';

import { BatchItemManager, SaveButton, Feedback } from '../../../data-manage/admin/admin-base.module.js';
import { syncManager } from '../../../data-manage/sync/sync-manager.module.js';
import {
    unlockRecord,
    mountUnlockAllButton,
    refreshUnlockAllButton,
    packCmsNodeForLock,
    collectCmsPrivateCoverKeys,
    countEncryptedDeep,
    cancelProtection,
    protectCmsNode
} from '../../../data-manage/encrypt/admin-lock.module.js';

// Dependency injection
let State = null;
let Controller = null;
let Render = null;
let Search = null;
let Tags = null;

export function initAdmin(state, controller, render, search = null, tags = null) {
    State = state;
    Controller = controller;
    Render = render;
    Search = search;
    Tags = tags;
}

let manager = null;

export async function initAdminFeatures() {
    if (!State.IS_ADMIN) return;

    // 1. 初始化 Manager
    manager = new BatchItemManager({
        list: [],
        autoSaveBar: false,
        onUpdate: () => {
            // When filtering, use refreshView to stay in filtered mode
            const searchInput = document.getElementById("search-input");
            const hasSearch = searchInput && searchInput.value.trim().length > 0;
            const hasFilter = State.AppState.activeFilters.size > 0;

            if (hasSearch || hasFilter) {
                // Delegate to refreshView which calls Search.applyFilter()
                // This keeps the filtered view while reflecting _deleted state
                if (Search && Search.applyFilter) {
                    Search.applyFilter();
                }
            } else {
                // skipSync=true 避免重新同步 Manager（防止循环依赖）
                Render?.renderGrid(manager.list, false, false, true);
            }
        }
    });



    // 3. 初始同步 - 使用 true 以重置 initialSnapshot，建立正确的“原始状态”
    syncManagerList(null, true);

    // 3.5 注册「解锁全部」按钮（加密节点由 Controller 剪出到 lockedNodes）
    mountUnlockAllButton({
        source: `${Controller.CONFIG.CURRENT_MODULE}-tree.json`,
        getCount: () => (Controller?.AppState?.lockedNodes?.length || 0) +
            countEncryptedDeep(Controller.AppState.root, node => node.children, node => !!node._private_id),
        onUnlockAll: unlockAllCms
    });

    // 4. Inject Create Buttons
    const headerRight = document.querySelector('.header-right');
    if (headerRight) {
        const toolsRow = headerRight.querySelector('.header-tools-row');
        const targetContainer = toolsRow || headerRight;
        const searchBox = targetContainer.querySelector('.search-box') || targetContainer.querySelector('input');
        const insertRef = searchBox || targetContainer.firstChild;

        // Simple Injection
        if (!document.querySelector('.cms-create-btn')) {
            const btnFolder = document.createElement('button');
            btnFolder.className = 'cms-create-btn';
            btnFolder.innerHTML = '＋ 文件';
            btnFolder.onclick = (e) => {
                e.stopPropagation();
                uiCreateNode('folder');
            };

            const btnText = document.createElement('button');
            btnText.className = 'cms-create-btn';
            btnText.innerHTML = '＋ 文本';
            btnText.style.marginRight = '8px';
            btnText.onclick = (e) => {
                e.stopPropagation();
                uiCreateNode('text');
            };

            targetContainer.insertBefore(btnFolder, insertRef);
            targetContainer.insertBefore(btnText, insertRef);
            syncManager.injectSyncButton(targetContainer);
        }
    }
}

export function getManager() {
    return manager;
}

export function syncManagerList(list, shouldReset = false) {
    if (manager) {
        // 如果没有传 list，就用当前的视图数据
        if (!list) {
            const current = State.AppState.pathStack[State.AppState.pathStack.length - 1];
            if (!current) return;
            list = current === 'root' ? State.AppState.root : current.children;
            // 排序
            list = [...list].sort((a, b) => a.type === b.type ? 0 : a.type === "folder" ? -1 : 1);
        }

        if (shouldReset) manager.setList(list);
        else manager.updateListReference(list);
    }
}

export async function performSave() {
    if (!manager) return;

    const deletedItems = manager.list.filter(item => item._deleted);



    let success = true;
    let deletedWithCover = false;

    // 1. Batch Delete
    for (const item of deletedItems) {
        // Check if item has cover before deletion
        if (item.coverImage) {
            deletedWithCover = true;
        }

        const res = await Controller.deleteNode(item.id);
        if (!res.success) {
            success = false;
        } else {
            // [Fix]: Force DOM removal to ensure visual feedback
            const el = document.querySelector(`.grid-item[data-id="${item.id}"]`);
            if (el) {
                el.style.display = 'none'; // Hide first to be instant
                el.remove(); // Then remove
            }
        }
    }

    // 2. Persist Reorder
    const currentListNodes = manager.list.filter(item => !item._deleted);
    const originalListNodes = JSON.parse(manager.initialSnapshot).filter(item => !item._deleted);

    let orderChanged = false;
    if (currentListNodes.length === originalListNodes.length) {
        for (let i = 0; i < currentListNodes.length; i++) {
            if (currentListNodes[i].id !== originalListNodes[i].id) {
                orderChanged = true;
                break;
            }
        }
    } else {
        orderChanged = true;
    }

    if (orderChanged && currentListNodes.length > 0) {
        const orderedIds = currentListNodes.map(item => item.id);
        const reorderRes = await Controller.reorderNodes(orderedIds);
        if (!reorderRes.success) {
            success = false;
        }
    }

    // 3. Finalize
    if (success) {
        if (Feedback && deletedItems.length > 0) {
            const hasFolder = deletedItems.some(item => item.type === 'folder');
            const label = hasFolder ? 'MD 文档及其子节点' : (deletedItems.length > 1 ? '多个 MD 文档' : 'MD 文档');
            Feedback.notifyDeleteSuccess(`${label}已删除`);
        }

        // Show cover deletion notice if applicable
        if (deletedWithCover && window.MAERS?.Toast) {
            window.MAERS.Toast.info("封面已一并删除");
        }

        // Reload View
        // [Fix]: Force Manager Reset (true, true) to ensure clean state matching the new data
        await refreshView(true, true);
        manager.updateSaveState();
    } else {
        // If success is false, we likely already showed a specific error toast above.
        // But show a general one if not.
        if (window.MAERS?.Toast && !document.querySelector('.maers-toast.error')) {
            window.MAERS.Toast.error("部分保存失败，请检查控制台");
        }
    }
}

export async function performCancel() {
    if (manager) {
        // 1. Manually revert changes on the Source of Truth (AppState)
        // because manager manages a detached sorted array and reset() replaces objects 
        // with clones, breaking the link to AppState.
        if (manager.list && Array.isArray(manager.list)) {
            manager.list.forEach(item => {
                if (item._deleted) delete item._deleted;
            });
        }

        // 2. Reset Manager Internal State
        manager.reset();

        // 3. Refresh View to reflect clean AppState
        await refreshView(false);
    }
}

async function performUpdateTags(nodeId, tags) {
    try {
        const res = await Controller.updateTags(nodeId, tags);
        return res || { success: true };
    } catch (e) {
        console.error("[CMS] Update tags failed", e);
        if (window.MAERS?.Toast) window.MAERS.Toast.error("Update tags failed");
        return { success: false };
    }
}

export async function refreshView(fullReload = false, forceResetManager = false) {
    if (fullReload) {
        await Controller.loadData();
    }
    refreshUnlockAllButton();

    // [New Logic] If Search is active, delegate to Search
    // This ensures we stay in the filtered view after Save/Update
    const searchInput = document.getElementById("search-input");
    const hasSearch = searchInput && searchInput.value.trim().length > 0;
    const hasFilter = State.AppState.activeFilters.size > 0;

    if ((hasSearch || hasFilter) && Search && Search.applyFilter) {
        Search.applyFilter(forceResetManager);
        // rely on Search to sync manager via renderGrid
        return;
    }

    // 获取当前路径下的最新数据
    const currentPathNode = State.AppState.pathStack[State.AppState.pathStack.length - 1];
    let items = [];

    if (currentPathNode === 'root') {
        items = State.AppState.root;
    } else {
        // 关键：在重新加载数据后，旧的引用失效了。我们需要根据 ID 找回最新的节点对象
        const latestNode = State.AppState.allNodes.find(n => n.id === currentPathNode.id);
        items = latestNode ? (latestNode.children || []) : State.AppState.root;

        // 同步更新路径栈中的引用，防止后续操作基于旧对象
        if (latestNode) {
            State.AppState.pathStack[State.AppState.pathStack.length - 1] = latestNode;
        }
    }

    if (Render?.renderGrid) {
        // Pass forceResetManager to ensure BatchItemManager is synced with fresh data (new pointers)
        Render.renderGrid(items, false, forceResetManager);
    }
}

// --- UI Action Handlers (Calling Controller) ---

export async function uiCreateNode(type) {
    const parent = State.AppState.pathStack[State.AppState.pathStack.length - 1];
    const parentId = parent === 'root' ? 'root' : parent.id;

    // Auto-Save: Direct execution
    const defaultTitle = type === 'folder' ? 'New Folder' : 'New Note';
    const title = prompt(`Enter ${type} Name:`, defaultTitle);

    if (title) {
        // 'text' maps to 'note' type usually, but backend might accept 'text'. 
        // Controller uses 'note' in createNode fallback. Let's use 'note' if type is text.
        const actualType = (type === 'text') ? 'note' : type;

        // 1. Capture ID snapshot to identify new node later
        const existingIds = new Set(State.AppState.allNodes.map(n => n.id));

        const res = await Controller.createNode(parentId, actualType, title);
        if (res.success) {
            // 2. Find the newly created node
            // Note: Controller.createNode calls loadData(), so AppState is already updated
            const newNode = State.AppState.allNodes.find(n =>
                !existingIds.has(n.id) &&
                n.title === title &&
                n.parentId === parentId
            );

            // 3. Apply active tags if found
            if (newNode && State.AppState.activeFilters.size > 0) {
                const activeTags = Array.from(State.AppState.activeFilters);
                await Controller.updateTags(newNode.id, activeTags);
            }

            // [Critical Fix] Sync Logic
            // refreshView handles both Filtered and Normal views now.
            // forceResetManager = true ensures we drop any stale state.
            await refreshView(true, true);

            // [Custom Feedback] User requested specific MD/Folder creation toast
            if (Feedback) {
                const msg = (actualType === 'note') ? 'MD 文档已创建' : '文件夹已创建';
                Feedback.notifyAddSuccess(msg);
            }
            // Force Hide SaveBar
            if (SaveButton) SaveButton.hide();
        } else {
            Toast.error("Create Failed: " + res.msg);
        }
    }
}

export async function uiDeleteNode(e, id) {
    e.preventDefault();
    e.stopPropagation();
    // 使用 Soft Delete
    if (manager) {
        const idx = manager.list.findIndex(n => n.id === id);
        if (idx !== -1) {
            manager.toggleDelete(idx);
        }
    }
}

export async function uiPickNode(e, id) {
    e.preventDefault();
    e.stopPropagation();
    if (manager) {
        const idx = manager.list.findIndex(n => n.id === id);
        if (idx !== -1) manager.toggleSelect(idx);
    }
}

export async function uiRenameNode(e, id, oldTitle) {
    e.preventDefault();
    e.stopPropagation();
    // Soft Delete check
    if (manager) {
        const idx = manager.list.findIndex(n => n.id === id);
        if (idx !== -1 && manager.isDeleted(idx)) return;
    }

    const newTitle = prompt("Enter new title:", oldTitle);
    if (newTitle && newTitle !== oldTitle) {
        const res = await Controller.renameNode(id, newTitle);
        if (res.success) {
            await refreshView(false, true);
            if (SaveButton) SaveButton.hide();
        }
    }
}

export async function uiUploadCover(e, id) {
    e.preventDefault();
    e.stopPropagation();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async (ev) => {
        const file = ev.target.files[0];
        if (file) {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("nodeId", id);
            const res = await Controller.uploadCover?.(formData);
            if (res?.success) {
                if (window.MAERS?.Toast) {
                    window.MAERS.Toast.success("封面上传成功");
                }
                await refreshView(false, true);
                if (SaveButton) SaveButton.hide();
            }
        }
    };
    input.click();
}

export async function uiRemoveCover(e, id) {
    e.preventDefault();
    e.stopPropagation();
    if (confirm("Remove cover image?")) {
        const res = await Controller.updateNode?.(id, { coverImage: null });
        if (res?.success || res === undefined) {
            if (window.MAERS?.Toast) {
                window.MAERS.Toast.success("封面删除成功");
            }
        }
        await refreshView(false, true);
        if (SaveButton) SaveButton.hide();
    }
}

export async function uiAddTag(e, id) {
    e.preventDefault();
    e.stopPropagation();
    const node = State.AppState.allNodes.find((n) => n.id === id);
    if (!node) return;

    const input = prompt("添加标签 (可使用 , 或 ， 分隔多个):");
    if (input) {
        const rawTags = input.split(/[,，]/);
        const cleanTags = rawTags
            .map(t => t.trim())
            .filter(t => t.length > 0);

        if (cleanTags.length > 0) {
            const oldTags = [...(node.tags || [])];
            node.tags = [...oldTags];
            let changed = false;

            for (const tag of cleanTags) {
                if (!node.tags.includes(tag)) {
                    node.tags.push(tag);
                    changed = true;
                }
            }

            if (changed) {
                // Optimistic update
                const res = await performUpdateTags(id, node.tags);
                if (res.success) {
                    // Success - UI already updated optimistically
                    await refreshView(false, true);
                    if (SaveButton) SaveButton.hide();
                    if (Tags?.refreshDrawerList) Tags.refreshDrawerList();
                } else {
                    // Revert on failure
                    node.tags = oldTags;
                    await refreshView(false, true);
                    if (SaveButton) SaveButton.hide();
                }
            }
        }
    }
}

export async function uiRemoveTag(e, id, tag) {
    e.preventDefault();
    e.stopPropagation();

    // Add Confirmation to prevent accidental deletion
    if (!confirm(`确定要删除标签 #${tag} 吗？`)) return;

    const node = State.AppState.allNodes.find((n) => n.id === id);
    if (!node) return;

    const oldTags = [...(node.tags || [])];
    const newTags = oldTags.filter((t) => t !== tag);

    // Optimistic update
    node.tags = newTags;

    // Call granular API
    const res = await performUpdateTags(id, newTags);
    if (res.success) {
        // Success - UI already updated optimistically
        await refreshView(false, true);
        if (SaveButton) SaveButton.hide();
        if (Tags?.refreshDrawerList) Tags.refreshDrawerList();
    } else {
        // Revert on failure
        node.tags = oldTags;
        await refreshView(false, true);
        if (SaveButton) SaveButton.hide();
    }
}

// --- 加锁 / 解锁 ---

function _toast(type, msg) {
    window.MAERS?.Toast?.[type]?.(msg);
}

/**
 * 加锁节点（文件夹则连同全部子文档一起加密）
 * 本地后端：立即写库并把封面迁入私有桶；中继模式：入队，电脑端合并时生效
 */
export async function uiLock(e, id) {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    const privateNode = Controller.AppState.allNodes.find(node => node.id === id && node._private_id);
    if (privateNode) {
        if (await cancelProtection(privateNode)) await refreshView(true, true);
        return;
    }

    if (manager && manager.getSnapshot() !== manager.initialSnapshot) {
        _toast('error', '存在未保存的改动，请先保存或取消后再加锁');
        return;
    }

    const target = Controller.AppState.allNodes.find(n => n.id === id);
    if (!target) return;
    if (target._private) {
        _toast('info', '该内容随上级文件夹对外加密，后台可正常编辑');
        return;
    }
    const isFolder = Array.isArray(target.children);
    const tip = isFolder
        ? `确定加密文件夹「${target.title}」及其全部子文档吗？\n明文 .md 文件将被删除，封面图迁入私有桶。`
        : `确定加密文档「${target.title}」吗？\n明文 .md 文件将被删除，封面图迁入私有桶。`;
    if (!confirm(tip)) return;

    try {
        if (syncManager.isLocalHost()) {
            if (await protectCmsNode(Controller.CONFIG.CURRENT_MODULE, id)) {
                await refreshView(true, true);
                _toast('success', '已对外加密，后台可继续编辑');
            }
            return;
        }
        await Controller.loadData();
        const node = Controller.AppState.allNodes.find(n => n.id === id);
        if (!node) return;

        const packed = await packCmsNodeForLock(node, Controller.AppState.lockedNodes);
        if (!packed) return;

        const res = await Controller.lockNode(id, packed.enc, packed.covers, packed.sources);
        if (!res.success) {
            _toast('error', `加锁失败: ${res.msg || ''}`);
            return;
        }
        _toast('success', '🔒 已加密');
        await refreshView(false, true);
        if (SaveButton) SaveButton.hide();
    } catch (err) {
        console.error('[CMS] Lock failed', err);
        _toast('error', `加锁失败: ${err.message}`);
    }
}

/** 解锁单个加密节点（不刷新视图） */
async function _unlockOne(locked) {
    const tree = await unlockRecord({ _enc: locked._enc });
    if (!tree) return false;

    const res = await Controller.unlockNode(locked.id, tree);
    if (!res.success) {
        _toast('error', `解锁失败: ${res.msg || ''}`);
        return false;
    }
    return true;
}

export async function uiUnlock(id) {
    const locked = (Controller.AppState.lockedNodes || []).find(n => n.id === id);
    if (!locked) return;
    if (await _unlockOne(locked)) {
        _toast('success', '🔓 已解密');
        await refreshView(false, true);
    }
}

/**
 * 直接删除整条加密记录
 * 若当前会话已解锁，顺带清理其已迁入私有桶的封面图；未解锁则仅删除记录
 */
export async function uiDeleteLocked(id) {
    if (!confirm('确定永久删除这条加密内容吗？此操作无法恢复。')) return;
    const locked = (Controller.AppState.lockedNodes || []).find(n => n.id === id);
    const purge = await collectCmsPrivateCoverKeys(locked);
    const res = await Controller.deleteNode(id, purge.length ? { purge_private: purge } : undefined);
    if (res.success) {
        await refreshView(false, true);
    }
}

/**
 * 解锁全部：逐个解锁并重新读取状态。
 * 解锁文件夹后其内部仍加密的子节点会变为新的顶层锁定项，循环直到清空。
 * @returns {Promise<number>} 成功解锁数量
 */
async function unlockAllCms() {
    let count = 0;
    let guard = 0;
    while ((Controller.AppState.lockedNodes || []).length > 0 && guard++ < 500) {
        if (!(await _unlockOne(Controller.AppState.lockedNodes[0]))) break;
        count++;
    }
    await refreshView(false, true);
    return count;
}

export const Admin = {
    initAdmin,
    initAdminFeatures,
    getManager,
    syncManagerList,
    refreshView,
    // Export UI Handlers
    uiCreateNode,
    uiDeleteNode,
    uiPickNode,
    uiRenameNode,
    uiUploadCover,
    uiRemoveCover,
    uiAddTag,
    uiRemoveTag,
    uiLock,
    uiUnlock,
    uiDeleteLocked,
    performSave,
    performCancel
};
