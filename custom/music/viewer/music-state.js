/**
 * MAERS Music State (music-state.js)
 * 播放状态记忆插件
 * 依赖: MAERS.Music.Player, MAERS.Music.UI
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.Music = MAERS.Music || {};

    const STORAGE_KEY = 'music_player_last_state';
    console.log("[MAERS.Music.State] 💾 Memory Plugin Loaded");

    // ================= 1. 状态保存逻辑 =================

    function saveState() {
        try {
            const Player = MAERS.Music.Player || {};
            const playing = Player.currentPlaying || {};
            if (!playing.bvid) return;

            // 1. 清理文字后缀
            let rawText = document.querySelector('.header-playing-info .scroll-text')?.innerText || "";
            let cleanText = rawText.replace(/(\s*\(已暂停\))+$/g, '');

            // 2. 计算真实进度
            let realTime = Player.playedSeconds || 0;
            if (Player.isPlaying && Player.playStartTime) {
                realTime += (Date.now() - Player.playStartTime) / 1000;
            }

            const UI = MAERS.Music.UI || {};
            const state = {
                playing: playing,
                time: realTime,
                timestamp: Date.now(),

                nav: {
                    level: UI.currentLevel || 0,
                    cat: UI.currentCatIndex || 0,
                    col: UI.currentColIndex || 0,
                    alb: UI.currentAlbIndex || 0
                },

                ui: {
                    infoText: cleanText
                }
            };

            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) {
            // 忽略报错
        }
    }

    // 定时保存
    setInterval(() => {
        const Player = MAERS.Music.Player || {};
        if (Player.isPlaying) {
            saveState();
        }
    }, 2000);

    window.addEventListener('beforeunload', saveState);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveState();
    });

    // ================= 2. 状态恢复逻辑 =================

    window.addEventListener('load', () => {
        setTimeout(restoreState, 500);
    });

    function restoreState() {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;

        try {
            const state = JSON.parse(raw);
            const Player = MAERS.Music.Player || {};
            const UI = MAERS.Music.UI || {};

            let targetCat = 0, targetCol = 0, targetLevel = 0;

            if (state.playing && state.playing.bvid) {
                targetCat = state.playing.catIdx;
                targetCol = state.playing.colIdx;
                targetLevel = 2;
            } else if (state.nav) {
                targetCat = state.nav.cat;
                targetCol = state.nav.col;
                targetLevel = state.nav.level;
            }

            // 同步全局索引
            if (UI.currentCatIndex !== undefined) UI.currentCatIndex = targetCat;
            if (UI.currentColIndex !== undefined) UI.currentColIndex = targetCol;
            if (UI.currentAlbIndex !== undefined) UI.currentAlbIndex = state.playing?.albIdx || 0;

            // 执行 UI 跳转
            if (UI.enterLevel1) {
                if (targetLevel >= 1) {
                    UI.enterLevel1(targetCat);
                    if (targetLevel >= 2 && UI.enterLevel2) {
                        setTimeout(() => {
                            UI.enterLevel2(targetCat, targetCol);
                        }, 100);
                    }
                } else if (UI.goBack) {
                    UI.goBack(0);
                }
            }

            // B. 恢复播放器状态
            if (state.playing && state.playing.bvid) {
                if (Player.currentPlaying) {
                    Object.assign(Player.currentPlaying, state.playing);
                    Player.playedSeconds = state.time || 0;
                }

                const duration = state.playing.duration || 300;
                const seekSlider = document.getElementById('seek-slider');
                const currLabel = document.getElementById('curr-time');
                const totalLabel = document.getElementById('total-time');

                if (seekSlider) seekSlider.value = ((Player.playedSeconds || 0) / duration) * 100;
                if (currLabel) currLabel.innerText = formatTime(Player.playedSeconds || 0);
                if (totalLabel) totalLabel.innerText = formatTime(duration);

                if (state.ui && state.ui.infoText) {
                    let text = state.ui.infoText.replace(/(\s*\(已暂停\))+$/g, '');
                    const headerInfo = document.querySelectorAll('.header-playing-info');
                    headerInfo.forEach(el => {
                        el.innerHTML = `<span class="scroll-text" style="opacity:0.7">${text} (已暂停)</span>`;
                        el.classList.add('show');
                    });
                }

                const jumpLink = document.getElementById('jump-link');
                if (jumpLink) {
                    jumpLink.href = `https://www.bilibili.com/video/${state.playing.bvid}?p=${state.playing.page}`;
                    jumpLink.style.display = 'block';
                }

                setTimeout(() => {
                    highlightCurrentItem(state.playing.albIdx);
                }, 600);
            }

        } catch (e) {
            console.error("[MAERS.Music.State] Restoring state failed:", e);
        }
    }

    function highlightCurrentItem(albIdx) {
        const item = document.querySelector(`.album-item[data-idx="${albIdx}"]`);
        if (item) item.classList.add('playing');
        if (item) item.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function formatTime(s) {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }

    // ================= 3. 清除状态逻辑 =================

    function clearState() {
        localStorage.removeItem(STORAGE_KEY);
        console.log("[MAERS.Music.State] 🗑️ Player state cleared");

        // 重置播放器状态
        const Player = MAERS.Music.Player || {};
        if (Player.currentPlaying) {
            Player.currentPlaying = { bvid: null, page: 0, total: 0, catIdx: -1, colIdx: -1, albIdx: -1 };
            Player.playedSeconds = 0;
            Player.isPlaying = false;
        }

        // 清除 UI 状态
        const seekSlider = document.getElementById('seek-slider');
        const currLabel = document.getElementById('curr-time');
        const totalLabel = document.getElementById('total-time');
        if (seekSlider) seekSlider.value = 0;
        if (currLabel) currLabel.innerText = '00:00';
        if (totalLabel) totalLabel.innerText = '00:00';

        // 隐藏播放信息
        document.querySelectorAll('.header-playing-info').forEach(el => {
            el.innerHTML = '';
            el.classList.remove('show');
        });

        // 隐藏跳转和还原按钮
        const jumpLink = document.getElementById('jump-link');
        const resetLink = document.getElementById('reset-link');
        if (jumpLink) jumpLink.style.display = 'none';
        if (resetLink) resetLink.style.display = 'none';

        // 移除播放高亮
        document.querySelectorAll('.playing').forEach(el => el.classList.remove('playing'));

        // 隐藏暂停提示
        const tip = document.getElementById('next-tip');
        if (tip) tip.style.display = 'none';

        // 重置封面
        const cover = document.getElementById('video-cover');
        const frame = document.getElementById('bili-frame');
        if (cover) cover.style.opacity = '1';
        if (frame) {
            frame.src = '';
            frame.style.opacity = '0';
        }

        // 重置耳机动画
        const icon = document.querySelector('.right-icon');
        if (icon) {
            icon.classList.remove('beating', 'paused');
        }

        // 提示用户
        if (MAERS.Music.Player && MAERS.Music.Player.showTip) {
            MAERS.Music.Player.showTip('记忆已清除');
        }
    }

    // ================= 4. 按钮可见性控制 =================

    function updateResetButtonVisibility() {
        const Player = MAERS.Music.Player || {};
        const jumpLink = document.getElementById('jump-link');
        const resetLink = document.getElementById('reset-link');
        const hasSavedState = localStorage.getItem(STORAGE_KEY);

        if (!resetLink) return;

        // 播放时：显示跳转按钮，隐藏还原按钮
        // 暂停时：隐藏跳转按钮，显示还原按钮（如果有保存的状态）
        if (Player.isPlaying) {
            if (jumpLink) jumpLink.style.display = 'block';
            resetLink.style.display = 'none';
        } else {
            if (jumpLink) jumpLink.style.display = 'none';
            // 只有有保存状态时才显示还原按钮
            resetLink.style.display = hasSavedState ? 'block' : 'none';
        }
    }

    // 监听播放状态变化
    setInterval(updateResetButtonVisibility, 500);

    // 绑定还原按钮点击事件
    document.addEventListener('DOMContentLoaded', () => {
        const resetLink = document.getElementById('reset-link');
        if (resetLink) {
            resetLink.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                clearState();
            });
        }
        // 初始化按钮可见性
        updateResetButtonVisibility();
    });

    // Mount to namespace
    MAERS.Music.State = {
        saveState,
        clearState,
        restoreState,
        formatTime
    };

})(typeof window !== 'undefined' ? window : this);
