/**
 * MAERS CMS Controller (cms-controller.module.js)
 * 职责：核心状态管理、API交互、纯数学逻辑
 * @version 3.0.0 - ES6 Module
 */

const URL_PARAMS = new URLSearchParams(window.location.search);

export const CONFIG = {
    CURRENT_MODULE: URL_PARAMS.get('module') || window.location.pathname.split('/').pop().replace('.html', '') || 'notes',
    IS_ADMIN: window.IS_ADMIN === true || URL_PARAMS.get('mode') === 'admin'
};

export const AppState = {
    root: [],
    allNodes: [],
    pathStack: ['root'],
    activeFilters: new Set(),
    pickedId: null,
    draggedId: null,
    tagCategories: []
};

// Logic Utils

function flattenNodes(list, parentId = 'root') {
    list.forEach(node => {
        node.parentId = parentId;
        AppState.allNodes.push(node);
        if (node.children) flattenNodes(node.children, node.id);
    });
}

// API Calls

export async function loadData() {
    let success = false;

    // 1. Try API Fetch (Server Mode)
    if (CONFIG.IS_ADMIN) {
        try {
            const res = await fetch(`/api/cms/fetch?module=${CONFIG.CURRENT_MODULE}`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.root && data.root.length > 0) {
                    AppState.root = data.root;
                    success = true;
                }
            }
        } catch (e) {
            console.warn("[MAERS.CMS] Server API failed, trying local JS fallback...", e);
        }
    }

    // 2. Fallback to Local JSON Data (if API failed or returned empty)
    if (!success) {
        try {
            const dataFile = window.MAERS?.ModuleConfig
                ? window.MAERS.ModuleConfig.get(CONFIG.CURRENT_MODULE).dataFile
                : `data/${CONFIG.CURRENT_MODULE}-tree.json`;

            const response = await fetch(`${dataFile}?t=${Date.now()}`);
            if (response.ok) {
                const data = await response.json();
                AppState.root = data.root || [];
                success = true;
            } else {
                console.error(`Failed to load JSON data: ${dataFile}`);
                AppState.root = [];
            }
        } catch (e) {
            console.error("[MAERS.CMS] Failed to load JSON data:", e);
            AppState.root = [];
        }
    }

    AppState.allNodes = [];
    flattenNodes(AppState.root);

    // Load Tag Categories from Config Node
    const configNode = AppState.allNodes.find(n => n.title === '_TAG_CONFIG');
    if (configNode && configNode.content) {
        try {
            // Handle potential markdown wrapping or raw text
            let cleanContent = configNode.content.trim();
            // Simple cleanup if needed, but assuming raw JSON
            AppState.tagCategories = JSON.parse(cleanContent);
        } catch (e) {
            console.warn("[MAERS.CMS] Failed to parse _TAG_CONFIG:", e);
            AppState.tagCategories = [];
        }
    } else {
        AppState.tagCategories = [];
    }

    return true;
}

export async function callApi(action, data) {
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
            // 向用户显示错误
            if (window.MAERS?.Toast?.show) {
                window.MAERS.Toast.show(`操作失败: ${err}`, 'error');
            }
            return { success: false, msg: err };
        }
    } catch (e) {
        console.error("[MAERS.CMS] API Error:", e);
        // 向用户显示网络错误
        if (window.MAERS?.Toast?.show) {
            window.MAERS.Toast.show('网络错误,请检查连接', 'error');
        }
        return { success: false, msg: e.message };
    }
}

// Business Operations

export function createNode(parentId, type, title) {
    return callApi('add', { parentId, type, title });
}

export function renameNode(id, title) {
    return callApi('update', { id, data: { title } });
}

export function deleteNode(id) {
    return callApi('delete', { id });
}

export function moveNode(id, targetParentId) {
    return callApi('move', { id, targetParentId });
}

export function updateTags(id, tags) {
    return callApi('update', { id, data: { tags } });
}

export function updateNode(id, data) {
    return callApi('update', { id, data });
}

export function reorderNodes(ids) {
    return callApi('reorder', { ids });
}

export async function saveTagCategories(categories) {
    AppState.tagCategories = categories;
    const configNode = AppState.allNodes.find(n => n.title === '_TAG_CONFIG');
    const content = JSON.stringify(categories, null, 2);

    if (configNode) {
        return callApi('update', { id: configNode.id, data: { content } });
    } else {
        // Create the config node. Hidden? We just use a confusing name to hide it slightly or use a distinct type if possible.
        // Using type 'note' to store content.
        return callApi('add', { parentId: 'root', type: 'note', title: '_TAG_CONFIG', content: content });
    }
}

// Image Upload Logic (Business Logic)
export async function uploadImage(file) {
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

// Export Controller object
export const Controller = {
    AppState,
    CONFIG,
    loadData,
    callApi,
    createNode,
    renameNode,
    deleteNode,
    moveNode,
    updateTags,
    updateNode,
    reorderNodes,
    saveTagCategories,
    uploadImage,
    uploadCover
};

// ...

// Cover Upload Logic
export async function uploadCover(formData) {
    const file = formData.get('file');
    const nodeId = formData.get('nodeId');
    if (!file || !nodeId) return { success: false, msg: 'Missing file or nodeId' };

    // 1. Upload Image
    // Using 'covers' category to organize files
    const ext = file.name.split('.').pop();
    const newName = `cover_${nodeId}_${Date.now()}.${ext}`;

    try {
        const res = await fetch(`/upload?category=covers&name=${newName}&convert=avif`, {
            method: 'POST',
            body: file // Body acts as file binary for this specific backend endpoint
        });

        if (res.ok) {
            const data = await res.json();
            // Data returns { path, thumb, preview, ... }
            // We save the relative raw path. Frontend handles thumb/preview logic.
            const coverPath = data.path;

            // 2. Update Node in CMS
            const updateRes = await callApi('update', {
                id: nodeId,
                data: { coverImage: coverPath }
            });

            return updateRes;
        } else {
            console.error('[CMS] Upload failed');
            return { success: false, msg: 'Upload request failed' };
        }
    } catch (e) {
        console.error('[CMS] Upload Error:', e);
        return { success: false, msg: e.message };
    }
}


// Bootstrap function (to be called from entry point)
export async function bootstrap(View) {
    if (!View) {
        console.warn("[MAERS.CMS] View not found, skipping bootstrap.");
        return;
    }

    const success = await loadData();

    if (success) {
        View.init(AppState, CONFIG);
        View.setupSearchListeners();
        View.renderPageTitle();
        View.renderBreadcrumb();
        View.renderGrid(AppState.root);
    } else {
        console.error("[MAERS.CMS] Failed to load data.");
        if (window.MAERS?.Toast) window.MAERS.Toast.error("Failed to load data.");
    }
}
