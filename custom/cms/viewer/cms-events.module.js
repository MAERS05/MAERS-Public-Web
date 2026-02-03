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

                if (Editor?.openNote) {
                    Editor.openNote(node);
                } else if (Editor?.open) {
                    Editor.open(node);
                }
            }
            return;
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

            const tag = e.target.closest(".mini-tag");
            if (tag) {
                e.preventDefault();
                e.stopPropagation();
                const tagName = tag.getAttribute("data-tag");
                const nodeId = tag.getAttribute("data-node-id");
                if (tagName && nodeId && Admin?.uiRemoveTag) {
                    Admin.uiRemoveTag(e, nodeId, tagName);
                }
            }
        });
    }

    State.markGridEventsDelegated();
}

export const Events = {
    setupGridEventDelegation
};
