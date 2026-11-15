/**
 * MAERS Music Player PIP (music-player-pip.module.js)
 * 画中画功能 + 后台播放保活机制
 * @version 3.0.0 - ES6 Module
 */

import { Utils } from '../../../shared/utils.module.js';

let Player, Control;

const RESTORE_DELAY = 10;

export function initPIP(playerModule, controlModule) {
    Player = playerModule;
    Control = controlModule;
}

/**
 *  启用后台播放保持机制
 * 使用 Wake Lock API (主方案) + 虚拟音频 (后备方案)
 */
export async function enableBackgroundPlayback() {
    if ('wakeLock' in navigator) {
        try {
            Player.wakeLock = await navigator.wakeLock.request('screen');
            Player.wakeLock.addEventListener('release', () => {
            });
        } catch (err) {
            console.warn(' Wake Lock 请求失败:', err.message);
        }
    }

    if (!Player.keepAliveAudio) {
        Player.keepAliveAudio = document.getElementById('keep-alive-audio');
    }

    if (Player.keepAliveAudio) {
        try {
            Player.keepAliveAudio.volume = 0.01;
            await Player.keepAliveAudio.play();
        } catch (err) {
            console.warn(' 虚拟音频启动失败:', err.message);
        }
    }
}

/**
 *  禁用后台播放保持机制
 */
export async function disableBackgroundPlayback() {
    if (Player.wakeLock) {
        try {
            await Player.wakeLock.release();
            Player.wakeLock = null;
        } catch (err) {
            console.warn(' Wake Lock 释放失败:', err);
        }
    }

    if (Player.keepAliveAudio && !Player.keepAliveAudio.paused) {
        Player.keepAliveAudio.pause();
    }
}

export async function togglePictureInPicture() {
    if (!Player.currentPlaying || !Player.currentPlaying.bvid) {
        if (Player.showTip) Player.showTip("未播放歌曲");
        return;
    }

    if ('documentPictureInPicture' in window) {
        try {
            if (window.documentPictureInPicture.window) {
                window.documentPictureInPicture.window.close();
                return;
            }

            const playerContainer = document.querySelector('.bili-monitor');
            const controlBar = document.querySelector('.custom-control-bar');
            if (!playerContainer || !controlBar) return;

            let pausedSrc = null;

            if (Player.isPlaying) {
                const now = Date.now();
                Player.playedSeconds += (now - Player.playStartTime) / 1000;
                const seekTime = Math.floor(Player.playedSeconds);

                pausedSrc = `https://player.bilibili.com/player.html?isOutside=true&bvid=${Player.currentPlaying.bvid}&page=${Player.currentPlaying.page}&high_quality=1&danmaku=0&autoplay=0&t=${seekTime}`;

                Player.isPlaying = false;

                const masterPlayBtn = document.getElementById('master-play-btn');
                if (masterPlayBtn) masterPlayBtn.classList.remove('is-playing');

                disableBackgroundPlayback();
            }

            const width = Math.max(playerContainer.clientWidth, 600);
            const height = playerContainer.clientHeight + controlBar.clientHeight + 100;

            const pipWindow = await window.documentPictureInPicture.requestWindow({
                width: width,
                height: height
            });

            [...document.styleSheets].forEach((styleSheet) => {
                try {
                    if (styleSheet.href) {
                        const link = document.createElement('link');
                        link.rel = 'stylesheet';
                        link.type = styleSheet.type;
                        link.media = styleSheet.media;
                        link.href = styleSheet.href;
                        pipWindow.document.head.appendChild(link);
                    } else {
                        const cssRules = [...styleSheet.cssRules].map((rule) => rule.cssText).join('');
                        const style = document.createElement('style');
                        style.textContent = cssRules;
                        pipWindow.document.head.appendChild(style);
                    }
                } catch (e) { console.warn("Style copy error:", e); }
            });

            pipWindow.playNext = Control?.playNext;
            pipWindow.playPrev = Control?.playPrev;
            pipWindow.remoteTogglePlay = Player.togglePlay;
            pipWindow.togglePictureInPicture = togglePictureInPicture;

            pipWindow.document.body.className = document.body.className;
            Object.assign(pipWindow.document.body.style, {
                display: 'flex',
                flexDirection: 'column',
                background: '#0a0a0a',
                margin: '0',
                padding: '0',
                overflow: 'hidden',
                height: '100vh'
            });

            controlBar.style.flexShrink = '0';
            controlBar.style.marginTop = 'auto';
            controlBar.style.width = '100%';
            controlBar.style.boxSizing = 'border-box';
            playerContainer.style.flex = '1';
            playerContainer.style.minHeight = '0';

            pipWindow.document.body.appendChild(playerContainer);
            pipWindow.document.body.appendChild(controlBar);

            if (pausedSrc && Player.frame) {
                setTimeout(() => {
                    Player.frame.src = pausedSrc;
                }, RESTORE_DELAY);
            }

            pipWindow.addEventListener("pagehide", (event) => {
                const monitorSection = document.querySelector('.monitor-section');
                if (monitorSection) {
                    if (Player.isPlaying) {
                        const now = Date.now();
                        Player.playedSeconds += (now - Player.playStartTime) / 1000;
                        const seekTime = Math.floor(Player.playedSeconds);

                        Player.frame.src = `https://player.bilibili.com/player.html?isOutside=true&bvid=${Player.currentPlaying.bvid}&page=${Player.currentPlaying.page}&high_quality=1&danmaku=0&autoplay=0&t=${seekTime}`;

                        Player.isPlaying = false;

                        const masterPlayBtn = document.getElementById('master-play-btn');
                        if (masterPlayBtn) masterPlayBtn.classList.remove('is-playing');

                        disableBackgroundPlayback();
                    }

                    monitorSection.prepend(playerContainer);
                    monitorSection.appendChild(controlBar);

                    controlBar.style.flexShrink = '';
                    controlBar.style.marginTop = '';
                    controlBar.style.width = '';
                    playerContainer.style.flex = '';
                    playerContainer.style.minHeight = '';
                }
            });

        } catch (err) {
            console.error("PiP failed:", err);
            if (Player.showTip) Player.showTip("画中画启动失败");
        }
    } else {
        if (Player.frame && Player.frame.requestPictureInPicture) {
            try {
                await Player.frame.requestPictureInPicture();
            } catch (e) {
                if (Player.showTip) Player.showTip("浏览器不支持画中画");
            }
        } else {
            if (Player.showTip) Player.showTip("浏览器不支持画中画");
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    Utils.bindEvent('.pip-float-btn', 'click', togglePictureInPicture);
});

// 保留全局函数供 HTML 调用

