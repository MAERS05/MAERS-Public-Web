/**
 * MAERS Photos - Main Entry Point (User View)
 * @version 3.1.0 - Full Backend Parity (CMS Integration)
 */

// 导入所有模块
import { initLayout } from '../../shared/layout.module.js';
import { initTheme } from '../../shared/theme.module.js';
import { DataProvider } from '../../data-manage/data-provider.module.js';
import { Controller, initController, State, reloadData } from './admin/photos-controller.module.js';
import { View, initView, render, openLightbox } from './viewer/photos-view.module.js';

// CMS Integration (Directly imitating Backend logic)
import { initTags, Tags } from '../cms/viewer/cms-tags.module.js';
import { setupPhotosAdapter, preloadTagCategories } from './admin/photos-cms-adapter.module.js';
import { initNav, Nav } from '../cms/viewer/render/cms-render-nav.module.js';

// 初始化核心 UI
initLayout();
initTheme();

// 初始化依赖关系
initController(DataProvider);

// Define Mock AdminCore for Frontend
const AdminCore = {
    Tags: Tags,
    AppState: null // Will be populated by adapter
};

// Initialize View with AdminCore (Enables Filtering)
initView(Controller, null, AdminCore);

// --- Frontend Adapter Setup (Identical to Admin-Main) ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Setup Adapter (Viewer Mode: IS_ADMIN = false)
    const adapterResult = setupPhotosAdapter(applyTagFilters, Controller, {
        initialState: { IS_ADMIN: false }
    });
    const { AppState, mockController, mockSearch, StateWrapper } = adapterResult;

    // 2. Inject into AdminCore so View can access state
    AdminCore.AppState = AppState;

    // 3. Initialize Shared CMS Components
    // Preload tag categories (for filtering logic)
    const currentCategory = (Controller?.State?.category) || 'nature';
    const dynamicModuleName = `photos-${currentCategory}`;
    await preloadTagCategories(AppState, dynamicModuleName);

    // Initialize Tags System (Filter Logic Only, no Admin features since IS_ADMIN is false/default)
    initTags(StateWrapper, mockController, mockSearch);

    // 4. Initialize Navigation Bar (Breadcrumbs / Filter Chips)
    if (initNav && Nav) {
        initNav({
            State: StateWrapper,
            Search: mockSearch,
            Drag: null, // No drag on frontend
            renderGrid: () => { }, // No grid re-render callback needed here (handled by applyTagFilters)
            renderBreadcrumb: Nav.renderBreadcrumb
        });

        // Initial Render
        if (Nav.renderBreadcrumb) Nav.renderBreadcrumb();
    }

    // 5. Bind UI Events (Directly from Admin-Main)
    const tagToggleBtn = document.getElementById('tag-toggle-btn');
    if (tagToggleBtn) {
        tagToggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (Tags.toggleTagDrawer) Tags.toggleTagDrawer();
        });
    }

    const closeBtn = document.querySelector('.btn-close-drawer');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            if (Tags.toggleTagDrawer) Tags.toggleTagDrawer();
        });
    }

    const overlay = document.getElementById('drawer-overlay');
    if (overlay) {
        overlay.addEventListener('click', () => {
            if (Tags.toggleTagDrawer) Tags.toggleTagDrawer();
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

    // Bind tag search input
    const tagSearchInput = document.getElementById('tag-drawer-search');
    if (tagSearchInput) {
        tagSearchInput.addEventListener('input', () => {
            if (Tags.refreshDrawerList) Tags.refreshDrawerList();
        });
    }
});

// Shared Filter Handler (Backend Logic)
function applyTagFilters() {
    // Sync Search (if applicable)
    // mockSearch.performSearch() -> already done by adapter internal mocks usually

    // Update Nav Bar
    if (Nav && Nav.renderBreadcrumb) {
        Nav.renderBreadcrumb();
    }

    // Update Grid View
    if (AdminCore.AppState) {
        const dataToRender = AdminCore.AppState.activeFilters.size > 0
            ? AdminCore.AppState.filteredNodes
            : Controller.State.loadedData;

        // Use View.render to update UI efficiently
        View.render(dataToRender);
    }
}

// Sync Data on Reload (Ensures AppState stays in sync with Controller)
const originalReload = Controller.reloadData;
if (originalReload) {
    Controller.reloadData = async function () {
        await originalReload.call(Controller);

        if (AdminCore.AppState) {
            AdminCore.AppState.allNodes = Controller.State.loadedData || [];
            // Re-apply filters if any exist
            if (AdminCore.AppState.activeFilters.size > 0) {
                applyTagFilters();
            }
        }
    };
}
