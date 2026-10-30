/**
 * @module custom/cms/viewer/render/cms-render-grid.module.js
 * @description CMS 网格渲染 - 卡片生成与分片渲染优化
 * @version 1.0.0 - ES6 Module
 */
import { localFetch } from '../../../../data-manage/api-client.module.js';
import { DataProvider, publicMediaUrl } from '../../../../data-manage/data-provider.module.js';

import { AdminButtonHelper } from '../../../../data-manage/admin/admin-base.module.js';
import { renderLockedCard, cryptoIconHtml, setupLockActionButton } from '../../../../data-manage/encrypt/admin-lock.module.js';
import { setupTagDragAndMenu } from '../../admin/tag-interactions.module.js';

const REMOVE_COVER_ICON = new URL('../../../../ui/remove-cover.svg', import.meta.url).href;

// 工具函数：判断当前是否有本地 Python 后端（localhost / 局域网）
function _isLocalBackend() {
    const host = window.location.hostname;
    return (
        ['localhost', '127.0.0.1', '[::1]', ''].includes(host) ||
        /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)
    );
}

// Dependency injection
let State = null;
let Admin = null;
let Controller = null;
let Drag = null;
let Events = null;

// Global Intersection Observer for Lazy Loading
let lazyObserver = null;

export function initGrid(deps) {
    State = deps.State;
    Admin = deps.Admin;
    Controller = deps.Controller;
    Drag = deps.Drag;
    Events = deps.Events;

    // Initialize IntersectionObserver
    if ('IntersectionObserver' in window && !lazyObserver) {
        lazyObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    const src = img.getAttribute('data-src');
                    if (src) {
                        img.src = src;
                        img.removeAttribute('data-src');
                    }
                    observer.unobserve(img);
                }
            });
        }, {
            rootMargin: '200px 0px', // ~1 row ahead
            threshold: 0.01
        });
    }
}

// Helper: Check if currently filtering
function isFiltering() {
    if (!State || !State.AppState) return false;
    return (State.AppState.searchQuery || (State.AppState.activeFilters && State.AppState.activeFilters.size > 0));
}

export function createGridItem(node, State, index) {
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
        const isLitModule = (currentMod === 'literature') || (currentMod === 'games') || (currentMod === 'videos') || (window.location.search.includes('module=literature')) || (window.location.search.includes('module=games')) || (window.location.search.includes('module=videos'));
        const filtering = isFiltering();

        const wrapper = document.createElement('div');
        wrapper.className = 'maers-admin-action-group';
        wrapper.style.cssText = "position: absolute; top: 5px; right: 5px; z-index: 10; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; max-width: 140px;";

        const createBtn = (icon, title, onClick) => {
            const btn = document.createElement('span');
            btn.className = 'maers-admin-btn';
            btn.title = title;
            if (icon === '🔒') btn.innerHTML = cryptoIconHtml(node._private_id ? 'decryption' : 'encryption');
            else if (icon === 'remove-cover') btn.innerHTML = `<img class="maers-admin-icon--remove-cover" src="${REMOVE_COVER_ICON}" width="18" height="18" alt="" aria-hidden="true">`;
            else if (icon === '✎') btn.innerHTML = '<span class="maers-admin-edit-icon">✎</span>';
            else btn.textContent = icon;
            btn.addEventListener('click', onClick);
            return btn;
        };

        // Hide Sort button when filtering (reordering doesn't apply to filtered results)
        if (!filtering) {
            wrapper.appendChild(createBtn('≡', 'Select', (e) => Admin.uiPickNode(e, node.id)));
        }
        wrapper.appendChild(createBtn('✎', 'Rename', (e) => Admin.uiRenameNode(e, node.id, node.title)));

        wrapper.appendChild(createBtn('＋', 'Add Tag', (e) => Admin.uiAddTag(e, node.id)));

        // Delete button always visible (works in both normal and filtered mode)
        const delIcon = isDeleted ? '↺' : '✕';
        const delBtn = createBtn(delIcon, 'Delete/Undo', (e) => Admin.uiDeleteNode(e, node.id));
        if (isDeleted) delBtn.classList.add('btn-delete-active');
        wrapper.appendChild(delBtn);
        if (isLitModule) {
            if (!node.coverImage) {
                wrapper.appendChild(createBtn('🖼️', 'Upload Cover', (e) => Admin.uiUploadCover(e, node.id)));
            } else {
                wrapper.appendChild(createBtn('remove-cover', 'Remove Cover', (e) => Admin.uiRemoveCover(e, node.id)));
            }
        }

        if (Admin.uiLock) {
            const lockTitle = node._private_id ? '取消对外加密' : node._private ? '随上级对外加密' : '对外加密' + (node.type === 'folder' ? '（含全部子文档）' : '');
            const lockBtn = createBtn('🔒', lockTitle, (e) => Admin.uiLock(e, node.id));
            setupLockActionButton(lockBtn, {
                isLocked: Boolean(node._private_id),
                title: lockTitle,
                onClick: (e) => Admin.uiLock(e, node.id)
            });
            wrapper.appendChild(lockBtn);
        }

        el.appendChild(wrapper);
        AdminButtonHelper.injectStyles();
    }

    el.setAttribute('data-tags', (node.tags || []).join(' '));
    el.setAttribute('data-type', node.type);

    // Cover/Icon
    const currentModule = Controller?.CONFIG?.CURRENT_MODULE;
    const showCover = currentModule === 'literature' || currentModule === 'games' || currentModule === 'videos';

    if (showCover) {
        const coverUrl = DataProvider.getCoverUrl(node, 'preview');
        const coverDiv = document.createElement('div');
        coverDiv.className = coverUrl ? 'item-cover' : 'item-cover placeholder';

        if (coverUrl) {
            const img = document.createElement('img');
            // Use IntersectionObserver logic instead of just loading='lazy'
            if (lazyObserver) {
                img.setAttribute('data-src', coverUrl); // Hold the URL
                lazyObserver.observe(img); // Observe real visibility
            } else {
                img.src = coverUrl; // Fallback
            }
            img.loading = 'lazy'; // Still keep native lazy for extra browser support
            img.decoding = 'async';
            img.className = 'item-cover-img';
            img.onload = () => coverDiv.classList.add('loaded');
            // 错误回退：优先降级至 Cloudflare R2 原图 CDN，若依然失败再展示占位图
            img.onerror = () => {
                if (!img.dataset.hasFallenBack && node.coverImage) {
                    img.dataset.hasFallenBack = "true";
                    img.src = publicMediaUrl(node.coverImage);
                    return;
                }
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

                // 线上无后端，仅内存更新后直接刷新视图
                if (!_isLocalBackend()) {
                    if (typeof Controller?.refreshView === 'function') {
                        Controller.refreshView(false, true);
                    }
                    return false;
                }

                // 本地环境：将标签变更请求写入后端数据库
                const module = Controller?.CONFIG?.CURRENT_MODULE || 'notes';
                try {
                    const res = await localFetch(`/api/cms/update_tags?module=${module}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: node.id, tags: newTags })
                    });

                    if (res.ok) {
                        if (typeof Controller?.refreshView === 'function') {
                            Controller.refreshView(false, true);
                        }
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
        const isLitModule = (currentMod === 'literature') || (currentMod === 'games') || (currentMod === 'videos') || (window.location.search.includes('module=literature')) || (window.location.search.includes('module=games')) || (window.location.search.includes('module=videos'));
        const filtering = isFiltering();

        const wrapper = document.createElement('div');
        wrapper.className = 'maers-admin-action-group';
        wrapper.style.cssText = "position: absolute; top: 5px; right: 5px; z-index: 10; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; max-width: 140px;";

        const createBtn = (icon, title, onClick) => {
            const btn = document.createElement('span');
            btn.className = 'maers-admin-btn';
            btn.title = title;
            if (icon === '🔒') btn.innerHTML = cryptoIconHtml(node._private_id ? 'decryption' : 'encryption');
            else if (icon === 'remove-cover') btn.innerHTML = `<img class="maers-admin-icon--remove-cover" src="${REMOVE_COVER_ICON}" width="18" height="18" alt="" aria-hidden="true">`;
            else if (icon === '✎') btn.innerHTML = '<span class="maers-admin-edit-icon">✎</span>';
            else btn.textContent = icon;
            btn.addEventListener('click', onClick);
            return btn;
        };

        // Hide Sort button when filtering (reordering doesn't apply to filtered results)
        if (!filtering) {
            wrapper.appendChild(createBtn('≡', 'Select', (e) => Admin.uiPickNode(e, node.id)));
        }
        wrapper.appendChild(createBtn('✎', 'Rename', (e) => Admin.uiRenameNode(e, node.id, node.title)));

        wrapper.appendChild(createBtn('＋', 'Add Tag', (e) => Admin.uiAddTag(e, node.id)));

        // Delete button always visible (works in both normal and filtered mode)
        const delIcon = isDeleted ? '↺' : '✕';
        const delBtn = createBtn(delIcon, 'Delete/Undo', (e) => Admin.uiDeleteNode(e, node.id));
        if (isDeleted) delBtn.classList.add('btn-delete-active');
        wrapper.appendChild(delBtn);
        if (isLitModule) {
            if (!node.coverImage) {
                wrapper.appendChild(createBtn('🖼️', 'Upload Cover', (e) => Admin.uiUploadCover(e, node.id)));
            } else {
                wrapper.appendChild(createBtn('remove-cover', 'Remove Cover', (e) => Admin.uiRemoveCover(e, node.id)));
            }
        }

        if (Admin.uiLock) {
            const lockTitle = node._private_id ? '取消对外加密' : node._private ? '随上级对外加密' : '对外加密' + (node.type === 'folder' ? '（含全部子文档）' : '');
            const lockBtn = createBtn('🔒', lockTitle, (e) => Admin.uiLock(e, node.id));
            setupLockActionButton(lockBtn, {
                isLocked: Boolean(node._private_id),
                title: lockTitle,
                onClick: (e) => Admin.uiLock(e, node.id)
            });
            wrapper.appendChild(lockBtn);
        }

        if (oldWrapper) {
            oldWrapper.replaceWith(wrapper);
        } else {
            el.insertBefore(wrapper, el.firstChild);
        }
    }

    // 4. Patch Cover Image — PRESERVE existing <img> if URL unchanged
    const currentModule = Controller?.CONFIG?.CURRENT_MODULE;
    const showCover = currentModule === 'literature' || currentModule === 'games' || currentModule === 'videos';

    if (showCover) {
        const newCoverUrl = DataProvider.getCoverUrl(node, 'preview');
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
                    if (lazyObserver) {
                        img.setAttribute('data-src', newCoverUrl);
                        lazyObserver.observe(img);
                    } else {
                        img.src = newCoverUrl;
                    }
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

                    // 线上无后端，仅内存更新后直接刷新视图
                    if (!_isLocalBackend()) {
                        if (typeof Controller?.refreshView === 'function') {
                            Controller.refreshView(false, true);
                        }
                        return false;
                    }

                    const module = Controller?.CONFIG?.CURRENT_MODULE || 'notes';
                    try {
                        const res = await localFetch(`/api/cms/update_tags?module=${module}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: node.id, tags: newTags })
                        });

                        if (res.ok) {
                            if (typeof Controller?.refreshView === 'function') {
                                Controller.refreshView(false, true);
                            }
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

/**
 * 创建加密节点的锁定占位卡片（仅 Admin）
 * 注意：不写 data-id，避免被事件委托/补丁渲染当成普通节点
 */
function createLockedCard(lockedNode) {
    return renderLockedCard({
        className: 'grid-item locked-card',
        variant: 'cms',
        label: '私密内容',
        dataset: { lockedId: lockedNode.id },
        onUnlock: () => Admin.uiUnlock(lockedNode.id),
        onDelete: () => Admin.uiDeleteLocked?.(lockedNode.id)
    });
}

/**
 * 在当前目录网格末尾追加锁定占位卡片（先清除旧的，筛选/搜索中不显示）
 * @returns {number} 追加的卡片数
 */
function renderLockedCards(container) {
    container.querySelectorAll('.locked-card').forEach(el => el.remove());
    if (!State.IS_ADMIN || !Admin?.uiUnlock || isFiltering()) return 0;

    const locked = State.AppState.lockedNodes || [];
    if (locked.length === 0) return 0;

    const cur = State.AppState.pathStack[State.AppState.pathStack.length - 1];
    const parentId = cur === 'root' ? 'root' : cur.id;
    const mine = locked.filter(n => n.parentId === parentId);
    mine.forEach(n => container.appendChild(createLockedCard(n)));

    // 有锁定卡片时不再显示空列表提示
    if (mine.length > 0) container.querySelector('.empty-tip')?.remove();
    return mine.length;
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
        renderLockedCards(container);
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
            } else {
                renderLockedCards(container);
            }
        }
        renderBatch();
    } else {
        // Patch Render (Preserves cover images to avoid reload flicker)
        // 先移除锁定卡片，避免影响下标定位，渲染完成后再重新追加
        container.querySelectorAll('.locked-card').forEach(el => el.remove());
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
        renderLockedCards(container);
    }
}
