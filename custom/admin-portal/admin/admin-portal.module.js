/**
 * MAERS Admin Portal (admin-portal.module.js)
 * 首页总管理面板核心逻辑 - ES6 Module
 * 集成 BatchItemManager 实现统一的排序、编辑、删除功能
 * @version 4.0.0
 */

import { Toast } from '../../../shared/toast.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../../data-manage/admin-base.module.js';

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
            onUpdate: () => this.render()
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

            if (mod.icon && (mod.icon.includes('/') || mod.icon.endsWith('.svg') || mod.icon.endsWith('.png'))) {
                icon.innerHTML = `<img src="${mod.icon}" class="admin-icon-img" alt="${mod.title}" />`;
            } else {
                // Support Emoji or Text Icon
                icon.innerHTML = `<span style="font-size: 2rem; line-height: 1;">${mod.icon || ''}</span>`;
            }

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

        // 1. 修改模块名称
        const newTitle = prompt("修改模块名称:", mod.title);
        if (newTitle === null) return;

        // 2. 修改图标路径或 Emoji
        const newIcon = prompt("修改图标路径 (ui/xxx.svg) 或 Emoji:", mod.icon);
        if (newIcon === null) return;

        // 3. 修改目标链接
        const newUrl = prompt("跳转链接 (会自动创建不存在的文件):", mod.url);
        if (newUrl === null) return;

        // 4. 修改样式路径
        const newStyle = prompt("样式路径 (CSS, 可选):", mod.style || "");
        if (newStyle === null) return;

        // 执行更新
        let hasChanges = false;
        if (newTitle && newTitle !== mod.title) { mod.title = newTitle; hasChanges = true; }
        if (newIcon !== mod.icon) { mod.icon = newIcon; hasChanges = true; }

        const oldUrl = mod.url;
        if (newUrl && newUrl !== mod.url) { mod.url = newUrl; hasChanges = true; }
        if (newStyle !== (mod.style || "")) { mod.style = newStyle; hasChanges = true; }

        if (hasChanges) {
            // Deferred Auto Create Page Logic (Edit)
            if (mod.url && mod.url !== oldUrl && mod.url.endsWith('.html') && !mod.url.startsWith('http') && !mod.url.includes('/')) {
                fetch('/api/ensure_page', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: mod.url, title: mod.title })
                })
                    .then(res => res.json())
                    .then(data => {
                        if (data.status === 'created') Feedback.notifySaveSuccess(`已自动创建页面: ${mod.url}`);
                    });
            }

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

        const iconInput = prompt("图标路径 (ui/xxx.svg) 或 Emoji:", "ui/icon.svg");
        if (!iconInput) return;

        const url = prompt("跳转链接*.html (会自动创建不存在的文件):",);
        if (!url) return;

        const styleInput = prompt("样式路径 (CSS, 可选):", "");
        if (styleInput === null) return; // User cancelled

        // All prompts passed. Execute Side Effects (Auto Create Page)
        if (url.endsWith('.html') && !url.startsWith('http') && !url.includes('/')) {
            fetch('/api/ensure_page', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: url, title: title })
            })
                .then(res => res.json())
                .then(data => {
                    if (data.status === 'created') Feedback.notifyAddSuccess(`已自动创建页面: ${url}`);
                });
        }

        const newModule = {
            title: title,
            icon: iconInput,
            url: url,
            style: styleInput || undefined
        };

        // 1. 本地更新
        this.modules.push(newModule);

        // 2. 立即保存 (原子操作)
        // 注意：admin-portal.html 使用的接口是 /api/save_modules
        try {
            const res = await fetch('/api/save_modules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.modules)
            });

            if (res.ok) {
                // 成功：重新加载数据以确保同步，并提示成功
                Feedback.notifyAddSuccess();
                await this.loadModules();
                this.manager.setList(this.modules);
                this.render();
                SaveButton.hide(); // 隐藏保存按钮，因为已保存
            } else {
                throw new Error("Server Error " + res.status);
            }
        } catch (e) {
            console.error(e);
            Feedback.notifyAddFail(e.message);
            // 失败：回滚本地变更
            this.modules.pop();
            this.render();
        }
    },

    async performSave() {
        // 清理已删除的项
        const cleanedModules = this.modules.filter(mod => !mod._deleted);

        // File Cleanup Logic
        const deletedModules = this.modules.filter(mod => mod._deleted);
        for (const mod of deletedModules) {
            if (mod.url && mod.url.endsWith('.html') && !mod.url.startsWith('http') && !mod.url.includes('/')) {
                const confirmName = prompt(`⚠️ 危险操作：是否一并删除物理文件？\n\n您删除了模块 "${mod.title}"。\n若要同时彻底删除服务器上的文件 "${mod.url}"，请在下方输入文件名确认：\n\n(否则请直接点击“取消”或关闭窗口)`, "");

                if (confirmName === mod.url) {
                    try {
                        await fetch('/api/delete_page', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: mod.url })
                        });
                        Feedback.notifySuccess(`文件已彻底物理删除: ${mod.url}`);
                    } catch (e) {
                        console.error(e);
                    }
                } else if (confirmName !== null) {
                    Feedback.notifyError("文件名不匹配，文件未删除。");
                }
            }
        }

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


};

