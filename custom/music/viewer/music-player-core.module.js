/**
 * MAERS Music Player Core (music-player-core.module.js)
 * 核心播放逻辑：播放控制、进度条、状态管理
 * @version 3.0.0 - ES6 Module
 */

import { Utils } from '../../../shared/utils.module.js';

let UI, IFrame, PIP;

const TIP_DURATION = 1200;
const FADE_DELAY = 600;

export function initPlayer(uiModule, iframeModule, pipModule) {
    UI = uiModule;
    IFrame = iframeModule;
    PIP = pipModule;
}

// 播放器状态
export const Player = {
    currentPlaying: { bvid: null, page: 0, total: 0, catIdx: -1, colIdx: -1, albIdx: -1 },
    isPlaying: false,
    playStartTime: 0,
    playedSeconds: 0,
    pauseTimeout: null,
    frame: null,
    wakeLock: null,
    keepAliveAudio: null,

    // Event System
    _listeners: {},
    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
    },
    emit(event, data) {
        if (this._listeners[event]) {
            this._listeners[event].forEach(cb => cb(data));
        }
    }
};

export function showTip(msg) {
    const nextTip = document.getElementById('next-tip');
    if (nextTip) {
        nextTip.textContent = msg;
        nextTip.style.display = 'block';
        nextTip.style.zIndex = '9999';
        setTimeout(() => nextTip.style.display = 'none', TIP_DURATION);
    }
}

export async function playTrack(bvid, page, total, catIdx, colIdx, albIdx, uiElement, trackIdx = -1) {
    Player.playedSeconds = 0;
    delete Player.currentPlaying.hasManualSeek;

    if (Player.pauseTimeout) {
        clearTimeout(Player.pauseTimeout);
        Player.pauseTimeout = null;
    }

    Player.isPlaying = true;
    Player.emit('stateChange', { isPlaying: true });
    document.querySelector('.right-icon')?.classList.add('beating');
    document.querySelector('.right-icon')?.classList.remove('paused');

    Player.playStartTime = Date.now();
    const seekSlider = document.getElementById('seek-slider');
    if (seekSlider) seekSlider.value = 0;
    const currTimeLabel = document.getElementById('curr-time');
    if (currTimeLabel) currTimeLabel.innerText = "00:00";

    const lib = UI?.libraryData || [];
    let duration = 300;

    if (lib[catIdx]) {
        const albumData = lib[catIdx].collections[colIdx].albums[albIdx];
        if (albumData.durations && albumData.durations[page]) {
            duration = parseInt(albumData.durations[page]);
        } else if (albumData.duration) {
            duration = parseInt(albumData.duration);
        }

        if (trackIdx === -1) {
            const totalP = parseInt(albumData.total) || 1;
            const mapping = albumData.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);
            trackIdx = mapping.indexOf(page);
        }

        const catName = lib[catIdx].name;
        const colName = lib[catIdx].collections[colIdx].name;
        const albName = albumData.title;
        let partText = "";
        if (albumData.total > 1) {
            const pTitle = (albumData.custom_parts && albumData.custom_parts[trackIdx]) || `P${page}`;
            partText = ` · ${pTitle}`;
        }
        const infoText = `Playing: ${catName} · ${colName} · ${albName}${partText}`;
        document.querySelectorAll('.header-playing-info').forEach(el => {
            el.innerHTML = `<span class="scroll-text">${Utils.escapeHtml(infoText)}</span>`;
            el.classList.add('show');
        });
    }

    const tLabel = document.getElementById('total-time');
    if (tLabel) {
        const m = Math.floor(duration / 60);
        const s = Math.floor(duration % 60);
        tLabel.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    Player.currentPlaying = { bvid, page, total, catIdx, colIdx, albIdx, duration, trackIdx };

    if (UI) {
        UI.currentCatIndex = catIdx;
        UI.currentColIndex = colIdx;
        UI.currentAlbIndex = albIdx;
    }

    const jumpLink = document.getElementById('jump-link');
    if (jumpLink) {
        jumpLink.href = `https://www.bilibili.com/video/${bvid}?p=${page}`;
        jumpLink.style.display = 'block';
    }

    if (IFrame?.ensurePlayerFrame) IFrame.ensurePlayerFrame();

    const randomTs = Date.now();
    Player.frame.src = `https://player.bilibili.com/player.html?isOutside=true&bvid=${bvid}&page=${page}&high_quality=1&danmaku=0&autoplay=1&t=2&platform=html5&_=${randomTs}`;
    Player.frame.style.opacity = '1';

    document.querySelectorAll('.playing').forEach(el => el.classList.remove('playing'));
    if (uiElement) uiElement.classList.add('playing');

    const albDiv = document.querySelector(`.album-item[data-idx="${albIdx}"]`);
    if (albDiv && UI?.currentLevel === 2) albDiv.classList.add('playing');

    const tip = document.getElementById('next-tip');
    if (tip) tip.style.display = 'none';

    if (PIP?.enableBackgroundPlayback) PIP.enableBackgroundPlayback();

    const pipBtn = document.querySelector('.pip-float-btn');
    if (pipBtn) pipBtn.style.display = 'flex';
}

export function togglePlay() {
    if (!Player.currentPlaying || !Player.currentPlaying.bvid) { showTip("未播放歌曲"); return; }
    const jumpLink = document.getElementById('jump-link');

    if (IFrame?.ensurePlayerFrame) IFrame.ensurePlayerFrame();

    if (Player.isPlaying) {
        const now = Date.now();
        Player.playedSeconds += (now - Player.playStartTime) / 1000;
        Player.frame.style.opacity = '0';

        Player.pauseTimeout = setTimeout(() => {
            Player.frame.src = '';
            Player.pauseTimeout = null;
        }, FADE_DELAY);

        Player.isPlaying = false;
        Player.emit('stateChange', { isPlaying: false });
        document.querySelector('.right-icon')?.classList.add('paused');

        const tip = document.getElementById('next-tip');
        if (tip) {
            tip.innerText = `已暂停`;
            tip.style.display = 'block';
            tip.style.zIndex = '9999';
        }
        if (jumpLink) jumpLink.style.display = 'none';

        document.querySelectorAll('.header-playing-info .scroll-text').forEach(el => {
            if (!el.innerText.includes('(已暂停)')) {
                el.innerText += ' (已暂停)';
                el.style.opacity = '0.7';
            }
        });

        if (PIP?.disableBackgroundPlayback) PIP.disableBackgroundPlayback();

        const pipBtn = document.querySelector('.pip-float-btn');
        if (pipBtn) pipBtn.style.display = 'none';

    } else {
        if (Player.currentPlaying.bvid) {
            if (Player.pauseTimeout) { clearTimeout(Player.pauseTimeout); Player.pauseTimeout = null; }
            const seekTime = Math.floor(Player.playedSeconds);

            Player.frame.src = `https://player.bilibili.com/player.html?isOutside=true&bvid=${Player.currentPlaying.bvid}&page=${Player.currentPlaying.page}&high_quality=1&danmaku=0&autoplay=1&t=${seekTime}`;
            Player.frame.style.opacity = '1';

            Player.playStartTime = Date.now();
            Player.isPlaying = true;
            Player.emit('stateChange', { isPlaying: true });

            const icon = document.querySelector('.right-icon');
            if (icon) {
                icon.classList.add('beating');
                icon.classList.remove('paused');
            }

            const tip = document.getElementById('next-tip');
            if (tip) tip.style.display = 'none';
            if (jumpLink) jumpLink.style.display = 'block';

            document.querySelectorAll('.header-playing-info .scroll-text').forEach(el => {
                el.innerText = el.innerText.replace(/(\s*\(已暂停\))+$/g, '');
                el.style.opacity = '1';
            });

            if (PIP?.enableBackgroundPlayback) PIP.enableBackgroundPlayback();

            const pipBtn = document.querySelector('.pip-float-btn');
            if (pipBtn) pipBtn.style.display = 'flex';
        }
    }
}

// 进度条与自动切歌监控
document.addEventListener('DOMContentLoaded', () => {
    const seekSlider = document.getElementById('seek-slider');
    const masterPlayBtn = document.getElementById('master-play-btn');
    const currTimeLabel = document.getElementById('curr-time');

    if (masterPlayBtn) {
        masterPlayBtn.onclick = null;
        Utils.bindEvent(masterPlayBtn, 'click', togglePlay);
    }

    let pendingAutoplay = false;

    setInterval(() => {
        if (Player.isPlaying) {
            const now = Date.now();
            const currentElapsed = (Player.playedSeconds || 0) + (now - (Player.playStartTime || now)) / 1000;
            const totalDuration = (Player.currentPlaying && Player.currentPlaying.duration) ? Player.currentPlaying.duration : 300;

            if (Player.currentPlaying.bvid && currentElapsed >= totalDuration) {
                Player.isPlaying = false;
                Player.emit('stateChange', { isPlaying: false });

                if (document.hidden) {
                    pendingAutoplay = true;
                    Player.isPlaying = true;
                    Player.emit('stateChange', { isPlaying: true });
                }

                if (UI?.playNext) UI.playNext();
                return;
            }

            if (currTimeLabel) {
                const m = Math.floor(currentElapsed / 60);
                const s = Math.floor(currentElapsed % 60);
                currTimeLabel.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
            }
            if (seekSlider) seekSlider.value = (currentElapsed / totalDuration) * 100;
            if (masterPlayBtn) masterPlayBtn.classList.add('is-playing');
        } else {
            if (masterPlayBtn) masterPlayBtn.classList.remove('is-playing');
        }
    }, 1000);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && pendingAutoplay && Player.currentPlaying && Player.currentPlaying.bvid) {
            const randomTs = Date.now();
            const seekTime = Math.floor(Player.playedSeconds || 2);
            Player.frame.src = `https://player.bilibili.com/player.html?isOutside=true&bvid=${Player.currentPlaying.bvid}&page=${Player.currentPlaying.page}&high_quality=1&danmaku=0&autoplay=1&t=${seekTime}&_=${randomTs}`;
            Player.frame.style.opacity = '1';
            Player.playStartTime = Date.now();

            pendingAutoplay = false;
        }
    });

    if (seekSlider) {
        seekSlider.onchange = () => {
            const totalDuration = (Player.currentPlaying && Player.currentPlaying.duration) ? Player.currentPlaying.duration : 300;
            const targetSeconds = Math.floor((seekSlider.value / 100) * totalDuration);
            const safeSeekTime = Math.max(2, targetSeconds);

            if (Player.currentPlaying && Player.currentPlaying.bvid) {
                if (Player.frame) Player.frame.remove();
                Player.frame = null;

                if (IFrame?.ensurePlayerFrame) IFrame.ensurePlayerFrame();

                Player.playedSeconds = safeSeekTime;
                const randomTs = Date.now();

                if (Player.isPlaying) {
                    Player.playStartTime = Date.now();
                    Player.frame.src = `https://player.bilibili.com/player.html?isOutside=true&bvid=${Player.currentPlaying.bvid}&page=${Player.currentPlaying.page}&high_quality=1&danmaku=0&autoplay=1&t=${safeSeekTime}&_=${randomTs}`;
                } else {
                    Player.frame.src = `https://player.bilibili.com/player.html?isOutside=true&bvid=${Player.currentPlaying.bvid}&page=${Player.currentPlaying.page}&high_quality=1&danmaku=0&autoplay=0&t=${safeSeekTime}&_=${randomTs}`;
                }
                Player.frame.style.opacity = '1';
            }
        };
    }
});

// 保留全局函数供 HTML 调用


// 将函数挂载到 Player 对象上
Player.playTrack = playTrack;
Player.togglePlay = togglePlay;
Player.showTip = showTip;
