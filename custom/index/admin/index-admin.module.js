/**
 * MAERS Index Admin (index-admin.module.js)
 * 主页卡片管理逻辑 - 完整版
 * 集成通用 AdminCore 实现排序、编辑、删除、添加 (原子化添加，批量保存)
 */
import { initChangelogEditor } from './index-changelog.module.js';
import { localFetch } from '../../../data-manage/api-client.module.js';

import { initLayout } from '../../../shared/layout.module.js';
import { initTheme } from '../../../shared/theme.module.js';
import { Toast } from '../../../shared/toast.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../../data-manage/admin/admin-base.module.js';
import { AdminModal } from '../../../data-manage/admin/admin-modal.module.js';
import { isEncryptedRecord } from '../../../data-manage/encrypt/crypto.module.js';
import {
    unlockRecord,
    mountUnlockAllButton,
    refreshUnlockAllButton,
    unlockListDeep,
    countEncryptedDeep,
    lockIndexCardRecord,
    renderLockedCard,
    cryptoIconHtml,
    setupLockActionButton
} from '../../../data-manage/encrypt/admin-lock.module.js';

// 初始化基础 UI
initLayout();
initTheme();

// 注入更新日志编辑器入口
initChangelogEditor();

export const IndexAdmin = {
    grid: null,
    items: [],
    manager: null,

    init() {
        this.grid = document.querySelector('.nav-grid');
        if (!this.grid) return;

        this.loadData();
    },

    loadData() {
        // 加载数据 (协商缓存：无变化时服务器返回 304，秒读本地缓存)
        localFetch('data/index-cards.json', { cache: 'no-cache' })
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

        // 注册「解锁全部」按钮
        mountUnlockAllButton({
            source: 'index-cards.json',
            getCount: () => countEncryptedDeep(this.items, null, isEncryptedRecord),
            onUnlockAll: async () => {
                const n = await unlockListDeep(this.items, null, isEncryptedRecord);
                if (n > 0) {
                    this.manager.updateSaveState();
                    this.render();
                }
                return n;
            }
        });
    },

    render() {
        if (!this.grid) return;
        this.grid.innerHTML = '';

        this.items.forEach((item, index) => {
            // ── 加密记录：渲染锁定占位卡片 ──
            if (isEncryptedRecord(item)) {
                const lockedCard = this._renderLockedCard(index);
                this.grid.appendChild(lockedCard);
                return;
            }

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
                if (e.target.closest('.card-lock-btn')) return;

                if (this.manager.selectedIndices.length > 0) {
                    e.preventDefault();
                    if (this.manager.selectedIndices.includes(index)) {
                        this.manager.toggleSelect(index); // 取消选中
                    } else {
                        this.manager.moveTo(index); // 移动到此位置
                    }
                } else {
                    // 非排序模式：直接跳转链接 (用于测试)
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

            // 加锁按钮（独立注入，悬停时显示）
            const lockBtn = document.createElement('span');
            lockBtn.className = 'card-lock-btn maers-admin-btn';
            setupLockActionButton(lockBtn, {
                isLocked: Boolean(item._private_id),
                title: item._private_id ? '取消此卡片的对外加密' : '对外加密此卡片',
                onClick: (e) => { e.stopPropagation(); this.uiLock(index); }
            });
            btnContainer.appendChild(lockBtn);

            card.appendChild(btnContainer);
            this.grid.appendChild(card);
        });

        // 渲染 "添加卡片" 按钮
        this.renderAddButton();
        refreshUnlockAllButton();
    },

    /**
     * 渲染加密记录的锁定占位卡片
     * @param {number} index
     * @returns {HTMLElement}
     */
    _renderLockedCard(index) {
        return renderLockedCard({
            className: 'nav-card locked-card',
            label: '私密卡片',
            onUnlock: () => this.uiUnlock(index),
            onDelete: (e) => this.uiDelete(e, index)
        });
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
        const oldUrl = item.url;

        AdminModal.open({
            title: 'Edit Card',
            isNew: false,
            data: item,
            fields: [
                { name: 'title', label: 'Title', type: 'text', required: true },
                { name: 'description', label: 'Description', type: 'textarea', required: true },
                { name: 'bgText', label: 'Background Text (4 chars)', type: 'text', required: true, placeholder: 'ABCD' },
                { name: 'icon', label: 'Icon (Path or Emoji)', type: 'text', required: true, placeholder: 'ui/logo.svg or 📝' },
                { name: 'url', label: 'URL', type: 'text', required: true, placeholder: 'page.html' }
            ],
            onSave: async (formData) => {
                // Update item
                item.title = formData.title;
                item.description = formData.description;
                item.bgText = formData.bgText;
                item.icon = formData.icon;
                item.url = formData.url;

                // Auto create page if URL changed
                if (item.url && item.url !== oldUrl && item.url.endsWith('.html') && !item.url.startsWith('http') && !item.url.includes('/')) {
                    localFetch('/api/ensure_page', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filename: item.url, title: item.title })
                    })
                        .then(res => res.json())
                        .then(data => {
                            if (data.status === 'created') {
                                Feedback.notifySuccess(`HTML文件创建成功`);
                            } else if (data.status === 'exists') {
                                Feedback.toast(`HTML文件已存在`, 'info');
                            }
                        })
                        .catch(err => console.error("Page creation check failed", err));
                }

                this.manager.updateSaveState();
                this.render();
                Feedback.notifyEditSuccess();
                return true;
            }
        });
    },

    async uiAdd() {
        const newItem = {
            id: '',
            bgText: 'NEW',
            icon: 'ui/logo.svg',
            title: 'New Card',
            description: 'Description...',
            url: ''
        };

        AdminModal.open({
            title: 'Add New Card',
            isNew: true,
            data: newItem,
            fields: [
                { name: 'title', label: 'Title', type: 'text', required: true },
                { name: 'description', label: 'Description', type: 'textarea', required: true },
                { name: 'bgText', label: 'Background Text (4 chars)', type: 'text', required: true, placeholder: 'ABCD' },
                { name: 'icon', label: 'Icon (Path or Emoji)', type: 'text', required: true, placeholder: 'ui/logo.svg or 📝' },
                { name: 'url', label: 'URL', type: 'text', required: true, placeholder: 'page.html' }
            ],
            onSave: async (formData) => {
                if (formData.url.endsWith('.html') && !formData.url.startsWith('http') && !formData.url.includes('/')) {
                    try {
                        const pageRes = await localFetch('/api/ensure_page', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: formData.url, title: formData.title })
                        });
                        const pageData = await pageRes.json();
                        if (pageData.status === 'created') Feedback.notifySuccess('HTML文件创建成功');
                        else if (pageData.status === 'exists') Feedback.toast('HTML文件已存在', 'info');
                    } catch (e) { console.error(e); }
                }

                const id = "nav-" + formData.title.toLowerCase().replace(/\s+/g, '-');

                const finalItem = {
                    id,
                    bgText: formData.bgText,
                    icon: formData.icon,
                    title: formData.title,
                    description: formData.description,
                    url: formData.url
                };

                // Add to local
                this.items.push(finalItem);

                // Immediate save
                try {
                    const res = await localFetch('/api/save_index_cards', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(this.items)
                    });

                    if (res.ok) {
                        this.manager.initialSnapshot = JSON.stringify(this.items);
                        this.manager.updateSaveState();
                        this.render();
                        Feedback.notifyAddSuccess("首页卡片创建成功");
                        return true;
                    } else {
                        throw new Error("Server Error");
                    }
                } catch (e) {
                    this.items.pop(); // Rollback
                    this.render();
                    Feedback.notifyAddFail("首页卡片创建失败");
                    return false;
                }
            }
        });
    },

    // --- 加锁 / 解锁 ---

    /**
     * 加锁：将指定索引的普通记录加密，替换为 { _enc: "enc:..." }
     * @param {number} index
     */
    async uiLock(index) {
        const wasPrivate = !!this.items[index]?._private_id;
        const encRecord = await lockIndexCardRecord(this.items[index]);
        if (!encRecord) return;

        this.items[index] = encRecord;
        this.manager.updateSaveState();
        this.render();
        Toast.success(wasPrivate ? '已取消对外加密' : '已设置对外加密，点击保存生效');
    },

    /**
     * 解锁：将加密记录解密后恢复为普通记录
     * @param {number} index
     */
    async uiUnlock(index) {
        const encRecord = this.items[index];
        if (!encRecord || !encRecord._enc) return;

        const original = await unlockRecord(encRecord);
        if (!original) return; // 密码错误或用户取消

        this.items[index] = original;
        this.manager.updateSaveState();
        this.render();
        Toast.success('🔓 已解密，点击保存生效');
    },

    // --- 核心保存/取消 ---

    async performSave() {
        // 过滤掉已标记删除的项（加密记录没有 _deleted 字段，不受影响）
        const finalItems = this.items.filter(item => !item._deleted);


        // 检查是否有被删除的项关联了本地文件，并询问删除
        const deletedItems = this.items.filter(item => item._deleted);
        for (const item of deletedItems) {
            if (item.url && item.url.endsWith('.html') && !item.url.startsWith('http') && !item.url.includes('/')) {
                const confirmName = prompt(`⚠️ 危险操作：是否一并删除物理文件？\n\n您删除了卡片 "${item.title}"。\n若要同时彻底删除服务器上的文件 "${item.url}"，请在下方输入文件名确认：\n\n(否则请直接点击“取消”或关闭窗口)`, "");

                if (confirmName === item.url) {
                    try {
                        await localFetch('/api/delete_page', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ filename: item.url })
                        });
                        Feedback.notifySuccess(`HTML文件已同步删除`);
                    } catch (e) {
                        console.error('File delete error', e);
                        Feedback.notifyError(`文件删除失败: ${item.url}`);
                    }
                } else if (confirmName !== null) {
                    Feedback.notifyError("文件名不匹配，文件未删除。");
                }
            }
        }

        try {
            const res = await localFetch('/api/save_index_cards', {
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

// ══════════════════════════════════════════════
// 📋 更新日志编辑器
// ══════════════════════════════════════════════

