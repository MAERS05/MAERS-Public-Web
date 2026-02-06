/**
 * @module custom/cms/viewer/cms-render.module.js
 * @description CMS 渲染系统 - 主入口模块（整合子模块）
 * @version 4.0.0 - ES6 Module (Modularized)
 */

import * as RenderGrid from './render/cms-render-grid.module.js';
import * as RenderNav from './render/cms-render-nav.module.js';

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

    // Initialize sub-modules
    RenderGrid.initGrid({ State, Admin, Controller, Drag, Events });
    RenderNav.initNav({
        State,
        Search,
        Drag,
        renderGrid,
        renderBreadcrumb
    });
}

export function renderGrid(list, isSearch = false, shouldResetManager = false, skipSync = false) {
    RenderGrid.renderGrid(list, isSearch, shouldResetManager, skipSync);
}

export function renderBreadcrumb() {
    RenderNav.renderBreadcrumb();
}

export function navigateTo(index) {
    RenderNav.navigateTo(index);
}

export function enterFolder(node) {
    RenderNav.enterFolder(node);
}

export function renderPageTitle() {
    RenderNav.renderPageTitle();
}

export const Render = {
    renderGrid,
    renderBreadcrumb,
    navigateTo,
    enterFolder,
    renderPageTitle
};
