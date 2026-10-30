/**
 * MAERS CMS Controller (cms-controller.module.js)
 * 职责：核心状态管理、API交互、纯数学逻辑
 * @version 3.0.0 - ES6 Module
 */
import { localFetch } from '../../../data-manage/api-client.module.js';
import { DataProvider } from '../../../data-manage/data-provider.module.js';

import { syncManager } from '../../../data-manage/sync/sync-manager.module.js';
import { revealInPlace } from '../../../data-manage/encrypt/secret-unlock.module.js';
import {
    unpackRevealedNode,
    getRevealTransform,
    extractLockedNodes,
    applyLockActionLocally as _applyLockLocally
} from '../../../data-manage/encrypt/private-media.module.js';

export { unpackRevealedNode, getRevealTransform };

const URL_PARAMS = new URLSearchParams(window.location.search);

function getDetectedModule() {
    if (window.CURRENT_MODULE) return window.CURRENT_MODULE;
    const fromParam = URL_PARAMS.get('module');
    if (fromParam) return fromParam;
    const fromPath = window.location.pathname.split('/').pop().replace('.html', '');
    if (fromPath && fromPath !== 'admin-cms' && fromPath !== 'index') return fromPath;
    return 'record'; // 默认回退至随记模块
}

export const CONFIG = {
    CURRENT_MODULE: getDetectedModule(),
    IS_ADMIN: window.IS_ADMIN === true || URL_PARAMS.get('mode') === 'admin'
};

export const AppState = {
    root: [],
    allNodes: [],
    pathStack: ['root'],
    activeFilters: new Set(),
    pickedId: null,
    draggedId: null,
    tagCategories: [],
    // 加密节点占位：[{ id, parentId, index, _enc }]，不进入 root/allNodes，仅 Admin 渲染锁定卡片使用
    // index 为其在同级中的原始位置，父文件夹再次加锁时据此还原顺序
    lockedNodes: []
};

// Logic Utils

function flattenNodes(list, parentId = 'root') {
    list.forEach(node => {
        node.parentId = parentId;
        AppState.allNodes.push(node);
        if (node.children) flattenNodes(node.children, node.id);
    });
}

export function applyLockActionLocally(action, data) {
    _applyLockLocally(AppState, flattenNodes, action, data);
}

// API Calls

export async function loadData() {
    let success = false;
    // 判断当前是否在本地后端环境（localhost / 局域网）
    const isLocal = syncManager.isLocalHost();

    // 1. 本地环境：尝试通过 Python API 拉取最新数据库数据
    if (CONFIG.IS_ADMIN && isLocal) {
        try {
            const res = await localFetch(`/api/cms/fetch?module=${CONFIG.CURRENT_MODULE}`);
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

    // 2. 线上/非本地环境，或本地 API 失败时：回退读取静态 JSON 文件
    if (!success) {
        try {
            const dataFile = window.MAERS?.ModuleConfig
                ? window.MAERS.ModuleConfig.get(CONFIG.CURRENT_MODULE).dataFile
                : `data/${CONFIG.CURRENT_MODULE}-tree.json`;

            const response = await localFetch(dataFile, { cache: 'no-cache' });
            if (response.ok) {
                const data = await response.json();
                // 兼容两种格式：{ root: [...] } 或顶层直接是数组 [...]
                AppState.root = data.root ?? (Array.isArray(data) ? data : []);
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
    AppState.lockedNodes = [];
    // 访客页面：已有会话密钥时原位还原（Admin 页面不还原，避免保存时把明文写回）
    if (!CONFIG.IS_ADMIN) {
        await revealInPlace(AppState.root, { getChildren: (n) => n.children, transform: await getRevealTransform() });
    }
    extractLockedNodes(AppState.root, AppState.lockedNodes);
    flattenNodes(AppState.root);

    // 3. 手机端 / 云端中继模式下，合并应用暂存队列草稿（防止刷新页面丢失）
    if (syncManager.getEffectiveMode() === 'relay' || !isLocal) {
        try {
            await syncManager.applyPendingToState(CONFIG.CURRENT_MODULE, AppState, (item) => {
                applyLockActionLocally(item.action, item.data);
            });
        } catch (e) {
            console.warn("[MAERS.CMS] 应用暂存草稿失败:", e);
        }
    }

    // 与标签请求并行准备真实封面路径，管理端上传后刷新索引。
    const coversReady = ['literature', 'games', 'videos'].includes(CONFIG.CURRENT_MODULE)
        && AppState.allNodes.some(node => node.coverImage)
        ? DataProvider.loadCoverIndex({ refresh: CONFIG.IS_ADMIN && isLocal })
        : Promise.resolve();

    // 4. 加载标签分类（本地走 API，线上直接走静态 JSON）
    let tagSuccess = false;
    if (isLocal) {
        try {
            const tagRes = await localFetch(`/api/cms/tag_categories?module=${CONFIG.CURRENT_MODULE}`);
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
    }

    if (!tagSuccess) {
        try {
            const staticTagFile = `data/tags/cms-${CONFIG.CURRENT_MODULE}-tag-categories.json`;
            const tagRes = await localFetch(staticTagFile, { cache: 'no-cache' });
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

    await coversReady;
    return true;
}

export async function callApi(action, data) {
    if (action === 'add' && !data.id) {
        data.id = `${(data.type || 'n')[0]}_${Date.now()}`;
    }

    const mode = syncManager.getEffectiveMode();
    const isLockAction = (action === 'lock' || action === 'unlock');
    const privateOperation = action === 'protect' || AppState.allNodes.some(node => node._private &&
        (node.id === data.id || node.id === data.targetParentId || node.id === data.parentId || data.ids?.includes(node.id)));
    // 手机端 / 远程模式：走 Cloudflare Worker 0.1秒极速入队
    if (mode === 'relay' && !privateOperation) {
        return _relayAction(action, data, isLockAction);
    }

    try {
        const res = await localFetch(`/api/cms/node?module=${CONFIG.CURRENT_MODULE}&action=${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (res.ok) {
            if (action !== 'open_external') {
                await loadData();
            }
            return { success: true };
        } else {
            const err = await res.text();
            // 向用户显示错误
            if (window.MAERS?.Toast?.error) {
                window.MAERS.Toast.error(`操作失败: ${err}`);
            }
            return { success: false, msg: err };
        }
    } catch (e) {
        // 当本地接口请求失败时（例如手机端或静态站），自动降级转为云端中继暂存
        const relayConfig = syncManager.getConfig().relay;
        if (!privateOperation && relayConfig?.endpoint && relayConfig?.secret) {
            console.warn("[MAERS.CMS] 本地后端未启动，自动切为云端中继暂存:", e);
            return _relayAction(action, data, isLockAction);
        }

        console.error("[MAERS.CMS] API Error:", e);
        // 向用户显示网络错误与同步配置指引
        if (window.MAERS?.Toast?.error) {
            window.MAERS.Toast.error('本地服务未启动，请点击顶栏「同步」设置云端中继');
        }
        return { success: false, msg: e.message };
    }
}

/** 中继入队；加解锁/删除入队成功后在本地内存同步加密占位 */
async function _relayAction(action, data, isLockAction) {
    const result = await syncManager.handleRelayAction(CONFIG.CURRENT_MODULE, action, data, AppState);
    if ((isLockAction || action === 'delete') && result?.success) applyLockActionLocally(action, data);
    return result;
}

// Business Operations

export function createNode(parentId, type, title) {
    return callApi('add', { parentId, type, title });
}

export function renameNode(id, title) {
    return callApi('update', { id, data: { title } });
}

/** @param {Object} [extra] - 附加字段，如 { purge_private: [...] } 清理加密节点的私有封面 */
export function deleteNode(id, extra) {
    return callApi('delete', { id, ...(extra || {}) });
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

/** 加锁：将节点整棵子树替换为一条密文记录（密文由前端生成） */
export function lockNode(id, enc, covers = [], sources = []) {
    return callApi('lock', { id, enc, covers, sources });
}

/** 解锁：用解密后的子树重建节点及正文文件 */
export function unlockNode(id, tree) {
    return callApi('unlock', { id, tree });
}

export async function saveTagCategories(categories) {
    AppState.tagCategories = categories;

    // Call API (本地环境)
    try {
        const res = await localFetch(`/api/cms/save_categories?module=${CONFIG.CURRENT_MODULE}`, {
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
        console.warn("[MAERS.CMS] 本地后端保存标签失败:", e);
        return { success: true }; // 线上模式静默放行
    }
}

// Image Upload Logic (Business Logic)
export async function uploadImage(file, nodeId) {
    if (!file) return { success: false, msg: 'Missing file' };
    const module = CONFIG.CURRENT_MODULE || 'notes';
    let category = '_notes';

    if (module === 'games') category = '_games';
    else if (module === 'literature') category = '_literature';
    else if (module === 'record') category = '_record';
    else if (module === 'videos') category = '_videos';
    else category = '_notes';

    return await syncManager.uploadFile(file, category, 'public', nodeId ? { module, node_id: nodeId } : {});
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
    lockNode,
    unlockNode,
    saveTagCategories,
    uploadImage,
    uploadCover
};

// 封面图片上传 (CMS Cards)
export async function uploadCover(formData) {
    const file = formData.get('file');
    const nodeId = formData.get('nodeId');
    if (!file || !nodeId) return { success: false, msg: 'Missing file or nodeId' };

    // 确定所属封面分类
    let category = 'literaturecovers';
    const currentModule = CONFIG.CURRENT_MODULE;
    if (currentModule === 'games') {
        category = 'gamecovers';
    } else if (currentModule === 'videos') {
        category = 'videocovers';
    }

    try {
        const uploadRes = await syncManager.uploadFile(file, category, 'public', {
            module: currentModule, node_id: nodeId, cover: '1'
        });
        if (!uploadRes.success) {
            console.error('[CMS] Upload failed:', uploadRes.msg);
            return { success: false, msg: uploadRes.msg || 'Upload request failed' };
        }

        // 保存封面路径
        const coverPath = uploadRes.relPath || uploadRes.path;

        // 更新节点数据
        const updateRes = await callApi('update', {
            id: nodeId,
            data: { coverImage: coverPath }
        });

        return updateRes;
    } catch (e) {
        console.error('[CMS] Upload Error:', e);
        return { success: false, msg: e.message };
    }
}


// Bootstrap function (to be called from entry point)
export async function bootstrap(View) {
    syncManager.setController(Controller);
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
