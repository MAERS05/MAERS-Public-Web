/**
 * MAERS Album View (photos-view.module.js)
 * 职责：DOM渲染、交互事件、Lightbox
 * 依赖：Controller, Admin (可选), AdminCore (可选)
 * @version 3.0.0 - ES6 Module
 */

// 依赖声明
let Controller, Admin, AdminCore;

// Import Utils
import { Utils } from '../../../shared/utils.module.js';

// Mobile Adaptation
import '../../zmobile adaptation/mobile-photos.js';

const WHEEL_DELAY = 250;

// Album Config (loaded dynamically)
let CATEGORY_CONFIG = [];

// 依赖注入
export function initView(controller, admin = null, adminCore = null) {
    Controller = controller;
    Admin = admin;
    AdminCore = adminCore;
}

// View State
const ViewState = {
    currentIdx: 0,
    isHD: false,
    sortMode: 0, // 0: Default, 1: Time Desc, 2: Time Asc
    originalData: []
};

const SortMode = {
    DEFAULT: 0,
    TIME_DESC: 1,
    TIME_ASC: 2
};

// Helper: Check if currently filtering
function isFiltering() {
    if (!AdminCore || !AdminCore.AppState) return false;
    return (AdminCore.AppState.searchQuery || (AdminCore.AppState.activeFilters && AdminCore.AppState.activeFilters.size > 0));
}

let container = null;
let saveBtn = null;

async function init() {
    container = document.getElementById('gallery-container');
    saveBtn = document.getElementById('save-order-btn');
    const titleEl = document.getElementById('page-title');

    // 加载相册配置
    try {
        const response = await fetch('data/album-config.json?t=' + Date.now());
        if (response.ok) {
            CATEGORY_CONFIG = await response.json();
        } else {
            console.error('Failed to load album config');
        }
    } catch (err) {
        console.error('Error loading album config:', err);
    }

    // 设置标题
    if (titleEl) {
        const cfg = CATEGORY_CONFIG.find(c => c.id === Controller.State.category);
        if (cfg) {
            titleEl.innerHTML = `${cfg.icon} ${cfg.subtitle || cfg.title}`;

            // Apply zoom trigger using global function
            if (window.MAERS?.Theme?.setupZoomTrigger) {
                window.MAERS.Theme.setupZoomTrigger(titleEl, 'icon_only', true);
            }
        }
    }

    // 初始加载
    await Controller.reloadData();
    // Backup original order
    ViewState.originalData = [...Controller.State.loadedData];

    // Initialize Manager (if admin)
    if (Controller.State.isAdmin && Admin?.initManager) {
        Admin.initManager(Controller.State.loadedData);
    }

    // Bind Sort Dropdown
    const triggerBtn = document.getElementById('sort-trigger-btn');
    const menuEl = document.getElementById('sort-menu');

    if (triggerBtn && menuEl) {
        // Toggle menu
        triggerBtn.onclick = (e) => {
            e.stopPropagation();
            menuEl.classList.toggle('show');
            triggerBtn.classList.toggle('active');
        };

        // Item selection
        menuEl.querySelectorAll('.sort-item').forEach(item => {
            item.onclick = (e) => {
                e.stopPropagation();
                const mode = parseInt(item.dataset.mode);
                setSortMode(mode);
                // Close menu
                menuEl.classList.remove('show');
                triggerBtn.classList.remove('active');
            };
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (!triggerBtn.contains(e.target) && !menuEl.contains(e.target)) {
                menuEl.classList.remove('show');
                triggerBtn.classList.remove('active');
            }
        });

        updateSortUI();
    }

    render();

    bindLightbox();

    setupTiltEffect();
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

    // Update Label
    switch (ViewState.sortMode) {
        case SortMode.DEFAULT:
            label.textContent = "默认";
            break;
        case SortMode.TIME_DESC:
            // Mode 1: New -> Old
            label.textContent = "时间顺序";
            break;
        case SortMode.TIME_ASC:
            // Mode 2: Old -> New
            label.textContent = "时间倒序";
            break;
    }

    // Update Menu Active State
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

    render();
}

function getTime(item) {
    // 1. 尝试从文件名(name)或路径(path)中提取
    const targets = [item.name, item.path];

    for (const str of targets) {
        if (!str) continue;

        // Pattern A: 13位毫秒时间戳 (e.g. 1768296440061, img_176...)
        // 排除 202x 开头的（那是日期格式），通常时间戳是 17x 或 16x 开头
        const tsMatch = str.match(/(1[6-9]\d{11})/);
        if (tsMatch) return parseInt(tsMatch[1]);

        // Pattern B: yyyyMMdd_HHmmss_SS (带序号, e.g. 20260115_184233_72)
        // 优先匹配更长的带序号格式，以确保把序号算入排序权重
        const seqMatch = str.match(/(20\d{6})_(\d{6})_(\d+)/);
        if (seqMatch) {
            const dateStr = seqMatch[1]; // 20260115
            const timeStr = seqMatch[2]; // 184233
            const seq = parseInt(seqMatch[3]); // 72

            const year = dateStr.substring(0, 4);
            const month = dateStr.substring(4, 6);
            const day = dateStr.substring(6, 8);
            const hour = timeStr.substring(0, 2);
            const min = timeStr.substring(2, 4);
            const sec = timeStr.substring(4, 6);

            // 将序号作为毫秒加入，确保同秒内的顺序
            // 假设序号不会超过 999，即使超过也不影响大体时间序
            return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`).getTime() + seq;
        }

        // Pattern C: yyyyMMdd_HHmmss (标准, e.g. 20260128_184019, IMG_20250108_175319)
        const dateMatch = str.match(/20\d{2}[01]\d[0-3]\d[-_]\d{6}/);
        if (dateMatch) {
            // "20260128_184019" -> "2026-01-28T18:40:19"
            const s = dateMatch[0].replace(/[-_]/, ''); // 20260128184019
            const year = s.substring(0, 4);
            const month = s.substring(4, 6);
            const day = s.substring(6, 8);
            const hour = s.substring(8, 10);
            const min = s.substring(10, 12);
            const sec = s.substring(12, 14);
            return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`).getTime();
        }

        // Pattern D: yyyyMMddHHmmss (Pure 14 digits)
        const pureDateMatch = str.match(/(20\d{12})/);
        if (pureDateMatch) {
            const s = pureDateMatch[1];
            const year = s.substring(0, 4);
            const month = s.substring(4, 6);
            const day = s.substring(6, 8);
            const hour = s.substring(8, 10);
            const min = s.substring(10, 12);
            const sec = s.substring(12, 14);
            return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`).getTime();
        }
    }

    return 0;
}

export function render(list = null) {
    if (!container) return;

    // Use list if provided (e.g. search results), otherwise use globally loaded data
    const dataList = list || Controller.State.loadedData || [];

    // --- Smart Diff Rendering (In-Place) ---
    // This ensures we never empty the container, preventing scroll jumps.

    // 1. Snapshot existing nodes
    const existingMap = new Map();
    Array.from(container.children).forEach(el => {
        const path = el.getAttribute('data-path');
        if (path) existingMap.set(path, el);
    });

    const manager = Admin?.getManager?.();

    // 2. Reconcile
    dataList.forEach((img, idx) => {
        let div = existingMap.get(img.path);
        let isNew = false;

        if (!div) {
            isNew = true;
            div = document.createElement('div');
            div.className = 'photo-item';
            div.setAttribute('data-path', img.path);

            const fullRawPath = Controller.fixPath(img.path);
            const thumbSrc = Controller.fixPath(img.thumb, null, 'thumbnails') || fullRawPath;

            div.innerHTML = `<img src="${thumbSrc}" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.onerror=null; this.src='${fullRawPath}'">`;
        } else {
            // Remove from map so we know it's kept
            existingMap.delete(img.path);
        }

        // --- Update State/Events (for both new and existing) ---

        // Always update click handler
        div.onclick = () => {
            if (Admin?.isReordering()) {
                if (manager && manager.selectedIndices.includes(idx)) {
                    Admin.togglePick(img.path);
                } else {
                    Admin.executeMove(img.path);
                }
                return;
            }
            if (img._deleted) {
                Admin?.stageDelete(div);
                return;
            }
            openLightbox(img.path);
        };

        // Apply manager styling
        if (manager) {
            const filtering = isFiltering();
            if (filtering) {
                // When filtering, indices don't match manager list — check _deleted directly
                div.className = `photo-item ${img._deleted ? 'is-deleted' : ''}`;
            } else {
                const extraClasses = manager.getItemClass(idx);
                div.className = `photo-item ${extraClasses}`;
                if (manager.selectedIndices.includes(idx)) {
                    const orderNum = manager.selectedIndices.indexOf(idx) + 1;
                    div.setAttribute('data-order-num', orderNum);
                } else {
                    div.removeAttribute('data-order-num');
                }
            }
        }

        // --- Render Tags ---
        const existingTags = div.querySelector('.photo-tags');
        if (existingTags) existingTags.remove();

        if (img.tags && img.tags.length > 0) {
            const tagsDiv = document.createElement('div');
            tagsDiv.className = 'photo-tags';
            img.tags.forEach(t => {
                const span = document.createElement('span');
                span.className = 'photo-tag-chip';
                span.textContent = t;
                tagsDiv.appendChild(span);

                // Bind Delete Event (Right Click)
                if (Admin && Admin.bindTagEvents) {
                    Admin.bindTagEvents(span, img, t);
                }

                // Bind Tag Click (Filter)
                if (AdminCore && AdminCore.Tags && AdminCore.Tags.filterByTag) {
                    span.title = "Click to filter";
                    span.style.cursor = "pointer";

                    // Highlight Active
                    if (AdminCore.AppState && AdminCore.AppState.activeFilters && AdminCore.AppState.activeFilters.has(t)) {
                        span.classList.add('active');
                    }

                    span.onclick = (e) => {
                        e.stopPropagation();
                        AdminCore.Tags.filterByTag(e, t);
                    };
                }

                // Bind Tag Click (Filter) for remaining logic
            });
            div.appendChild(tagsDiv);
        }

        // Apply Admin Buttons
        const existingBtns = div.querySelector('.photo-admin-actions');
        if (existingBtns) existingBtns.remove();

        const shouldHaveBtns = Controller.State.isAdmin && Admin && AdminCore?.AdminButtonHelper;

        if (shouldHaveBtns) {
            const filtering = isFiltering();

            const adminEl = AdminCore.AdminButtonHelper.render({
                index: idx,
                onSort: filtering ? null : (e) => {
                    e.stopPropagation();
                    Admin.togglePick(img.path);
                },
                onEdit: null,
                onDelete: (e) => Admin.stageDelete(e),
                isDeleted: img._deleted || false,
                extraClass: '',
                containerClass: 'photo-admin-actions'
            });

            // Space-Style 'Add Tag' Button
            const addTagBtn = document.createElement('span');
            addTagBtn.className = 'maers-admin-btn';
            addTagBtn.innerHTML = '＋';
            addTagBtn.title = 'Add Tag';
            addTagBtn.onclick = (e) => {
                e.stopPropagation();
                if (Admin && Admin.addTag) Admin.addTag(img);
            };
            adminEl.appendChild(addTagBtn);

            div.appendChild(adminEl);
        }

        // --- PLACEMENT ---
        // Get the element currently at this position
        const occupant = container.children[idx];

        if (isNew) {
            container.insertBefore(div, occupant || null);
        } else {
            // If it's an existing node, check if it's in the right place
            if (div !== occupant) {
                // Move it. Since we are iterating from 0 to N, 
                // any node we encounter should be moved to the current index.
                container.insertBefore(div, occupant || null);
            }
            // If div === occupant, it's already in the right place, do nothing.
        }
    });

    // 3. Cleanup Stale Nodes
    existingMap.forEach(el => el.remove());

    // Manual scroll restoration is no longer needed because height never collapsed.
}

// --- Visual Effects ---

function setupTiltEffect() {
    if (!container) return;

    container.addEventListener('mousemove', (e) => {
        const item = e.target.closest('.photo-item');
        if (!item || Admin?.isReordering()) return; // Disable tilt when reordering

        const rect = item.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const centerX = rect.width / 2;
        const centerY = rect.height / 2;

        // Calculate rotation (max 2.2 degrees)
        const rotateX = ((y - centerY) / centerY) * -2.2;
        const rotateY = ((x - centerX) / centerX) * 2.2;

        item.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
        item.style.transition = 'transform 0.1s ease-out';
        item.style.zIndex = '10';
    });

    container.addEventListener('mouseout', (e) => {
        const item = e.target.closest('.photo-item');
        if (!item) return;

        // Check if mouse actually left the item (not just moved to a child)
        if (!item.contains(e.relatedTarget)) {
            item.style.transform = '';
            item.style.transition = 'transform 0.3s ease-out';
            item.style.zIndex = '';
        }
    });
}

// --- Lightbox ---

function loadToLightbox(data) {
    const lb = document.getElementById('lightbox');
    const imgEl = document.getElementById('lightbox-img');
    const hdBtn = document.getElementById('hd-switch');

    if (!data) return;
    const fullRawPath = Controller.fixPath(data.path);
    const previewPath = Controller.fixPath(data.preview, null, 'previews');
    const targetSrc = (ViewState.isHD || !previewPath) ? fullRawPath : previewPath;

    if (hdBtn) {
        hdBtn.classList.toggle('active', ViewState.isHD);
        const hdText = hdBtn.querySelector('.hd-text');
        if (hdText) hdText.textContent = ViewState.isHD ? "RAW" : "HD";
    }
    imgEl.classList.add('loading-hd');
    const tempLoader = new Image();
    tempLoader.onload = () => { imgEl.src = targetSrc; imgEl.classList.remove('loading-hd'); };
    tempLoader.onerror = () => { imgEl.src = fullRawPath; imgEl.classList.remove('loading-hd'); };
    tempLoader.src = targetSrc;
}

export function openLightbox(path) {
    const lb = document.getElementById('lightbox');
    ViewState.isHD = false;
    // Get current valid items (excluding deleted)
    const validItems = Controller.State.loadedData.filter(d => {
        const el = container.querySelector(`.photo-item[data-path="${d.path}"]`);
        return el && !el.classList.contains('pending-delete');
    });

    ViewState.currentIdx = validItems.findIndex(d => d.path === path);
    lb.dataset.tempList = JSON.stringify(validItems);

    loadToLightbox(validItems[ViewState.currentIdx]);
    lb.classList.add('active');
    document.body.style.overflow = 'hidden';
    document.body.classList.add('is-viewing');
}

const navigate = (d) => {
    const lb = document.getElementById('lightbox');
    const list = JSON.parse(lb.dataset.tempList || "[]");
    let newIdx = ViewState.currentIdx + d;
    if (newIdx < 0) newIdx = list.length - 1;
    if (newIdx >= list.length) newIdx = 0;
    ViewState.currentIdx = newIdx;
    loadToLightbox(list[newIdx]);
};

function bindLightbox() {
    const lb = document.getElementById('lightbox');
    const imgEl = document.getElementById('lightbox-img');
    const hdBtn = document.getElementById('hd-switch');
    if (!lb || !imgEl) return;

    // Bind events only
    const pBtn = lb.querySelector('.lb-prev'); if (pBtn) pBtn.onclick = (e) => { e.stopPropagation(); navigate(-1); };
    const nBtn = lb.querySelector('.lb-next'); if (nBtn) nBtn.onclick = (e) => { e.stopPropagation(); navigate(1); };
    if (hdBtn) hdBtn.onclick = (e) => {
        e.stopPropagation();
        ViewState.isHD = !ViewState.isHD;
        const list = JSON.parse(lb.dataset.tempList || "[]");
        loadToLightbox(list[ViewState.currentIdx]);
    };

    // Mouse wheel navigation
    lb.addEventListener('wheel', Utils.throttle((e) => {
        if (!lb.classList.contains('active')) return;

        // Prevent default scroll behavior
        e.preventDefault();

        // Navigate based on wheel direction
        if (e.deltaY < 0) {
            navigate(-1); // Scroll up = previous image
        } else if (e.deltaY > 0) {
            navigate(1);  // Scroll down = next image
        }
    }, WHEEL_DELAY), { passive: false });

    // Close button handler
    const closeBtn = lb.querySelector('.close-lightbox');
    if (closeBtn) {
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            lb.classList.remove('active');
            document.body.style.overflow = '';
            document.body.classList.remove('is-viewing');
        };
    }

    // Click outside image to close
    lb.onclick = (e) => {
        // Check if clicking on interactive buttons
        const isButton = e.target.closest('.lb-nav') ||
            e.target.closest('.hd-switch-wrapper') ||
            e.target.closest('.close-lightbox');

        if (isButton) return; // Don't close if clicking buttons

        // Check if clicking on actual visible image content
        if (e.target.id === 'lightbox-img') {
            const img = imgEl;
            const rect = img.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const clickY = e.clientY - rect.top;

            // Calculate actual image dimensions within the element
            const imgAspect = img.naturalWidth / img.naturalHeight;
            const boxAspect = rect.width / rect.height;

            let imgWidth, imgHeight, imgLeft, imgTop;

            if (imgAspect > boxAspect) {
                // Image is wider - fits width, has vertical padding
                imgWidth = rect.width;
                imgHeight = rect.width / imgAspect;
                imgLeft = 0;
                imgTop = (rect.height - imgHeight) / 2;
            } else {
                // Image is taller - fits height, has horizontal padding
                imgHeight = rect.height;
                imgWidth = rect.height * imgAspect;
                imgTop = 0;
                imgLeft = (rect.width - imgWidth) / 2;
            }

            // Check if click is within actual image bounds
            const isOnImage = clickX >= imgLeft && clickX <= imgLeft + imgWidth &&
                clickY >= imgTop && clickY <= imgTop + imgHeight;

            if (isOnImage) return; // Don't close if clicking on visible image
        }

        // Close lightbox
        lb.classList.remove('active');
        document.body.style.overflow = '';
        document.body.classList.remove('is-viewing');
    };
}



// 导出 View 对象（向后兼容）
export const View = {
    render,
    openLightbox
};

// DOM Ready 初始化
document.addEventListener('DOMContentLoaded', init);
