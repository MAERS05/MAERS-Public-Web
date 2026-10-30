/**
 * MAERS Flash Guard - 关键渲染路径同步脚本
 *
 * 职责：
 *   0. 首页解析完成即显示；其他页面等待 DOM 与页面守卫就绪，避免重复揭示；
 *   1. 在首帧前应用深/浅色主题（逻辑与 theme.module.js 保持一致）；
 *   2. 恢复全局缩放状态；
 *   3. 注入 favicon、PWA manifest / meta 与离线下载脚本；
 *   4. 注册 Service Worker 版本控制器。
 *
 * 注意：本文件以经典脚本同步加载（非 ES 模块），须放在 <head> 最前，禁止引入任何依赖。
 */
(function () {
    const root = document.documentElement;

    // 只有明确标记的公开首页可以提前显示，受守卫保护的页面仍等待模块完成检查。
    const earlyHome = root.dataset?.earlyRender === 'home';
    let domReady = earlyHome ? document.readyState !== 'loading' : document.readyState === 'complete';
    let pageGuardPending = false;
    const guardId = 'global-theme-guard-style';
    if (!document.getElementById(guardId)) {
        const style = document.createElement('style');
        style.id = guardId;
        style.textContent = 'html.js-loading body { visibility: hidden; } html.js-loading, html.js-loading *, html.js-loading *::before, html.js-loading *::after { transition: none !important; }';
        document.head.appendChild(style);
        root.classList.add('js-loading');
    }
    document.addEventListener('maers:page-guard-start', () => { pageGuardPending = true; });
    document.addEventListener('maers:page-guard-ready', () => {
        pageGuardPending = false;
        revealPage();
    });

    // ---------------------------------------------------------
    // 1. 主题检测与应用 (Theme Detection)
    // ---------------------------------------------------------
    /** 将 "HH:MM" 转为当日分钟数 */
    const toMinutes = (text) => {
        const [h, m] = text.split(':');
        return parseInt(h, 10) * 60 + parseInt(m, 10);
    };

    /** 按 system / auto / manual 三种模式判定是否深色（默认深色） */
    const resolveIsDark = () => {
        const rawConfig = localStorage.getItem('autoThemeConfig');
        const config = rawConfig ? JSON.parse(rawConfig) : { mode: 'system' };
        const mode = ['system', 'auto', 'manual'].includes(config.mode) ? config.mode
            : config.enabled === true ? 'auto' : config.enabled === false ? 'manual' : 'system';

        if (mode === 'system') {
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return false;
            return true;
        }
        if (mode === 'auto') {
            const now = new Date();
            const mins = now.getHours() * 60 + now.getMinutes();
            const dayStart = toMinutes(config.dayTime || '07:00');
            const nightStart = toMinutes(config.nightTime || '19:00');
            return !(mins >= dayStart && mins < nightStart);
        }
        return localStorage.getItem('theme') !== 'light-mode';
    };

    try {
        const isDark = resolveIsDark();
        // 先移除再添加，避免状态残留
        root.classList.toggle('light-mode', !isDark);

        // 首帧底色与主题变量保持一致，揭示正文时清除
        root.style.backgroundColor = isDark ? '#0a0a0c' : '#ffffff';
        root.style.color = isDark ? '#f0f0f2' : '#333330';
    } catch (err) {
        // 出错默认深色
        root.style.backgroundColor = '#0a0a0c';
        root.style.color = '#e0e0e0';
    }

    // ---------------------------------------------------------
    // 2. 缩放状态恢复 (Zoom Restoration)
    // ---------------------------------------------------------
    try {
        if (localStorage.getItem('globalZoomState') === 'true') {
            root.classList.add('shrink-view');
        }
    } catch (err) { /* 隐私模式下 localStorage 不可用，忽略 */ }

    // ---------------------------------------------------------
    // 3. 图标 / PWA / 离线下载脚本注入
    // ---------------------------------------------------------
    /** 若 selector 不存在则创建并追加到 <head> */
    const ensureHeadElement = (selector, tag, attrs) => {
        if (document.querySelector(selector)) return;
        const el = document.createElement(tag);
        Object.assign(el, attrs);
        document.head.appendChild(el);
    };

    try {
        ensureHeadElement("link[rel*='icon']", 'link', { type: 'image/svg+xml', rel: 'icon', href: 'ui/logo.svg' });
        ensureHeadElement('link[rel="manifest"]', 'link', { rel: 'manifest', href: '/manifest.json' });
        ensureHeadElement('meta[name="theme-color"]', 'meta', { name: 'theme-color', content: '#0a0a0a' });
        ensureHeadElement('link[rel="apple-touch-icon"]', 'link', { rel: 'apple-touch-icon', href: '/ui/logo.svg' });

        const loadOfflinePanel = () => {
            const offlineScript = document.createElement('script');
            offlineScript.src = '/custom/zmobile localization/offline-download.js';
            document.head.appendChild(offlineScript);
        };
        // 离线下载入口仅挂载到前台首页，等首屏资源完成后再加载。
        if (earlyHome) {
            if (document.readyState !== 'complete') {
                window.addEventListener('load', loadOfflinePanel, { once: true });
            } else loadOfflinePanel();
        }
    } catch (err) { /* 注入失败不影响页面主体 */ }

    // DOM 与守卫都完成后直接显示正文，不叠加全屏遮罩或延迟淡出。
    function revealPage() {
        if (!domReady || pageGuardPending) return;
        root.classList.remove('js-loading');
        root.style.removeProperty('background-color');
        root.style.removeProperty('color');
    }
    if (domReady) revealPage();
    if (earlyHome && !domReady) document.addEventListener('readystatechange', () => {
        if (document.readyState === 'loading') return;
        domReady = true;
        revealPage();
    });
    document.addEventListener('DOMContentLoaded', () => {
        domReady = true;
        revealPage();
    }, { once: true });

    // ---------------------------------------------------------
    // 5. 注册 Service Worker（缓存穿透版本控制）
    // ---------------------------------------------------------
    if ('serviceWorker' in navigator) {
        // 延迟到 load 后注册，避免影响首屏关键资源加载
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/maers-version-controller.js').then((registration) => {
                registration.onupdatefound = () => {
                    const installingWorker = registration.installing;
                    installingWorker.onstatechange = () => {
                        if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            console.info('[MAERS] New version available.');
                        }
                    };
                };
            }).catch((error) => {
                console.warn('[MAERS] SW registration failed:', error);
            });
        });
    }
})();
