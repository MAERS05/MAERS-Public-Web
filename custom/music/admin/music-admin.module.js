/**
 * MAERS Music Admin Logic (music-admin.module.js)
 * 依赖: UI, Player, AdminCore (通过 import)
 * @version 4.0.0 - ES6 Module
 */

let UI, Player, AdminCore;

export function initAdmin(uiModule, playerModule, adminCoreModule) {
    UI = uiModule;
    Player = playerModule;
    AdminCore = adminCoreModule;
}

const API_BASE = window.API_BASE || '';

// Managers for each level
const managers = {
    0: null,
    1: null,
    2: null
};

function ensureManager(level) {
    if (!UI) return null;

    let list = null;
    if (level === 0) list = UI.libraryData;
    else if (level === 1 && UI.libraryData[UI.currentCatIndex])
        list = UI.libraryData[UI.currentCatIndex].collections;
    else if (level === 2 && UI.libraryData[UI.currentCatIndex] && UI.libraryData[UI.currentCatIndex].collections[UI.currentColIndex])
        list = UI.libraryData[UI.currentCatIndex].collections[UI.currentColIndex].albums;

    if (!list) return null;

    // 如果manager不存在，或者列表引用已变化（说明切换了分类/合集），则重新创建
    if (!managers[level] || managers[level].list !== list) {
        managers[level] = new AdminCore.BatchItemManager({
            list: list,
            onUpdate: () => UI.refreshCurrentView && UI.refreshCurrentView(),
            onChange: () => AdminCore.SaveButton.show()
        });
    }

    return managers[level];
}

// Initialize Save Button
document.addEventListener('DOMContentLoaded', () => {
    if (AdminCore?.SaveButton) {
        AdminCore.SaveButton.init(
            document.body,
            async () => {
                // SAVE
                cleanDeletedItems(UI.libraryData);

                if (UI.saveData) {
                    await UI.saveData();
                    Object.values(managers).forEach(m => m && m.clearSelection());
                    if (UI.refreshCurrentView) UI.refreshCurrentView();
                    if (AdminCore.Feedback) AdminCore.Feedback.notifySaveSuccess();
                }
            },
            async () => {
                // CANCEL - Reset all managers to initial snapshot
                Object.values(managers).forEach(m => {
                    if (m) m.reset();
                });
                if (AdminCore.Feedback) AdminCore.Feedback.notifyCancel();
            }
        );
    }
});

function cleanDeletedItems(list) {
    if (!list) return;
    // Filter current level
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]._deleted) {
            list.splice(i, 1);
        } else {
            // Recursively clean children
            if (list[i].collections) cleanDeletedItems(list[i].collections);
            if (list[i].albums) cleanDeletedItems(list[i].albums);
        }
    }
}

// --- UI Bridges ---

export function getItemClass(level, index) {
    const mgr = ensureManager(level);
    return mgr ? mgr.getItemClass(index) : '';
}

export function uiSort(e, level, index) {
    e.stopPropagation();
    const mgr = ensureManager(level);
    if (mgr) mgr.toggleSelect(index);
}

export function uiMoveTo(e, level, index) {
    const mgr = ensureManager(level);
    if (mgr && mgr.selectedIndices.length > 0) {
        e.stopPropagation(); // Only stop if we are actually moving
        mgr.moveTo(index);
        return true; // handled
    }
    return false;
}

export function uiDelete(e, level, index) {
    e.stopPropagation();
    const mgr = ensureManager(level);
    if (mgr) mgr.toggleDelete(index);
}

export function uiRename(e, level, index) { // Generic rename for Cat/Col
    e.stopPropagation();
    const mgr = ensureManager(level);
    if (mgr && mgr.isDeleted(index)) return;

    const item = mgr.list[index];
    const newName = prompt("重命名:", item.name);
    if (newName && newName !== item.name) {
        item.name = newName;
        mgr.onChange();
        UI.refreshCurrentView();
    }
}

// Specific logic for Album (Level 2) which has more fields
export function uiEditAlbum(e, catIdx, colIdx, albIdx) {
    e.stopPropagation();
    // We use args to get item, but manager uses index in current list
    const mgr = ensureManager(2);
    if (mgr && mgr.isDeleted(albIdx)) return;

    const alb = mgr.list[albIdx];
    handleComplexEdit(alb, mgr);
}

async function handleComplexEdit(alb, mgr) {
    const newBvid = prompt("修改 B站 BV号 (留空保留):", alb.bvid);

    if (newBvid && newBvid !== alb.bvid) {
        // Fetch new info
        try {
            const response = await fetch(`${API_BASE}/api/get_bili_info?bvid=${newBvid}`);
            const info = await response.json();
            const newTitle = prompt("修改标题:", info.title) || info.title;
            alb.bvid = newBvid;
            alb.title = newTitle;
            alb.total = info.pages.length;
            alb.duration = info.duration;
            alb.durations = {};
            alb.custom_parts = [];
            info.pages.forEach(p => {
                alb.durations[p.page] = p.duration; alb.custom_parts.push(p.part);
            });
            mgr.onChange();
            UI.refreshCurrentView();
            UI.refreshCurrentView();
            if (AdminCore.Feedback) AdminCore.Feedback.notifySuccess("已更新 B站数据 (未保存)");
            return;
        } catch (e) {
            if (AdminCore.Feedback) AdminCore.Feedback.notifyError("获取失败，仅能手动编辑");
            else alert("获取失败，仅能手动编辑");
        }
    }

    // Manual Edit
    const t = prompt("修改标题:", alb.title);
    if (t) alb.title = t;
    mgr.onChange();
    UI.refreshCurrentView();
}

// Creation Helper (Direct execution logic: Update -> Save -> No Prompt)

export async function addCategory() {
    const name = prompt("新分类名称：");
    if (name) {
        UI.libraryData.push({ name: name, collections: [] });
        // Direct Save
        if (UI.saveData) {
            await UI.saveData();
            // [Fix] Sync Snapshot so subsequent Cancel doesn't revert creation
            const mgr = ensureManager(0);
            if (mgr) mgr.setList(UI.libraryData);

            if (AdminCore?.SaveButton) AdminCore.SaveButton.hide();
            if (window.MAERS?.Toast) window.MAERS.Toast.success("添加成功");
        }
        UI.refreshCurrentView();
    }
}

export async function addCollection() {
    const name = prompt("新合集名称：");
    if (name) {
        const cat = UI.libraryData[UI.currentCatIndex];
        cat.collections.push({ name: name, albums: [] });
        // Direct Save
        if (UI.saveData) {
            await UI.saveData();
            // [Fix] Sync Snapshot
            const mgr = ensureManager(1);
            if (mgr) mgr.setList(cat.collections);

            if (AdminCore?.SaveButton) AdminCore.SaveButton.hide();
            if (window.MAERS?.Toast) window.MAERS.Toast.success("添加成功");
        }
        UI.refreshCurrentView();
    }
}

// Album creation is complex (fetch). 
export async function addAlbum() {
    const bvid = prompt("B站 BV号：");
    if (!bvid) return;
    try {
        const response = await fetch(`${API_BASE}/api/get_bili_info?bvid=${bvid}`);
        const info = await response.json();
        const title = prompt("确认标题：", info.title) || info.title;
        const newAlbum = {
            title: title, bvid: bvid, total: info.pages.length,
            duration: info.duration, durations: {}, custom_parts: []
        };
        info.pages.forEach(p => {
            newAlbum.durations[p.page] = p.duration;
            newAlbum.custom_parts.push(p.part);
        });

        const col = UI.libraryData[UI.currentCatIndex].collections[UI.currentColIndex];
        col.albums.push(newAlbum);

        // Direct Save
        if (UI.saveData) {
            await UI.saveData();
            // [Fix] Sync Snapshot
            const mgr = ensureManager(2);
            if (mgr) mgr.setList(col.albums);

            if (AdminCore?.SaveButton) AdminCore.SaveButton.hide();
            if (AdminCore.Feedback) AdminCore.Feedback.notifyAddSuccess();
        }
        UI.refreshCurrentView();

    } catch (e) {
        if (AdminCore.Feedback) AdminCore.Feedback.notifyError("获取数据失败");
        else alert("获取数据失败");
    }
}



export function isDeleted(level, index) {
    const mgr = ensureManager(level);
    return mgr ? mgr.isDeleted(index) : false;
}

export function getManager(level) {
    return ensureManager(level);
}

// 导出所有函数
export const Admin = {
    getManager: ensureManager,
    isDeleted,
    getItemClass,
    uiSort,
    uiMoveTo,
    uiDelete,
    uiRename,
    uiEditAlbum,
    addCategory,
    addCollection,
    addAlbum
};
