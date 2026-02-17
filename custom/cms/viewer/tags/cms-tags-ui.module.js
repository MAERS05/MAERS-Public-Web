/**
 * @module custom/cms/viewer/tags/cms-tags-ui.module.js
 * @description CMS 标签抽屉 - 交互逻辑层 (右键菜单/排序)
 * @version 1.0.0
 */

// Inject styles for tag context menu
if (!document.getElementById('tag-drawer-context-menu-styles')) {
    const style = document.createElement('style');
    style.id = 'tag-drawer-context-menu-styles';
    style.textContent = `
        .tag-context-menu { animation: menuFadeIn 0.15s ease-out; }
        @keyframes menuFadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        .tag-menu-option { padding: 8px 16px; cursor: pointer; font-size: 0.9rem; color: var(--text-main); transition: background 0.2s; user-select: none; }
        .tag-menu-option:hover { background: rgba(255, 255, 255, 0.1); }
        .tag-menu-option.delete-option { color: #ff6b6b; }
        .tag-menu-option.delete-option:hover { background: rgba(255, 107, 107, 0.1); }
        .drawer-item.reorder-target-tag:hover { background: rgba(120, 255, 214, 0.2); }
        .light-mode .tag-context-menu { background: #fff; border-color: rgba(0,0,0,0.1); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .light-mode .tag-menu-option:hover { background: rgba(0,0,0,0.05); }
    `;
    document.head.appendChild(style);
}

let tagReorderMode = {
    active: false,
    reorderClickHandler: null,
    cancelHandler: null
};

export const TagsUI = {

    /**
     * 显示标签右键菜单
     * @param {Event} e 鼠标事件
     * @param {string} tagName 标签名
     * @param {string} categoryName 分类名
     * @param {Object} callbacks 回调 { onRename, onSort, onDelete }
     */
    showContextMenu(e, tagName, categoryName, callbacks) {
        // Remove existing menu
        document.querySelector('.tag-context-menu')?.remove();

        const menu = document.createElement('div');
        menu.className = 'tag-context-menu';
        // z-index must be higher than tag-drawer (10001)
        menu.style.cssText = `position:fixed;left:-9999px;top:-9999px;background:var(--pill-bg);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:4px 0;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:10002;min-width:120px;`;

        // Rename option
        const rename = document.createElement('div');
        rename.className = 'tag-menu-option';
        rename.textContent = '✎ 重命名';
        rename.onclick = () => {
            menu.remove();
            if (callbacks.onRename) callbacks.onRename(tagName);
        };

        // Sort option (only if in a category, not uncategorized)
        const sort = document.createElement('div');
        sort.className = 'tag-menu-option';
        sort.textContent = '⇅ 排序';
        sort.onclick = () => {
            menu.remove();
            if (callbacks.onSort) callbacks.onSort(tagName, categoryName);
        };

        // Delete option
        const del = document.createElement('div');
        del.className = 'tag-menu-option delete-option';
        del.textContent = '✕ 删除';
        del.onclick = () => {
            menu.remove();
            if (callbacks.onDelete) callbacks.onDelete(tagName);
        };

        menu.append(rename, sort, del);
        document.body.appendChild(menu);

        // Smart positioning
        const menuWidth = menu.offsetWidth;
        const menuHeight = menu.offsetHeight;
        let posX = e.clientX;
        let posY = e.clientY;

        if (posX + menuWidth > window.innerWidth) {
            posX = window.innerWidth - menuWidth - 10;
        }
        if (posY + menuHeight > window.innerHeight) {
            posY = posY - menuHeight;
            if (posY < 10) posY = 10;
        }

        menu.style.left = `${posX}px`;
        menu.style.top = `${posY}px`;

        // Close on click outside
        setTimeout(() => {
            const close = () => {
                menu.remove();
                document.removeEventListener('click', close);
            };
            document.addEventListener('click', close);
        }, 100);
    },

    /**
     * 开始标签排序模式
     * @param {string} tagName 源标签
     * @param {string} categoryName 分类名
     * @param {Function} onReorderComplete 回调(sourceTag, targetTag)
     */
    startTagReorder(tagName, categoryName, onReorderComplete) {
        this.cancelTagReorder();
        if (categoryName === '_UNCATEGORIZED_') {
            alert('未分类的标签无法排序');
            return;
        }

        tagReorderMode.active = true;

        // Highlight
        const listContainer = document.getElementById('drawer-list');
        const items = listContainer.querySelectorAll('.drawer-item');
        items.forEach(item => {
            if (item.dataset.tag === tagName) {
                item.style.outline = '2px solid #78ffd6';
                item.style.outlineOffset = '2px';
            } else if (item.closest('.tag-category-group')?.dataset.category === categoryName) {
                item.style.cursor = 'pointer';
                item.style.opacity = '0.7';
                item.classList.add('reorder-target-tag');
            }
        });

        // Click handler
        const reorderClickHandler = (e) => {
            const targetItem = e.target.closest('.drawer-item.reorder-target-tag');
            if (!targetItem) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const targetTag = targetItem.dataset.tag;

            // Cleanup
            this.cancelTagReorder();

            // Execute
            if (onReorderComplete) onReorderComplete(tagName, targetTag);
        };

        // Cancel handler
        const cancelHandler = (e) => {
            if (e.key === 'Escape' || !e.target.closest('.drawer-item')) {
                this.cancelTagReorder();
            }
        };

        tagReorderMode.reorderClickHandler = reorderClickHandler;
        tagReorderMode.cancelHandler = cancelHandler;

        // Keydown listener can be added immediately
        document.addEventListener('keydown', cancelHandler);

        // Click listener uses timeout to avoid capturing the triggering click
        setTimeout(() => {
            if (tagReorderMode.active && tagReorderMode.reorderClickHandler === reorderClickHandler) {
                document.addEventListener('click', reorderClickHandler, true);
            }
        }, 100);
    },

    cancelTagReorder() {
        if (!tagReorderMode.active) return;
        tagReorderMode.active = false;

        // Remove event listeners
        if (tagReorderMode.reorderClickHandler) {
            document.removeEventListener('click', tagReorderMode.reorderClickHandler, true);
            tagReorderMode.reorderClickHandler = null;
        }
        if (tagReorderMode.cancelHandler) {
            document.removeEventListener('keydown', tagReorderMode.cancelHandler);
            tagReorderMode.cancelHandler = null;
        }

        const listContainer = document.getElementById('drawer-list');
        if (!listContainer) return;

        const items = listContainer.querySelectorAll('.drawer-item');
        items.forEach(item => {
            item.style.outline = '';
            item.style.outlineOffset = '';
            item.style.cursor = '';
            item.style.opacity = '';
            item.classList.remove('reorder-target-tag');
        });
    }
};
