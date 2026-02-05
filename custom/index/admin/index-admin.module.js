/**
 * MAERS Index Admin (index-admin.module.js)
 * 主页卡片管理逻辑 - 完整版
 * 集成通用 AdminCore 实现排序、编辑、删除、添加 (原子化添加，批量保存)
 */

import { initLayout } from '../../shared/ui/layout.module.js';
import { initTheme } from '../../shared/ui/theme.module.js';
import { Toast } from '../../../shared/toast.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../shared/admin-core.module.js';

// 初始化基础 UI
initLayout();
initTheme();

export const IndexAdmin = {
    grid: null,
    items: [],
    manager: null,

    init() {
        console.log("IndexAdmin Init...");
        this.grid = document.querySelector('.nav-grid');
        if (!this.grid) return;

        this.loadData();
    },

    loadData() {
        // 加载数据 (并加上时间戳防缓存)
        fetch('custom/index/index-cards.json?t=' + Date.now())
            .then(res => res.json())
            .then(data => {
                this.items = data;
                this.initManager();
            })
            .catch(err => {
                console.error("加载数据失败:", err);
                this.grid.innerHTML = '<p style="color:red">加载数据失败</p>';
            });
    },

    initManager() {
        // 初始化管理器 - 用于处理选中、删除状态及脏检查
        this.manager = new BatchItemManager({
            list: this.items,
            onUpdate: () => this.render(),
            onChange: (isDirty) => {
                if (isDirty) SaveButton.show();
                else SaveButton.hide();
            }
        });

        // 初始化全局保存按钮
        SaveButton.init(
            document.body,
            async () => await this.performSave(),   // 保存回调
            async () => await this.performCancel()  // 取消回调
        );

        this.render();
    },

    render() {
        if (!this.grid) return;
        this.grid.innerHTML = '';

        this.items.forEach((item, index) => {
            const card = document.createElement('div');
            // 获取管理员状态类 (选中/删除/普通)
            const stateClass = this.manager.getItemClass(index);
            card.className = `nav-card ${stateClass}`;
            card.id = item.id || `card-${index}`;
            card.style.position = 'relative'; // 确保内部绝对定位按钮正确

            // 如果处于选中排序模式，显示序号
            if (this.manager.selectedIndices.includes(index)) {
                const orderNum = this.manager.selectedIndices.indexOf(index) + 1;
                card.setAttribute('data-order-num', orderNum);
            }

            // 图标渲染逻辑：如果是路径则显示IMG，否则直接显示文本(Emoji)
            // 简单判断：含 / 或 .svg 视为路径，且不是以 < 开头的 HTML
            let iconHtml = item.icon;
            if (item.icon && (item.icon.includes('/') || item.icon.endsWith('.svg')) && !item.icon.trim().startsWith('<')) {
                iconHtml = `<img src="${item.icon}" class="nav-icon-img" alt="${item.title}" />`;
            } else {
                // Emoji 或 纯文本图重
                iconHtml = `<span style="font-size: 3rem; line-height: 1;">${item.icon}</span>`;
            }

            // 卡片内容
            card.innerHTML = `
                <div class="card-bg-text">${item.bgText}</div>
                <div class="card-icon">${iconHtml}</div>
                <div class="card-title">${item.title}</div>
                <div class="card-desc">${item.description}</div>
            `;

            // 点击逻辑：如果是排序模式，点击即移动；否则无动作(或跳转预览)
            card.onclick = (e) => {
                // 如果点击的是操作按钮，不触发卡片点击
                if (e.target.closest('.maers-admin-action-group')) return;

                if (this.manager.selectedIndices.length > 0) {
                    e.preventDefault();
                    if (this.manager.selectedIndices.includes(index)) {
                        this.manager.toggleSelect(index); // 取消选中
                    } else {
                        this.manager.moveTo(index); // 移动到此位置
                    }
                } else {
                    // 非排序模式：直接跳转链接 (用于测试)
                    // 如果处于删除标记状态，也许应该阻止跳转？通常保持一致即可。
                    // 只有当有有效链接时才跳转
                    if (item.url && item.url !== '#') {
                        window.location.href = item.url;
                    }
                }
            };

            // 注入通用管理按钮 (Sort, Edit, Delete)
            const btnContainer = AdminButtonHelper.render({
                index: index,
                onSort: (e) => this.uiSort(e, index),
                onEdit: (e) => this.uiEdit(e, index),
                onDelete: (e) => this.uiDelete(e, index),
                isDeleted: this.manager.isDeleted(index),
                containerClass: 'nav-card-actions' // 自定义类名以便CSS微调
            });

            // 手动微调按钮位置 (也可在CSS中定义 .nav-card-actions)
            // inline styles removed to use admin.css rules (top: 12px, right: 12px)

            card.appendChild(btnContainer);
            this.grid.appendChild(card);
        });

        // 渲染 "添加卡片" 按钮
        this.renderAddButton();
    },

    renderAddButton() {
        const addCard = document.createElement('div');
        addCard.className = 'nav-card functional-card';
        addCard.style.display = 'flex';
        addCard.style.alignItems = 'center';
        addCard.style.justifyContent = 'center';
        addCard.style.cursor = 'pointer';
        addCard.style.border = '2px dashed rgba(255,255,255,0.2)';
        addCard.style.background = 'transparent';
        addCard.style.minHeight = '200px';

        addCard.innerHTML = `
            <div style="text-align:center; opacity:0.6;">
                <div style="font-size:3rem; margin-bottom:10px;">+</div>
                <div>Add New Card</div>
            </div>
        `;

        addCard.onmouseenter = () => {
            addCard.style.background = 'rgba(255,255,255,0.05)';
            addCard.style.borderColor = 'rgba(255,255,255,0.5)';
        };
        addCard.onmouseleave = () => {
            addCard.style.background = 'transparent';
            addCard.style.borderColor = 'rgba(255,255,255,0.2)';
        };

        addCard.onclick = () => this.uiAdd();
        this.grid.appendChild(addCard);
    },

    // --- UI 操作 ---

    uiSort(e, index) {
        e.stopPropagation();
        this.manager.toggleSelect(index);
    },

    uiDelete(e, index) {
        e.stopPropagation();
        this.manager.toggleDelete(index);
    },

    uiEdit(e, index) {
        e.stopPropagation();
        if (this.manager.isDeleted(index)) return;

        const item = this.items[index];

        const newTitle = prompt("修改标题:", item.title);
        if (newTitle === null) return;

        const newDesc = prompt("修改描述:", item.description);
        if (newDesc === null) return;

        const newBg = prompt("修改背景文字 (4字符):", item.bgText);
        if (newBg === null) return;

        const newIcon = prompt("修改图标路径 (或 Emoji):", item.icon);
        if (newIcon === null) return;

        const newUrl = prompt("跳转链接 (会自动创建不存在的文件):", item.url);
        if (newUrl === null) return;

        // 更新数据
        let changed = false;
        if (newTitle !== item.title) { item.title = newTitle; changed = true; }
        if (newDesc !== item.description) { item.description = newDesc; changed = true; }
        if (newBg !== item.bgText) { item.bgText = newBg; changed = true; }

        const oldUrl = item.url;
        if (newUrl !== item.url) { item.url = newUrl; changed = true; }
        if (newIcon !== item.icon) { item.icon = newIcon; changed = true; }

        if (changed) {
            // Deferred Auto Create Page Logic (For Edit)
            if (item.url && item.url !== oldUrl && item.url.endsWith('.html') && !item.url.startsWith('http') && !item.url.includes('/')) {
                fetch('/api/ensure_page', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: item.url, title: item.title })
                })
                    .then(res => res.json())
                    .then(data => {
                        if (data.status === 'created') {
                            Feedback.notifySuccess(`已自动创建页面: ${item.url}`);
                        }
                    })
                    .catch(err => console.error("Page creation check failed", err));
            }

            this.manager.updateSaveState(); // 标记为脏
            this.render();
            Feedback.notifyEditSuccess();
        }
    },

    async uiAdd() {
        const title = prompt("新卡片标题:", "New Card");
        if (!title) return;

        const desc = prompt("卡片描述:", "Description...");
        if (!desc) return;

        const bgText = prompt("背景文字 (建议4个大写字母):", "NEW");
        if (!bgText) return;

        const icon = prompt("图标路径 (或 Emoji):", "ui/icon.svg");
        if (!icon) return;

        const url = prompt("跳转链接*.html (会自动创建不存在的文件):",);
        if (!url) return;

        // Auto Create Page Logic
        if (url.endsWith('.html') && !url.startsWith('http') && !url.includes('/')) {
            // Check if we should create this page
            // We do this non-blocking, but notify user
            fetch('/api/ensure_page', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: url, title: title })
            })
                .then(res => res.json())
                .then(data => {
                    if (data.status === 'created') {
                        Feedback.notifySuccess(`已自动创建页面: ${url}`);
                    } else if (data.status === 'exists') {
                        // console.log("Page exists, linking directly.");
                    }
                })
                .catch(err => console.error("Page creation check failed", err));
        }

        const id = "nav-" + title.toLowerCase().replace(/\s+/g, '-');

        // 构建新对象
        const newItem = {
            id, bgText, icon, title, description: desc, url
        };

        // 添加到本地
        this.items.push(newItem);

        // 立即原子化保存 (因为添加通常是确定的操作)
        // 注意：这里我们选择直接调用 performSave 以复用保存逻辑
        // 但为了更好的体验，我们可以只针对添加做保存，或者整体保存
        // 为保持一致性，这里调用整体保存接口
        try {
            const res = await fetch('/api/save_index_cards', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.items) // 发送含新项的完整列表
            });

            if (res.ok) {
                // 更新快照，避免 SaveButton 依然显示
                this.manager.initialSnapshot = JSON.stringify(this.items);
                this.manager.updateSaveState();
                this.render();
                Feedback.notifyAddSuccess();
            } else {
                throw new Error("Server Error");
            }
        } catch (e) {
            this.items.pop(); // 回滚
            this.render();
            Feedback.notifyAddFail();
        }
    },

    // --- 核心保存/取消 ---

    async performSave() {
        // 过滤掉已标记删除的项
        const finalItems = this.items.filter(item => !item._deleted);

        // 检查是否有被删除的项关联了本地文件，并询问删除
        const deletedItems = this.items.filter(item => item._deleted);
        for (const item of deletedItems) {
            if (item.url && item.url.endsWith('.html') && !item.url.startsWith('http') && !item.url.includes('/')) {
                const confirmName = prompt(`⚠️ 危险操作：是否一并删除物理文件？\n\n您删除了卡片 "${item.title}"。\n若要同时彻底删除服务器上的文件 "${item.url}"，请在下方输入文件名确认：\n\n(否则请直接点击“取消”或关闭窗口)`, "");

                if (confirmName === item.url) {
                    try {
                        await fetch('/api/delete_page', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: item.url })
                        });
                        Feedback.notifySuccess(`文件已彻底物理删除: ${item.url}`);
                    } catch (e) {
                        console.error('File delete error', e);
                        Feedback.notifyError(`文件删除失败: ${item.url}`);
                    }
                } else if (confirmName !== null) {
                    Feedback.notifyError("文件名不匹配，文件未删除。");
                }
            }
        }

        console.log("Saving items:", finalItems);

        try {
            const res = await fetch('/api/save_index_cards', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(finalItems)
            });

            if (res.ok) {
                // 保存成功
                // 更新 items 引用 (去除 soft deleted 的项)
                this.items = finalItems;
                // 更新管理器引用
                this.manager.setList(this.items);

                this.render();
                SaveButton.hide();
                Feedback.notifySaveSuccess();
            } else {
                Feedback.notifySaveFail();
            }
        } catch (e) {
            console.error(e);
            Feedback.notifySaveFail(e.message);
        }
    },

    async performCancel() {
        this.manager.reset(); // 回滚到快照
        this.render();
        Feedback.notifyCancel();
    }
};

document.addEventListener('DOMContentLoaded', () => {
    IndexAdmin.init();
});
