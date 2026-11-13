/**
 * 本地专属管理操作的环境判定与禁用控件。
 */
import { syncManager } from '../sync/sync-manager.module.js';

/** 是否处于云端中继模式（无本地后端） */
export function isRelayMode() {
    return syncManager.getEffectiveMode() === 'relay';
}

/** 公网站点没有本地接口，即使同步配置被设为本地模式。 */
export function isLocalOnlyUnavailable() {
    return !syncManager.isLocalHost() || isRelayMode();
}

/** 禁用原生按钮或卡片控件，同时拦截事件，避免触发其父卡片的导航。 */
export function disableAdminControl(control, reason = '仅限电脑本地后台操作') {
    if (control.classList.contains('maers-local-disabled')) return;
    control.classList.add('maers-local-disabled');
    control.title = control.title ? `${control.title}（${reason}）` : reason;
    control.setAttribute('aria-disabled', 'true');
    if ('disabled' in control) {
        control.disabled = true;
    } else {
        control.setAttribute('role', 'button');
        control.tabIndex = -1;
    }
    control.addEventListener('click', event => {
        event.preventDefault();
        event.stopImmediatePropagation();
    }, { capture: true });
}

