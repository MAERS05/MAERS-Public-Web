/**
 * Photos-CMS Adapter Module
 * 
 * 为 Photos Admin 提供 CMS 模块兼容层，使其能够复用 CMS 的 Tags 等组件。
 * 核心逻辑现已抽取至 custom/cms/cms-adapter.module.js
 * 
 * @module custom/photos/admin/photos-cms-adapter.module.js
 * @version 1.1.0 - Refactored to use Shared Adapter
 */

import { setupBaseAdapter, preloadTagCategories } from '../../cms/cms-adapter.module.js';

/**
 * 设置 Photos-CMS 适配器
 * @param {Function} applyFiltersCallback - Photos Admin 的 applyFilters 函数
 * @param {Object} photosController - Photos Controller 对象
 * @param {Object} [extraConfig] - Optional configuration overrides (e.g. initialState)
 * @returns {Object} 包含 AppState, mockController, mockSearch, StateWrapper 的对象
 */
export function setupPhotosAdapter(applyFiltersCallback, photosController, extraConfig = {}) {
    // 1. 定义 Controller 覆盖项
    const controllerOverrides = {
        updateNodeTags: async (nodeId, tags) => {
            try {
                const res = await fetch('/api/photos/update_tags', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: nodeId, tags: tags })
                });

                if (res.ok) {
                    // Update local data cache in photosController
                    const localNode = photosController?.State?.loadedData?.find(p => p.id === nodeId);
                    if (localNode) {
                        localNode.tags = tags;
                    }
                    return true;
                }
                return false;
            } catch (e) {
                console.error("Failed to update photo tags:", e);
                return false;
            }
        },
        SELECTORS: {
            HEADER_RIGHT: ".header-actions",
            TAG_TOGGLE_BTN: "#tag-toggle-btn",
            GRID_ITEM: ".photo-item",
            MINI_TAG: ".photo-tag-chip",
            BREADCRUMB: "#breadcrumb",
            GRID_CONTAINER: "#gallery-container",
            TAG_DRAWER: "#tag-drawer",
            DRAWER_OVERLAY: "#drawer-overlay",
            DRAWER_LIST: "#drawer-list",
            SEARCH_INPUT: "#search-input",
            TAG_DRAWER_SEARCH: "#tag-drawer-search"
        }
    };

    // 2. 获取通用适配器对象
    // Merge controllerOverrides with any extraConfig.controllerOverrides
    const finalConfig = {
        ...extraConfig,
        controllerOverrides: {
            ...controllerOverrides,
            ...(extraConfig.controllerOverrides || {})
        }
    };

    // Determine dynamic module name
    // e.g. "photos-nature", "photos-gamecovers"
    const currentCategory = (photosController?.State?.category) || 'default';
    const dynamicModuleName = `photos-${currentCategory}`;

    const base = setupBaseAdapter(dynamicModuleName, applyFiltersCallback, finalConfig);
    const { AppState, mockSearch } = base;

    // 3. 注入 Photos 特有的 Search 逻辑
    mockSearch.performSearch = () => {
        const query = AppState.searchQuery.toLowerCase();
        // Photos 模块的数据源位于 photosController.State.loadedData
        const sourceData = photosController?.State?.loadedData || [];

        AppState.filteredNodes = sourceData.filter(photo => {
            // 搜索过滤
            const matchesSearch = !query ||
                photo.name?.toLowerCase().includes(query) ||
                photo.path?.toLowerCase().includes(query);

            // 标签过滤
            const matchesTags = AppState.activeFilters.size === 0 ||
                Array.from(AppState.activeFilters).every(tag => photo.tags?.includes(tag));

            return matchesSearch && matchesTags;
        });
    };

    // 4. 复写 applyFilter 以包含 search 调用
    mockSearch.applyFilter = () => {
        mockSearch.performSearch(); // Update filteredNodes
        if (typeof applyFiltersCallback === 'function') {
            applyFiltersCallback();
        }
    };

    return base;
}

export { preloadTagCategories };
