/**
 * @module custom/space/viewer/space-render.module.js
 * @description Space Module - Card Grid Renderer
 * @version 1.0.0 - ES6 Module
 */

let State = null;

export function initSpaceRender(deps) {
    State = deps.State;
}

/**
 * Render Space cards in grid layout
 * @param {Array} nodes - Array of link nodes to render
 * @param {HTMLElement} container - Container element
 */
export function renderSpaceGrid(nodes, container) {
    if (!container) return;

    container.innerHTML = '';
    container.className = 'space-grid grid-layout';

    nodes.forEach(node => {
        if (node.type === 'directory') {
            renderFolderCard(node, container);
        } else if (node.type === 'link') {
            renderLinkCard(node, container);
        }
    });
}

/**
 * Render a folder card
 */
function renderFolderCard(node, container) {
    const card = document.createElement('div');
    card.className = `space-card folder-card ${node.style_class || ''}`;
    card.dataset.id = node.id;

    card.innerHTML = `
        <div class="space-icon folder-icon">
            <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor">
                <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
            </svg>
        </div>
        <div class="space-text">
            <div class="space-title">${State.escapeHtml(node.name)}</div>
            <div class="space-desc">${State.escapeHtml(node.content || '')}</div>
        </div>
        <div class="space-tags">
            ${(node.tags || []).map(tag =>
        `<span class="space-tag ${State?.AppState?.activeFilters?.has(tag) ? 'active' : ''}">${State.escapeHtml(tag)}</span>`
    ).join('')}
        </div>
    `;

    container.appendChild(card);
}

/**
 * Render a link card
 */
function renderLinkCard(node, container) {
    const card = document.createElement('div');
    card.className = `space-card link-card ${node.style_class || ''}`;
    card.dataset.id = node.id;
    card.dataset.url = node.url;

    card.innerHTML = `
        <div class="space-icon">
            <img src="${node.icon || 'ui/placeholder.svg'}" alt="${State.escapeAttr(node.name)}">
        </div>
        <div class="space-text">
            <div class="space-title">${State.escapeHtml(node.name)}</div>
            <div class="space-desc">${State.escapeHtml(node.content || '')}</div>
        </div>
        <div class="space-tags">
            ${(node.tags || []).map(tag =>
        `<span class="space-tag ${State?.AppState?.activeFilters?.has(tag) ? 'active' : ''}">${State.escapeHtml(tag)}</span>`
    ).join('')}
        </div>
    `;

    container.appendChild(card);
}

export const SpaceRender = {
    renderSpaceGrid
};
