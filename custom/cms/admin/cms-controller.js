/**
 * MAERS CMS Controller (cms-controller.js)
 * 职责：核心状态管理、API交互、纯数学逻辑
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.CMS = MAERS.CMS || {};

    const URL_PARAMS = new URLSearchParams(window.location.search);
    const CONFIG = {
        CURRENT_MODULE: URL_PARAMS.get('module') || window.location.pathname.split('/').pop().replace('.html', '') || 'notes',
        IS_ADMIN: window.IS_ADMIN === true || URL_PARAMS.get('mode') === 'admin'
    };

    const AppState = {
        root: [],
        allNodes: [],
        pathStack: ['root'],
        activeFilters: new Set(),
        pickedId: null,
        draggedId: null
    };

    console.log(`[MAERS.CMS] Controller Init: ${CONFIG.CURRENT_MODULE}, Admin: ${CONFIG.IS_ADMIN}`);

    // ================= Logic Utils =================

    function flattenNodes(list, parentId = 'root') {
        list.forEach(node => {
            node.parentId = parentId;
            AppState.allNodes.push(node);
            if (node.children) flattenNodes(node.children, node.id);
        });
    }

    // ================= API Calls =================

    async function loadData() {
        if (CONFIG.IS_ADMIN) {
            try {
                const res = await fetch(`/api/cms/fetch?module=${CONFIG.CURRENT_MODULE}`);
                const data = await res.json();
                AppState.root = data.root;
            } catch (e) {
                console.error("[MAERS.CMS] Server Error", e);
                return false;
            }
        } else {
            AppState.root = window.MAERS_DATA ? window.MAERS_DATA.root : [];
        }

        AppState.allNodes = [];
        flattenNodes(AppState.root);
        return true;
    }

    async function callApi(action, data) {
        try {
            const res = await fetch(`/api/cms/node?module=${CONFIG.CURRENT_MODULE}&action=${action}`, {
                method: 'POST',
                body: JSON.stringify(data)
            });
            if (res.ok) {
                await loadData();
                return { success: true };
            } else {
                const err = await res.text();
                return { success: false, msg: err };
            }
        } catch (e) {
            console.error("[MAERS.CMS] API Error:", e);
            return { success: false, msg: e.message };
        }
    }

    // ================= Business Ops =================

    // Return promise
    function createNode(parentId, type, title) {
        return callApi('add', { parentId, type, title });
    }

    function renameNode(id, title) {
        return callApi('update', { id, data: { title } });
    }

    function deleteNode(id) {
        return callApi('delete', { id });
    }

    function moveNode(id, targetParentId) {
        return callApi('move', { id, targetParentId });
    }

    function updateTags(id, tags) {
        return callApi('update', { id, data: { tags } });
    }

    // Image Upload Logic (Business Logic)
    async function uploadImage(file) {
        const newFileName = `paste_${Date.now()}.avif`;
        const res = await fetch(`/upload?category=_notes&name=${newFileName}&convert=avif`, {
            method: 'POST',
            body: file
        });
        if (res.ok) {
            const data = await res.json();
            return { success: true, path: data.path };
        }
        return { success: false };
    }

    // ================= Export =================
    MAERS.CMS.Controller = {
        AppState,
        CONFIG,
        loadData,
        callApi,
        createNode,
        renameNode,
        deleteNode,
        moveNode,
        updateTags,
        uploadImage
    };

    // ================= Bootstrap =================
    document.addEventListener('DOMContentLoaded', async () => {
        // Ensure View is loaded
        if (!MAERS.CMS.View) {
            console.warn("[MAERS.CMS] View not found, skipping bootstrap.");
            return;
        }

        console.log("[MAERS.CMS] Bootstrapping...");
        const success = await loadData();

        if (success) {
            MAERS.CMS.View.init(AppState, CONFIG);
            MAERS.CMS.View.setupSearchListeners();
            MAERS.CMS.View.renderPageTitle();
            MAERS.CMS.View.renderBreadcrumb();
            MAERS.CMS.View.renderGrid(AppState.root);
        } else {
            console.error("[MAERS.CMS] Failed to load data.");
            if (window.MAERS && window.MAERS.Toast) MAERS.Toast.error("Failed to load data.");
        }
    });

})(typeof window !== 'undefined' ? window : this);
