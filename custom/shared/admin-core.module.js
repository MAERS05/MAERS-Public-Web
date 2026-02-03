/**
 * MAERS Admin Core (admin-core.module.js)
 * 通用的列表管理逻辑：批量排序、软删除、延迟保存、统一拖拽
 * @version 2.0.0 - ES6 Module
 */

export class BatchItemManager {
    constructor(config) {
        this.list = config.list || [];
        this.onUpdate = config.onUpdate || (() => { });
        this.onChange = config.onChange || (() => { });
        this.selectedIndices = []; // 使用数组以保持点击顺序
        this.initialSnapshot = this.getSnapshot();
    }

    getSnapshot() {
        try {
            // Simple circular reference protection
            return JSON.stringify(this.list, (key, value) => {
                if (key === 'parent' || key === 'domElement') return undefined; // Exclude common circular props
                return value;
            });
        } catch (e) {
            console.error("Snapshot failed", e);
            return "[]";
        }
    }

    setList(newList) {
        this.list = newList;
        this.selectedIndices = [];
        this.initialSnapshot = this.getSnapshot();
        this.updateSaveState();
        // 注意：setList时不触发onUpdate以避免渲染循环，如果需要更新UI应由调用者处理
    }

    // 仅更新列表引用，不重置initialSnapshot
    // 尝试保留选中项，过滤掉越界的索引
    updateListReference(newList) {
        this.list = newList;
        // 过滤无效索引
        this.selectedIndices = this.selectedIndices.filter(idx => idx < this.list.length);
    }

    // 恢复到初始快照状态
    reset() {
        try {
            const original = JSON.parse(this.initialSnapshot);
            // 清空当前列表并用原始数据填充
            this.list.length = 0;
            this.list.push(...original);
            this.selectedIndices = [];
            this.updateSaveState();
            this.onUpdate();
        } catch (e) {
            console.error('Reset failed:', e);
        }
    }

    updateSaveState() {
        const current = this.getSnapshot();
        const isDirty = current !== this.initialSnapshot;
        if (isDirty) SaveButton.show();
        else SaveButton.hide();
        this.onChange(isDirty);
    }

    toggleSelect(index) {
        const existingIndex = this.selectedIndices.indexOf(index);
        if (existingIndex !== -1) {
            // 已选中，移除
            this.selectedIndices.splice(existingIndex, 1);
        } else {
            // 未选中，添加到末尾（保持点击顺序）
            this.selectedIndices.push(index);
        }
        this.onUpdate();
    }

    clearSelection() {
        this.selectedIndices = [];
        this.onUpdate();
    }

    moveTo(targetIndex) {
        if (this.selectedIndices.length === 0) return;
        if (targetIndex < 0 || targetIndex >= this.list.length) return;

        // 通用逻辑：按点击顺序插入到目标之后 (Insert After)
        // 无论是单选还是多选，都执行插入操作，不再执行交换

        // 如果目标本身就是选中项之一，先取消选中状态，避免逻辑混乱
        if (this.selectedIndices.includes(targetIndex)) {
            this.clearSelection();
            return;
        }

        // 1. 提取要移动的项目（按点击顺序）
        const itemsToMove = this.selectedIndices.map(idx => this.list[idx]);

        // 2. 从列表中删除选中项（即使是多选，也需按索引从大到小删，防止索引偏移）
        const sortedForDeletion = [...this.selectedIndices].sort((a, b) => b - a);
        for (const idx of sortedForDeletion) {
            this.list.splice(idx, 1);
        }

        // 3. 计算目标插入位置
        let adjustedTarget = targetIndex;
        // 减去目标之前被删除的项的数量
        const deletedBeforeTarget = this.selectedIndices.filter(idx => idx < targetIndex).length;
        adjustedTarget -= deletedBeforeTarget;

        // 插入到目标之后，所以 +1
        adjustedTarget += 1;

        // 边界检查
        if (adjustedTarget < 0) adjustedTarget = 0;
        if (adjustedTarget > this.list.length) adjustedTarget = this.list.length;

        // 4. 执行插入
        this.list.splice(adjustedTarget, 0, ...itemsToMove);

        this.clearSelection();
        this.onUpdate();
        this.updateSaveState();
    }

    toggleDelete(triggerIndex) {
        if (this.list[triggerIndex]) {
            const item = this.list[triggerIndex];
            if (item._deleted) {
                delete item._deleted;
            } else {
                item._deleted = true;
            }

            const idx = this.selectedIndices.indexOf(triggerIndex);
            if (idx !== -1) {
                this.selectedIndices.splice(idx, 1);
            }
        }
        this.onUpdate();
        this.updateSaveState();
    }

    getItemClass(index) {
        const classes = [];
        const selectedIdx = this.selectedIndices.indexOf(index);
        if (selectedIdx !== -1) {
            classes.push('is-selected');
            // 序号按点击顺序（从1开始）
            const orderNum = selectedIdx + 1;
            classes.push(`order-${orderNum}`);
        }
        if (this.list[index] && this.list[index]._deleted) classes.push('is-deleted');
        return classes.join(' ');
    }
    isDeleted(index) {
        return this.list[index] && !!this.list[index]._deleted;
    }
}



export const SaveButton = {
    element: null,
    onSave: null,

    onCancel: null,

    RESET_DELAY: 1000,

    init(container, onSave, onCancel) {
        const old = document.querySelectorAll('.global-save-bar');
        old.forEach(el => el.remove());

        this.onSave = onSave;
        this.onCancel = onCancel;

        this.element = document.createElement('div');
        this.element.className = 'global-save-bar';
        this.element.innerHTML = `
            <button id="global-cancel-btn" class="cancel-btn">取消修改</button>
            <button id="global-save-btn" class="save-btn" disabled>保存修改</button>
        `;

        if (!document.getElementById('admin-core-style')) {
            const style = document.createElement('style');
            style.id = 'admin-core-style';
            style.innerHTML = `
                .global-save-bar { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%) translateY(100px); background: #1e1e24; padding: 8px 10px; border-radius: 50px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); transition: 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); z-index: 9999; display: flex; align-items: center; gap: 8px; border: 1px solid rgba(255,255,255,0.08); }
                .global-save-bar.active { transform: translateX(-50%) translateY(0); }
                .global-save-bar button { border: none; padding: 10px 20px; border-radius: 30px; font-weight: 600; cursor: pointer; font-size: 14px; transition: all 0.2s; }
                .save-btn { background: #2ed573; color: #111; }
                .save-btn:hover { box-shadow: 0 0 15px rgba(46, 213, 115, 0.4); transform: scale(1.05); }
                .save-btn:disabled { background: #333; color: #666; cursor: not-allowed; box-shadow: none; transform: none; }
                .cancel-btn { background: transparent; color: #ff6b81; border: 1px solid rgba(255, 107, 129, 0.3); }
                .cancel-btn:hover { background: rgba(255, 107, 129, 0.1); border-color: #ff6b81; }
                .is-selected { outline: 2px solid #78ffd6 !important; position: relative; }
                .is-selected::before { content: attr(data-order-num); position: absolute; top: 5px; left: 5px; background: #78ffd6; color: #111; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; z-index: 10; box-shadow: 0 2px 8px rgba(120, 255, 214, 0.4); }
                .is-deleted { filter: grayscale(100%); position: relative; }
                .is-deleted::after { content: ''; position: absolute; top: 50%; left: 0; right: 0; height: 2px; background: #ff4757; pointer-events: none; }
            `;
            document.head.appendChild(style);
        }
        document.body.appendChild(this.element);

        const saveBtn = document.getElementById('global-save-btn');
        const cancelBtn = document.getElementById('global-cancel-btn');

        saveBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            if (!this.onSave) return;
            saveBtn.textContent = '保存中...';
            saveBtn.disabled = true;
            await this.onSave();
            saveBtn.textContent = '✅ 已保存';
            setTimeout(() => { this.hide(); saveBtn.textContent = '保存修改'; saveBtn.disabled = false; }, this.RESET_DELAY);
        };

        cancelBtn.onclick = async (e) => {
            if (e) e.stopPropagation();
            if (this.onCancel) await this.onCancel();
            this.hide();
        };
    },
    show() { if (this.element && !this.element.classList.contains('active')) { this.element.classList.add('active'); document.getElementById('global-save-btn').disabled = false; } },
    hide() { if (this.element) this.element.classList.remove('active'); }
};

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

export const Feedback = {
    toast(msg, type = 'info') {
        if (window.MAERS?.Toast) {
            window.MAERS.Toast[type](msg);
        } else {
            // Fallback
            console.log(`[${type}] ${msg}`);
            if (type === 'error' || type === 'success') {
                // Should we alert on success? Maybe not.
                if (type === 'error') alert(msg);
            }
        }
    },

    // Standard Actions
    notifySuccess(msg) { this.toast(msg || "操作成功", 'success'); },
    notifyError(msg) { this.toast(msg || "操作失败", 'error'); },

    notifySaveSuccess() { this.toast("保存成功", 'success'); },
    notifySaveFail(msg) { this.toast(msg || "保存失败", 'error'); },

    notifyAddSuccess() { this.toast("添加成功", 'success'); },
    notifyAddFail(msg) { this.toast(msg || "添加失败", 'error'); },

    notifyDeleteSuccess() { this.toast("删除成功", 'success'); },

    notifyEditSuccess() { this.toast("修改成功", 'success'); },

    notifyCancel() { this.toast("修改已取消", 'info'); }
};


