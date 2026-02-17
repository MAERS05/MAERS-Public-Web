/**
 * MAERS Album Controller (photos-controller.module.js)
 * 职责：数据状态管理、API调用封装、业务逻辑
 * 依赖: DataProvider
 * @version 3.0.0 - ES6 Module
 */

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
        State.loadedData = await DataProvider.getGalleryData(State.category);
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
        // 1. Deletions
        for (let path of deletePaths) {
            await DataProvider.deleteImage(path);
        }
        // 2. Reorder
        await DataProvider.reorderGallery(State.category, newOrder);

        // Reload
        await reloadData();
        return { success: true };
    } catch (e) {
        console.error(e);
        return { success: false, error: e };
    }
}

// Update tags helper
async function updateTags(id, tags) {
    try {
        const res = await fetch('/api/photos/update_tags', {
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

export async function uploadFiles(files, tags = []) {
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
                // Apply tags to new image
                // Use ID returned from server
                if (res.id) {
                    console.log(`[Upload] Trying to apply tags to ID: ${res.id}`, tags);
                    const success = await updateTags(res.id, tags);
                    console.log(`[Upload] Tag update result for ${res.id}: ${success}`);
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
    if (p.startsWith('photos/')) return p;
    return `photos/${subDir}/${category || State.category}/${p}`;
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
