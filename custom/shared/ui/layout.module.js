/**
 * MAERS Layout Utilities (layout.module.js)
 * 页面布局工具函数
 * @version 2.0.0 - ES6 Module
 */

import { initSpatialNav } from './spatial-nav.module.js';

export function injectThemeSwitch() {
    const path = window.location.pathname;
    // Original check includes checking if it's index.html, but strictly speaking 
    // the original code just checked this boolean but didn't actually use it to guard execution?
    // Let's re-read line 18-20 of layout.js carefully.
    // Line 18: const isHome = ...
    // Line 20: if (document.querySelector('.theme-switch-wrapper')) return;
    // It seems `isHome` was calculated but unused in `injectThemeSwitch`? 
    // Wait, let me check layout.js again.

    if (document.querySelector('.theme-switch-wrapper')) return;

    const html = `
    <div class="theme-switch-wrapper">
        <label class="theme-switch-label" for="checkbox">
            <input type="checkbox" id="checkbox" class="theme-switch-checkbox" />
            <div class="ball"><span id="mode-icon">🌙</span></div>
        </label>
    </div>`;

    document.body.insertAdjacentHTML('afterbegin', html);
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
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            _runInit();
        });
    } else {
        _runInit();
    }
}

function _runInit() {
    injectThemeSwitch();
    // Load Spatial Nav (replaces loadSpatialNav which injected script tag)
    initSpatialNav();
}

// Global Mount Removed
// window.MAERS.Layout = ...
