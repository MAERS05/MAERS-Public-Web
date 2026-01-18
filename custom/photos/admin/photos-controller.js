/**
 * MAERS Album Controller (album-controller.js)
 * 职责：数据状态管理、API调用封装、业务逻辑
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.Album = MAERS.Album || {};

    const State = {
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

    async function reloadData() {
        try {
            State.loadedData = await MAERS.DataProvider.getGalleryData(State.category);
            State.originalHash = generateHash(State.loadedData);
            State.hasChanges = false;
            return State.loadedData;
        } catch (e) {
            console.error(e);
            return [];
        }
    }

    function checkIsDirty(currentDataList, pendingDeleteCount) {
        const currentHash = generateHash(currentDataList);
        const orderChanged = currentHash !== State.originalHash;
        State.hasChanges = (pendingDeleteCount > 0) || orderChanged;
        return State.hasChanges;
    }

    async function saveChanges(deletePaths, newOrder) {
        try {
            // 1. Deletions
            for (let path of deletePaths) {
                await MAERS.DataProvider.deleteImage(path);
            }
            // 2. Reorder
            await MAERS.DataProvider.reorderGallery(State.category, newOrder);

            // Reload
            await reloadData();
            return { success: true };
        } catch (e) {
            console.error(e);
            return { success: false, error: e };
        }
    }

    async function uploadFiles(files) {
        let dupCount = 0;
        for (let f of files) {
            const res = await MAERS.DataProvider.uploadImage(State.category, f);
            if (res && res.msg === 'duplicate_found') {
                dupCount++;
            }
        }
        await reloadData();
        return { success: true, dupCount };
    }

    function fixPath(p, category, subDir = 'images') {
        if (!p) return p;
        if (p.startsWith('photos/')) return p;
        return `photos/${subDir}/${category || State.category}/${p}`;
    }

    MAERS.Album.Controller = {
        State,
        reloadData,
        checkIsDirty,
        saveChanges,
        uploadFiles,
        fixPath
    };

})(typeof window !== 'undefined' ? window : this);
