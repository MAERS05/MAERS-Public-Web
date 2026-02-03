/**
 * MAERS Theme Controller
 * ES6 Module Version
 * 主题切换、自动模式、智能缩放系统
 * @version 3.0.0 - ES6 Module
 */

// 初始化全局命名空间
window.MAERS = window.MAERS || {};
window.MAERS.Theme = window.MAERS.Theme || {};

// 版本管理与安全加载
const CONFIG_VERSION = 2;
const DEFAULT_CONFIG = {
    version: CONFIG_VERSION,
    mode: "system", // 'system', 'auto', 'manual'
    dayTime: "07:00",
    nightTime: "19:00",
};

function safeLoadConfig() {
    try {
        const raw = localStorage.getItem("autoThemeConfig");
        if (!raw) return { ...DEFAULT_CONFIG };

        const data = JSON.parse(raw);

        if (!data.version || data.version < CONFIG_VERSION) {
            console.log(
                "[MAERS.Theme] Migrating config to version",
                CONFIG_VERSION,
            );
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

let config = safeLoadConfig();

// 主题切换核心
function applyTheme(theme) {
    try {
        requestAnimationFrame(() => {
            const isDark = theme === "dark-mode";

            if (isDark) {
                document.documentElement.classList.remove("light-mode");
            } else {
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
    }
}

// 主题策略
function checkThemeStrategy() {
    if (config.mode === "system") {
        // 跟随系统
        const prefersDark = window.matchMedia(
            "(prefers-color-scheme: dark)",
        ).matches;
        applyTheme(prefersDark ? "dark-mode" : "light-mode");
    } else if (config.mode === "auto") {
        // 时间自动切换
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        const [dh, dm] = config.dayTime.split(":");
        const [nh, nm] = config.nightTime.split(":");
        const start = parseInt(dh) * 60 + parseInt(dm);
        const end = parseInt(nh) * 60 + parseInt(nm);

        const isDay = mins >= start && mins < end;
        applyTheme(isDay ? "light-mode" : "dark-mode");
    } else {
        // 手动模式
        const saved = localStorage.getItem("theme");
        if (saved) applyTheme(saved);
        else applyTheme("dark-mode");
    }
}

// 智能缩放系统
function toggleGlobalShrink(e) {
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

function setupZoomTriggerGlobal(targetEl, mode, force = false) {
    if (!targetEl) return;

    // Skip if already processed (unless force is true)
    if (!force && targetEl.classList.contains("js-zoom-ready")) return;

    // Remove old zoom triggers if forcing re-process
    if (force) {
        const oldTriggers = targetEl.querySelectorAll('.zoom-trigger-icon, .zoom-trigger-whole');
        oldTriggers.forEach(trigger => {
            trigger.replaceWith(document.createTextNode(trigger.textContent));
        });
        targetEl.classList.remove("js-zoom-ready");
    }

    targetEl.classList.add("js-zoom-ready");

    // Auto-detect mode if not provided
    if (!mode) {
        mode = "icon_only";
    }

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

                        firstChild.textContent = match[2];
                        targetEl.insertBefore(span, firstChild);
                    } else {
                        targetEl.addEventListener("click", toggleGlobalShrink);
                    }
                } else {
                    const text = targetEl.innerText.trim();
                    const match = text.match(/^([\p{Emoji}\S]+)(.*)/u);
                    if (match) {
                        targetEl.innerHTML = `<span class="zoom-trigger-icon">${match[1]}</span>${match[2]}`;
                        targetEl
                            .querySelector(".zoom-trigger-icon")
                            .addEventListener("click", toggleGlobalShrink);
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

// 初始化函数
function init() {
    const path = window.location.pathname;
    const isHome =
        path.endsWith("index.html") || path.endsWith("/") || path === "";

    // 注入遮罩层
    if (!document.getElementById("theme-mask")) {
        const maskHtml = `<div id="theme-mask"></div>`;
        document.body.insertAdjacentHTML("beforeend", maskHtml);
    }

    // 首页 S/A/M 按钮逻辑
    if (isHome) {
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
            autoBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                // 循环切换: S -> A -> M -> S
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
        }

        if (saveTrigger) {
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
        }

        document.addEventListener("click", (e) => {
            if (popover && !popover.contains(e.target) && e.target !== autoBtn)
                popover.classList.remove("show");
        });
    }

    // 主题切换
    const toggleSwitch = document.querySelector(".theme-switch-checkbox");
    const modeIcon = document.getElementById("mode-icon");

    if (toggleSwitch) {
        const saved = localStorage.getItem("theme");
        toggleSwitch.checked = saved === "dark-mode" || !saved;
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

    checkThemeStrategy();

    // 监听系统主题变化
    if (window.matchMedia) {
        const systemThemeMedia = window.matchMedia(
            "(prefers-color-scheme: dark)",
        );
        systemThemeMedia.addEventListener("change", () => {
            if (config.mode === "system") {
                checkThemeStrategy();
            }
        });
    }

    // 智能缩放系统初始化
    if (localStorage.getItem("globalZoomState") === "true") {
        document.documentElement.classList.add("shrink-view");
        setTimeout(() => {
            document.addEventListener("click", restoreGlobalView);
        }, 100);
    }

    // 缩放配置
    window.MAERS.Theme.ZOOM_CONFIG = [
        { path: "index.html", selector: "#brand-logo", mode: "whole" },
        { path: "", selector: "#brand-logo", mode: "whole" },
        { path: "music.html", selector: ".right-icon", mode: "whole" },
        { path: "admin-music.html", selector: ".right-icon", mode: "whole" },
        { path: "*", selector: ".header-title", mode: "icon_only" },
    ];

    const configList = window.MAERS.Theme.ZOOM_CONFIG || [];
    const currentPath =
        decodeURIComponent(window.location.pathname).split("/").pop() ||
        "index.html";

    let rule = configList.find((r) => r.path === currentPath);
    if (!rule) rule = configList.find((r) => r.path === "*");

    if (rule && rule.selector) {
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

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                observer.disconnect();
            }, 5000);
        }
    }
}

// Iframe 点击穿透处理
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

// DOMContentLoaded 初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// 挂载到全局命名空间
window.MAERS.Theme.apply = applyTheme;
window.MAERS.Theme.toggleShrink = toggleGlobalShrink;
window.MAERS.Theme.setupZoomTrigger = setupZoomTriggerGlobal;
window.MAERS.Theme.checkStrategy = checkThemeStrategy;

// 全局函数包装器（兼容性）
window.toggleGlobalShrink = (e) => window.MAERS.Theme && window.MAERS.Theme.toggleShrink(e);

// 导出
export {
    applyTheme,
    checkThemeStrategy,
    toggleGlobalShrink,
    setupZoomTriggerGlobal,
    init
};

export default {
    apply: applyTheme,
    checkStrategy: checkThemeStrategy,
    toggleShrink: toggleGlobalShrink,
    setupZoomTrigger: setupZoomTriggerGlobal,
    init
};
