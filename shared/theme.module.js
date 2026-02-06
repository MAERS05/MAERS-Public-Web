/**
 * MAERS Theme Controller (theme.module.js)
 * 主题切换、自动模式、智能缩放系统
 * @version 3.0.0 - ES6 Module (Modularized)
 */

import { applyTheme, checkThemeStrategy, initHomeControls, initThemeCore } from './theme/theme-core.module.js';
import { toggleGlobalShrink, setupZoomTrigger, initZoomSystem } from './theme/theme-zoom.module.js';

/**
 * Main Initialization Function
 */
export function initTheme() {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            _runInitTheme();
        });
    } else {
        _runInitTheme();
    }
}

function _runInitTheme() {
    const path = window.location.pathname;
    const isHome = path.endsWith("index.html") || path.endsWith("admin-index.html") || path.endsWith("/") || path === "";

    // 0. Auto-Inject Drag Styles
    if (!document.querySelector('link[href*="drag.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'static-style/drag.css';

        if (window.location.pathname.includes('/custom/')) {
            link.href = '../../../static-style/drag.css';
        }

        document.head.appendChild(link);
    }

    // 1. Theme Mask
    if (!document.getElementById("theme-mask")) {
        const maskHtml = `<div id="theme-mask"></div>`;
        document.body.insertAdjacentHTML("beforeend", maskHtml);
    }

    // 2. Home Actions
    if (isHome) {
        initHomeControls();
    }

    // 3. Toggle Switch Logic
    initThemeCore();

    // 4. Zoom System
    initZoomSystem();

    // 5. Iframe Click Handling
    document.addEventListener("click", (e) => {
        if (window.parent !== window && window.name === "content-frame") {
            const isInteractive = e.target.closest(
                "a, button, input, .interactive, .theme-switch-wrapper, .auto-mode-btn",
            );
            if (!isInteractive) window.parent.postMessage("closePanel", "*");
        }
    });
    document.documentElement.classList.add("in-iframe");
}

// Backward Compatibility Global Mount
if (typeof window !== 'undefined') {
    window.MAERS = window.MAERS || {};
    window.MAERS.Theme = {
        apply: applyTheme,
        toggleShrink: toggleGlobalShrink,
        setupZoomTrigger: setupZoomTrigger,
        init: initTheme
    };
    window.toggleGlobalShrink = toggleGlobalShrink;
}

// Export for ES6 module usage
export { applyTheme, toggleGlobalShrink, setupZoomTrigger, checkThemeStrategy };
