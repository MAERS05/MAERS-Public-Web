/**
 * @module shared/theme/theme-drag.module.js
 * @description 拖拽交互系统
 * @version 1.0.0 - ES6 Module
 */

// 拖拽交互状态
let panState = {
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    currentX: 0,
    currentY: 0,
    tempStartX: 0,
    tempStartY: 0,
    initialStartX: 0,
    initialStartY: 0,
    heldTimer: null,
    targetEl: null,
    ticking: false
};

// 蓝色涟漪动画
function createRipple(x, y) {
    const ripple = document.createElement("div");
    ripple.classList.add("long-press-ripple");

    const size = 100;
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${x - size / 2}px`;
    ripple.style.top = `${y - size / 2}px`;

    document.body.appendChild(ripple);

    ripple.addEventListener("animationend", () => {
        ripple.remove();
    });
}

// 性能优化的位置更新 (rAF)
function updatePanTransform() {
    if (!panState.targetEl) panState.targetEl = document.querySelector(".main-card, .home-container");

    if (panState.targetEl && !panState.ticking) {
        panState.ticking = true;
        requestAnimationFrame(() => {
            panState.targetEl.style.setProperty("--zoom-pan-x", `${panState.currentX}px`);
            panState.targetEl.style.setProperty("--zoom-pan-y", `${panState.currentY}px`);
            panState.ticking = false;
        });
    }
}

// 统一处理 Start 事件 (Mouse + Touch)
function handleDragStart(e) {
    if (!document.documentElement.classList.contains("shrink-view")) return;

    const isCard = e.target.closest(".main-card, .home-container");
    if (!isCard) return;

    if (e.target.closest("a, button, input, .interactive")) return;

    let clientX, clientY;
    if (e.type === 'touchstart') {
        if (e.touches.length > 1) return;
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }

    panState.tempStartX = clientX;
    panState.tempStartY = clientY;
    panState.initialStartX = clientX;
    panState.initialStartY = clientY;

    if (panState.heldTimer) clearTimeout(panState.heldTimer);

    panState.heldTimer = setTimeout(() => {
        panState.isDragging = true;
        createRipple(panState.tempStartX, panState.tempStartY);

        const target = document.querySelector(".main-card, .home-container");
        if (target) target.classList.add("is-dragging");

        panState.dragStartX = panState.tempStartX;
        panState.dragStartY = panState.tempStartY;
    }, 600);
}

// 统一处理 Move 事件
function handleDragMove(e) {
    if (!document.documentElement.classList.contains("shrink-view")) return;

    let clientX, clientY;
    if (e.type === 'touchmove') {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }

    if (panState.isDragging) {
        if (e.cancelable) e.preventDefault();

        const dx = clientX - panState.dragStartX;
        const dy = clientY - panState.dragStartY;

        panState.currentX += dx / 0.65;
        panState.currentY += dy / 0.65;

        panState.dragStartX = clientX;
        panState.dragStartY = clientY;

        updatePanTransform();
        return;
    }

    if (panState.heldTimer) {
        const moveDist = Math.sqrt(Math.pow(clientX - panState.tempStartX, 2) + Math.pow(clientY - panState.tempStartY, 2));

        if (moveDist > 10) {
            clearTimeout(panState.heldTimer);
            panState.heldTimer = null;
        }
    }
}

// 统一处理 End 事件
function handleDragEnd(e) {
    if (panState.heldTimer) {
        clearTimeout(panState.heldTimer);
        panState.heldTimer = null;
    }

    if (panState.isDragging) {
        panState.isDragging = false;
        const target = document.querySelector(".main-card, .home-container");
        if (target) target.classList.remove("is-dragging");
    }
}

export function bindDragListeners() {
    const container = document.body;
    container.addEventListener("mousedown", handleDragStart);
    window.addEventListener("mousemove", handleDragMove);
    window.addEventListener("mouseup", handleDragEnd);
    container.addEventListener("touchstart", handleDragStart, { passive: false });
    window.addEventListener("touchmove", handleDragMove, { passive: false });
    window.addEventListener("touchend", handleDragEnd);
}

export function unbindDragListeners() {
    const container = document.body;
    container.removeEventListener("mousedown", handleDragStart);
    window.removeEventListener("mousemove", handleDragMove);
    window.removeEventListener("mouseup", handleDragEnd);
    container.removeEventListener("touchstart", handleDragStart);
    window.removeEventListener("touchmove", handleDragMove);
    window.removeEventListener("touchend", handleDragEnd);
}

export function resetPanState() {
    panState.currentX = 0;
    panState.currentY = 0;
    updatePanTransform();
}

export { panState };
