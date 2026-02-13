/**
 * @module custom/cms/viewer/tags/cms-tags-drawer.module.js
 * @description CMS 标签抽屉 - UI渲染与事件委托
 * @version 1.0.0 - ES6 Module
 */

import { AdminButtonHelper } from '../../../../data-manage/admin-base.module.js';
import { Search as SearchUtils } from '../../../../shared/utils.module.js';

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
            setupDrawerEventDelegation();
            drawerEventDelegationSetup = true;
        }

        refreshCallback();
    }
}

export function refreshDrawerList(updateManagerCallback) {
    const listContainer = document.getElementById("drawer-list");
    const inputEl = document.getElementById("tag-drawer-search");
    if (!listContainer) return;

    updateManagerCallback();

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

    if (query) {
        visibleTags = visibleTags.filter(t => SearchUtils.match(t, query));
    }

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

    // Add Category Button + Cleanup Button
    if (State.IS_ADMIN) {
        html += `<div style="padding: 5px 15px; margin-bottom: 5px; display: flex; align-items: center; justify-content: space-between;">
                <button class="add-cat-btn" style="background:none;color:#a0a0a5;border:none;cursor:pointer;">＋ 添加分类</button>
                <button class="cleanup-tags-btn" title="清理未使用的标签" style="background:none;border:none;cursor:pointer;font-size:1.1rem;opacity:0.5;transition:opacity 0.2s;">🗑️</button>
             </div>`;
    }

    const renderTag = (tag) => {
        const count = tagCounts[tag];
        const active = State.AppState.activeFilters.has(tag) ? "active" : "";
        const selected = selectedTags.has(tag) ? "is-picked" : "";
        const safeTag = State.escapeAttr(tag);
        const encTag = State.escapeHtml(tag);

        return `<div class="drawer-item ${active} ${selected}" data-tag="${safeTag}" style="width: 100%; display: flex; align-items: center; justify-content: space-between; min-width: 0;">
               <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
                   ${State.IS_ADMIN ? `<span class="tag-select-dot"></span>` : ''}
                   <span class="tag-name" title="#${encTag}">#${encTag}</span>
               </div>
               <span class="tag-count-badge">${count}</span>
            </div>`;
    };

    // Render Categories
    categories.forEach((cat, catIndex) => {
        const tagsHtml = categoriesMap[cat.name].map(renderTag).join('');
        let extraClass = '';
        let adminButtonsPlaceholder = '';

        if (State.IS_ADMIN && categoryManager) {
            extraClass = categoryManager.getItemClass(catIndex);
            adminButtonsPlaceholder = `<span class="admin-buttons-placeholder" data-cat-index="${catIndex}"></span>`;
        }

        const matches = categoriesMap[cat.name].length > 0;
        const isExpanded = query ? matches : expandedCategories.has(cat.name);

        const iconRotation = isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        const gridStyle = isExpanded ? 'grid-template-rows:1fr;opacity:1;margin-top:0;' : 'grid-template-rows:0fr;opacity:0;margin-top:-5px;';

        const catId = `cat-group-${catIndex}`;

        let orderNumAttr = '';
        if (State.IS_ADMIN && categoryManager && categoryManager.selectedIndices.includes(catIndex)) {
            const orderNum = categoryManager.selectedIndices.indexOf(catIndex) + 1;
            orderNumAttr = `data-order-num="${orderNum}"`;
        }

        html += `<div id="${catId}" class="tag-category-group ${extraClass}" 
                  data-category="${State.escapeAttr(cat.name)}" 
                  ${orderNumAttr}
                  style="margin-bottom: 15px; padding: 10px; border-radius: 8px; transition: all 0.2s;">
                  <div class="category-header" style="font-weight:bold;margin-bottom:5px;display:flex;align-items:center;cursor:pointer;gap:8px;">
                      <span class="cat-toggle-icon" style="transform:${iconRotation};flex-shrink:0;">▼</span>
                      <span class="category-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${State.escapeAttr(cat.name)}">${State.escapeHtml(cat.name)}</span>
                      ${State.IS_ADMIN && selectedTags.size > 0 ? `<button class="tag-move-here-btn" style="background:#78ffd6; border:none; border-radius:4px; color:#000; box-shadow:0 0 10px rgba(120, 255, 214, 0.6); font-size:11px; padding:3px 8px; cursor:pointer; font-weight:bold; flex-shrink:0; white-space:nowrap;">移动至此</button>` : ''}
                      ${adminButtonsPlaceholder}
                  </div>
                  <div class="list-anim-wrapper" style="display:grid;transition:all 0.3s ease;${gridStyle}">
                      <div class="category-tags-list" style="display:flex;flex-direction:column;gap:2px;overflow:hidden;min-height:0;">
                          ${tagsHtml || '<span style="font-size:12px;color:#555;padding-left:15px;">Empty</span>'}
                      </div>
                  </div>
               </div>`;
    });

    // Uncategorized
    if (uncategorized.length > 0) {
        const isExpanded = query ? true : expandedCategories.has('_UNCATEGORIZED_');
        const iconRotation = isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        const gridStyle = isExpanded ? 'grid-template-rows:1fr;opacity:1;' : 'grid-template-rows:0fr;opacity:0;';

        html += `<div class="tag-category-group" data-category="_UNCATEGORIZED_" style="padding:10px;">
                  <div class="category-header" style="font-weight:bold;margin-bottom:5px;cursor:pointer;display:flex;align-items:center;gap:8px;">
                      <span class="cat-toggle-icon" style="transform:${iconRotation};flex-shrink:0;">▼</span>
                      <span class="category-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="其他">其他</span>
                      ${State.IS_ADMIN && selectedTags.size > 0 ? `<button class="tag-move-here-btn" style="background:#78ffd6; border:none; border-radius:4px; color:#000; box-shadow:0 0 10px rgba(120, 255, 214, 0.6); font-size:11px; padding:3px 8px; cursor:pointer; font-weight:bold; flex-shrink:0; white-space:nowrap;">移动至此</button>` : ''}
                  </div>
                  <div class="list-anim-wrapper" style="display:grid;transition:all 0.3s ease;${gridStyle}">
                      <div class="category-tags-list" style="display:flex;flex-direction:column;gap:2px;overflow:hidden;min-height:0;">
                          ${uncategorized.map(renderTag).join('')}
                      </div>
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
                onSort: (e) => uiSortCallback(catIndex, e),
                onEdit: (e) => uiEditCallback(catIndex, e),
                onDelete: (e) => uiDeleteCallback(catIndex, e),
                extraClass: ''
            });

            placeholder.replaceWith(buttons);
        });
    }

    // Event Binding
    attachEvents(listContainer);
}

function setupDrawerEventDelegation() {
    const listContainer = document.getElementById('drawer-list');
    if (!listContainer) return;

    listContainer.addEventListener('click', (e) => {
        // Stop propagation to prevent document-level click listeners (like zoom restore) from firing
        e.stopPropagation();

        // 1. Handle tag selection dot clicks
        const dot = e.target.closest('.tag-select-dot');
        if (dot) {
            e.preventDefault();
            e.stopPropagation();
            const item = dot.closest('.drawer-item');
            if (item) {
                const tagName = item.dataset.tag;
                if (selectedTags.has(tagName)) {
                    selectedTags.delete(tagName);
                } else {
                    selectedTags.add(tagName);
                }
                refreshDrawerList(() => { });
            }
            return;
        }

        // 2. Handle 'Move Here' button clicks
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

        // 3. Handle category header clicks
        const header = e.target.closest('.category-header');
        if (header) {
            if (e.target.closest('.cat-action-btn') || e.target.closest('.maers-admin-btn') || e.target.closest('.tag-move-here-btn')) return;

            const group = header.closest('.tag-category-group');
            const catName = group.dataset.category;

            // Category Move Logic
            if (categoryManager && categoryManager.selectedIndices.length > 0) {
                e.stopPropagation();
                const indexStr = group.id.split('-').pop();
                const index = parseInt(indexStr, 10);
                if (!isNaN(index)) categoryManager.moveTo(index);
                return;
            }

            // Toggle Expand
            if (catName === '_UNCATEGORIZED_' || !categoryManager) {
                if (expandedCategories.has(catName)) expandedCategories.delete(catName);
                else expandedCategories.add(catName);
                refreshDrawerList(() => { });
            } else {
                const indexStr = group.id.split('-').pop();
                if (!categoryManager.isDeleted(parseInt(indexStr, 10))) {
                    if (expandedCategories.has(catName)) expandedCategories.delete(catName);
                    else expandedCategories.add(catName);
                    refreshDrawerList(() => { });
                }
            }
            return;
        }

        // 4. Handle tag item clicks (filtering)
        const item = e.target.closest('.drawer-item');
        if (item && !e.target.closest('.tag-select-dot')) {
            const tagName = item.dataset.tag;
            filterByTagCallback(null, tagName);
            return;
        }
    });
}

function attachEvents(container) {
    if (State.IS_ADMIN) {
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

        const addBtn = container.querySelector('.add-cat-btn');
        if (addBtn) addBtn.onclick = createCategoryCallback;

        // Cleanup button
        const cleanupBtn = container.querySelector('.cleanup-tags-btn');
        if (cleanupBtn) {
            cleanupBtn.onmouseenter = () => { cleanupBtn.style.opacity = '1'; };
            cleanupBtn.onmouseleave = () => { cleanupBtn.style.opacity = '0.5'; };
            cleanupBtn.onclick = async () => {
                const moduleName = Controller?.CONFIG?.CURRENT_MODULE || 'notes';
                if (!confirm(`确认清理 "${moduleName}" 中未使用的标签？`)) return;

                cleanupBtn.style.pointerEvents = 'none';
                cleanupBtn.textContent = '⏳';
                try {
                    const res = await fetch(`/api/cms/cleanup_tags?module=${moduleName}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({})
                    });
                    const result = await res.json();

                    if (res.ok && result.removed_count > 0) {
                        // Reload categories
                        const tagRes = await fetch(`/api/cms/tag_categories?module=${moduleName}`);
                        if (tagRes.ok && Controller?.AppState) {
                            Controller.AppState.tagCategories = await tagRes.json();
                        }
                        alert(`✅ 已清理 ${result.removed_count} 个标签:\n${result.removed_tags.join(', ')}`);
                        refreshDrawerList(() => { });
                    } else if (res.ok) {
                        alert('✨ 没有需要清理的标签');
                    } else {
                        alert('❌ 清理失败: ' + (result.error || 'Unknown error'));
                    }
                } catch (e) {
                    alert('❌ 清理失败: ' + e.message);
                } finally {
                    cleanupBtn.textContent = '🗑️';
                    cleanupBtn.style.pointerEvents = '';
                }
            };
        }
    }
}
