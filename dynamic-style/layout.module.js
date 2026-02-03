/**
 * MAERS Layout Utilities
 * ES6 Module Version
 * 页面布局工具函数
 * @version 3.0.0 - ES6 Module
 */

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

function loadSpatialNav() {
    if (document.querySelector('script[src*="spatial-nav"]')) return;
    const script = document.createElement('script');
    script.src = 'dynamic-style/spatial-nav.module.js';
    script.type = 'module';
    script.defer = true;
    document.body.appendChild(script);
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

// 自动初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        injectThemeSwitch();
        loadSpatialNav();
    });
} else {
    injectThemeSwitch();
    loadSpatialNav();
}

// 挂载到全局命名空间（向后兼容）
if (typeof window !== 'undefined') {
    window.MAERS = window.MAERS || {};
    window.MAERS.Layout = {
        injectThemeSwitch,
        renderPageHeader
    };
}

// 导出
export {
    injectThemeSwitch,
    loadSpatialNav,
    renderPageHeader
};

export default {
    injectThemeSwitch,
    renderPageHeader
};
