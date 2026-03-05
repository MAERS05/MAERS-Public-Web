/**
 * MAERS Games Viewer - View Mode Engine
 * 管理 Playing / Played 视图切换
 * @version 1.1.0
 */

const MODES = {
    PLAYING: 'playing',
    PLAYED: 'played'
};

const LABELS = {
    playing: 'Playing',
    played: 'Played'
};

export const GamesView = {
    currentMode: MODES.PLAYED, // default: Played (grid view)

    /** 初始化：注入 header 按钮并绑定模式 */
    init() {
        this._injectModeBtn();
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
            playingContainer.style.display = '';
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
    }
};
