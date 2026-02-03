/**
 * MAERS CMS - View Layer (cms-view.module.js)
 * 职责：主入口、模块协调、统一API导出
 * 依赖：所有CMS子模块
 * @version 3.0.0 - ES6 Module
 */

// Dependency injection
let State = null;
let Search = null;
let Tags = null;
let Render = null;
let Events = null;
let Lightbox = null;
let Admin = null;
let Controller = null;
let Editor = null;

export function initView(modules) {
    State = modules.State;
    Search = modules.Search;
    Tags = modules.Tags;
    Render = modules.Render;
    Events = modules.Events;
    Lightbox = modules.Lightbox;
    Admin = modules.Admin;
    Controller = modules.Controller;
    Editor = modules.Editor;
}

/**
 * Initialize CMS View
 * @param {Object} appState - Application state
 * @param {Object} config - Configuration object
 */
export function init(appState, config) {
    // Restore Dynamic Style Loading (Critical for specific modules like Literature)
    if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        const module = (config && config.CURRENT_MODULE) || params.get('module') || 'notes';

        // Load module-specific CSS if not already present
        if (!document.querySelector(`link[href*="custom/${module}/viewer/${module}.css"]`)) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = `custom/${module}/viewer/${module}.css`;
            document.head.appendChild(link);
        }
    }

    // Initialize shared state
    if (State?.initState) {
        State.initState(appState, config);
    }

    // Initialize lightbox
    if (Lightbox?.initLightbox) {
        Lightbox.initLightbox();
    }

    // Initialize admin features if admin mode
    const IS_ADMIN = Controller?.CONFIG?.IS_ADMIN || false;
    if (IS_ADMIN && Admin?.initAdminFeatures) {
        Admin.initAdminFeatures();
    }
}

// Create unified API object by combining all module exports
export const View = {
    // Core
    init,

    // Search Module
    setupSearchListeners: () => Search?.setupSearchListeners(),
    autoResizeInput: (input) => Search?.autoResizeInput(input),
    applyFilter: () => Search?.applyFilter(),

    // Tags Module
    filterByTag: (e, tag) => Tags?.filterByTag(e, tag),
    toggleTagDrawer: () => Tags?.toggleTagDrawer(),
    refreshDrawerList: () => Tags?.refreshDrawerList(),
    selectTagFromDrawer: (tag) => Tags?.selectTagFromDrawer(tag),
    clearTagFilter: () => Tags?.clearTagFilter(),

    // Render Module
    renderGrid: (list, isSearch) => Render?.renderGrid(list, isSearch),
    renderBreadcrumb: () => Render?.renderBreadcrumb(),
    renderPageTitle: () => Render?.renderPageTitle(),
    navigateTo: (index) => Render?.navigateTo(index),
    enterFolder: (node) => Render?.enterFolder(node),

    // Events Module
    setupGridEventDelegation: () => Events?.setupGridEventDelegation(),

    // Lightbox Module
    showLightbox: (src) => Lightbox?.showLightbox(src),
    closeLightbox: () => Lightbox?.closeLightbox(),

    // Admin Module
    uiCreateNode: (type) => Admin?.uiCreateNode(type),
    uiRenameNode: (e, id, old) => Admin?.uiRenameNode(e, id, old),
    uiDeleteNode: (e, id) => Admin?.uiDeleteNode(e, id),
    uiPickNode: (e, id) => Admin?.uiPickNode(e, id),
    uiCancelPick: () => Admin?.uiCancelPick(),
    uiExecuteMove: (pid) => Admin?.uiExecuteMove(pid),
    uiAddTag: (e, id) => Admin?.uiAddTag(e, id),
    uiRemoveTag: (e, id, tag) => Admin?.uiRemoveTag(e, id, tag),
    uiUploadCover: (e, id) => Admin?.uiUploadCover(e, id),
    uiRemoveCover: (e, id) => Admin?.uiRemoveCover(e, id),
    refreshView: () => Admin?.refreshView()
};

// Event Binding (to be called from entry point after DOM is ready)
export function setupViewEventListeners() {
    // Tag Drawer
    const tagToggleBtn = document.querySelector(".tag-toggle-btn");
    const overlay = document.getElementById("drawer-overlay");
    const closeDrawerBtn = document.querySelector(".btn-close-drawer");
    const clearTagsBtn = document.querySelector(".btn-clear-tags");
    const drawerSearch = document.getElementById("tag-drawer-search");
    const drawerList = document.getElementById("drawer-list");

    if (tagToggleBtn)
        tagToggleBtn.addEventListener("click", () => View.toggleTagDrawer());
    if (overlay)
        overlay.addEventListener("click", () => View.toggleTagDrawer());
    if (closeDrawerBtn)
        closeDrawerBtn.addEventListener("click", () => View.toggleTagDrawer());
    if (clearTagsBtn)
        clearTagsBtn.addEventListener("click", () => View.clearTagFilter());
    if (drawerSearch)
        drawerSearch.addEventListener("input", () => View.refreshDrawerList());

    // Drawer List Event Delegation
    if (drawerList) {
        drawerList.addEventListener("click", (e) => {
            const drawerItem = e.target.closest(".drawer-item");
            if (drawerItem) {
                const tag = drawerItem.dataset.tag;
                if (tag) View.selectTagFromDrawer(tag);
            }
        });
    }

    // Editor Close (Static binding, dynamic ones handled in Editor.open)
    const editorCloseBtns = document.querySelectorAll(".close-btn");
    editorCloseBtns.forEach((btn) => {
        btn.addEventListener(
            "click",
            () => Editor?.close()
        );
    });
}
