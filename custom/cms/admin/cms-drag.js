/**
 * MAERS CMS Drag & Drop Logic (cms-drag.js)
 * 依赖: MAERS.CMS.Core
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.CMS = MAERS.CMS || {};

    MAERS.CMS.Drag = {
        // 拖拽中的节点ID
        draggedId: null,

        // 初始化容器的拖拽行为
        setupContainer(container) {
            if (!container) return;

            container.ondragover = e => e.preventDefault();
            container.ondrop = e => {
                e.preventDefault();
                // Drop on whitespace area
                if (e.target === container && this.draggedId) {
                    const AppState = MAERS.CMS.Controller ? MAERS.CMS.Controller.AppState : null;
                    const stack = AppState ? AppState.pathStack : [];
                    if (stack.length > 0) {
                        const current = stack[stack.length - 1];
                        const pid = current === 'root' ? 'root' : current.id;
                        this.executeMove(this.draggedId, pid);
                    }
                }
            };
        },

        // 为单个 Grid Item 绑定拖拽事件
        setupItemDrag(el, node) {
            if (!el || !node) return;

            el.draggable = true;

            el.addEventListener('dragstart', (e) => {
                e.stopPropagation();
                this.draggedId = node.id;

                const AppState = MAERS.CMS.Controller ? MAERS.CMS.Controller.AppState : null;
                if (AppState) AppState.draggedId = node.id;

                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', node.id);
            });

            // Folder as drop target
            if (node.type === 'folder') {
                el.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    if (node.id !== this.draggedId) {
                        el.classList.add('drag-over');
                    }
                });

                el.addEventListener('dragleave', () => el.classList.remove('drag-over'));

                el.addEventListener('drop', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    el.classList.remove('drag-over');

                    if (this.draggedId && this.draggedId !== node.id) {
                        this.executeMove(this.draggedId, node.id);
                    }
                });
            }
        },

        // 面包屑导航的拖拽支持
        bindBreadcrumbDrop(el, index, navigateCallback) {
            let hoverTimer = null;

            el.addEventListener('dragover', e => {
                e.preventDefault();
                el.style.color = '#78ffd6';
            });

            el.addEventListener('dragenter', () => {
                if (hoverTimer) clearTimeout(hoverTimer);
                hoverTimer = setTimeout(() => {
                    if (typeof navigateCallback === 'function') navigateCallback(index);
                }, 600);
            });

            el.addEventListener('dragleave', () => {
                el.style.color = '';
                if (hoverTimer) clearTimeout(hoverTimer);
            });

            el.addEventListener('drop', e => {
                e.preventDefault();
                el.style.color = '';
                if (hoverTimer) clearTimeout(hoverTimer);

                if (this.draggedId) {
                    const AppState = MAERS.CMS.Controller ? MAERS.CMS.Controller.AppState : null;
                    let targetId = 'root';
                    if (AppState && AppState.pathStack && index >= 0) {
                        targetId = AppState.pathStack[index].id;
                    }
                    this.executeMove(this.draggedId, targetId);
                } else {
                    if (typeof navigateCallback === 'function') navigateCallback(index);
                }
            });
        },

        // 执行移动操作
        executeMove(id, targetParentId) {
            if (MAERS.CMS.Controller && MAERS.CMS.Controller.moveNode) {
                MAERS.CMS.Controller.moveNode(id, targetParentId).then(res => {
                    if (res.success && MAERS.CMS.View && MAERS.CMS.View.refreshView) {
                        MAERS.CMS.View.refreshView();
                    }
                });
            } else {
                console.error("[MAERS.CMS.Drag] MAERS.CMS.Controller.moveNode not found.");
            }
        }
    };

})(typeof window !== 'undefined' ? window : this);
