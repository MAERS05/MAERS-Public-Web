/**
 * @module data-manage/admin/admin-button-helper.module.js
 * @description 管理按钮渲染器 - 统一的管理按钮（排序/编辑/删除）渲染
 * @version 1.0.0 - ES6 Module
 */

export const AdminButtonHelper = {
    styleInjected: false,

    injectStyles() {
        if (this.styleInjected) return;
        const style = document.createElement('style');
        style.textContent = `
            /* Unified Admin Button Styles */
            .maers-admin-action-group {
                display: inline-flex;
                align-items: center;
                opacity: 0;
                transition: opacity 0.2s ease-in-out;
                pointer-events: none; /* Prevent accidental clicks when hidden */
            }

            /* Show on Hover */
            .category-header:hover .maers-admin-action-group,
            .list-item:hover .maers-admin-action-group, 
            .album-item:hover .maers-admin-action-group,
            .photo-item:hover .maers-admin-action-group,
            .category-card:hover .maers-admin-action-group,
            .maers-admin-action-group:hover {
                opacity: 1;
                pointer-events: auto;
            }

            /* [Unified] Global Admin Button Style (Theme Adapted) */
            .maers-admin-action-group .maers-admin-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 28px;
                height: 28px;
                margin-left: 4px;
                cursor: pointer;
                border-radius: 50%;
                transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1);
                font-weight: normal;
                font-size: 14px;
                
                /* Dark Mode (Default) */
                background: #1f1f1f;
                color: #ffffff;
                box-shadow: 0 2px 6px rgba(0,0,0,0.4);
                border: 1px solid rgba(255, 255, 255, 0.2);
            }
            
            /* Light Mode Override */
            .light-mode .maers-admin-action-group .maers-admin-btn {
                background: #ffffff;
                color: #333333;
                box-shadow: 0 2px 6px rgba(0,0,0,0.15);
                border: 1px solid rgba(0, 0, 0, 0.1);
            }
            
            .maers-admin-action-group .maers-admin-btn:hover {
                transform: scale(1.15);
                z-index: 10;
                /* Dark Mode Hover */
                background: #333333;
                color: #ffffff;
                box-shadow: 0 5px 15px rgba(0,0,0,0.5);
                border-color: rgba(255, 255, 255, 0.4);
            }
            
            .light-mode .maers-admin-action-group .maers-admin-btn:hover {
                /* Light Mode Hover */
                background: #ffffff;
                color: #000000;
                box-shadow: 0 5px 15px rgba(0,0,0,0.2);
                border-color: rgba(0, 0, 0, 0.2);
            }

            .maers-admin-action-group .maers-admin-btn.btn-delete-active {
                color: #2ed573;
                border-color: #2ed573; /* Also color current border */
                font-weight: bold;
            }

            /* Music Module Specific Fixes */
            .item-actions {
                display: flex !important; /* Override 'none' from music.css */
                /* No background needed if we hide the arrow */
            }

            /* Hide Arrow on Hover in Music List to prevent overlap */
            .list-item:hover .arrow-icon {
                opacity: 0;
                transition: opacity 0.2s;
            }
        `;
        document.head.appendChild(style);
        this.styleInjected = true;
    },

    // options: { onSort, onEdit, onDelete, index, isDeleted, extraClass, containerClass }
    // NOW RETURNS: HTMLElement (not string)
    // Callbacks should be FUNCTIONS, not strings
    render(options) {
        this.injectStyles();
        const { index, onSort, onEdit, onDelete, isDeleted, extraClass = '', containerClass = '' } = options;

        const container = document.createElement('div');
        container.className = `maers-admin-action-group ${containerClass}`;

        const delIcon = isDeleted ? '↺' : '✕';
        const delClass = isDeleted ? 'btn-delete-active' : '';

        // Sort Button
        if (onSort) {
            const btn = document.createElement('span');
            btn.className = `maers-admin-btn ${extraClass}`;
            btn.title = '点击选中/取消选中';
            btn.textContent = '≡';
            btn.addEventListener('click', onSort);
            container.appendChild(btn);
        }

        // Edit Button
        if (onEdit) {
            const btn = document.createElement('span');
            btn.className = 'maers-admin-btn';
            btn.title = '重命名';
            btn.textContent = '✎';
            btn.addEventListener('click', onEdit);
            container.appendChild(btn);
        }

        // Delete Button
        if (onDelete) {
            const btn = document.createElement('span');
            btn.className = `maers-admin-btn ${delClass}`;
            btn.title = '删除/恢复';
            btn.textContent = delIcon;
            btn.addEventListener('click', onDelete);
            container.appendChild(btn);
        }

        return container;
    }
};
