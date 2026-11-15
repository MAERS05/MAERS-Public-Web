import { icon as appIcon } from '../../../shared/icons.module.js';
/**
 * MAERS Album View (photos-view.module.js)
 * 职责：图库列表渲染、排序、标签与管理按钮；灯箱通过独立实例调度
 * 依赖：Controller, Admin (可选), AdminCore (可选)
 * @version 3.0.0 - ES6 Module
 */

// 依赖声明
let Controller, Admin, AdminCore;

// 共用工具与移动端手势适配。
import { Utils } from '../../../shared/utils.module.js';
import { Toast } from '../../../shared/toast.module.js';
import { tagFilterMode } from '../../cms/viewer/tags/cms-tags-filter.module.js';
import { PhotoLightbox } from './photos-lightbox.module.js';

const lightbox = new PhotoLightbox({
    getItems: lightboxItems,
    fixPath: (...args) => Controller.fixPath(...args),
    getThumbnail: path => Array.from(container?.children || [])
        .find(item => item.getAttribute('data-path') === path)?.querySelector('img') || null
});

// 依赖注入
export function initView(controller, admin = null, adminCore = null) {
    Controller = controller;
    Admin = admin;
    AdminCore = adminCore;
}

// 当前结果包含全部匹配图片，网格只挂载其中一页。
const PHOTOS_PER_PAGE = 100;
const ViewState = {
    sortMode: 0, // 默认、时间顺序、时间倒序
    originalData: [],
    results: [],
    filterKey: null,
    page: 0
};

const SortMode = {
    DEFAULT: 0,
    TIME_DESC: 1,
    TIME_ASC: 2
};

/** 筛选时管理器下标与展示下标不同，停用按下标进行的排序操作。 */
function isFiltering() {
    if (!AdminCore || !AdminCore.AppState) return false;
    return (AdminCore.AppState.searchQuery || (AdminCore.AppState.activeFilters && AdminCore.AppState.activeFilters.size > 0));
}

let container = null;
let pager = null;
let thumbnailObserver = null;
const renderedTags = new WeakMap();
const renderedActions = new WeakMap();

async function loadTitle(category) {
    const titleEl = document.getElementById('page-title');
    try {
        if (!category) {
            const response = await fetch('data/album-config.json', { cache: 'no-cache' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const categories = await response.json();
            if (!Array.isArray(categories)) throw new TypeError('相册配置格式无效');
            category = categories.find(item => item?.id === Controller.State.category);
        }
        if (!titleEl || !category) return;
        // 图标沿用配置中的图标标记，标题只按文字展示。
        const iconValue = String(category.icon || '').trim();
        const iconSource = iconValue.match(/src=["']([^"']+)["']/)?.[1] || iconValue;
        const symbol = document.createElement('span');
        symbol.className = 'page-title-symbol';
        if (/^ui\/[a-z0-9_-]+\.svg$/i.test(iconSource)) {
            const image = document.createElement('img');
            image.src = new URL('../../../' + iconSource, import.meta.url).href;
            image.alt = '';
            symbol.append(image);
        } else symbol.innerHTML = appIcon('photo', 24);
        const label = document.createElement('span');
        label.textContent = category.title || category.subtitle || '照片';
        titleEl.classList.remove('zoom-trigger-icon', 'zoom-trigger-whole');
        titleEl.replaceChildren(symbol, label);
        document.title = `${category.title || category.subtitle || '照片'} · 我的空间`;
    } catch (err) {
        console.error('[MAERS Photos] 相册标题加载失败', err);
    }
}

async function init() {
    container = document.getElementById('gallery-container');
    if (!container || !Controller) return;
    if (typeof IntersectionObserver === 'function' && !thumbnailObserver) {
        thumbnailObserver = new IntersectionObserver((entries, observer) => {
            for (const { isIntersecting, target } of entries) {
                if (!isIntersecting) continue;
                observer.unobserve(target);
                if (!target.isConnected || !target.dataset.src) continue;
                target.src = target.dataset.src;
                delete target.dataset.src;
            }
        }, { root: container, rootMargin: '360px 0px' });
    }
    const category = await Controller.resolveCategory?.();
    await Promise.all([loadTitle(category), Controller.reloadData()]);
    ViewState.originalData = [...Controller.State.loadedData];
    if (Controller.State.isAdmin && Admin?.initManager) {
        Admin.initManager(Controller.State.loadedData);
    }
    bindSortMenu();
    render();
    setupTiltEffect();
}

function bindSortMenu() {
    const triggerBtn = document.getElementById('sort-trigger-btn');
    const menuEl = document.getElementById('sort-menu');

    if (!triggerBtn || !menuEl) return;
    const closeMenu = () => {
        menuEl.classList.remove('show');
        triggerBtn.classList.remove('active');
    };
    triggerBtn.onclick = (e) => {
        e.stopPropagation();
        menuEl.classList.toggle('show');
        triggerBtn.classList.toggle('active');
    };

    menuEl.querySelectorAll('.sort-item').forEach(item => {
        item.onclick = (e) => {
            e.stopPropagation();
            const mode = parseInt(item.dataset.mode);
            setSortMode(mode);
            closeMenu();
        };
    });

    document.addEventListener('click', (e) => {
        if (!triggerBtn.contains(e.target) && !menuEl.contains(e.target)) closeMenu();
    });
    updateSortUI();
}

function setSortMode(mode) {
    ViewState.sortMode = mode;
    updateSortUI();
    applySort();
}

function updateSortUI() {
    const label = document.getElementById('sort-label');
    const items = document.querySelectorAll('.sort-item');

    if (!label) return;

    // 更新当前排序文案。
    switch (ViewState.sortMode) {
        case SortMode.DEFAULT:
            label.textContent = "默认";
            break;
        case SortMode.TIME_DESC:
            label.textContent = "时间顺序";
            break;
        case SortMode.TIME_ASC:
            label.textContent = "时间倒序";
            break;
    }

    // 更新菜单选中状态。
    items.forEach(item => {
        if (parseInt(item.dataset.mode) === ViewState.sortMode) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
}

function applySort() {
    let list = [...ViewState.originalData];

    // 如果 originalData 为空但 loadedData 有值（可能初始化错位），尝试同步
    if (list.length === 0 && Controller.State.loadedData.length > 0) {
        list = [...Controller.State.loadedData];
        ViewState.originalData = [...list];
    }

    if (ViewState.sortMode === SortMode.TIME_DESC) {
        list.sort((a, b) => getTime(b) - getTime(a));
    } else if (ViewState.sortMode === SortMode.TIME_ASC) {
        list.sort((a, b) => getTime(a) - getTime(b));
    }

    Controller.State.loadedData = list;

    // 纯前端展示排序，不触发 Admin 的 Dirty Check
    // 这样管理员点击排序后，"保存"按钮不会亮起，也不会误以为需要保存

    const matchingPaths = isFiltering() ? new Set(ViewState.results.map(photo => photo.path)) : null;
    ViewState.page = 0;
    render(matchingPaths ? list.filter(photo => matchingPaths.has(photo.path)) : list);
    container.scrollTop = 0;
}

/** 文件名中的时间优先于路径；无法识别的时间按零处理。 */
function getTime(item) {
    for (const value of [item.name, item.path]) {
        if (!value) continue;
        const timestamp = value.match(/(1[6-9]\d{11})/);
        if (timestamp) return Number(timestamp[1]);
        const match = value.match(/(20\d{6})_(\d{6})_(\d+)/) ||
            value.match(/(20\d{2}[01]\d[0-3]\d)[-_](\d{6})/) ||
            value.match(/(20\d{6})(\d{6})/);
        if (!match) continue;
        const date = match[1], time = match[2];
        const milliseconds = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T` +
            `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}`).getTime();
        if (Number.isFinite(milliseconds)) return milliseconds + Number(match[3] || 0);
    }
    return 0;
}

/** 创建图片节点，使用浏览器原生延迟加载，缩略图失败时回退原图。 */
function createPhotoItem(photo, priority) {
    const item = document.createElement('div');
    item.className = 'photo-item';
    item.setAttribute('data-path', photo.path);
    const original = Controller.fixPath(photo.path);
    const image = document.createElement('img');
    image.decoding = 'async';
    image.loading = priority ? 'eager' : 'lazy';
    if (priority) image.fetchPriority = 'high';
    if (Number.isInteger(photo.width) && photo.width > 0 &&
        Number.isInteger(photo.height) && photo.height > 0) {
        image.width = photo.width;
        image.height = photo.height;
    }
    image.alt = photo.name || '照片';
    image.onload = () => image.classList.add('loaded');
    image.onerror = () => {
        image.onerror = null;
        image.src = original;
    };
    const src = Controller.fixPath(photo.thumb, null, 'thumbnails') || original;
    if (!priority && thumbnailObserver) {
        image.dataset.src = src;
        thumbnailObserver.observe(image);
    } else {
        image.src = src;
    }
    item.appendChild(image);
    return item;
}

function handlePhotoClick(photo, index, item, manager) {
    if (Admin?.isReordering()) {
        if (manager?.selectedIndices.includes(index)) Admin.togglePick(photo.path);
        else Admin.executeMove(photo.path);
        return;
    }
    if (photo._deleted) {
        Admin?.stageDelete(item);
        return;
    }
    openLightbox(photo.path);
}

function updatePhotoStyle(item, photo, index, manager, filtering) {
    item.removeAttribute('data-order-num');
    if (!manager) return;
    if (filtering) {
        item.className = `photo-item ${photo._deleted ? 'is-deleted' : ''}`;
        return;
    }
    item.className = `photo-item ${manager.getItemClass(index)}`;
    const picked = manager.selectedIndices.indexOf(index);
    if (picked >= 0) item.setAttribute('data-order-num', picked + 1);
}

function createTag(tag, activeFilters) {
    const chip = document.createElement('span');
    chip.className = 'photo-tag-chip';
    chip.textContent = tag;
    if (!AdminCore?.Tags?.filterByTag) return chip;
    chip.title = '筛选这个标签';
    chip.style.cursor = 'pointer';
    chip.classList.toggle('active', Boolean(activeFilters?.has(tag)));
    chip.onclick = event => {
        event.stopPropagation();
        AdminCore.Tags.filterByTag(event, tag);
    };
    return chip;
}

function updatePhotoTags(item, photo, activeFilters) {
    const previous = renderedTags.get(item);
    const values = photo.tags;
    if (previous?.photo === photo && previous.values.length === values?.length &&
        previous.values.every((tag, index) => tag === values[index])) {
        previous.values.forEach((tag, index) => {
            previous.element.children[index].classList.toggle('active', Boolean(activeFilters?.has(tag)));
        });
        return;
    }

    previous?.element.remove();
    if (!values?.length) {
        renderedTags.delete(item);
        return;
    }
    const tags = document.createElement('div');
    tags.className = 'photo-tags';
    for (const tag of values) {
        const chip = createTag(tag, activeFilters);
        tags.appendChild(chip);
        // 管理事件绑定器读取标签的父容器，必须先挂载标签节点。
        Admin?.bindTagEvents?.(chip, photo, tag);
    }
    item.appendChild(tags);
    renderedTags.set(item, { element: tags, photo, values: [...values] });
}

function updatePhotoActions(item, photo, filtering) {
    const previous = renderedActions.get(item);
    const helper = Controller.State.isAdmin && Admin && AdminCore?.AdminButtonHelper;
    const deleted = Boolean(photo._deleted);
    if (helper && previous?.photo === photo && previous.filtering === filtering && previous.deleted === deleted) return;

    previous?.element.remove();
    if (!helper) {
        renderedActions.delete(item);
        return;
    }
    const actions = helper.render({
        onSort: filtering ? null : event => {
            event.stopPropagation();
            Admin.togglePick(photo.path);
        },
        onEdit: null,
        onAddTag: event => {
            event.stopPropagation();
            Admin.addTag?.(photo);
        },
        onDelete: event => Admin.stageDelete(event),
        isDeleted: deleted,
        extraClass: '',
        containerClass: 'photo-admin-actions'
    });
    item.appendChild(actions);
    renderedActions.set(item, { element: actions, photo, filtering, deleted });
}

/** 更新整类的匹配结果，并在筛选条件改变时回到第一页。 */
export function render(list = null) {
    if (!container) return;
    ViewState.results = list || Controller.State.loadedData || [];
    const { searchQuery, activeFilters } = AdminCore?.AppState || {};
    const tagSelection = activeFilters?.size ? [tagFilterMode, ...activeFilters] : [];
    const filterKey = JSON.stringify([searchQuery || '', tagSelection]);
    const filterChanged = ViewState.filterKey !== filterKey;
    ViewState.filterKey = filterKey;
    if (filterChanged) ViewState.page = 0;
    renderPage(filterChanged);
}

function selectPage(page) {
    ViewState.page = page;
    renderPage(true);
}

function updatePager(pageCount) {
    if (pageCount < 2) {
        if (pager) pager.nav.hidden = true;
        return;
    }
    if (!pager) {
        const nav = document.createElement('nav');
        nav.className = 'photo-pager';
        nav.setAttribute('aria-label', '图库分页');
        nav.innerHTML = `
            <button type="button" class="header-action-btn" aria-label="上一页">‹</button>
            <select class="header-action-btn" aria-label="跳转到图库页码"></select>
            <button type="button" class="header-action-btn" aria-label="下一页">›</button>`;
        const [previous, pageSelect, next] = nav.children;
        previous.onclick = () => selectPage(ViewState.page - 1);
        next.onclick = () => selectPage(ViewState.page + 1);
        pageSelect.onchange = () => selectPage(Number(pageSelect.value));
        container.before(nav);
        pager = { nav, previous, pageSelect, next };
    }

    const { nav, previous, pageSelect, next } = pager;
    if (pageSelect.length !== pageCount) {
        pageSelect.length = 0;
        for (let page = 0; page < pageCount; page++) {
            pageSelect.add(new Option(`${page + 1} / ${pageCount}`, String(page)));
        }
    }
    pageSelect.value = String(ViewState.page);
    previous.disabled = ViewState.page === 0;
    next.disabled = ViewState.page === pageCount - 1;
    nav.hidden = false;
}

/** 原位复用当前页的卡片，管理操作使用整类下标。 */
function renderPage(resetScroll) {
    const { results, page } = ViewState;
    const pageCount = Math.max(1, Math.ceil(results.length / PHOTOS_PER_PAGE));
    ViewState.page = Math.max(0, Math.min(page, pageCount - 1));
    const start = ViewState.page * PHOTOS_PER_PAGE;
    const pagePhotos = results.slice(start, start + PHOTOS_PER_PAGE);
    const pagePaths = new Set(pagePhotos.map(photo => photo.path));
    const existing = new Map();
    for (const item of Array.from(container.children)) {
        const path = item.getAttribute('data-path');
        if (pagePaths.delete(path)) existing.set(path, item);
        else {
            const image = item.querySelector('img');
            if (image?.dataset.src) thumbnailObserver?.unobserve(image);
            item.remove();
        }
    }
    const manager = Admin?.getManager?.();
    const filtering = Boolean(isFiltering());
    const activeFilters = AdminCore?.Tags?.filterByTag ? AdminCore.AppState?.activeFilters : null;
    pagePhotos.forEach((photo, offset) => {
        const index = start + offset;
        const item = existing.get(photo.path) || createPhotoItem(photo, index === 0);
        existing.delete(photo.path);
        item.onclick = () => handlePhotoClick(photo, index, item, manager);
        updatePhotoStyle(item, photo, index, manager, filtering);
        updatePhotoTags(item, photo, activeFilters);
        updatePhotoActions(item, photo, filtering);
        const occupant = container.children[offset];
        if (item !== occupant) container.insertBefore(item, occupant || null);
    });
    updatePager(pageCount);
    if (resetScroll || ViewState.page !== page) container.scrollTop = 0;
}

// 悬停动效。

function setupTiltEffect() {
    if (!container) return;

    let pendingItem = null;
    let pointerX = 0;
    let pointerY = 0;
    let framePending = false;

    const applyTilt = () => {
        framePending = false;
        const item = pendingItem;
        pendingItem = null;
        if (!item || item.parentNode !== container || Admin?.isReordering()) return;
        const rect = item.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        if (!centerX || !centerY) return;

        // 最大倾斜角为 2.2 度。
        const rotateX = ((pointerY - rect.top - centerY) / centerY) * -2.2;
        const rotateY = ((pointerX - rect.left - centerX) / centerX) * 2.2;

        item.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
        item.style.transition = 'transform 0.1s ease-out';
        item.style.zIndex = '10';
    };

    container.addEventListener('mousemove', (e) => {
        const item = e.target.closest('.photo-item');
        if (!item || Admin?.isReordering()) return; // 排序时停用倾斜效果

        pendingItem = item;
        pointerX = e.clientX;
        pointerY = e.clientY;
        if (framePending) return;
        framePending = true;
        requestAnimationFrame(applyTilt);
    });

    container.addEventListener('mouseout', (e) => {
        const item = e.target.closest('.photo-item');
        // 只在鼠标离开整个卡片时复位。
        if (!item || item.contains(e.relatedTarget)) return;
        if (pendingItem === item) pendingItem = null;
        item.style.transform = '';
        item.style.transition = 'transform 0.3s ease-out';
        item.style.zIndex = '';
    });
}

// 灯箱预览。

function lightboxItems() {
    return ViewState.results.filter(photo => !photo._deleted);
}

export function openLightbox(path) {
    return lightbox.open(path);
}

// 导出 View 对象（向后兼容）
export function setOriginalData(list) {
    ViewState.originalData = [...list];
}

export const View = {
    render,
    openLightbox,
    setOriginalData
};

// DOM Ready 初始化
document.addEventListener('DOMContentLoaded', () => init().catch(error => {
    console.error('[MAERS Photos] 图库初始化失败', error);
    Toast.error('图库加载失败，请刷新重试');
}));
