/**
 * @module custom/literature/viewer/flow/literature-flow-render.module.js
 * @description Literature Flow - 渲染与布局逻辑
 * @version 1.0.0 - ES6 Module
 */

import { loadFlowOrder } from './literature-flow-data.module.js';

/**
 * Pre-process and prepare the list of books to be shown in the flow
 * @param {FlowEngine} engine - Engine instance
 */
export function prepareRealBooks(engine) {
    const savedOrder = loadFlowOrder();

    if (savedOrder.length > 0) {
        const bookMap = new Map();
        engine.allBooksSource.forEach(book => bookMap.set(book.id, book));

        const restoredBooks = [];
        savedOrder.forEach(id => {
            const book = bookMap.get(id);
            if (book) {
                restoredBooks.push(book);
                bookMap.delete(id);
            }
        });

        const newBooks = Array.from(bookMap.values());
        engine.realBooks = [...restoredBooks, ...newBooks].slice(0, 36);
    } else {
        engine.realBooks = engine.allBooksSource.slice(0, 36);
    }
}

/**
 * Update viewport metrics and layout calculations
 * @param {FlowEngine} engine - Engine instance
 */
export function updateMetrics(engine) {
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const isMobile = viewportW < 768;

    // 1. Prepare books if not already done
    if (!engine.realBooks || engine.realBooks.length === 0) {
        prepareRealBooks(engine);
    }

    const bookCount = engine.realBooks.length || 36;

    // 2. Set card dimensions based on device
    if (isMobile) {
        engine.config.cardWidth = 90;
        engine.config.cardHeight = 135;
        engine.config.paddingY = 50;
        engine.config.rowHeight = 160;
    } else {
        engine.config.cardWidth = 140;
        engine.config.cardHeight = 210;
        engine.config.paddingY = 0;
        engine.config.rowHeight = 270;
    }

    // 3. Lock EXACT spacing (cardWidth + 15px)
    engine.config.spacing = engine.config.cardWidth + 15;

    // 4. Loop Logic: Total track length must be a multiple of spacing for a smooth loop.
    // Also, we need enough margin to let books fully exit the screen.
    const safeMargin = Math.max(200, engine.config.cardWidth * 1.5);
    const minSegmentLen = viewportW + safeMargin * 2;
    const minTrackLen = 3 * minSegmentLen; // 3 rows

    // Round up the track length to the nearest multiple of spacing
    const finalTrackLen = Math.ceil(minTrackLen / engine.config.spacing) * engine.config.spacing;

    // 5. Update derived metrics
    engine.rowCount = 3;
    engine.trackLength = finalTrackLen;
    engine.segmentLen = finalTrackLen / engine.rowCount;
    engine.boundaryMargin = (engine.segmentLen - viewportW) / 2;
    engine.visualWidth = viewportW;

    // 6. [CRITICAL] Sync Identity Count: Total physical slots in the circuit
    engine.slotCount = Math.round(finalTrackLen / engine.config.spacing);

    // 7. [RANDOM SCATTER LOGIC] 
    // Build a shuffled mapping that uses every book at least once (if possible)
    // and fills extra slots with randomly selected books.
    if (!engine.slotMapping || engine.slotMapping.length !== engine.slotCount) {
        const mapping = [];
        const dataCount = engine.realBooks.length;

        if (engine.slotCount >= dataCount) {
            // Mandatory: include every book once
            for (let i = 0; i < dataCount; i++) mapping.push(i);
            // Optional: fill remaining slots with random picks from all books
            const extra = engine.slotCount - dataCount;
            for (let i = 0; i < extra; i++) {
                mapping.push(Math.floor(Math.random() * dataCount));
            }
        } else {
            // Narrow screen: just fill what we can
            for (let i = 0; i < engine.slotCount; i++) mapping.push(i);
        }

        // Fisher-Yates shuffle for stable session-based randomness across the circuit
        for (let i = mapping.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [mapping[i], mapping[j]] = [mapping[j], mapping[i]];
        }
        engine.slotMapping = mapping;
    }

    console.log(`[Flow] Scattered: Spacing=15px, Slots=${engine.slotCount}, Data=${bookCount}`);
}

/**
 * Generate book cards in the DOM pool
 * @param {FlowEngine} engine - Engine instance
 * @param {Function} openBookEditorCallback - Callback to open book editor
 */
export function generateBooks(engine, openBookEditorCallback) {
    engine.container.innerHTML = '';
    engine.books = [];

    // Ensure realBooks are prepared and metrics refreshed
    prepareRealBooks(engine);
    updateMetrics(engine);

    if (engine.realBooks.length === 0) {
        console.warn('[Flow] No books to render');
        return;
    }

    // Pool must be large enough to cover the entire physical circuit to maintain stable identity
    const poolSize = engine.slotCount + 5;

    for (let i = 0; i < poolSize; i++) {
        const card = document.createElement('div');
        card.className = 'book-card';
        card.innerHTML = `
            <div class="book-spine"></div>
            <div class="book-cover"></div>
        `;
        engine.container.appendChild(card);

        card.addEventListener('mouseenter', () => {
            engine.state.isPaused = true;
            card.classList.add('is-hovered');
            if (!engine.isGridMode) {
                card.style.zIndex = 9999;
            }
        });
        card.addEventListener('mouseleave', () => {
            engine.state.isPaused = false;
            card.classList.remove('is-hovered');
            card.style.zIndex = '';
        });

        card.addEventListener('click', () => {
            openBookEditorCallback(card);
        });

        engine.books.push({
            el: card,
            dataIndex: -1
        });
    }
}

/**
 * Calculate position on the flowing path
 * @param {FlowEngine} engine - Engine instance
 * @param {number} t - Position parameter
 * @returns {Object} Position {x, y, rowIndex}
 */
export function getPathPosition(engine, t) {
    let dist = t % engine.trackLength;
    if (dist < 0) dist += engine.trackLength;

    const rowIndex = Math.floor(dist / engine.segmentLen);
    const progress = dist % engine.segmentLen;

    const isEvenRow = rowIndex % 2 === 0;

    let x;
    if (isEvenRow) {
        x = -engine.boundaryMargin + progress;
    } else {
        x = engine.visualWidth + engine.boundaryMargin - progress;
    }

    const y = engine.config.paddingY + rowIndex * engine.config.rowHeight;

    return { x, y, rowIndex };
}

/**
 * Start the animation loop
 * @param {FlowEngine} engine - Engine instance
 */
export function startLoop(engine) {
    let lastTime = performance.now();

    const update = (time) => {
        if (engine.isGridMode) {
            engine.rafId = requestAnimationFrame(update);
            return;
        }

        const dt = (time - lastTime) / 16.67;
        lastTime = time;

        if (!engine.state.isPaused) {
            engine.state.scrollOffset += engine.state.autoScrollSpeed * dt;
        }

        // 1. First, hide all books in the pool to prepare for the new frame
        engine.books.forEach(b => b.el.style.display = 'none');

        // 2. Define the range of virtual indices that could potentially be visible
        const slotCount = engine.slotCount;
        const poolSize = engine.books.length;
        const startVirtualIndex = Math.floor(-engine.state.scrollOffset / engine.config.spacing) - 2;
        // We render the amount of items that cover the tracks plus some buffers
        const endVirtualIndex = startVirtualIndex + slotCount + 4;

        for (let virtualIndex = startVirtualIndex; virtualIndex < endVirtualIndex; virtualIndex++) {
            // [STABLE MAPPING] Select mapping based on physical slot
            const slotIndex = ((virtualIndex % slotCount) + slotCount) % slotCount;
            const bookPoolIndex = ((virtualIndex % poolSize) + poolSize) % poolSize;
            const book = engine.books[bookPoolIndex];

            // Use the shuffled mapping to determine which book data to show in this slot
            const wrappedSlotIndex = engine.slotMapping ? engine.slotMapping[slotIndex] : (slotIndex % engine.realBooks.length);

            // Physical position calculation
            const absPos = virtualIndex * engine.config.spacing + engine.state.scrollOffset;
            let relPos = absPos % engine.trackLength;
            if (relPos < 0) relPos += engine.trackLength;

            const pos = getPathPosition(engine, relPos);

            // Visibility Check: Use boundaryMargin to ensure turns are correctly calculated on narrow screens
            const xThreshold = engine.boundaryMargin + 50;
            const isVisibleX = pos.x > -xThreshold && pos.x < engine.visualWidth + xThreshold;
            const isVisibleY = pos.rowIndex < 3;

            if (isVisibleX && isVisibleY) {
                // Update content only if data identity/slot changed
                if (book.dataIndex !== wrappedSlotIndex) {
                    book.dataIndex = wrappedSlotIndex;

                    const data = engine.realBooks[wrappedSlotIndex % engine.realBooks.length];
                    const coverEl = book.el.querySelector('.book-cover');

                    book.el.dataset.bookData = JSON.stringify(data);

                    if (data && data.coverImage && !data.isPlaceholder) {
                        const pathParts = data.coverImage.split('/');
                        const basename = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
                        const webpUrl = `photos/thumbnails/covers/${basename}.webp`;
                        coverEl.style.backgroundImage = `url('${webpUrl}')`;
                    } else {
                        coverEl.style.backgroundImage = '';
                    }
                }

                // Apply Transforms
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
            }
        }

        engine.rafId = requestAnimationFrame(update);
    };

    engine.rafId = requestAnimationFrame(update);
}
