/**
 * MAERS Music Player (music-player.js)
 * 负责核心播放控制、B站通信、进度条状态
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.Music = MAERS.Music || {};

    // 播放器状态
    const Player = {
        currentPlaying: { bvid: null, page: 0, total: 0, catIdx: -1, colIdx: -1, albIdx: -1 },
        isPlaying: false,
        playStartTime: 0,
        playedSeconds: 0,
        pauseTimeout: null,
        frame: null
    };

    /**
     * 创建或获取 Bilibili player iframe
     * @returns {HTMLIFrameElement}
     */
    function ensurePlayerFrame() {
        if (!Player.frame) {
            Player.frame = document.getElementById('bili-frame');
        }

        if (!Player.frame) {
            Player.frame = document.createElement('iframe');
            Player.frame.id = 'bili-frame';
            Player.frame.setAttribute('scrolling', 'no');
            Player.frame.setAttribute('border', '0');
            Player.frame.setAttribute('frameborder', 'no');
            Player.frame.setAttribute('framespacing', '0');
            Player.frame.setAttribute('allowfullscreen', 'true');
            Player.frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write');

            const monitor = document.querySelector('.bili-monitor');
            if (monitor) monitor.appendChild(Player.frame);
        }

        return Player.frame;
    }

    function showTip(msg) {
        const nextTip = document.getElementById('next-tip');
        if (nextTip) {
            nextTip.textContent = msg;
            nextTip.style.display = 'block';
            nextTip.style.zIndex = '9999';
            setTimeout(() => nextTip.style.display = 'none', 1200);
        }
    }

    async function playTrack(bvid, page, total, catIdx, colIdx, albIdx, uiElement, trackIdx = -1) {
        // 强制重置进度
        Player.playedSeconds = 0;
        delete Player.currentPlaying.hasManualSeek;

        if (Player.pauseTimeout) {
            clearTimeout(Player.pauseTimeout);
            Player.pauseTimeout = null;
        }

        Player.isPlaying = true;
        document.querySelector('.right-icon')?.classList.add('beating');
        document.querySelector('.right-icon')?.classList.remove('paused');

        Player.playStartTime = Date.now();
        const seekSlider = document.getElementById('seek-slider');
        if (seekSlider) seekSlider.value = 0;
        const currTimeLabel = document.getElementById('curr-time');
        if (currTimeLabel) currTimeLabel.innerText = "00:00";

        const UI = MAERS.Music.UI || {};
        const lib = UI.libraryData || [];
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
                el.innerHTML = `<span class="scroll-text">${infoText}</span>`;
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

        // 同步到 UI 模块
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

        ensurePlayerFrame();

        const randomTs = Date.now();
        Player.frame.src = `https://player.bilibili.com/player.html?isOutside=true&bvid=${bvid}&page=${page}&high_quality=1&danmaku=0&autoplay=1&t=2&platform=html5&_=${randomTs}`;
        Player.frame.style.opacity = '1';

        document.querySelectorAll('.playing').forEach(el => el.classList.remove('playing'));
        if (uiElement) uiElement.classList.add('playing');

        const albDiv = document.querySelector(`.album-item[data-idx="${albIdx}"]`);
        const UI2 = MAERS.Music.UI;
        if (albDiv && UI2 && UI2.currentLevel === 2) albDiv.classList.add('playing');

        const tip = document.getElementById('next-tip');
        if (tip) tip.style.display = 'none';
    }

    function togglePlay() {
        if (!Player.currentPlaying || !Player.currentPlaying.bvid) { showTip("未播放歌曲"); return; }
        const jumpLink = document.getElementById('jump-link');

        ensurePlayerFrame();

        if (Player.isPlaying) {
            const now = Date.now();
            Player.playedSeconds += (now - Player.playStartTime) / 1000;
            Player.frame.style.opacity = '0';

            Player.pauseTimeout = setTimeout(() => {
                Player.frame.src = '';
                Player.pauseTimeout = null;
            }, 600);

            Player.isPlaying = false;
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

        } else {
            if (Player.currentPlaying.bvid) {
                if (Player.pauseTimeout) { clearTimeout(Player.pauseTimeout); Player.pauseTimeout = null; }
                const seekTime = Math.floor(Player.playedSeconds);

                Player.frame.src = `https://player.bilibili.com/player.html?isOutside=true&bvid=${Player.currentPlaying.bvid}&page=${Player.currentPlaying.page}&high_quality=1&danmaku=0&autoplay=1&t=${seekTime}`;
                Player.frame.style.opacity = '1';

                Player.playStartTime = Date.now();
                Player.isPlaying = true;

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
            }
        }
    }

    // 进度条与自动切歌监控
    document.addEventListener('DOMContentLoaded', () => {
        const seekSlider = document.getElementById('seek-slider');
        const masterPlayBtn = document.getElementById('master-play-btn');
        const currTimeLabel = document.getElementById('curr-time');

        setInterval(() => {
            if (Player.isPlaying) {
                const now = Date.now();
                const currentElapsed = (Player.playedSeconds || 0) + (now - (Player.playStartTime || now)) / 1000;
                const totalDuration = (Player.currentPlaying && Player.currentPlaying.duration) ? Player.currentPlaying.duration : 300;

                if (Player.currentPlaying.bvid && currentElapsed >= totalDuration) {
                    Player.isPlaying = false;
                    const UI = MAERS.Music.UI;
                    if (UI && UI.playNext) UI.playNext();
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

        if (seekSlider) {
            seekSlider.onchange = () => {
                const totalDuration = (Player.currentPlaying && Player.currentPlaying.duration) ? Player.currentPlaying.duration : 300;
                const targetSeconds = Math.floor((seekSlider.value / 100) * totalDuration);
                const safeSeekTime = Math.max(2, targetSeconds);

                if (Player.currentPlaying && Player.currentPlaying.bvid) {
                    if (Player.frame) Player.frame.remove();
                    Player.frame = null;
                    ensurePlayerFrame();

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

    // Mount to namespace
    MAERS.Music.Player = Player;
    MAERS.Music.Player.playTrack = playTrack;
    MAERS.Music.Player.togglePlay = togglePlay;
    MAERS.Music.Player.showTip = showTip;

    // 🔧 全局函数包装器 (用于 HTML onclick 兼容性)
    global.remoteTogglePlay = () => MAERS.Music.Player && MAERS.Music.Player.togglePlay();

})(typeof window !== 'undefined' ? window : this);
