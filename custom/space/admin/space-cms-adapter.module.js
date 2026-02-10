/**
 * Space-CMS Adapter Module
 * 
 * 为 Space Admin 提供 CMS 模块兼容层，使其能够复用 CMS 的 Tags、Recent、Nav 等组件。
 * 核心逻辑现已抽取至 custom/cms/cms-adapter.module.js
 * 
 * @module custom/space/admin/space-cms-adapter.module.js
 * @version 1.1.0 - Refactored to use Shared Adapter
 */

import { setupBaseAdapter, preloadTagCategories } from '../../cms/cms-adapter.module.js';

/**
 * 设置 Space-CMS 适配器
 * @param {Function} applyFiltersCallback - Space Admin 的 applyFilters 函数
 * @returns {Object} 包含 AppState, mockController, mockSearch, StateWrapper, AdminCore 的对象
 */
export function setupSpaceAdapter(applyFiltersCallback) {
    // 1. 获取通用适配器对象
    const base = setupBaseAdapter('space', applyFiltersCallback);
    const { AppState, mockSearch } = base;

    // 2. 注入 Space 特有的 Search 逻辑
    mockSearch.performSearch = () => {
        const query = AppState.searchQuery.toLowerCase();

        AppState.filteredNodes = AppState.allNodes.filter(node => {
            // 搜索过滤
            const matchesSearch = !query ||
                node.name?.toLowerCase().includes(query) ||
                node.title?.toLowerCase().includes(query) ||
                node.description?.toLowerCase().includes(query) ||
                node.content?.toLowerCase().includes(query);

            // 标签过滤
            const matchesTags = AppState.activeFilters.size === 0 ||
                Array.from(AppState.activeFilters).every(tag => node.tags?.includes(tag));

            return matchesSearch && matchesTags;
        });
    };

    // 3. 复写 applyFilter 以包含 search 调用
    mockSearch.applyFilter = () => {
        mockSearch.performSearch(); // Update filteredNodes
        if (typeof applyFiltersCallback === 'function') {
            applyFiltersCallback();
        }
    };

    return base;
}

export { preloadTagCategories };
