/**
 * @module custom/space/admin/space-admin.module.js
 * @description Space Admin - Fully Restored & Fixed (Batch Manager + Filters)
 * @version 4.1.0 - Filters restored, markDirty fixed.
 */

import { setupTagDragAndMenu } from '../../cms/admin/tag-interactions.module.js';

import { AdminModal } from '../../../data-manage/admin-modal.module.js';

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
                // When manager updates (selection/deletion state), just re-render
                // Manager handles SaveButton visibility internally via updateSaveState()
                render();
            }
        });
    }

    setupUI();
    render();
}

function setupUI() {
    // SaveButton is initialized by admin-main.module.js using initUnified
    // Do not call SaveButton.init here as it will override the unified save logic
}

async function loadData() {
    try {
        const res = await fetch(`data/space-tree.json?v=${Date.now()}`);
        if (res.ok) {
            treeData = await res.json();
        } else {
            treeData = { root: [] };
        }
    } catch (e) {
        console.error("Load failed", e);
        if (window.MAERS?.Toast) window.MAERS.Toast.error("Failed to load data");
        treeData = { root: [] };
    }
    updateCurrentLevel();
    syncToAppState(); // Important for search/filter
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
    if (manager) manager.toggleDelete(index);
}

function uiEdit(e, index) {
    e.stopPropagation();
    // Use the node from the *rendered* list
    const nodes = getRenderNodes();
    const node = nodes[index];
    if (!node) return;

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

function render() {
    if (!grid) return;
    grid.innerHTML = '';

    const nodes = getRenderNodes();
    const filtering = isFiltering();

    if (!nodes) return;

    nodes.forEach((node, index) => {
        const card = document.createElement('div');

        let extraClasses = '';
        // Only apply Manager classes if NOT filtering (indexes match)
        if (!filtering && manager) {
            extraClasses = manager.getItemClass(index);
        }

        card.className = `space-card ${node.type === 'directory' ? 'folder-card' : 'link-card'} ${extraClasses}`;
        card.dataset.id = node.id;
        card.dataset.type = node.type;

        if (!filtering && manager && manager.selectedIndices.includes(index)) {
            card.setAttribute('data-order-num', manager.selectedIndices.indexOf(index) + 1);
        }

        // Click Handler (Navigation)
        card.onclick = (e) => {
            if (e.target.closest('.action-btn') || e.target.closest('.maers-admin-btn')) return;

            // 1. Tag Click
            const tagEl = e.target.closest('.space-tag');
            if (tagEl) {
                e.stopPropagation();
                if (AdminCore.Tags && AdminCore.Tags.filterByTag) {
                    AdminCore.Tags.filterByTag(e, tagEl.textContent.trim());
                }
                return;
            }

            // 2. Move-To (if batch selection is active)
            if (!filtering && manager && manager.selectedIndices.length > 0) {
                uiMoveTo(e, index);
                return;
            }

            // 3. Navigation
            if (node.type === 'directory') {
                // Enter folder?
            } else if (node.url) {
                window.open(node.url, '_blank');
            }
        };

        // Render Buttons
        if (AdminCore?.AdminButtonHelper) {
            const adminEl = AdminCore.AdminButtonHelper.render({
                index: index,
                isDeleted: node._deleted,
                onSort: filtering ? null : (e) => uiToggleSelect(e, index),
                onEdit: (e) => uiEdit(e, index),
                onDelete: filtering ? null : (e) => uiToggleDelete(e, index),
                containerClass: 'admin-actions' // This might need adjustment if using specific styles
            });

            // Add Custom 'Add Tag' Button to the admin group
            const addTagBtn = document.createElement('span');
            addTagBtn.className = 'maers-admin-btn'; // Use global admin btn class
            addTagBtn.innerHTML = '＋';
            addTagBtn.title = 'Add Tag';
            addTagBtn.onclick = async (e) => {
                e.stopPropagation();
                const newTag = prompt("Add Tag:");
                if (newTag) {
                    const cleanTag = newTag.trim();
                    if (cleanTag) {
                        if (!node.tags) node.tags = [];
                        if (!node.tags.includes(cleanTag)) {
                            const newTags = [...node.tags, cleanTag];
                            // Optimistic update
                            node.tags = newTags;
                            syncToAppState();

                            // Call Granular API
                            if (await performUpdateTags(node.id, newTags)) {
                                // Success - UI already optimistic
                            } else {
                                // Revert on failure
                                node.tags = node.tags.filter(t => t !== cleanTag);
                                render();
                            }
                        }
                    }
                }
            };
            // Append to the container returned by helper
            // Note: AdminButtonHelper usually returns the wrapper div found in cms-render-grid
            adminEl.appendChild(addTagBtn);

            card.appendChild(adminEl);
        }

        // Inner Content
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

        // Tag interactions (drag-and-drop + context menu)
        if (manager) {
            const tagsContainer = innerDiv.querySelector('.space-tags');
            if (tagsContainer) {
                const setupEvents = () => {
                    setupTagDragAndMenu({
                        tagsContainer,
                        getTags: () => node.tags || [],
                        onTagsUpdate: async (newTags) => {
                            const oldTags = [...node.tags];
                            node.tags = newTags;
                            syncToAppState();

                            if (await performUpdateTags(node.id, newTags)) {
                                return true;
                            } else {
                                node.tags = oldTags;
                                return false;
                            }
                        }
                    });
                };
                setupEvents();
            }
        }

        card.appendChild(innerDiv);

        grid.appendChild(card);
    });

    // Add New Card (Always visible)
    const addCard = document.createElement('div');
    addCard.className = 'space-card add-card-wrapper';
    addCard.style.cssText = "border: 2px dashed rgba(255,255,255,0.1); display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer; opacity:0.6;";
    addCard.innerHTML = `<div style="font-size:48px; font-weight:300;">+</div><div style="font-size:12px; font-weight:600;">ADD NEW SITE</div>`;
    addCard.onclick = handleAdd;
    grid.appendChild(addCard);
}
function openEditModal(node, index, isNew = false) {
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
            // Update node properties
            node.name = formData.name;
            node.content = formData.content;
            if (node.type === 'link') {
                node.url = formData.url;
                node.icon = formData.icon;
            }
            node.tags = formData.tags;

            // Logic for New Item
            if (isNew) {
                currentLevelNodes.push(node);
                if (manager) {
                    manager.setList(currentLevelNodes);
                }
            }

            try {
                // Update app state first
                syncToAppState();

                // Call the main save function directly
                await handleSave();

                // If we reach here, save was successful
                if (window.MAERS?.Toast) {
                    window.MAERS.Toast.success(isNew ? "网站收藏成功" : "Item saved!");
                }

                // Clean up manager state since we just saved everything
                if (manager) manager.reset();

                return true; // Close modal
            } catch (err) {
                console.error(err);
                if (window.MAERS?.Toast) {
                    window.MAERS.Toast.error(isNew ? "网站收藏失败" : "Save failed");
                }
                return false; // Keep modal open
            }
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

async function handleSave() {
    console.log("Saving data...", treeData);
    function pruneDeleted(nodes) {
        if (!nodes) return [];
        return nodes.filter(n => !n._deleted).map(n => {
            if (n.children) {
                return { ...n, children: pruneDeleted(n.children) };
            }
            return n;
        });
    }

    try {
        // Create a clean copy of the tree data
        const cleanRoot = pruneDeleted(treeData.root);
        const dataToSave = { root: cleanRoot };

        const res = await fetch('/api/space/save_tree', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dataToSave)
        });

        if (res.ok) {
            if (manager) manager.reset();

            // Reload data
            await loadData();
            render(); // Force UI update with new data
            return true;
        } else {
            throw new Error(res.status);
        }
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
    if (manager) manager.reset();
    render();
}

async function performUpdateTags(nodeId, tags) {
    try {
        const res = await fetch('/api/space/update_tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: nodeId, tags: tags })
        });
        if (res.ok) {
            // No need to reload whole tree if successful
            render();
            return true;
        }
        throw new Error(res.status);
    } catch (e) {
        console.error("Update tags failed", e);
        if (window.MAERS?.Toast) window.MAERS.Toast.error("Update tags failed");
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
