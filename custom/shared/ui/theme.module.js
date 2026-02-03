/**
 * MAERS Theme Controller (theme.module.js)
 * 主题切换、自动模式、智能缩放系统
 * Based on original script.js
 * @version 2.0.0 - ES6 Module
 */

import { Utils } from '../../../shared/utils.module.js';

// 共享主题状态
const themeState = {
    mode: 'auto', // 'auto', 'light', 'dark'
    autoStartHour: 18,
    autoEndHour: 6,
    manualOverride: false
};

const AUTO_HIDE_DELAY = 5000;

const CONFIG_VERSION = 2;
const DEFAULT_CONFIG = {
    version: CONFIG_VERSION,
    mode: "system", // 'system', 'auto', 'manual'
    dayTime: "07:00",
    nightTime: "19:00",
};

let config = safeLoadConfig();

function safeLoadConfig() {
    try {
        const raw = localStorage.getItem("autoThemeConfig");
        if (!raw) return { ...DEFAULT_CONFIG };

        const data = JSON.parse(raw);

        if (!data.version || data.version < CONFIG_VERSION) {
            // 迁移旧配置: enabled -> mode
            let mode = "system";
            if (data.enabled === true) mode = "auto";
            else if (data.enabled === false) mode = "manual";
            const migrated = {
                ...DEFAULT_CONFIG,
                ...data,
                mode,
                version: CONFIG_VERSION,
            };
            delete migrated.enabled;
            localStorage.setItem("autoThemeConfig", JSON.stringify(migrated));
            return migrated;
        }
        return data;
    } catch (e) {
        console.warn("[MAERS.Theme] Config corrupted, resetting to defaults.");
        return { ...DEFAULT_CONFIG };
    }
}

export function applyTheme(theme) {
    try {
        requestAnimationFrame(() => {
            const isDark = theme === "dark-mode";

            // 先完全移除 light-mode class，确保状态干净
            // CSS 默认样式就是黑夜模式，所以不需要 dark-mode class
            document.documentElement.classList.remove("light-mode");

            // 重要：清除 flash-guard.js 设置的内联样式，否则 CSS 背景色会被覆盖且无法切换
            document.documentElement.style.removeProperty("background-color");
            document.documentElement.style.removeProperty("color");

            // 只在白昼模式时添加 light-mode class
            if (!isDark) {
                document.documentElement.classList.add("light-mode");
            }

            const toggleSwitch = document.querySelector(".theme-switch-checkbox");
            const modeIcon = document.getElementById("mode-icon");

            if (toggleSwitch) toggleSwitch.checked = isDark;
            if (modeIcon) modeIcon.innerText = isDark ? "🌙" : "☀️";

            localStorage.setItem("theme", theme);
        });
    } catch (err) {
        console.error("[MAERS.Theme] Theme switch failed:", err);
        // 向用户显示友好提示
        if (window.MAERS?.Toast?.show) {
            window.MAERS.Toast.show('主题切换失败，请刷新页面重试', 'error');
        }
    }
}

export function checkThemeStrategy() {
    if (config.mode === "system") {
        const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        applyTheme(prefersDark ? "dark-mode" : "light-mode");
    } else if (config.mode === "auto") {
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        const [dh, dm] = config.dayTime.split(":");
        const [nh, nm] = config.nightTime.split(":");
        const start = parseInt(dh) * 60 + parseInt(dm);
        const end = parseInt(nh) * 60 + parseInt(nm);

        const isDay = mins >= start && mins < end;
        applyTheme(isDay ? "light-mode" : "dark-mode");
    } else {
        const saved = localStorage.getItem("theme");
        if (saved) applyTheme(saved);
        else applyTheme("dark-mode");
    }
}

function restoreGlobalView(e) {
    const t = e.target;
    if (t.closest(".zoom-trigger-icon") || t.closest(".zoom-trigger-whole"))
        return;
    if (
        t.closest(".main-card") ||
        t.closest(".nav-card") ||
        t.closest(".brand-area")
    )
        return;
    if (
        t.closest(".theme-switch-wrapper") ||
        t.closest(".auto-mode-btn") ||
        t.closest(".mode-text-btn") ||
        t.closest(".lightbox")
    )
        return;

    document.documentElement.classList.remove("shrink-view");
    document.removeEventListener("click", restoreGlobalView);
    localStorage.setItem("globalZoomState", "false");
}

export function toggleGlobalShrink(e) {
    try {
        if (e) {
            e.stopPropagation();
            e.preventDefault();
        }
        const isShrunk =
            document.documentElement.classList.toggle("shrink-view");
        localStorage.setItem("globalZoomState", isShrunk);

        if (isShrunk) {
            setTimeout(() => {
                document.addEventListener("click", restoreGlobalView);
            }, 50);
        } else {
            document.removeEventListener("click", restoreGlobalView);
        }
    } catch (err) {
        console.error("[MAERS.Theme] Zoom toggle failed:", err);
        // 向用户显示友好提示
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
            trigger.replaceWith(document.createTextNode(trigger.textContent));
        });
        targetEl.classList.remove("js-zoom-ready");
    }

    targetEl.classList.add("js-zoom-ready");

    if (!mode) mode = "icon_only";

    if (mode === "icon_only") {
        const existingIcon = targetEl.querySelector(".title-icon");
        if (existingIcon) {
            existingIcon.classList.add("zoom-trigger-icon");
            existingIcon.addEventListener("click", toggleGlobalShrink);
        } else {
            const existingZoomIcon = targetEl.querySelector(".zoom-trigger-icon");
            if (existingZoomIcon) {
                existingZoomIcon.addEventListener("click", toggleGlobalShrink);
            } else {
                const firstChild = targetEl.firstChild;
                if (firstChild && firstChild.nodeType === Node.TEXT_NODE) {
                    const text = firstChild.textContent.trim();
                    const match = text.match(/^([\p{Emoji}\S]+)(.*)/u);
                    if (match) {
                        const span = document.createElement('span');
                        span.className = 'zoom-trigger-icon';
                        span.textContent = match[1];
                        span.addEventListener("click", toggleGlobalShrink);
                        targetEl.insertBefore(span, firstChild);
                        firstChild.textContent = match[2];
                    } else {
                        targetEl.addEventListener("click", toggleGlobalShrink);
                    }
                } else {
                    const text = targetEl.innerText.trim();
                    const match = text.match(/^([\p{Emoji}\S]+)(.*)/u);
                    if (match) {
                        targetEl.innerHTML = `<span class="zoom-trigger-icon">${Utils.escapeHtml(match[1])}</span>${Utils.escapeHtml(match[2])}`;
                        targetEl.querySelector(".zoom-trigger-icon").addEventListener("click", toggleGlobalShrink);
                    } else {
                        targetEl.addEventListener("click", toggleGlobalShrink);
                    }
                }
            }
        }
    } else {
        targetEl.addEventListener("click", toggleGlobalShrink);
        targetEl.classList.add("zoom-trigger-whole");
    }
}

export function setupZoomTrigger(el, mode, force) {
    setupZoomTriggerGlobal(el, mode, force);
}

function initZoomSystem() {
    if (localStorage.getItem("globalZoomState") === "true") {
        document.documentElement.classList.add("shrink-view");
        setTimeout(() => {
            document.addEventListener("click", restoreGlobalView);
        }, 100);
    }

    const loadConfig = () => {
        // Use local variable for ZOOM_CONFIG as it's not on Window/MAERS anymore inside module
        const ZOOM_CONFIG = [
            { path: "index.html", selector: "#brand-logo", mode: "whole" },
            { path: "", selector: "#brand-logo", mode: "whole" },
            { path: "music.html", selector: ".right-icon", mode: "whole" },
            { path: "admin-music.html", selector: ".right-icon", mode: "whole" },
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
    const isHome = path.endsWith("index.html") || path.endsWith("/") || path === "";

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
    const toggleSwitch = document.querySelector(".theme-switch-checkbox");
    if (toggleSwitch) {
        const saved = localStorage.getItem("theme");
        toggleSwitch.checked = saved === "dark-mode" || !saved;
        const modeIcon = document.getElementById("mode-icon");
        if (modeIcon) modeIcon.innerText = toggleSwitch.checked ? "🌙" : "☀️";

        toggleSwitch.addEventListener("change", (e) => {
            if (config.mode !== "manual") {
                config.mode = "manual";
                localStorage.setItem("autoThemeConfig", JSON.stringify(config));
                const btn = document.getElementById("auto-btn");
                if (btn) {
                    btn.textContent = "M";
                    btn.classList.remove("active");
                }
            }
            const target = e.target.checked ? "dark-mode" : "light-mode";
            applyTheme(target);
        });
    }

    // 4. Initial Strategy Check
    checkThemeStrategy();

    // 5. System Media Listener
    if (window.matchMedia) {
        const systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
        systemThemeMedia.addEventListener("change", () => {
            if (config.mode === "system") {
                checkThemeStrategy();
            }
        });
    }

    // 6. Zoom System
    initZoomSystem();

    // 7. Iframe Click Handling
    document.addEventListener("click", (e) => {
        if (window.parent !== window && window.name === "content-frame") {
            const isInteractive = e.target.closest(
                "a, button, input, .interactive, .theme-switch-wrapper, .auto-mode-btn",
            );
            if (!isInteractive) window.parent.postMessage("closePanel", "*");
        }
    });
    if (window.parent !== window)
        document.documentElement.classList.add("in-iframe");
}

// 存储监听器引用,用于清理
let popoverClickHandler = null;

function initHomeControls() {
    const getModeLabel = (mode) => {
        if (mode === "system") return "S";
        if (mode === "auto") return "A";
        return "M";
    };

    const autoControlHtml = `
              <div class="auto-mode-btn ${config.mode !== "manual" ? "active" : ""}" id="auto-btn" title="左键切换 / 右键设置">
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

    if (!document.getElementById("auto-btn")) {
        document.body.insertAdjacentHTML("afterbegin", autoControlHtml);
    }

    const autoBtn = document.getElementById("auto-btn");
    const popover = document.getElementById("auto-popover");
    const dayInput = document.getElementById("day-start");
    const nightInput = document.getElementById("night-start");
    const saveTrigger = document.getElementById("save-trigger");

    if (dayInput) dayInput.value = config.dayTime;
    if (nightInput) nightInput.value = config.nightTime;

    if (autoBtn) {
        // 使用 { once: false } 确保不会重复绑定
        // 通过检查是否已绑定来避免重复
        if (!autoBtn.dataset.listenersBound) {
            autoBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (config.mode === "system") config.mode = "auto";
                else if (config.mode === "auto") config.mode = "manual";
                else config.mode = "system";

                autoBtn.textContent = getModeLabel(config.mode);
                autoBtn.classList.toggle("active", config.mode !== "manual");
                localStorage.setItem("autoThemeConfig", JSON.stringify(config));

                if (config.mode !== "manual") {
                    localStorage.removeItem("theme");
                }
                checkThemeStrategy();
            });

            autoBtn.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                popover.classList.toggle("show");
            });

            autoBtn.dataset.listenersBound = "true";
        }
    }

    if (saveTrigger && !saveTrigger.dataset.listenersBound) {
        saveTrigger.addEventListener("click", (e) => {
            e.stopPropagation();
            config.dayTime = dayInput.value;
            config.nightTime = nightInput.value;
            localStorage.setItem("autoThemeConfig", JSON.stringify(config));
            saveTrigger.classList.add("active");
            setTimeout(() => {
                saveTrigger.classList.remove("active");
            }, 1000);
            if (config.mode === "auto") checkThemeStrategy();
        });
        saveTrigger.dataset.listenersBound = "true";
    }

    // 移除旧的全局点击监听器
    if (popoverClickHandler) {
        document.removeEventListener("click", popoverClickHandler);
    }

    // 创建新的监听器
    popoverClickHandler = (e) => {
        if (popover && !popover.contains(e.target) && e.target !== autoBtn)
            popover.classList.remove("show");
    };
    document.addEventListener("click", popoverClickHandler);
}


// Backward Compatibility Global Mount (optional, but good for safety)
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
