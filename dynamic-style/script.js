/**
 * MAERS Theme Controller (script.js)
 * 主题切换、自动模式、智能缩放系统
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.Theme = MAERS.Theme || {};

    document.addEventListener('DOMContentLoaded', () => {
        const path = window.location.pathname;
        const isHome = path.endsWith('index.html') || path.endsWith('/') || path === '';

        // 版本管理与安全加载
        const CONFIG_VERSION = 2;
        const DEFAULT_CONFIG = {
            version: CONFIG_VERSION,
            mode: 'system',  // 'system', 'auto', 'manual'
            dayTime: '07:00',
            nightTime: '19:00'
        };

        function safeLoadConfig() {
            try {
                const raw = localStorage.getItem('autoThemeConfig');
                if (!raw) return { ...DEFAULT_CONFIG };

                const data = JSON.parse(raw);

                if (!data.version || data.version < CONFIG_VERSION) {
                    console.log('[MAERS.Theme] Migrating config to version', CONFIG_VERSION);
                    // 迁移旧配置: enabled -> mode
                    let mode = 'system';
                    if (data.enabled === true) mode = 'auto';
                    else if (data.enabled === false) mode = 'manual';
                    const migrated = { ...DEFAULT_CONFIG, ...data, mode, version: CONFIG_VERSION };
                    delete migrated.enabled;
                    localStorage.setItem('autoThemeConfig', JSON.stringify(migrated));
                    return migrated;
                }
                return data;
            } catch (e) {
                console.warn('[MAERS.Theme] Config corrupted, resetting to defaults.');
                return { ...DEFAULT_CONFIG };
            }
        }

        let config = safeLoadConfig();

        // 注入遮罩层
        if (!document.getElementById('theme-mask')) {
            const maskHtml = `<div id="theme-mask"></div>`;
            document.body.insertAdjacentHTML('beforeend', maskHtml);
        }

        // 首页 S/A/M 按钮逻辑
        if (isHome) {
            const getModeLabel = (mode) => {
                if (mode === 'system') return 'S';
                if (mode === 'auto') return 'A';
                return 'M';
            };


            const autoControlHtml = `
                <div class="auto-mode-btn ${config.mode !== 'manual' ? 'active' : ''}" id="auto-btn" title="左键切换 / 右键设置">
                    ${getModeLabel(config.mode)}
                </div>
                
                <div class="auto-settings-popover" id="auto-popover">
                    <div class="popover-header">
                        <span>⚙️ 自动切换</span>
                        <div class="save-trigger" id="save-trigger" title="点击保存">
                            <span class="save-icon"></span>
                        </div>
                    </div>
                    <div class="setting-row"><span>☀️ 日出:</span><input type="time" id="day-start"></div>
                    <div class="setting-row"><span>🌙 日落:</span><input type="time" id="night-start"></div>
                </div>`;

            if (!document.getElementById('auto-btn')) {
                document.body.insertAdjacentHTML('afterbegin', autoControlHtml);
            }

            const autoBtn = document.getElementById('auto-btn');
            const popover = document.getElementById('auto-popover');
            const dayInput = document.getElementById('day-start');
            const nightInput = document.getElementById('night-start');
            const saveTrigger = document.getElementById('save-trigger');

            if (dayInput) dayInput.value = config.dayTime;
            if (nightInput) nightInput.value = config.nightTime;

            if (autoBtn) {
                autoBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // 循环切换: S -> A -> M -> S
                    if (config.mode === 'system') config.mode = 'auto';
                    else if (config.mode === 'auto') config.mode = 'manual';
                    else config.mode = 'system';

                    autoBtn.textContent = getModeLabel(config.mode);
                    autoBtn.classList.toggle('active', config.mode !== 'manual');
                    localStorage.setItem('autoThemeConfig', JSON.stringify(config));

                    if (config.mode !== 'manual') {
                        localStorage.removeItem('theme');
                    }
                    checkThemeStrategy();
                });

                autoBtn.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    popover.classList.toggle('show');
                });
            }

            if (saveTrigger) {
                saveTrigger.addEventListener('click', (e) => {
                    e.stopPropagation();
                    config.dayTime = dayInput.value;
                    config.nightTime = nightInput.value;
                    localStorage.setItem('autoThemeConfig', JSON.stringify(config));
                    saveTrigger.classList.add('active');
                    setTimeout(() => { saveTrigger.classList.remove('active'); }, 1000);
                    if (config.mode === 'auto') checkThemeStrategy();
                });
            }

            document.addEventListener('click', (e) => {
                if (popover && !popover.contains(e.target) && e.target !== autoBtn)
                    popover.classList.remove('show');
            });
        }

        // 主题切换核心
        const toggleSwitch = document.querySelector('.theme-switch-checkbox');
        const modeIcon = document.getElementById('mode-icon');

        function applyTheme(theme) {
            try {
                requestAnimationFrame(() => {
                    const isDark = (theme === 'dark-mode');

                    if (isDark) {
                        document.documentElement.classList.remove('light-mode');
                    } else {
                        document.documentElement.classList.add('light-mode');
                    }

                    if (toggleSwitch) toggleSwitch.checked = isDark;
                    if (modeIcon) modeIcon.innerText = isDark ? "🌙" : "☀️";

                    localStorage.setItem('theme', theme);
                });
            } catch (err) {
                console.error("[MAERS.Theme] Theme switch failed:", err);
            }
        }

        // Expose to namespace
        MAERS.Theme.apply = applyTheme;

        if (toggleSwitch) {
            const saved = localStorage.getItem('theme');
            toggleSwitch.checked = (saved === 'dark-mode' || !saved);
            if (modeIcon) modeIcon.innerText = toggleSwitch.checked ? "🌙" : "☀️";

            toggleSwitch.addEventListener('change', (e) => {
                if (config.mode !== 'manual') {
                    config.mode = 'manual';
                    localStorage.setItem('autoThemeConfig', JSON.stringify(config));
                    const btn = document.getElementById('auto-btn');
                    if (btn) {
                        btn.textContent = 'M';
                        btn.classList.remove('active');
                    }
                }
                const target = e.target.checked ? 'dark-mode' : 'light-mode';
                applyTheme(target);
            });
        }

        // 主题策略
        function checkThemeStrategy() {
            if (config.mode === 'system') {
                // 跟随系统
                const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                applyTheme(prefersDark ? 'dark-mode' : 'light-mode');
            } else if (config.mode === 'auto') {
                // 时间自动切换
                const now = new Date();
                const mins = now.getHours() * 60 + now.getMinutes();
                const [dh, dm] = config.dayTime.split(':');
                const [nh, nm] = config.nightTime.split(':');
                const start = parseInt(dh) * 60 + parseInt(dm);
                const end = parseInt(nh) * 60 + parseInt(nm);

                const isDay = (mins >= start && mins < end);
                applyTheme(isDay ? 'light-mode' : 'dark-mode');
            } else {
                // 手动模式
                const saved = localStorage.getItem('theme');
                if (saved) applyTheme(saved);
                else applyTheme('dark-mode');
            }
        }
        checkThemeStrategy();

        // 监听系统主题变化
        if (window.matchMedia) {
            const systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
            systemThemeMedia.addEventListener('change', () => {
                if (config.mode === 'system') {
                    checkThemeStrategy();
                }
            });
        }

        // 智能缩放系统
        (function initZoomSystem() {
            if (localStorage.getItem('globalZoomState') === 'true') {
                document.documentElement.classList.add('shrink-view');
                setTimeout(() => { document.addEventListener('click', restoreGlobalView); }, 100);
            }

            const loadConfig = () => {
                if (!MAERS.Theme.ZOOM_CONFIG) {
                    const isBackEnd = window.location.pathname.includes('admin');
                    const defaultMode = isBackEnd ? 'whole' : 'icon_only';
                    MAERS.Theme.ZOOM_CONFIG = [{ path: '*', selector: '.header-title', mode: defaultMode }];
                }
                return Promise.resolve();
            };

            function toggleGlobalShrink(e) {
                try {
                    if (e) { e.stopPropagation(); e.preventDefault(); }
                    const isShrunk = document.documentElement.classList.toggle('shrink-view');
                    localStorage.setItem('globalZoomState', isShrunk);

                    if (isShrunk) {
                        setTimeout(() => { document.addEventListener('click', restoreGlobalView); }, 50);
                    } else {
                        document.removeEventListener('click', restoreGlobalView);
                    }
                } catch (err) {
                    console.error("[MAERS.Theme] Zoom toggle failed:", err);
                }
            }

            MAERS.Theme.toggleShrink = toggleGlobalShrink;

            function restoreGlobalView(e) {
                const t = e.target;
                if (t.closest('.zoom-trigger-icon') || t.closest('.zoom-trigger-whole')) return;
                if (t.closest('.main-card') || t.closest('.nav-card') || t.closest('.brand-area')) return;
                if (t.closest('.theme-switch-wrapper') || t.closest('.auto-mode-btn') || t.closest('.lightbox')) return;

                document.documentElement.classList.remove('shrink-view');
                document.removeEventListener('click', restoreGlobalView);
                localStorage.setItem('globalZoomState', 'false');
            }

            loadConfig().then(() => {
                const configList = MAERS.Theme.ZOOM_CONFIG || [];
                const currentPath = decodeURIComponent(window.location.pathname).split('/').pop() || 'index.html';

                let rule = configList.find(r => r.path === currentPath);
                if (!rule) rule = configList.find(r => r.path === '*');

                if (!rule || !rule.selector) return;

                let checkCount = 0;
                const checker = setInterval(() => {
                    checkCount++;
                    const targetEl = document.querySelector(rule.selector);

                    if (targetEl && !targetEl.classList.contains('js-zoom-ready')) {
                        targetEl.classList.add('js-zoom-ready');

                        if (rule.mode === 'icon_only') {
                            const existingIcon = targetEl.querySelector('.title-icon');
                            if (existingIcon) {
                                existingIcon.classList.add('zoom-trigger-icon');
                                existingIcon.addEventListener('click', toggleGlobalShrink);
                            } else {
                                const text = targetEl.innerText.trim();
                                const match = text.match(/^([\p{Emoji}\S]+)(.*)/u);
                                if (match) {
                                    targetEl.innerHTML = `<span class="zoom-trigger-icon">${match[1]}</span>${match[2]}`;
                                    targetEl.querySelector('.zoom-trigger-icon').addEventListener('click', toggleGlobalShrink);
                                } else {
                                    targetEl.addEventListener('click', toggleGlobalShrink);
                                }
                            }
                        } else {
                            targetEl.addEventListener('click', toggleGlobalShrink);
                            targetEl.classList.add('zoom-trigger-whole');
                        }
                    }
                    if (checkCount > 20) clearInterval(checker);
                }, 200);
            });
        })();

    });

    // Iframe 点击穿透处理
    document.addEventListener('click', (e) => {
        if (window.parent !== window && window.name === 'content-frame') {
            const isInteractive = e.target.closest('a, button, input, .interactive, .theme-switch-wrapper, .auto-mode-btn');
            if (!isInteractive) window.parent.postMessage('closePanel', '*');
        }
    });
    if (window.parent !== window) document.documentElement.classList.add('in-iframe');

    // 🔧 全局函数包装器已移除
    // global.toggleGlobalShrink = (e) => MAERS.Theme && MAERS.Theme.toggleShrink(e);

})(typeof window !== 'undefined' ? window : this);
