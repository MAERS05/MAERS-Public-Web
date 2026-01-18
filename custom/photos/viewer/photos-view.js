/**
 * MAERS Album View (album-view.js)
 * 职责：DOM渲染、交互事件、Lightbox
 * 依赖：MAERS.Album.Controller
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.Album = MAERS.Album || {};

    const Controller = MAERS.Album.Controller;
    if (!Controller) {
        console.error("MAERS.Album.Controller not found!");
        return;
    }

    // View State
    const ViewState = {
        pickedPaths: new Set(),
        currentIdx: 0,
        isHD: false
    };

    let container = null;
    let saveBtn = null;

    document.addEventListener('DOMContentLoaded', init);

    async function init() {
        container = document.getElementById('gallery-container');
        saveBtn = document.getElementById('save-order-btn');
        const titleEl = document.getElementById('page-title');

        // 设置标题
        if (titleEl && typeof CATEGORY_CONFIG !== 'undefined') {
            const cfg = CATEGORY_CONFIG.find(c => c.id === Controller.State.category);
            if (cfg) titleEl.textContent = `${cfg.icon} ${cfg.subtitle || cfg.title}`;
        }

        // 初始加载
        await Controller.reloadData();
        render();

        if (Controller.State.isAdmin) {
            bindAdminEvents();
        }
        bindLightbox();

        // 全局右键取消
        document.addEventListener('contextmenu', (e) => {
            if (ViewState.pickedPaths.size > 0) {
                e.preventDefault();
                cancelMove();
            }
        });

        setupTiltEffect();
    }

    function render() {
        if (!container) return;
        const dataList = Controller.State.loadedData;
        const scrollTop = window.scrollY || document.documentElement.scrollTop;

        const existingMap = new Map();
        Array.from(container.children).forEach(el => {
            const path = el.getAttribute('data-path');
            if (path) existingMap.set(path, el);
        });

        const fragment = document.createDocumentFragment();

        dataList.forEach((img, idx) => {
            let div = existingMap.get(img.path);

            if (!div) {
                div = document.createElement('div');
                div.className = 'photo-item';
                div.setAttribute('data-path', img.path);

                const fullRawPath = Controller.fixPath(img.path);
                const thumbSrc = Controller.fixPath(img.thumb, null, 'thumbnails') || fullRawPath;

                div.innerHTML += `<img src="${thumbSrc}" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.onerror=null; this.src='${fullRawPath}'">`;

                if (Controller.State.isAdmin) {
                    const del = document.createElement('button');
                    del.className = 'delete-btn';
                    del.textContent = '×';
                    del.onclick = (e) => { e.stopPropagation(); stageDelete(div); };
                    div.appendChild(del);

                    const move = document.createElement('button');
                    move.className = 'move-btn';
                    move.textContent = '≡';
                    move.title = "Sort";
                    move.onclick = (e) => { e.stopPropagation(); togglePick(img.path); };
                    div.appendChild(move);
                }

                div.onclick = () => {
                    if (ViewState.pickedPaths.size > 0) {
                        if (ViewState.pickedPaths.has(img.path)) togglePick(img.path);
                        else executeMove(img.path);
                        return;
                    }
                    if (div.classList.contains('pending-delete')) { stageDelete(div); return; }
                    openLightbox(img.path);
                };
            } else {
                existingMap.delete(img.path);
            }
            fragment.appendChild(div);
        });

        existingMap.forEach(el => el.remove());
        container.appendChild(fragment);

        updateSelectionVisuals();
        updateSaveButtonState();

        if (scrollTop > 0) window.scrollTo(0, scrollTop);
    }

    // --- Visual Effects ---

    function setupTiltEffect() {
        if (!container) return;

        container.addEventListener('mousemove', (e) => {
            const item = e.target.closest('.photo-item');
            if (!item || ViewState.pickedPaths.size > 0) return; // Disable tilt when reordering

            const rect = item.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            const centerX = rect.width / 2;
            const centerY = rect.height / 2;

            // Calculate rotation (max 3 degrees)
            const rotateX = ((y - centerY) / centerY) * -3;
            const rotateY = ((x - centerX) / centerX) * 3;

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

    // --- Interaction Logic ---

    function togglePick(path) {
        if (ViewState.pickedPaths.has(path)) ViewState.pickedPaths.delete(path);
        else ViewState.pickedPaths.add(path);
        updateSelectionVisuals();
    }

    function cancelMove() {
        ViewState.pickedPaths.clear();
        document.body.classList.remove('is-reordering');
        updateSelectionVisuals();
    }

    function updateSelectionVisuals() {
        const items = container.querySelectorAll('.photo-item');
        const pickedArray = Array.from(ViewState.pickedPaths);

        items.forEach(el => {
            const path = el.getAttribute('data-path');
            if (ViewState.pickedPaths.has(path)) {
                el.classList.add('is-picked');
                let badge = el.querySelector('.pick-badge');
                if (!badge) {
                    badge = document.createElement('div');
                    badge.className = 'pick-badge';
                    el.appendChild(badge);
                }
                badge.textContent = pickedArray.indexOf(path) + 1;
            } else {
                el.classList.remove('is-picked');
                const badge = el.querySelector('.pick-badge');
                if (badge) badge.remove();
            }
        });

        if (ViewState.pickedPaths.size > 0) document.body.classList.add('is-reordering');
        else document.body.classList.remove('is-reordering');
    }

    function executeMove(targetPath) {
        const list = Controller.State.loadedData;
        const targetIndex = list.findIndex(i => i.path === targetPath);
        if (targetIndex === -1) return;

        const itemsToMove = [];
        const newLoadedData = [];

        list.forEach(item => {
            if (ViewState.pickedPaths.has(item.path)) itemsToMove.push(item);
            else newLoadedData.push(item);
        });

        let insertIndex = newLoadedData.findIndex(i => i.path === targetPath);
        // 如果是往后插，逻辑可能需要微调，这里保持简单插入逻辑
        if (insertIndex === -1) insertIndex = newLoadedData.length;

        newLoadedData.splice(insertIndex, 0, ...itemsToMove);

        Controller.State.loadedData = newLoadedData; // Update State directly (optimistic UI)
        cancelMove();
        render();
    }

    function stageDelete(el) {
        if (ViewState.pickedPaths.size > 0) return;
        el.classList.toggle('pending-delete');
        updateSaveButtonState();
    }

    function updateSaveButtonState() {
        if (!saveBtn) return;
        const pendingDeletes = container.querySelectorAll('.photo-item.pending-delete').length;
        const isDirty = Controller.checkIsDirty(Controller.State.loadedData, pendingDeletes);

        if (isDirty) {
            saveBtn.classList.add('has-changes');
            saveBtn.style.opacity = "1";
        } else {
            saveBtn.classList.remove('has-changes');
            saveBtn.style.opacity = "";
        }
    }

    function bindAdminEvents() {
        const upBtn = document.getElementById('upload-btn');
        const fileInput = document.getElementById('file-input');

        if (upBtn && fileInput) {
            upBtn.style.display = 'flex';
            saveBtn.style.display = 'flex';
            fileInput.onchange = async (e) => {
                const res = await Controller.uploadFiles(e.target.files);
                if (res.dupCount > 0) {
                    showToast(`发现 ${res.dupCount} 张重复图片`, 'warning');
                } else {
                    showToast("上传成功", 'success');
                }
                render();
            };
        }

        if (saveBtn) {
            saveBtn.onclick = async () => {
                saveBtn.textContent = "⏳";
                try {
                    const dels = Array.from(document.querySelectorAll('.photo-item.pending-delete')).map(el => el.dataset.path);
                    const newOrder = Controller.State.loadedData.map(i => ({ path: i.path })); // State is already reordered by executeMove

                    const res = await Controller.saveChanges(dels, newOrder);
                    if (res.success) {
                        showToast("✅ 保存成功");
                        render();
                    } else throw res.error;
                } catch (e) {
                    showToast("❌ 保存失败", 'error');
                } finally {
                    saveBtn.textContent = "💾";
                }
            };
        }
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

    function openLightbox(path) {
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

    // Expose for external calls
    MAERS.Album.openLightbox = openLightbox;

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
        let wheelTimeout = null;
        lb.addEventListener('wheel', (e) => {
            if (!lb.classList.contains('active')) return;

            // Prevent default scroll behavior
            e.preventDefault();

            // Debounce wheel events to prevent too fast switching
            if (wheelTimeout) return;
            wheelTimeout = setTimeout(() => { wheelTimeout = null; }, 200);

            // Navigate based on wheel direction
            if (e.deltaY < 0) {
                navigate(-1); // Scroll up = previous image
            } else if (e.deltaY > 0) {
                navigate(1);  // Scroll down = next image
            }
        }, { passive: false });

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

    function showToast(msg, type = 'success') {
        if (MAERS.Toast) {
            type === 'error' ? MAERS.Toast.error(msg) : MAERS.Toast.success(msg);
        } else {
            alert(msg);
        }
    }

    MAERS.Album.View = {
        render,
        openLightbox
    };

})(typeof window !== 'undefined' ? window : this);
