/**
 * MAERS Space - CMS Module Edition
 * @version 2.0.0 - Full CMS Integration
 */

import { initLayout } from '../../../shared/layout.module.js';
import { initTheme } from '../../../shared/theme.module.js';

// Import CMS Core Modules
import { State, initState as initStateModule } from '../../cms/viewer/cms-state.module.js';
import { Search, initSearch, setupSearchListeners } from '../../cms/viewer/cms-search.module.js';
import { Tags, initTags } from '../../cms/viewer/cms-tags.module.js';
import { Recent, initRecent } from '../../cms/viewer/cms-recent.module.js';
import { initNav, Nav } from '../../cms/viewer/render/cms-render-nav.module.js';
import { preloadTagCategories } from '../../cms/cms-adapter.module.js';

// Import Space-Specific Renderer
import { initSpaceRender, SpaceRender } from './space-render.module.js';

let SPACE_DATA = { root: [] };

// CMS Controller for Space Module
const SpaceController = {
    CONFIG: {
        IS_ADMIN: false,
        CURRENT_MODULE: 'space'
    },
    get IS_ADMIN() { return this.CONFIG.IS_ADMIN; },
    AppState: {
        root: [],
        pathStack: ['root'],
        activeFilters: new Set(),
        allNodes: [],
        filteredNodes: [],
        searchQuery: '',
        tags: new Set(),
        tagCategories: []
    },
    SELECTORS: {
        HEADER_RIGHT: ".header-right",
        TAG_TOGGLE_BTN: ".tag-toggle-btn",
        GRID_ITEM: ".space-card",
        MINI_TAG: ".space-tag",
        BREADCRUMB: "#breadcrumb",
        GRID_CONTAINER: "#category-grid",
        TAG_DRAWER: "#tag-drawer",
        DRAWER_OVERLAY: "#drawer-overlay",
        DRAWER_LIST: "#drawer-list",
        SEARCH_INPUT: "#search-input",
        TAG_DRAWER_SEARCH: "#tag-drawer-search"
    },
    escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, function (m) {
            switch (m) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                case "'": return '&#039;';
            }
        });
    },
    escapeAttr(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, function (m) {
            switch (m) {
                case '&': return '&amp;';
                case '<': return '&lt;';
                case '>': return '&gt;';
                case '"': return '&quot;';
                case "'": return '&#039;';
            }
        });
    }
};

initLayout();
initTheme();

document.addEventListener('DOMContentLoaded', async () => {
    // Load Space Tree Data
    try {
        const response = await fetch('data/space-tree.json?t=' + Date.now());
        if (response.ok) {
            SPACE_DATA = await response.json();
        }
    } catch (err) {
        console.error('Failed to load space data:', err);
    }

    SpaceController.AppState.root = SPACE_DATA.root || [];

    // Flatten tree for search/filter
    function flattenNodes(nodes, result = []) {
        nodes.forEach(node => {
            result.push(node);
            if (node.children && node.children.length > 0) {
                flattenNodes(node.children, result);
            }
        });
        return result;
    }

    SpaceController.AppState.allNodes = flattenNodes(SPACE_DATA.root || []);

    // Extract all tags
    const allTags = new Set();
    SpaceController.AppState.allNodes.forEach(node => {
        if (node.tags) {
            node.tags.forEach(tag => allTags.add(tag));
        }
    });
    SpaceController.AppState.tags = allTags;

    // Load tag categories (with static fallback)
    await preloadTagCategories(SpaceController.AppState, 'space');

    // Initialize CMS Core
    initStateModule(SpaceController);
    State.initState(SpaceController.AppState, SpaceController.CONFIG);
    initSpaceRender({ State: State });

    const SpaceRenderCallbacks = {
        renderGrid: (list) => renderGrid(list),
        renderBreadcrumb: () => {
            if (Nav && Nav.renderBreadcrumb) {
                Nav.renderBreadcrumb();
            }
        }
    };

    // Make Controller compatible with CMS modules
    SpaceController.renderGrid = SpaceRenderCallbacks.renderGrid;

    // Correctly pass full State module
    initSearch(State, SpaceRenderCallbacks, Tags);
    initTags(State, SpaceController, Search);
    initNav({
        State: State,
        Search: Search,
        Drag: null,
        renderGrid: SpaceRenderCallbacks.renderGrid,
        renderBreadcrumb: SpaceRenderCallbacks.renderBreadcrumb
    });

    initRecent(State, SpaceController, {
        openFile: (node) => {
            if (node.url) {
                window.open(node.url, '_blank');
            }
        }
    });

    setupSearchListeners();

    // Bind tag toggle button
    const tagToggleBtn = document.querySelector('.tag-toggle-btn');
    if (tagToggleBtn) {
        tagToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            Tags.toggleTagDrawer();
        });
    }

    // Bind drawer close button
    const closeBtn = document.querySelector('.btn-close-drawer');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            Tags.toggleTagDrawer();
        });
    }

    // Bind clear tags button
    const clearBtn = document.querySelector('.btn-clear-tags');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            const input = document.getElementById('tag-drawer-search');
            if (input) input.value = '';
            if (Tags.clearTagFilter) Tags.clearTagFilter();
            if (Tags.refreshDrawerList) Tags.refreshDrawerList();
        });
    }

    // Standard Event Delegation (Clean & Robust)
    const galleryContent = document.body; // Use body for robust global delegation
    if (galleryContent) {
        galleryContent.addEventListener('click', (e) => {
            const card = e.target.closest('.space-card');
            if (!card) return;

            // 1. Tag Click
            const tagEl = e.target.closest('.space-tag');
            if (tagEl) {
                e.preventDefault();
                e.stopPropagation();
                const tagName = tagEl.textContent.trim();
                // Ensure Tags is loaded
                if (tagName && Tags && Tags.filterByTag) {
                    Tags.filterByTag(e, tagName);
                }
                return;
            }

            // 2. Card Click (Link)
            const url = card.dataset.url;
            if (url) {
                const cardId = card.dataset.id;
                // Robust ID comparison (String vs Number safety)
                const node = SpaceController.AppState.allNodes.find(n => String(n.id) === String(cardId));

                if (node) {
                    Recent.addToHistory({
                        id: node.id,
                        title: node.name,
                        url: node.url,
                        type: 'link',
                        timestamp: Date.now()
                    });
                }
                window.open(url, '_blank');
            } else {
                // Folder navigation logic
                console.log('Folder clicked');
            }
        });
    }

    renderGrid(SpaceController.AppState.root);
    if (Nav && Nav.renderBreadcrumb) {
        Nav.renderBreadcrumb();
    }
});

// Helper function to render grid
function renderGrid(nodes) {
    const grid = document.getElementById('category-grid');
    if (!grid) return;
    SpaceRender.renderSpaceGrid(nodes, grid);
}
