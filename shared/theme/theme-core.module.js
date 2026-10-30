/**
 * @module shared/theme/theme-core.module.js
 * @description 主题切换与配置 + 首页控制面板
 * @version 1.0.0 - ES6 Module
 */

// 共享主题状态
const themeState = {
    mode: 'auto',
    autoStartHour: 18,
    autoEndHour: 6,
    manualOverride: false
};

const CONFIG_VERSION = 2;
const DEFAULT_CONFIG = {
    version: CONFIG_VERSION,
    mode: "system",
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
            let mode = ["system", "auto", "manual"].includes(data.mode) ? data.mode : "system";
            if (!data.mode && data.enabled === true) mode = "auto";
            else if (!data.mode && data.enabled === false) mode = "manual";
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

const THEME_TRANSITION_MS = 500;
let themeTransitionTimer = null;
let themeViewTransition = null;
let themeRequestId = 0;
let requestedTheme = null;
let themeCoreInitialized = false;

export function applyTheme(theme, { animate = true } = {}) {
    requestedTheme = theme;
    const requestId = ++themeRequestId;
    const apply = () => {
        if (requestId !== themeRequestId) return;
        try {
            const isDark = theme === 'dark-mode';
            const root = document.documentElement;
            const changed = root.classList.contains('light-mode') === isDark;
            const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            const update = () => {
                if (requestId !== themeRequestId) return;
                root.classList.toggle('light-mode', !isDark);
                root.style.removeProperty('background-color');
                root.style.removeProperty('color');
                const toggleSwitch = document.querySelector('.theme-switch-checkbox');
                if (toggleSwitch) toggleSwitch.checked = isDark;
                localStorage.setItem('theme', theme);
            };

            // Skip old snapshots; outdated callbacks cannot overwrite the latest target.
            themeViewTransition?.skipTransition();
            themeViewTransition = null;
            clearTimeout(themeTransitionTimer);
            root.classList.remove('theme-crossfade', 'theme-switching');
            if (animate && changed && !reduceMotion && typeof document.startViewTransition === 'function') {
                root.classList.add('theme-crossfade');
                const transition = document.startViewTransition(update);
                themeViewTransition = transition;
                transition.finished.catch(() => {}).finally(() => {
                    if (themeViewTransition !== transition) return;
                    themeViewTransition = null;
                    root.classList.remove('theme-crossfade');
                });
            } else {
                if (animate && changed && !reduceMotion) {
                    root.classList.add('theme-switching');
                    void root.offsetWidth;
                    themeTransitionTimer = setTimeout(() => {
                        root.classList.remove('theme-switching');
                        themeTransitionTimer = null;
                    }, THEME_TRANSITION_MS + 50);
                }
                update();
            }
        } catch (err) {
            console.error('[MAERS.Theme] Theme switch failed:', err);
            if (window.MAERS?.Toast?.show) {
                window.MAERS.Toast.show('主题切换失败，请刷新页面重试', 'error');
            }
        }
    };
    if (animate) requestAnimationFrame(apply);
    else apply();
}

export function checkThemeStrategy({ animate = true } = {}) {
    if (config.mode === "system") {
        const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        applyTheme(prefersDark ? "dark-mode" : "light-mode", { animate });
    } else if (config.mode === "auto") {
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        const [dh, dm] = config.dayTime.split(":");
        const [nh, nm] = config.nightTime.split(":");
        const start = parseInt(dh) * 60 + parseInt(dm);
        const end = parseInt(nh) * 60 + parseInt(nm);

        const isDay = mins >= start && mins < end;
        applyTheme(isDay ? "light-mode" : "dark-mode", { animate });
    } else {
        const saved = localStorage.getItem("theme");
        if (saved) applyTheme(saved, { animate });
        else applyTheme("dark-mode", { animate });
    }
}

let popoverClickHandler = null;

export function initHomeControls() {
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
                      <span><img src="ui/set-up.svg" style="width: 1.2em; vertical-align: middle; margin-right: 4px;"> 自动切换</span>
                      <div class="save-trigger" id="save-trigger" title="点击保存">
                          <span class="save-icon"></span>
                      </div>
                  </div>
                  <div class="setting-row"><span><img src="ui/sun.svg" style="width: 1.2em; vertical-align: middle; margin-right: 4px;"> 日出:</span><input type="time" id="day-start"></div>
                  <div class="setting-row"><span><img src="ui/moon.svg" style="width: 1.2em; vertical-align: middle; margin-right: 4px;"> 日落:</span><input type="time" id="night-start"></div>
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

    if (popoverClickHandler) {
        document.removeEventListener("click", popoverClickHandler);
    }

    popoverClickHandler = (e) => {
        if (popover && !popover.contains(e.target) && e.target !== autoBtn)
            popover.classList.remove("show");
    };
    document.addEventListener("click", popoverClickHandler);
}

export function initThemeCore() {
    if (themeCoreInitialized) return;
    themeCoreInitialized = true;
    // 后台可能先初始化主题、后注入布局，委托监听不依赖按钮创建顺序。
    document.addEventListener("change", (e) => {
        if (!e.target?.matches?.('.theme-switch-checkbox')) return;
        if (config.mode !== "manual") {
            config.mode = "manual";
            localStorage.setItem("autoThemeConfig", JSON.stringify(config));
            const btn = document.getElementById("auto-btn");
            if (btn) {
                btn.textContent = "M";
                btn.classList.remove("active");
            }
        }
        const target = requestedTheme === 'dark-mode' ? 'light-mode' : 'dark-mode';
        // 原生勾选先于主题快照发生；先还原当前位置，由主题更新统一驱动滑块。
        e.target.checked = !document.documentElement.classList.contains('light-mode');
        applyTheme(target);
    });

    checkThemeStrategy({ animate: false });

    if (window.matchMedia) {
        const systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
        systemThemeMedia.addEventListener("change", () => {
            if (config.mode === "system") {
                checkThemeStrategy();
            }
        });
    }
}

export function getConfig() {
    return config;
}
