/**
 * MAERS CMS - Search Module (cms-search.module.js)
 * 职责：搜索输入、过滤逻辑、自动调整输入框大小
 * @version 3.0.0 - ES6 Module
 */

import { Search as SearchUtils } from '../../../shared/utils.module.js';

// Dependency injection
let State = null;
let Render = null;
let Tags = null;
let LiteratureView = null;

export function initSearch(state, render, tags = null, literatureView = null) {
    State = state;
    Render = render;
    Tags = tags;
    LiteratureView = literatureView;
}

export function setupSearchListeners() {
    if (!State) {
        console.warn('[CMS.Search] State not initialized yet');
        return;
    }

    const mainInput = document.getElementById(State.SELECTORS.SEARCH_INPUT.slice(1));
    if (mainInput) {
        mainInput.addEventListener("input", (e) => {
            autoResizeInput(e.target);
            applyFilter();
        });
    }

    const drawerInput = document.getElementById("tag-drawer-search");
    if (drawerInput) {
        drawerInput.addEventListener("input", () => {
            if (Tags?.refreshDrawerList) {
                Tags.refreshDrawerList();
            }
        });
    }
}

export function autoResizeInput(input) {
    const span = document.createElement("span");
    span.style.font = getComputedStyle(input).font;
    span.style.visibility = "hidden";
    span.style.position = "absolute";
    span.style.whiteSpace = "pre";
    span.textContent = input.value || input.placeholder;
    document.body.appendChild(span);
    input.style.width =
        Math.max(260, Math.min(span.offsetWidth + 60, 600)) + "px";
    document.body.removeChild(span);
}

export function applyFilter() {
    const mainInput = document.getElementById(State.SELECTORS.SEARCH_INPUT.slice(1));
    const keywordStr = mainInput ? mainInput.value.trim() : "";

    const Search = SearchUtils;
    if (!Search) return;

    // [Fix] Search Scope: Based on current path, not always root.
    // This allows filtering "within" a folder when navigating.
    let searchScope = State.AppState.root;
    if (State.AppState.pathStack && State.AppState.pathStack.length > 0) {
        const current = State.AppState.pathStack[State.AppState.pathStack.length - 1];
        if (current !== 'root' && current.children) {
            searchScope = current.children;
        }
    }

    const results = Search.filterNodes(
        searchScope,
        State.AppState.activeFilters,
        keywordStr,
    );

    const hasFilter = State.AppState.activeFilters.size > 0 || keywordStr;

    // Handle Literature view mode switching
    if (LiteratureView?.setMode) {
        if (hasFilter) {
            LiteratureView.setMode('grid');
        } else {
            LiteratureView.setMode('gallery');
        }
    }

    // Render grid with filtered results
    if (Render?.renderGrid) {
        if (hasFilter) {
            Render.renderGrid(results, true);
        } else {
            const current = State.AppState.pathStack[State.AppState.pathStack.length - 1];
            const list = current === "root" ? State.AppState.root : current.children;
            Render.renderGrid(list);
        }
    }

    // [Fix]: Update breadcrumb (overlay) when filtering
    if (Render?.renderBreadcrumb) {
        Render.renderBreadcrumb();
    }
}

export const Search = {
    setupSearchListeners,
    autoResizeInput,
    applyFilter
};
