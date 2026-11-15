/**
 * MAERS Music Render (music-render.module.js)
 * 渲染分类、合集、专辑列表 (Unified Admin UI)
 * 依赖: UI, Admin, Player, Utils (通过 import)
 * @version 3.0.0 - ES6 Module
 */

import { icon as appIcon } from '../../../shared/icons.module.js';

import { isEncryptedRecord } from '../../../data-manage/encrypt/crypto.module.js';
import { disableAdminControl, isLocalOnlyUnavailable } from '../../../data-manage/admin/local-only.module.js';
import { renderLockedCard, cryptoIconHtml, setupLockActionButton } from '../../../data-manage/encrypt/admin-lock.module.js';

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
        // 加密记录：访客不展示，admin 展示锁定占位行
        if (isEncryptedRecord(cat)) {
            if (IsAdmin()) listL0.appendChild(_renderLockedListItem(0, index));
            return;
        }

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
        arrowSpan.innerHTML = appIcon('forward', 16);

        // Click handler
        const handleClick = (event) => {
            event.stopPropagation();
            if (IsAdmin()) {
                if (!Admin.uiMoveTo(event, 0, index)) {
                    UI.enterLevel1(index);
                }
            } else {
                UI.enterLevel1(index);
            }
        };

        labelSpan.onclick = handleClick;
        labelSpan.tabIndex = 0;
        labelSpan.setAttribute('role', 'button');
        labelSpan.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleClick(event); } };
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

            // 加锁按钮
            const lockBtn = document.createElement('button');
            lockBtn.type = 'button';
            lockBtn.className = 'maers-admin-btn';
            setupLockActionButton(lockBtn, {
                isLocked: Boolean(cat._private_id || cat._cloudEnvelope),
                title: '对外加密此分类',
                onClick: (e) => { e.stopPropagation(); Admin.uiLock(0, index); }
            });
            actionsEl.appendChild(lockBtn);

            const actionWrapper = document.createElement('div');
            actionWrapper.className = 'item-actions';
            actionWrapper.appendChild(actionsEl);
            div.appendChild(actionWrapper);
        }

        listL0.appendChild(div);
    });
    if (IsAdmin()) Admin.refreshUnlockAll?.();
}

export function renderCollections(catIndex) {
    const listL1 = document.getElementById('list-level-1');
    if (!listL1) return;

    while (listL1.firstChild) listL1.removeChild(listL1.firstChild);
    if (!UI.libraryData[catIndex]) return;

    const cols = UI.libraryData[catIndex].collections;
    cols.forEach((col, index) => {
        // 加密记录处理
        if (isEncryptedRecord(col)) {
            if (IsAdmin()) listL1.appendChild(_renderLockedListItem(1, index));
            return;
        }

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
        arrowSpan.innerHTML = appIcon('forward', 16);

        // Click handler
        const handleClick = (event) => {
            event.stopPropagation();
            if (IsAdmin()) {
                if (!Admin.uiMoveTo(event, 1, index)) {
                    UI.enterLevel2(catIndex, index);
                }
            } else {
                UI.enterLevel2(catIndex, index);
            }
        };

        labelSpan.onclick = handleClick;
        labelSpan.tabIndex = 0;
        labelSpan.setAttribute('role', 'button');
        labelSpan.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleClick(event); } };
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

            // 加锁按钮
            const lockBtn = document.createElement('button');
            lockBtn.type = 'button';
            lockBtn.className = 'maers-admin-btn';
            setupLockActionButton(lockBtn, {
                isLocked: Boolean(col._private_id || col._cloudEnvelope),
                title: col._private ? '随上级对外加密' : '对外加密此合集',
                onClick: (e) => { e.stopPropagation(); Admin.uiLock(1, index); }
            });
            actionsEl.appendChild(lockBtn);

            const actionWrapper = document.createElement('div');
            actionWrapper.className = 'item-actions';
            actionWrapper.appendChild(actionsEl);
            div.appendChild(actionWrapper);
        }

        listL1.appendChild(div);
    });
    if (IsAdmin()) Admin.refreshUnlockAll?.();
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
        // 加密记录处理
        if (isEncryptedRecord(album)) {
            if (IsAdmin()) listL2.appendChild(_renderLockedListItem(2, albIndex));
            return;
        }

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
            chevron.innerHTML = appIcon('forward', 14);
        }

        // Click handler
        const handleClick = (event) => {
            event.stopPropagation();
            if (IsAdmin()) {
                if (!Admin.uiMoveTo(event, 2, albIndex)) {
                    UI.handleAlbumClick(catIndex, colIndex, albIndex, isMultiPart);
                }
            } else {
                UI.handleAlbumClick(catIndex, colIndex, albIndex, isMultiPart);
            }
        };

        contentDiv.onclick = handleClick;
        contentDiv.tabIndex = 0;
        contentDiv.setAttribute('role', 'button');
        contentDiv.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleClick(event); } };

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

            // 加锁按钮
            const lockBtn2 = document.createElement('button');
            lockBtn2.type = 'button';
            lockBtn2.className = 'maers-admin-btn';
            setupLockActionButton(lockBtn2, {
                isLocked: Boolean(album._private_id || album._cloudEnvelope),
                title: album._private ? '随上级对外加密' : '对外加密此专辑',
                onClick: (e) => { e.stopPropagation(); Admin.uiLock(2, albIndex); }
            });
            actionsEl.appendChild(lockBtn2);

            // 补全：还原分P按钮 (↺)
            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'maers-admin-btn';
            resetBtn.title = '还原原始曲目';
            resetBtn.innerHTML = appIcon('refresh', 16);
            resetBtn.setAttribute('aria-label', '还原曲目');
            if (isLocalOnlyUnavailable()) {
                disableAdminControl(resetBtn, '还原原始分 P 需要电脑本地后台获取 B 站信息');
            } else {
                resetBtn.onclick = (e) => Admin.uiResetTracks(e, catIndex, colIndex, albIndex);
            }

            // 插入到删除按钮之前
            if (actionsEl.children.length > 0) {
                actionsEl.insertBefore(resetBtn, actionsEl.lastChild);
            } else {
                actionsEl.appendChild(resetBtn);
            }

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

                if (IsAdmin()) {
                    const iconGroup = document.createElement('div');
                    iconGroup.style.display = 'flex';
                    iconGroup.style.gap = '5px';

                    const eI = document.createElement('button');
            eI.type = 'button';
                    eI.className = 'track-edit-icon'; eI.innerHTML = appIcon('edit', 15); eI.title = '重命名曲目'; eI.setAttribute('aria-label', eI.title);
                    eI.onclick = (e) => Admin.uiRenamePart(e, albIndex, trackIdx);
                    iconGroup.appendChild(eI);

                    const dI = document.createElement('button');
            dI.type = 'button';
                    dI.className = 'track-edit-icon'; dI.innerHTML = appIcon('trash', 15); dI.title = '删除曲目'; dI.setAttribute('aria-label', dI.title);
                    dI.style.color = 'var(--danger)';
                    dI.onclick = (e) => Admin.uiDeletePart(e, albIndex, trackIdx);
                    iconGroup.appendChild(dI);

                    trackDiv.appendChild(iconGroup);
                }

                dropdown.appendChild(trackDiv);
            });
            wrapper.appendChild(dropdown);
        }
        listL2.appendChild(wrapper);
    });
    if (IsAdmin()) Admin.refreshUnlockAll?.();
}

// ── 内部辅助函数 ──

/**
 * 渲染一个锁定列表运占位行（仅 Admin 可见）
 * @param {number} level - 0/1/2
 * @param {number} index
 * @returns {HTMLElement}
 */
function _renderLockedListItem(level, index) {
    return renderLockedCard({
        variant: 'list',
        label: '私密内容',
        onUnlock: () => Admin.uiUnlock(level, index),
        deleteEl: AdminCore?.AdminButtonHelper?.render({
            index,
            isDeleted: false,
            onDelete: (e) => { e.stopPropagation(); Admin.uiDelete(e, level, index); }
        })
    });
}
