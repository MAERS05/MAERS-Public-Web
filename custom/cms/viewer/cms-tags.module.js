/**
 * MAERS CMS - Tags Module (cms-tags.module.js)
 * 职责：标签系统、抽屉管理、分类管理
 * @version 3.0.0 - ES6 Module
 */

import { BatchItemManager, SaveButton, AdminButtonHelper } from '../../shared/admin-core.module.js';

// Dependency injection
let State = null;
let Controller = null;
let Search = null;

export function initTags(state, controller, search) {
    State = state;
    Controller = controller;
    Search = search;
}

// Track which categories are expanded
const expandedCategories = new Set();

// Admin Manager
let categoryManager = null;

function initManager() {
    if (State && State.IS_ADMIN && !categoryManager) {
        // Init with current categories reference
        const categories = (Controller && Controller.AppState.tagCategories) ? Controller.AppState.tagCategories : [];
        categoryManager = new BatchItemManager({
            list: categories,
            onUpdate: refreshDrawerList,
            onChange: () => {
                SaveButton.show();
            }
        });

        SaveButton.init(document.body, async () => {
            // Save Logic
            const cats = categoryManager.list.filter(c => !c._deleted); // Filter out soft-deleted
            await Controller.saveTagCategories(cats);
            categoryManager.clearSelection();
            // Important: Update snapshot after save!
            if (categoryManager.setList) {
                categoryManager.setList(Controller.AppState.tagCategories);
                categoryManager.selectedIndices = []; // Fix: Ensure selected indices are cleared on save
            }
            refreshDrawerList();
        }, async () => {
            // Cancel Logic - Reset to initial snapshot
            if (categoryManager) {
                categoryManager.reset();
                refreshDrawerList();
                if (window.MAERS?.Toast) window.MAERS.Toast.info("修改已取消");
            }
        });
    }
}

export function filterByTag(e, tag) {
    if (e.target.closest('.dragging') || e.target.classList.contains('dragging')) return;
    e.stopPropagation();
    if (State.AppState.activeFilters.has(tag)) {
        State.AppState.activeFilters.delete(tag);
    } else {
        State.AppState.activeFilters.add(tag);
    }
    if (Search?.applyFilter) Search.applyFilter();
    refreshDrawerList();
}

export function toggleTagDrawer() {
    const drawer = document.getElementById(State.SELECTORS.TAG_DRAWER.slice(1));
    const overlay = document.getElementById("drawer-overlay");
    if (!drawer) return;
    const active = drawer.classList.toggle("active");
    if (overlay) overlay.classList.toggle("active", active);
    if (active) {
        initManager(); // Ensure initialized
        refreshDrawerList();
    }
}

// --- Tag Dragging ---
async function handleDropTag(tagName, targetCategoryName) {
    // Deep copy current categories to modify
    const categories = Controller.AppState.tagCategories || [];

    // Logic: Remove tag from all cats, add to target
    categories.forEach(c => {
        if (c.tags && c.tags.includes(tagName)) {
            c.tags = c.tags.filter(t => t !== tagName);
        }
    });

    if (targetCategoryName !== '_UNCATEGORIZED_') {
        const target = categories.find(c => c.name === targetCategoryName.replace(/&quot;/g, '"')); // unescape if needed
        if (target) {
            if (!target.tags) target.tags = [];
            target.tags.push(tagName);
        }
    }

    SaveButton.show();
    refreshDrawerList();
}

export function refreshDrawerList() {
    const listContainer = document.getElementById("drawer-list");
    const inputEl = document.getElementById("tag-drawer-search");
    if (!listContainer) return;

    // Update Manager Ref if needed (in case data reloaded externally)
    if (categoryManager && Controller) {
        if (categoryManager.list !== Controller.AppState.tagCategories) {
            // 使用 updateListReference 避免重置快照和丢失选中项
            if (categoryManager.updateListReference) {
                categoryManager.updateListReference(Controller.AppState.tagCategories);
            } else {
                categoryManager.setList(Controller.AppState.tagCategories);
            }
        }
    }

    // 1. Tag Counts
    const tagCounts = {};
    State.AppState.allNodes.forEach((node) => {
        (node.tags || []).forEach((t) => {
            tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
    });

    // 2. Search
    const query = inputEl ? inputEl.value.trim().toLowerCase() : "";
    let visibleTags = Object.keys(tagCounts);
    if (query) visibleTags = visibleTags.filter(t => t.toLowerCase().includes(query));

    // 3. Organize
    const categories = State.AppState.tagCategories || [];
    const categorizedTags = new Set();
    const categoriesMap = {};

    categories.forEach(cat => {
        categoriesMap[cat.name] = [];
        (cat.tags || []).forEach(t => {
            if (visibleTags.includes(t)) {
                categoriesMap[cat.name].push(t);
                categorizedTags.add(t);
            }
        });
    });

    const uncategorized = visibleTags.filter(t => !categorizedTags.has(t));

    // 4. Render
    let html = '';

    // Add Category Button
    if (State.IS_ADMIN) {
        html += `<div style="padding: 5px 15px; margin-bottom: 5px;">
                <button class="add-cat-btn" style="background:none;color:#a0a0a5;border:none;cursor:pointer;">＋ 添加分类</button>
             </div>`;
    }



    const renderTag = (tag) => {
        const count = tagCounts[tag];
        const active = State.AppState.activeFilters.has(tag) ? "active" : "";
        const safeTag = State.escapeAttr(tag);
        const encTag = State.escapeHtml(tag);
        return `<div class="drawer-item ${active}" data-tag="${safeTag}" draggable="true">
               <span>#${encTag}</span>
               <span class="tag-count-badge">${count}</span>
            </div>`;
    };

    // Render Categories
    categories.forEach((cat, catIndex) => {
        const tagsHtml = categoriesMap[cat.name].map(renderTag).join('');
        let extraClass = '';
        let adminButtonsPlaceholder = '';

        // Admin Logic
        if (State.IS_ADMIN && categoryManager) {
            extraClass = categoryManager.getItemClass(catIndex);
            // Use placeholder that will be replaced with DOM element
            adminButtonsPlaceholder = `<span class="admin-buttons-placeholder" data-cat-index="${catIndex}"></span>`;
        }

        const isExpanded = expandedCategories.has(cat.name);
        const iconRotation = isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        const listStyle = isExpanded ? 'max-height:1000px;opacity:1;min-height:30px;' : 'max-height:0px;opacity:0;min-height:0;margin-top:0;';

        // Category Wrapper
        const catId = `cat-group-${catIndex}`;

        // 添加序号属性
        let orderNumAttr = '';
        if (State.IS_ADMIN && categoryManager && categoryManager.selectedIndices.includes(catIndex)) {
            const orderNum = categoryManager.selectedIndices.indexOf(catIndex) + 1;
            orderNumAttr = `data-order-num="${orderNum}"`;
        }

        html += `<div id="${catId}" class="tag-category-group ${extraClass}" 
                  data-category="${State.escapeAttr(cat.name)}" 
                  ${orderNumAttr}
                  style="margin-bottom: 15px; padding: 10px; border-radius: 8px; transition: all 0.2s;">
                  <div class="category-header" style="font-weight:bold;margin-bottom:5px;display:flex;align-items:center;cursor:pointer;">
                      <span class="cat-toggle-icon" style="transform:${iconRotation};margin-right:8px;">▼</span>
                      <span class="category-name" style="flex:1;">${State.escapeHtml(cat.name)}</span>
                      ${adminButtonsPlaceholder}
                  </div>
                  <div class="category-tags-list" style="display:flex;flex-wrap:wrap;gap:5px;overflow:hidden;transition:all 0.3s ease;${listStyle}">
                      ${tagsHtml || '<span style="font-size:12px;color:#555;">Empty</span>'}
                  </div>
               </div>`;
    });

    // Uncategorized
    if (uncategorized.length > 0) {
        const isExpanded = expandedCategories.has('_UNCATEGORIZED_');
        const iconRotation = isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        const listStyle = isExpanded ? 'max-height:1000px;opacity:1;' : 'max-height:0px;opacity:0;';

        html += `<div class="tag-category-group" data-category="_UNCATEGORIZED_" style="padding:10px;">
                  <div class="category-header" style="font-weight:bold;margin-bottom:5px;cursor:pointer;display:flex;align-items:center;">
                      <span class="cat-toggle-icon" style="transform:${iconRotation};margin-right:8px;">▼</span>
                      <span class="category-name" style="flex:1;">其他</span>
                  </div>
                  <div class="category-tags-list" style="display:flex;flex-wrap:wrap;gap:5px;overflow:hidden;transition:all 0.3s ease;${listStyle}">
                      ${uncategorized.map(renderTag).join('')}
                  </div>
              </div>`;
    }

    listContainer.innerHTML = html;

    // Replace placeholders with actual DOM elements
    if (State.IS_ADMIN && categoryManager) {
        listContainer.querySelectorAll('.admin-buttons-placeholder').forEach(placeholder => {
            const catIndex = parseInt(placeholder.dataset.catIndex, 10);
            const isDel = categoryManager.isDeleted(catIndex);

            const buttons = AdminButtonHelper.render({
                index: catIndex,
                isDeleted: isDel,
                onSort: (e) => uiSort(catIndex, e),
                onEdit: (e) => uiEdit(catIndex, e),
                onDelete: (e) => uiDelete(catIndex, e),
                extraClass: ''
            });

            placeholder.replaceWith(buttons);
        });
    }

    // Event Binding
    attachEvents(listContainer, State);
}

function attachEvents(container, State) {
    // Toggle Expansion
    container.querySelectorAll('.category-header').forEach(header => {
        header.addEventListener('click', (e) => {
            if (e.target.closest('.cat-action-btn') || e.target.closest('.maers-admin-btn')) return;

            const group = header.closest('.tag-category-group');

            // 如果有选中项，执行移动操作并阻止折叠
            if (categoryManager && categoryManager.selectedIndices.length > 0) {
                e.stopPropagation();
                const index = parseInt(group.id.split('-').pop(), 10);
                if (!isNaN(index)) categoryManager.moveTo(index);
                return;
            }

            const name = group.dataset.category;
            // logic fix: allow toggle if uncategorized OR manager is null (visitor) OR manager says not deleted
            if (name === '_UNCATEGORIZED_' || !categoryManager || !categoryManager.isDeleted(group.getAttribute('onclick')?.match(/\d+/)?.[0])) {
                if (expandedCategories.has(name)) expandedCategories.delete(name);
                else expandedCategories.add(name);
                refreshDrawerList();
            }
        });
    });

    // Fix Z-Index for Save Bar (ensure it's above everything)
    const saveBar = document.querySelector('.global-save-bar');
    if (saveBar) saveBar.style.zIndex = '2147483647';

    // Tag Dragging
    container.querySelectorAll('.drawer-item').forEach(el => {
        el.addEventListener('click', (e) => filterByTag(e, el.dataset.tag));
        el.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', el.dataset.tag);
            el.classList.add('dragging');
        });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
    });

    // Category Drop Zone
    if (State.IS_ADMIN) {
        container.querySelectorAll('.tag-category-group').forEach(group => {
            group.addEventListener('dragover', (e) => { e.preventDefault(); group.style.background = 'rgba(255,255,255,0.05)'; });
            group.addEventListener('dragleave', () => { group.style.background = ''; });
            group.addEventListener('drop', (e) => {
                e.preventDefault();
                group.style.background = '';
                const tag = e.dataTransfer.getData('text/plain');
                const cat = group.dataset.category;
                if (tag && cat) handleDropTag(tag, cat);
            });
        });

        const addBtn = container.querySelector('.add-cat-btn');
        if (addBtn) addBtn.onclick = createCategory;
    }
}

// --- Admin UI Callbacks ---

export function uiSort(index, e) {
    if (e) e.stopPropagation();
    if (categoryManager) categoryManager.toggleSelect(index);
}

export function uiMoveTo(index, e) {
    if (e) e.stopPropagation();
    // 只有在有选中项时才执行移动
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
        refreshDrawerList();
    }
}

export function uiDelete(index, e) {
    if (e) e.stopPropagation();
    if (categoryManager) categoryManager.toggleDelete(index);
}

async function createCategory() {
    const name = prompt("Enter Category Name:");
    if (!name || !categoryManager) return;

    // Add locally first
    categoryManager.list.push({ name: name, tags: [] });

    // Auto Save (Direct Execution)
    const cats = categoryManager.list.filter(c => !c._deleted);
    try {
        if (Controller && Controller.saveTagCategories) {
            await Controller.saveTagCategories(cats);

            // Sync & Reset Manager Snapshot
            if (categoryManager.setList) {
                // Controller.saveTagCategories usually reloads data or we assume current list is now valid
                categoryManager.setList(cats);
            }

            // Hide SaveBar
            if (SaveButton) SaveButton.hide();

            if (window.MAERS?.Toast) window.MAERS.Toast.success("分类已添加");
        } else {
            // Fallback if controller method missing
            categoryManager.onChange();
        }
    } catch (e) {
        console.error(e);
        alert("保存失败: " + e.message);
    }

    refreshDrawerList();
}

export function clearTagFilter() {
    State.AppState.activeFilters.clear();
    const mainInput = document.getElementById("search-input");
    if (mainInput) mainInput.value = "";
    if (Search?.applyFilter) Search.applyFilter();
    refreshDrawerList();
}

export function selectTagFromDrawer(tag) {
    if (!State.AppState.activeFilters.has(tag)) {
        State.AppState.activeFilters.add(tag);
        if (Search?.applyFilter) Search.applyFilter();
        refreshDrawerList();
    }
}

export const Tags = {
    filterByTag,
    toggleTagDrawer,
    refreshDrawerList,
    selectTagFromDrawer,
    clearTagFilter,
    // Admin ops
    uiSort,
    uiMoveTo,
    uiEdit,
    uiDelete
};
