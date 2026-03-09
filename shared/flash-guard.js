(function () {
    // ---------------------------------------------------------
    // 0. 全局防闪烁遮罩 (Global Flash Guard)
    // ---------------------------------------------------------
    // 逻辑：立即注入一个全屏遮罩样式，在页面判定完成后移除
    // 这样所有引入此脚本的页面都能拥有 index.html 同款的无闪烁体验
    var guardId = 'global-theme-guard-style';
    if (!document.getElementById(guardId)) {
        var css = 'html.js-loading::before { content: ""; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background-color: #141417; z-index: 99999; pointer-events: none; transition: opacity 0.2s ease-out; } html.light-mode.js-loading::before { background-color: #f2f0eb; }';
        var style = document.createElement('style');
        style.id = guardId;
        style.innerHTML = css;
        document.head.appendChild(style);
        document.documentElement.classList.add('js-loading');

        // 兜底：500ms 后强制移除，防止脚本报错导致永久黑屏
        setTimeout(function () {
            document.documentElement.classList.remove('js-loading');
        }, 500);
    }

    // ---------------------------------------------------------
    // 1. 主题检测与应用 (Theme Detection)
    // ---------------------------------------------------------
    // 逻辑完全复刻自 theme.module.js (v2.0)
    try {
        var isDark = true; // 默认深色
        var savedTheme = localStorage.getItem('theme');
        var rawConfig = localStorage.getItem('autoThemeConfig');
        var config = rawConfig ? JSON.parse(rawConfig) : { mode: 'system' };

        // 兼容旧版本配置（enabled -> mode）
        if (config.enabled !== undefined && !config.mode) {
            config.mode = config.enabled ? 'auto' : 'manual';
        }
        if (!config.mode) config.mode = 'system';

        // 根据模式决定主题
        if (config.mode === 'system') {
            // 系统模式：跟随系统偏好
            if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                isDark = true;
            } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
                isDark = false;
            }
        } else if (config.mode === 'auto') {
            // 自动模式：根据时间判断
            var now = new Date();
            var mins = now.getHours() * 60 + now.getMinutes();
            var d = (config.dayTime || "07:00").split(':');
            var n = (config.nightTime || "19:00").split(':');
            var s = parseInt(d[0]) * 60 + parseInt(d[1]);
            var e = parseInt(n[0]) * 60 + parseInt(n[1]);
            isDark = !(mins >= s && mins < e);
        } else {
            // 手动模式：使用保存的主题
            if (savedTheme === 'light-mode') {
                isDark = false;
            } else if (savedTheme === 'dark-mode') {
                isDark = true;
            }
            // 如果没有保存的主题，保持默认 isDark = true
        }

        // 应用主题 - 确保先移除再添加，避免状态残留
        document.documentElement.classList.remove('light-mode');
        if (!isDark) {
            document.documentElement.classList.add('light-mode');
        }

        // [Fallout Sync] 
        // 这里的背景色强制设置保留作为非遮罩区域的兜底
        // 但为了避免与遮罩冲突，延后执行或仅作为底色修正
        var bgColor = isDark ? '#0a0a0a' : '#ffffff';
        var textColor = isDark ? '#e0e0e0' : '#1a1a1a';
        document.documentElement.style.backgroundColor = bgColor;
        document.documentElement.style.color = textColor;

    } catch (e) {
        // 出错默认深色
        document.documentElement.style.backgroundColor = '#0a0a0a';
        document.documentElement.style.color = '#e0e0e0';
    }

    // ---------------------------------------------------------
    // 2. 缩放状态恢复 (Zoom Restoration)
    // ---------------------------------------------------------
    try {
        if (localStorage.getItem('globalZoomState') === 'true') {
            document.documentElement.classList.add('shrink-view');
        }
    } catch (e) { }

    // ---------------------------------------------------------
    // 3. 图标注入 (Favicon)
    // ---------------------------------------------------------
    try {
        if (!document.querySelector("link[rel*='icon']")) {
            var link = document.createElement('link');
            link.type = 'image/svg+xml';
            link.rel = 'icon';
            link.href = 'ui/logo.svg';
            document.getElementsByTagName('head')[0].appendChild(link);
        }
    } catch (e) { }

    // ---------------------------------------------------------
    // 4. 解除遮罩 (Remove Guard)
    // ---------------------------------------------------------
    // 页面内容基本就绪后移除遮罩
    function removeGuard() {
        // 1. 移除全局伪元素遮罩
        document.documentElement.classList.remove('js-loading');

        // 2. [Critical Fix] 清除内联兜底样式
        // 必须移除 flash-guard 设置的 background-color/color，否则会死锁内联样式
        // 导致 theme.css 的变量无法生效（特别是切换到 Light Mode 时背景卡在黑色）
        document.documentElement.style.removeProperty('background-color');
        document.documentElement.style.removeProperty('color');

        // 3. [Index Special] 移除首页硬编码的 DOM 遮罩 (#flash-guard)
        // 必须与 index.html 原有逻辑保持一致（透明 -> 移除）
        var legacyGuard = document.getElementById('flash-guard');
        if (legacyGuard) {
            legacyGuard.style.opacity = '0';
            setTimeout(function () {
                legacyGuard.remove();
                // 首页特效：遮罩消失后，强制 body 透明 (配合 CSS)
                document.body.style.setProperty('background-color', 'transparent', 'important');
            }, 200);
        }
    }

    // 如果是 DOMContentLoaded 之后才执行此脚本，立即移除
    if (document.readyState === 'interactive' || document.readyState === 'complete') {
        setTimeout(removeGuard, 100);
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(removeGuard, 100);
        });
    }

    // 4. [New] Register Service Worker for Cache Busting
    if ('serviceWorker' in navigator) {
        // 延迟注册，避免影响首屏关键资源加载
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/maers-version-controller.js').then(registration => {
                // console.log('SW registered:', registration);

                // 检测是否是从旧版 SW 更新过来的
                registration.onupdatefound = () => {
                    const installingWorker = registration.installing;
                    installingWorker.onstatechange = () => {
                        if (installingWorker.state === 'installed') {
                            if (navigator.serviceWorker.controller) {
                                // 新版本已就绪，可以在这里提示用户刷新，或者自动刷新
                                console.log('[MAERS] New version available.');
                            }
                        }
                    };
                };
            }).catch(error => {
                console.log('SW registration failed:', error);
            });
        });
    }

})();
