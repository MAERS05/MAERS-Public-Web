/**
 * @module custom/literature/viewer/flow/literature-flow-engine.module.js
 * @description Literature Flow - 核心引擎类
 * @version 1.0.0 - ES6 Module
 */

import { loadBooksFromBackend, promoteBook, saveFlowOrder } from './literature-flow-data.module.js';
import { updateMetrics, generateBooks, startLoop } from './literature-flow-render.module.js';

// Dependency Injection
let Editor = null;

export function setEditor(editor) {
    Editor = editor;
}

export class FlowEngine {
    constructor() {
        this.container = document.getElementById('path-container');
        this.viewport = document.getElementById('viewport') || document.body;
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
            mutations.forEach((mutation) => {
                if (mutation.attributeName === 'class') {
                    const isActive = immersiveReader.classList.contains('active');
                    if (!isActive) {
                        this.resumeAnimation();
                    }
                }
            });
        });

        observer.observe(immersiveReader, {
            attributes: true,
            attributeFilter: ['class']
        });
    }

    setMode(mode) {
        if (mode === 'grid' && !this.isGridMode) {
            this.toggleMode();
        } else if (mode === 'gallery' && this.isGridMode) {
            this.toggleMode();
        }
    }

    toggleMode() {
        this.isGridMode = !this.isGridMode;
        if (this.modeText) this.modeText.textContent = this.isGridMode ? 'Grid' : 'Gallery';

        this.updateHeaderTitle();
        this.container.innerHTML = '';
        this.books = [];

        if (this.isGridMode) {
            this.viewport.classList.remove('gallery-mode');
            this.viewport.classList.add('grid-mode');
            this.state.isPaused = true;
        } else {
            this.viewport.classList.remove('grid-mode');
            this.viewport.classList.add('gallery-mode');
            this.state.isPaused = false;

            this.viewport.style.display = '';
            this.viewport.style.height = 'calc(100vh - 200px)';
            this.viewport.style.overflow = 'visible';
            this.container.style.height = '100%';

            this.generateBooks();

            // Restart animation loop if it was stopped (e.g., by pauseAnimation in grid mode)
            if (!this.rafId) {
                this.startLoop();
            }
        }
    }

    updateHeaderTitle() {
        const titleEl = document.querySelector(".header-title");
        if (!titleEl) return;

        const mode = this.isGridMode ? 'GRID' : 'FLOW';

        let modeBtn = titleEl.querySelector('.mode-text-btn');
        if (modeBtn) {
            modeBtn.textContent = mode;
            modeBtn.title = this.isGridMode ? '展示最近36本' : '展示所有书籍';
            return;
        }

        modeBtn = document.createElement('span');
        modeBtn.className = 'mode-text-btn';
        modeBtn.textContent = mode;
        modeBtn.title = this.isGridMode ? '展示最近36本' : '展示所有书籍';
        modeBtn.addEventListener('click', () => this.toggleMode());

        const existingImg = titleEl.querySelector('img');

        if (existingImg) {
            const space = document.createTextNode(' ');

            if (existingImg.nextSibling) {
                titleEl.insertBefore(space, existingImg.nextSibling);
                titleEl.insertBefore(modeBtn, space.nextSibling);
            } else {
                titleEl.appendChild(space);
                titleEl.appendChild(modeBtn);
            }

            if (window.MAERS?.Theme?.setupZoomTrigger) {
                window.MAERS.Theme.setupZoomTrigger(existingImg, 'icon_only', true);
            }
        } else {
            console.warn('[LiteratureView] Standard header structure not found, rebuilding...');
            titleEl.innerHTML = '';

            const iconWrapper = document.createElement('span');
            iconWrapper.innerHTML = '<img src="ui/literature-icon.svg" alt="Literature" style="height: 1.25em; width: auto; vertical-align: middle;">';
            titleEl.appendChild(iconWrapper);

            titleEl.appendChild(document.createTextNode(' '));
            titleEl.appendChild(modeBtn);
            titleEl.appendChild(document.createTextNode(' Literature'));

            if (window.MAERS?.Theme?.setupZoomTrigger) {
                const imgEl = iconWrapper.querySelector('img');
                if (imgEl) window.MAERS.Theme.setupZoomTrigger(imgEl, 'icon_only', true);
            }
        }
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

        if (Editor) {
            Editor.open(node);
        } else {
            console.error('[FlowEngine] Editor not injected. Call initLiteratureView(deps) first.');
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
