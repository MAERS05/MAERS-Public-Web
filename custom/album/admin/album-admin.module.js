/** 相册分类管理：批量编辑、确认写入后的状态更新与分类加解密。 */
import { isOnlineAdminPage, localFetch } from '../../../data-manage/api-client.module.js';
import { loadCloudAlbums } from '../../photos/admin/photos-private-drafts.module.js';

import { AdminModal } from '../../../data-manage/admin/admin-modal.module.js';
import { BatchItemManager, SaveButton, AdminButtonHelper, Feedback } from '../../../data-manage/admin/admin-base.module.js';
import { isEncryptedRecord } from '../../../data-manage/encrypt/crypto.module.js';
import {
    mountUnlockAllButton,
    refreshUnlockAllButton,
    countEncryptedDeep,
    lockAlbumCategoryFlow,
    unlockAlbumCategoryFlow,
    renderLockedCard,
    setupLockActionButton
} from '../../../data-manage/encrypt/admin-lock.module.js';
import { Utils } from '../../../shared/utils.module.js';
import { validatePhotoCategorySlug } from '../../../shared/photos-url.module.js';
import { Toast } from '../../../shared/toast.module.js';
import { disableAdminControl, isLocalOnlyUnavailable } from '../../../data-manage/admin/local-only.module.js';

// 依赖注入接口保持与相册入口一致。
let AdminCore;
export function initAlbumAdmin(adminCore) { AdminCore = adminCore; }

const grid = document.getElementById('category-grid');
let currentData = [];
let manager = null;
let mutationBusy = false;
let needsReload = false;
let privateAlbums = new Map();

function disabledReason() {
    if (isLocalOnlyUnavailable()) return '仅限电脑本地后台操作';
    if (needsReload) return '分类状态已改变，请刷新页面后继续编辑';
    return '';
}

function canEdit() {
    return Boolean(manager) && !mutationBusy && !disabledReason();
}

async function loadData() {
    if (isOnlineAdminPage()) {
        const { records, drafts } = await loadCloudAlbums();
        privateAlbums = new Map();
        currentData = records.map(record => {
            const entry = drafts.get(record);
            if (!entry?.payload.category?.id) return record;
            const category = { ...entry.payload.category };
            privateAlbums.set(category.id, entry);
            return category;
        });
        manager?.setList(currentData);
        return;
    }
    const response = await localFetch('data/album-config.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`读取分类失败（HTTP ${response.status}）`);
    const categories = await response.json();
    if (!Array.isArray(categories) || categories.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
        throw new TypeError('相册分类数据格式无效');
    }
    // 完整校验后才替换编辑列表和基线，读取失败时保留原有数据。
    currentData = categories;
    manager?.setList(currentData);
    needsReload = false;
}

async function init() {
    if (!grid) return;
    await loadData();
    manager = new BatchItemManager({ list: currentData, onUpdate: render });
    SaveButton.init(document.body, handleSave, () => {
        if (mutationBusy || needsReload) return;
        manager.reset();
        Feedback.notifyCancel();
    });
    render();
    mountUnlockAllButton({
        source: 'album-config.json',
        getCount: () => countEncryptedDeep(currentData, null, isEncryptedRecord),
        onUnlockAll: unlockAll
    });
}

async function unlockAll() {
    let count = 0;
    while (!needsReload) {
        const index = currentData.findIndex(isEncryptedRecord);
        if (index < 0 || !await unlockByIndex(index)) break;
        count++;
    }
    return count;
}

/** 只在操作入口捕获错误，成功写入后的界面失败单独处理。 */
async function mutate(action, label) {
    if (!canEdit()) return false;
    mutationBusy = true;
    const controls = ['global-save-btn', 'global-cancel-btn'].map(id => document.getElementById(id))
        .filter(Boolean).map(control => [control, control.disabled]);
    controls.forEach(([control]) => { control.disabled = true; });
    try {
        return await action();
    } catch (error) {
        console.error(`[MAERS Album] ${label}失败`, error);
        Feedback.notifyError(`${label}失败：${error.message}`);
        return false;
    } finally {
        mutationBusy = false;
        controls.forEach(([control, disabled]) => { control.disabled = disabled; });
    }
}

async function postCategory(endpoint, data, label) {
    const response = await localFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || detail.message || `${label}失败（HTTP ${response.status}）`);
    }
    return response;
}

async function resourceFeedback(response) {
    try {
        const result = await response.json();
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('资源状态反馈格式无效');
        return result;
    } catch (error) {
        console.warn('[MAERS Album] 分类操作已保存，资源状态反馈读取失败', error);
        Feedback.toast('分类操作已保存，目录状态反馈读取失败', 'warning');
        return {};
    }
}

function refreshConfirmed(update, success) {
    try {
        update();
        render();
    } catch (error) {
        needsReload = true;
        console.warn('[MAERS Album] 分类操作已保存，界面刷新失败', error);
        Feedback.toast('分类操作已保存，请手动刷新页面', 'warning');
        return;
    }
    success();
}

async function deleteCategory(category, physical) {
    const response = await postCategory('/api/delete_category', {
        id: category.id, delete_physical: physical
    }, `删除分类「${category.title}」`);
    const result = await resourceFeedback(response);
    if (physical) Feedback.notifySuccess('图片存储文件夹已同步删除');
    if (result.tag_file_deleted || physical) Feedback.notifySuccess('标签文件已同步删除');
}

async function handleSave() {
    return mutate(async () => {
        const snapshot = structuredClone(currentData);
        const deleted = snapshot.filter(item => item._deleted && !isEncryptedRecord(item));
        const choices = [];
        for (const item of deleted) {
            const choice = await AdminModal.choose({
                title: `删除相册「${item.title}」`,
                message: '仅移除相册入口：保留图片和标签，之后可以恢复相册。\n\n' +
                    '一并删除本地图片：删除该相册的原图、缩略图、预览图和标签，无法撤销。云端副本不会在此操作中删除。\n\n' +
                    '点击右上角 × 可取消本次保存。',
                primary: { text: '仅移除相册入口，保留图片', value: 'entry' },
                secondary: { text: '删除相册及本地图片', value: 'physical' }
            });
            if (choice !== 'entry' && choice !== 'physical') return false;
            choices.push([item, choice === 'physical']);
        }
        // 批量删除先完成所有选择，关闭任一弹窗都不会提前删除前面的相册。
        for (const [item, physical] of choices) await deleteCategory(item, physical);
        const remaining = snapshot.filter(item => isEncryptedRecord(item) || !item._deleted);
        for (const item of remaining) {
            if (isEncryptedRecord(item)) continue;
            await postCategory('/api/update_category', item, `更新分类「${item.title}」`);
        }
        await postCategory('/api/reorder_category', remaining.map(item => item.id || item._enc), '分类排序');
        // 使用已确认写入的快照推进基线，避免额外读取失败被误报成保存失败。
        currentData = remaining;
        refreshConfirmed(() => manager.setList(currentData), () => Feedback.notifySaveSuccess());
        return true;
    }, '保存分类');
}

function handleCardClick(event, category, index) {
    event.stopPropagation();
    if (event.target.closest('.action-btn')) return;
    if (manager?.selectedIndices.length && canEdit()) {
        if (manager.selectedIndices.includes(index)) manager.toggleSelect(index);
        else manager.moveTo(index);
        return;
    }
    if (!category._deleted) window.location.href = `admin-photos.html?id=${encodeURIComponent(category.id)}`;
}

function renderActions(category, index, reason) {
    const actions = AdminButtonHelper.render({
        index, isDeleted: category._deleted,
        onSort: event => uiToggleSelect(event, index),
        onEdit: event => uiEdit(event, index),
        onDelete: event => uiToggleDelete(event, index), containerClass: 'admin-actions'
    });
    const lockButton = document.createElement('span');
    lockButton.className = 'maers-admin-btn';
    setupLockActionButton(lockButton, {
        isLocked: Boolean(category._private_id || privateAlbums.has(category.id)),
        title: '对外加密此相册',
        onClick: event => { event.stopPropagation(); uiLock(index); }
    });
    actions.appendChild(lockButton);
    if (reason) actions.querySelectorAll('.maers-admin-btn').forEach(button => {
        if (privateAlbums.has(category.id) && button.querySelector('.maers-admin-edit-icon')) return;
        disableAdminControl(button, reason);
    });
    return actions;
}

function renderCategory(category, index, reason) {
    const card = document.createElement('div');
    card.className = `category-card ${category.style_class || ''} ${manager?.getItemClass(index) || ''}`;
    const selected = manager?.selectedIndices.indexOf(index) ?? -1;
    if (selected >= 0) card.setAttribute('data-order-num', selected + 1);
    card.onclick = event => handleCardClick(event, category, index);
    card.appendChild(renderActions(category, index, reason));
    const icon = document.createElement('div');
    icon.className = 'card-icon';
    icon.innerHTML = category.icon || '';
    card.appendChild(icon);
    const text = document.createElement('div');
    text.className = 'text-group';
    for (const [className, content] of [['card-title', category.title], ['card-subtitle', category.subtitle]]) {
        const element = document.createElement('div');
        element.className = className;
        element.textContent = content || '';
        text.appendChild(element);
    }
    card.appendChild(text);
    return card;
}

function render() {
    if (!grid) return;
    const reason = disabledReason();
    grid.innerHTML = '';
    currentData.forEach((category, index) => {
        const card = isEncryptedRecord(category) ? renderLockedCard({
            className: 'category-card locked-card', label: '私密相册', onUnlock: () => uiUnlock(index)
        }) : renderCategory(category, index, reason);
        if (reason && isEncryptedRecord(category)) disableAdminControl(card, reason);
        grid.appendChild(card);
    });
    const add = document.createElement('div');
    add.className = 'category-card func-card';
    if (reason) disableAdminControl(add, reason);
    else add.onclick = addNewCategory;
    add.innerHTML = '<div class="func-icon">＋</div><div class="func-text">ADD NEW CATEGORY</div>';
    grid.appendChild(add);
    refreshUnlockAllButton();
}

export function uiToggleSelect(event, index) {
    event.stopPropagation();
    if (canEdit()) manager.toggleSelect(index);
}

export function uiToggleDelete(event, index) {
    event.stopPropagation();
    if (canEdit()) manager.toggleDelete(index);
}

/** 加解密改变服务端密文；刷新失败时阻止继续编辑旧视图。 */
async function reloadAfterProtection() {
    try {
        await loadData();
    } catch (error) {
        needsReload = true;
        console.warn('[MAERS Album] 相册加解密已完成，列表刷新失败', error);
        Feedback.toast('相册加解密已完成，请刷新页面后继续编辑', 'warning');
    }
    refreshConfirmed(() => { if (!needsReload) SaveButton.hide(); }, () => {});
}

export async function uiLock(index) {
    return mutate(async () => {
        const category = currentData[index];
        if (!category?.id || isEncryptedRecord(category)) return false;
        if (category._private_id) {
            const { cancelProtection } = await import('../../../data-manage/encrypt/admin-lock.module.js');
            if (!await cancelProtection(category)) return false;
        } else {
            const { choosePasswordGroup } = await import('../../../data-manage/encrypt/password-groups.module.js');
            const group = await choosePasswordGroup({
                title: `加密相册「${category.title}」`,
                sub: '全部图片将迁入私有桶，并从公开桶与仓库删除。加密立即生效，未保存的修改会丢弃。'
            });
            if (!group || !await lockAlbumCategoryFlow(category.id, { group })) return false;
        }
        await reloadAfterProtection();
        return true;
    }, '相册加锁');
}

async function unlockByIndex(index) {
    return mutate(async () => {
        const category = currentData[index];
        if (!isEncryptedRecord(category) || !await unlockAlbumCategoryFlow(category)) return false;
        await reloadAfterProtection();
        return true;
    }, '相册解锁');
}

export async function uiUnlock(index) {
    if (!canEdit()) return false;
    if (!confirm('解锁将把该相册的全部图片迁回公开桶与仓库，恢复为公开状态。继续？')) return false;
    return unlockByIndex(index);
}

function iconInput(icon = '') {
    const value = String(icon ?? '');
    const match = value.match(/src=['"]([^'"]+)['"]/);
    return match ? match[1] : value;
}

function iconMarkup(value = '') {
    const icon = String(value ?? '').trim();
    return (icon.includes('/') || icon.includes('.')) && !icon.startsWith('<')
        ? `<img src="${Utils.escapeAttr(icon)}" style="width: 1em; height: 1em;">` : icon;
}

export function uiEdit(event, index) {
    event.stopPropagation();
    const item = currentData[index];
    const entry = privateAlbums.get(item?.id);
    if (!item || (!entry && !canEdit()) || manager.isDeleted(index)) return;
    AdminModal.open({
        title: 'Edit Category', isNew: false,
        data: { title: item.title, subtitle: item.subtitle, icon: iconInput(item.icon), slug: item.slug || '' },
        fields: [
            { name: 'title', label: 'Title', type: 'text', required: true },
            { name: 'subtitle', label: 'Subtitle', type: 'text', required: true },
            { name: 'icon', label: 'Icon (SVG path or Emoji)', type: 'text', required: true },
            { name: 'slug', label: '链接代号', type: 'text', placeholder: item.id }
        ],
        onSave: async form => {
            const changes = { title: form.title, subtitle: form.subtitle, icon: iconMarkup(form.icon), slug: form.slug.trim() };
            try {
                validatePhotoCategorySlug({ ...item, ...changes }, currentData);
            } catch (error) {
                Toast.error(error.message);
                return false;
            }
            if (entry) {
                try {
                    await entry.edit(payload => Object.assign(payload.category, changes));
                    Object.assign(item, changes);
                    render();
                    Toast.success('私密相册修改已暂存');
                    return true;
                } catch (error) {
                    Toast.error(error.message);
                    return false;
                }
            }
            if (!canEdit()) return false;
            Object.assign(item, changes);
            render();
            manager.updateSaveState();
            return true;
        }
    });
}

function notifyCreated(result) {
    for (const [created, existed, label] of [
        ['dirs_created', 'dirs_existed', '图片存储文件夹'],
        ['tag_file_created', 'tag_file_existed', '标签文件']
    ]) {
        if (result[created]) Feedback.notifySuccess(`${label}创建成功`);
        else if (result[existed]) Feedback.toast(`${label}已存在`, 'info');
    }
    Feedback.notifySuccess('分类创建成功');
}

async function createCategory(form) {
    return mutate(async () => {
        const category = { title: form.title, subtitle: form.subtitle, icon: iconMarkup(form.icon),
            id: form.id.trim(), slug: form.slug.trim() };
        if (currentData.some(item => item.id === category.id)) throw new Error('分类 ID 已存在');
        validatePhotoCategorySlug(category, currentData);
        const baseline = JSON.parse(manager.initialSnapshot);
        const response = await postCategory('/api/add_category', category, '创建分类');
        currentData.push(category);
        const result = await resourceFeedback(response);
        // 新分类已写入，其他分类仍保留尚未保存的重命名、排序及删除标记。
        refreshConfirmed(() => manager.markSaved([...baseline, category]), () => notifyCreated(result));
        return true;
    }, '创建分类');
}

export async function addNewCategory() {
    if (!canEdit()) return;
    AdminModal.open({
        title: 'Add New Category', isNew: true, data: { title: '', subtitle: '', icon: '', id: '', slug: '' },
        fields: [
            { name: 'title', label: 'Title (Chinese)', type: 'text', required: true },
            { name: 'subtitle', label: 'Subtitle (English)', type: 'text', required: true },
            { name: 'icon', label: 'Icon (SVG path or Emoji)', type: 'text', required: true },
            { name: 'id', label: 'Category ID (lowercase, immutable)', type: 'text', required: true, placeholder: 'category-name' },
            { name: 'slug', label: '链接代号（留空使用分类 ID）', type: 'text', placeholder: 'nature' }
        ],
        onSave: createCategory
    });
}

export const AlbumAdmin = { init, uiToggleSelect, uiToggleDelete, uiLock, uiUnlock, uiEdit, addNewCategory };

function initialize() {
    return init().catch(error => {
        console.error('[MAERS Album] 分类初始化失败', error);
        Toast.error(`分类加载失败：${error.message}`);
    });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
else initialize();
