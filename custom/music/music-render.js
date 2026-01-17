/**
 * MAERS Music Render (music-render.js)
 * 渲染分类、合集、专辑列表
 * 依赖: MAERS.Music.UI, MAERS.Music.Admin, MAERS.Music.Drag, MAERS.Music.Player, MAERS.Utils
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.Music = MAERS.Music || {};

    function renderCategories() {
        const UI = MAERS.Music.UI;
        const listL0 = document.getElementById('list-level-0');
        if (!listL0) return;

        while (listL0.firstChild) {
            listL0.removeChild(listL0.firstChild);
        }
        UI.libraryData.forEach((cat, index) => {
            const div = document.createElement('div');
            div.className = 'list-item';

            const adminActions = window.IS_ADMIN ?
                `<div class="item-actions">
                    <div class="action-icon drag-handle" title="拖动排序" onclick="MAERS.Music.Drag.startStickyDrag(event, 0, ${index})">≡</div>
                    <div class="action-icon" onclick="MAERS.Music.Admin.renameCategory(${index})">✎</div>
                    <div class="action-icon icon-del" onclick="MAERS.Music.Admin.deleteCategory(${index})">🗑</div>
                </div>` : '';

            const escapeHtml = MAERS.Utils ? MAERS.Utils.escapeHtml : (t) => t;
            div.innerHTML = `<span onclick="MAERS.Music.UI.enterLevel1(${index})" style="flex:1">🗻 ${escapeHtml(cat.name)}</span><span class="arrow-icon" onclick="MAERS.Music.UI.enterLevel1(${index})">›</span>${adminActions}`;
            listL0.appendChild(div);
        });
    }

    function renderCollections(catIndex) {
        const UI = MAERS.Music.UI;
        const listL1 = document.getElementById('list-level-1');
        if (!listL1) return;

        while (listL1.firstChild) {
            listL1.removeChild(listL1.firstChild);
        }
        if (!UI.libraryData[catIndex]) return;

        const cols = UI.libraryData[catIndex].collections;
        cols.forEach((col, index) => {
            const div = document.createElement('div');
            div.className = 'list-item';

            const adminActions = window.IS_ADMIN ?
                `<div class="item-actions">
                    <div class="action-icon drag-handle" title="拖动排序" onclick="MAERS.Music.Drag.startStickyDrag(event, 1, ${index})">≡</div>
                    <div class="action-icon" onclick="MAERS.Music.Admin.renameCollection(${catIndex}, ${index})">✎</div>
                    <div class="action-icon icon-del" onclick="MAERS.Music.Admin.deleteCollection(${catIndex}, ${index})">🗑</div>
                </div>` : '';

            const escapeHtml = MAERS.Utils ? MAERS.Utils.escapeHtml : (t) => t;
            div.innerHTML = `<span onclick="MAERS.Music.UI.enterLevel2(${catIndex}, ${index})" style="flex:1">💿 ${escapeHtml(col.name)}</span><span class="arrow-icon" onclick="MAERS.Music.UI.enterLevel2(${catIndex}, ${index})">›</span>${adminActions}`;
            listL1.appendChild(div);
        });
    }

    function renderAlbums(catIndex, colIndex) {
        const UI = MAERS.Music.UI;
        const listL2 = document.getElementById('list-level-2');
        if (!listL2) return;

        const openDropdown = document.querySelector('.track-dropdown.active');
        let openIndex = -1;
        if (openDropdown) {
            const parts = openDropdown.id.split('-');
            if (parts.length > 1) openIndex = parseInt(parts[1]);
        }

        while (listL2.firstChild) {
            listL2.removeChild(listL2.firstChild);
        }
        if (!UI.libraryData[catIndex] || !UI.libraryData[catIndex].collections[colIndex]) return;

        const albums = UI.libraryData[catIndex].collections[colIndex].albums;
        const Player = MAERS.Music.Player;
        const escapeHtml = MAERS.Utils ? MAERS.Utils.escapeHtml : (t) => t;

        albums.forEach((album, albIndex) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'album-wrapper';

            const totalP = parseInt(album.total) || 1;
            const mapping = album.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);
            const isMultiPart = mapping.length > 1;

            const badge = isMultiPart ? `<span class="item-meta">${mapping.length}P</span>` : '';
            const chevron = isMultiPart ? `<span class="album-chevron" id="chevron-${albIndex}">▶</span>` : '';
            const mainDiv = document.createElement('div');
            mainDiv.className = 'list-item album-item';
            mainDiv.setAttribute('data-idx', albIndex);

            if (Player && Player.currentPlaying &&
                Player.currentPlaying.catIdx === catIndex &&
                Player.currentPlaying.colIdx === colIndex &&
                Player.currentPlaying.albIdx === albIndex) {
                mainDiv.classList.add('playing');
            }

            const adminActions = window.IS_ADMIN ?
                `<div class="item-actions">
                    <div class="action-icon" title="重置分P (恢复已删)" onclick="MAERS.Music.Admin.resetAlbum(${catIndex}, ${colIndex}, ${albIndex})">↺</div>
                    <div class="action-icon drag-handle" title="拖动排序" onclick="MAERS.Music.Drag.startStickyDrag(event, 2, ${albIndex})">≡</div>
                    <div class="action-icon" onclick="MAERS.Music.Admin.editAlbum(${catIndex}, ${colIndex}, ${albIndex})">✎</div>
                    <div class="action-icon icon-del" onclick="MAERS.Music.Admin.deleteAlbum(${catIndex}, ${colIndex}, ${albIndex})">🗑</div>
                </div>` : '';

            mainDiv.innerHTML = `<div style="flex:1; display:flex; align-items:center; gap:8px;" onclick="MAERS.Music.UI.handleAlbumClick(${catIndex}, ${colIndex}, ${albIndex}, ${isMultiPart})">${escapeHtml(album.title)} ${badge}</div>${chevron}${adminActions}`;
            wrapper.appendChild(mainDiv);

            if (isMultiPart) {
                const dropdown = document.createElement('div');
                dropdown.className = 'track-dropdown';
                dropdown.id = `dropdown-${albIndex}`;
                if (!album.custom_parts) album.custom_parts = [];

                if (albIndex === openIndex) {
                    dropdown.classList.add('active');
                    setTimeout(() => {
                        const chev = document.getElementById(`chevron-${albIndex}`);
                        if (chev) chev.style.transform = 'rotate(90deg)';
                    }, 0);
                }

                mapping.forEach((realPage, trackIdx) => {
                    const trackDiv = document.createElement('div');
                    trackDiv.className = 'track-item';

                    const titleText = album.custom_parts[trackIdx] || `P${realPage}`;
                    const textSpan = document.createElement('span');
                    textSpan.textContent = titleText;
                    trackDiv.appendChild(textSpan);

                    if (Player && Player.currentPlaying &&
                        Player.currentPlaying.catIdx === catIndex &&
                        Player.currentPlaying.colIdx === colIndex &&
                        Player.currentPlaying.albIdx === albIndex &&
                        Player.currentPlaying.trackIdx === trackIdx) {
                        trackDiv.classList.add('playing');
                    }

                    trackDiv.onclick = (e) => {
                        e.stopPropagation();
                        if (Player && Player.playTrack) {
                            Player.playTrack(album.bvid, realPage, mapping.length, catIndex, colIndex, albIndex, trackDiv, trackIdx);
                        }
                    };

                    if (window.IS_ADMIN) {
                        const actionGroup = document.createElement('div');
                        actionGroup.style.display = 'flex';
                        actionGroup.style.alignItems = 'center';

                        const renameBtn = document.createElement('span');
                        renameBtn.className = 'track-edit-icon';
                        renameBtn.textContent = '✎';
                        renameBtn.onclick = (e) => {
                            e.stopPropagation();
                            if (MAERS.Music.Admin) MAERS.Music.Admin.renameTrack(catIndex, colIndex, albIndex, trackIdx);
                        };
                        actionGroup.appendChild(renameBtn);

                        const delBtn = document.createElement('span');
                        delBtn.className = 'track-edit-icon';
                        delBtn.textContent = '×';
                        delBtn.style.color = '#ff4757';
                        delBtn.style.fontWeight = 'bold';
                        delBtn.style.marginLeft = '8px';
                        delBtn.onclick = (e) => {
                            e.stopPropagation();
                            if (MAERS.Music.Admin) MAERS.Music.Admin.deleteTrack(catIndex, colIndex, albIndex, trackIdx);
                        };
                        actionGroup.appendChild(delBtn);
                        trackDiv.appendChild(actionGroup);
                    }
                    dropdown.appendChild(trackDiv);
                });
                wrapper.appendChild(dropdown);
            }
            listL2.appendChild(wrapper);
        });
    }

    // Mount to namespace
    MAERS.Music.Render = {
        renderCategories,
        renderCollections,
        renderAlbums
    };

})(typeof window !== 'undefined' ? window : this);
