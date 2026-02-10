/**
 * @module custom/cms/viewer/render/cms-render-grid.module.js
 * @description CMS 网格渲染 - 卡片生成与分片渲染优化
 * @version 1.0.0 - ES6 Module
 */

import { AdminButtonHelper } from '../../../../data-manage/admin-base.module.js';
import { setupTagDragAndMenu } from '../../admin/tag-interactions.module.js';

// Dependency injection
let State = null;
let Admin = null;
let Controller = null;
let Drag = null;
let Events = null;

export function initGrid(deps) {
    State = deps.State;
    Admin = deps.Admin;
    Controller = deps.Controller;
    Drag = deps.Drag;
    Events = deps.Events;
}

function getCoverUrl(node, isLitModule) {
    if (!isLitModule) return null;
    if (!node.coverImage) return null;
    const pathParts = node.coverImage.split('/');
    const filename = pathParts[pathParts.length - 1];
    const basename = filename.replace(/\.[^/.]+$/, "");
    return `photos/previews/covers/${basename}.avif`;
}

function createGridItem(node, State, index) {
    const el = document.createElement("div");
    let className = `grid-item type-${node.type}`;

    let manager = null;
    if (State.IS_ADMIN && Admin) {
        manager = Admin.getManager?.();
        if (manager) {
            const extraClass = manager.getItemClass(index);
            className += ` ${extraClass}`;

            if (manager.selectedIndices && manager.selectedIndices.includes(index)) {
                const orderNum = manager.selectedIndices.indexOf(index) + 1;
                el.setAttribute('data-order-num', orderNum);
            }
        }

        if (Drag) {
            Drag.setupItemDrag?.(el, node);
        }
    }

    el.className = className;
    el.dataset.id = node.id;

    // Admin Actions
    if (State.IS_ADMIN && Admin && AdminButtonHelper) {
        const isDeleted = manager ? manager.isDeleted(index) : false;
        const isLitModule = (Controller?.CONFIG?.CURRENT_MODULE === 'literature') || (window.location.search.includes('module=literature'));

        const wrapper = document.createElement('div');
        wrapper.className = 'maers-admin-action-group';
        wrapper.style.cssText = "position: absolute; top: 5px; right: 5px; z-index: 10; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; max-width: 140px;";

        const createBtn = (icon, title, onClick) => {
            const btn = document.createElement('span');
            btn.className = 'maers-admin-btn';
            btn.title = title;
            btn.textContent = icon;
            btn.addEventListener('click', onClick);
            return btn;
        };

        wrapper.appendChild(createBtn('≡', 'Select', (e) => Admin.uiPickNode(e, node.id)));
        wrapper.appendChild(createBtn('✎', 'Rename', (e) => Admin.uiRenameNode(e, node.id, node.title)));

        const delIcon = isDeleted ? '↺' : '✕';
        const delBtn = createBtn(delIcon, 'Delete/Undo', (e) => Admin.uiDeleteNode(e, node.id));
        if (isDeleted) delBtn.classList.add('btn-delete-active');
        wrapper.appendChild(delBtn);

        wrapper.appendChild(createBtn('＋', 'Add Tag', (e) => Admin.uiAddTag(e, node.id)));

        if (isLitModule) {
            wrapper.appendChild(createBtn('🖼️', 'Upload Cover', (e) => Admin.uiUploadCover(e, node.id)));
            if (node.coverImage) {
                wrapper.appendChild(createBtn('🗑️', 'Remove Cover', (e) => Admin.uiRemoveCover(e, node.id)));
            }
        }

        el.appendChild(wrapper);
        AdminButtonHelper.injectStyles();
    }

    el.setAttribute('data-tags', (node.tags || []).join(' '));
    el.setAttribute('data-type', node.type);

    // Cover/Icon
    const isLit = Controller?.CONFIG?.CURRENT_MODULE === 'literature';
    if (isLit) {
        const coverUrl = getCoverUrl(node, true);
        const coverDiv = document.createElement('div');
        coverDiv.className = coverUrl ? 'item-cover' : 'item-cover placeholder';
        if (coverUrl) coverDiv.style.backgroundImage = `url('${coverUrl}')`;
        el.appendChild(coverDiv);
    }

    // Title
    const titleDiv = document.createElement('div');
    titleDiv.className = 'item-title';
    titleDiv.textContent = node.title;
    el.appendChild(titleDiv);

    // Divider
    const divDiv = document.createElement('div');
    divDiv.className = 'item-divider';
    el.appendChild(divDiv);

    // Tags
    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'item-tags';
    (node.tags || []).forEach(t => {
        const span = document.createElement('span');
        span.className = 'mini-tag';
        if (State.AppState.activeFilters.has(t)) span.classList.add('active');
        span.textContent = `#${t}`;
        span.dataset.tag = t;
        if (State.IS_ADMIN) span.dataset.nodeId = node.id;
        tagsDiv.appendChild(span);
    });
    el.appendChild(tagsDiv);

    // Setup tag interactions (drag-and-drop + context menu) in admin mode
    if (State.IS_ADMIN && Admin && tagsDiv.children.length > 0) {
        setupTagDragAndMenu({
            tagsContainer: tagsDiv,
            getTags: () => {
                const currentNode = State.AppState.allNodes.find(n => n.id === node.id);
                return currentNode?.tags || [];
            },
            onTagsUpdate: async (newTags) => {
                const currentNode = State.AppState.allNodes.find(n => n.id === node.id);
                if (!currentNode) return false;

                const oldTags = [...(currentNode.tags || [])];
                currentNode.tags = newTags;

                // Call update API
                const module = Controller?.CONFIG?.CURRENT_MODULE || 'notes';
                try {
                    const res = await fetch(`/api/cms/update_tags?module=${module}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: node.id, tags: newTags })
                    });

                    if (res.ok) {
                        return true;
                    } else {
                        currentNode.tags = oldTags;
                        return false;
                    }
                } catch (e) {
                    console.error('Update tags failed', e);
                    currentNode.tags = oldTags;
                    if (window.MAERS?.Toast) window.MAERS.Toast.error('标签更新失败');
                    return false;
                }
            }
        });
    }

    return el;
}

export function renderGrid(list, isSearch = false, shouldResetManager = false, skipSync = false) {
    const container = document.getElementById("grid-container");
    const taskId = State.incrementRenderTask();

    if (Events?.setupGridEventDelegation) {
        Events.setupGridEventDelegation();
    }

    if (State.IS_ADMIN && Drag) {
        Drag.setupContainer?.(container);
    }

    if (!list || list.length === 0) {
        container.innerHTML = `<div class="empty-tip">${State.IS_ADMIN ? '<button class="tag-toggle-btn" data-action="create-note">+ Create Note</button>' : "Empty."}</div>`;
        if (State.IS_ADMIN && Admin && !skipSync) {
            Admin.syncManagerList?.([], true);
        }
        return;
    }

    // Sort: Folders first
    const sortedList = [...list].sort((a, b) =>
        a.type === b.type ? 0 : a.type === "folder" ? -1 : 1,
    );

    // SYNC MANAGER
    if (State.IS_ADMIN && Admin && !skipSync) {
        Admin.syncManagerList?.(sortedList, shouldResetManager);
    }

    if (container.children.length === 0 || container.querySelector('.empty-tip')) {
        // Batch Render (Fast Initial Load)
        container.innerHTML = "";
        let index = 0;
        const batchSize = 25;
        const total = sortedList.length;

        function renderBatch() {
            if (taskId !== State.currentRenderTask) return;
            const fragment = document.createDocumentFragment();
            const end = Math.min(index + batchSize, total);

            for (let i = index; i < end; i++) {
                fragment.appendChild(createGridItem(sortedList[i], State, i));
            }
            container.appendChild(fragment);
            index += batchSize;

            if (index < total) {
                requestAnimationFrame(renderBatch);
            }
        }
        renderBatch();
    } else {
        // Diff Render (Scroll Preservation)
        const existingNodes = new Map();
        Array.from(container.children).forEach(el => {
            if (el.dataset.id) existingNodes.set(el.dataset.id, el);
        });

        sortedList.forEach((item, index) => {
            const newEl = createGridItem(item, State, index);
            const existingEl = existingNodes.get(item.id);
            const occupant = container.children[index];

            if (existingEl) {
                existingEl.replaceWith(newEl);
                if (newEl !== container.children[index]) {
                    container.insertBefore(newEl, container.children[index]);
                }
            } else {
                container.insertBefore(newEl, occupant || null);
            }
        });

        while (container.children.length > sortedList.length) {
            container.lastElementChild.remove();
        }
    }
}
