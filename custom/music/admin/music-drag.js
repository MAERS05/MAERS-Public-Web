/**
 * MAERS Music Drag & Drop Logic (music-drag.js)
 * 依赖: MAERS.Music.UI
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.Music = MAERS.Music || {};

    // 拖拽状态
    const DragState = {
        isDragging: false,
        ghost: null,
        placeholder: null,
        srcList: null,
        srcIndex: -1,
        container: null,
        grabOffsetX: 0,
        grabOffsetY: 0
    };

    function startStickyDrag(e, level, index) {
        e.stopPropagation();
        if (DragState.isDragging) return;

        DragState.isDragging = true;
        DragState.srcIndex = index;
        document.body.classList.add('is-dragging-mode');

        const UI = MAERS.Music.UI || {};

        if (level === 0) {
            DragState.srcList = UI.libraryData;
            DragState.container = document.getElementById('list-level-0');
        } else if (level === 1) {
            DragState.srcList = UI.libraryData[UI.currentCatIndex].collections;
            DragState.container = document.getElementById('list-level-1');
        } else if (level === 2) {
            DragState.srcList = UI.libraryData[UI.currentCatIndex].collections[UI.currentColIndex].albums;
            DragState.container = document.getElementById('list-level-2');
        }

        if (!DragState.container) {
            console.error("[MAERS.Music.Drag] Container not found!");
            return;
        }

        let itemEl = DragState.container.children[index];
        const rect = itemEl.getBoundingClientRect();
        DragState.grabOffsetX = e.clientX - rect.left;
        DragState.grabOffsetY = e.clientY - rect.top;

        DragState.placeholder = document.createElement('div');
        DragState.placeholder.className = 'drag-placeholder';
        DragState.placeholder.style.height = itemEl.offsetHeight + 'px';
        DragState.placeholder.style.marginBottom = '5px';

        DragState.ghost = itemEl.cloneNode(true);
        DragState.ghost.className += ' drag-ghost';
        DragState.ghost.style.width = rect.width + 'px';
        const actions = DragState.ghost.querySelector('.item-actions');
        if (actions) actions.style.display = 'none';

        document.body.appendChild(DragState.ghost);
        DragState.container.replaceChild(DragState.placeholder, itemEl);

        updateGhostPosition(e);

        document.addEventListener('mousemove', handleStickyMove);
        setTimeout(() => document.addEventListener('click', finishStickyDrag, true), 50);
        document.addEventListener('contextmenu', cancelStickyDrag, true);
        document.body.style.cursor = 'grabbing';
    }

    function handleStickyMove(e) {
        if (!DragState.isDragging) return;
        e.preventDefault();
        updateGhostPosition(e);

        const siblings = Array.from(DragState.container.children);
        const mouseY = e.clientY;
        let closestEl = null;
        let minOffset = Number.POSITIVE_INFINITY;

        siblings.forEach(sibling => {
            if (sibling === DragState.placeholder) return;
            const rect = sibling.getBoundingClientRect();
            const offset = Math.abs(mouseY - (rect.top + rect.height / 2));
            if (offset < minOffset) {
                minOffset = offset;
                closestEl = sibling;
            }
        });

        if (closestEl) {
            const rect = closestEl.getBoundingClientRect();
            if (mouseY < rect.top + rect.height / 2) {
                DragState.container.insertBefore(DragState.placeholder, closestEl);
            } else {
                DragState.container.insertBefore(DragState.placeholder, closestEl.nextSibling);
            }
        }
    }

    function updateGhostPosition(e) {
        if (DragState.ghost) {
            DragState.ghost.style.left = (e.clientX - DragState.grabOffsetX) + 'px';
            DragState.ghost.style.top = (e.clientY - DragState.grabOffsetY) + 'px';
        }
    }

    function finishStickyDrag(e) {
        if (!DragState.isDragging) return;
        e.stopPropagation();
        e.preventDefault();

        const newIndex = Array.from(DragState.container.children).indexOf(DragState.placeholder);
        if (DragState.srcIndex !== -1 && newIndex !== -1) {
            const item = DragState.srcList.splice(DragState.srcIndex, 1)[0];
            DragState.srcList.splice(newIndex, 0, item);
            const UI = MAERS.Music.UI;
            if (UI && UI.saveData) UI.saveData();
        }

        cleanupDrag();
        const UI = MAERS.Music.UI;
        if (UI && UI.refreshCurrentView) UI.refreshCurrentView();
    }

    function cancelStickyDrag(e) {
        if (!DragState.isDragging) return;
        e.preventDefault();
        e.stopPropagation();
        cleanupDrag();
        const UI = MAERS.Music.UI;
        if (UI && UI.refreshCurrentView) UI.refreshCurrentView();
    }

    function cleanupDrag() {
        DragState.isDragging = false;
        document.body.classList.remove('is-dragging-mode');

        if (DragState.ghost) DragState.ghost.remove();
        if (DragState.placeholder) DragState.placeholder.remove();

        document.removeEventListener('mousemove', handleStickyMove);
        document.removeEventListener('click', finishStickyDrag, true);
        document.removeEventListener('contextmenu', cancelStickyDrag, true);
        document.body.style.cursor = '';

        DragState.ghost = null;
        DragState.placeholder = null;
        DragState.srcList = null;
        DragState.container = null;
    }

    // Mount to namespace
    MAERS.Music.Drag = {
        startStickyDrag,
        DragState
    };

})(typeof window !== 'undefined' ? window : this);
