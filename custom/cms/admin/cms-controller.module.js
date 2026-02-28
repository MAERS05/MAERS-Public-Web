/**
 * MAERS CMS Controller (cms-controller.module.js)
 * 职责：核心状态管理、API交互、纯数学逻辑
 * @version 3.0.0 - ES6 Module
 */

const URL_PARAMS = new URLSearchParams(window.location.search);

export const CONFIG = {
    CURRENT_MODULE: window.CURRENT_MODULE || URL_PARAMS.get('module') || window.location.pathname.split('/').pop().replace('.html', '') || 'notes',
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

    // Load Tag Categories (with robust fallbacks)
    let tagSuccess = false;
    try {
        const tagRes = await fetch(`/api/cms/tag_categories?module=${CONFIG.CURRENT_MODULE}`);
        if (tagRes.ok) {
            const data = await tagRes.json();
            if (Array.isArray(data) && data.length > 0) {
                AppState.tagCategories = data;
                tagSuccess = true;
            }
        }
    } catch (e) {
        console.warn("[MAERS.CMS] Tag API failed, trying static fallback...", e);
    }

    if (!tagSuccess) {
        try {
            const staticTagFile = `data/tags/cms-${CONFIG.CURRENT_MODULE}-tag-categories.json`;
            const tagRes = await fetch(`${staticTagFile}?t=${Date.now()}`);
            if (tagRes.ok) {
                AppState.tagCategories = await tagRes.json();
            } else {
                console.warn(`[MAERS.CMS] Static tags file not found: ${staticTagFile}`);
                AppState.tagCategories = [];
            }
        } catch (e) {
            console.error("[MAERS.CMS] Static tags load failed:", e);
            AppState.tagCategories = [];
        }
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

    // Call API
    try {
        const res = await fetch(`/api/cms/save_categories?module=${CONFIG.CURRENT_MODULE}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(categories)
        });

        if (res.ok) {
            return { success: true };
        } else {
            return { success: false, msg: 'API Error' };
        }
    } catch (e) {
        console.error("Save Tags Failed", e);
        return { success: false, msg: e.message };
    }
}

// Image Upload Logic (Business Logic)
export async function uploadImage(file) {
    const module = CONFIG.CURRENT_MODULE || 'notes';
    let category = '_notes';

    if (module === 'games') category = '_games';
    else if (module === 'literature') category = '_literature';
    else if (module === 'record') category = '_record';
    else category = '_notes';

    const ext = file.name.split('.').pop() || 'png';
    const newFileName = `paste_${Date.now()}.${ext}`;
    const res = await fetch(`/upload?category=${category}&name=${newFileName}&convert=avif`, {
        method: 'POST',
        body: file
    });
    if (res.ok) {
        const data = await res.json();
        // Return preview (AVIF) as the main path if available, otherwise fallback to raw path
        return { success: true, path: data.preview || data.path };
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


// Cover Upload Logic
export async function uploadCover(formData) {
    const file = formData.get('file');
    const nodeId = formData.get('nodeId');
    if (!file || !nodeId) return { success: false, msg: 'Missing file or nodeId' };

    // 1. Upload Image
    // Determine category based on module
    let category = 'literaturecovers';
    const currentModule = CONFIG.CURRENT_MODULE;
    if (currentModule === 'games') {
        category = 'gamecovers';
    }

    const ext = file.name.split('.').pop();
    const newName = `cover_${nodeId}_${Date.now()}.${ext}`;

    try {
        const res = await fetch(`/upload?category=${category}&name=${newName}&convert=avif`, {
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
        View.renderGrid(AppState.root, false, true);
    } else {
        console.error("[MAERS.CMS] Failed to load data.");
        if (window.MAERS?.Toast) window.MAERS.Toast.error("Failed to load data.");
    }
}
