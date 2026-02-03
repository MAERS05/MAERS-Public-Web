/**
 * MAERS Album View (photos-view.module.js)
 * 职责：DOM渲染、交互事件、Lightbox
 * 依赖：Controller, Admin (可选), AdminCore (可选)
 * @version 3.0.0 - ES6 Module
 */

// 依赖声明
let Controller, Admin, AdminCore;

// Import Config
// Import Config
import '../../album/viewer/album-config.module.js';
import { Utils } from '../../../shared/utils.module.js';

const WHEEL_DELAY = 250;

// 依赖注入
export function initView(controller, admin = null, adminCore = null) {
    Controller = controller;
    Admin = admin;
    AdminCore = adminCore;
}

// View State
const ViewState = {
    currentIdx: 0,
    isHD: false
};

let container = null;
let saveBtn = null;

async function init() {
    container = document.getElementById('gallery-container');
    saveBtn = document.getElementById('save-order-btn');
    const titleEl = document.getElementById('page-title');

    // 设置标题
    if (titleEl) {
        const cfg = (window.CATEGORY_CONFIG || []).find(c => c.id === Controller.State.category);
        if (cfg) {
            titleEl.textContent = `${cfg.icon} ${cfg.subtitle || cfg.title}`;

            // Apply zoom trigger using global function
            if (window.MAERS?.Theme?.setupZoomTrigger) {
                window.MAERS.Theme.setupZoomTrigger(titleEl, 'icon_only', true);
            }
        }
    }

    // 初始加载
    await Controller.reloadData();

    // Initialize Manager (if admin)
    if (Controller.State.isAdmin && Admin?.initManager) {
        Admin.initManager(Controller.State.loadedData);
    }

    render();

    bindLightbox();

    setupTiltEffect();
}

export function render() {
    if (!container) return;
    const dataList = Controller.State.loadedData;

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
            const extraClasses = manager.getItemClass(idx);
            div.className = `photo-item ${extraClasses}`;
            if (manager.selectedIndices.includes(idx)) {
                const orderNum = manager.selectedIndices.indexOf(idx) + 1;
                div.setAttribute('data-order-num', orderNum);
            } else {
                div.removeAttribute('data-order-num');
            }
        }

        // Apply Admin Buttons
        const existingBtns = div.querySelector('.photo-admin-actions');
        if (existingBtns) existingBtns.remove();

        const shouldHaveBtns = Controller.State.isAdmin && Admin && AdminCore?.AdminButtonHelper;

        if (shouldHaveBtns) {
            const adminEl = AdminCore.AdminButtonHelper.render({
                index: idx,
                onSort: (e) => {
                    e.stopPropagation();
                    Admin.togglePick(img.path);
                },
                onEdit: null,
                onDelete: (e) => Admin.stageDelete(e),
                isDeleted: img._deleted || false,
                extraClass: '',
                containerClass: 'photo-admin-actions'
            });
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
