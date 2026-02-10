/**
 * MAERS CMS - Shared State Module (cms-state.module.js)
 * 职责：管理所有CMS模块的共享状态
 * @version 3.0.0 - ES6 Module
 */

import { Utils } from '../../../shared/utils.module.js';

// DOM Selectors (Constants)
export const SELECTORS = {
    HEADER_RIGHT: ".header-right",
    ADMIN_BTN_GROUP: ".admin-btn-group",
    TAG_TOGGLE_BTN: ".tag-toggle-btn",
    GRID_ITEM: ".grid-item",
    MINI_TAG: ".mini-tag",
    BREADCRUMB: "#breadcrumb",
    GRID_CONTAINER: "#grid-container",
    TAG_DRAWER: "#tag-drawer",
    DRAWER_OVERLAY: "#drawer-overlay",
    DRAWER_LIST: "#drawer-list",
    SEARCH_INPUT: "#search-input",
    TAG_DRAWER_SEARCH: "#tag-drawer-search",
    LIGHTBOX: "#img-lightbox",
    LIGHTBOX_IMG: "#lightbox-img",
    MOVE_GHOST: "#move-ghost"
};

// Internal state references (shared across all modules)
let AppState = null;
let CONFIG = null;
let IS_ADMIN = false;

// Render control state
let currentRenderTask = 0;
let gridEventsDelegated = false;

// Filter order tracking for breadcrumb navigation
let filterOrder = [];

// Dependency injection - Controller will be injected
let Controller = null;

export function initState(controller) {
    Controller = controller;
}

// State management object
export const State = {
    SELECTORS, // Expose SELECTORS through State for backward compatibility
    get AppState() { return AppState; },
    set AppState(val) { AppState = val; },
    get CONFIG() { return CONFIG; },
    set CONFIG(val) { CONFIG = val; },
    get IS_ADMIN() { return IS_ADMIN; },
    set IS_ADMIN(val) { IS_ADMIN = val; },
    get currentRenderTask() { return currentRenderTask; },
    get gridEventsDelegated() { return gridEventsDelegated; },

    initState(appState, config) {
        AppState = appState;
        CONFIG = config;
        IS_ADMIN = Controller?.CONFIG?.IS_ADMIN || false;
    },

    incrementRenderTask() {
        return ++currentRenderTask;
    },

    markGridEventsDelegated() {
        gridEventsDelegated = true;
    },

    // Utility function accessors (eliminates redundant wrapping in other modules)
    escapeHtml(input) {
        return Utils ? Utils.escapeHtml(input) : String(input ?? '');
    },

    escapeAttr(input) {
        return Utils ? Utils.escapeAttr(input) : String(input ?? '');
    },

    addFilter(filterItem) {
        if (!filterOrder.includes(filterItem)) {
            filterOrder.push(filterItem);
        }
    },

    removeFilter(filterItem) {
        const index = filterOrder.indexOf(filterItem);
        if (index !== -1) {
            filterOrder.splice(index, 1);
        }
    },

    jumpToFilter(filterItem) {
        const index = filterOrder.indexOf(filterItem);
        if (index !== -1) {
            filterOrder = filterOrder.slice(0, index + 1);
        }
    },

    getFilterOrder() {
        return filterOrder;
    },

    clearFilters() {
        filterOrder = [];
    }
};
