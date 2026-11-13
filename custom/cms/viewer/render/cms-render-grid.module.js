/**
 * @module custom/cms/viewer/render/cms-render-grid.module.js
 * @description CMS 网格渲染 - 卡片生成与分片渲染优化
 * @version 1.0.0 - ES6 Module
 */
import { localFetch } from '../../../../data-manage/api-client.module.js';
import { DataProvider, publicMediaUrl } from '../../../../data-manage/data-provider.module.js';

import { AdminButtonHelper } from '../../../../data-manage/admin/admin-base.module.js';
import { disableAdminControl, isLocalOnlyUnavailable } from '../../../../data-manage/admin/local-only.module.js';
import { hasProtectedCmsContent } from '../../../../data-manage/sync/relay-actions.module.js';
import { renderLockedCard, setupLockActionButton } from '../../../../data-manage/encrypt/admin-lock.module.js';
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

const COVER_MODULES = ['literature', 'games', 'videos'];

function updateItemState(el, node, state, index) {
    const manager = state.IS_ADMIN && Admin ? Admin.getManager?.() : null;
    el.className = `grid-item type-${node.type}${manager ? ` ${manager.getItemClass(index)}` : ''}`;
    const selectedIndex = manager?.selectedIndices?.indexOf(index) ?? -1;
    if (selectedIndex >= 0) el.setAttribute('data-order-num', selectedIndex + 1);
    else el.removeAttribute('data-order-num');
    el.dataset.id = node.id;
    el.setAttribute('data-tags', (node.tags || []).join(' '));
    el.setAttribute('data-type', node.type);
    return manager;
}

function createAdminActions(node, state, manager, index) {
    if (!state.IS_ADMIN || !Admin || !AdminButtonHelper) return null;
    const isDeleted = manager ? manager.isDeleted(index) : false;
    const currentMod = Controller?.CONFIG?.CURRENT_MODULE || '';
    const isLitModule = COVER_MODULES.some(module => currentMod === module || window.location.search.includes(`module=${module}`));
    const filtering = isFiltering();

    const wrapper = document.createElement('div');
    wrapper.className = 'maers-admin-action-group';
    wrapper.style.cssText = "position: absolute; top: 5px; right: 5px; z-index: 10; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; max-width: 140px;";

    const createBtn = (icon, title, onClick) => {
        const btn = document.createElement('span');
        btn.className = 'maers-admin-btn';
        btn.title = title;
        if (icon === 'remove-cover') btn.innerHTML = `<img class="maers-admin-icon--remove-cover" src="${REMOVE_COVER_ICON}" width="18" height="18" alt="" aria-hidden="true">`;
        else if (icon === '✎') btn.innerHTML = '<span class="maers-admin-edit-icon">✎</span>';
        else btn.textContent = icon;
        btn.addEventListener('click', onClick);
        return btn;
    };

    // 筛选结果不提供排序入口
    if (!filtering) {
        wrapper.appendChild(createBtn('≡', 'Select', (e) => Admin.uiPickNode(e, node.id)));
    }
    wrapper.appendChild(createBtn('✎', 'Rename', (e) => Admin.uiRenameNode(e, node.id, node.title)));

    wrapper.appendChild(createBtn('＋', 'Add Tag', (e) => Admin.uiAddTag(e, node.id)));

    // 普通列表和筛选列表都允许删除与撤销
    const delIcon = isDeleted ? '↺' : '✕';
    const delBtn = createBtn(delIcon, 'Delete/Undo', (e) => Admin.uiDeleteNode(e, node.id));
    if (isDeleted) delBtn.classList.add('btn-delete-active');
    if (isLocalOnlyUnavailable() && hasProtectedCmsContent(node, state.AppState.lockedNodes)) {
        disableAdminControl(delBtn, '整项删除加密内容仅限电脑本地后台');
    }
    wrapper.appendChild(delBtn);
    if (isLitModule) {
        if (!node.coverImage) {
            wrapper.appendChild(createBtn('🖼️', 'Upload Cover', (e) => Admin.uiUploadCover(e, node.id)));
        } else {
            wrapper.appendChild(createBtn('remove-cover', 'Remove Cover', (e) => Admin.uiRemoveCover(e, node.id)));
        }
    }

    if (Admin.uiLock) {
        // 父节点未加密的私密节点是加密操作的发起点（常驻解密图标）；父节点已加密则仅随上级。
        const parent = state.AppState.allNodes.find(item => item.id === node.parentId);
        const inherited = Boolean(node._private && !node._private_id && parent?._private);
        const isLockRoot = Boolean(node._private && !inherited);
        const lockTitle = inherited ? '随上级对外加密' : '对外加密' + (node.type === 'folder' ? '（含全部子文档）' : '');
        const lockBtn = document.createElement('span');
        lockBtn.className = 'maers-admin-btn';
        setupLockActionButton(lockBtn, {
            isLocked: Boolean(node._private_id || node._cloudEnvelope || isLockRoot),
            title: lockTitle,
            onClick: (e) => Admin.uiLock(e, node.id)
        });
        wrapper.appendChild(lockBtn);
    }

    AdminButtonHelper.injectStyles();
    return wrapper;
}

function createCover(node) {
    const coverUrl = DataProvider.getCoverUrl(node, 'thumb');
    const coverDiv = document.createElement('div');
    coverDiv.className = coverUrl ? 'item-cover' : 'item-cover placeholder';
    coverDiv.dataset.coverUrl = coverUrl || '';

    if (coverUrl) {
        const img = document.createElement('img');
        // 延迟加载与原生懒加载共用同一个图片节点
        if (lazyObserver) {
            img.setAttribute('data-src', coverUrl); // 保存待加载地址
            lazyObserver.observe(img); // 按可见性加载
        } else {
            img.src = coverUrl; // 无观察器时直接加载
        }
        img.loading = 'lazy'; // 同时保留原生懒加载
        img.decoding = 'async';
        img.className = 'item-cover-img';
        img.onload = () => coverDiv.classList.add('loaded');
        const alternatives = new Set([DataProvider.getCoverUrl(node, 'preview')]);
        if (DataProvider.isLocal) {
            alternatives.add(publicMediaUrl(node.coverImage, { local: true }));
            alternatives.add(DataProvider.getCoverUrl(node, 'thumb', { local: false }));
        }
        alternatives.add(publicMediaUrl(node.coverImage));
        alternatives.delete(coverUrl);
        const fallbacks = [...alternatives].filter(Boolean);
        // 缩略图缺失时先使用预览，最后再尝试原图。
        img.onerror = () => {
            const fallback = fallbacks.shift();
            if (fallback) {
                img.src = fallback;
                return;
            }
            img.style.display = 'none';
            coverDiv.classList.add('placeholder');
        };
        coverDiv.appendChild(img);
    }
    return coverDiv;
}

async function updateNodeTags(nodeId, newTags, state) {
    const node = state.AppState.allNodes.find(item => item.id === nodeId);
    if (!node) return false;
    const oldTags = [...(node.tags || [])];
    node.tags = newTags;
    if (!_isLocalBackend()) {
        Controller?.refreshView?.(false, true);
        return false;
    }
    const module = Controller?.CONFIG?.CURRENT_MODULE || 'notes';
    try {
        const res = await localFetch(`/api/cms/update_tags?module=${module}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: nodeId, tags: newTags })
        });
        if (res.ok) Controller?.refreshView?.(false, true);
        else node.tags = oldTags;
    } catch (error) {
        node.tags = oldTags;
        console.error('[MAERS.CMS] 标签更新失败', error);
        window.MAERS?.Toast?.error('标签更新失败');
    }
    return false;
}

function createTags(node, state) {
    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'item-tags';
    for (const tag of node.tags || []) {
        const span = document.createElement('span');
        span.className = 'mini-tag';
        if (state.AppState.activeFilters.has(tag)) span.classList.add('active');
        span.textContent = `#${tag}`;
        span.dataset.tag = tag;
        if (state.IS_ADMIN) span.dataset.nodeId = node.id;
        tagsDiv.appendChild(span);
    }
    if (state.IS_ADMIN && Admin && tagsDiv.children.length) {
        setupTagDragAndMenu({
            tagsContainer: tagsDiv,
            getTags: () => state.AppState.allNodes.find(item => item.id === node.id)?.tags || [],
            onTagsUpdate: newTags => updateNodeTags(node.id, newTags, state)
        });
    }
    return tagsDiv;
}

export function createGridItem(node, state, index) {
    const el = document.createElement('div');
    const manager = updateItemState(el, node, state, index);
    if (state.IS_ADMIN && Admin) Drag?.setupItemDrag?.(el, node);
    const actions = createAdminActions(node, state, manager, index);
    if (actions) el.appendChild(actions);
    if (COVER_MODULES.includes(Controller?.CONFIG?.CURRENT_MODULE)) el.appendChild(createCover(node));
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = node.title;
    el.appendChild(title);
    const divider = document.createElement('div');
    divider.className = 'item-divider';
    el.appendChild(divider);
    el.appendChild(createTags(node, state));
    return el;
}

// 原位更新卡片，保留地址未变的封面节点及其加载状态。
function patchGridItem(el, node, state, index) {
    const manager = updateItemState(el, node, state, index);
    const actions = createAdminActions(node, state, manager, index);
    if (actions) {
        const previous = el.querySelector('.maers-admin-action-group');
        if (previous) previous.replaceWith(actions);
        else el.insertBefore(actions, el.firstChild);
    }
    if (COVER_MODULES.includes(Controller?.CONFIG?.CURRENT_MODULE)) {
        const cover = el.querySelector('.item-cover');
        const coverUrl = DataProvider.getCoverUrl(node, 'thumb');
        // 比较原始封面地址，未加载或已回退的图片也能复用。
        if (cover && coverUrl !== (cover.dataset.coverUrl || null)) cover.replaceWith(createCover(node));
    }
    const title = el.querySelector('.item-title');
    if (title && title.textContent !== node.title) title.textContent = node.title;
    const tags = el.querySelector('.item-tags');
    if (tags) tags.replaceWith(createTags(node, state));
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
