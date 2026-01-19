/**
 * MAERS Music UI (music-ui.js)
 * 音乐界面核心 - 数据管理、导航、搜索
 * 依赖: MAERS.Music.Render, MAERS.Music.Control, MAERS.Utils
 * @version 3.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.Music = MAERS.Music || {};

    const API_BASE = (window.location.protocol === 'file:') ? 'http://localhost:8000' : '';

    // 统一状态管理 (移除 window 同步)
    const UI = {
        libraryData: [],
        currentLevel: 0,
        currentCatIndex: 0,
        currentColIndex: 0,
        currentAlbIndex: 0
    };

    // DOM 引用
    let slider, listL0, listL1, listL2;

    // 初始化
    document.addEventListener('DOMContentLoaded', async () => {
        slider = document.getElementById('slider');
        listL0 = document.getElementById('list-level-0');
        listL1 = document.getElementById('list-level-1');
        listL2 = document.getElementById('list-level-2');
        await loadMusicData();
    });

    async function loadMusicData() {
        try {
            const response = await fetch('data/music-data.json?t=' + Date.now());
            if (response.ok) UI.libraryData = await response.json();
            else throw new Error("JSON load failed");
        } catch (err) {
            if (typeof musicData !== 'undefined') UI.libraryData = musicData;
            else UI.libraryData = [];
        }

        migrateData();
        buildSearchIndex();
        if (MAERS.Music.Render) MAERS.Music.Render.renderCategories();

        const wrapper = document.querySelector('.content-wrapper');
        if (wrapper) wrapper.style.opacity = '1';
    }

    function migrateData() {
        let modified = false;
        UI.libraryData.forEach(cat => {
            if (cat.albums && !cat.collections) {
                cat.collections = [{ name: "默认合集", albums: cat.albums }];
                delete cat.albums;
                modified = true;
            }
            if (!cat.collections) cat.collections = [];
        });
        if (modified) console.log("[MAERS.Music.UI] Data migrated.");
    }

    function saveData() {
        fetch(`${API_BASE}/api/save_music`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(UI.libraryData)
        }).then(response => {
            if (!response.ok) alert("❌ 保存失败！");
        }).catch(err => {
            alert("❌ 网络错误");
        });
    }

    function refreshCurrentView() {
        const Render = MAERS.Music.Render;
        if (!Render) return;

        if (UI.currentLevel === 0) Render.renderCategories();
        else if (UI.currentLevel === 1) Render.renderCollections(UI.currentCatIndex);
        else if (UI.currentLevel === 2) Render.renderAlbums(UI.currentCatIndex, UI.currentColIndex);
    }

    // ----------------- 导航逻辑 -----------------

    function enterLevel1(index) {
        UI.currentCatIndex = index;
        const t = document.getElementById('title-level-1');
        if (t && UI.libraryData[index]) t.innerText = UI.libraryData[index].name;
        if (MAERS.Music.Render) MAERS.Music.Render.renderCollections(index);
        slideTo(1);
    }

    function enterLevel2(catIndex, colIndex) {
        UI.currentColIndex = colIndex;
        const t = document.getElementById('title-level-2');
        if (t && UI.libraryData[catIndex]) {
            const col = UI.libraryData[catIndex].collections[colIndex];
            t.innerText = UI.libraryData[catIndex].name + (col ? " · " + col.name : "");
        }
        if (MAERS.Music.Render) MAERS.Music.Render.renderAlbums(catIndex, colIndex);
        slideTo(2);
    }

    function slideTo(level) {
        UI.currentLevel = level;
        if (slider) slider.style.transform = `translateX(-${level * 33.3333}%)`;
    }

    function goBack(level) {
        slideTo(level);
    }

    function handleAlbumClick(catIdx, colIdx, albIdx, isMultiPart) {
        if (isMultiPart) {
            const dropdown = document.getElementById(`dropdown-${albIdx}`);
            const chevron = document.getElementById(`chevron-${albIdx}`);
            const isActive = dropdown.classList.contains('active');
            document.querySelectorAll('.track-dropdown.active').forEach(el => {
                if (el.id !== `dropdown-${albIdx}`) el.classList.remove('active');
            });
            document.querySelectorAll('.album-chevron').forEach(el => {
                if (el.id !== `chevron-${albIdx}`) el.style.transform = 'rotate(0deg)';
            });

            if (!isActive) {
                dropdown.classList.add('active');
                if (chevron) chevron.style.transform = 'rotate(90deg)';
            } else {
                dropdown.classList.remove('active');
                if (chevron) chevron.style.transform = 'rotate(0deg)';
            }
        } else {
            const album = UI.libraryData[catIdx].collections[colIdx].albums[albIdx];
            const el = document.querySelector(`.album-item[data-idx="${albIdx}"]`);
            const Player = MAERS.Music.Player;
            if (Player && Player.playTrack) {
                Player.playTrack(album.bvid, 1, 1, catIdx, colIdx, albIdx, el);
            }
        }
    }

    // ----------------- 搜索功能 -----------------

    // getPinyinInitials has been moved to MAERS.Utils.Search (MAERS.Search)

    function buildSearchIndex() {
        const getPin = (str) => {
            if (MAERS.Search && MAERS.Search.getPinyinInitials) return MAERS.Search.getPinyinInitials(str);
            if (MAERS.Utils && MAERS.Utils.Search && MAERS.Utils.Search.getPinyinInitials) return MAERS.Utils.Search.getPinyinInitials(str);
            return '';
        };

        UI.libraryData.forEach(cat => {
            cat._searchStr = (cat.name + " " + getPin(cat.name)).toLowerCase();
            cat.collections.forEach(col => {
                col._searchStr = (col.name + " " + getPin(col.name)).toLowerCase();
                col.albums.forEach(alb => {
                    alb._searchStr = (alb.title + " " + getPin(alb.title)).toLowerCase();
                });
            });
        });
    }

    function debounce(func, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    const performSearch = debounce((e) => {
        const query = e.target.value.toLowerCase().trim();
        if (!query) { searchResults.classList.remove('active'); return; }
        const results = [];
        UI.libraryData.forEach((cat, catIdx) => {
            if (cat._searchStr && cat._searchStr.includes(query))
                results.push({ name: cat.name, type: 'Category', click: () => enterLevel1(catIdx) });
            cat.collections.forEach((col, colIdx) => {
                if (col._searchStr && col._searchStr.includes(query))
                    results.push({ name: col.name, type: 'Collection', click: () => { enterLevel1(catIdx); setTimeout(() => enterLevel2(catIdx, colIdx), 300); } });
                col.albums.forEach((alb, albIdx) => {
                    if (alb._searchStr && alb._searchStr.includes(query))
                        results.push({
                            name: alb.title,
                            type: 'Video',
                            click: () => {
                                enterLevel1(catIdx);
                                setTimeout(() => {
                                    enterLevel2(catIdx, colIdx);
                                    setTimeout(() => {
                                        if (alb.total > 1) {
                                            handleAlbumClick(catIdx, colIdx, albIdx, true);
                                            const el = document.querySelector(`.album-item[data-idx="${albIdx}"]`);
                                            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                        } else {
                                            const el = document.querySelector(`.album-item[data-idx="${albIdx}"]`);
                                            const Player = MAERS.Music.Player;
                                            if (Player && Player.playTrack) Player.playTrack(alb.bvid, 1, alb.total, catIdx, colIdx, albIdx, el);
                                        }
                                    }, 400);
                                }, 300);
                            }
                        });
                });
            });
        });
        if (results.length > 0) {
            searchResults.innerHTML = results.map((r, i) => `<div class="search-item" data-i="${i}">${r.name} <span class="search-tag">${r.type}</span></div>`).join('');
            searchResults.classList.add('active');
            searchResults.onclick = (evt) => {
                const item = evt.target.closest('.search-item');
                if (item) {
                    results[item.dataset.i].click();
                    searchResults.classList.remove('active');
                    searchInput.value = '';
                }
            };
        } else {
            searchResults.innerHTML = '<div class="search-item" style="color:#aaa; cursor:default;">No results</div>';
            searchResults.classList.add('active');
        }
    }, 300);

    if (searchInput) searchInput.addEventListener('input', performSearch);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-box-wrapper')) searchResults.classList.remove('active');
    });

    // Event Binding
    document.addEventListener('DOMContentLoaded', () => {
        // Nav Buttons
        const backL1 = document.getElementById('nav-back-L1-text');
        const homeL1 = document.getElementById('nav-home-L1');
        const backL2 = document.getElementById('nav-back-L2-text');
        const homeL2 = document.getElementById('nav-home-L2');
        
        if (backL1) backL1.addEventListener('click', () => goBack(0));
        if (homeL1) homeL1.addEventListener('click', () => goBack(0));
        if (backL2) backL2.addEventListener('click', () => goBack(1));
        if (homeL2) homeL2.addEventListener('click', () => goBack(0));
        
        // Search Input is already bound above

        // Header Zoom Trigger
        const zoomTrigger = document.querySelector('.zoom-trigger-whole');
        if(zoomTrigger && typeof toggleGlobalShrink === 'function') {
           zoomTrigger.addEventListener('click', (e) => toggleGlobalShrink(e));
        }
    });

    // Mount to namespace
    MAERS.Music.UI = Object.assign(UI, {
        loadMusicData,
        saveData,
        refreshCurrentView,
        enterLevel1,
        enterLevel2,
        slideTo,
        goBack,
        handleAlbumClick,
        // 代理到 Render 模块
        renderCategories: () => MAERS.Music.Render && MAERS.Music.Render.renderCategories(),
        renderCollections: (idx) => MAERS.Music.Render && MAERS.Music.Render.renderCollections(idx),
        renderAlbums: (cIdx, colIdx) => MAERS.Music.Render && MAERS.Music.Render.renderAlbums(cIdx, colIdx),
        // 代理到 Control 模块
        playNext: () => MAERS.Music.Control && MAERS.Music.Control.playNext(),
        playPrev: () => MAERS.Music.Control && MAERS.Music.Control.playPrev()
    });

    // 🔧 全局函数包装器已移除
    // global.playNext = ...
    // global.playPrev = ...
    // global.goBack = ...

})(typeof window !== 'undefined' ? window : this);
