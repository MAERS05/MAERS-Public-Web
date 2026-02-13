/**
 * MAERS Photos - Admin Entry Point (Admin View)
 * @version 4.1.0 - CMS Tags Integration (Scope Fix)
 */

// 导入所有模块
import { initLayout } from '../../shared/layout.module.js';
import { initTheme } from '../../shared/theme.module.js';
import { DataProvider } from '../../data-manage/data-provider.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../data-manage/admin-base.module.js';
import { Controller, initController, State, reloadData, checkIsDirty, saveChanges, uploadFiles, fixPath } from './admin/photos-controller.module.js';
import { View, initView, render, openLightbox } from './viewer/photos-view.module.js';
import { Admin, initAdmin, initManager, togglePick, stageDelete, executeMove } from './admin/photos-admin.module.js';

// CMS Tags Integration
import { initTags, Tags } from '../cms/viewer/cms-tags.module.js';
import { setupPhotosAdapter, preloadTagCategories } from './admin/photos-cms-adapter.module.js';
import { initNav, Nav } from '../cms/viewer/render/cms-render-nav.module.js';

// Pure ES6: AdminCore is imported, not mounted
// Pure ES6: AdminCore is imported, not mounted
const AdminCore = {
    BatchItemManager,
    // SaveButton removed to use initUnified pattern
    AdminButtonHelper,
    Feedback,
    Tags
};

// Module-level variables to ensure access across scopes
let AppState = null;
let mockController = null;
let mockSearch = null;
let StateWrapper = null;

// 初始化依赖关系
initController(DataProvider);
initAdmin(Controller, View, AdminCore);
initView(Controller, Admin, AdminCore);
initLayout();
initTheme();

// DOM Ready Initialization
document.addEventListener('DOMContentLoaded', async () => {
    console.log("Photos Admin: Initializing...");

    // Setup CMS Tags Adapter
    const adapterResult = setupPhotosAdapter(applyTagFilters, Controller);

    // Assign to module-level variables
    AppState = adapterResult.AppState;
    // Inject into AdminCore so Views can access it for filtering checks
    AdminCore.AppState = AppState;
    mockController = adapterResult.mockController;
    mockSearch = adapterResult.mockSearch;
    StateWrapper = adapterResult.StateWrapper;

    // Preload tag categories
    const currentCategory = (Controller?.State?.category) || 'default';
    const dynamicModuleName = `photos-${currentCategory}`;
    await preloadTagCategories(AppState, dynamicModuleName);

    // Initialize CMS Tags System
    console.log("Photos Admin: Initializing CMS Tags...");
    initTags(StateWrapper, mockController, mockSearch);

    // Initialize Navigation (Breadcrumb)
    if (initNav && Nav) {
        initNav({
            State: StateWrapper,
            Search: mockSearch,
            Drag: null,
            renderGrid: () => { },
            renderBreadcrumb: Nav.renderBreadcrumb
        });
        Nav.renderBreadcrumb?.();
    }

    // -- Unified Save Logic (Photos + Tags) --
    if (SaveButton && SaveButton.initUnified) {
        SaveButton.initUnified(
            [
                () => Admin.getManager?.(),
                () => Tags.getManager?.()
            ],
            async () => {
                // Joint Save
                let r1 = true;
                if (Admin.performSave) {
                    try {
                        const res = await Admin.performSave();
                        if (res === false) r1 = false;
                    } catch (e) {
                        r1 = false;
                        console.error(e);
                    }
                }

                let r2 = true;
                if (Tags.tagPerformSave) {
                    try {
                        const res = await Tags.tagPerformSave();
                        if (res === false) r2 = false;
                    } catch (e) {
                        r2 = false;
                        console.error(e);
                    }
                }

                if (r1 !== false && r2 !== false) {
                    Feedback.notifySaveSuccess();
                } else {
                    Feedback.notifySaveFail("部分保存失败");
                }
            },
            async () => {
                // Joint Cancel
                if (Admin.performCancel) await Admin.performCancel();
                if (Tags.tagPerformCancel) await Tags.tagPerformCancel();
                Feedback.notifyCancel();
            }
        );

        // Re-hook Tags manager when drawer opens (lazy initialization)
        const originalToggle = Tags.toggleTagDrawer;
        Tags.toggleTagDrawer = () => {
            originalToggle();

            // Retry hooking for stability
            const tryHook = (attempts = 0) => {
                if (SaveButton.reHook) {
                    SaveButton.reHook();

                    // Verify if manager is captured
                    const tm = Tags.getManager?.();
                    if (tm && !tm._unifiedHook) {
                        if (attempts < 5) setTimeout(() => tryHook(attempts + 1), 200);
                    }
                }
            };

            setTimeout(() => tryHook(), 100);
        };
    }

    // Bind Tags Toggle Button
    const tagToggleBtn = document.getElementById('tag-toggle-btn');
    if (tagToggleBtn) {
        tagToggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            Tags.toggleTagDrawer();
        });
    }

    // Bind Close Button
    const closeBtn = document.querySelector('.btn-close-drawer');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            Tags.toggleTagDrawer();
        });
    }

    // Bind Overlay Click
    const overlay = document.getElementById('drawer-overlay');
    if (overlay) {
        overlay.addEventListener('click', () => {
            Tags.toggleTagDrawer();
        });
    }

    // Bind Clear All button
    const clearBtn = document.querySelector('.btn-clear-tags');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            const input = document.getElementById('tag-drawer-search');
            if (input) input.value = '';
            Tags.clearTagFilter();
        });
    }

    // Bind tag search input
    const tagSearchInput = document.getElementById('tag-drawer-search');
    if (tagSearchInput) {
        tagSearchInput.addEventListener('input', () => {
            Tags.refreshDrawerList();
        });
    }
});

// Apply tag filters function
function applyTagFilters() {
    // Perform search to update filtered nodes
    if (mockSearch && mockSearch.performSearch) {
        mockSearch.performSearch();
    }

    // Re-render Breadcrumb
    if (Nav && Nav.renderBreadcrumb) {
        Nav.renderBreadcrumb();
    }

    // Re-render with filtered data
    if (AppState) {
        const dataToRender = AppState.activeFilters.size > 0
            ? AppState.filteredNodes
            : Controller.State.loadedData;

        View.render(dataToRender);
    }
}

// Sync photos data to AppState when loaded
const originalReload = Controller.reloadData;
if (originalReload) {
    Controller.reloadData = async function () {
        await originalReload.call(Controller);

        // Sync to AppState (only if initialized)
        if (AppState) {
            AppState.allNodes = Controller.State.loadedData || [];
            if (mockSearch && mockSearch.performSearch) {
                mockSearch.performSearch();
            }
        }
    };
}
