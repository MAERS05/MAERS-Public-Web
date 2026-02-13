/**
 * MAERS CMS - Admin Logic (cms-admin.module.js)
 * 职责：负责所有的 CMS 管理操作（增删改查、标签管理）
 * 集成：使用 AdminCore.BatchItemManager 进行批量管理
 * @version 3.0.0 - ES6 Module
 */

import { BatchItemManager, SaveButton, Feedback } from '../../../data-manage/admin-base.module.js';

// Dependency injection
let State = null;
let Controller = null;
let Render = null;
let Search = null;

export function initAdmin(state, controller, render, search = null) {
    State = state;
    Controller = controller;
    Render = render;
    Search = search;
}

let manager = null;

export async function initAdminFeatures() {
    if (!State.IS_ADMIN) return;

    // 1. 初始化 Manager
    manager = new BatchItemManager({
        list: [],
        autoSaveBar: false,
        onUpdate: () => {
            // skipSync=true 避免重新同步 Manager（防止循环依赖）
            Render?.renderGrid(manager.list, false, false, true);
        }
    });



    // 3. 初始同步 - 使用 true 以重置 initialSnapshot，建立正确的“原始状态”
    syncManagerList(null, true);

    // 4. Inject Create Buttons
    const existingAddBtn = document.querySelector('.cms-add-btn-group');
    if (!existingAddBtn) {
        // Use a broader selector or State.SELECTORS if available, but assuming .header-right
        const headerRight = document.querySelector('.header-right');
        if (headerRight) {
            // Find the correct container (.header-tools-row)
            const toolsRow = headerRight.querySelector('.header-tools-row');
            const targetContainer = toolsRow || headerRight;
            const searchBox = targetContainer.querySelector('.search-box') || targetContainer.querySelector('input');
            const insertRef = searchBox || targetContainer.firstChild;

            // Create Buttons using 'cms-create-btn' (Styles defined in cms-editor.css)
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
            btnText.onclick = (e) => {
                e.stopPropagation();
                uiCreateNode('text');
            };
            btnText.style.marginRight = '12px'; // Extra spacing before search box

            // Sequence: [Folder] -> [Text] -> [SearchBox]
            targetContainer.insertBefore(btnFolder, insertRef);
            targetContainer.insertBefore(btnText, insertRef);
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
    if (success && manager.list && manager.list.length > 0) {
        try {
            const currentOrderIds = manager.list.map(n => n.id);
            // Reorder usually not needed after delete unless we want to save remaining order
            // which BatchManager handles implicitly by list state. 
            // Skipping reorder call for deleted items to save bandwidth/time
        } catch (e) {
            console.error('[CMS] Reorder Exception:', e);
        }
    }

    // 3. Finalize
    if (success) {
        if (Feedback) {
            if (deletedItems.length > 0) {
                Feedback.notifyDeleteSuccess('MD 文档及其子节点已删除');
            }
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
        const module = Controller.CONFIG.CURRENT_MODULE;
        const res = await fetch(`/api/cms/update_tags?module=${module}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: nodeId, tags: tags })
        });

        if (res.ok) {
            return { success: true };
        }
        throw new Error(res.status);
    } catch (e) {
        console.error("Update tags failed", e);
        if (window.MAERS?.Toast) window.MAERS.Toast.error("Update tags failed");
        return { success: false };
    }
}

export async function refreshView(fullReload = false, forceResetManager = false) {
    if (fullReload) {
        await Controller.loadData();
    }

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
            alert("Create Failed: " + res.msg);
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
                refreshView();
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
        refreshView();
    }
}

export async function uiAddTag(e, id) {
    e.preventDefault();
    e.stopPropagation();
    const node = State.AppState.allNodes.find((n) => n.id === id);
    if (!node) return;

    const tag = prompt("Enter tag name (without #):");
    if (tag) {
        const cleanTag = tag.trim();
        if (cleanTag) {
            const currentTags = node.tags || [];
            if (!currentTags.includes(cleanTag)) {
                const newTags = [...currentTags, cleanTag];

                // Optimistic update
                node.tags = newTags;

                // Call granular API
                const res = await performUpdateTags(id, newTags);
                if (res.success) {
                    // Success - UI already updated optimistically
                    refreshView();
                } else {
                    // Revert on failure
                    node.tags = currentTags;
                    refreshView();
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
        refreshView();
    } else {
        // Revert on failure
        node.tags = oldTags;
        refreshView();
    }
}

export const Admin = {
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
    performSave,
    performCancel
};
