/**
 * MAERS Album Controller (photos-controller.module.js)
 * 职责：数据状态管理、API调用封装、业务逻辑
 * 依赖: DataProvider
 * @version 3.1.0 - 新增移动端 Cloudflare R2 直传支持
 */
import { localFetch } from '../../../data-manage/api-client.module.js';
import { publicMediaUrl } from '../../../data-manage/data-provider.module.js';

// 依赖声明
let DataProvider;

// 依赖注入
export function initController(dataProvider) {
    DataProvider = dataProvider;
}

// State
export const State = {
    category: new URLSearchParams(window.location.search).get('id') || 'nature',
    isAdmin: window.IS_ADMIN === true,
    loadedData: [],
    originalHash: "",
    hasChanges: false
};

// 生成指纹用于比对
function generateHash(dataList) {
    return dataList.map(i => i.path).join('|');
}

export async function reloadData() {
    try {
        if (!DataProvider) {
            console.error('DataProvider not initialized');
            return [];
        }
        State.loadedData = [...await DataProvider.getGalleryData(State.category)];
        // 远程管理页恢复已上传但尚未合并进静态快照的图片；访客仍读取已发布数据。
        if (State.isAdmin && !isLocalEnv()) {
            const { syncManager } = await import('../../../data-manage/sync/sync-manager.module.js');
            await syncManager.applyPendingPhotos(State.category, State.loadedData);
        }
        // 访客侧：公共数据中不存在该分类且会话已解锁时，尝试解密私密相册
        if (!State.isAdmin && (!State.loadedData || State.loadedData.length === 0)) {
            const { revealPrivateCategory } = await import('../../../data-manage/encrypt/private-media.module.js');
            const revealed = await revealPrivateCategory(State.category);
            if (revealed) State.loadedData = revealed;
        }
        State.originalHash = generateHash(State.loadedData);
        State.hasChanges = false;
        return State.loadedData;
    } catch (e) {
        console.error(e);
        return [];
    }
}

export function checkIsDirty(currentDataList, pendingDeleteCount) {
    const currentHash = generateHash(currentDataList);
    const orderChanged = currentHash !== State.originalHash;
    State.hasChanges = (pendingDeleteCount > 0) || orderChanged;
    return State.hasChanges;
}

export async function saveChanges(deletePaths, newOrder) {
    try {
        if (!DataProvider) {
            throw new Error('DataProvider not initialized');
        }
        for (let path of deletePaths) {
            await DataProvider.deleteImage(path);
        }
        await DataProvider.reorderGallery(State.category, newOrder);
        await reloadData();
        return { success: true };
    } catch (e) {
        console.error(e);
        return { success: false, error: e };
    }
}

// 更新标签
async function updateTags(id, tags) {
    try {
        const res = await localFetch('/api/photos/update_tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, tags: tags })
        });
        return res.ok;
    } catch (e) {
        console.error("Failed to update tags:", e);
        return false;
    }
}

/**
 * 判断当前是否在本地环境（localhost / 局域网 IP）
 */
function isLocalEnv() {
    const host = window.location.hostname;
    return ['localhost', '127.0.0.1', '[::1]', ''].includes(host) ||
        /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host);
}

/**
 * 上传图片
 * - 本地电脑端：走 Python 后端 /upload 接口
 * - 手机端 / 非本地环境：走 Cloudflare R2 直传，上传结果实时插入前端 State
 */
export async function uploadFiles(files, tags = []) {
    // ── 手机端 / 远程环境：委托 syncManager 走 Cloudflare R2 直传 ────────────
    if (!isLocalEnv()) {
        const { syncManager } = await import('../../../data-manage/sync/sync-manager.module.js');
        return syncManager.uploadPhotosBatch(files, State.category, State.loadedData);
    }

    // ── 本地电脑端：走原有 Python 后端 ──────────────────────────────────────
    try {
        if (!DataProvider) {
            throw new Error('DataProvider not initialized');
        }
        let dupCount = 0;
        for (let f of files) {
            const res = await DataProvider.uploadImage(State.category, f);
            if (res && res.msg === 'duplicate_found') {
                dupCount++;
            } else if (tags && tags.length > 0) {
                if (res.id) {
                    const success = await updateTags(res.id, tags);
                } else {
                    console.warn(`[Upload] Server did not return ID for ${f.name}, cannot apply tags.`);
                }
            }
        }
        await reloadData();
        return { success: true, dupCount };
    } catch (e) {
        console.error(e);
        return { success: false, error: e };
    }
}

export function fixPath(p, category, subDir = 'images') {
    if (!p) return p;
    if (p.startsWith('/api/private/media/')) return p;
    // 手机端直传 R2 返回的已是完整 URL，直接返回
    if (p.startsWith('http://') || p.startsWith('https://')) return p;
    // 原图路径分流至 R2 CDN
    if (p.startsWith('photos/images/')) {
        return publicMediaUrl(p);
    }
    if (p.startsWith('photos/')) return publicMediaUrl(p);

    const targetSubDir = subDir || 'images';
    const resolved = `photos/${targetSubDir}/${category || State.category}/${p}`;
    if (targetSubDir === 'images') {
        return publicMediaUrl(resolved);
    }
    return resolved;
}

// 导出 Controller 对象（向后兼容）
export const Controller = {
    State,
    reloadData,
    checkIsDirty,
    saveChanges,
    uploadFiles,
    updateTags,
    fixPath
};
