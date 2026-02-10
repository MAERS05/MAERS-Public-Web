/**
 * MAERS CMS - Events Module (cms-events.module.js)
 * 职责：事件委托设置、网格事件处理
 * @version 3.0.0 - ES6 Module
 */

// Dependency injection
let State = null;
let Render = null;
let Admin = null;
let Tags = null;
let Editor = null;
let LiteratureView = null;
let Recent = null;

export function initEvents(state, render, admin = null, tags = null, editor = null, literatureView = null, recent = null) {
    State = state;
    Render = render;
    Admin = admin;
    Tags = tags;
    Editor = editor;
    LiteratureView = literatureView;
    Recent = recent;
}

export function setupGridEventDelegation() {
    if (State.gridEventsDelegated) return;
    const container = document.getElementById("grid-container");
    if (!container) return;

    container.addEventListener("click", (e) => {
        // ... (existing code for tags, actions, create buttons)
        const tag = e.target.closest(".mini-tag");
        const actionBtn = e.target.closest(".action-mini");
        const card = e.target.closest(".grid-item");
        const createBtn = e.target.closest('[data-action^="create-"]');

        if (tag) {
            e.stopPropagation();
            const tagName = tag.getAttribute("data-tag");
            if (tagName && Tags?.filterByTag) {
                Tags.filterByTag(e, tagName);
            }
            return;
        }

        if (actionBtn) {
            e.stopPropagation();
            const action = actionBtn.dataset.action;
            const id = actionBtn.dataset.id;

            if (!Admin) return;
            // ... (switch case for actions)
            switch (action) {
                case 'pick':
                    if (Admin.uiPickNode) Admin.uiPickNode(e, id);
                    break;
                case 'rename':
                    if (Admin.uiRenameNode) Admin.uiRenameNode(e, id, actionBtn.dataset.title);
                    break;
                case 'delete':
                    if (Admin.uiDeleteNode) Admin.uiDeleteNode(e, id);
                    break;
                case 'add-tag':
                    if (Admin.uiAddTag) Admin.uiAddTag(e, id);
                    break;
                case 'upload-cover':
                    if (Admin.uiUploadCover) Admin.uiUploadCover(e, id);
                    break;
                case 'remove-cover':
                    if (Admin.uiRemoveCover) Admin.uiRemoveCover(e, id);
                    break;
            }
            return;
        }

        if (createBtn) {
            const type = createBtn.dataset.action === 'create-folder' ? 'folder' : 'note';
            if (Admin?.uiCreateNode) {
                Admin.uiCreateNode(type);
            }
            return;
        }

        if (card) {
            e.stopPropagation();
            const nodeId = card.dataset.id;
            const node = State.AppState.allNodes.find((n) => n.id === nodeId);
            if (!node) return;

            // 1. Check BatchManager Selection State (Reorder Mode)
            const manager = Admin?.getManager?.();
            if (manager && manager.selectedIndices.length > 0) {
                const targetIndex = manager.list.findIndex(n => n.id === nodeId);
                if (targetIndex !== -1) {
                    // Click on selected -> Toggle (Deselect)
                    if (manager.selectedIndices.includes(targetIndex)) {
                        manager.toggleSelect(targetIndex);
                    } else {
                        // Click on unselected -> Move picked item(s) to here (Pick & Drop)
                        manager.moveTo(targetIndex);
                    }
                }
                return;
            }

            if (State.IS_ADMIN && State.AppState.pickedId) {
                if (node.type === "folder" && Render?.enterFolder) {
                    Render.enterFolder(node);
                }
                return;
            }

            if (node.type === "folder") {
                if (Render?.enterFolder) {
                    Render.enterFolder(node);
                }
            } else {
                if (!State.IS_ADMIN && LiteratureView?.engine) {
                    LiteratureView.engine.promoteBook(node);
                }

                // [Recent Files]
                if (Recent?.addToHistory) {
                    Recent.addToHistory(node);
                }

                // 1. Open Note Immediately
                if (Editor?.openNote) {
                    Editor.openNote(node);
                } else if (Editor?.open) {
                    Editor.open(node);
                }

                // 2. Handle Navigation Logic ONLY if in Search/Filter Context
                // We check state AFTER opening the note to ensure instant UI response.

                // Allow browser to render the opened note first (microtask/timeout)
                setTimeout(() => {
                    const searchInput = document.getElementById('search-input');
                    const hasSearch = searchInput && searchInput.value.trim().length > 0;
                    const hasFilter = State.AppState.activeFilters.size > 0;

                    if (hasSearch || hasFilter) {
                        const shouldNavigate = confirm("是否跳转到文本所在目录？\n\n【确定】跳转到文本所在目录 (更新导航栏)\n【取消】保持当前筛选状态 (仅预览)");

                        if (shouldNavigate) {
                            navigateToFileContext(node);
                        }
                    }
                    // If NO filter, we assume user is already in context (or we don't force navigation),
                    // per user instruction "only check when filtered".
                }, 100);

                // Helper function for navigation (updating stack, grid, etc.)
                function navigateToFileContext(targetNode) {
                    const newStack = [];
                    let curr = targetNode;

                    let parentId = curr.parentId;
                    while (parentId && parentId !== 'root') {
                        const parent = State.AppState.allNodes.find(n => n.id === parentId);
                        if (parent) {
                            newStack.unshift(parent);
                            parentId = parent.parentId;
                        } else {
                            break;
                        }
                    }
                    newStack.unshift('root');

                    // 1. Update Path Stack
                    State.AppState.pathStack = newStack;

                    // 2. Clear Filters & Search
                    if (State.AppState.activeFilters.size > 0) {
                        State.AppState.activeFilters.clear();
                        if (Tags?.renderTags) Tags.renderTags();
                    }
                    const sInput = document.getElementById('search-input');
                    if (sInput) sInput.value = '';

                    // 3. Render Breadcrumb
                    if (Render?.renderBreadcrumb) {
                        Render.renderBreadcrumb();
                    }

                    // 4. Render Grid
                    const navTarget = newStack[newStack.length - 1];
                    let targetList = [];

                    if (navTarget === 'root') {
                        targetList = State.AppState.root;
                    } else {
                        targetList = navTarget.children;
                    }

                    if (Render?.renderGrid) {
                        Render.renderGrid(targetList, false, true);
                    }
                }
                return;
            }
        }
    });

    if (State.IS_ADMIN) {
        container.addEventListener("contextmenu", (e) => {
            if (State.AppState.pickedId) {
                e.preventDefault();
                e.stopPropagation();
                if (Admin?.uiCancelPick) {
                    Admin.uiCancelPick();
                }
                if (window.MAERS?.Toast) {
                    window.MAERS.Toast.success("❌ 移动已取消");
                }
                return;
            }

            // Note: Tag right-click interactions are now handled by setupTagDragAndMenu
            // in cms-render-grid.module.js, so we don't need the old logic here
        });
    }

    State.markGridEventsDelegated();
}

export const Events = {
    setupGridEventDelegation
};
