/**
 * MAERS Music Admin Logic (music-admin.js)
 * 依赖: MAERS.Music.UI, MAERS.Music.Player
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.Music = MAERS.Music || {};

    const API_BASE = window.API_BASE || '';

    // Helper functions removed - use MAERS.Music.UI and MAERS.Music.Player directly

    function addCategory() {
        const name = prompt("新分类名称：");
        if (name) {
            const UI = MAERS.Music.UI || {};
            UI.libraryData.push({ name: name, collections: [] });
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
        }
    }

    function renameCategory(idx) {
        const UI = MAERS.Music.UI || {};
        const newName = prompt("重命名：", UI.libraryData[idx].name);
        if (newName) {
            UI.libraryData[idx].name = newName;
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
        }
    }

    function deleteCategory(idx) {
        if (confirm("删除分类？")) {
            const UI = MAERS.Music.UI || {};
            UI.libraryData.splice(idx, 1);
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
        }
    }

    function addCollection() {
        const name = prompt("新合集名称：");
        if (name) {
            const UI = MAERS.Music.UI || {};
            UI.libraryData[UI.currentCatIndex].collections.push({ name: name, albums: [] });
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
        }
    }

    function renameCollection(c, l) {
        const UI = MAERS.Music.UI || {};
        const newName = prompt("重命名：", UI.libraryData[c].collections[l].name);
        if (newName) {
            UI.libraryData[c].collections[l].name = newName;
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
        }
    }

    function deleteCollection(c, l) {
        if (confirm("删除合集？")) {
            const UI = MAERS.Music.UI || {};
            UI.libraryData[c].collections.splice(l, 1);
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
        }
    }

    async function addAlbum() {
        const bvid = prompt("B站 BV号 (例如 BV1xxxx)：");
        if (!bvid) return;
        const Player = MAERS.Music.Player || {};
        if (Player.showTip) Player.showTip("正在抓取视频数据...");
        try {
            const response = await fetch(`${API_BASE}/api/get_bili_info?bvid=${bvid}`);
            if (!response.ok) throw new Error("无法连接到抓取接口");
            const info = await response.json();
            const title = prompt("确认视频标题：", info.title) || info.title;

            const newAlbum = {
                title: title, bvid: bvid, total: info.pages.length,
                duration: info.duration, durations: {}, custom_parts: []
            };
            info.pages.forEach(p => {
                newAlbum.durations[p.page] = p.duration;
                newAlbum.custom_parts.push(p.part);
            });
            const UI = MAERS.Music.UI || {};
            UI.libraryData[UI.currentCatIndex].collections[UI.currentColIndex].albums.push(newAlbum);
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
            if (Player.showTip) Player.showTip("✅ 添加成功！");
        } catch (err) {
            console.error(err);
            const title = prompt("抓取失败，请手动输入标题：");
            if (!title) return;
            const total = prompt("请手动输入分P数量：", "1");
            const UI = MAERS.Music.UI || {};
            UI.libraryData[UI.currentCatIndex].collections[UI.currentColIndex].albums.push({
                title, bvid, total: parseInt(total) || 1, custom_parts: []
            });
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
            if (Player.showTip) Player.showTip("⚠️ 已转为手动添加");
        }
    }

    async function editAlbum(c, l, a) {
        const UI = MAERS.Music.UI || {};
        const alb = UI.libraryData[c].collections[l].albums[a];
        const newBvid = prompt("修改 B站 BV号：", alb.bvid);
        if (!newBvid) return;
        const Player = MAERS.Music.Player || {};
        if (Player.showTip) Player.showTip("正在更新视频数据...");
        try {
            const response = await fetch(`${API_BASE}/api/get_bili_info?bvid=${newBvid}`);
            const info = await response.json();
            const newTitle = prompt("修改标题：", info.title) || info.title;
            alb.bvid = newBvid; alb.title = newTitle; alb.total = info.pages.length;
            alb.duration = info.duration; alb.durations = {}; alb.custom_parts = [];
            info.pages.forEach(p => {
                alb.durations[p.page] = p.duration; alb.custom_parts.push(p.part);
            });
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
            if (Player.showTip) Player.showTip("✅ 更新成功");
        } catch (err) {
            const t = prompt("抓取失败，请手动修改标题", alb.title);
            const n = prompt("请手动修改分P数", alb.total);
            if (t) alb.title = t; alb.bvid = newBvid; if (n) alb.total = parseInt(n);
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
            if (Player.showTip) Player.showTip("⚠️ 已手动更新");
        }
    }

    function deleteAlbum(c, l, a) {
        if (confirm("删除视频？")) {
            const UI = MAERS.Music.UI || {};
            UI.libraryData[c].collections[l].albums.splice(a, 1);
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
        }
    }

    function renameTrack(c, l, a, tIdx) {
        const UI = MAERS.Music.UI || {};
        const alb = UI.libraryData[c].collections[l].albums[a];
        if (!alb.custom_parts) alb.custom_parts = [];
        const val = prompt("分P名称", alb.custom_parts[tIdx] || `P${tIdx + 1}`);
        if (val) {
            alb.custom_parts[tIdx] = val;
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
        }
    }

    function deleteTrack(c, l, a, tIdx) {
        if (!confirm("确定删除该分P吗？\n删除后将跳过该P，但保留B站原始页码映射。")) return;
        fetch(`${API_BASE}/api/delete_track`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ catIdx: c, colIdx: l, albIdx: a, trackIdx: tIdx })
        }).then(res => {
            if (res.ok) {
                const UI = MAERS.Music.UI || {};
                if (UI.loadMusicData) UI.loadMusicData().then(() => { if (UI.refreshCurrentView) UI.refreshCurrentView(); });
            } else {
                alert("删除失败");
            }
        }).catch(err => alert("网络错误"));
    }

    async function resetAlbum(c, l, a) {
        if (!confirm("确定重置该视频吗？\n这将从B站重新抓取数据，恢复所有被删除的分P和原始分P名称。")) return;
        const UI = MAERS.Music.UI || {};
        const Player = MAERS.Music.Player || {};
        const alb = UI.libraryData[c].collections[l].albums[a];
        const bvid = alb.bvid;
        
        if (!bvid) {
            alert("该专辑缺少 BVID，无法重置");
            return;
        }
        
        if (Player.showTip) Player.showTip("正在从B站重新抓取数据...");
        try {
            const response = await fetch(`${API_BASE}/api/get_bili_info?bvid=${bvid}`);
            if (!response.ok) throw new Error("无法连接到抓取接口");
            const info = await response.json();
            
            // 更新专辑数据
            alb.total = info.pages.length;
            alb.duration = info.duration;
            alb.durations = {};
            alb.custom_parts = [];
            alb.page_mapping = [];
            
            info.pages.forEach(p => {
                alb.durations[p.page] = p.duration;
                alb.custom_parts.push(p.part);
                alb.page_mapping.push(p.page);
            });
            
            if (UI.saveData) UI.saveData();
            if (UI.refreshCurrentView) UI.refreshCurrentView();
            if (Player.showTip) Player.showTip("✅ 重置成功！");
        } catch (err) {
            console.error(err);
            alert("重置失败：无法从B站获取视频信息");
            if (Player.showTip) Player.showTip("❌ 重置失败");
        }
    }

    // Event Binding
    document.addEventListener('DOMContentLoaded', () => {
        // Add Category Button
        const addCatBtn = document.querySelector('.btn-add-entity[title="新建分类"]');
        if (addCatBtn) {
            addCatBtn.onclick = null;
            addCatBtn.addEventListener('click', () => MAERS.Music.Admin.addCategory());
        }

        // Add Collection Button
        const addColBtn = document.querySelector('.btn-add-entity[title="新建合集"]');
        if (addColBtn) {
            addColBtn.onclick = null;
            addColBtn.addEventListener('click', () => MAERS.Music.Admin.addCollection());
        }

        // Add Album Button
        const addAlbBtn = document.querySelector('.btn-add-entity[title="添加视频"]');
        if (addAlbBtn) {
            addAlbBtn.onclick = null;
            addAlbBtn.addEventListener('click', () => MAERS.Music.Admin.addAlbum());
        }

        // Jump Link (Bilibili)
        const jumpLink = document.getElementById('jump-link');
        const resetLink = document.getElementById('reset-link');
        
        // Reset Link event is dynamic, might be handled here depending on logic, 
        // but typically these buttons are static in admin.html.
        // Assuming reset-link logic is fully handled via onclick? 
        // Wait, reset-button logic wasn't in music-admin.js view. 
        // It might be in music-player.js or justinline.
        // Checking music-admin.js again... resetAlbum is there.
        // But reset-link in HTML has no onclick?
        // Ah, looking at HTML: <button id="reset-link"...>
        // It doesn't have an onclick in the HTML I saw above!
        // Let me re-read admin-music.html lines 74-78.
        // "button id="reset-link" class="reset-link" title="清除播放记忆""
        // It has NO onclick. So where is it bound? 
        // Maybe in music-player.js?
        // I will bind it here just in case or leave it if it's already bound elsewhere.
        // Since I am only refactoring INLINE events, and it HAS none, I skip it.
    });

    // Mount to namespace
    MAERS.Music.Admin = {
        addCategory,
        renameCategory,
        deleteCategory,
        addCollection,
        renameCollection,
        deleteCollection,
        addAlbum,
        editAlbum,
        deleteAlbum,
        renameTrack,
        deleteTrack,
        resetAlbum
    };

})(typeof window !== 'undefined' ? window : this);
