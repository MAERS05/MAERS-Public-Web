/**
 * @module custom/cms/viewer/render/cms-render-nav.module.js
 * @description CMS 导航渲染 - 面包屑与导航逻辑
 * @version 1.0.0 - ES6 Module
 */
import { ModuleConfig } from '../../../../shared/module-config.module.js';

// Dependency injection
let State = null;
let Search = null;
let Drag = null;
let renderGridCallback = null;
let renderBreadcrumbCallback = null;

export function initNav(deps) {
    State = deps.State;
    Search = deps.Search;
    Drag = deps.Drag;
    renderGridCallback = deps.renderGrid;
    renderBreadcrumbCallback = deps.renderBreadcrumb;
}

export function renderBreadcrumb() {
    const container = document.getElementById("breadcrumb");
    if (!container) return;

    const searchInput = document.getElementById('search-input');
    const hasSearch = searchInput && searchInput.value.trim().length > 0;
    const hasFilter = State.AppState.activeFilters.size > 0;

    container.innerHTML = "";

    const isSearching = hasSearch || hasFilter;
    if (isSearching) {
        container.classList.add("is-searching");
    } else {
        container.classList.remove("is-searching");
    }

    const overlay = document.createElement("div");
    overlay.className = `breadcrumb-overlay ${isSearching ? 'active' : ''}`;

    const prefix = document.createElement("span");
    prefix.className = "filter-prefix";
    prefix.textContent = "筛选：";
    prefix.style.marginRight = "8px";
    prefix.style.opacity = "0.6";
    prefix.style.cursor = "pointer"; // Make it clickable
    prefix.style.transition = "opacity 0.2s";

    // Add interactions
    prefix.onclick = (e) => {
        e.stopPropagation();
        handleFilterBack();
    };
    prefix.onmouseover = () => {
        prefix.style.opacity = "1";
        prefix.title = "返回并清空筛选";
    };
    prefix.onmouseout = () => {
        prefix.style.opacity = "0.6";
    };

    overlay.appendChild(prefix);

    const items = State.getFilterOrder();

    if (items.length > 0) {
        items.forEach((filterItem, index) => {
            if (index > 0) {
                const sep = document.createElement("span");
                sep.className = "filter-separator";
                sep.textContent = " / ";
                overlay.appendChild(sep);
            }

            const item = document.createElement("span");
            item.className = "filter-item";
            item.textContent = filterItem;

            item.onclick = (e) => {
                e.stopPropagation();
                jumpToFilterItem(filterItem);
            };

            overlay.appendChild(item);
        });
    } else {
        const item = document.createElement("span");
        item.className = "filter-item";
        item.textContent = "全部";
        overlay.appendChild(item);
    }

    container.appendChild(overlay);

    const rootSpan = document.createElement("span");
    rootSpan.className = `crumb-item ${State.AppState.pathStack.length === 1 ? "active" : ""}`;
    rootSpan.innerText = "全部内容";
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

function handleFilterBack() {
    const currentOrder = State.getFilterOrder();

    if (currentOrder.length > 1) {
        // Step back one level (e.g. [A, B] -> Jump to A)
        const targetItem = currentOrder[currentOrder.length - 2];
        jumpToFilterItem(targetItem);
    } else {
        // Clear all filters if only one level or empty
        State.clearFilters();
        State.AppState.activeFilters.clear();

        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.value = "";
            if (Search && Search.autoResizeInput) {
                Search.autoResizeInput(searchInput);
            }
        }

        if (Search && Search.applyFilter) {
            Search.applyFilter();
        }
    }
}

function jumpToFilterItem(filterItem) {
    State.jumpToFilter(filterItem);

    const newOrder = State.getFilterOrder();
    const searchInput = document.getElementById('search-input');

    State.AppState.activeFilters.clear();

    newOrder.forEach(item => {
        const isSearchKeyword = searchInput && searchInput.value.trim() === item;
        if (!isSearchKeyword) {
            State.AppState.activeFilters.add(item);
        }
    });

    const lastItem = newOrder[newOrder.length - 1];
    const isLastItemSearch = searchInput && !State.AppState.activeFilters.has(lastItem);

    if (isLastItemSearch) {
        searchInput.value = lastItem;
        if (Search && Search.autoResizeInput) {
            Search.autoResizeInput(searchInput);
        }
    } else if (searchInput && !newOrder.includes(searchInput.value.trim())) {
        searchInput.value = "";
        if (Search && Search.autoResizeInput) {
            Search.autoResizeInput(searchInput);
        }
    }

    if (Search && Search.applyFilter) {
        Search.applyFilter();
    }
}

export function navigateTo(index) {
    if (index === -1) {
        State.AppState.pathStack = ["root"];
    } else {
        State.AppState.pathStack = State.AppState.pathStack.slice(0, index + 1);
    }

    if (Search && Search.applyFilter) {
        const searchInput = document.getElementById('search-input');
        const hasSearch = searchInput && searchInput.value.trim().length > 0;
        const hasFilter = State.AppState.activeFilters.size > 0;

        if (hasSearch || hasFilter) {
            renderBreadcrumbCallback();
            Search.applyFilter();
            return;
        }
    }

    const target = State.AppState.pathStack[State.AppState.pathStack.length - 1];
    const list = target === "root" ? State.AppState.root : target.children;

    renderGridCallback(list, false, true);
    renderBreadcrumbCallback();
}

export function enterFolder(node) {
    State.AppState.pathStack.push(node);

    if (Search && Search.applyFilter) {
        const searchInput = document.getElementById('search-input');
        const hasSearch = searchInput && searchInput.value.trim().length > 0;
        const hasFilter = State.AppState.activeFilters.size > 0;

        if (hasSearch || hasFilter) {
            renderBreadcrumbCallback();
            Search.applyFilter();
            return;
        }
    }

    renderBreadcrumbCallback();
    renderGridCallback(node.children, false, true);
}

export function renderPageTitle() {
    const titleEl = document.querySelector('.header-title');
    if (!titleEl) return;
    titleEl.classList.remove('zoom-trigger-icon', 'zoom-trigger-whole');
    titleEl.innerHTML = ModuleConfig.getTitle(State.CONFIG.CURRENT_MODULE, State.IS_ADMIN);
}

export const Nav = {
    renderBreadcrumb
};
