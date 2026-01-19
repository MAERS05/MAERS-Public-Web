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
        frame: null,
        wakeLock: null,           // Screen Wake Lock (防止标签页休眠)
        keepAliveAudio: null      // 虚拟音频元素 (后备方案)
    };

    /**
     * 创建或获取 Bilibili player iframe
     * 自动处理主窗口和小窗容器的查找
     * @returns {HTMLIFrameElement}
     */
    function ensurePlayerFrame() {
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

    function showTip(msg) {
        const nextTip = document.getElementById('next-tip');
        if (nextTip) {
            nextTip.textContent = msg;
            nextTip.style.display = 'block';
            nextTip.style.zIndex = '9999';
            setTimeout(() => nextTip.style.display = 'none', 1200);
        }
    }

    /**
     * 🎵 启用后台播放保持机制
     * 使用 Wake Lock API (主方案) + 虚拟音频 (后备方案)
     */
    async function enableBackgroundPlayback() {
        // 方案一：Wake Lock API (需要 HTTPS)
        if ('wakeLock' in navigator) {
            try {
                Player.wakeLock = await navigator.wakeLock.request('screen');
                console.log('✅ Wake Lock 已启用 - 后台播放已保护');
                
                // 监听 Wake Lock 释放事件 (例如标签页最小化)
                Player.wakeLock.addEventListener('release', () => {
                    console.log('⚠️ Wake Lock 已释放');
                });
            } catch (err) {
                console.warn('⚠️ Wake Lock 请求失败:', err.message);
            }
        }

        // 方案二：虚拟音频保活 (后备方案，兼容性更好)
        if (!Player.keepAliveAudio) {
            Player.keepAliveAudio = document.getElementById('keep-alive-audio');
        }
        
        if (Player.keepAliveAudio) {
            try {
                // 设置极低音量并开始循环播放
                Player.keepAliveAudio.volume = 0.01;
                await Player.keepAliveAudio.play();
                console.log('✅ 虚拟音频已启动 - 标签页保活');
            } catch (err) {
                console.warn('⚠️ 虚拟音频启动失败:', err.message);
            }
        }
    }

    /**
     * 🔇 禁用后台播放保持机制
     */
    async function disableBackgroundPlayback() {
        // 释放 Wake Lock
        if (Player.wakeLock) {
            try {
                await Player.wakeLock.release();
                Player.wakeLock = null;
                console.log('🔓 Wake Lock 已释放');
            } catch (err) {
                console.warn('⚠️ Wake Lock 释放失败:', err);
            }
        }

        // 停止虚拟音频
        if (Player.keepAliveAudio && !Player.keepAliveAudio.paused) {
            Player.keepAliveAudio.pause();
            console.log('🔇 虚拟音频已停止');
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

        // 🎵 启用后台播放保活
        enableBackgroundPlayback();

        const pipBtn = document.querySelector('.pip-float-btn');
        if (pipBtn) pipBtn.style.display = 'flex';
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

            // 🔇 禁用后台播放保活（暂停时释放资源）
            disableBackgroundPlayback();

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

                // 🎵 重新启用后台播放保活
                enableBackgroundPlayback();

                const pipBtn = document.querySelector('.pip-float-btn');
                if (pipBtn) pipBtn.style.display = 'flex';
            }
        }
    }
    
    async function togglePictureInPicture() {
        if (!Player.currentPlaying || !Player.currentPlaying.bvid) { showTip("未播放歌曲"); return; }
        
        // 尝试使用 Document Picture-in-Picture API
        if ('documentPictureInPicture' in window) {
            try {
                if (window.documentPictureInPicture.window) {
                    window.documentPictureInPicture.window.close();
                    return;
                }

                const playerContainer = document.querySelector('.bili-monitor');
                const controlBar = document.querySelector('.custom-control-bar');
                if (!playerContainer || !controlBar) return;

                // ⏸️ 切换前准备 (仅保存进度并停止音频，核心 URL 更新推迟到移动后)
                let pausedSrc = null;

                if (Player.isPlaying) {
                    const now = Date.now();
                    Player.playedSeconds += (now - Player.playStartTime) / 1000; // 保存进度
                    const seekTime = Math.floor(Player.playedSeconds);
                    
                    // 构造新的不自动播放 URL
                    pausedSrc = `https://player.bilibili.com/player.html?isOutside=true&bvid=${Player.currentPlaying.bvid}&page=${Player.currentPlaying.page}&high_quality=1&danmaku=0&autoplay=0&t=${seekTime}`;
                    
                    Player.isPlaying = false; // 更新状态
                    
                    // 更新播放按钮UI
                    const masterPlayBtn = document.getElementById('master-play-btn');
                    if (masterPlayBtn) masterPlayBtn.classList.remove('is-playing');
                    
                    // 禁用保活
                    disableBackgroundPlayback();
                }

                // 计算所需窗口大小 (给足够的高度，特别是给控制条留足空间)
                const width = Math.max(playerContainer.clientWidth, 600); // 最小宽度
                const height = playerContainer.clientHeight + controlBar.clientHeight + 100; // 增加额外缓冲

                // 打开 PiP 窗口
                const pipWindow = await window.documentPictureInPicture.requestWindow({
                    width: width,
                    height: height
                });

                // 🌟 1. 样式继承 (复制样式表)
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

                // 🌟 2. 环境继承 (直接赋予主窗口能力)
                pipWindow.playNext = window.playNext || MAERS.Music.Control.playNext;
                pipWindow.playPrev = window.playPrev || MAERS.Music.Control.playPrev;
                pipWindow.remoteTogglePlay = togglePlay;
                pipWindow.togglePictureInPicture = togglePictureInPicture;
                pipWindow.MAERS = window.MAERS;

                // 设置 PiP 窗口基础样式
                pipWindow.document.body.className = document.body.className; // 继承 dark/light mode
                Object.assign(pipWindow.document.body.style, {
                    display: 'flex',
                    flexDirection: 'column',
                    background: '#0a0a0a',
                    margin: '0',
                    padding: '0', // 移除 padding 避免挤压
                    overflow: 'hidden',
                    height: '100vh' // 确保占满全高
                });
                
                // 强制控制条不被压缩
                controlBar.style.flexShrink = '0';
                controlBar.style.marginTop = 'auto'; // 推到底部
                controlBar.style.width = '100%';
                controlBar.style.boxSizing = 'border-box';
                playerContainer.style.flex = '1'; // 视频占据剩余空间
                playerContainer.style.minHeight = '0'; // 允许视频缩小适应窗口

                // 🌟 3. DOM 移动
                pipWindow.document.body.appendChild(playerContainer);
                pipWindow.document.body.appendChild(controlBar);

                // 🌟 4. 强制应用暂停状态 (移动后立即设置 src，确保加载的是暂停版)
                if (pausedSrc && Player.frame) {
                    // 给一个小延迟确保 iframe 在新文档就绪
                    setTimeout(() => {
                         Player.frame.src = pausedSrc;
                    }, 10);
                }

                // 监听窗口关闭，恢复原位
                pipWindow.addEventListener("pagehide", (event) => {
                    const monitorSection = document.querySelector('.monitor-section');
                    if (monitorSection) {
                        // ⏸️ 退出小窗时自动暂停 (保存进度并停止音频)
                        if (Player.isPlaying) {
                            const now = Date.now();
                            Player.playedSeconds += (now - Player.playStartTime) / 1000; // 保存进度
                            const seekTime = Math.floor(Player.playedSeconds);
                            
                            // 更新 iframe src 不自动播放 (注意：此时 iframe 还在小窗里，或者即将被移动)
                            // 我们先在移动前强制暂停它
                            Player.frame.src = `https://player.bilibili.com/player.html?isOutside=true&bvid=${Player.currentPlaying.bvid}&page=${Player.currentPlaying.page}&high_quality=1&danmaku=0&autoplay=0&t=${seekTime}`;
                            
                            Player.isPlaying = false; // 更新状态
                            
                            // 更新播放按钮UI
                            const masterPlayBtn = document.getElementById('master-play-btn');
                            if (masterPlayBtn) masterPlayBtn.classList.remove('is-playing');
                            
                            // 禁用保活
                            disableBackgroundPlayback();
                        }

                        // 恢复视频容器
                        monitorSection.prepend(playerContainer);
                        // 恢复控制条
                        monitorSection.appendChild(controlBar);
                        
                        // 清理临时样式
                        controlBar.style.flexShrink = '';
                        controlBar.style.marginTop = '';
                        controlBar.style.width = '';
                        playerContainer.style.flex = '';
                        playerContainer.style.minHeight = '';
                    }
                });

            } catch (err) {
                console.error("PiP failed:", err);
                showTip("画中画启动失败");
            }
        } else {
             // 后备方案
             if (Player.frame && Player.frame.requestPictureInPicture) {
                try {
                    await Player.frame.requestPictureInPicture();
                } catch(e) {
                    showTip("浏览器不支持画中画");
                }
             } else {
                 showTip("浏览器不支持画中画");
             }
        }
    }
    
    // 进度条与自动切歌监控
    document.addEventListener('DOMContentLoaded', () => {
        const seekSlider = document.getElementById('seek-slider');
        const masterPlayBtn = document.getElementById('master-play-btn');
        const currTimeLabel = document.getElementById('curr-time');
        const pipBtn = document.querySelector('.pip-float-btn');

        // 绑定事件：避免使用全局 onclick 污染
        if (pipBtn) {
            pipBtn.onclick = null; // 清除 HTML 属性绑定
            pipBtn.addEventListener('click', togglePictureInPicture);
        }
        
        // 绑定主要播放按钮
        if (masterPlayBtn) {
            masterPlayBtn.onclick = null;
            masterPlayBtn.addEventListener('click', togglePlay);
        }

        // 🎵 添加后台切歌待播放标志
        let pendingAutoplay = false;

        setInterval(() => {
            if (Player.isPlaying) {
                const now = Date.now();
                const currentElapsed = (Player.playedSeconds || 0) + (now - (Player.playStartTime || now)) / 1000;
                const totalDuration = (Player.currentPlaying && Player.currentPlaying.duration) ? Player.currentPlaying.duration : 300;

                if (Player.currentPlaying.bvid && currentElapsed >= totalDuration) {
                    Player.isPlaying = false;
                    const UI = MAERS.Music.UI;
                    
                    // 如果页面隐藏，设置待播放标志
                    if (document.hidden) {
                        console.log('⚠️ 后台自动切歌，等待页面可见时播放');
                        pendingAutoplay = true;
                        Player.isPlaying = true; // 保持播放状态
                    }
                    
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

        // 🎵 监听页面可见性变化
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && pendingAutoplay && Player.currentPlaying && Player.currentPlaying.bvid) {
                console.log('🎵 页面可见，触发待播放的歌曲');
                
                // 强制重新加载 iframe 开始播放
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
                    
                    // 🌟 简化逻辑：直接由 ensurePlayerFrame 负责找到正确容器
                    ensurePlayerFrame();

                    Player.playedSeconds = safeSeekTime;
                    const randomTs = Date.now();

                    if (Player.isPlaying) {
                        Player.playStartTime = Date.now();
                        Player.frame.src = `https://player.bilibili.com/player.html?isOutside=true&bvid=${Player.currentPlaying.bvid}&page=${Player.currentPlaying.page}&high_quality=1&danmaku=0&autoplay=1&t=${safeSeekTime}&_=${randomTs}`;
                    } else {
                        // 如果暂停状态下拖动，保持暂停
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
    MAERS.Music.Player.togglePictureInPicture = togglePictureInPicture;
    // showTip is internal, no longer exposed unless needed? 
    // If other modules invalidly used it, it might break. 
    // Let's expose it just in case since other files might rely on MAERS.Music.Player.showTip if it was there before?
    // User asked to OPTIMIZE namespaces, usually meaning hiding internals. I'll hide it for now unless I see external usage.
    // Wait, music-control.js used check Player.showTip! (Step 193: Player.showTip('xxx'))
    // So I MUST expose it.
    MAERS.Music.Player.showTip = showTip;

    // 🔧 兼容性：尽可能清理全局，但保留必要的 HTML onclick 兼容
    // 如果 HTML 文件里写了 onclick="remoteTogglePlay()"，我们又不能改 HTML，就必须保留 global 挂载。
    // 但我们会尝试在 DOMContentLoaded 里清理掉 binding (above)，所以这里保留 global 定义作为 fallback 是安全的。
    global.remoteTogglePlay = togglePlay; 
    global.togglePictureInPicture = togglePictureInPicture;
    // playNext/playPrev are in music-control.js

})(typeof window !== 'undefined' ? window : this);
