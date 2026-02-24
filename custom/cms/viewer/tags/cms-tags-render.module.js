/**
 * @module custom/cms/viewer/tags/cms-tags-render.module.js
 * @description CMS 标签抽屉 - UI 渲染层
 * @version 1.0.0
 */

import { AdminButtonHelper } from '../../../../data-manage/admin-base.module.js';
import { Search as SearchUtils } from '../../../../shared/utils.module.js';

export const TagsRender = {

    /**
     * 渲染抽屉内容
     * @param {HTMLElement} container 
     * @param {Object} context 包含 State, Controller, categoryManager 等
     * @param {Object} uiState 包含 selectedTags, expandedCategories, query
     * @param {Object} callbacks 包含 uiSort, uiEdit, uiDelete, createCategory 等
     */
    render(container, context, uiState, callbacks) {
        const { State, categoryManager } = context;
        const { selectedTags, expandedCategories, query } = uiState;

        if (!container) return;

        // 1. Tag Counts
        const tagCounts = {};
        State.AppState.allNodes.forEach((node) => {
            (node.tags || []).forEach((t) => {
                tagCounts[t] = (tagCounts[t] || 0) + 1;
            });
        });

        // 2. Search Filter
        let visibleTags = Object.keys(tagCounts);
        if (query) {
            visibleTags = visibleTags.filter(t => SearchUtils.match(t, query));
        }

        // 3. Organize into Categories
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

        // 4. Build HTML
        let html = '';

        // Header Buttons (Admin Only)
        // Header Buttons
        const filterMode = uiState.tagFilterMode || 'AND';
        const toggleBtnStyle = `
            width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(128,128,128,0.3); 
            display: flex; align-items: center; justify-content: center; 
            font-size: 10px; cursor: pointer; color: var(--text-main); background: rgba(255,255,255,0.05);
            transition: all 0.2s; user-select: none;
        `;

        html += `<div style="padding: 5px 15px; margin-bottom: 5px; display: flex; align-items: center; justify-content: space-between;">`;

        // Left controls (Add Category + Toggle)
        html += `<div style="display:flex;align-items:center;gap:10px;">`;

        // 1. Add Category (Admin only)
        if (State.IS_ADMIN) {
            html += `<button class="add-cat-btn" style="background:none;color:#a0a0a5;border:none;cursor:pointer;">＋ 添加分类</button>`;
        }

        // 2. Toggle Button
        html += `<div class="tag-filter-toggle-btn" title="筛选逻辑: ${filterMode === 'AND' ? '关联标签 (AND)' : '任意标签 (OR)'}" style="${toggleBtnStyle}">${filterMode}</div>`;

        html += `</div>`;

        // Right controls (Cleanup)
        html += `<div style="display:flex;align-items:center;gap:15px;">`;
        if (State.IS_ADMIN) {
            html += `<button class="cleanup-tags-btn" title="清理未使用的标签" style="background:none;border:none;cursor:pointer;font-size:1.1rem;opacity:0.5;transition:opacity 0.2s;">🗑️</button>`;
        }
        html += `</div></div>`;

        // Helper: Render Single Tag
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

        // Render Uncategorized
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

        container.innerHTML = html;

        // 5. Replace Admin Placeholders
        if (State.IS_ADMIN && categoryManager) {
            container.querySelectorAll('.admin-buttons-placeholder').forEach(placeholder => {
                const catIndex = parseInt(placeholder.dataset.catIndex, 10);
                const isDel = categoryManager.isDeleted(catIndex);

                const buttons = AdminButtonHelper.render({
                    index: catIndex,
                    isDeleted: isDel,
                    onSort: (e) => callbacks.uiSort(catIndex, e),
                    onEdit: (e) => callbacks.uiEdit(catIndex, e),
                    onDelete: (e) => callbacks.uiDelete(catIndex, e),
                    extraClass: ''
                });

                placeholder.replaceWith(buttons);
            });
        }

        // 6. Bind standard events (click to filter) are handled by Drawer via Delegation
        // But we need to bind specific buttons created here
        // 6. Bind events
        const toggleBtn = container.querySelector('.tag-filter-toggle-btn');
        if (toggleBtn && callbacks.onToggleFilterMode) {
            toggleBtn.onclick = (e) => {
                e.stopPropagation();
                callbacks.onToggleFilterMode();
            };
            toggleBtn.onmouseenter = () => { toggleBtn.style.background = 'rgba(120, 255, 214, 0.15)'; toggleBtn.style.borderColor = '#78ffd6'; };
            toggleBtn.onmouseleave = () => { toggleBtn.style.background = 'rgba(255,255,255,0.05)'; toggleBtn.style.borderColor = 'rgba(128,128,128,0.3)'; };
        }

        if (State.IS_ADMIN) {
            const addBtn = container.querySelector('.add-cat-btn');
            if (addBtn) addBtn.onclick = callbacks.createCategory; // Bind add callback

            const cleanupBtn = container.querySelector('.cleanup-tags-btn');
            if (cleanupBtn) {
                cleanupBtn.onmouseenter = () => { cleanupBtn.style.opacity = '1'; };
                cleanupBtn.onmouseleave = () => { cleanupBtn.style.opacity = '0.5'; };
                cleanupBtn.onclick = callbacks.onCleanup; // Bind cleanup callback
            }
        }
    }
};
