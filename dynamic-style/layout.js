/**
 * MAERS Layout Utilities (layout.js)
 * 页面布局工具函数
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};

    document.addEventListener("DOMContentLoaded", () => { injectThemeSwitch(); });

    function injectThemeSwitch() {
        const path = window.location.pathname;
        const isHome = path.endsWith('index.html') || path.endsWith('index.html') || path.endsWith('/') || path === '';

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

    function renderPageHeader(title, backUrl = "index.html", backText = "Back to Home") {
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

    // Mount to namespace
    MAERS.Layout = {
        injectThemeSwitch,
        renderPageHeader
    };

})(typeof window !== 'undefined' ? window : this);
