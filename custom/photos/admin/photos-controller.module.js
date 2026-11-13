/**
 * MAERS Album Controller (photos-controller.module.js)
 * 职责：数据状态管理、API调用封装、业务逻辑
 * 依赖: DataProvider
 * @version 3.1.0
 */
import { isOnlineAdminPage, localFetch } from '../../../data-manage/api-client.module.js';
import { publicMediaUrl } from '../../../data-manage/data-provider.module.js';
import { openProgress } from '../../../data-manage/encrypt/lock-dialog.module.js';
import { uploadMeter } from '../../../data-manage/upload-progress.module.js';
import { photoCategoryPath } from '../../../shared/photos-url.module.js';

// 依赖声明
let DataProvider;
let privatePhotoUrl;

async function cloudAlbum() {
    if (!State.isAdmin || !isOnlineAdminPage()) return null;
    const { getCloudAlbumDraft } = await import('./photos-private-drafts.module.js');
    return getCloudAlbumDraft(State.category);
}

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

let categoryRequest = null;

/** 分类路径先还原成内部 ID，再开始加载图片和标签；旧查询链接同步规范化。 */
export function resolveCategory() {
    if (State.isAdmin) return Promise.resolve(null);
    if (!categoryRequest) {
        categoryRequest = loadCategory().catch(error => {
            categoryRequest = null;
            throw error;
        });
    }
    return categoryRequest;
}

async function loadCategory() {
    const url = new URL(window.location.href);
    const path = /^\/photos\/([^/]+)\/?$/.exec(url.pathname);
    const name = path ? decodeURIComponent(path[1]) : url.searchParams.get('id') || State.category;
    const response = await localFetch('/data/album-config.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`读取相册分类失败（HTTP ${response.status}）`);
    const categories = await response.json();
    if (!Array.isArray(categories)) throw new TypeError('相册分类数据格式无效');
    const { revealInPlace } = await import('../../../data-manage/encrypt/secret-unlock.module.js');
    await revealInPlace(categories, { transform: plain => plain.category || plain });
    const category = categories.find(item => item?.id &&
        (path ? (item.slug || item.id) === name : item.id === name)) ||
        categories.find(item => item?.id === name);
    if (!category) {
        if (path) throw new Error('相册分类不存在或尚未解锁');
        return null;
    }
    State.category = category.id;
    url.pathname = photoCategoryPath(category);
    url.searchParams.delete('id');
    url.searchParams.delete('maers_ver');
    if (url.href !== window.location.href) {
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    return category;
}

// 生成指纹用于比对
function generateHash(dataList) {
    return dataList.map(i => i.path).join('|');
}

/** 云端中继写入时返回同步管理器；有本地后端时返回 null */
async function relayManager() {
    const { syncManager } = await import('../../../data-manage/sync/sync-manager.module.js');
    return syncManager.getEffectiveMode() === 'relay' ? syncManager : null;
}

export async function reloadData() {
    try {
        if (!DataProvider) {
            console.error('DataProvider not initialized');
            return [];
        }
        await resolveCategory();
        const entry = await cloudAlbum();
        if (entry) {
            const { getPrivateUrlBuilder } = await import('../../../data-manage/encrypt/private-media.module.js');
            const { photoTags } = await import('./photos-private-drafts.module.js');
            const builder = await getPrivateUrlBuilder(entry.group).catch(() => null);
            privatePhotoUrl = builder || (() => 'about:blank');
            State.loadedData = entry.payload.photos.map(row => ({ ...row, tags: photoTags(row) }));
        } else {
            privatePhotoUrl = null;
            State.loadedData = [...await DataProvider.getGalleryData(State.category, { refresh: State.isAdmin })];
        }
        if (State.isAdmin && !entry) {
            const relay = await relayManager();
            if (relay) await relay.applyPendingPhotos(State.category, State.loadedData);
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
        State.loadedData = [];
        State.originalHash = '';
        if (State.isAdmin) window.MAERS?.Toast?.error?.(e.message);
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
        const entry = await cloudAlbum();
        const relay = entry ? null : await relayManager();
        if (entry) {
            const { editAlbumOrder } = await import('./photos-private-drafts.module.js');
            await editAlbumOrder(entry, deletePaths, newOrder);
        } else if (relay) {
            // 云端：删除与排序按序入队，由电脑合并时调用本地接口；任一失败即中止并保留编辑
            const category = State.category;
            for (const path of deletePaths) {
                const queued = await relay.enqueue('photos', 'delete', { category, path });
                if (!queued.success) throw new Error(queued.msg || '删除图片暂存失败');
            }
            const deleted = new Set(deletePaths);
            const before = State.originalHash.split('|').filter(path => path && !deleted.has(path));
            const after = newOrder.map(item => item.path);
            if (before.join('|') !== after.join('|')) {
                const queued = await relay.enqueue('photos', 'reorder', { category, order: after });
                if (!queued.success) throw new Error(queued.msg || '图片排序暂存失败');
            }
        } else {
            for (let path of deletePaths) {
                await DataProvider.deleteImage(path);
            }
            await DataProvider.reorderGallery(State.category, newOrder);
        }
        await reloadData();
        return { success: true };
    } catch (e) {
        console.error(e);
        return { success: false, error: e };
    }
}

/**
 * 保存单张图片的标签：本地按 ID 写后端；云端按原图路径入队，电脑合并时执行。
 * @returns {Promise<{success:boolean, error?:string}>}
 */
export async function savePhotoTags(photo, tags) {
    try {
        const entry = await cloudAlbum();
        if (entry) {
            await entry.edit(payload => {
                const row = payload.photos.find(item => item.path === photo.path);
                if (!row) throw Error('图片已移除，请刷新页面');
                row.tags = tags;
            });
            return { success: true };
        }
        const relay = await relayManager();
        if (relay) {
            const queued = await relay.enqueue('photos', 'update_tags',
                { category: State.category, path: photo.path, tags });
            return queued.success ? { success: true } : { success: false, error: queued.msg };
        }
        const res = await localFetch('/api/photos/update_tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: photo.id, tags })
        });
        const data = await res.json().catch(() => ({}));
        return res.ok ? { success: true } : { success: false, error: data.error || `HTTP ${res.status}` };
    } catch (e) {
        return { success: false, error: e.message };
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
 * - 手机端 / 非本地环境：保存 KV 草稿，当前页面立即展示
 */
export async function uploadFiles(files, tags = [], bucketId) {
    try {
        const entry = await cloudAlbum();
        if (entry) return await uploadPrivateFiles(entry, files, tags, bucketId);
    } catch (error) {
        return { success: false, error };
    }
    // 手机端上传原图，所选标签随图库草稿一并暂存。
    const relay = await relayManager();
    if (relay) return relay.uploadPhotosBatch(files, State.category, State.loadedData, tags, bucketId);

    const progress = openProgress('正在准备上传图片', '');
    // ── 本地电脑端：走原有 Python 后端 ──────────────────────────────────────
    try {
        if (!DataProvider) {
            throw new Error('DataProvider not initialized');
        }
        let dupCount = 0;
        let completed = 0;
        for (let f of files) {
            const label = `第 ${completed + 1}/${files.length} 张图片`;
            progress.update(0, 0, `正在准备${label}`);
            const res = await DataProvider.uploadImage(State.category, f, {
                bucketId, progress, onUploadProgress: uploadMeter(progress, label)
            });
            if (res && res.msg === 'duplicate_found') {
                dupCount++;
            } else if (tags && tags.length > 0) {
                if (res.id) {
                    if (!await updateTags(res.id, tags)) throw new Error('图片已保存，标签保存失败，请刷新后补充标签');
                } else {
                    console.warn(`[Upload] Server did not return ID for ${f.name}, cannot apply tags.`);
                }
            }
            completed++;
            progress.update(completed, files.length, '图片已处理');
        }
        await reloadData();
        return { success: true, dupCount };
    } catch (e) {
        console.error(e);
        return { success: false, error: e };
    } finally { progress.close(); }
}

async function uploadPrivateFiles(entry, files, tags, bucketId) {
    const { syncManager } = await import('../../../data-manage/sync/sync-manager.module.js');
    const progress = openProgress('正在上传私密图片', '');
    let uploadedCount = 0;
    try {
        for (const file of files) {
            await entry.edit(async payload => {
                const row = await syncManager.uploadPrivatePhoto(file, entry.group, progress, bucketId);
                payload.photos.unshift({ ...row, category: State.category, tags, sort_order: -1 });
            });
            uploadedCount++;
            progress.update(uploadedCount, files.length, '正在暂存私密图片');
        }
        return { success: true, uploadedCount };
    } catch (error) {
        return { success: false, uploadedCount, error: uploadedCount
            ? `已暂存 ${uploadedCount} 张私密图片。剩余图片上传失败，${error.message}` : error.message };
    } finally {
        progress.close();
        if (uploadedCount) await Controller.reloadData();
    }
}

export function fixPath(p, category, subDir = 'images') {
    if (!p) return p;
    if (privatePhotoUrl) return privatePhotoUrl(p);
    if (p.startsWith('/api/private/media/')) return p;
    // 外部媒体的完整地址直接使用。
    if (p.startsWith('http://') || p.startsWith('https://')) return p;
    const key = p.replace(/^\/+/, '');
    const mediaPath = key.startsWith('photos/') ? key :
        `photos/${subDir || 'images'}/${category || State.category}/${key}`;
    // 本机已有原图及衍生图，直接经本地服务读取，避免绕道公网 CDN。
    if (DataProvider?.isLocal) return '/' + mediaPath.split('/').map(encodeURIComponent).join('/');
    return publicMediaUrl(mediaPath);
}

// 导出 Controller 对象（向后兼容）
export const Controller = {
    State,
    resolveCategory,
    reloadData,
    checkIsDirty,
    saveChanges,
    uploadFiles,
    updateTags,
    savePhotoTags,
    fixPath
};
