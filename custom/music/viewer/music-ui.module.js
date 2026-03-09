/**
 * MAERS Music UI (music-ui.module.js)
 * 音乐界面核心 - 数据管理、导航、搜索
 * 依赖: Render, Control, Utils (通过 import)
 * @version 4.0.0 - ES6 Module
 */

import { Utils } from '../../../shared/utils.module.js';

let Render, Control, Search, Player;

export function initUI(renderModule, controlModule, searchModule, playerModule) {
    Render = renderModule;
    Control = controlModule;
    Search = searchModule;
    Player = playerModule;
}

// 统一状态管理
export const UI = {
    libraryData: [],
    currentLevel: 0,
    currentCatIndex: 0,
    currentColIndex: 0,
    currentAlbIndex: 0
};

const DEBOUNCE_DELAY = 300;
const ANIMATION_DELAY = 300;
const TRANSITION_DELAY = 400;

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

export async function loadMusicData() {
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
    if (Render?.renderCategories) Render.renderCategories();

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
}

export function saveData() {
    const API_BASE = (window.location.protocol === 'file:')
        ? (window.MAERS?.Config?.API_BASE || 'http://localhost:8000')
        : '';

    // [Clean] Remove runtime fields starting with '_' (e.g., _searchStr, _deleted)
    const cleanData = JSON.parse(JSON.stringify(UI.libraryData, (key, value) => {
        if (key.startsWith('_')) return undefined;
        return value;
    }));

    fetch(`${API_BASE}/api/save_music`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleanData)
    }).then(response => {
        if (!response.ok) alert("❌ 保存失败！");
    }).catch(err => {
        alert("❌ 网络错误");
    });
}

export function refreshCurrentView() {
    if (!Render) return;

    if (UI.currentLevel === 0) Render.renderCategories();
    else if (UI.currentLevel === 1) Render.renderCollections(UI.currentCatIndex);
    else if (UI.currentLevel === 2) Render.renderAlbums(UI.currentCatIndex, UI.currentColIndex);
}

// ----------------- 导航逻辑 -----------------

export function enterLevel1(index) {
    UI.currentCatIndex = index;
    const t = document.getElementById('title-level-1');
    if (t && UI.libraryData[index]) t.innerText = UI.libraryData[index].name;
    if (Render?.renderCollections) Render.renderCollections(index);
    slideTo(1);
}

export function enterLevel2(catIndex, colIndex) {
    UI.currentColIndex = colIndex;
    const t = document.getElementById('title-level-2');
    if (t && UI.libraryData[catIndex]) {
        const col = UI.libraryData[catIndex].collections[colIndex];
        t.innerText = UI.libraryData[catIndex].name + (col ? " · " + col.name : "");
    }
    if (Render?.renderAlbums) Render.renderAlbums(catIndex, colIndex);
    slideTo(2);
}

export function slideTo(level) {
    UI.currentLevel = level;
    if (slider) slider.style.transform = `translateX(-${level * 33.3333}%)`;
}

export function goBack(level) {
    slideTo(level);
}

export function handleAlbumClick(catIdx, colIdx, albIdx, isMultiPart) {
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

        if (Player && Player.playTrack) {
            Player.playTrack(album.bvid, 1, 1, catIdx, colIdx, albIdx, el);
        }
    }
}

// ----------------- 搜索功能 -----------------

function buildSearchIndex() {
    const getPin = (str) => {
        if (Search?.getPinyinInitials) return Search.getPinyinInitials(str);
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

const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const performSearch = Utils.debounce((e) => {
    const query = e.target.value.toLowerCase().trim();
    if (!query) { searchResults.classList.remove('active'); return; }
    const results = [];
    UI.libraryData.forEach((cat, catIdx) => {
        if (cat._searchStr && cat._searchStr.includes(query))
            results.push({ name: cat.name, type: 'Category', click: () => enterLevel1(catIdx) });
        cat.collections.forEach((col, colIdx) => {
            if (col._searchStr && col._searchStr.includes(query))
                results.push({ name: col.name, type: 'Collection', click: () => { enterLevel1(catIdx); setTimeout(() => enterLevel2(catIdx, colIdx), ANIMATION_DELAY); } });
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
                                        if (Player && Player.playTrack) {
                                            Player.playTrack(alb.bvid, 1, alb.total, catIdx, colIdx, albIdx, el);
                                        }
                                    }
                                }, TRANSITION_DELAY);
                            }, ANIMATION_DELAY);
                        }
                    });
            });
        });
    });
    if (results.length > 0) {
        searchResults.innerHTML = results.map((r, i) => `<div class="search-item" data-i="${i}">${Utils.escapeHtml(r.name)} <span class="search-tag">${Utils.escapeHtml(r.type)}</span></div>`).join('');
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
}, DEBOUNCE_DELAY);

if (searchInput) Utils.bindEvent(searchInput, 'input', performSearch);
document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box-wrapper')) searchResults.classList.remove('active');
});

// Event Binding
document.addEventListener('DOMContentLoaded', () => {
    // Nav Buttons
    Utils.bindEvent('#nav-back-L1-text', 'click', () => goBack(0));
    Utils.bindEvent('#nav-home-L1', 'click', () => goBack(0));
    Utils.bindEvent('#nav-back-L2-text', 'click', () => goBack(1));
    Utils.bindEvent('#nav-home-L2', 'click', () => goBack(0));
});

// 代理到其他模块的函数
UI.loadMusicData = loadMusicData;
UI.saveData = saveData;
UI.refreshCurrentView = refreshCurrentView;
UI.enterLevel1 = enterLevel1;
UI.enterLevel2 = enterLevel2;
UI.slideTo = slideTo;
UI.goBack = goBack;
UI.handleAlbumClick = handleAlbumClick;
UI.renderCategories = () => Render?.renderCategories();
UI.renderCollections = (idx) => Render?.renderCollections(idx);
UI.renderAlbums = (cIdx, colIdx) => Render?.renderAlbums(cIdx, colIdx);
UI.playNext = () => Control?.playNext();
UI.playPrev = () => Control?.playPrev();
