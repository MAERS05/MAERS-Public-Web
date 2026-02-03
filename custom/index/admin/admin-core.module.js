/**
 * MAERS Admin Core (admin-core.module.js)
 * 首页总管理面板核心逻辑 - ES6 Module
 * 集成 BatchItemManager 实现统一的排序、编辑、删除功能
 * @version 4.0.0
 */

import { Toast } from '../../../shared/toast.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../shared/admin-core.module.js';

export const Admin = {
    grid: null,
    modules: [],
    manager: null,

    async init() {
        this.grid = document.getElementById('admin-grid');
        if (!this.grid) return;

        await this.loadModules();
        this.initManager();
        this.render(); // 初始渲染
        this.bindEvents();
    },

    async loadModules() {
        try {
            const res = await fetch('/api/modules');
            this.modules = res.ok ? await res.json() : [];
        } catch (e) {
            console.error('加载模块失败:', e);
            this.modules = [];
        }
    },

    initManager() {
        // 初始化 BatchItemManager
        this.manager = new BatchItemManager({
            list: this.modules,
            onUpdate: () => this.render(),
            onChange: () => SaveButton.show()
        });

        // 初始化保存按钮
        SaveButton.init(
            document.body,
            async () => await this.performSave(),
            async () => await this.performCancel()
        );
    },

    render() {
        if (!this.grid) return;
        this.grid.innerHTML = '';

        this.modules.forEach((mod, idx) => {
            const card = document.createElement('div');
            card.className = `admin-card ${this.manager.getItemClass(idx)}`;
            card.setAttribute('data-order-num', this.getOrderNum(idx));

            // 如果有选中项，点击卡片执行移动操作
            card.onclick = (e) => {
                if (this.manager.selectedIndices.length > 0) {
                    e.preventDefault();
                    this.manager.moveTo(idx);
                } else {
                    // 没有选中项时正常跳转
                    window.location.href = mod.url;
                }
            };

            // 图标和名称
            const icon = document.createElement('span');
            icon.className = 'icon';
            icon.textContent = mod.icon;

            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = mod.title;

            card.appendChild(icon);
            card.appendChild(name);

            // 管理按钮组
            const actionGroup = document.createElement('div');
            actionGroup.className = 'maers-admin-action-group';

            // 使用 DOM API 生成按钮
            const adminBtns = AdminButtonHelper.render({
                index: idx,
                onSort: (e) => this.uiSort(e, idx),
                onEdit: (e) => this.uiEdit(e, idx),
                onDelete: (e) => this.uiDelete(e, idx),
                isDeleted: this.manager.isDeleted(idx),
                containerClass: 'admin-module-actions'
            });

            actionGroup.appendChild(adminBtns);
            card.appendChild(actionGroup);
            this.grid.appendChild(card);
        });

        // 添加新模块卡片
        const addCard = document.createElement('div');
        addCard.className = 'admin-card functional-card';
        addCard.style.cursor = 'pointer';
        addCard.onclick = () => this.addNewModule();
        addCard.innerHTML = `<span class="icon">＋</span>`;
        this.grid.appendChild(addCard);
    },

    getOrderNum(index) {
        const selectedIdx = this.manager.selectedIndices.indexOf(index);
        return selectedIdx !== -1 ? selectedIdx + 1 : '';
    },

    // UI 操作处理器
    uiSort(e, index) {
        e.stopPropagation();
        e.preventDefault();
        this.manager.toggleSelect(index);
    },

    uiEdit(e, index) {
        e.stopPropagation();
        e.preventDefault();
        if (this.manager.isDeleted(index)) return;

        const mod = this.modules[index];

        // 编辑名称
        const newTitle = prompt("修改模块名称:", mod.title);
        if (!newTitle || newTitle === mod.title) {
            // 用户取消或未修改，直接返回
            return;
        }

        // 编辑图标
        const newIcon = prompt("修改图标 (Emoji):", mod.icon);
        if (!newIcon) return; // 用户取消

        // 编辑链接
        const newUrl = prompt("修改目标链接:", mod.url);
        if (!newUrl) return; // 用户取消

        // 应用修改
        let hasChanges = false;
        if (newTitle !== mod.title) {
            mod.title = newTitle;
            hasChanges = true;
        }
        if (newIcon !== mod.icon) {
            mod.icon = newIcon;
            hasChanges = true;
        }
        if (newUrl !== mod.url) {
            mod.url = newUrl;
            hasChanges = true;
        }

        if (hasChanges) {
            this.manager.updateSaveState();
            this.render();
        }
    },

    uiDelete(e, index) {
        e.stopPropagation();
        e.preventDefault();
        this.manager.toggleDelete(index);
    },

    async addNewModule() {
        const title = prompt("模块名称:");
        if (!title) return;
        const icon = prompt("图标 (Emoji):", "📦");
        const url = prompt("目标链接:", "index.html");

        this.modules.push({ title, icon, url });

        // 直接保存
        try {
            const saveRes = await fetch('/api/save_modules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.modules)
            });

            if (saveRes.ok) {
                Feedback.notifyAddSuccess();
                await this.loadModules();
                this.manager.setList(this.modules);
                this.render();
            } else {
                Feedback.notifyAddFail();
            }
        } catch (e) {
            Feedback.notifyAddFail(e.message);
        }
    },

    async performSave() {
        // 清理已删除的项
        const cleanedModules = this.modules.filter(mod => !mod._deleted);

        try {
            const res = await fetch('/api/save_modules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cleanedModules)
            });

            if (res.ok) {
                Feedback.notifySaveSuccess();
                await this.loadModules();
                this.manager.setList(this.modules);
                this.render();
            } else {
                Feedback.notifySaveFail();
            }
        } catch (e) {
            Feedback.notifySaveFail(e.message);
        }
    },

    async performCancel() {
        this.manager.reset();
        Feedback.notifyCancel();
    },

    async exportModules() {
        try {
            const res = await fetch('/api/modules');
            const data = await res.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `modules_backup_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            Toast.success('✅ 配置已导出');
        } catch (e) {
            Toast.error('❌ 导出失败: ' + e.message);
        }
    },

    async importModules(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);

            if (!Array.isArray(data)) {
                alert('❌ 文件格式错误: 必须是数组格式');
                return;
            }

            for (let mod of data) {
                if (!mod.title || !mod.icon || !mod.url) {
                    alert('❌ 文件格式错误: 每个模块必须包含 title, icon, url 字段');
                    return;
                }
            }

            const res = await fetch('/api/save_modules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (res.ok) {
                Toast.success(`✅ 成功导入 ${data.length} 个模块`);
                await this.loadModules();
                this.manager.setList(this.modules);
                this.render();
            } else {
                Toast.error('❌ 保存失败');
            }
        } catch (e) {
            Toast.error('❌ 导入失败: ' + e.message);
        } finally {
            event.target.value = '';
        }
    },

    bindEvents() {
        const exportBtn = document.getElementById('export-btn');
        const importBtn = document.getElementById('import-btn');
        const importFile = document.getElementById('import-file');

        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportModules());
        }

        if (importBtn) {
            importBtn.addEventListener('click', () => {
                if (importFile) importFile.click();
            });
        }

        if (importFile) {
            importFile.addEventListener('change', (e) => this.importModules(e));
        }
    }
};

