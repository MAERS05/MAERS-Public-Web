/**
 * MAERS CMS - Render Module (cms-render.module.js)
 * 职责：网格渲染、面包屑渲染、分片渲染优化
 * @version 3.0.0 - ES6 Module
 */

import { AdminButtonHelper } from '../../shared/admin-core.module.js';

// Dependency injection
let State = null;
let Admin = null;
let Controller = null;
let Events = null;
let Drag = null;
let LiteratureView = null;
let Search = null;

export function initRender(state, admin = null, controller = null, events = null, drag = null, literatureView = null, search = null) {
    State = state;
    Admin = admin;
    Controller = controller;
    Events = events;
    Drag = drag;
    LiteratureView = literatureView;
    Search = search;
}

// const DEFAULT_COVER = 'photos/images/covers/default-book-cover.png'; Remove unused constant
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

    // Admin Core Styling Integration
    let manager = null;
    if (State.IS_ADMIN && Admin) {
        manager = Admin.getManager?.();
        if (manager) {
            // Use Manager to determine styling (selected, deleted, order)
            const extraClass = manager.getItemClass(index);
            className += ` ${extraClass}`;

            // Fix: Add data-order-num attribute for CSS counter
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

    const icon = window.MAERS?.ModuleConfig
        ? window.MAERS.ModuleConfig.getNodeIcon(node.type)
        : node.type === "folder" ? "📁" : "📝";

    // Admin Actions - Build using DOM API
    if (State.IS_ADMIN && Admin && AdminButtonHelper) {
        const isDeleted = manager ? manager.isDeleted(index) : false;
        const isLitModule = (Controller?.CONFIG?.CURRENT_MODULE === 'literature') || (window.location.search.includes('module=literature'));

        // Create wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'maers-admin-action-group';
        wrapper.style.cssText = "position: absolute; top: 5px; right: 5px; z-index: 10; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; max-width: 140px;";

        // Helper to create buttons
        const createBtn = (icon, title, onClick) => {
            const btn = document.createElement('span');
            btn.className = 'maers-admin-btn';
            btn.title = title;
            btn.textContent = icon;
            btn.addEventListener('click', onClick);
            return btn;
        };

        // Standard buttons
        wrapper.appendChild(createBtn('≡', 'Select', (e) => Admin.uiPickNode(e, node.id)));
        wrapper.appendChild(createBtn('✎', 'Rename', (e) => Admin.uiRenameNode(e, node.id, node.title)));

        const delIcon = isDeleted ? '↺' : '✕';
        const delBtn = createBtn(delIcon, 'Delete/Undo', (e) => Admin.uiDeleteNode(e, node.id));
        if (isDeleted) delBtn.classList.add('btn-delete-active');
        wrapper.appendChild(delBtn);

        // Add Tag button
        wrapper.appendChild(createBtn('＋', 'Add Tag', (e) => Admin.uiAddTag(e, node.id)));

        // Literature-specific buttons
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
    } else {
        const iconDiv = document.createElement('div');
        iconDiv.className = 'item-icon';
        iconDiv.textContent = icon;
        el.appendChild(iconDiv);
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

    // --- STRATEGY SELECTION ---
    // Rule: If container is empty, use fast batch rendering (First Load).
    // Rule: If container has items, use Diff Rendering (Update) to preserve scroll.

    if (container.children.length === 0 || container.querySelector('.empty-tip')) {
        // --- Mode 1: Batch Render (Fast Initial Load) ---
        container.innerHTML = ""; // Clear potential empty-tip
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
        // --- Mode 2: Diff Render (Scroll Preservation) ---
        // Synchronous execution is required to prevent UI jitter/jump during updates.

        // 1. Snapshot existing nodes
        const existingNodes = new Map();
        Array.from(container.children).forEach(el => {
            if (el.dataset.id) existingNodes.set(el.dataset.id, el);
        });

        // 2. Reperceive (Reconcile)
        // We iterate through the NEW list order and enforce it in the DOM
        sortedList.forEach((item, index) => {
            const newEl = createGridItem(item, State, index);
            const existingEl = existingNodes.get(item.id);

            // The element that is currently at this position (if any)
            const occupant = container.children[index];

            if (existingEl) {
                // Update: Replace the old node with the new one (updates content/events)
                // Note: unique ID logic ensures we are operating on the correct persistent item
                existingEl.replaceWith(newEl);

                // Position Check: logic above puts newEl in DOM where existingEl WAS.
                // Now we must ensure it is at 'index'. 
                // If the replaced position != current expected index, move it.
                if (newEl !== container.children[index]) {
                    container.insertBefore(newEl, container.children[index]);
                }
            } else {
                // Insert: New item appearing in the list
                container.insertBefore(newEl, occupant || null);
            }
        });

        // 3. Cleanup Stale Nodes
        // Any node remaining after the length of sortedList is implicitly stale 
        // because we packed all valid nodes to the top 0..N-1 indexes.
        while (container.children.length > sortedList.length) {
            container.lastElementChild.remove();
        }
    }
}

export function renderBreadcrumb() {
    const container = document.getElementById("breadcrumb");
    if (!container) return;
    container.innerHTML = "";

    const rootSpan = document.createElement("span");
    rootSpan.className = `crumb-item ${State.AppState.pathStack.length === 1 ? "active" : ""}`;
    rootSpan.innerText = "Root";
    rootSpan.onclick = (e) => {
        e.stopPropagation();
        navigateTo(-1);
    };

    if (State.IS_ADMIN) bindDragNav(rootSpan, -1);
    container.appendChild(rootSpan);

    for (let i = 1; i < State.AppState.pathStack.length; i++) {
        const node = State.AppState.pathStack[i];
        const sep = document.createElement("span");
        sep.className = "crumb-separator";
        sep.innerText = " / ";
        container.appendChild(sep);

        const item = document.createElement("span");
        item.className = `crumb-item ${i === State.AppState.pathStack.length - 1 ? "active" : ""}`;
        item.innerText = node.title || node;
        item.onclick = (e) => {
            e.stopPropagation();
            navigateTo(i);
        };

        if (State.IS_ADMIN) bindDragNav(item, i);
        container.appendChild(item);
    }

    function bindDragNav(el, index) {
        if (Drag) {
            Drag.bindBreadcrumbDrop?.(el, index, (idx) => {
                if (idx === -1) navigateTo(-1);
                else navigateTo(idx);
            });
        }
    }
}

export function navigateTo(index) {
    if (index === -1) {
        State.AppState.pathStack = ["root"];
    } else {
        State.AppState.pathStack = State.AppState.pathStack.slice(0, index + 1);
    }

    // [Fix]: Re-apply filter if active, instead of resetting to full grid
    if (Search && Search.applyFilter) {
        const searchInput = document.getElementById(State.SELECTORS.SEARCH_INPUT.slice(1));
        const hasSearch = searchInput && searchInput.value.trim().length > 0;
        const hasFilter = State.AppState.activeFilters.size > 0;

        if (hasSearch || hasFilter) {
            renderBreadcrumb();
            Search.applyFilter();
            return;
        }
    }

    const target = State.AppState.pathStack[State.AppState.pathStack.length - 1];
    const list = target === "root" ? State.AppState.root : target.children;

    // Navigation implies Reset
    renderGrid(list, false, true);
    renderBreadcrumb();
}

export function enterFolder(node) {
    State.AppState.pathStack.push(node);

    // [Fix]: Re-apply filter if active
    if (Search && Search.applyFilter) {
        const searchInput = document.getElementById(State.SELECTORS.SEARCH_INPUT.slice(1));
        const hasSearch = searchInput && searchInput.value.trim().length > 0;
        const hasFilter = State.AppState.activeFilters.size > 0;

        if (hasSearch || hasFilter) {
            renderBreadcrumb();
            Search.applyFilter();
            return;
        }
    }

    renderBreadcrumb();
    // Entering folder implies Reset
    renderGrid(node.children, false, true);
}

export function renderPageTitle() {
    const titleEl = document.querySelector(".header-title");
    if (!titleEl) return;

    if (State.CONFIG.CURRENT_MODULE === 'literature') {
        if (LiteratureView?.engine) {
            LiteratureView.engine.updateHeaderTitle();
        }
        return;
    }

    if (window.MAERS?.ModuleConfig) {
        titleEl.textContent = window.MAERS.ModuleConfig.getTitle(State.CONFIG.CURRENT_MODULE);
    } else {
        const iconMap = { notes: "✒️", literature: "📙", record: "📝" };
        const titleMap = { notes: "Study Notes", literature: "Literature", record: "Records" };
        const icon = iconMap[State.CONFIG.CURRENT_MODULE] || "📂";
        const text = titleMap[State.CONFIG.CURRENT_MODULE] || State.CONFIG.CURRENT_MODULE.toUpperCase();
        titleEl.textContent = `${icon} ${text}`;
    }

    if (window.MAERS?.Theme?.setupZoomTrigger) {
        window.MAERS.Theme.setupZoomTrigger(titleEl, 'icon_only', true);
    }
}

export const Render = {
    renderGrid,
    renderBreadcrumb,
    navigateTo,
    enterFolder,
    renderPageTitle
};
