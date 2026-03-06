/**
 * MAERS Games Viewer - View Mode Engine
 * 管理 Playing / Played 视图切换
 * @version 1.3.0
 */

import { State } from '../../cms/viewer/cms-state.module.js';
import { Editor } from '../../cms/admin/cms-editor.module.js';
import { Recent } from '../../cms/viewer/cms-recent.module.js';
import { createGridItem } from '../../cms/viewer/render/cms-render-grid.module.js';

const MODES = { PLAYING: 'playing', PLAYED: 'played' };
const LABELS = { playing: 'Playing', played: 'Played' };

// Animation config — tuned for best feel
const ANIM_FRAME_COUNT = 10;  // exactly 10 unique covers for a controlled sequential draw
const ANIM_DURATION = 1000; // 1s: quick and decisive

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

    // ─── Private ─────────────────────────────────────────────────────────────

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
                    <div class="folder-grid playing-grid" id="playing-card-wrapper"></div>
                    <button id="btn-draw-game" class="btn-draw-game">随机抽取</button>
                </div>
            </div>
        `;

        this._cardWrapper = document.getElementById('playing-card-wrapper');
        this._btnDraw = document.getElementById('btn-draw-game');
        this._btnDraw?.addEventListener('click', () => this._drawGame());

        // Restore last result from localStorage
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

        // Force lazy-loaded image to resolve immediately (not waiting on IntersectionObserver)
        const img = cardEl.querySelector('img');
        if (img?.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
        }

        cardEl.addEventListener('click', (e) => {
            if (this._isAnimating || State.IS_ADMIN) return;
            e.stopPropagation();
            Recent?.addToHistory(node);
            Editor?.open(node);
        });

        this._cardWrapper.appendChild(cardEl);
    },

    // ─── Animation helpers ────────────────────────────────────────────────────

    _getCoverUrl(node) {
        if (!node.coverImage) return null;
        const basename = node.coverImage.split('/').pop().replace(/\.[^/.]+$/, '');
        return `photos/previews/gamecovers/${basename}.avif`;
    },

    // Build (or refresh) the invisible DOM frame stack for opacity-swap animation
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

        // Pick ANIM_FRAME_COUNT unique random nodes without repetition
        const pool = [...notes];
        const count = Math.min(ANIM_FRAME_COUNT, pool.length);
        for (let i = 0; i < count; i++) {
            const idx = Math.floor(Math.random() * pool.length);
            const [node] = pool.splice(idx, 1);
            const url = this._getCoverUrl(node);
            if (!url) continue;

            const img = new Image();
            img.src = url; // Trigger browser fetch & decode
            img.style.cssText =
                'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;';
            this._animContainer.appendChild(img);
        }
    },

    _drawGame() {
        if (this._isAnimating) return;

        const allNotes = (State.AppState.allNodes || []).filter(n => n.type === 'note');
        if (!allNotes.length) return;

        this._isAnimating = true;

        if (this._cardWrapper) {
            const cardEl = this._cardWrapper.querySelector('.grid-item');
            if (cardEl) cardEl.classList.add('is-animating');
        }

        this._btnDraw.disabled = true;
        this._btnDraw.textContent = '抽取中...';

        // Pick winner now; preload its image immediately
        const winner = allNotes[Math.floor(Math.random() * allNotes.length)];
        const winnerUrl = this._getCoverUrl(winner);
        if (winnerUrl) new Image().src = winnerUrl;

        // Attach the anim frame stack onto the existing card's cover div
        const imgs = this._animContainer ? [...this._animContainer.children] : [];
        if (imgs.length) {
            const coverDiv = this._cardWrapper.querySelector('.item-cover');
            if (coverDiv) {
                coverDiv.appendChild(this._animContainer);
                this._animContainer.style.opacity = '1';
                // Hide the static underlying card image to eliminate ghosting
                const baseImg = coverDiv.querySelector('.item-cover-img');
                if (baseImg) baseImg.style.opacity = '0';
            }
        }

        // ── Tick loop ──────────────────────────────────────────────────────────
        let frameCount = 0;
        let currentIdx = -1;

        const tick = () => {
            if (frameCount >= 10) {
                // Remove the animation stack immediately and render an empty placeholder card
                if (this._animContainer) this._animContainer.style.opacity = '0';
                this._renderCard(null);

                // Wait 0.2s showing the blank placeholder before "snapping" the final winner into place
                setTimeout(() => {
                    this._isAnimating = false;

                    this._btnDraw.disabled = false;
                    this._btnDraw.textContent = '随机抽取';

                    this._renderCard(winner);
                    try { localStorage.setItem('maers_playing_game_id', winner.id); } catch { }

                    // Refresh frame pool silently for next draw
                    this._preloadCovers();
                }, 200);

                return;
            }

            // Flip frames sequentially without random selection to guarantee no repeats
            if (imgs.length) {
                if (currentIdx >= 0 && imgs[currentIdx]) imgs[currentIdx].style.opacity = '0';
                currentIdx = frameCount % imgs.length; // guaranteed 0 through 9
                if (imgs[currentIdx]) imgs[currentIdx].style.opacity = '1';
            }

            // Exactly 10 frames distributed in a 5, 3, 2 cadence to resolve in exactly 1000ms
            let delay;
            if (frameCount < 5) delay = 60;        // Initial 5 frames: 60ms each (fast blur) = 300ms
            else if (frameCount < 8) delay = 100;  // Next 3 frames: 100ms each (slowing down) = 300ms
            else delay = 200;                      // Final 2 frames: 200ms each (heavy drama) = 400ms

            frameCount++;
            setTimeout(tick, delay);
        };

        tick(); // kick off instantly
    }
};
