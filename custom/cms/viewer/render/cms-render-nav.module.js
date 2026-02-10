/**
 * @module custom/cms/viewer/render/cms-render-nav.module.js
 * @description CMS 导航渲染 - 面包屑与导航逻辑
 * @version 1.0.0 - ES6 Module
 */

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
    prefix.textContent = "Filter : ";
    prefix.style.marginRight = "8px";
    prefix.style.opacity = "0.6";
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
        item.textContent = "All";
        overlay.appendChild(item);
    }

    container.appendChild(overlay);

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
    const titleEl = document.querySelector(".header-title");
    if (!titleEl) return;

    let desiredHTML = '';
    if (window.MAERS?.ModuleConfig) {
        desiredHTML = window.MAERS.ModuleConfig.getTitle(State.CONFIG.CURRENT_MODULE);
    } else {
        const iconMap = {
            notes: '<img src="ui/notes-icon.svg" style="height: 1.25em; vertical-align: middle;">',
            literature: '<img src="ui/literature-icon.svg" style="height: 1.25em; vertical-align: middle;">',
            record: '<img src="ui/record-icon.svg" style="height: 1.25em; vertical-align: middle;">',
            album: '<img src="ui/album-icon.svg" style="height: 1.25em; vertical-align: middle;">'
        };
        const titleMap = { notes: "Study Notes", literature: "Literature", record: "Records" };
        const icon = iconMap[State.CONFIG.CURRENT_MODULE] || "📂";
        const text = titleMap[State.CONFIG.CURRENT_MODULE] || State.CONFIG.CURRENT_MODULE.toUpperCase();
        desiredHTML = `${icon} ${text}`;
    }

    const imgMatch = desiredHTML.match(/^<img src="([^"]+)"[^>]*>\s*(.*)$/);

    if (imgMatch) {
        const targetSrc = imgMatch[1];
        const targetText = imgMatch[2];

        const existingImg = titleEl.querySelector('img');
        if (existingImg && existingImg.getAttribute('src') === targetSrc) {
            let node = existingImg.nextSibling;
            while (node) {
                const next = node.nextSibling;
                node.remove();
                node = next;
            }

            titleEl.appendChild(document.createTextNode(' ' + targetText.trim()));

            if (window.MAERS?.Theme?.setupZoomTrigger) {
                window.MAERS.Theme.setupZoomTrigger(existingImg, 'icon_only', true);
            }
            return;
        }
    }

    titleEl.innerHTML = desiredHTML;

    if (window.MAERS?.Theme?.setupZoomTrigger) {
        const img = titleEl.querySelector('img');
        if (img) {
            window.MAERS.Theme.setupZoomTrigger(img, 'icon_only', true);
        } else {
            window.MAERS.Theme.setupZoomTrigger(titleEl, 'icon_only', true);
        }
    }
}

export const Nav = {
    renderBreadcrumb
};
