/**
 * @module custom/literature/viewer/flow/literature-flow-engine.module.js
 * @description Literature Flow - 核心引擎类
 * @version 1.0.0 - ES6 Module
 */

import { loadBooksFromBackend, promoteBook, saveFlowOrder } from './literature-flow-data.module.js';
import { updateMetrics, generateBooks, startLoop } from './literature-flow-render.module.js';

// 阅读器由文学入口注入。
let Reader = null;

export function setEditor(editor) {
    Reader = editor;
}

export class FlowEngine {
    constructor() {
        this.container = document.getElementById('path-container');
        this.viewport = document.getElementById('viewport') || document.body;
        this.breadcrumb = document.getElementById('breadcrumb');
        this.modeBtn = document.getElementById('btn-toggle-mode');
        this.modeText = document.getElementById('mode-text');

        this.isGridMode = false;

        this.state = {
            scrollOffset: 0,
            autoScrollSpeed: 0.6,
            isPaused: false
        };

        this.books = [];
        this.rafId = null;

        this.config = {
            cardWidth: 140,
            cardHeight: 210,
            spacing: 180,
            paddingY: 100,
            rowHeight: 280
        };

        this.allBooksSource = [];
        this.realBooks = [];
    }

    async loadBooksFromBackend() {
        return await loadBooksFromBackend(this);
    }

    updateMetrics() {
        updateMetrics(this);
    }

    generateBooks() {
        generateBooks(this, (card) => this.openBookEditor(card));
    }

    promoteBook(node) {
        promoteBook(this, node);
    }

    setupEvents() {
        if (this.modeBtn) {
            this.modeBtn.addEventListener('click', () => this.toggleMode());
        }

        window.addEventListener('resize', () => {
            this.updateMetrics();
            this.generateBooks();
        });

        this.viewport.addEventListener('wheel', (e) => {
            if (this.isGridMode) return;
            e.preventDefault();
            this.state.scrollOffset += e.deltaY * 0.5;
        }, { passive: false });
    }

    setupEditorCloseListener() {
        const immersiveReader = document.getElementById('immersive-reader');
        if (!immersiveReader) return;

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.attributeName !== 'class') continue;
                if (!immersiveReader.classList.contains('active')) this.resumeAnimation();
            }
        });

        observer.observe(immersiveReader, {
            attributes: true,
            attributeFilter: ['class']
        });
    }

    setMode(mode) {
        const shouldToggle = (mode === 'grid' && !this.isGridMode) || (mode === 'gallery' && this.isGridMode);
        if (shouldToggle) this.toggleMode();
    }

    toggleMode() {
        this.isGridMode = !this.isGridMode;
        if (this.modeText) this.modeText.textContent = this.isGridMode ? 'Grid' : 'Gallery';

        this.updateHeaderTitle();
        this.container.innerHTML = '';
        this.books = [];

        this.viewport.classList.toggle('grid-mode', this.isGridMode);
        this.viewport.classList.toggle('gallery-mode', !this.isGridMode);
        this.state.isPaused = this.isGridMode;
        if (this.breadcrumb) this.breadcrumb.style.display = this.isGridMode ? '' : 'none';
        if (!this.isGridMode) this._showGallery();
    }

    /** 流动视图恢复尺寸和书籍，并在需要时重启动画。 */
    _showGallery() {
        this.viewport.style.display = '';
        this.viewport.style.height = 'calc(100vh - 200px)';
        this.viewport.style.overflow = 'visible';
        this.container.style.height = '100%';
        this.generateBooks();

        // 网格模式下可能已经停止了动画循环。
        if (!this.rafId) this.startLoop();
    }

    updateHeaderTitle() {
        const titleEl = document.querySelector(".header-title");
        if (!titleEl) return;

        let modeBtn = titleEl.querySelector('.mode-text-btn');
        if (!modeBtn) {
            modeBtn = document.createElement('span');
            modeBtn.className = 'mode-text-btn';
            modeBtn.addEventListener('click', () => this.toggleMode());
            const image = this._insertModeButton(titleEl, modeBtn);
            if (image) window.MAERS?.Theme?.setupZoomTrigger?.(image, 'icon_only', true);
        }
        modeBtn.textContent = this.isGridMode ? 'GRID' : 'FLOW';
        modeBtn.title = this.isGridMode ? '展示最近36本' : '展示所有书籍';
    }

    /** 将模式按钮放在标题图标之后，缺少标准结构时重建相同布局。 */
    _insertModeButton(titleEl, modeBtn) {
        const existingImg = titleEl.querySelector('img');
        if (existingImg) {
            const space = document.createTextNode(' ');
            titleEl.insertBefore(space, existingImg.nextSibling);
            titleEl.insertBefore(modeBtn, space.nextSibling);
            return existingImg;
        }
        console.warn('[LiteratureView] Standard header structure not found, rebuilding...');
        titleEl.innerHTML = '';
        const iconWrapper = document.createElement('span');
        iconWrapper.innerHTML = '<img src="ui/literature-icon.svg" alt="文学" style="height: 1.25em; width: auto; vertical-align: middle;">';
        titleEl.appendChild(iconWrapper);
        titleEl.appendChild(document.createTextNode(' '));
        titleEl.appendChild(modeBtn);
        titleEl.appendChild(document.createTextNode(' Literature'));
        return iconWrapper.querySelector('img');
    }

    async init() {
        try {
            await this.loadBooksFromBackend();

            this.updateHeaderTitle();
            this.updateMetrics();
            this.generateBooks();
            this.setupEvents();
            this.setupEditorCloseListener();
            this.startLoop();

            if (this.viewport) {
                this.viewport.style.display = 'block';
                this.viewport.style.opacity = '1';
                this.viewport.style.visibility = 'visible';
            }

            // 默认流动视图隐藏面包屑。
            if (this.breadcrumb) this.breadcrumb.style.display = 'none';
        } catch (e) {
            console.error('[FlowEngine] Init failed:', e);
        }
    }

    startLoop() {
        startLoop(this);
    }

    openBookEditor(cardElement) {
        let bookData;
        if (cardElement.dataset.bookData) {
            bookData = JSON.parse(cardElement.dataset.bookData);
        } else {
            const bookObj = this.books.find(b => b.el === cardElement);
            if (bookObj && bookObj.dataIndex !== -1) {
                bookData = this.realBooks[bookObj.dataIndex % this.realBooks.length];
            }
        }

        if (!bookData) {
            console.warn('[FlowEngine] No book data found for this card');
            return;
        }

        this.pauseAnimation();
        this.viewport.style.display = 'none';

        const node = {
            id: bookData.id,
            title: bookData.title,
            content: bookData.content || '',
            coverImage: bookData.coverImage
        };

        if (Reader) {
            Reader.open(node);
        } else {
            console.error('[FlowEngine] Reader not injected. Call initLiteratureView(deps) first.');
        }
    }

    pauseAnimation() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.state.isPaused = true;
    }

    resumeAnimation() {
        this.state.isPaused = false;
        if (!this.rafId && !this.isGridMode) {
            this.startLoop();
        }
        this.viewport.style.display = 'block';
    }
}
