/**
 * MAERS Games Viewer - View Mode Engine
 * 管理 Playing / Played 视图切换
 * @version 1.2.0
 */

import { State } from '../../cms/viewer/cms-state.module.js';
import { Editor } from '../../cms/admin/cms-editor.module.js';
import { Recent } from '../../cms/viewer/cms-recent.module.js';
import { createGridItem } from '../../cms/viewer/render/cms-render-grid.module.js';

const MODES = {
    PLAYING: 'playing',
    PLAYED: 'played'
};

const LABELS = {
    playing: 'Playing',
    played: 'Played'
};

export const GamesView = {
    currentMode: MODES.PLAYING, // default: Playing view

    /** 初始化：注入 header 按钮并绑定模式 */
    init() {
        this._injectModeBtn();
        this._initPlayingSandbox();
        this._applyMode(this.currentMode);
    },

    /** 切换到指定模式 */
    setMode(mode) {
        if (mode === this.currentMode) return;
        this.currentMode = mode;
        this._applyMode(mode);
        this._refreshModeBtn();
    },

    // ─── Private ─────────────────────────────────────────────────────────────

    _applyMode(mode) {
        const gridContainer = document.getElementById('grid-container');
        const playingContainer = document.getElementById('playing-container');
        const breadcrumb = document.getElementById('breadcrumb');

        if (!gridContainer || !playingContainer) return;

        if (mode === MODES.PLAYED) {
            gridContainer.style.display = '';
            playingContainer.style.display = 'none';
            if (breadcrumb) breadcrumb.style.display = '';
        } else {
            gridContainer.style.display = 'none';
            playingContainer.style.display = 'flex';
            if (breadcrumb) breadcrumb.style.display = 'none';
        }
    },

    _injectModeBtn() {
        const titleEl = document.querySelector('.header-title');
        if (!titleEl || titleEl.querySelector('.games-mode-btn')) return;

        const btn = document.createElement('span');
        btn.className = 'games-mode-btn';
        btn.textContent = LABELS[this.currentMode];
        btn.title = '点击切换视图';
        btn.addEventListener('click', () => {
            const next = this.currentMode === MODES.PLAYED ? MODES.PLAYING : MODES.PLAYED;
            this.setMode(next);
        });

        const existingImg = titleEl.querySelector('img');
        if (existingImg && existingImg.nextSibling) {
            // Insert between icon and " Games" text: [icon] [Playing] [Games]
            titleEl.insertBefore(document.createTextNode(' '), existingImg.nextSibling);
            titleEl.insertBefore(btn, existingImg.nextSibling.nextSibling);
        } else {
            titleEl.appendChild(document.createTextNode(' '));
            titleEl.appendChild(btn);
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

        if (this._btnDraw) {
            this._btnDraw.addEventListener('click', () => this._drawGame());
        }

        // Restore last drawn game from localStorage
        const savedId = localStorage.getItem('maers_playing_game_id');
        if (savedId) {
            // Defer so State.AppState.allNodes is populated
            setTimeout(() => {
                const node = (State.AppState.allNodes || []).find(n => n.id === savedId);
                if (node) {
                    this._renderCard(node);
                } else {
                    this._renderCard(null);
                }
            }, 100);
        } else {
            this._renderCard(null);
        }
    },


    _renderCard(node) {
        if (!this._cardWrapper) return;
        this._cardWrapper.innerHTML = '';

        if (!node) {
            // Empty placeholder card
            const placeholder = document.createElement('div');
            placeholder.className = 'grid-item type-note placeholder-card';
            placeholder.innerHTML = `
                <div class="item-cover placeholder"></div>
            `;
            this._cardWrapper.appendChild(placeholder);
            return;
        }

        // Use CMS standard grid renderer
        const cardEl = createGridItem(node, State, -1);

        // Ensure images show immediately without waiting strictly on scrolling/IntersectionObserver layout thrash
        const img = cardEl.querySelector('img');
        if (img && img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute('data-src');
        }

        // Bind standard interaction matching CMS delegation
        cardEl.addEventListener('click', (e) => {
            if (State.IS_ADMIN) return; // Prevent raw click in admin context if it ever leaks
            e.stopPropagation();
            if (Recent && Recent.addToHistory) Recent.addToHistory(node);
            if (Editor && Editor.open) Editor.open(node);
        });

        this._cardWrapper.appendChild(cardEl);
    },

    _drawGame() {
        const nodes = (State.AppState.allNodes || []).filter(n => n.type === 'note');
        if (nodes.length === 0) return;

        const randomNode = nodes[Math.floor(Math.random() * nodes.length)];

        // Disable button and show loading state for 2s
        if (this._btnDraw) {
            this._btnDraw.disabled = true;
            this._btnDraw.textContent = '抽取中...';
        }

        setTimeout(() => {
            // Render card after 2s
            this._renderCard(randomNode);

            // Save to localStorage so next visit restores it
            try {
                localStorage.setItem('maers_playing_game_id', randomNode.id);
            } catch (e) {
                console.warn('[GamesView] localStorage unavailable', e);
            }

            if (this._btnDraw) {
                this._btnDraw.disabled = false;
                this._btnDraw.textContent = '随机抽取';
            }
        }, 2000);
    }
};
