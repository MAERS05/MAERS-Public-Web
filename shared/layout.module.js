/**
 * MAERS Layout Utilities (layout.module.js)
 * 页面布局工具函数
 * @version 2.0.0 - ES6 Module
 */

import { initSpatialNav } from './spatial-nav.module.js';
import { guardCurrentPage } from '../data-manage/encrypt/secret-unlock.module.js';

export function injectThemeSwitch() {
    if (document.querySelector('.theme-switch-wrapper')) return;

    const html = `
    <div class="theme-switch-wrapper">
        <label class="theme-switch-label" for="checkbox">
            <input type="checkbox" id="checkbox" class="theme-switch-checkbox" ${document.documentElement.classList.contains('light-mode') ? '' : 'checked'} />
            <div class="ball">
                <img id="mode-icon" src="ui/moon.svg" alt="" aria-hidden="true" />
                <img class="mode-icon-sun" src="ui/sun.svg" alt="" aria-hidden="true" />
            </div>
        </label>
    </div>`;

    document.body.insertAdjacentHTML('afterbegin', html);
}

export function injectImmersiveBackground() {
    if (document.getElementById('immersive-bg')) return;
    const bg = document.createElement('div');
    bg.id = 'immersive-bg';
    bg.className = 'immersive-bg';

    // Two layers for cross-fade. Each has a blur layer + a clear contain layer.
    ['a', 'b'].forEach(id => {
        const layer = document.createElement('div');
        layer.id = `imm-layer-${id}`;
        layer.className = 'imm-layer';

        // Bottom: blurred cover (fills screen, hides letterboxing)
        const blur = document.createElement('div');
        blur.className = 'imm-blur';

        // Top: crisp contain (full image, correct aspect ratio, centered)
        const clear = document.createElement('div');
        clear.className = 'imm-clear';

        layer.appendChild(blur);
        layer.appendChild(clear);
        bg.appendChild(layer);
    });

    document.body.insertAdjacentElement('afterbegin', bg);
}

function _runInit() {
    injectThemeSwitch();
    injectImmersiveBackground();
    // Load Spatial Nav (replaces loadSpatialNav which injected script tag)
    initSpatialNav();
}

export function renderPageHeader(title, backUrl = "index.html", backText = "Back to Home") {
    if (document.querySelector('.page-header-bar')) return;
    const currentMode = new URLSearchParams(window.location.search).get('mode');
    const separator = backUrl.includes('?') ? '&' : '?';
    const finalBackUrl = currentMode ? `${backUrl}${separator}mode=${currentMode}` : backUrl;
    const headerHtml = `
    <div class="page-header-bar">
        <a href="${finalBackUrl}" class="back-btn">← ${backText}</a>
        <div class="header-title">${title}</div>
        <div style="width:80px"></div>
    </div>`;

    const mainCard = document.querySelector('.main-card');
    if (mainCard) { mainCard.insertAdjacentHTML('afterbegin', headerHtml); }
}

/**
 * Main Initialization Function
 * Replaces the DOMContentLoaded listener in original layout.js
 */
export function initLayout() {
    guardCurrentPage(); // 首页卡片已加锁的页面，未解锁访客直接访问时显示 404
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            _runInit();
        });
    } else {
        _runInit();
    }
}

// Global Mount Removed
// window.MAERS.Layout = ...
