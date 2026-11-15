/**
 * MAERS Index Admin (index-admin.module.js)
 * 职责：初始化首页卡片管理，处理卡片编辑、加解锁和保存反馈。
 */
import { icon as appIcon } from '../../../shared/icons.module.js';
import { navigationInfo } from '../../../shared/spatial-nav.module.js';

import { initChangelogEditor } from './index-changelog.module.js';
import {
    appendSavedCard, ensureCardPage, readCardList, refreshSavedCards, saveCardChanges
} from '../../../data-manage/admin/card-persistence.module.js';

import { initLayout } from '../../../shared/layout.module.js';
import { initTheme } from '../../../shared/theme.module.js';
import { Toast } from '../../../shared/toast.module.js';
import { Utils } from '../../../shared/utils.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../../data-manage/admin/admin-base.module.js';
import { AdminModal } from '../../../data-manage/admin/admin-modal.module.js';
import { disableAdminControl, isLocalOnlyUnavailable } from '../../../data-manage/admin/local-only.module.js';
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

const SAVE_INDEX_CARDS = '/api/save_index_cards';

/** 生成普通卡片的展示内容，图标路径及文本都按对应的 HTML 上下文转义。 */
function renderCardContent(item) {
    const info = navigationInfo(item);
    return '<span class="card-icon">' + appIcon(info.icon, 24) + '</span><span class="card-copy">' +
        '<span class="card-title">' + Utils.escapeHtml(info.title) + '</span><span class="card-desc">' +
        Utils.escapeHtml(info.description) + '</span></span>';
}

export const IndexAdmin = {
    grid: null,
    items: [],
    manager: null,

    async init() {
        this.grid = document.querySelector('.nav-grid');
        if (!this.grid) return;
        try {
            this.items = await readCardList('data/index-cards.json');
        } catch (error) {
            console.error('[MAERS.Index] 读取首页卡片失败:', error);
            this.grid.innerHTML = '<p style="color:red">加载数据失败</p>';
            return;
        }
        this.initManager();
    },

    initManager() {
        // 初始化管理器 - 用于处理选中、删除状态及脏检查
        this.manager = new BatchItemManager({
            list: this.items,
            onUpdate: () => this.render()
        });

        // 初始化全局保存按钮
        SaveButton.init(
            document.body,
            () => this.performSave(),
            () => this.performCancel()
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
        const localOnlyUnavailable = isLocalOnlyUnavailable();
        this.grid.innerHTML = '';

        this.items.forEach((item, index) => {
            // ── 加密记录：渲染锁定占位卡片 ──
            if (isEncryptedRecord(item)) {
                const lockedCard = this._renderLockedCard(index);
                if (localOnlyUnavailable) disableAdminControl(lockedCard);
                this.grid.appendChild(lockedCard);
                return;
            }

            // ── 普通卡片 ──
            const card = this._renderNormalCard(item, index, localOnlyUnavailable);
            this.grid.appendChild(card);
        });

        // 渲染 "添加卡片" 按钮
        this.renderAddButton(localOnlyUnavailable);
        refreshUnlockAllButton();
    },

    /**
     * 渲染单张普通（非加密）卡片
     * @param {object} item - 卡片数据
     * @param {number} index - 在 items 中的索引
     * @param {boolean} localOnlyUnavailable - 是否处于受限模式
     * @returns {HTMLElement}
     */
    _renderNormalCard(item, index, localOnlyUnavailable) {
        const card = document.createElement('div');
        // 获取管理员状态类 (选中/删除/普通)
        const stateClass = this.manager.getItemClass(index);
        card.className = `nav-card ${stateClass}`;
        card.id = item.id || `card-${index}`;
        card.tabIndex = 0;
        card.style.position = 'relative'; // 确保内部绝对定位按钮正确

        // 如果处于选中排序模式，显示序号
        const order = this.manager.selectedIndices.indexOf(index) + 1;
        if (order) card.setAttribute('data-order-num', order);

        // 卡片内容
        card.innerHTML = renderCardContent(item);

        // 点击逻辑
        card.onclick = (e) => this._handleCardClick(e, item, index);
        card.onkeydown = e => { if (e.target === card && e.key === 'Enter') card.click(); };

        // 注入管理按钮组（含加锁按钮）
        const btnContainer = this._renderAdminButtons(item, index, localOnlyUnavailable);
        card.appendChild(btnContainer);
        return card;
    },

    /**
     * 卡片点击处理：排序模式下切换选中/移动，普通模式下跳转
     */
    _handleCardClick(e, item, index) {
        // 如果点击的是操作按钮，不触发卡片点击
        if (e.target.closest('.maers-admin-action-group, .card-lock-btn')) return;

        if (this.manager.selectedIndices.length > 0) {
            e.preventDefault();
            if (this.manager.selectedIndices.includes(index)) {
                this.manager.toggleSelect(index); // 取消选中
            } else {
                this.manager.moveTo(index); // 移动到此位置
            }
            return;
        }
        // 非排序模式：直接跳转链接 (用于测试)
        if (item.url && item.url !== '#') {
            window.location.href = item.url;
        }
    },

    /**
     * 渲染管理按钮组（排序/编辑/删除 + 加锁按钮）
     */
    _renderAdminButtons(item, index, localOnlyUnavailable) {
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
            title: '对外加密此卡片',
            onClick: (e) => { e.stopPropagation(); this.uiLock(index); }
        });
        btnContainer.appendChild(lockBtn);

        if (localOnlyUnavailable) {
            btnContainer.querySelectorAll('.maers-admin-btn').forEach(btn => disableAdminControl(btn));
        }
        return btnContainer;
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

    renderAddButton(localOnlyUnavailable) {
        const addCard = document.createElement('div');
        addCard.className = 'nav-card functional-card';
        addCard.style.display = 'flex';
        addCard.style.alignItems = 'center';
        addCard.style.justifyContent = 'center';
        addCard.style.border = '2px dashed rgba(255,255,255,0.2)';
        addCard.style.background = 'transparent';
        addCard.style.minHeight = '200px';

        addCard.innerHTML = `
            <div style="text-align:center; opacity:0.6;">
                <div style="font-size:3rem; margin-bottom:10px;">+</div>
                <div>添加入口</div>
            </div>
        `;

        this.grid.appendChild(addCard);
        if (localOnlyUnavailable) {
            disableAdminControl(addCard);
            return;
        }
        addCard.style.cursor = 'pointer';
        addCard.onmouseenter = () => {
            addCard.style.background = 'rgba(255,255,255,0.05)';
            addCard.style.borderColor = 'rgba(255,255,255,0.5)';
        };
        addCard.onmouseleave = () => {
            addCard.style.background = 'transparent';
            addCard.style.borderColor = 'rgba(255,255,255,0.2)';
        };

        addCard.onclick = () => this.uiAdd();
    },

    // --- 公共字段定义 ---

    /**
     * 返回卡片编辑/新增的公共字段定义数组
     * @returns {Array} 字段配置
     */
    _cardFields() {
        return [
            { name: 'title', label: '名称', type: 'text', required: true },
            { name: 'description', label: '说明', type: 'textarea', required: true },
            { name: 'bgText', label: '标记（选填）', type: 'text', required: true, placeholder: 'ABCD' },
            { name: 'icon', label: '图标地址', type: 'text', required: true, placeholder: 'ui/logo.svg or ' },
            { name: 'url', label: '网址', type: 'text', required: true, placeholder: 'page.html' }
        ];
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
            title: '编辑入口',
            isNew: false,
            data: item,
            fields: this._cardFields(),
            onSave: async (formData) => {
                if (formData.url !== oldUrl) await ensureCardPage(formData.url, formData.title);
                Object.assign(item, formData);

                this.manager.updateSaveState();
                this.render();
                Feedback.notifyEditSuccess();
                return true;
            }
        });
    },

    uiAdd() {
        if (isLocalOnlyUnavailable()) return;
        const newItem = {
            id: '',
            bgText: 'NEW',
            icon: 'ui/logo.svg',
            title: '新入口',
            description: 'Description...',
            url: ''
        };

        AdminModal.open({
            title: '添加入口',
            isNew: true,
            data: newItem,
            fields: this._cardFields(),
            onSave: formData => this._saveNewCard(formData)
        });
    },

    async _saveNewCard(formData) {
        const added = { ...formData, id: 'nav-' + formData.title.toLowerCase().replace(/\s+/g, '-') };
        let saved;
        try {
            await ensureCardPage(added.url, added.title);
            saved = await appendSavedCard(SAVE_INDEX_CARDS, this.items, added);
        } catch (error) {
            console.error('[MAERS.Index] 新建卡片失败:', error);
            Feedback.notifyAddFail('首页卡片创建失败');
            return false;
        }
        refreshSavedCards(() => {
            this.manager.markSaved(saved);
            this.render();
        }, () => Feedback.notifyAddSuccess('首页卡片创建成功'));
        return true;
    },

    // --- 加锁 / 解锁 ---

    /**
     * 加锁：将指定索引的普通记录加密，替换为 { _enc: "enc:..." }
     * @param {number} index
     */
    async uiLock(index) {
        const wasPrivate = !!this.items[index]?._private_id;
        const encRecord = await lockIndexCardRecord(this.items[index], { choose: true });
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
        Toast.success(' 已解密，点击保存生效');
    },

    // --- 核心保存/取消 ---

    async performSave() {
        if (isLocalOnlyUnavailable()) return false;
        try {
            this.items = await saveCardChanges(SAVE_INDEX_CARDS, this.items, '卡片');
        } catch (error) {
            console.error('[MAERS.Index] 保存失败:', error);
            Feedback.notifySaveFail(error.message);
            return false;
        }
        refreshSavedCards(() => {
            this.manager.setList(this.items);
            this.render();
        }, () => Feedback.notifySaveSuccess());
        return true;
    },

    async performCancel() {
        this.manager.reset(); // 回滚到快照
        Feedback.notifyCancel();
    }
};

document.addEventListener('DOMContentLoaded', () => {
    IndexAdmin.init().catch(error => {
        console.error('[MAERS.Index] 初始化首页管理失败:', error);
        Toast.error('首页管理初始化失败，请刷新重试');
    });
});

