/**
 * MAERS Layout Utilities (layout.module.js)
 * 页面布局工具函数
 * @version 2.0.0 - ES6 Module
 */

import { initSpatialNav } from './spatial-nav.module.js';
import { initSecretUnlock, guardCurrentPage } from '../data-manage/encrypt/secret-unlock.module.js';
import { isStudioAdminPage, isOnlineAdminPage, STUDIO_ENTRY_KEY } from '../data-manage/api-client.module.js';

export function injectThemeSwitch() {
    if (document.querySelector('.theme-switch-wrapper')) return;

    const html = `
    <div class="theme-switch-wrapper">
        <label class="theme-switch-label" for="checkbox">
            <input type="checkbox" id="checkbox" class="theme-switch-checkbox" ${document.documentElement.classList.contains('light-mode') ? '' : 'checked'} />
            <div class="ball">
                <img id="mode-icon" src="ui/moon.svg" alt="" aria-hidden="true" />
                <img class="mode-icon-sun" src="ui/sun.svg" alt="" aria-hidden="true" />
            </div>
        </label>
    </div>`;

    document.body.insertAdjacentHTML('afterbegin', html);
}

export function injectImmersiveBackground() {
    if (document.getElementById('immersive-bg')) return;
    const bg = document.createElement('div');
    bg.id = 'immersive-bg';
    bg.className = 'immersive-bg';

    // Two layers for cross-fade. Each has a blur layer + a clear contain layer.
    ['a', 'b'].forEach(id => {
        const layer = document.createElement('div');
        layer.id = `imm-layer-${id}`;
        layer.className = 'imm-layer';

        // Bottom: blurred cover (fills screen, hides letterboxing)
        const blur = document.createElement('div');
        blur.className = 'imm-blur';

        // Top: crisp contain (full image, correct aspect ratio, centered)
        const clear = document.createElement('div');
        clear.className = 'imm-clear';

        layer.appendChild(blur);
        layer.appendChild(clear);
        bg.appendChild(layer);
    });

    document.body.insertAdjacentElement('afterbegin', bg);
}

function _runInit() {
    injectThemeSwitch();
    injectImmersiveBackground();
    // Load Spatial Nav (replaces loadSpatialNav which injected script tag)
    initSpatialNav();
}

export function renderPageHeader(title, backUrl = "index.html", backText = "Back to Home") {
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

let studioEntryStarted = false;
function initStudioEntry() {
    if (studioEntryStarted) return;
    studioEntryStarted = true;
    const online = isOnlineAdminPage();
    if (!isStudioAdminPage() && !online) {
        const leaveAdmin = () => {
            if (isOnlineAdminPage(new URL('/admin-portal.html', window.location.href))) return;
            try { sessionStorage.removeItem(STUDIO_ENTRY_KEY); } catch { /* 访客页允许禁用会话存储。 */ }
        };
        leaveAdmin();
        window.addEventListener('pageshow', event => { if (event.persisted) leaveAdmin(); });
        return;
    }
    const root = document.documentElement;
    root.classList.add('studio-entry-locked');
    const back = () => window.location.replace('/');
    import('../data-manage/encrypt/admin-session.module.js')
        .then(({ ensureAdminSession, ensureOnlineAdminEntry }) => online ? ensureOnlineAdminEntry() : ensureAdminSession())
        .then(() => root.classList.remove('studio-entry-locked'))
        .catch(async error => {
            if (error.cause === 'admin_entry_cancelled') { back(); return; }
            const { openFormModal } = await import('../data-manage/encrypt/lock-dialog.module.js');
            openFormModal({
                title: online ? '无法进入线上后台' : '无法进入本地后台', sub: error.message,
                confirmText: '重试', cancelText: '返回首页',
                onSubmit: () => { window.location.reload(); return true; }, onCancel: back
            });
        });
}

/**
 * Main Initialization Function
 * Replaces the DOMContentLoaded listener in original layout.js
 */
export function initLayout() {
    initStudioEntry();
    initSecretUnlock(); // 隐藏的线上解锁入口（无任何可见元素）
    guardCurrentPage(); // 首页卡片已加锁的页面，未解锁访客直接访问时显示 404
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            _runInit();
        });
    } else {
        _runInit();
    }
}

// Global Mount Removed
// window.MAERS.Layout = ...
