/**
 * MAERS CMS - Recent Files Module
 * 职责：管理最近访问的文件历史（LocalStorage持久化）
 * @version 1.0.0
 */

// Dependency Injection
let State = null;
let Controller = null;
let View = null;

const MAX_Items = 12;

function getStorageKey() {
    const module = Controller?.CONFIG?.CURRENT_MODULE || 'default';
    return `maers_cms_recent_files_${module}`;
}

function getPinnedKey() {
    const module = Controller?.CONFIG?.CURRENT_MODULE || 'default';
    return `maers_cms_pinned_files_${module}`;
}

export function initRecent(state, controller, view) {
    State = state;
    Controller = controller;
    View = view;

    injectUI();
    setupListeners();
}

function injectUI() {
    // 1. Check & Inject Button
    if (!document.querySelector('.recent-toggle-btn')) {
        const headerRight = document.querySelector('.header-right');
        if (headerRight) {
            const btn = document.createElement('button');
            btn.className = 'recent-toggle-btn';
            btn.style.cssText = 'align-self: flex-end; margin-top: 5px; background: transparent; border: none; padding: 5px; cursor: pointer; opacity: 0.7; transition: 0.2s; color: var(--text-sub);';
            btn.innerHTML = `<img src="ui/cms-history.svg" style="width:24px; height:24px; display:block; color:inherit;">`;
            btn.title = '快速访问';
            headerRight.appendChild(btn);
        }
    }

    // 2. Check & Inject Drawer
    if (!document.getElementById('recent-drawer')) {
        const drawerHtml = `
            <div id="recent-drawer-overlay" class="drawer-overlay"></div>
            <div id="recent-drawer" class="tag-drawer">
                <div class="drawer-header">
                    <div style="display:flex; justify-content:space-between; align-items:center; width:100%">
                        <h3>Quick Access</h3>
                        <button class="btn-close-drawer btn-close-recent">×</button>
                    </div>
                </div>
                <div class="drawer-body" id="recent-drawer-list"></div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', drawerHtml);
    }
}

function setupListeners() {
    // Re-query dynamically injected elements
    const btn = document.querySelector('.recent-toggle-btn');
    const closeBtn = document.querySelector('.btn-close-recent'); // This is inside drawer now
    const overlay = document.getElementById('recent-drawer-overlay');

    if (btn) btn.addEventListener('click', toggleDrawer);
    // Use delegation for close button in case drawer is re-rendered? 
    // Actually drawer structure is static, list is dynamic. Close button is in header.
    // But I injected HTML string.
    // Need to query it again.

    // Close button listener
    document.addEventListener('click', e => {
        if (e.target.matches('.btn-close-recent')) {
            toggleDrawer();
        }
    });

    if (overlay) overlay.addEventListener('click', toggleDrawer);
}

export function toggleDrawer() {
    const drawer = document.getElementById('recent-drawer');
    const overlay = document.getElementById('recent-drawer-overlay');

    if (drawer && overlay) {
        const isActive = drawer.classList.contains('active');
        if (isActive) {
            drawer.classList.remove('active');
            overlay.classList.remove('active');
        } else {
            renderList();
            drawer.classList.add('active');
            overlay.classList.add('active');
        }
    }
}

export function addToHistory(node) {
    if (!node || !node.id) return;

    // Check if pinned
    const pinned = getPinned();
    if (pinned.some(p => p.id === node.id)) return;

    let history = getHistory();
    // Remove existing entry for this node
    history = history.filter(item => item.id !== node.id);

    // Add to front
    history.unshift({
        id: node.id,
        title: node.title,
        type: node.type,
        timestamp: Date.now()
    });

    // Trim
    if (history.length > MAX_Items) {
        history = history.slice(0, MAX_Items);
    }

    localStorage.setItem(getStorageKey(), JSON.stringify(history));

    // Update view if drawer is open
    const drawer = document.getElementById('recent-drawer');
    if (drawer && drawer.classList.contains('active')) {
        renderList();
    }
}

function getHistory() {
    try {
        const data = localStorage.getItem(getStorageKey());
        return data ? JSON.parse(data) : [];
    } catch (e) {
        return [];
    }
}

function getPinned() {
    try {
        const data = localStorage.getItem(getPinnedKey());
        return data ? JSON.parse(data) : [];
    } catch (e) {
        return [];
    }
}

function savePinned(list) {
    localStorage.setItem(getPinnedKey(), JSON.stringify(list));
}

// Logic: Cancel fix -> direct remove
function togglePin(e, id) {
    e.stopPropagation(); // Prevent opening file

    let pinned = getPinned();
    let history = getHistory();

    const isPinned = pinned.some(p => p.id === id);

    if (isPinned) {
        // Unpin: Remove directly (per user req)
        pinned = pinned.filter(p => p.id !== id);
        savePinned(pinned);
    } else {
        // Pin: Move from history to pinned
        const item = history.find(h => h.id === id);
        if (item) {
            history = history.filter(h => h.id !== id);
            localStorage.setItem(getStorageKey(), JSON.stringify(history));

            pinned.unshift(item); // Add to top of pinned
            savePinned(pinned);
        }
    }
    renderList();
}

const sectionStates = { fixed: true, recent: true };

function renderList() {
    const container = document.getElementById('recent-drawer-list');
    if (!container) return;

    const history = getHistory();
    const pinned = getPinned();

    let html = '';

    // Helper for Header
    const renderHeader = (title, key) => {
        const isOpen = sectionStates[key];
        const arrowStyle = `transform: rotate(${isOpen ? '0deg' : '-90deg'}); transition: transform 0.2s;`;
        return `
        <div class="section-header" data-key="${key}" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center; padding:10px 15px; user-select:none;">
            <h4 style="margin:0; font-size:0.85em; color:var(--text-main); text-transform:uppercase; letter-spacing:1px; font-weight:bold;">${title}</h4>
            <span class="chevron" style="${arrowStyle} color:var(--text-main); font-size:0.8em;">▼</span>
        </div>`;
    };

    // FIXED ACCESS Section
    html += `<div class="drawer-section">
        ${renderHeader('固定访问', 'fixed')}
        <div class="section-content" style="display:${sectionStates.fixed ? 'block' : 'none'}">
            ${pinned.length > 0 ? renderItems(pinned, true) : '<div style="padding:10px 15px; color:#888; font-style:italic; font-size:0.85em; opacity:0.6;">No pinned items</div>'}
        </div>
    </div>`;

    // RECENT ACCESS Section
    html += `<div class="drawer-section">
        ${renderHeader('最近访问', 'recent')}
        <div class="section-content" style="display:${sectionStates.recent ? 'block' : 'none'}">
            ${history.length > 0 ? renderItems(history, false) : '<div style="padding:10px 15px; color:#888; font-style:italic; font-size:0.85em; opacity:0.6;">No recent items</div>'}
        </div>
    </div>`;

    container.innerHTML = html;

    // Bind Header Clicks (Toggle)
    container.querySelectorAll('.section-header').forEach(header => {
        header.addEventListener('click', () => {
            const key = header.dataset.key;
            sectionStates[key] = !sectionStates[key];
            renderList(); // Re-render to update view
        });
    });

    // Bind item clicks
    container.querySelectorAll('.recent-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.pin-btn')) return;
            openRecentFile(el.dataset.id);
        });

        const pinBtn = el.querySelector('.pin-btn');
        if (pinBtn) {
            pinBtn.addEventListener('click', (e) => togglePin(e, el.dataset.id));
        }
    });
}


function renderItems(list, isPinned) {
    return list.map(item => `
        <div class="drawer-item recent-item" data-id="${item.id}" data-type="${item.type}" style="display:flex; justify-content:space-between; align-items:center;">
            <div class="item-info" style="flex:1; display:flex; align-items:center; gap:8px; overflow:hidden;">
                <span class="item-icon">${item.type === 'folder' ? '📁' : '📄'}</span>
                <div style="display:flex; flex-direction:column; min-width:0;">
                    <span class="item-name" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(item.title)}</span>
                    <span class="item-time" style="font-size:0.7em;color:var(--text-sub);opacity:0.6;">${new Date(item.timestamp).toLocaleDateString()}</span>
                </div>
            </div>
            <button class="pin-btn" title="${isPinned ? 'Unpin' : 'Pin'}" style="background:none; border:none; color:var(--text-sub); cursor:pointer; padding:8px; opacity:0.6; transition:all 0.2s; display:flex;">
                <img src="ui/${isPinned ? 'cms-pin-slash.svg' : 'cms-pin.svg'}" style="width:18px; height:18px; display:block;">
            </button>
        </div>
    `).join('');
}

async function openRecentFile(id) {
    // We need to navigate to this file.
    // If it's a folder, enterFolder.
    // If it's a file, we need to find it and likely trigger 'uiPickNode' or similar.
    // Since we only have ID, we need to find it in State.AppState.allNodes

    if (!State || !State.AppState) return;

    const node = State.AppState.allNodes.find(n => n.id === id);

    if (node) {
        toggleDrawer(); // Close drawer

        if (node.type === 'folder') {
            // How to navigate to a folder by ID?
            // Need to reconstruct path or just call enterFolder if logic allows arbitrary node interaction
            // View.enterFolder(node); 
            // Better: update pathStack.
            // Actually, best to use Controller to navigate if possible, or View.
            if (View && View.enterFolder) View.enterFolder(node);
        } else {
            // It's a file (note)
            if (View && View.openFile) {
                View.openFile(node);
            } else if (View && View.uiPickNode) {
                // Fallback for Admin
                View.uiPickNode(new Event('click'), id);
            }
        }
    } else {
        alert('File not found (might be deleted)');
        // Remove from history?
        let history = getHistory().filter(i => i.id !== id);
        localStorage.setItem(getStorageKey(), JSON.stringify(history));
        renderList();
    }
}

function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export const Recent = {
    initRecent,
    addToHistory,
    toggleDrawer
};
