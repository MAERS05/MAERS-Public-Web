/**
 * MAERS 游戏视图与随机抽取
 * 管理 Playing / Played 切换、封面预载与抽取动画
 * @version 1.3.0
 */

import { State } from '../../cms/viewer/cms-state.module.js';
import { Reader } from '../../cms/viewer/cms-reader.module.js';
import { Recent } from '../../cms/viewer/cms-recent.module.js';
import { createGridItem } from '../../cms/viewer/render/cms-render-grid.module.js';
import { DataProvider } from '../../../data-manage/data-provider.module.js';

const MODES = { PLAYING: 'playing', PLAYED: 'played' };
const LABELS = { playing: 'Playing', played: 'Played' };

// 十帧按快、中、慢三段播放，总时长一秒。
const ANIM_FRAME_COUNT = 10;
const ANIM_DURATION = 1000;

function runCoverAnimation(images, onComplete) {
    let frame = 0;
    let currentIdx = -1;
    const tick = () => {
        if (frame >= ANIM_FRAME_COUNT) {
            onComplete();
            return;
        }
        if (images.length) {
            if (currentIdx >= 0) images[currentIdx].style.opacity = '0';
            currentIdx = frame % images.length;
            images[currentIdx].style.opacity = '1';
        }
        const durationRatio = frame < 5 ? 0.06 : frame < 8 ? 0.1 : 0.2;
        frame++;
        setTimeout(tick, ANIM_DURATION * durationRatio);
    };
    tick();
}

export const GamesView = {
    currentMode: MODES.PLAYING,
    _isAnimating: false,
    _animContainer: null,

    init() {
        this._injectModeBtn();
        this._initPlayingSandbox();
        this._applyMode(this.currentMode);
        setTimeout(() => this._preloadCovers(), 500);
    },

    setMode(mode) {
        if (mode === this.currentMode) return;
        this.currentMode = mode;
        this._applyMode(mode);
        this._refreshModeBtn();
    },

    // 视图切换与卡片渲染

    _applyMode(mode) {
        const grid = document.getElementById('grid-container');
        const playing = document.getElementById('playing-container');
        const breadcrumb = document.getElementById('breadcrumb');
        if (!grid || !playing) return;

        const isPlaying = mode === MODES.PLAYING;
        grid.style.display = isPlaying ? 'none' : '';
        playing.style.display = isPlaying ? 'flex' : 'none';
        if (breadcrumb) breadcrumb.style.display = isPlaying ? 'none' : '';
    },

    _injectModeBtn() {
        const titleEl = document.querySelector('.header-title');
        if (!titleEl || titleEl.querySelector('.games-mode-btn')) return;

        const btn = document.createElement('span');
        btn.className = 'games-mode-btn';
        btn.textContent = LABELS[this.currentMode];
        btn.title = '点击切换视图';
        btn.addEventListener('click', () => {
            this.setMode(this.currentMode === MODES.PLAYED ? MODES.PLAYING : MODES.PLAYED);
        });

        const icon = titleEl.querySelector('img');
        if (icon?.nextSibling) {
            titleEl.insertBefore(document.createTextNode(' '), icon.nextSibling);
            titleEl.insertBefore(btn, icon.nextSibling.nextSibling);
        } else {
            titleEl.append(document.createTextNode(' '), btn);
        }
    },

    _refreshModeBtn() {
        const btn = document.querySelector('.games-mode-btn');
        if (btn) btn.textContent = LABELS[this.currentMode];
    },

    _initPlayingSandbox() {
        const container = document.getElementById('playing-container');
        if (!container) return;

        container.innerHTML = `
            <div class="playing-sandbox">
                <div class="playing-card-group">
                    <div class="playing-label">今日玩:</div>
                    <div class="folder-grid playing-grid" id="playing-card-wrapper"></div>
                    <button id="btn-draw-game" class="btn-draw-game">抽一下</button>
                </div>
            </div>
        `;

        this._cardWrapper = document.getElementById('playing-card-wrapper');
        this._btnDraw = document.getElementById('btn-draw-game');
        this._btnDraw?.addEventListener('click', () => this._drawGame());

        // 恢复上一次抽取结果
        const savedId = localStorage.getItem('maers_playing_game_id');
        if (savedId) {
            setTimeout(() => {
                const node = (State.AppState.allNodes || []).find(n => n.id === savedId);
                this._renderCard(node || null);
            }, 100);
        } else {
            this._renderCard(null);
        }
    },

    _renderCard(node) {
        if (!this._cardWrapper) return;
        this._cardWrapper.innerHTML = '';

        if (!node) {
            const placeholder = document.createElement('div');
            placeholder.className = 'grid-item type-note placeholder-card';
            placeholder.innerHTML = `<div class="item-cover placeholder"></div>`;
            this._cardWrapper.appendChild(placeholder);
            return;
        }

        const cardEl = createGridItem(node, State, -1);

        // 抽取结果立即加载封面
        const img = cardEl.querySelector('img');
        if (img?.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
        }

        cardEl.addEventListener('click', (e) => {
            if (this._isAnimating || State.IS_ADMIN) return;
            e.stopPropagation();
            Recent?.addToHistory(node);
            Reader?.open(node);
        });

        this._cardWrapper.appendChild(cardEl);
    },

    // 封面预载与抽取动画

    _getCoverUrl(node) {
        return DataProvider.getCoverUrl(node, 'thumb');
    },

    // 构建不可见的封面帧栈，抽取时只切换透明度
    _preloadCovers() {
        const notes = (State.AppState.allNodes || []).filter(n => n.type === 'note' && n.coverImage);
        if (!notes.length) return;

        if (!this._animContainer) {
            this._animContainer = document.createElement('div');
            this._animContainer.id = 'playing-anim-box';
            this._animContainer.style.cssText =
                'position:absolute;inset:0;opacity:0;pointer-events:none;z-index:10;';
        }
        this._animContainer.innerHTML = '';

        // 随机选出不重复的封面
        const pool = [...notes];
        const count = Math.min(ANIM_FRAME_COUNT, pool.length);
        for (let i = 0; i < count; i++) {
            const idx = Math.floor(Math.random() * pool.length);
            const [node] = pool.splice(idx, 1);
            const url = this._getCoverUrl(node);
            if (!url) continue;

            const img = new Image();
            img.src = url; // 提前请求并解码封面
            img.style.cssText =
                'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;';
            this._animContainer.appendChild(img);
        }
    },

    _setDrawing(drawing) {
        this._isAnimating = drawing;
        const card = this._cardWrapper?.querySelector('.grid-item');
        card?.classList.toggle('is-animating', drawing);
        if (this._btnDraw) {
            this._btnDraw.disabled = drawing;
            this._btnDraw.textContent = drawing ? '抽取中...' : '抽一下';
        }
    },

    _attachAnimation() {
        const images = this._animContainer ? [...this._animContainer.children] : [];
        const cover = this._cardWrapper?.querySelector('.item-cover');
        if (images.length && cover) {
            cover.appendChild(this._animContainer);
            this._animContainer.style.opacity = '1';
            const baseImg = cover.querySelector('.item-cover-img');
            if (baseImg) baseImg.style.opacity = '0';
        }
        return images;
    },

    _finishDraw(winner) {
        if (this._animContainer) this._animContainer.style.opacity = '0';
        this._renderCard(null);
        // 保留半秒空白停顿，再显示并保存最终结果。
        setTimeout(() => {
            this._setDrawing(false);
            this._renderCard(winner);
            try { localStorage.setItem('maers_playing_game_id', winner.id); } catch { }
            this._preloadCovers();
        }, 500);
    },

    _drawGame() {
        if (this._isAnimating) return;
        const notes = (State.AppState.allNodes || []).filter(node => node.type === 'note');
        if (!notes.length) return;

        this._setDrawing(true);
        const winner = notes[Math.floor(Math.random() * notes.length)];
        const winnerUrl = this._getCoverUrl(winner);
        if (winnerUrl) new Image().src = winnerUrl;
        runCoverAnimation(this._attachAnimation(), () => this._finishDraw(winner));
    }
};
