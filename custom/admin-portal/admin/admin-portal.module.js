/**
 * MAERS Admin Portal (admin-portal.module.js)
 * 首页总管理面板核心逻辑 - ES6 Module
 * 集成 BatchItemManager 实现统一的排序、编辑、删除功能
 * @version 4.0.0
 */

import { Toast } from '../../../shared/toast.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../../data-manage/admin-base.module.js';
import { AdminModal } from '../../../data-manage/admin-modal.module.js';

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
        const oldUrl = mod.url;

        AdminModal.open({
            title: 'Edit Module',
            isNew: false,
            data: mod,
            fields: [
                { name: 'title', label: 'Module Name', type: 'text', required: true },
                { name: 'icon', label: 'Icon (Path or Emoji)', type: 'text', required: true, placeholder: 'ui/xxx.svg or 📝' },
                { name: 'url', label: 'URL', type: 'text', required: true, placeholder: 'page.html' },
                { name: 'style', label: 'Style Path (Optional)', type: 'text', placeholder: 'custom/xxx.css' }
            ],
            onSave: async (formData) => {
                mod.title = formData.title;
                mod.icon = formData.icon;
                mod.url = formData.url;
                mod.style = formData.style || undefined;

                // Auto create page if URL changed
                if (mod.url && mod.url !== oldUrl && mod.url.endsWith('.html') && !mod.url.startsWith('http') && !mod.url.includes('/')) {
                    fetch('/api/ensure_page', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filename: mod.url, title: mod.title })
                    })
                        .then(res => res.json())
                        .then(data => {
                            if (data.status === 'created') Feedback.notifySaveSuccess(`HTML文件创建成功`);
                            if (data.status === 'exists') Feedback.toast(`HTML文件已存在`, 'info');
                        });
                }

                this.manager.updateSaveState();
                this.render();
                return true;
            }
        });
    },

    uiDelete(e, index) {
        e.stopPropagation();
        e.preventDefault();
        this.manager.toggleDelete(index);
    },

    async addNewModule() {
        const newModule = {
            title: '',
            icon: 'ui/logo.svg',
            url: '',
            style: ''
        };

        AdminModal.open({
            title: 'Add New Module',
            isNew: true,
            data: newModule,
            fields: [
                { name: 'title', label: 'Module Name', type: 'text', required: true },
                { name: 'icon', label: 'Icon (Path or Emoji)', type: 'text', required: true, placeholder: 'ui/xxx.svg or 📝' },
                { name: 'url', label: 'URL', type: 'text', required: true, placeholder: 'page.html' },
                { name: 'style', label: 'Style Path (Optional)', type: 'text', placeholder: 'custom/xxx.css' }
            ],
            onSave: async (formData) => {
                // Auto create page
                let pageMsg = '';
                if (formData.url.endsWith('.html') && !formData.url.startsWith('http') && !formData.url.includes('/')) {
                    try {
                        const pageRes = await fetch('/api/ensure_page', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: formData.url, title: formData.title })
                        });
                        const pageData = await pageRes.json();
                        if (pageData.status === 'created') pageMsg = ' (HTML文件创建成功)';
                        if (pageData.status === 'exists') pageMsg = ' (HTML文件已存在)';
                    } catch (e) { console.error(e); }
                }

                const finalModule = {
                    title: formData.title,
                    icon: formData.icon,
                    url: formData.url,
                    style: formData.style || undefined
                };

                this.modules.push(finalModule);

                try {
                    const res = await fetch('/api/save_modules', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(this.modules)
                    });

                    if (res.ok) {
                        Feedback.notifyAddSuccess(`管理模块创建成功${pageMsg}`);
                        await this.loadModules();
                        this.manager.setList(this.modules);
                        this.render();
                        SaveButton.hide();
                        return true;
                    } else {
                        throw new Error("Server Error " + res.status);
                    }
                } catch (e) {
                    console.error(e);
                    Feedback.notifyAddFail("管理模块创建失败");
                    this.modules.pop();
                    this.render();
                    return false;
                }
            }
        });
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
                        Feedback.notifySuccess(`HTML文件已同步删除`);
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

