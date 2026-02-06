/**
 * @module custom/literature/viewer/flow/literature-flow-data.module.js
 * @description Literature Flow - 数据加载与管理
 * @version 1.0.0 - ES6 Module
 */

/**
 * Load books from backend JSON file
 * @param {FlowEngine} engine - Engine instance
 * @returns {Promise<Array>} Array of books
 */
export async function loadBooksFromBackend(engine) {
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

    engine.allBooksSource = allBooks;
    return [];
}

/**
 * Load Flow order from localStorage
 * @returns {Array<string>} Array of book IDs in user's preferred order
 */
export function loadFlowOrder() {
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
 * @param {Array} realBooks - Current books array
 */
export function saveFlowOrder(realBooks) {
    try {
        const ids = realBooks.map(b => b.id);
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

/**
 * Promote a book to the front of the Flow
 * @param {FlowEngine} engine - Engine instance
 * @param {Object} node - Book node to promote
 */
export function promoteBook(engine, node) {
    if (!node) return;

    const idx = engine.realBooks.findIndex(b => b.id === node.id);

    if (idx !== -1) {
        const item = engine.realBooks.splice(idx, 1)[0];
        engine.realBooks.unshift(item);
    } else {
        const newBook = {
            id: node.id,
            title: node.title,
            content: node.content || '',
            tags: node.tags || [],
            coverImage: node.coverImage || null
        };
        engine.realBooks.unshift(newBook);
        engine.realBooks.pop();
    }

    saveFlowOrder(engine.realBooks);
    engine.state.scrollOffset = 0;
    engine.books.forEach(b => b.dataIndex = -1);
}
