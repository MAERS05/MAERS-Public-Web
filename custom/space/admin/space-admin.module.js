/**
 * @module custom/space/admin/space-admin.module.js
 * @description 空间管理：网站卡片、批量操作、筛选与云端持久化
 * @version 4.1.0 - Filters restored, markDirty fixed.
 */
import { Search } from '../../../shared/utils.module.js';
import { api, localFetch } from '../../../data-manage/api-client.module.js';
import { syncManager } from '../../../data-manage/sync/sync-manager.module.js';
import { applySpaceDraft } from '../../../data-manage/sync/relay-actions.module.js';

import { setupTagDragAndMenu } from '../../cms/admin/tag-interactions.module.js';
import { AdminModal } from '../../../data-manage/admin/admin-modal.module.js';
import { isEncryptedRecord } from '../../../data-manage/encrypt/crypto.module.js';
import { lockRecord, unlockRecord, mountUnlockAllButton, refreshUnlockAllButton, unlockListDeep, countEncryptedDeep, renderLockedCard, cryptoIconHtml, setupLockActionButton } from '../../../data-manage/encrypt/admin-lock.module.js';

let AdminCore = null;
let grid = null;

let treeData = { root: [] };
let currentPath = ['root'];

// Manager operates on the PHYSICAL list of current level
let manager = null;
let currentLevelNodes = [];

export function initSpaceAdmin(core) {
    AdminCore = core;
    init();
}

async function init() {
    grid = document.getElementById('category-grid');
    if (!grid) return;

    await loadData();

    // Init Batch Manager
    if (AdminCore?.BatchItemManager) {
        manager = new AdminCore.BatchItemManager({
            list: currentLevelNodes,
            onUpdate: () => {
                // When filtering, re-apply filters to stay in filtered view
                if (isFiltering() && applyFilters) {
                    applyFilters();
                } else {
                    render();
                }
            }
        });
    }

    setupUI();
    render();

    // 注册「解锁全部」按钮（递归整棵树，解锁目录后继续处理其子节点）
    const getKids = (n) => n.children;
    mountUnlockAllButton({
        source: 'space-tree.json',
        getCount: () => countEncryptedDeep(treeData.root, getKids, isEncryptedRecord),
        onUnlockAll: async () => {
            const n = await unlockListDeep(treeData.root, getKids, isEncryptedRecord);
            if (n > 0) {
                // 数组为原地修改，无需 updateCurrentLevel（避免 setList 重置脏检查快照）
                syncToAppState();
                if (manager) manager.updateSaveState();
                render();
            }
            return n;
        }
    });
}

function setupUI() {
    // SaveButton is initialized by admin-main.module.js using initUnified
    // Do not call SaveButton.init here as it will override the unified save logic
}

async function loadData() {
    let loaded = false;
    try {
        const res = await localFetch('data/space-tree.json', { cache: 'no-cache' });
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
        const data = res.ok ? await res.json() : { root: [] };
        if (!Array.isArray(data?.root)) throw new Error('空间数据格式无效');
        treeData = data;
        loaded = true;
    } catch (e) {
        console.error("Load failed", e);
        if (window.MAERS?.Toast) window.MAERS.Toast.error("Failed to load data");
        treeData = { root: [] };
    }
    // 云端模式：已发布的树叠加尚未合并的整份快照与标签草稿，刷新后保持一致
    if (loaded) treeData = await syncManager.loadDocument('space-tree', treeData, applySpaceDraft);
    else syncManager.rememberDocument('space-tree', undefined);
    updateCurrentLevel();
    syncToAppState(); // Important for search/filter
}

/** 当前是否经云端中继写入（无本地后端） */
function isRelayMode() {
    return syncManager.getEffectiveMode() === 'relay';
}

function updateCurrentLevel() {
    let nodes = treeData.root;
    for (let i = 1; i < currentPath.length; i++) {
        const pathSegment = currentPath[i];
        const node = nodes.find(n => n.id === pathSegment);
        if (node && node.children) {
            nodes = node.children;
        } else {
            nodes = treeData.root;
            currentPath = ['root'];
            break;
        }
    }
    currentLevelNodes = nodes;

    // Update manager list reference
    if (manager) {
        manager.setList(currentLevelNodes);
    }
}

// Sync tree data to global AppState for Search/Filter modules
function syncToAppState() {
    if (!AdminCore.AppState) return;

    function flatten(nodes, acc = []) {
        nodes.forEach(n => {
            acc.push(n);
            if (n.children) flatten(n.children, acc);
        });
        return acc;
    }

    AdminCore.AppState.allNodes = flatten(treeData.root);

    // Trigger generic search update if needed
    if (AdminCore.Search && AdminCore.Search.performSearch) {
        AdminCore.Search.performSearch();
    }
}

// Exported for admin-main to call when filters change
export function applyFilters() {
    // Trigger the search logic to update AppState.filteredNodes based on new filters
    if (AdminCore.Search && AdminCore.Search.performSearch) {
        AdminCore.Search.performSearch();
    }

    // [NEW] Update Breadcrumb (Filter Indicator)
    if (AdminCore.Nav && AdminCore.Nav.renderBreadcrumb) {
        AdminCore.Nav.renderBreadcrumb();
    }

    render();
}

// UI Bridges
function uiToggleSelect(e, index) {
    e.stopPropagation();
    if (manager) manager.toggleSelect(index);
}

function uiMoveTo(e, index) {
    e.stopPropagation();
    if (manager && manager.selectedIndices.length > 0) {
        manager.moveTo(index);
    }
}

function uiToggleDelete(e, index) {
    e.stopPropagation();
    if (!manager) return;

    if (isFiltering()) {
        const filteredNodes = getRenderNodes();
        const node = filteredNodes[index];
        if (!node) return;

        const managerIndex = manager.list.findIndex(n => n.id === node.id);
        if (managerIndex !== -1) {
            // Delegate logic to Manager (handles toggling, save state, selection)
            manager.toggleDelete(managerIndex);

            // Sync visual state if references differ (fix for stale UI in search view)
            const managerItem = manager.list[managerIndex];
            if (node !== managerItem) {
                // Ensure the UI node matches the Manager node state
                if (managerItem._deleted) node._deleted = true;
                else delete node._deleted;
            }

            // Re-render
            if (AdminCore.applyFilters) AdminCore.applyFilters();
            else render();

        } else {
            // Deep node (not in current manager list)
            // Just toggle local property and force dirty state
            if (node._deleted) delete node._deleted;
            else node._deleted = true;

            if (AdminCore.SaveButton) AdminCore.SaveButton.show();

            if (AdminCore.applyFilters) AdminCore.applyFilters();
            else render();
        }
    } else {
        manager.toggleDelete(index);
    }
}

function uiEdit(e, index) {
    e.stopPropagation();
    // Use the node from the *rendered* list
    const nodes = getRenderNodes();
    let node = nodes[index];
    if (!node) return;

    // [FIX] In filtering mode, filteredNodes might have stale references.
    // Always use the live object from treeData.
    if (isFiltering()) {
        const liveNode = Search.findNodeInfo(treeData.root, node.id);
        if (liveNode) {
            node = liveNode;
        } else {
            console.error('[SPACE] Node not found in treeData:', node.id);
            return;
        }
    }

    // We need to find the node in 'currentLevelNodes' if we want to support BatchManager saving correctly
    // But if we are in Filter mode, 'index' might not match 'currentLevelNodes'.
    // BatchManager primarily supports the *unfiltered* list view.
    // So if filtered, we do a direct edit without Manager dirty tracking (or we handle it manually).

    if (isFiltering()) {
        openEditModal(node, null); // null index = no batch manager sync
    } else {
        openEditModal(node, index);
    }
}

function isFiltering() {
    return (AdminCore.AppState.searchQuery || (AdminCore.AppState.activeFilters && AdminCore.AppState.activeFilters.size > 0));
}

function getRenderNodes() {
    if (isFiltering()) {
        return AdminCore.AppState.filteredNodes || [];
    }
    return currentLevelNodes;
}

async function saveNodeTags(node, newTags) {
    const oldTags = [...(node.tags || [])];
    node.tags = newTags;
    syncToAppState();
    if (await performUpdateTags(node, newTags)) return true;
    node.tags = oldTags;
    return false;
}

async function addNodeTags(event, node) {
    event.stopPropagation();
    const input = prompt('添加标签 (可使用 , 或 ， 分隔多个):');
    if (!input) return;
    const oldTags = node.tags || [];
    const additions = [...new Set(input.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))]
        .filter(tag => !oldTags.includes(tag));
    if (!additions.length) return;
    if (!(await saveNodeTags(node, [...oldTags, ...additions]))) render();
}

function createCardActions(node, index, filtering) {
    if (!AdminCore?.AdminButtonHelper) return null;
    const actions = AdminCore.AdminButtonHelper.render({
        index,
        isDeleted: node._deleted,
        onSort: filtering ? null : event => uiToggleSelect(event, index),
        onEdit: event => uiEdit(event, index),
        onAddTag: event => addNodeTags(event, node),
        onDelete: event => uiToggleDelete(event, index),
        containerClass: 'admin-actions'
    });
    const lockBtn = document.createElement('span');
    lockBtn.className = 'maers-admin-btn';
    setupLockActionButton(lockBtn, {
        isLocked: Boolean(node._private_id || node._cloudEnvelope),
        title: node._private ? '随上级对外加密' : '对外加密此节点',
        onClick: event => { event.stopPropagation(); uiLock(index); }
    });
    actions.appendChild(lockBtn);
    return actions;
}

function createCardContent(node) {
    const contentHtml = node.type === 'directory' ? `
        <div class="space-icon folder-icon">
            <svg viewBox="0 0 24 24" width="64" height="64" fill="currentColor">
                <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
            </svg>
        </div>
    ` : `
        <div class="space-icon">
            <img src="${node.icon || 'ui/placeholder.svg'}" alt="${escapeAttr(node.name)}" onerror="this.src='ui/placeholder.svg'">
        </div>
    `;

    const innerDiv = document.createElement('div');
    innerDiv.className = 'card-content-wrapper';
    innerDiv.innerHTML = `
        ${contentHtml}
        <div class="space-text">
            <div class="space-title">${escapeHtml(node.name)}</div>
            <div class="space-desc">${escapeHtml(node.content || '')}</div>
        </div>
        <div class="space-tags">
            ${(node.tags || []).map(tag => {
        const isActive = AdminCore.AppState?.activeFilters?.has(tag);
        return `<span class="space-tag ${isActive ? 'active' : ''}">${escapeHtml(tag)}</span>`;
    }).join('')}
        </div>
    `;

    const tagsContainer = innerDiv.querySelector('.space-tags');
    if (manager && tagsContainer) {
        setupTagDragAndMenu({
            tagsContainer,
            getTags: () => node.tags || [],
            onTagsUpdate: newTags => saveNodeTags(node, newTags)
        });
    }
    return innerDiv;
}

function handleCardClick(event, node, index, filtering) {
    if (event.target.closest('.action-btn') || event.target.closest('.maers-admin-btn')) return;
    const tag = event.target.closest('.space-tag');
    if (tag) {
        event.stopPropagation();
        AdminCore.Tags?.filterByTag?.(event, tag.textContent.trim());
    } else if (!filtering && manager?.selectedIndices.length > 0) {
        uiMoveTo(event, index);
    } else if (node.type !== 'directory' && node.url) {
        window.open(node.url, '_blank');
    }
}

function createSpaceCard(node, index, filtering) {
    if (isEncryptedRecord(node)) return _renderLockedSpaceCard(index);
    const card = document.createElement('div');
    const extraClasses = !filtering && manager ? manager.getItemClass(index)
        : filtering && node._deleted ? 'is-deleted' : '';
    card.className = `space-card ${node.type === 'directory' ? 'folder-card' : 'link-card'} ${extraClasses}`;
    card.dataset.id = node.id;
    card.dataset.type = node.type;
    if (!filtering && manager?.selectedIndices.includes(index)) {
        card.setAttribute('data-order-num', manager.selectedIndices.indexOf(index) + 1);
    }
    card.onclick = event => handleCardClick(event, node, index, filtering);
    const actions = createCardActions(node, index, filtering);
    if (actions) card.appendChild(actions);
    card.appendChild(createCardContent(node));
    return card;
}

function createAddCard() {
    const card = document.createElement('div');
    card.className = 'space-card add-card-wrapper';
    card.style.cssText = "border: 2px dashed rgba(255,255,255,0.15); display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer; opacity:0.6;";
    card.innerHTML = `<div style="font-size:48px; font-weight:300;">+</div><div style="font-size:12px; font-weight:600;">ADD NEW SITE</div>`;
    card.onclick = handleAdd;
    return card;
}

function render() {
    if (!grid) return;
    grid.innerHTML = '';
    const nodes = getRenderNodes();
    if (!nodes) return;
    const filtering = isFiltering();
    nodes.forEach((node, index) => grid.appendChild(createSpaceCard(node, index, filtering)));
    grid.appendChild(createAddCard());
    refreshUnlockAllButton();
}

function openEditModal(node, index, isNew = false) {
    const level = currentLevelNodes;
    AdminModal.open({
        title: isNew ? 'Add New Item' : 'Edit Item',
        isNew,
        data: node,
        fields: [
            ...(node.type === 'link' ? [
                { name: 'url', label: 'URL', type: 'url', required: true, placeholder: 'https://example.com', showFetch: true }
            ] : []),
            { name: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Site Name' },
            ...(node.type === 'link' ? [
                { name: 'icon', label: 'Icon URL', type: 'image', placeholder: 'https://.../icon.png' }
            ] : []),
            { name: 'content', label: 'Description', type: 'textarea', placeholder: 'Optional description' },
            { name: 'tags', label: 'Tags', type: 'tags', placeholder: 'tag1, tag2' }
        ],
        onSave: async (formData) => {
            const edited = { ...node, name: formData.name, content: formData.content, tags: formData.tags };
            if (node.type === 'link') {
                edited.url = formData.url;
                edited.icon = formData.icon;
            }

            try {
                await saveToServer({ node, edited, insertInto: isNew ? level : null });
            } catch (error) {
                console.error('[SPACE] 保存网站失败:', error);
                return false;
            }
            // 确认保存后才更新内存树，同一个表单重试只会插入一次。
            if (isNew) level.push(edited);
            else Object.assign(node, edited);
            try {
                syncToAppState();
                render();
                if (manager) manager.setList(currentLevelNodes);
                window.MAERS?.Toast?.success(isNew ? '网站收藏成功' : '保存成功');
            } catch (error) {
                console.warn('[SPACE] 保存后刷新失败:', error);
                window.MAERS?.Toast?.warning('网站已保存，请手动刷新页面');
            }
            return true;
        }
    });
}

function handleAdd() {
    // Auto-fill tags from active filters (matching CMS behavior)
    let autoTags = [];
    if (AdminCore?.AppState?.activeFilters && AdminCore.AppState.activeFilters.size > 0) {
        autoTags = Array.from(AdminCore.AppState.activeFilters);
    }

    const newNode = {
        id: `space_${Date.now()}`,
        name: '',
        type: 'link',
        url: '',
        content: '',
        tags: autoTags,
        children: null
    };

    openEditModal(newNode, null, true);
}

/**
 * Only POST the current treeData to the server (prune deleted nodes first).
 * Does NOT reload from JSON or re-render — caller is responsible for that.
 */
async function saveToServer({ node, edited, insertInto } = {}) {
    function pruneDeleted(nodes) {
        if (!nodes) return [];
        const list = nodes === insertInto ? [...nodes, edited] : nodes;
        return list.filter(n => !n._deleted).map(original => {
            const n = original === node ? edited : original;
            if (n.children) {
                return { ...n, children: pruneDeleted(n.children) };
            }
            return n;
        });
    }

    const cleanRoot = pruneDeleted(treeData.root);
    const dataToSave = { root: cleanRoot };

    const result = await syncManager.writeDocument('space-tree', dataToSave);
    if (!result.success) throw new Error(result.msg || '保存失败');
}

/**
 * Full save used by the floating save bar:
 * writes to server, then reloads JSON data and re-renders.
 * Needed when items may have been deleted or reordered.
 */
async function handleSave() {
    try {
        await saveToServer();

        if (manager) manager.reset();

        // Reload data to reflect server state (deletions, reorders, etc.)
        await loadData();
        render();
        return true;
    } catch (e) {
        console.error(e);
        if (window.MAERS?.Toast) window.MAERS.Toast.error("Save failed");
        return false;
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, function (m) {
        switch (m) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#039;';
        }
    });
}
function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/"/g, '&quot;');
}

async function performCancel() {
    // Revert changes by reloading original data
    await loadData();
    render();
}

async function performUpdateTags(node, tags) {
    const { id: nodeId } = node;
    try {
        if (isRelayMode() && node._private) {
            const saved = await syncManager.writePrivateSpaceTags(nodeId, tags);
            if (!saved.success) throw Error(saved.msg || '私密标签暂存失败');
        } else if (isRelayMode()) {
            const queued = await syncManager.enqueue('space', 'update_tags', { id: nodeId, tags });
            if (!queued.success) throw new Error(queued.msg || '暂存失败');
        } else {
            await api.post('/api/space/update_tags', { id: nodeId, tags: tags });
        }
        const item = { module: 'space', action: 'update_tags', data: { id: nodeId, tags } };
        if (!isRelayMode() || !node._private) {
            syncManager.updateDocumentBase('space-tree', content => applySpaceDraft(item, content));
        }

        // Success - apply filters to update view and breadcrumb
        if (typeof applyFilters === 'function') {
            applyFilters();
        } else {
            render();
        }

        // Refresh counts in drawer
        if (AdminCore?.Tags?.refreshDrawerList) {
            AdminCore.Tags.refreshDrawerList();
        }

        return true;
    } catch (e) {
        console.error("[SPACE] Update tags failed", e);
        window.MAERS?.Toast?.error?.(e.message || '标签保存失败');
        return false;
    }
}

export const SpaceAdmin = {
    render,
    applyFilters,
    performSave: handleSave,
    performCancel,
    getManager: () => manager
};

// ── 加锁 / 解锁 ──

/**
 * 加锁：将当前层级指定索引的节点加密
 * @param {number} index
 */
async function uiLock(index) {
    const nodes = getRenderNodes();
    const node = nodes[index];
    if (!node || isEncryptedRecord(node)) return;

    // 找到 currentLevelNodes 中对应的实际索引
    const actualIdx = currentLevelNodes.findIndex(n => n === node || n.id === node.id);
    const targetIdx = actualIdx !== -1 ? actualIdx : index;

    const enc = await lockRecord(currentLevelNodes[targetIdx], { choose: true });
    if (!enc) return;

    currentLevelNodes[targetIdx] = enc;
    if (manager) manager.updateSaveState();
    render();
}

/**
 * 解锁：将加密节点恢复
 * @param {number} index
 */
async function uiUnlock(index) {
    const enc = currentLevelNodes[index];
    if (!isEncryptedRecord(enc)) return;

    const original = await unlockRecord(enc);
    if (!original) return;

    currentLevelNodes[index] = original;
    if (manager) manager.updateSaveState();
    render();
}

/**
 * 渲染 Space 节点的锁定占位卡片
 * @param {number} index
 * @returns {HTMLElement}
 */
function _renderLockedSpaceCard(index) {
    return renderLockedCard({
        className: 'space-card locked-card',
        label: '私密内容',
        onUnlock: () => uiUnlock(index),
        deleteEl: AdminCore?.AdminButtonHelper?.render({
            index,
            isDeleted: false,
            onDelete: (e) => { e.stopPropagation(); uiToggleDelete(e, index); }
        })
    });
}
