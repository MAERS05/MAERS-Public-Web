/**
 * @module shared/theme/theme-zoom.module.js
 * @description 缩放系统 + 视觉效果
 * @version 1.0.0 - ES6 Module
 */

import { Utils } from '../utils.module.js';
import { bindDragListeners, unbindDragListeners, resetPanState } from './theme-drag.module.js';

const AUTO_HIDE_DELAY = 5000;
const ZOOM_TIP = "点击缩放，长按卡片空白处拖拽";

function restoreGlobalView(e) {
    const t = e.target;
    // If element is detached from DOM, it was likely removed by a UI interaction (like innerHTML refresh)
    // In this case we should NOT restore the view.
    if (!document.body.contains(t)) return;

    if (t.closest(".main-card, .home-container, .immersive-layer")) return;
    if (t.closest(".zoom-trigger-icon") || t.closest(".zoom-trigger-whole")) return;
    if (t.closest(".theme-switch-wrapper") || t.closest(".auto-mode-btn") || t.closest(".mode-text-btn") || t.closest(".lightbox") || t.closest(".lightbox-overlay")) return;
    if (t.closest(".tag-drawer") || t.closest(".drawer-overlay") || t.closest(".admin-modal") || t.closest(".toast-container")) return;

    document.documentElement.classList.remove("shrink-view");
    document.removeEventListener("click", restoreGlobalView);
    localStorage.setItem("globalZoomState", "false");

    unbindDragListeners();
    resetPanState();
}

export function toggleGlobalShrink(e) {
    try {
        if (e) {
            e.stopPropagation();
            e.preventDefault();
        }
        const isShrunk = document.documentElement.classList.toggle("shrink-view");
        localStorage.setItem("globalZoomState", isShrunk);

        if (isShrunk) {
            bindDragListeners();
            setTimeout(() => {
                document.addEventListener("click", restoreGlobalView);
            }, 50);
        } else {
            document.removeEventListener("click", restoreGlobalView);
            unbindDragListeners();
            resetPanState();
        }
    } catch (err) {
        console.error("[MAERS.Theme] Zoom toggle failed:", err);
        if (window.MAERS?.Toast?.show) {
            window.MAERS.Toast.show('缩放功能异常，请刷新页面', 'error');
        }
    }
}

function setupZoomTriggerGlobal(targetEl, mode, force = false) {
    if (!targetEl) return;
    if (!force && targetEl.classList.contains("js-zoom-ready")) return;

    if (force) {
        const oldTriggers = targetEl.querySelectorAll('.zoom-trigger-icon, .zoom-trigger-whole');
        oldTriggers.forEach(trigger => {
            if (trigger.tagName === 'IMG' || trigger.tagName === 'SVG' || trigger.querySelector('img, svg')) {
                trigger.classList.remove('zoom-trigger-icon', 'zoom-trigger-whole');
                const clone = trigger.cloneNode(true);
                trigger.replaceWith(clone);
            } else {
                trigger.replaceWith(document.createTextNode(trigger.textContent));
            }
        });
        targetEl.classList.remove("js-zoom-ready");
    }

    targetEl.classList.add("js-zoom-ready");

    if (!mode) mode = "icon_only";

    if (mode === "icon_only") {
        if (targetEl.tagName === 'IMG' || targetEl.tagName === 'SVG') {
            targetEl.classList.add('zoom-trigger-icon');
            targetEl.title = ZOOM_TIP;
            targetEl.addEventListener("click", toggleGlobalShrink);
            return;
        }

        const existingIcon = targetEl.querySelector(".title-icon");
        if (existingIcon) {
            existingIcon.classList.add("zoom-trigger-icon");
            existingIcon.title = ZOOM_TIP;
            existingIcon.addEventListener("click", toggleGlobalShrink);
        } else {
            const existingZoomIcon = targetEl.querySelector(".zoom-trigger-icon");
            if (existingZoomIcon) {
                existingZoomIcon.title = ZOOM_TIP;
                existingZoomIcon.addEventListener("click", toggleGlobalShrink);
            } else {
                const firstChild = targetEl.firstElementChild || targetEl.firstChild;

                if (firstChild && firstChild.nodeType === Node.ELEMENT_NODE && (firstChild.tagName === 'IMG' || firstChild.tagName === 'SVG')) {
                    firstChild.classList.add('zoom-trigger-icon');
                    firstChild.title = ZOOM_TIP;
                    firstChild.addEventListener("click", toggleGlobalShrink);
                }
                else if (targetEl.firstChild && targetEl.firstChild.nodeType === Node.TEXT_NODE) {
                    const firstNode = targetEl.firstChild;
                    const text = firstNode.textContent.trim();
                    const match = text.match(/^([\p{Emoji}\S]+)(.*)/u);
                    if (match) {
                        const span = document.createElement('span');
                        span.className = 'zoom-trigger-icon';
                        span.title = ZOOM_TIP;
                        span.textContent = match[1];
                        span.addEventListener("click", toggleGlobalShrink);
                        targetEl.insertBefore(span, firstNode);
                        firstNode.textContent = match[2];
                    } else {
                        targetEl.title = ZOOM_TIP;
                        targetEl.addEventListener("click", toggleGlobalShrink);
                    }
                } else {
                    const text = targetEl.innerText.trim();
                    const match = text.match(/^([\p{Emoji}\S]+)(.*)/u);
                    if (match) {
                        targetEl.innerHTML = `<span class="zoom-trigger-icon" title="${ZOOM_TIP}">${Utils.escapeHtml(match[1])}</span>${Utils.escapeHtml(match[2])}`;
                        targetEl.querySelector(".zoom-trigger-icon").addEventListener("click", toggleGlobalShrink);
                    } else {
                        targetEl.title = ZOOM_TIP;
                        targetEl.addEventListener("click", toggleGlobalShrink);
                    }
                }
            }
        }
    } else {
        targetEl.title = ZOOM_TIP;
        targetEl.addEventListener("click", toggleGlobalShrink);
        targetEl.classList.add("zoom-trigger-whole");
    }
}

export function setupZoomTrigger(el, mode, force) {
    setupZoomTriggerGlobal(el, mode, force);
}

export function initZoomSystem() {
    if (localStorage.getItem("globalZoomState") === "true") {
        document.documentElement.classList.add("shrink-view");

        bindDragListeners();

        setTimeout(() => {
            document.addEventListener("click", restoreGlobalView);
        }, 100);
    }

    const loadConfig = () => {
        const ZOOM_CONFIG = [
            { path: "index.html", selector: "#brand-logo", mode: "whole" },
            { path: "admin-index.html", selector: "#brand-logo", mode: "whole" },
            { path: "", selector: "#brand-logo", mode: "whole" },
            { path: "music.html", selector: ".music-title-icon", mode: "icon_only" },
            { path: "admin-music.html", selector: ".music-title-icon", mode: "icon_only" },
            { path: "*", selector: ".header-title", mode: "icon_only" },
        ];
        return Promise.resolve(ZOOM_CONFIG);
    };

    loadConfig().then((configList) => {
        const currentPath =
            decodeURIComponent(window.location.pathname).split("/").pop() ||
            "index.html";

        let rule = configList.find((r) => r.path === currentPath);
        if (!rule) rule = configList.find((r) => r.path === "*");

        if (!rule || !rule.selector) return;

        const targetEl = document.querySelector(rule.selector);
        if (targetEl) {
            setupZoomTriggerGlobal(targetEl, rule.mode);
        } else {
            const observer = new MutationObserver(() => {
                const el = document.querySelector(rule.selector);
                if (el) {
                    setupZoomTriggerGlobal(el, rule.mode);
                    observer.disconnect();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => observer.disconnect(), AUTO_HIDE_DELAY);
        }
    });
}
