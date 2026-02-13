/**
 * @module custom/cms/cms-adapter.module.js
 * @description CMS 适配器核心 - 提供跨模块复用 CMS 组件（如标签系统）的通用兼容层
 * @version 1.0.0
 */

/**
 * 设置基础 CMS 适配器
 * @param {string} moduleName - 当前模块名称 (e.g. 'space', 'photos')
 * @param {Function} applyFiltersCallback - 外部模块的渲染/应用回调
 * @param {Object} extraConfig - 可选配置 (initialState, controllerOverrides)
 * @returns {Object} 包含 AppState, mockController, mockSearch, StateWrapper 的对象
 */
export function setupBaseAdapter(moduleName, applyFiltersCallback, extraConfig = {}) {
    // 1. Shared State
    const AppState = {
        allNodes: [], // 默认数据源，模块可视情况覆盖或填充
        filteredNodes: [],
        searchQuery: '',
        activeFilters: new Set(), // 存储激活的过滤标签
        tagCategories: [],        // 存储标签分类
        pathStack: ['root'],      // 路径栈 (面包屑)
        IS_ADMIN: true,           // 默认启用管理权限 (适配器通常用于 Admin)
        ...extraConfig.initialState
    };

    // 2. Shared Controller
    const mockController = {
        CONFIG: { CURRENT_MODULE: moduleName },
        AppState: AppState,
        renderNodes: () => {
            if (typeof applyFiltersCallback === 'function') {
                applyFiltersCallback();
            }
        },
        // 统一的标签保存逻辑
        saveTagCategories: async (categories) => {
            try {
                const res = await fetch(`/api/cms/save_tag_categories?module=${moduleName}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(categories)
                });
                if (res.ok) {
                    AppState.tagCategories = JSON.parse(JSON.stringify(categories));
                    return true;
                } else {
                    throw new Error("Save failed");
                }
            } catch (e) {
                console.error(e);
                if (window.MAERS?.Toast) window.MAERS.Toast.error("标签保存失败");
                return false;
            }
        },
        ...extraConfig.controllerOverrides
    };

    // 3. Shared Search (Base)
    const mockSearch = {
        // 默认空实现，由具体模块覆盖
        performSearch: () => {
            console.warn(`[${moduleName}] performSearch implementation missing in adapter.`);
        },
        applyFilter: () => {
            // 标准流程：先搜索更新 filteredNodes，再回调渲染
            mockSearch.performSearch();
            if (typeof applyFiltersCallback === 'function') {
                applyFiltersCallback();
            }
        }
    };

    // 4. Shared StateWrapper
    // 管理过滤历史堆栈和 HTML 转义
    let filterOrder = [];

    const StateWrapper = {
        AppState: AppState,
        get IS_ADMIN() { return AppState.IS_ADMIN; },

        escapeAttr: (str) => {
            if (!str) return '';
            return String(str).replace(/"/g, '&quot;');
        },

        escapeHtml: (str) => {
            if (!str) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },

        addFilter(filterItem) {
            if (!filterOrder.includes(filterItem)) {
                filterOrder.push(filterItem);
                AppState.activeFilters.add(filterItem);
            }
        },

        removeFilter(filterItem) {
            const index = filterOrder.indexOf(filterItem);
            if (index !== -1) {
                filterOrder.splice(index, 1);
                AppState.activeFilters.delete(filterItem);
            }
        },

        jumpToFilter(filterItem) {
            const index = filterOrder.indexOf(filterItem);
            if (index !== -1) {
                // 截断堆栈
                filterOrder = filterOrder.slice(0, index + 1);
                // 同步 activeFilters
                AppState.activeFilters.clear();
                filterOrder.forEach(item => AppState.activeFilters.add(item));
            }
        },

        getFilterOrder() {
            return filterOrder;
        },

        clearFilters() {
            filterOrder = [];
            AppState.activeFilters.clear();
        }
    };

    return {
        AppState,
        mockController,
        mockSearch,
        StateWrapper
    };
}

/**
 * 预加载标签数据 (带静态回退)
 * @param {Object} AppState - 应用状态对象
 * @param {string} moduleName - 当前模块名称
 */
export async function preloadTagCategories(AppState, moduleName = 'cms') {
    let success = false;

    // 1. 优先尝试 API (适用于 Admin 模式或有后端支持的环境)
    try {
        const res = await fetch(`/api/cms/tag_categories?module=${moduleName}`);
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
                AppState.tagCategories = data;
                success = true;
            }
        }
    } catch (e) {
        console.warn(`[MAERS.Tags] API loading failed for ${moduleName}, trying static fallback...`);
    }

    // 2. 静态回退 (适用于 线上部署/纯静态 环境)
    if (!success) {
        try {
            const staticFile = `data/tags/${moduleName}-tag-categories.json`;
            const res = await fetch(`${staticFile}?t=${Date.now()}`);
            if (res.ok) {
                const data = await res.json();
                AppState.tagCategories = data;
            } else {
                console.warn(`[MAERS.Tags] Static fallback file not found: ${staticFile}`);
                AppState.tagCategories = [];
            }
        } catch (e) {
            console.error(`[MAERS.Tags] Failed to load tag categories for ${moduleName}`, e);
            AppState.tagCategories = [];
        }
    }
}
