/**
 * MAERS Music Player IFrame (music-player-iframe.module.js)
 * Bilibili iframe通信：创建、管理、容器查找
 * @version 3.0.0 - ES6 Module
 */

let Player;

export function initIFrame(playerModule) {
    Player = playerModule;
}

/**
 * 创建或获取 Bilibili player iframe
 * 自动处理主窗口和小窗容器的查找
 * @returns {HTMLIFrameElement}
 */
export function ensurePlayerFrame() {
    // 1. 尝试获取现有引用
    if (Player.frame && Player.frame.isConnected) {
        return Player.frame;
    }

    // 2. 查找容器：优先找主界面，如果主界面没有（可能在小窗），则找小窗
    let container = document.querySelector('.bili-monitor');

    // 如果主页面找不到容器，且存在小窗，则尝试在小窗里找
    if (!container && typeof window !== 'undefined' && window.documentPictureInPicture && window.documentPictureInPicture.window) {
        container = window.documentPictureInPicture.window.document.querySelector('.bili-monitor');
    }

    // 3. 如果已有 iframe 但不在 DOM 中，或者需要新建
    if (!Player.frame) {
        Player.frame = document.createElement('iframe');
        Player.frame.id = 'bili-frame';
        Player.frame.setAttribute('scrolling', 'no');
        Player.frame.setAttribute('border', '0');
        Player.frame.setAttribute('frameborder', 'no');
        Player.frame.setAttribute('framespacing', '0');
        Player.frame.setAttribute('allowfullscreen', 'true');
        Player.frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write');
    }

    // 4. 将 iframe 放入找到的容器
    if (container && Player.frame.parentElement !== container) {
        container.appendChild(Player.frame);
    }

    return Player.frame;
}
