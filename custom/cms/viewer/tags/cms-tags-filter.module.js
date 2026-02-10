/**
 * @module custom/cms/viewer/tags/cms-tags-filter.module.js
 * @description CMS 标签筛选 - 筛选逻辑与状态管理
 * @version 1.0.0 - ES6 Module
 */

// Dependency injection
let State = null;
let Search = null;

export function initFilter(deps) {
    State = deps.State;
    Search = deps.Search;
}

export function filterByTag(e, tag) {
    if (e && (e.target.closest('.dragging') || e.target.classList.contains('dragging'))) return;
    if (e) e.stopPropagation();

    if (State.AppState.activeFilters.has(tag)) {
        State.AppState.activeFilters.delete(tag);
        State.removeFilter(tag);
    } else {
        State.AppState.activeFilters.add(tag);
        State.addFilter(tag);
    }

    if (Search?.applyFilter) Search.applyFilter();
}

export function clearTagFilter() {
    State.AppState.activeFilters.clear();
    const mainInput = document.getElementById("search-input");
    if (mainInput) mainInput.value = "";
    if (Search?.applyFilter) Search.applyFilter();
}

export function selectTagFromDrawer(tag) {
    if (!State.AppState.activeFilters.has(tag)) {
        State.AppState.activeFilters.add(tag);
        if (Search?.applyFilter) Search.applyFilter();
    }
}
