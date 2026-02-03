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

export async function uploadFiles(files) {
    try {
        if (!DataProvider) {
            throw new Error('DataProvider not initialized');
        }
        let dupCount = 0;
        for (let f of files) {
            const res = await DataProvider.uploadImage(State.category, f);
            if (res && res.msg === 'duplicate_found') {
                dupCount++;
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
    fixPath
};
