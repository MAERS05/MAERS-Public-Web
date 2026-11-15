/**
 * MAERS CMS - Events Module (cms-events.module.js)
 * 职责：事件委托设置、网格事件处理
 * @version 3.0.0 - ES6 Module
 */
import { confirmAction } from "../../../data-manage/admin/admin-confirm.module.js";


// 通过入口模块注入视图与管理依赖。
let State = null;
let Render = null;
let Admin = null;
let Tags = null;
let Reader = null;
let LiteratureView = null;
let Recent = null;

export function initEvents(state, render, admin = null, tags = null, editor = null, literatureView = null, recent = null) {
    State = state;
    Render = render;
    Admin = admin;
    Tags = tags;
    Reader = editor;
    LiteratureView = literatureView;
    Recent = recent;
}

let immersiveBgDelegated = false;

export function setupImmersiveBackground() {
    if (immersiveBgDelegated) return;
    immersiveBgDelegated = true;

    let hoverTimeout = null;
    let fadeOutTimeout = null;
    let activeLayerId = 'a';

    function isBlocked() {
        const reader = document.getElementById('immersive-reader');
        return !!(reader && reader.classList.contains('active'));
    }

    function triggerFadeOut() {
        clearTimeout(fadeOutTimeout);
        fadeOutTimeout = setTimeout(() => {
            const immersiveBg = document.getElementById('immersive-bg');
            if (!immersiveBg) return;
            const layerA = document.getElementById('imm-layer-a');
            const layerB = document.getElementById('imm-layer-b');
            if (layerA) { layerA.style.transition = 'opacity 0.5s ease'; layerA.style.opacity = '0'; }
            if (layerB) { layerB.style.transition = 'opacity 0.5s ease'; layerB.style.opacity = '0'; }
            immersiveBg.classList.remove('active');
            document.body.classList.remove('immersive-active');
        }, 350);
    }

    function onBlockStateChange() {
        if (isBlocked()) {
            clearTimeout(hoverTimeout);
            clearTimeout(fadeOutTimeout);
        } else {
            triggerFadeOut();
        }
    }

    new MutationObserver(onBlockStateChange)
        .observe(document.documentElement, { attributeFilter: ['class'] });

    new MutationObserver((mutations) => {
        if (mutations.some(m => m.target.id === 'immersive-reader')) onBlockStateChange();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });

    document.body.addEventListener("mouseover", (e) => {
        if (isBlocked()) return;

        const card = e.target.closest(".grid-item, .book-card, .photo-item, .category-card");
        if (!card) return;

        let imgUrl = null;
        // 仅使用内容封面或照片，不能将管理按钮里的 SVG 当成背景。
        const imgEl = card.querySelector('.item-cover-img') ||
            (card.matches('.photo-item') ? card.querySelector(':scope > img') : null);
        if (imgEl) {
            imgUrl = imgEl.src || imgEl.getAttribute('data-src');
        } else {
            const coverEl = card.querySelector('.book-cover');
            if (coverEl && coverEl.style.backgroundImage && coverEl.style.backgroundImage !== "none") {
                imgUrl = coverEl.style.backgroundImage.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
            }
        }

        const pickedId = State?.AppState?.pickedId || null;
        const manager = typeof Admin?.getManager === 'function' ? Admin.getManager() : null;
        if (!imgUrl || pickedId || (manager?.selectedIndices?.length > 0)) return;

        clearTimeout(hoverTimeout);
        clearTimeout(fadeOutTimeout);

        hoverTimeout = setTimeout(() => {
            const immersiveBg = document.getElementById('immersive-bg');
            if (!immersiveBg) return;

            const nextId = activeLayerId === 'a' ? 'b' : 'a';
            const nextLayer = document.getElementById(`imm-layer-${nextId}`);
            const currentLayer = document.getElementById(`imm-layer-${activeLayerId}`);
            if (!nextLayer) return;

            const blurEl = nextLayer.querySelector('.imm-blur');
            const clearEl = nextLayer.querySelector('.imm-clear');
            if (blurEl) blurEl.style.backgroundImage = `url('${imgUrl}')`;
            if (clearEl) clearEl.style.backgroundImage = `url('${imgUrl}')`;

            requestAnimationFrame(() => {
                nextLayer.style.transition = 'opacity 0.5s ease';
                nextLayer.style.opacity = '1';
                if (currentLayer) {
                    currentLayer.style.transition = 'opacity 1s ease';
                    currentLayer.style.opacity = '0';
                }
                immersiveBg.classList.add('active');
                document.body.classList.add('immersive-active');
                activeLayerId = nextId;
            });
        }, 80);
    });

    document.body.addEventListener("mouseout", (e) => {
        if (isBlocked()) return;
        const card = e.target.closest(".grid-item, .book-card, .photo-item, .category-card");
        if (!card) return;
        if (e.relatedTarget && card.contains(e.relatedTarget)) return;
        clearTimeout(hoverTimeout);
        triggerFadeOut();
    });
}

export function setupGridEventDelegation() {
    setupImmersiveBackground();
    if (State?.gridEventsDelegated) return;
    const container = document.getElementById("grid-container");
    if (!container) return;
    container.addEventListener('click', onGridClick);
    if (State.IS_ADMIN) container.addEventListener('contextmenu', onGridContextMenu);
    State.markGridEventsDelegated();
}

/** 标签、管理按钮、新建入口的优先级高于卡片导航。 */
function onGridClick(e) {
    const tag = e.target.closest('.mini-tag');
    if (tag) {
        e.stopPropagation();
        const tagName = tag.getAttribute('data-tag');
        if (tagName) Tags?.filterByTag?.(e, tagName);
        return;
    }
    const actionBtn = e.target.closest('.action-mini');
    if (actionBtn) {
        e.stopPropagation();
        handleGridAction(e, actionBtn);
        return;
    }
    const createBtn = e.target.closest('[data-action^="create-"]');
    if (createBtn) {
        Admin?.uiCreateNode?.(createBtn.dataset.action === 'create-folder' ? 'folder' : 'note');
        return;
    }
    const card = e.target.closest('.grid-item');
    if (card) handleCardClick(e, card.dataset.id);
}

/** 以独立入口分发管理操作，避免混入卡片导航分支。 */
function handleGridAction(e, button) {
    if (!Admin) return;
    const id = button.dataset.id;
    switch (button.dataset.action) {
        case 'pick': Admin.uiPickNode?.(e, id); break;
        case 'rename': Admin.uiRenameNode?.(e, id, button.dataset.title); break;
        case 'delete': Admin.uiDeleteNode?.(e, id); break;
        case 'add-tag': Admin.uiAddTag?.(e, id); break;
        case 'upload-cover': Admin.uiUploadCover?.(e, id); break;
        case 'remove-cover': Admin.uiRemoveCover?.(e, id); break;
    }
}

/** 批量排序中的卡片点击只调整选择或落点。 */
function handleSelection(manager, nodeId) {
    if (!manager?.selectedIndices.length) return false;
    const index = manager.list.findIndex(node => node.id === nodeId);
    if (index === -1) return true;
    if (manager.selectedIndices.includes(index)) manager.toggleSelect(index);
    else manager.moveTo(index);
    return true;
}

/** 普通卡片按当前排序、移动、阅读状态执行对应操作。 */
function handleCardClick(e, nodeId) {
    e.stopPropagation();
    const node = State.AppState.allNodes.find(entry => entry.id === nodeId);
    if (!node || handleSelection(Admin?.getManager?.(), nodeId)) return;
    if (State.IS_ADMIN && State.AppState.pickedId) {
        if (node.type === 'folder') Render?.enterFolder?.(node);
        return;
    }
    if (node.type === 'folder') {
        Render?.enterFolder?.(node);
        return;
    }
    if (!State.IS_ADMIN) LiteratureView?.engine?.promoteBook(node);
    Recent?.addToHistory?.(node);
    if (Reader?.openNote) Reader.openNote(node);
    else Reader?.open?.(node);

    // 先显示文章，再仅在搜索或筛选状态下询问是否切换目录。
    setTimeout(() => navigateIfFiltered(node), 100);
}

/** 延后判断筛选状态，保持打开阅读器时的响应顺序。 */
async function navigateIfFiltered(node) {
    const searchInput = document.getElementById('search-input');
    const hasSearch = searchInput && searchInput.value.trim().length > 0;
    if (!hasSearch && State.AppState.activeFilters.size === 0) return;
    if (await confirmAction({ confirmText: "前往所在目录", cancelText: "保留当前筛选" })) {
        navigateToFileContext(node);
    }
}

/** 根据祖先链恢复面包屑并清除筛选。 */
function navigateToFileContext(node) {
    const stack = [];
    let parentId = node.parentId;
    while (parentId && parentId !== 'root') {
        const parent = State.AppState.allNodes.find(entry => entry.id === parentId);
        if (!parent) break;
        stack.unshift(parent);
        parentId = parent.parentId;
    }
    stack.unshift('root');
    State.AppState.pathStack = stack;
    if (State.AppState.activeFilters.size > 0) {
        State.AppState.activeFilters.clear();
        Tags?.renderTags?.();
    }
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';
    Render?.renderBreadcrumb?.();
    const target = stack[stack.length - 1];
    Render?.renderGrid?.(target === 'root' ? State.AppState.root : target.children, false, true);
}

/** 右键取消移动；标签的右键菜单仍由标签组件处理。 */
function onGridContextMenu(e) {
    if (!State.AppState.pickedId) return;
    e.preventDefault();
    e.stopPropagation();
    Admin?.uiCancelPick?.();
    window.MAERS?.Toast?.success(' 移动已取消');
}

export const Events = {
    setupGridEventDelegation
};
