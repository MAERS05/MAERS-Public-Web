/**
 * MAERS Literature Viewer - Flowing Path Engine
 * 基于虚拟滚动优化的流动路径引擎
 * @version 3.0.0 - ES6 Module
 */

// Dependency Injection
let Editor = null;

export function initLiteratureView(deps) {
    Editor = deps.Editor;
}

// View 对象
export const LiteratureView = {
    engine: null,

    async init() {
        // 检查必要的容器
        const container = document.getElementById('path-container');
        if (!container) {
            console.warn('[MAERS.Literature.View] #path-container not found, creating...');
            this.createContainers();
        }

        this.engine = new FlowEngine();
        await this.engine.init();
    },

    setMode: function (mode) {
        if (this.engine) {
            this.engine.setMode(mode);
        }
    },

    createContainers: function () {
        // 动态创建必要的容器
        const viewport = document.createElement('div');
        viewport.id = 'viewport';
        viewport.className = 'viewport gallery-mode';

        const pathContainer = document.createElement('div');
        pathContainer.id = 'path-container';
        pathContainer.className = 'path-container';

        viewport.appendChild(pathContainer);
        document.body.insertBefore(viewport, document.body.firstChild);
    }
};

class FlowEngine {
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

        // 数据将在 init() 中异步加载
        this.allBooksSource = [];
        this.realBooks = [];
    }

    async loadBooksFromBackend() {
        // Load data from JSON file
        let allBooks = [];
        try {
            const dataFile = 'data/literature-tree.json';

            const response = await fetch(dataFile);
            if (response.ok) {
                const data = await response.json();
                if (data && data.root) {
                    const flattenBooks = (nodes) => {
                        nodes.forEach(node => {
                            if (node.type === 'note') {
                                allBooks.push({
                                    id: node.id,
                                    title: node.title,
                                    content: node.content || '',
                                    tags: node.tags || [],
                                    coverImage: node.coverImage || null
                                });
                            }
                            if (node.children && node.children.length > 0) {
                                flattenBooks(node.children);
                            }
                        });
                    };
                    flattenBooks(data.root);
                }
            } else {
                console.error('[FlowEngine] Failed to load JSON data');
            }
        } catch (e) {
            console.error('[FlowEngine] Error loading JSON data:', e);
        }

        this.allBooksSource = allBooks; // 保存全量数据源
        return []; // realBooks 在 generateBooks（计算出容量后）再初始化
    }

    /**
     * Load Flow order from localStorage
     * Returns array of book IDs in user's preferred order
     */
    loadFlowOrder() {
        try {
            const saved = localStorage.getItem('maers_literature_flow_order');
            if (saved) {
                const orderData = JSON.parse(saved);
                return orderData.ids || [];
            }
        } catch (e) {
            console.warn('[FlowEngine] Failed to load Flow order:', e);
        }
        return [];
    }

    /**
     * Save current Flow order to localStorage
     */
    saveFlowOrder() {
        try {
            const ids = this.realBooks.map(b => b.id);
            const orderData = {
                ids: ids,
                timestamp: Date.now(),
                version: '1.0'
            };
            localStorage.setItem('maers_literature_flow_order', JSON.stringify(orderData));
        } catch (e) {
            console.warn('[FlowEngine] Failed to save Flow order:', e);
        }
    }

    updateMetrics() {
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;

        this.boundaryMargin = 180;
        this.segmentLen = viewportW + this.boundaryMargin * 2;

        // 强制只显示 3 行 (Removing phantom 4th row)
        this.rowCount = 3;

        this.trackLength = this.rowCount * this.segmentLen;
        this.visualWidth = viewportW;

        // 大幅减少顶部间距和行高，确保3行完全可见
        this.config.paddingY = 0; // 顶部只留20px
        this.config.rowHeight = 270; // 减少行高，让3行能完全显示
    }

    generateBooks() {
        this.container.innerHTML = '';
        this.books = [];

        // 1. Load saved Flow order from localStorage
        const savedOrder = this.loadFlowOrder();

        // 2. Restore books based on saved order
        if (savedOrder.length > 0) {
            // Build a map for quick lookup
            const bookMap = new Map();
            this.allBooksSource.forEach(book => bookMap.set(book.id, book));

            // Restore saved books (filter out deleted ones)
            const restoredBooks = [];
            savedOrder.forEach(id => {
                const book = bookMap.get(id);
                if (book) {
                    restoredBooks.push(book);
                    bookMap.delete(id); // Remove from map to track what's new
                }
            });

            // Add new books (not in saved order) to the end
            const newBooks = Array.from(bookMap.values());
            this.realBooks = [...restoredBooks, ...newBooks].slice(0, 36);
        } else {
            // No saved order: use first 36 books
            this.realBooks = this.allBooksSource.slice(0, 36);
        }

        // 3. Adaptive Spacing Logic
        // If we have books, fit them exactly to the track to prevent ANY repetition
        if (this.realBooks.length > 0) {
            this.totalBookCount = this.realBooks.length;

            // Calculate spacing required to stretch these books across the full track
            this.config.spacing = this.trackLength / this.totalBookCount;
        } else {
            // Fallback for 0 books
            this.config.spacing = 180;
        }

        // Grid pool calculation uses visual width and spacing
        const booksPerRow = Math.ceil(this.visualWidth / this.config.spacing) + 5;
        const visibleRows = 3;
        const poolSize = booksPerRow * visibleRows;

        // 创建 DOM 池
        for (let i = 0; i < poolSize; i++) {
            const card = document.createElement('div');
            card.className = 'book-card';
            card.innerHTML = `
                <div class="book-spine"></div>
                <div class="book-cover"></div>
            `;
            this.container.appendChild(card);

            // 交互事件
            card.addEventListener('mouseenter', () => {
                this.state.isPaused = true;
                card.classList.add('is-hovered');
                if (!this.isGridMode) {
                    card.style.zIndex = 9999;
                }
            });
            card.addEventListener('mouseleave', () => {
                this.state.isPaused = false;
                card.classList.remove('is-hovered');
                card.style.zIndex = '';
            });

            // 点击事件：打开编辑器
            card.addEventListener('click', () => {
                this.openBookEditor(card);
            });

            this.books.push({
                el: card,
                dataIndex: -1
            });
        }
    }

    promoteBook(node) {
        if (!node) return;

        // Check if already in gallery (by ID)
        const idx = this.realBooks.findIndex(b => b.id === node.id);

        if (idx !== -1) {
            // Already in Flow: Move to front to reflect recency
            const item = this.realBooks.splice(idx, 1)[0];
            this.realBooks.unshift(item);
        } else {
            // Not in Flow: Add to front, remove last
            const newBook = {
                id: node.id,
                title: node.title,
                content: node.content || '',
                tags: node.tags || [],
                coverImage: node.coverImage || null
            };
            this.realBooks.unshift(newBook);
            this.realBooks.pop(); // Remove last
        }

        // Save updated order to localStorage
        this.saveFlowOrder();

        // Reset scroll position to show the promoted book at the start
        this.state.scrollOffset = 0;

        // Force DOM refresh
        this.books.forEach(b => b.dataIndex = -1);
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
            // 阻止页面整体滚动，仅滚动书籍长廊
            e.preventDefault();
            this.state.scrollOffset += e.deltaY * 0.5;
        }, { passive: false });
    }

    setupEditorCloseListener() {
        // 监听编辑器关闭事件
        const immersiveReader = document.getElementById('immersive-reader');
        if (!immersiveReader) return;

        // 使用 MutationObserver 监听 class 变化
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.attributeName === 'class') {
                    const isActive = immersiveReader.classList.contains('active');
                    if (!isActive) {
                        // 编辑器关闭，恢复动画
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

    getPathPosition(t) {
        let dist = t % this.trackLength;
        if (dist < 0) dist += this.trackLength;

        const rowIndex = Math.floor(dist / this.segmentLen);
        const progress = dist % this.segmentLen;

        const isEvenRow = rowIndex % 2 === 0;

        let x;
        if (isEvenRow) {
            x = -this.boundaryMargin + progress;
        } else {
            x = this.visualWidth + this.boundaryMargin - progress;
        }

        const y = this.config.paddingY + rowIndex * this.config.rowHeight;

        return { x, y, rowIndex };
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

        // 更新标题
        this.updateHeaderTitle();

        // 清空现有容器
        this.container.innerHTML = '';
        this.books = [];

        if (this.isGridMode) {
            this.viewport.classList.remove('gallery-mode');
            this.viewport.classList.add('grid-mode');
            this.state.isPaused = true; // 暂停循环

            // Note: In Grid Mode, we now rely on the CMS grid (#grid-container)
            // which is automatically revealed by CSS when .viewport has .grid-mode
            // We do NOT generate custom DOM here anymore.

        } else {
            this.viewport.classList.remove('grid-mode');
            this.viewport.classList.add('gallery-mode');
            this.state.isPaused = false; // 恢复循环

            // 恢复视口样式
            this.viewport.style.height = 'calc(100vh - 200px)';
            this.viewport.style.overflow = 'visible';
            this.container.style.height = '100%';

            // 【长廊模式】重新生成虚拟滚动池
            this.generateBooks();
        }
    }

    updateHeaderTitle() {
        const titleEl = document.querySelector(".header-title");
        if (!titleEl) return;

        const mode = this.isGridMode ? 'GRID' : 'FLOW';

        // Clear existing content
        titleEl.innerHTML = '';

        // Create emoji text node
        titleEl.appendChild(document.createTextNode('📙 '));

        // Create mode toggle button
        const modeBtn = document.createElement('span');
        modeBtn.className = 'mode-text-btn';
        modeBtn.textContent = mode;
        modeBtn.addEventListener('click', () => this.toggleMode());
        titleEl.appendChild(modeBtn);

        // Add trailing text
        titleEl.appendChild(document.createTextNode(' Literature'));

        // Apply zoom trigger using global function (will wrap the emoji automatically)
        if (window.MAERS?.Theme?.setupZoomTrigger) {
            window.MAERS.Theme.setupZoomTrigger(titleEl, 'icon_only', true);
        }
    }

    async init() {
        try {
            // 先加载数据
            await this.loadBooksFromBackend();

            // FlowEngine 初始化
            this.updateHeaderTitle();
            this.updateMetrics();
            this.generateBooks();
            this.setupEvents();
            this.setupEditorCloseListener();
            this.startLoop();

            // 确保 viewport 可见
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
        let lastTime = performance.now();

        const update = (time) => {
            // 如果是网格模式，直接跳过整个循环，什么都不要做
            if (this.isGridMode) {
                this.rafId = requestAnimationFrame(update);
                return;
            }

            const dt = (time - lastTime) / 16.67;
            lastTime = time;

            if (!this.state.isPaused) {
                this.state.scrollOffset += this.state.autoScrollSpeed * dt;
            }

            // [虚拟滚动核心逻辑]
            const startVirtualIndex = Math.floor(-this.state.scrollOffset / this.config.spacing);
            // Increase scan range to account for off-screen items in the margins
            const endVirtualIndex = startVirtualIndex + this.books.length + 20;

            let domIndex = 0;
            for (let virtualIndex = startVirtualIndex; virtualIndex < endVirtualIndex && domIndex < this.books.length; virtualIndex++) {
                const wrappedIndex = ((virtualIndex % this.totalBookCount) + this.totalBookCount) % this.totalBookCount;

                const absPos = virtualIndex * this.config.spacing + this.state.scrollOffset;
                let relPos = absPos % this.trackLength;
                if (relPos < 0) relPos += this.trackLength;

                const pos = this.getPathPosition(relPos);

                const isVisibleX = pos.x > -200 && pos.x < this.visualWidth + 200;
                const isVisibleY = pos.rowIndex < 3;

                if (isVisibleX && isVisibleY) {
                    const book = this.books[domIndex];

                    // 数据绑定 (如果索引变化，说明复用了 DOM，需要更新内容)
                    if (book.dataIndex !== wrappedIndex) {
                        book.dataIndex = wrappedIndex;
                        const data = this.realBooks[wrappedIndex % this.realBooks.length];
                        const coverEl = book.el.querySelector('.book-cover');

                        // 存储数据
                        book.el.dataset.bookData = JSON.stringify(data);

                        // 图片路径处理
                        if (data.isPlaceholder) {
                            coverEl.style.backgroundImage = '';
                            book.el.dataset.webp = '';
                            book.el.dataset.avif = '';
                        } else if (data.coverImage) {
                            // 构造 WebP 路径
                            const pathParts = data.coverImage.split('/');
                            const filename = pathParts[pathParts.length - 1];
                            const basename = filename.replace(/\.[^/.]+$/, "");

                            const webpUrl = `photos/thumbnails/covers/${basename}.webp`;

                            // 默认显示 WebP
                            coverEl.style.backgroundImage = `url('${webpUrl}')`;

                            // 存入 dataset 供 hover 事件使用
                            book.el.dataset.webp = webpUrl;
                        } else {
                            coverEl.style.backgroundImage = '';
                            book.el.dataset.webp = '';
                        }
                    }

                    // 视觉更新
                    book.el.style.display = 'flex';
                    let zIndex = (pos.rowIndex + 1) * 10;

                    if (book.el.classList.contains('is-hovered')) {
                        zIndex = 10000;
                        book.el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0) scale(1.15) translateY(-10px)`;
                        book.el.style.boxShadow = '0 20px 50px rgba(0,0,0,0.6)';
                    } else {
                        book.el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
                        book.el.style.boxShadow = 'none';
                    }
                    book.el.style.zIndex = zIndex;
                    domIndex++;
                }
                // Do NOT else { domIndex++ }. 
                // We skip invisible items without consuming a DOM node.
            }

            // Hide any remaining books that are no longer in the visible range
            for (let i = domIndex; i < this.books.length; i++) {
                this.books[i].el.style.display = 'none';
            }

            this.rafId = requestAnimationFrame(update);
        };

        this.rafId = requestAnimationFrame(update);
    }

    openBookEditor(cardElement) {
        // 从 DOM 元素获取书籍数据
        let bookData;
        if (cardElement.dataset.bookData) {
            // 网格模式：从 dataset 获取
            bookData = JSON.parse(cardElement.dataset.bookData);
        } else {
            // 画廊模式：从 books 数组查找
            const bookObj = this.books.find(b => b.el === cardElement);
            if (bookObj && bookObj.dataIndex !== -1) {
                bookData = this.realBooks[bookObj.dataIndex % this.realBooks.length];
            }
        }

        if (!bookData) {
            console.warn('[FlowEngine] No book data found for this card');
            return;
        }

        // 暂停动画循环
        this.pauseAnimation();

        // 隐藏 viewport
        this.viewport.style.display = 'none';

        // 构造符合 CMS Editor 期望的 node 对象
        const node = {
            id: bookData.id,
            title: bookData.title,
            content: bookData.content || '',
            coverImage: bookData.coverImage
        };

        // 调用 CMS Editor 打开编辑器
        if (Editor) {
            Editor.open(node);
        } else {
            console.error('[FlowEngine] Editor not injected. Call initLiteratureView(deps) first.');
        }
    }

    pauseAnimation() {
        // 取消动画帧
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.state.isPaused = true;
    }

    resumeAnimation() {
        // 恢复动画
        this.state.isPaused = false;
        if (!this.rafId && !this.isGridMode) {
            this.startLoop();
        }
        // 恢复 viewport 显示
        this.viewport.style.display = 'block';
    }
}

// Export for ES6 module usage
// Initialization is now controlled by main.module.js
