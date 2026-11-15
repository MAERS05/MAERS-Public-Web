/**
 * MAERS Admin Portal (admin-portal.module.js)
 * 职责：管理门户模块卡片并挂载同步、清理与恢复入口。
 */
import { confirmAction } from "../../../data-manage/admin/admin-confirm.module.js";
import { icon as appIcon } from '../../../shared/icons.module.js';
import { navigationInfo } from '../../../shared/spatial-nav.module.js';

import {
    appendSavedCard, ensureCardPage, readCardList, refreshSavedCards, saveCardChanges
} from '../../../data-manage/admin/card-persistence.module.js';
import { isStudioAdminPage, localFetch } from '../../../data-manage/api-client.module.js';

import { Toast } from '../../../shared/toast.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../../data-manage/admin/admin-base.module.js';
import { AdminModal } from '../../../data-manage/admin/admin-modal.module.js';
import { syncManager } from '../../../data-manage/sync/sync-manager.module.js';
import { disableAdminControl, isLocalOnlyUnavailable } from '../../../data-manage/admin/local-only.module.js';
import { mountCryptoSettingsButton } from '../../../data-manage/encrypt/admin-lock.module.js';

const SAVE_MODULES = '/api/save_modules';

/** 清理结果与后续的徽章刷新分开处理，按钮无论成功或失败都可恢复。 */
async function runCleanData(button) {
    if (button.disabled || !await confirmAction({ confirmText: "开始整理", cancelText: "先不整理", description: "未引用的文件会移入本机回收区，可在备份与恢复中找回。" })) return;

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = '清理中...';
    let result;
    try {
        const response = await localFetch('/api/admin/clean_data', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        result = await response.json().catch(() => null);
        if (!response.ok || !result?.success) {
            throw new Error(result?.error || (response.ok ? '服务返回的清理结果无效' : `HTTP ${response.status}`));
        }
    } catch (error) {
        console.error('[MAERS.Portal] 清理失败:', error);
        Toast.error(`清理失败：${error.message}`);
        return;
    } finally {
        button.disabled = false;
        button.textContent = originalLabel;
    }
    Toast.success(` 整理完成：${result.deleted_files_count} 个未引用文件已移入回收区`);
    void syncManager.refreshGitStatusBadge();
}

async function openRecoveryPanel() {
    try {
        const { openDataRecovery } = await import('../../../data-manage/admin/data-recovery.module.js');
        await openDataRecovery();
    } catch (error) {
        console.error('[MAERS.Portal] 打开备份与恢复失败:', error);
        Toast.error('无法打开备份与恢复，请刷新后重试');
    }
}

/** 本地工具共用按钮样式及云端禁用规则。 */
function addLocalTool(container, { id, label, action, title = '' }) {
    if (document.getElementById(id)) return;
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.className = 'maers-toolbar-btn';
    button.textContent = label;
    button.title = title;
    button.onclick = () => action(button);
    if (isLocalOnlyUnavailable()) disableAdminControl(button);
    container.appendChild(button);
}

function mountHeaderActions() {
    const container = document.querySelector('.admin-header-actions');
    if (!container) return;
    syncManager.injectSyncButton(container);
    const tools = document.createElement('details');
    tools.className = 'admin-tools';
    tools.innerHTML = '<summary class="app-icon-button" title="更多操作" aria-label="更多操作">' + appIcon('more') + '</summary><div class="admin-tools-panel" aria-label="管理工具"></div>';
    container.append(tools);
    const panel = tools.querySelector('.admin-tools-panel');
    if (isStudioAdminPage()) addLocalTool(panel, {
        id: 'maers-storage-settings-btn', label: '存储设置',
        action: async () => {
            try {
                const { openStorageSettings } = await import('../../../data-manage/sync/storage-settings.module.js');
                await openStorageSettings();
            } catch {
                Toast.error('无法打开存储设置，请刷新后重试');
            }
        }
    });
    addLocalTool(panel, { id: 'maers-clean-data-btn', label: '整理文件', action: runCleanData,
        title: '检查数据真源，将未引用文件移入本机回收区' });
    addLocalTool(panel, { id: 'maers-recovery-btn', label: '备份与恢复', action: openRecoveryPanel });
    const crypto = document.getElementById('maers-crypto-settings-btn');
    if (crypto) {
        crypto.className = 'maers-toolbar-btn';
        crypto.textContent = crypto.getAttribute('aria-label');
        panel.append(crypto);
        document.getElementById('maers-crypto-controls')?.remove();
    }
    panel.addEventListener('click', event => { if (event.target.closest('button')) tools.open = false; });
    document.addEventListener('click', event => { if (!tools.contains(event.target)) tools.open = false; });
    tools.addEventListener('keydown', event => {
        if (event.key === 'Escape') { tools.open = false; tools.querySelector('summary').focus(); }
    });
}

/** 保留图片与文字图标两种展示，路径和标题通过 DOM 赋值。 */
function renderModuleIcon(moduleCard) {
    const icon = document.createElement('span');
    icon.className = 'icon';
    const known = navigationInfo(moduleCard);
    if (known.icon !== 'link' || /(?:^|\/)admin-index(?:\.html)?(?:[?#]|$)/.test(moduleCard.url || '')) {
        icon.innerHTML = appIcon(known.key === 'index' ? 'home' : known.icon, 28);
        return icon;
    }
    const value = moduleCard.icon || '';
    if (value.includes('/') || value.endsWith('.svg') || value.endsWith('.png')) {
        const image = document.createElement('img');
        image.className = 'admin-icon-img';
        image.src = value;
        image.alt = moduleCard.title;
        icon.appendChild(image);
    } else {
        const label = document.createElement('span');
        label.style.fontSize = '2rem';
        label.style.lineHeight = '1';
        label.textContent = value;
        icon.appendChild(label);
    }
    return icon;
}

export const Admin = {
    grid: null,
    modules: [],
    manager: null,

    async init() {
        this.grid = document.getElementById('admin-grid');
        if (!this.grid) return;

        const loaded = await this.loadModules();
        mountCryptoSettingsButton();
        mountHeaderActions();
        if (!loaded) {
            this.grid.textContent = '读取模块失败，请刷新后重试';
            return;
        }
        this.initManager();
        this.render();
    },

    async loadModules() {
        const sources = syncManager.isLocalHost() ? ['/api/modules', 'data/admin-portal.json'] : ['data/admin-portal.json'];
        for (const source of sources) {
            try {
                this.modules = await readCardList(source);
                return true;
            } catch (error) {
                console.warn(`[MAERS.Portal] 读取模块失败 (${source}):`, error);
            }
        }
        return false;
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
            () => this.performSave(),
            () => this.performCancel()
        );
    },

    render() {
        if (!this.grid) return;
        const localOnlyUnavailable = isLocalOnlyUnavailable();
        this.grid.innerHTML = '';

        this.modules.forEach((mod, idx) => {
            this.grid.appendChild(this._renderModuleCard(mod, idx, localOnlyUnavailable));
        });

        const addCard = document.createElement('button');
        addCard.type = 'button';
        addCard.className = 'admin-card functional-card';
        addCard.setAttribute('aria-label', '添加模块');
        if (localOnlyUnavailable) disableAdminControl(addCard);
        else addCard.onclick = () => this.addNewModule();
        addCard.innerHTML = '<span class="icon">' + appIcon('plus', 24) + '</span><span class="name">添加入口</span>';
        this.grid.appendChild(addCard);
    },

    /** 渲染一张模块卡片，保留导航及本地编辑操作。 */
    _renderModuleCard(mod, idx, localOnlyUnavailable) {
        const card = document.createElement('div');
        card.className = `admin-card ${this.manager.getItemClass(idx)}`;
        card.tabIndex = 0;
        card.setAttribute('role', 'link');
        card.addEventListener('keydown', event => {
            if (event.target === card && event.key === 'Enter') { event.preventDefault(); card.click(); }
        });
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

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = mod.title;

        card.appendChild(renderModuleIcon(mod));
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
        if (localOnlyUnavailable) {
            adminBtns.querySelectorAll('.maers-admin-btn').forEach(btn => disableAdminControl(btn));
        }

        actionGroup.appendChild(adminBtns);
        card.appendChild(actionGroup);
        return card;
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
            title: '编辑入口',
            isNew: false,
            data: mod,
            fields: this._moduleFields(),
            onSave: async (formData) => {
                if (formData.url !== oldUrl) await ensureCardPage(formData.url, formData.title);
                Object.assign(mod, formData, { style: formData.style || undefined });
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

    /** 新增和编辑模块共用的表单字段。 */
    _moduleFields() {
        return [
            { name: 'title', label: '入口名称', type: 'text', required: true },
            { name: 'icon', label: '图标地址', type: 'text', required: true, placeholder: '例如 ui/notes-icon.svg' },
            { name: 'url', label: '网址', type: 'text', required: true, placeholder: 'page.html' },
            { name: 'style', label: '样式地址（选填）', type: 'text', placeholder: 'custom/xxx.css' }
        ];
    },

    addNewModule() {
        if (isLocalOnlyUnavailable()) return;
        const newModule = {
            title: '',
            icon: 'ui/logo.svg',
            url: '',
            style: ''
        };

        AdminModal.open({
            title: '添加入口',
            isNew: true,
            data: newModule,
            fields: this._moduleFields(),
            onSave: (formData) => this._saveNewModule(formData)
        });
    },

    /** 新增模块由后端确认后才进入当前列表。 */
    async _saveNewModule(formData) {
        const added = { ...formData, style: formData.style || undefined };
        let saved;
        try {
            await ensureCardPage(added.url, added.title);
            saved = await appendSavedCard(SAVE_MODULES, this.modules, added);
        } catch (error) {
            console.error('[MAERS.Portal] 新建模块失败:', error);
            Feedback.notifyAddFail('管理模块创建失败');
            return false;
        }
        refreshSavedCards(() => {
            this.manager.markSaved(saved);
            this.render();
        }, () => Feedback.notifyAddSuccess('管理模块创建成功'));
        return true;
    },

    async performSave() {
        if (isLocalOnlyUnavailable()) return false;
        try {
            this.modules = await saveCardChanges(SAVE_MODULES, this.modules, '模块');
        } catch (error) {
            console.error('[MAERS.Portal] 保存模块失败:', error);
            Feedback.notifySaveFail(error.message);
            return false;
        }
        refreshSavedCards(() => {
            this.manager.setList(this.modules);
            this.render();
        }, () => Feedback.notifySaveSuccess());
        return true;
    },

    async performCancel() {
        this.manager.reset();
        Feedback.notifyCancel();
    }
};

