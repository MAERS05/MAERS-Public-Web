/**
 * MAERS Music Admin Logic (music-admin.module.js)
 * 依赖: UI, Player, AdminCore (通过 import)
 * @version 4.0.0 - ES6 Module
 */
import { Toast } from '../../../shared/toast.module.js';

import { isEncryptedRecord } from '../../../data-manage/encrypt/crypto.module.js';
import { lockRecord, unlockRecord, mountUnlockAllButton, refreshUnlockAllButton, unlockListDeep, countEncryptedDeep } from '../../../data-manage/encrypt/admin-lock.module.js';

let UI, Player, AdminCore;

export function initAdmin(uiModule, playerModule, adminCoreModule) {
    UI = uiModule;
    Player = playerModule;
    AdminCore = adminCoreModule;

    // 注册「解锁全部」按钮（递归 分类→合集→专辑）
    const getKids = (n) => n.collections || n.albums;
    mountUnlockAllButton({
        source: 'music-data.json',
        getCount: () => countEncryptedDeep(UI?.libraryData, getKids, isEncryptedRecord),
        onUnlockAll: async () => {
            const n = await unlockListDeep(UI.libraryData, getKids, isEncryptedRecord);
            if (n > 0) {
                const mgr = ensureManager(0);
                if (mgr) mgr.updateSaveState();
                if (UI.refreshCurrentView) UI.refreshCurrentView();
            }
            return n;
        }
    });
}

/** 供渲染模块在每次渲染后调用，刷新「解锁全部」按钮 */
export function refreshUnlockAll() {
    refreshUnlockAllButton();
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
            onUpdate: () => UI.refreshCurrentView && UI.refreshCurrentView()
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
    // 从后往前遍历，删除标记删除的项（跳过 _enc 加密记录，它们没有子结构）
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]._enc) continue; // 加密记录不处理子结构
        if (list[i]._deleted) {
            list.splice(i, 1);
        } else {
            // 递归清理子节点
            if (list[i].collections) cleanDeletedItems(list[i].collections);
            if (list[i].albums) cleanDeletedItems(list[i].albums);
        }
    }
}

// --- UI Bridges ---

// 获取指定层级的 manager（供 render 模块调用）
export function getManager(level) {
    return managers[level] || null;
}

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

export function isDeleted(level, index) {
    const mgr = ensureManager(level);
    return mgr ? mgr.isDeleted(index) : false;
}

/**
 * 加锁：将指定层级索引的记录加密
 * @param {number} level - 0=分类 1=合集 2=专辑
 * @param {number} index
 */
export async function uiLock(level, index) {
    const mgr = ensureManager(level);
    if (!mgr) return;
    const original = mgr.list[index];
    if (!original || isEncryptedRecord(original)) return;

    const enc = await lockRecord(original);
    if (!enc) return;

    mgr.list[index] = enc;
    mgr.updateSaveState();
    if (UI.refreshCurrentView) UI.refreshCurrentView();
}

/**
 * 解锁：将加密记录恢复为原始记录
 * @param {number} level
 * @param {number} index
 */
export async function uiUnlock(level, index) {
    const mgr = ensureManager(level);
    if (!mgr) return;
    const enc = mgr.list[index];
    if (!isEncryptedRecord(enc)) return;

    const original = await unlockRecord(enc);
    if (!original) return;

    mgr.list[index] = original;
    mgr.updateSaveState();
    if (UI.refreshCurrentView) UI.refreshCurrentView();
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
            else Toast.error("获取失败，仅能手动编辑");
        }
    }

    // Manual Edit
    const t = prompt("修改标题:", alb.title);
    if (t) alb.title = t;
    mgr.onChange();
    UI.refreshCurrentView();
}

export function uiRenamePart(e, albIdx, trackIdx) {
    e.stopPropagation();
    const alb = ensureManager(2).list[albIdx];
    const old = (alb.custom_parts && alb.custom_parts[trackIdx]) || `P${trackIdx + 1}`;
    const n = prompt("重命名该分P:", old);
    if (n && n !== old) {
        if (!alb.custom_parts) alb.custom_parts = [];
        alb.custom_parts[trackIdx] = n;
        ensureManager(2).onChange();
        UI.refreshCurrentView();
    }
}

export function uiDeletePart(e, albIdx, trackIdx) {
    e.stopPropagation();
    if (!confirm("确定要删除吗？")) return;
    const alb = ensureManager(2).list[albIdx];
    const mapping = alb.page_mapping || Array.from({ length: parseInt(alb.total) || 1 }, (_, k) => k + 1);
    if (mapping.length <= 1) return Toast.error("最后一个不可删除");
    mapping.splice(trackIdx, 1);
    if (alb.custom_parts) alb.custom_parts.splice(trackIdx, 1);
    alb.page_mapping = mapping;
    alb.total = mapping.length;
    ensureManager(2).onChange();
    UI.refreshCurrentView();
}

export async function uiResetTracks(e, catIdx, colIdx, albIdx) {
    e.stopPropagation();
    if (!confirm("确定要恢复该视频的所有原始分P吗？")) return;

    // 我们既可以调用 API，也可以在本地尝试重置并保存
    // 优先本地重置以保持 UI 状态同步
    const alb = UI.libraryData[catIdx].collections[colIdx].albums[albIdx];

    // 如果没有 bili_total，尝试从 total 获取（前提是我们没改过 total）
    // 或者干脆重新通过 BV 号获取一次信息
    try {
        const response = await fetch(`${API_BASE}/api/get_bili_info?bvid=${alb.bvid}`);
        const info = await response.json();

        alb.total = info.pages.length;
        alb.page_mapping = Array.from({ length: alb.total }, (_, k) => k + 1);
        alb.custom_parts = info.pages.map(p => p.part);
        alb.durations = {};
        info.pages.forEach(p => {
            alb.durations[p.page] = p.duration;
        });

        ensureManager(2).onChange();
        UI.refreshCurrentView();
        if (window.MAERS?.Toast) window.MAERS.Toast.success("已还原原始分P");
    } catch (err) {
        Toast.error("获取原始信息失败：" + err.message);
    }
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
            if (window.MAERS?.Toast) window.MAERS.Toast.success("创建成功");
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
            if (window.MAERS?.Toast) window.MAERS.Toast.success("创建成功");
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
        else Toast.error("获取数据失败");
    }
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
    uiRenamePart,
    uiDeletePart,
    uiLock,
    uiUnlock,
    refreshUnlockAll,
    uiResetTracks,
    addCategory,
    addCollection,
    addAlbum
};
