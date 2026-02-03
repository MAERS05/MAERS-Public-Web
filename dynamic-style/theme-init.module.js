/**
 * MAERS Theme Initializer
 * ES6 Module Version
 * 主题初始化脚本 - 防闪烁、主题检测与应用
 * @version 3.0.0 - ES6 Module
 */

// ---------------------------------------------------------
// 0. 全局防闪烁遮罩 (Global Flash Guard)
// ---------------------------------------------------------
function initFlashGuard() {
    const guardId = 'global-theme-guard-style';
    if (!document.getElementById(guardId)) {
        const css = 'html.js-loading::before { content: ""; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background-color: #141417; z-index: 99999; pointer-events: none; transition: opacity 0.2s ease-out; } html.light-mode.js-loading::before { background-color: #f2f0eb; }';
        const style = document.createElement('style');
        style.id = guardId;
        style.innerHTML = css;
        document.head.appendChild(style);
        document.documentElement.classList.add('js-loading');

        // 兜底：500ms 后强制移除，防止脚本报错导致永久黑屏
        setTimeout(() => {
            document.documentElement.classList.remove('js-loading');
        }, 500);
    }
}

// ---------------------------------------------------------
// 1. 主题检测与应用 (Theme Detection)
// ---------------------------------------------------------
function applyInitialTheme() {
    try {
        let isDark = true; // 默认深色
        const savedTheme = localStorage.getItem('theme');
        const config = JSON.parse(localStorage.getItem('autoThemeConfig')) || { enabled: false };

        if (config.enabled) {
            const now = new Date();
            const mins = now.getHours() * 60 + now.getMinutes();
            // 默认早7晚7
            const d = (config.dayTime || "07:00").split(':');
            const n = (config.nightTime || "19:00").split(':');
            const s = parseInt(d[0]) * 60 + parseInt(d[1]);
            const e = parseInt(n[0]) * 60 + parseInt(n[1]);
            if (mins >= s && mins < e) isDark = false;
        } else if (savedTheme === 'light-mode') {
            isDark = false;
        } else if (!savedTheme && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
            isDark = false;
        }

        // 应用主题
        if (isDark) {
            document.documentElement.classList.remove('light-mode');
        } else {
            document.documentElement.classList.add('light-mode');
        }

        // 背景色强制设置作为兜底
        const bgColor = isDark ? '#0a0a0a' : '#ffffff';
        const textColor = isDark ? '#e0e0e0' : '#1a1a1a';
        document.documentElement.style.backgroundColor = bgColor;
        document.documentElement.style.color = textColor;

    } catch (e) {
        // 出错默认深色
        document.documentElement.style.backgroundColor = '#0a0a0a';
        document.documentElement.style.color = '#e0e0e0';
    }
}

// ---------------------------------------------------------
// 2. 缩放状态恢复 (Zoom Restoration)
// ---------------------------------------------------------
function restoreZoomState() {
    try {
        if (localStorage.getItem('globalZoomState') === 'true') {
            document.documentElement.classList.add('shrink-view');
        }
    } catch (e) { }
}

// ---------------------------------------------------------
// 3. 图标注入 (Favicon)
// ---------------------------------------------------------
function injectFavicon() {
    try {
        if (!document.querySelector("link[rel*='icon']")) {
            const link = document.createElement('link');
            link.type = 'image/svg+xml';
            link.rel = 'icon';
            link.href = 'ui/icon.svg';
            document.getElementsByTagName('head')[0].appendChild(link);
        }
    } catch (e) { }
}

// ---------------------------------------------------------
// 4. 解除遮罩 (Remove Guard)
// ---------------------------------------------------------
function removeGuard() {
    // 1. 移除全局伪元素遮罩
    document.documentElement.classList.remove('js-loading');

    // 2. [Index Special] 移除首页硬编码的 DOM 遮罩 (#flash-guard)
    const legacyGuard = document.getElementById('flash-guard');
    if (legacyGuard) {
        legacyGuard.style.opacity = '0';
        setTimeout(() => {
            legacyGuard.remove();
            // 首页特效：遮罩消失后，强制 body 透明 (配合 CSS)
            document.body.style.setProperty('background-color', 'transparent', 'important');
        }, 200);
    }
}

// ---------------------------------------------------------
// 初始化执行
// ---------------------------------------------------------
function init() {
    initFlashGuard();
    applyInitialTheme();
    restoreZoomState();
    injectFavicon();

    // 解除遮罩
    if (document.readyState === 'interactive' || document.readyState === 'complete') {
        setTimeout(removeGuard, 100);
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(removeGuard, 100);
        });
    }
}

// 自动执行
init();

// 导出函数供外部使用
export {
    initFlashGuard,
    applyInitialTheme,
    restoreZoomState,
    injectFavicon,
    removeGuard,
    init
};

export default { init, applyInitialTheme, removeGuard };
