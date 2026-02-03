/**
 * MAERS CMS Drag & Drop Logic (cms-drag.module.js)
 * 职责: 处理 Grid Item 的拖拽，支持"多选拖入文件夹"
 * 桥接: Admin.getManager() <-> DOM Events
 * @version 4.0.0 - ES6 Module
 */

// Dependency injection
let Admin = null;
let Controller = null;
let State = null;

const HOVER_DELAY = 500;
const LONG_PRESS_DELAY = 300;

export function initDrag(admin, controller, state) {
    Admin = admin;
    Controller = controller;
    State = state;
}

// 拖拽中的数据缓存
let dragData = {
    active: false,
    sourceIds: [] // 正在被拖拽的 ID 列表
};

export function setupContainer(container) {
    if (!container) return;

    // 允许拖放在容器空白处 (移动到当前层级? 通常不行，除非面包屑导航)
    // 这里主要处理"取消默认行为"
    container.addEventListener('dragover', e => {
        e.preventDefault();
    });

    // 容器级的 Drop 通常意味着"什么都不做"或者"移动到根"
    // CMS 中通过面包屑处理跨层级移动，容器空白处通常忽略
}

export function setupItemDrag(el, node) {
    if (!el || !node) return;

    el.draggable = true;

    // --- Drag Start ---
    el.addEventListener('dragstart', (e) => {
        const manager = Admin?.getManager?.();
        if (!manager) {
            e.preventDefault();
            return;
        }

        // Strict Rule: Only selected items can be dragged.
        // User must explicitly select the item (checkbox or mode) before dragging.
        const index = manager.list.findIndex(n => n.id === node.id);
        if (index === -1 || !manager.selectedIndices.includes(index)) {
            e.preventDefault();
            return;
        }

        // 2. 准备拖拽数据
        const selectedNodes = manager.selectedIndices.map(i => manager.list[i]);
        dragData.sourceIds = selectedNodes.map(n => n.id);
        dragData.active = true;

        // 3. 设置原生 DataTransfer (为了兼容性)
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify(dragData.sourceIds));

        // 4. 样式状态
        // 给所有拖拽项添加样式
        requestAnimationFrame(() => {
            document.querySelectorAll('.grid-item').forEach(item => {
                if (dragData.sourceIds.includes(item.dataset.id)) {
                    item.classList.add('is-dragging');
                }
            });
        });
    });

    el.addEventListener('dragend', () => {
        dragData.active = false;
        dragData.sourceIds = [];
        document.querySelectorAll('.grid-item').forEach(item => {
            item.classList.remove('is-dragging');
            item.classList.remove('drag-over');
        });
    });

    // --- Drop Zone (仅 Folder 有效) ---
    if (node.type === 'folder') {
        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            // 防止拖给自己
            if (dragData.sourceIds.includes(node.id)) return;
            el.classList.add('drag-over');
        });

        el.addEventListener('dragleave', () => {
            el.classList.remove('drag-over');
        });

        el.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            el.classList.remove('drag-over');

            const targetParentId = node.id;

            // 检查是否包含非法操作 (如父拖进子)
            // 后端 API 通常会检查环路，前端简单检查自身
            if (dragData.sourceIds.includes(targetParentId)) return;

            // 执行移动
            executeBatchMove(dragData.sourceIds, targetParentId);
        });
    }
}

export function bindBreadcrumbDrop(el, index, navigateCallback) {
    let hoverTimer = null;

    el.addEventListener('dragover', e => {
        e.preventDefault();
        el.classList.add('breadcrumb-drag-over');
    });

    el.addEventListener('dragleave', () => {
        el.classList.remove('breadcrumb-drag-over');
        if (hoverTimer) clearTimeout(hoverTimer);
    });

    el.addEventListener('dragenter', () => {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
            if (typeof navigateCallback === 'function') navigateCallback(index);
        }, HOVER_DELAY); // 500ms 悬停自动进入
    });

    el.addEventListener('drop', e => {
        e.preventDefault();
        el.classList.remove('breadcrumb-drag-over');
        if (hoverTimer) clearTimeout(hoverTimer);

        const AppState = Controller?.AppState;
        // 确定目标 ID
        let targetId = 'root';
        if (index === -1) targetId = 'root';
        else if (AppState?.pathStack[index]) targetId = AppState.pathStack[index].id;

        if (dragData.sourceIds.length > 0) {
            executeBatchMove(dragData.sourceIds, targetId);
        }
    });
}

export async function executeBatchMove(ids, targetParentId) {
    if (!ids || ids.length === 0) return;

    const manager = Admin?.getManager?.();
    if (window.MAERS?.Toast) window.MAERS.Toast.info(`Moving ${ids.length} items...`);

    let successCount = 0;
    // 串行执行移动 (CMS API 目前不支持批量移动，需要循环调用)
    // 如果 Controller 支持批量更好，目前假设它只支持单体
    for (const id of ids) {
        const res = await Controller?.moveNode?.(id, targetParentId);
        if (res?.success) successCount++;
    }

    if (successCount > 0) {
        if (window.MAERS?.Toast) window.MAERS.Toast.success(`Moved ${successCount} items.`);
        if (manager) manager.clearSelection();
        Admin?.refreshView?.();
    } else {
        if (window.MAERS?.Toast) window.MAERS.Toast.error("Move failed.");
    }
}

export const Drag = {
    setupContainer,
    setupItemDrag,
    bindBreadcrumbDrop,
    executeBatchMove
};
