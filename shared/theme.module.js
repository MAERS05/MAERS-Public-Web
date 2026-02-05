/**
 * MAERS Theme Controller (theme.module.js)
 * 主题切换、自动模式、智能缩放系统
 * Based on original script.js
 * @version 2.0.0 - ES6 Module
 */

import { Utils } from './utils.module.js';

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
            if (modeIcon) modeIcon.src = isDark ? "ui/moon.svg" : "ui/sun.svg";

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

// --- 拖拽交互状态 ---
let panState = {
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    currentX: 0,
    currentY: 0,
    // 长按检测变量
    tempStartX: 0, // 实时光标位置 (供长按触发时使用)
    tempStartY: 0,
    initialStartX: 0, // 初始按下位置 (供位移阈值检测使用)
    initialStartY: 0,
    heldTimer: null,
    // 性能优化变量
    targetEl: null,
    ticking: false
};

// 蓝色涟漪动画
function createRipple(x, y) {
    const ripple = document.createElement("div");
    ripple.classList.add("long-press-ripple");

    // 居中定位
    const size = 100;
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${x - size / 2}px`;
    ripple.style.top = `${y - size / 2}px`;

    document.body.appendChild(ripple);

    ripple.addEventListener("animationend", () => {
        ripple.remove();
    });
}

// 性能优化的位置更新 (rAF)
function updatePanTransform() {
    if (!panState.targetEl) panState.targetEl = document.querySelector(".main-card, .home-container");

    if (panState.targetEl && !panState.ticking) {
        panState.ticking = true;
        requestAnimationFrame(() => {
            panState.targetEl.style.setProperty("--zoom-pan-x", `${panState.currentX}px`);
            panState.targetEl.style.setProperty("--zoom-pan-y", `${panState.currentY}px`);
            panState.ticking = false;
        });
    }
}

// 统一处理 Start 事件 (Mouse + Touch)
function handleDragStart(e) {
    if (!document.documentElement.classList.contains("shrink-view")) return;

    // 只有点击卡片内部才可能触发长按
    const isCard = e.target.closest(".main-card, .home-container");
    if (!isCard) return;

    // 排除交互按钮
    if (e.target.closest("a, button, input, .interactive")) return;

    // 获取坐标
    let clientX, clientY;
    if (e.type === 'touchstart') {
        if (e.touches.length > 1) return;
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }

    // 记录初始点
    panState.tempStartX = clientX;
    panState.tempStartY = clientY;
    panState.initialStartX = clientX;
    panState.initialStartY = clientY;

    if (panState.heldTimer) clearTimeout(panState.heldTimer);

    // 启动 0.6s 长按计时
    panState.heldTimer = setTimeout(() => {
        panState.isDragging = true;
        // 关键修复：使用最新的已知坐标(tempStartX/Y)作为起点
        // 因为在长按期间(0.6s)，手指可能发生了微小的移动(move事件会更新tempStartX)，
        // 如果使用旧的 clientX，会导致 activating 瞬间卡片位置跳动。
        createRipple(panState.tempStartX, panState.tempStartY);

        const target = document.querySelector(".main-card, .home-container");
        if (target) target.classList.add("is-dragging");

        // 设定当前的拖拽基准点
        panState.dragStartX = panState.tempStartX;
        panState.dragStartY = panState.tempStartY;
    }, 600);
}

// 统一处理 Move 事件
function handleDragMove(e) {
    if (!document.documentElement.classList.contains("shrink-view")) return;

    let clientX, clientY;
    if (e.type === 'touchmove') {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }

    // 模式1: 已处于拖拽状态 -> 移动卡片
    if (panState.isDragging) {
        if (e.cancelable) e.preventDefault(); // 阻止滚动

        const dx = clientX - panState.dragStartX;
        const dy = clientY - panState.dragStartY;

        // [关键修复] 补偿 Scale(0.65) 带来的视觉差
        // 鼠标移动 1px，逻辑坐标需要移动 1/0.65 px，才能在视觉上保持 1:1 跟手
        panState.currentX += dx / 0.65;
        panState.currentY += dy / 0.65;

        // 更新基准点
        panState.dragStartX = clientX;
        panState.dragStartY = clientY;

        updatePanTransform();
        return;
    }

    // 模式2: 等待长按中 -> 检测是否移动过大
    if (panState.heldTimer) {
        // 如果移动超过 10px，判定为“滚动页面”，取消长按
        const moveDist = Math.sqrt(Math.pow(clientX - panState.tempStartX, 2) + Math.pow(clientY - panState.tempStartY, 2));

        if (moveDist > 10) {
            clearTimeout(panState.heldTimer);
            panState.heldTimer = null;
        }
    }
}


// 统一处理 End 事件
function handleDragEnd(e) {
    if (panState.heldTimer) {
        clearTimeout(panState.heldTimer);
        panState.heldTimer = null;
    }

    if (panState.isDragging) {
        panState.isDragging = false;
        const target = document.querySelector(".main-card, .home-container");
        if (target) target.classList.remove("is-dragging");
    }
}

function restoreGlobalView(e) {
    // 1. 如果正在拖拽，或者刚松开手(isDragging由handleDragEnd重置，此处作为双重保险)
    // 注意：restoreGlobalView 是 click 事件，click 会在 mouseup 之后触发。
    // 如果刚刚发生了拖拽，我们其实应该阻止复原。但由于 dragging 状态在 mouseup 立即取消了，
    // 这里需要一个标志位或者简单的逻辑链。
    // 现在的交互逻辑是：点击背景复原，点击卡片不做反应（除非是长按）。
    // 所以，直接判断点击目标即可。即使刚刚拖拽完，点击的也是卡片本身，所以这里 return 掉是正确的。

    const t = e.target;

    // A. 点击的是卡片 -> 不复原 (无论是点击还是拖拽完)
    if (t.closest(".main-card, .home-container, .immersive-layer")) return;

    // B. 点击无关元素
    if (t.closest(".zoom-trigger-icon") || t.closest(".zoom-trigger-whole")) return;
    if (t.closest(".theme-switch-wrapper") || t.closest(".auto-mode-btn") || t.closest(".mode-text-btn") || t.closest(".lightbox")) return;

    // C. 点击背景 -> 执行复原
    document.documentElement.classList.remove("shrink-view");
    document.removeEventListener("click", restoreGlobalView);
    localStorage.setItem("globalZoomState", "false");

    // 解绑拖拽监听
    const container = document.body;
    container.removeEventListener("mousedown", handleDragStart);
    window.removeEventListener("mousemove", handleDragMove);
    window.removeEventListener("mouseup", handleDragEnd);
    container.removeEventListener("touchstart", handleDragStart);
    window.removeEventListener("touchmove", handleDragMove);
    window.removeEventListener("touchend", handleDragEnd);

    // 重置位移
    panState.currentX = 0;
    panState.currentY = 0;
    updatePanTransform();
}

export function toggleGlobalShrink(e) {
    try {
        if (e) {
            e.stopPropagation();
            e.preventDefault();
        }
        const isShrunk = document.documentElement.classList.toggle("shrink-view");
        localStorage.setItem("globalZoomState", isShrunk);

        if (isShrunk) {
            // 进入缩放模式：绑定拖拽监听
            const container = document.body;
            container.addEventListener("mousedown", handleDragStart);
            window.addEventListener("mousemove", handleDragMove);
            window.addEventListener("mouseup", handleDragEnd);
            container.addEventListener("touchstart", handleDragStart, { passive: false });
            window.addEventListener("touchmove", handleDragMove, { passive: false });
            window.addEventListener("touchend", handleDragEnd);

            setTimeout(() => {
                document.addEventListener("click", restoreGlobalView);
            }, 50);
        } else {
            // 退出缩放模式：解绑
            document.removeEventListener("click", restoreGlobalView);

            const container = document.body;
            container.removeEventListener("mousedown", handleDragStart);
            window.removeEventListener("mousemove", handleDragMove);
            window.removeEventListener("mouseup", handleDragEnd);
            container.removeEventListener("touchstart", handleDragStart);
            window.removeEventListener("touchmove", handleDragMove);
            window.removeEventListener("touchend", handleDragEnd);

            panState.currentX = 0;
            panState.currentY = 0;
            updatePanTransform();
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
            // [Fix] 如果触发器本身是图片或包含图片，不要替换为 textContent (会导致图片消失)
            if (trigger.tagName === 'IMG' || trigger.tagName === 'SVG' || trigger.querySelector('img, svg')) {
                trigger.classList.remove('zoom-trigger-icon', 'zoom-trigger-whole');
                const clone = trigger.cloneNode(true);
                trigger.replaceWith(clone);
            } else {
                trigger.replaceWith(document.createTextNode(trigger.textContent));
            }
        });
        targetEl.classList.remove("js-zoom-ready");
    }

    targetEl.classList.add("js-zoom-ready");

    if (!mode) mode = "icon_only";

    if (mode === "icon_only") {
        // [Fix] If the target itself is an image/svg, treat it as the icon immediately
        if (targetEl.tagName === 'IMG' || targetEl.tagName === 'SVG') {
            targetEl.classList.add('zoom-trigger-icon');
            targetEl.addEventListener("click", toggleGlobalShrink);
            return;
        }

        const existingIcon = targetEl.querySelector(".title-icon");
        if (existingIcon) {
            existingIcon.classList.add("zoom-trigger-icon");
            existingIcon.addEventListener("click", toggleGlobalShrink);
        } else {
            const existingZoomIcon = targetEl.querySelector(".zoom-trigger-icon");
            if (existingZoomIcon) {
                existingZoomIcon.addEventListener("click", toggleGlobalShrink);
            } else {
                const firstChild = targetEl.firstElementChild || targetEl.firstChild;

                // [Fix] 优先检测图片/SVG作为图标
                if (firstChild && firstChild.nodeType === Node.ELEMENT_NODE && (firstChild.tagName === 'IMG' || firstChild.tagName === 'SVG')) {
                    firstChild.classList.add('zoom-trigger-icon');
                    firstChild.addEventListener("click", toggleGlobalShrink);
                }
                // 原有文本检测逻辑
                else if (targetEl.firstChild && targetEl.firstChild.nodeType === Node.TEXT_NODE) {
                    const firstNode = targetEl.firstChild;
                    const text = firstNode.textContent.trim();
                    const match = text.match(/^([\p{Emoji}\S]+)(.*)/u);
                    if (match) {
                        const span = document.createElement('span');
                        span.className = 'zoom-trigger-icon';
                        span.textContent = match[1];
                        span.addEventListener("click", toggleGlobalShrink);
                        targetEl.insertBefore(span, firstNode);
                        firstNode.textContent = match[2];
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

        // 恢复页面时的监听绑定
        const container = document.body;
        container.addEventListener("mousedown", handleDragStart);
        window.addEventListener("mousemove", handleDragMove);
        window.addEventListener("mouseup", handleDragEnd);
        container.addEventListener("touchstart", handleDragStart, { passive: false });
        window.addEventListener("touchmove", handleDragMove, { passive: false });
        window.addEventListener("touchend", handleDragEnd);

        setTimeout(() => {
            document.addEventListener("click", restoreGlobalView);
        }, 100);
    }

    const loadConfig = () => {
        // Use local variable for ZOOM_CONFIG as it's not on Window/MAERS anymore inside module
        const ZOOM_CONFIG = [
            { path: "index.html", selector: "#brand-logo", mode: "whole" },
            { path: "admin-index.html", selector: "#brand-logo", mode: "whole" },
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
    const isHome = path.endsWith("index.html") || path.endsWith("admin-index.html") || path.endsWith("/") || path === "";

    // 0. Auto-Inject Drag Styles (零配置样式注入)
    // 自动检测当前目录层级并加载 drag.css，解决手动引入问题
    if (!document.querySelector('link[href*="drag.css"]')) {
        const scriptEls = document.getElementsByTagName('script');
        // 尝试从 theme.module.js 路径推断，或者由于是绝对路径部署，直接尝试相对路径
        // 稳健的做法：直接尝试几个常见位置，或者简单地假定 static-style 在根目录
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        // 注意：这里的路径逻辑需要适配不同深度的页面
        // 由于项目中大量使用相对路径，我们这里统一用绝对路径可能更稳，
        // 但为了兼容本地文件系统打开，我们这里简单检测 path depth
        const depth = window.location.pathname.split('/').length - 2; // 粗略估算
        const prefix = depth > 0 ? '../'.repeat(depth) : '';
        // 实际上 MAERS 项目结构比较扁平，直接用 'static-style/drag.css' 在根目录和一级子目录通常有效
        // 但最稳妥是直接用用户当前的文件结构惯例
        link.href = 'static-style/drag.css';

        // 针对子页面的修正 (如 custom/index/viewer)
        if (window.location.pathname.includes('/custom/')) {
            link.href = '../../../static-style/drag.css';
        }

        document.head.appendChild(link);
    }

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
        if (modeIcon) modeIcon.src = toggleSwitch.checked ? "ui/moon.svg" : "ui/sun.svg";

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
    document.documentElement.classList.add("in-iframe");

    // 8. Auto-Inject Drag Styles (零配置样式注入)
    if (!document.querySelector('link[href*="drag.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        // 简单路径判断：如果是 nested custom 目录，回退 3 层，否则当前目录
        if (window.location.pathname.includes('/custom/')) {
            link.href = '../../../static-style/drag.css';
        } else {
            link.href = 'static-style/drag.css';
        }
        document.head.appendChild(link);
    }

    // 9. Home Actions
    if (isHome) {
        initHomeControls();
    }
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
