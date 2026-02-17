/**
 * @module custom/cms/viewer/tags/cms-tags-drawer.module.js
 * @description CMS 标签抽屉 - 控制器 (Controller)
 * @version 2.0.0 - Refactored
 */

import { TagsApi } from '../../admin/cms-tags-api.module.js';
import { TagsRender } from './cms-tags-render.module.js';
import { TagsUI } from './cms-tags-ui.module.js';
import { SaveButton } from '../../../../data-manage/admin-base.module.js';

// Dependency injection
let State = null;
let Controller = null;
let categoryManager = null;
let selectedTags = null;
let expandedCategories = null;
let filterByTagCallback = null;
let handleMoveTagsCallback = null;
let uiSortCallback = null;
let uiEditCallback = null;
let uiDeleteCallback = null;
let createCategoryCallback = null;
let tagFilterMode = 'AND';
let toggleFilterModeCallback = null;

// Track if event delegation is set up
let drawerEventDelegationSetup = false;

export function initDrawer(deps) {
    State = deps.State;
    Controller = deps.Controller;
    categoryManager = deps.categoryManager;
    selectedTags = deps.selectedTags;
    expandedCategories = deps.expandedCategories;
    filterByTagCallback = deps.filterByTag;
    handleMoveTagsCallback = deps.handleMoveTags;
    uiSortCallback = deps.uiSort;
    uiEditCallback = deps.uiEdit;
    uiDeleteCallback = deps.uiDelete;
    createCategoryCallback = deps.createCategory;
    tagFilterMode = deps.tagFilterMode;
    toggleFilterModeCallback = deps.toggleFilterMode;
}

export function toggleTagDrawer(initManagerCallback, refreshCallback) {
    const drawer = document.getElementById('tag-drawer');
    const overlay = document.getElementById("drawer-overlay");
    if (!drawer) return;
    const active = drawer.classList.toggle("active");
    if (overlay) overlay.classList.toggle("active", active);
    if (active) {
        initManagerCallback();

        if (!drawerEventDelegationSetup) {
            setupDrawerEventDelegation(refreshCallback);
            drawerEventDelegationSetup = true;
        }

        refreshCallback();
    }
}

export function refreshDrawerList(updateManagerCallback) {
    const listContainer = document.getElementById("drawer-list");
    const inputEl = document.getElementById("tag-drawer-search");
    if (!listContainer) return;

    // 更新外部管理器引用
    updateManagerCallback();

    // 准备数据
    const query = inputEl ? inputEl.value.trim().toLowerCase() : "";

    // 调用 Render 模块
    TagsRender.render(
        listContainer,
        {
            State,
            Controller,
            categoryManager
        },
        {
            selectedTags,
            expandedCategories,
            query,
            tagFilterMode
        },
        {
            uiSort: uiSortCallback,
            uiEdit: uiEditCallback,
            uiDelete: uiDeleteCallback,
            createCategory: createCategoryCallback,
            onCleanup: () => handleCleanup(refreshDrawerList),
            onToggleFilterMode: toggleFilterModeCallback
        }
    );

    // 绑定拖拽事件 (Admin Only)
    if (State.IS_ADMIN) {
        setupDragEvents(listContainer);
    }
}

function setupDrawerEventDelegation(refreshCallback) {
    const listContainer = document.getElementById('drawer-list');
    if (!listContainer) return;

    // Context Menu
    listContainer.addEventListener('contextmenu', (e) => {
        const item = e.target.closest('.drawer-item');
        if (!item || !State.IS_ADMIN) return;

        e.preventDefault();
        e.stopPropagation();

        const tagName = item.dataset.tag;
        const categoryGroup = item.closest('.tag-category-group');
        const categoryName = categoryGroup ? categoryGroup.dataset.category : null;

        TagsUI.showContextMenu(e, tagName, categoryName, {
            onRename: (name) => handleRename(name, refreshCallback),
            onSort: (name, cat) => handleSort(name, cat, refreshCallback),
            onDelete: (name) => handleDelete(name, refreshCallback)
        });
    });

    // Clicks
    listContainer.addEventListener('click', (e) => {
        // [Fix] Close context menu check is handled by UI module auto-close, 
        // but we can ensure safe side.
        document.querySelector('.tag-context-menu')?.remove();

        e.stopPropagation();

        // 1. Tag Selection Dot
        const dot = e.target.closest('.tag-select-dot');
        if (dot) {
            e.preventDefault();
            e.stopPropagation();
            const item = dot.closest('.drawer-item');
            if (item) {
                const tagName = item.dataset.tag;
                if (selectedTags.has(tagName)) selectedTags.delete(tagName);
                else selectedTags.add(tagName);

                // Refresh passing the same updater
                refreshDrawerList(() => { });
            }
            return;
        }

        // 2. Move Here Button
        const moveBtn = e.target.closest('.tag-move-here-btn');
        if (moveBtn) {
            e.preventDefault();
            e.stopPropagation();
            const group = moveBtn.closest('.tag-category-group');
            const catName = group.dataset.category;
            if (State.IS_ADMIN && selectedTags.size > 0 && catName) {
                handleMoveTagsCallback(Array.from(selectedTags), catName);
            }
            return;
        }

        // 3. Category Header (Collapse/Move)
        const header = e.target.closest('.category-header');
        if (header) {
            if (e.target.closest('.cat-action-btn') || e.target.closest('.maers-admin-btn') || e.target.closest('.tag-move-here-btn')) return;

            const group = header.closest('.tag-category-group');
            const catName = group.dataset.category;

            // Admin: Category Move Logic
            if (categoryManager && categoryManager.selectedIndices.length > 0) {
                e.stopPropagation();
                const indexStr = group.id.split('-').pop();
                const index = parseInt(indexStr, 10);
                if (!isNaN(index)) categoryManager.moveTo(index);
                return;
            }

            // Collapse/Expand
            if (catName === '_UNCATEGORIZED_' || !categoryManager) {
                toggleCategoryExpand(catName);
            } else {
                const indexStr = group.id.split('-').pop();
                if (!categoryManager.isDeleted(parseInt(indexStr, 10))) {
                    toggleCategoryExpand(catName);
                }
            }
            // Refresh
            refreshDrawerList(() => { });
            return;
        }

        // 4. Tag Item Click (Filter)
        const item = e.target.closest('.drawer-item');
        if (item) {
            const tagName = item.dataset.tag;
            filterByTagCallback(null, tagName);
            return;
        }
    });
}

function toggleCategoryExpand(catName) {
    if (expandedCategories.has(catName)) expandedCategories.delete(catName);
    else expandedCategories.add(catName);
}

// ================= Actions =================

function getModuleName() {
    return Controller?.CONFIG?.CURRENT_MODULE || 'notes';
}

async function handleRename(oldName, refreshCallback) {
    const newName = prompt(`重命名标签 "${oldName}":`, oldName);
    if (!newName?.trim() || newName.trim() === oldName) return;

    const res = await TagsApi.renameTag(getModuleName(), oldName, newName.trim());
    if (res.success) {
        // Update Local State for immediate feedback (with deduplication)
        if (Controller?.AppState?.allNodes) {
            Controller.AppState.allNodes.forEach(node => {
                if (node.tags && node.tags.includes(oldName)) {
                    // Replace then deduplicate (handles case where node has both old and new tag)
                    const renamed = node.tags.map(t => t === oldName ? newName.trim() : t);
                    node.tags = [...new Set(renamed)];
                }
            });
        }
        if (selectedTags.has(oldName)) {
            selectedTags.delete(oldName);
            selectedTags.add(newName.trim());
        }

        // Update Active Filters and Filter Order if the renamed tag was active
        if (State?.renameFilter) {
            State.renameFilter(oldName, newName.trim());
        } else if (Controller?.AppState?.activeFilters?.has(oldName)) {
            // Fallback for non-StateWrapper environments
            Controller.AppState.activeFilters.delete(oldName);
            Controller.AppState.activeFilters.add(newName.trim());
        }

        // Reload categories
        const categories = await TagsApi.getCategories(getModuleName());
        if (categories && Controller?.AppState) {
            Controller.AppState.tagCategories = categories;
        }

        alert(`✅ 标签已重命名: ${oldName} → ${newName.trim()}\n已更新 ${res.count} 个项目`);
        if (refreshCallback) refreshCallback();
        categoryManager?.setList(Controller.AppState.tagCategories);
        if (typeof Controller?.refreshView === 'function') Controller.refreshView(false, true);
        SaveButton?.hide();
    } else {
        alert('❌ 重命名失败: ' + res.error);
    }
}

async function handleDelete(tagName, refreshCallback) {
    if (!confirm(`确认删除标签 #${tagName}？\n所有使用该标签的项目都会移除此标签。`)) return;

    const res = await TagsApi.deleteTag(getModuleName(), tagName);
    if (res.success) {
        // Update Local State
        if (Controller?.AppState?.allNodes) {
            Controller.AppState.allNodes.forEach(node => {
                if (node.tags && node.tags.includes(tagName)) {
                    node.tags = node.tags.filter(t => t !== tagName);
                }
            });
        }
        if (selectedTags.has(tagName)) selectedTags.delete(tagName);

        // Update Active Filters and Filter Order if the deleted tag was active
        if (State?.removeFilter) {
            State.removeFilter(tagName);
        } else if (Controller?.AppState?.activeFilters?.has(tagName)) {
            // Fallback
            Controller.AppState.activeFilters.delete(tagName);
        }

        // Reload categories
        const categories = await TagsApi.getCategories(getModuleName());
        if (categories && Controller?.AppState) {
            Controller.AppState.tagCategories = categories;
        }

        alert(`✅ 标签已删除: ${tagName}\n已从 ${res.count} 个项目中移除`);
        if (refreshCallback) refreshCallback();
        categoryManager?.setList(Controller.AppState.tagCategories);
        if (typeof Controller?.refreshView === 'function') Controller.refreshView(false, true);
        SaveButton?.hide();
    } else {
        alert('❌ 删除失败: ' + res.error);
    }
}

function handleSort(tagName, categoryName, refreshCallback) {
    TagsUI.startTagReorder(tagName, categoryName, async (startTag, targetTag) => {
        // Reordering Logic
        const categories = State.AppState.tagCategories || [];
        const category = categories.find(cat => cat.name === categoryName);

        if (!category || !category.tags) return;

        const tags = [...category.tags];
        const sourceIndex = tags.indexOf(startTag);
        const targetIndex = tags.indexOf(targetTag);

        if (sourceIndex === -1 || targetIndex === -1) return;

        // Move
        const [moved] = tags.splice(sourceIndex, 1);
        tags.splice(targetIndex > sourceIndex ? targetIndex : targetIndex + 1, 0, moved);
        category.tags = tags;

        // Save
        const success = await TagsApi.saveCategories(getModuleName(), categories);
        if (success) {
            Controller.AppState.tagCategories = categories;
            if (refreshCallback) refreshCallback();
            categoryManager?.setList(categories);
            if (SaveButton) SaveButton.hide();
        } else {
            alert('保存排序失败');
        }
    });
}

async function handleCleanup(refreshCallback) {
    const moduleName = getModuleName();
    if (!confirm(`确认清理 "${moduleName}" 中未使用的标签？`)) return;

    const res = await TagsApi.cleanupTags(moduleName);
    if (res.success) {
        if (res.removed_count > 0) {
            const categories = await TagsApi.getCategories(moduleName);
            if (categories && Controller?.AppState) {
                Controller.AppState.tagCategories = categories;
            }
            alert(`✅ 已清理 ${res.removed_count} 个标签:\n${res.removed_tags.join(', ')}`);
            if (refreshCallback) refreshCallback(() => { });
            categoryManager?.setList(Controller.AppState.tagCategories);
            SaveButton?.hide();
        } else {
            alert('✨ 没有需要清理的标签');
        }
    } else {
        alert('❌ 清理失败: ' + res.error);
    }
}

function setupDragEvents(container) {
    container.querySelectorAll('.tag-category-group').forEach(group => {
        group.addEventListener('dragover', (e) => {
            e.preventDefault();
            group.classList.add('drag-over');
        });
        group.addEventListener('dragleave', () => {
            group.classList.remove('drag-over');
        });
        group.addEventListener('drop', (e) => {
            e.preventDefault();
            group.classList.remove('drag-over');
            const tag = e.dataTransfer.getData('text/plain');
            const cat = group.dataset.category;
            if (tag && cat) handleMoveTagsCallback([tag], cat);
        });
    });
}
