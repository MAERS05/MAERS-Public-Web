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
        let lastKeyword = "";

        mainInput.addEventListener("input", (e) => {
            const currentKeyword = e.target.value.trim();

            if (lastKeyword === "" && currentKeyword !== "") {
                State.addFilter(currentKeyword);
            } else if (lastKeyword !== "" && currentKeyword === "") {
                State.removeFilter(lastKeyword);
            } else if (lastKeyword !== "" && currentKeyword !== "" && lastKeyword !== currentKeyword) {
                State.removeFilter(lastKeyword);
                State.addFilter(currentKeyword);
            }

            lastKeyword = currentKeyword;

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

    // Search Scope: Current folder's immediate children
    let searchScope = State.AppState.root;

    if (State.AppState.pathStack && State.AppState.pathStack.length > 0) {
        const current = State.AppState.pathStack[State.AppState.pathStack.length - 1];
        if (current !== 'root' && current.children) {
            searchScope = current.children;
        }
    }

    // When tag filters are active, only search immediate children (non-recursive)
    const hasTagFilters = State.AppState.activeFilters.size > 0;
    let results;

    if (hasTagFilters && !keywordStr) {
        // Tag-only filter: non-recursive, immediate children only

        results = searchScope.filter(node => {
            if (!node.tags) return false;
            for (let tag of State.AppState.activeFilters) {
                if (!node.tags.includes(tag)) return false;
            }
            return true;
        });
    } else {
        // Keyword search or combined: use recursive search
        results = Search.filterNodes(
            searchScope,
            State.AppState.activeFilters,
            keywordStr,
        );
    }

    const hasFilter = State.AppState.activeFilters.size > 0 || keywordStr;

    // Handle Literature view mode switching
    if (LiteratureView?.setMode) {
        if (hasFilter) {
            LiteratureView.setMode('grid');
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
