/**
 * MAERS Music Render (music-render.module.js)
 * 渲染分类、合集、专辑列表 (Unified Admin UI)
 * 依赖: UI, Admin, Player, Utils (通过 import)
 * @version 3.0.0 - ES6 Module
 */

let UI, Admin, Player, Utils, AdminCore;

export function initRender(uiModule, adminModule, playerModule, utilsModule, adminCoreModule) {
    UI = uiModule;
    Admin = adminModule;
    Player = playerModule;
    Utils = utilsModule;
    AdminCore = adminCoreModule;
}

const IsAdmin = () => window.IS_ADMIN && Admin;

export function renderCategories() {
    const listL0 = document.getElementById('list-level-0');
    if (!listL0) return;

    while (listL0.firstChild) listL0.removeChild(listL0.firstChild);

    UI.libraryData.forEach((cat, index) => {
        const div = document.createElement('div');
        const extraClass = IsAdmin() ? Admin.getItemClass(0, index) : '';
        div.className = `list-item ${extraClass}`;

        // 添加序号属性
        if (IsAdmin() && Admin.getManager) {
            const mgr = Admin.getManager(0);
            if (mgr && mgr.selectedIndices.includes(index)) {
                const orderNum = mgr.selectedIndices.indexOf(index) + 1;
                div.setAttribute('data-order-num', orderNum);
            }
        }

        const isDel = Admin?.isDeleted && Admin.isDeleted(0, index);

        // Label span
        const labelSpan = document.createElement('span');
        labelSpan.style.flex = '1';

        const icon = document.createElement('img');
        icon.src = 'ui/music-collection.svg';
        icon.style.cssText = 'width: 1.25em; vertical-align: middle; margin-right: 4px;';
        labelSpan.appendChild(icon);
        labelSpan.appendChild(document.createTextNode(cat.name));

        // Arrow span
        const arrowSpan = document.createElement('span');
        arrowSpan.className = 'arrow-icon';
        arrowSpan.textContent = '›';

        // Click handler
        const handleClick = (event) => {
            if (IsAdmin()) {
                if (!Admin.uiMoveTo(event, 0, index)) {
                    UI.enterLevel1(index);
                }
            } else {
                UI.enterLevel1(index);
            }
        };

        labelSpan.onclick = handleClick;
        arrowSpan.onclick = handleClick;

        div.appendChild(labelSpan);
        div.appendChild(arrowSpan);

        // Admin Actions
        if (IsAdmin() && AdminCore?.AdminButtonHelper) {
            const actionsEl = AdminCore.AdminButtonHelper.render({
                index: index,
                isDeleted: isDel,
                onSort: (e) => Admin.uiSort(e, 0, index),
                onEdit: (e) => Admin.uiRename(e, 0, index),
                onDelete: (e) => Admin.uiDelete(e, 0, index),
                extraClass: ''
            });

            const actionWrapper = document.createElement('div');
            actionWrapper.className = 'item-actions';
            actionWrapper.appendChild(actionsEl);
            div.appendChild(actionWrapper);
        }

        listL0.appendChild(div);
    });
}

export function renderCollections(catIndex) {
    const listL1 = document.getElementById('list-level-1');
    if (!listL1) return;

    while (listL1.firstChild) listL1.removeChild(listL1.firstChild);
    if (!UI.libraryData[catIndex]) return;

    const cols = UI.libraryData[catIndex].collections;
    cols.forEach((col, index) => {
        const div = document.createElement('div');
        const extraClass = IsAdmin() ? Admin.getItemClass(1, index) : '';
        div.className = `list-item ${extraClass}`;

        // 添加序号属性
        if (IsAdmin() && Admin?.getManager) {
            const mgr = Admin.getManager(1);
            if (mgr && mgr.selectedIndices.includes(index)) {
                const orderNum = mgr.selectedIndices.indexOf(index) + 1;
                div.setAttribute('data-order-num', orderNum);
            }
        }

        const isDel = Admin?.isDeleted && Admin.isDeleted(1, index);

        // Label
        const labelSpan = document.createElement('span');
        labelSpan.style.flex = '1';

        const icon = document.createElement('img');
        icon.src = 'ui/music-singer.svg';
        icon.style.cssText = 'width: 1.25em; vertical-align: middle; margin-right: 4px;';
        labelSpan.appendChild(icon);
        labelSpan.appendChild(document.createTextNode(col.name));

        // Arrow
        const arrowSpan = document.createElement('span');
        arrowSpan.className = 'arrow-icon';
        arrowSpan.textContent = '›';

        // Click handler
        const handleClick = (event) => {
            if (IsAdmin()) {
                if (!Admin.uiMoveTo(event, 1, index)) {
                    UI.enterLevel2(catIndex, index);
                }
            } else {
                UI.enterLevel2(catIndex, index);
            }
        };

        labelSpan.onclick = handleClick;
        arrowSpan.onclick = handleClick;

        div.appendChild(labelSpan);
        div.appendChild(arrowSpan);

        // Admin Actions
        if (IsAdmin() && AdminCore?.AdminButtonHelper) {
            const actionsEl = AdminCore.AdminButtonHelper.render({
                index: index,
                isDeleted: isDel,
                onSort: (e) => Admin.uiSort(e, 1, index),
                onEdit: (e) => Admin.uiRename(e, 1, index),
                onDelete: (e) => Admin.uiDelete(e, 1, index),
                extraClass: ''
            });

            const actionWrapper = document.createElement('div');
            actionWrapper.className = 'item-actions';
            actionWrapper.appendChild(actionsEl);
            div.appendChild(actionWrapper);
        }

        listL1.appendChild(div);
    });
}

export function renderAlbums(catIndex, colIndex) {
    const listL2 = document.getElementById('list-level-2');
    if (!listL2) return;

    const openDropdown = document.querySelector('.track-dropdown.active');
    let openIndex = -1;
    if (openDropdown) {
        const parts = openDropdown.id.split('-');
        if (parts.length > 1) openIndex = parseInt(parts[1]);
    }

    while (listL2.firstChild) listL2.removeChild(listL2.firstChild);
    if (!UI.libraryData[catIndex] || !UI.libraryData[catIndex].collections[colIndex]) return;

    const albums = UI.libraryData[catIndex].collections[colIndex].albums;

    albums.forEach((album, albIndex) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'album-wrapper';

        const totalP = parseInt(album.total) || 1;
        const mapping = album.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);
        const isMultiPart = mapping.length > 1;

        const mainDiv = document.createElement('div');
        const extraClass = IsAdmin() ? Admin.getItemClass(2, albIndex) : '';
        mainDiv.className = `list-item album-item ${extraClass}`;
        mainDiv.setAttribute('data-idx', albIndex);

        // 添加序号属性
        if (IsAdmin() && Admin?.getManager) {
            const mgr = Admin.getManager(2);
            if (mgr && mgr.selectedIndices.includes(albIndex)) {
                const orderNum = mgr.selectedIndices.indexOf(albIndex) + 1;
                mainDiv.setAttribute('data-order-num', orderNum);
            }
        }

        if (Player?.currentPlaying &&
            Player.currentPlaying.catIdx === catIndex &&
            Player.currentPlaying.colIdx === colIndex &&
            Player.currentPlaying.albIdx === albIndex) {
            mainDiv.classList.add('playing');
        }

        const isDel = Admin?.isDeleted && Admin.isDeleted(2, albIndex);

        // Content container
        const contentDiv = document.createElement('div');
        contentDiv.style.cssText = "flex:1; display:flex; align-items:center; gap:8px;";

        const titleSpan = document.createElement('span');
        titleSpan.textContent = album.title;
        contentDiv.appendChild(titleSpan);

        if (isMultiPart) {
            const badge = document.createElement('span');
            badge.className = 'item-meta';
            badge.textContent = `${mapping.length}P`;
            contentDiv.appendChild(badge);
        }

        // Chevron for multi-part
        let chevron = null;
        if (isMultiPart) {
            chevron = document.createElement('span');
            chevron.className = 'album-chevron';
            chevron.id = `chevron-${albIndex}`;
            chevron.textContent = '▶';
        }

        // Click handler
        const handleClick = (event) => {
            if (IsAdmin()) {
                if (!Admin.uiMoveTo(event, 2, albIndex)) {
                    UI.handleAlbumClick(catIndex, colIndex, albIndex, isMultiPart);
                }
            } else {
                UI.handleAlbumClick(catIndex, colIndex, albIndex, isMultiPart);
            }
        };

        contentDiv.onclick = handleClick;

        mainDiv.appendChild(contentDiv);
        if (chevron) mainDiv.appendChild(chevron);

        // Admin Actions
        if (IsAdmin() && AdminCore?.AdminButtonHelper) {
            const actionsEl = AdminCore.AdminButtonHelper.render({
                index: albIndex,
                isDeleted: isDel,
                onSort: (e) => Admin.uiSort(e, 2, albIndex),
                onEdit: (e) => Admin.uiEditAlbum(e, catIndex, colIndex, albIndex),
                onDelete: (e) => Admin.uiDelete(e, 2, albIndex),
                extraClass: ''
            });

            const actionWrapper = document.createElement('div');
            actionWrapper.className = 'item-actions';
            actionWrapper.appendChild(actionsEl);
            mainDiv.appendChild(actionWrapper);
        }

        wrapper.appendChild(mainDiv);

        // Multi-part dropdown
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

                const span = document.createElement('span');
                span.textContent = titleText;
                trackDiv.appendChild(span);

                trackDiv.onclick = (e) => {
                    e.stopPropagation();
                    if (Player?.playTrack) Player.playTrack(album.bvid, realPage, mapping.length, catIndex, colIndex, albIndex, trackDiv, trackIdx);
                };
                dropdown.appendChild(trackDiv);
            });
            wrapper.appendChild(dropdown);
        }
        listL2.appendChild(wrapper);
    });
}
