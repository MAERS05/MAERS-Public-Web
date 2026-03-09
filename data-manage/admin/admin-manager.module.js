/**
 * @module data-manage/admin/admin-manager.module.js
 * @description 批量管理核心 - 列表状态管理、批量操作逻辑
 * @version 1.0.0 - ES6 Module
 */

import { SaveButton } from './admin-ui.module.js';

export class BatchItemManager {
    constructor(config) {
        this.list = config.list || [];
        this.onUpdate = config.onUpdate || (() => { });
        this.onChange = config.onChange || (() => { });
        this.selectedIndices = [];
        this.autoSaveBar = config.autoSaveBar !== false;
        this.initialSnapshot = this.getSnapshot();
    }

    getSnapshot() {
        try {
            return JSON.stringify(this.list, (key, value) => {
                if (key === 'parent' || key === 'domElement') return undefined;
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
    }

    updateListReference(newList) {
        this.list = newList;
        this.selectedIndices = this.selectedIndices.filter(idx => idx < this.list.length);
    }

    reset() {
        try {
            const original = JSON.parse(this.initialSnapshot);
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
        if (this.autoSaveBar) {
            if (isDirty) SaveButton.show();
            else SaveButton.hide();
        }
        this.onChange(isDirty, current, this.initialSnapshot);
    }

    toggleSelect(index) {
        const existingIndex = this.selectedIndices.indexOf(index);
        if (existingIndex !== -1) {
            this.selectedIndices.splice(existingIndex, 1);
        } else {
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

        if (this.selectedIndices.includes(targetIndex)) {
            this.clearSelection();
            return;
        }

        const itemsToMove = this.selectedIndices.map(idx => this.list[idx]);

        const sortedForDeletion = [...this.selectedIndices].sort((a, b) => b - a);
        for (const idx of sortedForDeletion) {
            this.list.splice(idx, 1);
        }

        let adjustedTarget = targetIndex;
        const deletedBeforeTarget = this.selectedIndices.filter(idx => idx < targetIndex).length;
        adjustedTarget -= deletedBeforeTarget;
        adjustedTarget += 1;

        if (adjustedTarget < 0) adjustedTarget = 0;
        if (adjustedTarget > this.list.length) adjustedTarget = this.list.length;

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
