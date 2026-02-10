// 导入 CMS 通用模块
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../data-manage/admin-base.module.js';
import { initLayout } from '../../shared/layout.module.js';
import { initTheme } from '../../shared/theme.module.js';
import { initTags, Tags } from '../cms/viewer/cms-tags.module.js';
import { initRecent, Recent } from '../cms/viewer/cms-recent.module.js';
import { initNav, Nav } from '../cms/viewer/render/cms-render-nav.module.js';

import { SpaceAdmin, initSpaceAdmin, applyFilters } from './admin/space-admin.module.js';
import { setupSpaceAdapter, preloadTagCategories } from './admin/space-cms-adapter.module.js';

initLayout();
initTheme();

// 使用适配器设置 CMS 兼容层
const { AppState, mockController, mockSearch, StateWrapper } = setupSpaceAdapter(applyFilters);

// 预加载标签数据
preloadTagCategories(AppState);

const AdminCore = {
    BatchItemManager,
    SaveButton,
    AdminButtonHelper,
    Feedback,
    Tags,
    Recent,
    Nav,
    Search: mockSearch,
    AppState
};

// 初始化 CMS 共享模块
console.log("Initializing CMS Tags with StateWrapper", StateWrapper);
initTags(StateWrapper, mockController, mockSearch);

const mockRender = {
    renderBreadcrumb: () => {
        if (Nav && Nav.renderBreadcrumb) {
            Nav.renderBreadcrumb();
        }
    }
};

initNav({
    State: StateWrapper,
    Search: mockSearch,
    Drag: null,
    renderGrid: null,
    renderBreadcrumb: mockRender.renderBreadcrumb
});

initRecent(StateWrapper, mockController, {
    renderList: () => { },
    openFile: (node) => window.open(node.url, '_blank') // Fix View method name for Recent module
});

// 绑定搜索框
// 绑定搜索框
const searchInput = document.getElementById('search-input');
if (searchInput) {
    let lastKeyword = "";

    searchInput.addEventListener('input', (e) => {
        const currentKeyword = e.target.value.trim();

        // Update Filter Badge Logic (Synced from CMS Search)
        if (lastKeyword === "" && currentKeyword !== "") {
            StateWrapper.addFilter(currentKeyword);
        } else if (lastKeyword !== "" && currentKeyword === "") {
            StateWrapper.removeFilter(lastKeyword);
        } else if (lastKeyword !== "" && currentKeyword !== "" && lastKeyword !== currentKeyword) {
            StateWrapper.removeFilter(lastKeyword);
            StateWrapper.addFilter(currentKeyword);
        }

        lastKeyword = currentKeyword;

        AppState.searchQuery = currentKeyword;
        mockSearch.performSearch();

        if (typeof applyFilters === 'function') {
            applyFilters();
        }
        if (Nav && Nav.renderBreadcrumb) {
            Nav.renderBreadcrumb();
        }
    });
}

// 绑定标签按钮
const tagToggleBtn = document.getElementById('tag-toggle-btn');
if (tagToggleBtn) {
    tagToggleBtn.addEventListener('click', () => {
        Tags.toggleTagDrawer();
    });
}
const tagCloseBtn = document.querySelector('.btn-close-drawer');
if (tagCloseBtn) {
    tagCloseBtn.addEventListener('click', () => {
        Tags.toggleTagDrawer();
    });
}

// 确保初始状态时清空 activeFilters
AppState.activeFilters = new Set();


// 初始化 Space 专属逻辑
initSpaceAdmin(AdminCore);

// Initialize Breadcrumb immediately (Fix "No Breadcrumb" issue)
if (Nav && Nav.renderBreadcrumb) {
    Nav.renderBreadcrumb();
}

// -- Unified Save Logic (Space + Tags) --
SaveButton.initUnified(
    [
        () => SpaceAdmin.getManager?.(),
        () => Tags.getManager?.()
    ],
    async () => {
        const r1 = await SpaceAdmin.performSave?.();
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
        }
    },
    async () => {
        // Joint Cancel
        await SpaceAdmin.performCancel?.();
        if (Tags.tagPerformCancel) await Tags.tagPerformCancel();
        Feedback.notifyCancel();
    }
);

// Re-hook Tags manager when drawer opens (lazy initialization)
const originalToggle = Tags.toggleTagDrawer;
Tags.toggleTagDrawer = () => {
    originalToggle();
    setTimeout(() => SaveButton.reHook?.(), 100);
};
