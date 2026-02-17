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

// Helper: Check if currently filtering
function isFiltering() {
    if (!State || !State.AppState) return false;
    return (State.AppState.searchQuery || (State.AppState.activeFilters && State.AppState.activeFilters.size > 0));
}

function getCoverUrl(node, moduleName) {
    if (!node.coverImage) return null;

    // Games Module: Map to previews/gamecovers/*.avif
    if (moduleName === 'games') {
        const pathParts = node.coverImage.split('/');
        const filename = pathParts[pathParts.length - 1]; // 20260211_143001_01.jpg
        const basename = filename.replace(/\.[^/.]+$/, ""); // 20260211_143001_01
        return `photos/previews/gamecovers/${basename}.avif`;
    }

    // Literature Module: legacy logic (photos/previews/literaturecovers/....avif)
    const pathParts = node.coverImage.split('/');
    const filename = pathParts[pathParts.length - 1];
    const basename = filename.replace(/\.[^/.]+$/, "");
    return `photos/previews/literaturecovers/${basename}.avif`;
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
        const currentMod = Controller?.CONFIG?.CURRENT_MODULE || '';
        const isLitModule = (currentMod === 'literature') || (currentMod === 'games') || (window.location.search.includes('module=literature')) || (window.location.search.includes('module=games'));
        const filtering = isFiltering();

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

        // Hide Sort button when filtering (reordering doesn't apply to filtered results)
        if (!filtering) {
            wrapper.appendChild(createBtn('≡', 'Select', (e) => Admin.uiPickNode(e, node.id)));
        }
        wrapper.appendChild(createBtn('✎', 'Rename', (e) => Admin.uiRenameNode(e, node.id, node.title)));

        // Delete button always visible (works in both normal and filtered mode)
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
    const currentModule = Controller?.CONFIG?.CURRENT_MODULE;
    const showCover = currentModule === 'literature' || currentModule === 'games';

    if (showCover) {
        const coverUrl = getCoverUrl(node, currentModule);
        const coverDiv = document.createElement('div');
        coverDiv.className = coverUrl ? 'item-cover' : 'item-cover placeholder';

        if (coverUrl) {
            const img = document.createElement('img');
            img.src = coverUrl;
            img.loading = 'lazy';
            img.decoding = 'async';
            img.className = 'item-cover-img';
            img.onload = () => coverDiv.classList.add('loaded');
            // Error fallback: hide image or show placeholder
            img.onerror = () => {
                img.style.display = 'none';
                coverDiv.classList.add('placeholder');
            };
            coverDiv.appendChild(img);
        }
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
                        // Refresh view to update filter bar and grid (matching photos/space behavior)
                        if (typeof Controller?.refreshView === 'function') {
                            Controller.refreshView(false, true);
                        }
                        // Return false: DOM will be rebuilt by refreshView, so tag-interactions
                        // should NOT try to update now-stale DOM elements
                        return false;
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

/**
 * Patch an existing grid-item element in-place.
 * Updates class, title, tags, admin buttons — but preserves the cover <img> element
 * to avoid image reload flicker.
 */
function patchGridItem(el, node, State, index) {
    // 1. Update className (admin state: selected, deleted, etc.)
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
            } else {
                el.removeAttribute('data-order-num');
            }
        }
    }
    el.className = className;

    // 2. Update data attributes
    el.setAttribute('data-tags', (node.tags || []).join(' '));
    el.setAttribute('data-type', node.type);

    // 3. Patch Admin Buttons (rebuild — these are tiny, no images)
    if (State.IS_ADMIN && Admin && AdminButtonHelper) {
        const oldWrapper = el.querySelector('.maers-admin-action-group');
        const isDeleted = manager ? manager.isDeleted(index) : false;
        const currentMod = Controller?.CONFIG?.CURRENT_MODULE || '';
        const isLitModule = (currentMod === 'literature') || (currentMod === 'games') || (window.location.search.includes('module=literature')) || (window.location.search.includes('module=games'));
        const filtering = isFiltering();

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

        // Hide Sort button when filtering (reordering doesn't apply to filtered results)
        if (!filtering) {
            wrapper.appendChild(createBtn('≡', 'Select', (e) => Admin.uiPickNode(e, node.id)));
        }
        wrapper.appendChild(createBtn('✎', 'Rename', (e) => Admin.uiRenameNode(e, node.id, node.title)));

        // Delete button always visible (works in both normal and filtered mode)
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

        if (oldWrapper) {
            oldWrapper.replaceWith(wrapper);
        } else {
            el.insertBefore(wrapper, el.firstChild);
        }
    }

    // 4. Patch Cover Image — PRESERVE existing <img> if URL unchanged
    const currentModule = Controller?.CONFIG?.CURRENT_MODULE;
    const showCover = currentModule === 'literature' || currentModule === 'games';

    if (showCover) {
        const newCoverUrl = getCoverUrl(node, currentModule);
        const existingCoverDiv = el.querySelector('.item-cover');

        if (existingCoverDiv) {
            const existingImg = existingCoverDiv.querySelector('.item-cover-img');
            const existingUrl = existingImg ? existingImg.getAttribute('src') : null;

            if (newCoverUrl !== existingUrl) {
                // Cover changed — rebuild cover div
                const coverDiv = document.createElement('div');
                coverDiv.className = newCoverUrl ? 'item-cover' : 'item-cover placeholder';

                if (newCoverUrl) {
                    const img = document.createElement('img');
                    img.src = newCoverUrl;
                    img.loading = 'lazy';
                    img.decoding = 'async';
                    img.className = 'item-cover-img';
                    img.onload = () => coverDiv.classList.add('loaded');
                    img.onerror = () => {
                        img.style.display = 'none';
                        coverDiv.classList.add('placeholder');
                    };
                    coverDiv.appendChild(img);
                }
                existingCoverDiv.replaceWith(coverDiv);
            }
            // else: URL unchanged, do nothing — image stays loaded!
        }
    }

    // 5. Patch Title
    const titleEl = el.querySelector('.item-title');
    if (titleEl && titleEl.textContent !== node.title) {
        titleEl.textContent = node.title;
    }

    // 6. Patch Tags
    const oldTagsDiv = el.querySelector('.item-tags');
    if (oldTagsDiv) {
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
        oldTagsDiv.replaceWith(tagsDiv);

        // Re-setup tag interactions in admin mode
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

                    const module = Controller?.CONFIG?.CURRENT_MODULE || 'notes';
                    try {
                        const res = await fetch(`/api/cms/update_tags?module=${module}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: node.id, tags: newTags })
                        });

                        if (res.ok) {
                            // Refresh view to update filter bar and grid (matching photos/space behavior)
                            if (typeof Controller?.refreshView === 'function') {
                                Controller.refreshView(false, true);
                            }
                            // Return false: DOM will be rebuilt by refreshView, so tag-interactions
                            // should NOT try to update now-stale DOM elements
                            return false;
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
    }
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
        // Patch Render (Preserves cover images to avoid reload flicker)
        const existingNodes = new Map();
        Array.from(container.children).forEach(el => {
            if (el.dataset.id) existingNodes.set(el.dataset.id, el);
        });

        sortedList.forEach((item, index) => {
            const existingEl = existingNodes.get(item.id);
            const occupant = container.children[index];

            if (existingEl) {
                // Patch in-place: update only what changed, preserve cover <img>
                patchGridItem(existingEl, item, State, index);

                // Ensure correct position (reorder support)
                if (existingEl !== container.children[index]) {
                    container.insertBefore(existingEl, container.children[index]);
                }
                existingNodes.delete(item.id);
            } else {
                // New item: create fresh
                const newEl = createGridItem(item, State, index);
                container.insertBefore(newEl, occupant || null);
            }
        });

        // Remove cards that no longer exist in the list
        while (container.children.length > sortedList.length) {
            container.lastElementChild.remove();
        }
    }
}
