/**
 * @module custom/cms/admin/cms-tags-admin.module.js
 * @description CMS 标签管理 - 分类管理与批量操作
 * @version 1.0.0 - ES6 Module
 */

import { BatchItemManager, SaveButton } from '../../../data-manage/admin-base.module.js';

// Dependency injection
let State = null;
let Controller = null;

// Track which categories are expanded
export const expandedCategories = new Set();
// Track selected tags for batch operation
export const selectedTags = new Set();

// Admin Manager
let categoryManager = null;

export function initAdmin(deps) {
    State = deps.State;
    Controller = deps.Controller;
}

export function initManager(onUpdateCallback) {
    if (State && State.IS_ADMIN && !categoryManager) {
        const categories = (Controller && Controller.AppState.tagCategories) ? Controller.AppState.tagCategories : [];
        categoryManager = new BatchItemManager({
            list: categories,
            // Revert autoSaveBar to false to rely on initUnified
            autoSaveBar: false,
            onUpdate: (newList) => {
                if (newList && Controller) {
                    // Update the source of truth immediately
                    Controller.AppState.tagCategories = newList;
                }
                if (onUpdateCallback) onUpdateCallback();
            }
        });
    }
}

export function getManager() {
    return categoryManager;
}

export function updateManagerReference() {
    if (categoryManager && Controller) {
        if (categoryManager.list !== Controller.AppState.tagCategories) {
            if (categoryManager.updateListReference) {
                categoryManager.updateListReference(Controller.AppState.tagCategories);
            } else {
                categoryManager.setList(Controller.AppState.tagCategories);
            }
        }
    }
}

export async function tagPerformSave() {
    if (!categoryManager || !Controller) return;
    const cats = categoryManager.list.filter(c => !c._deleted);
    await Controller.saveTagCategories(cats);
    categoryManager.clearSelection();
    if (categoryManager.setList) {
        categoryManager.setList(Controller.AppState.tagCategories);
        categoryManager.selectedIndices = [];
    }
}

export async function tagPerformCancel() {
    if (categoryManager && Controller) {
        categoryManager.reset();

        if (Controller.AppState && Controller.AppState.tagCategories) {
            categoryManager.setList(Controller.AppState.tagCategories);
        }
    }
}

export async function handleMoveTags(tagNames, targetCategoryName, refreshCallback) {
    if (!tagNames || tagNames.length === 0) return;

    const categories = Controller.AppState.tagCategories || [];

    tagNames.forEach(tagName => {
        // Remove from existing categories
        categories.forEach(c => {
            if (c.tags && c.tags.includes(tagName)) {
                c.tags = c.tags.filter(t => t !== tagName);
            }
        });

        // Add to target category
        if (targetCategoryName !== '_UNCATEGORIZED_') {
            // Trim target name to avoid whitespace mismatch
            const cleanTargetName = targetCategoryName.trim();
            const target = categories.find(c => c.name.trim() === cleanTargetName);

            if (target) {
                if (!target.tags) target.tags = [];
                if (!target.tags.includes(tagName)) target.tags.push(tagName);
            } else {
                console.warn(`[CMS Tags] Target category not found: "${targetCategoryName}"`);
                // Fallback: Create it? Or just leave it uncategorized?
                // For safety, warn and do nothing (tag becomes uncategorized effectively)
            }
        }
    });

    if (categoryManager) {
        categoryManager.updateSaveState();
    }

    expandedCategories.add(targetCategoryName);
    selectedTags.clear();

    const searchInput = document.getElementById('tag-drawer-search');
    const isSearching = searchInput && searchInput.value.trim().length > 0;

    if (isSearching) {
        const keepSearch = confirm(
            '是否保持搜索？\n\n' +
            '确认：保持当前搜索过滤\n' +
            '取消：清空搜索并定位到移动后的标签位置'
        );

        if (!keepSearch) {
            searchInput.value = '';
            refreshCallback();

            if (tagNames.length > 0) {
                const firstTag = tagNames[0];
                setTimeout(() => {
                    const safeTag = State.escapeAttr(firstTag);
                    const el = document.querySelector(`.drawer-item[data-tag="${safeTag}"]`);
                    if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.style.background = 'rgba(120, 255, 214, 0.3)';
                        setTimeout(() => { el.style.background = ''; }, 1000);
                    }
                }, 350);
            }
        } else {
            refreshCallback();
        }
    } else {
        refreshCallback();

        if (tagNames.length > 0) {
            const firstTag = tagNames[0];
            setTimeout(() => {
                const safeTag = State.escapeAttr(firstTag);
                const el = document.querySelector(`.drawer-item[data-tag="${safeTag}"]`);
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.style.background = 'rgba(120, 255, 214, 0.3)';
                    setTimeout(() => { el.style.background = ''; }, 1000);
                }
            }, 350);
        }
    }
}

export function uiSort(index, e) {
    if (e) e.stopPropagation();
    if (categoryManager) categoryManager.toggleSelect(index);
}

export function uiMoveTo(index, e) {
    if (e) e.stopPropagation();
    if (categoryManager && categoryManager.selectedIndices.length > 0) {
        categoryManager.moveTo(index);
    }
}

export function uiEdit(index, e) {
    if (e) e.stopPropagation();
    if (!categoryManager || !categoryManager.list[index]) return;
    const cat = categoryManager.list[index];
    const newName = prompt("编辑分类名称:", cat.name);
    if (newName && newName.trim()) {
        cat.name = newName.trim();
        categoryManager.onChange();
    }
}

export function uiDelete(index, e) {
    if (e) e.stopPropagation();
    if (categoryManager) categoryManager.toggleDelete(index);
}

export async function createCategory(refreshCallback) {
    const name = prompt("Enter Category Name:");
    if (!name || !categoryManager) return;

    categoryManager.list.push({ name: name, tags: [] });

    const cats = categoryManager.list.filter(c => !c._deleted);
    try {
        if (Controller && Controller.saveTagCategories) {
            await Controller.saveTagCategories(cats);

            if (categoryManager.setList) {
                categoryManager.setList(cats);
            }

            if (SaveButton) SaveButton.hide();

            // Toast handled by caller or unified logic if part of batch
        } else {
            categoryManager.onChange();
        }
    } catch (e) {
        console.error(e);
        alert("保存失败: " + e.message);
    }

    refreshCallback();
}
