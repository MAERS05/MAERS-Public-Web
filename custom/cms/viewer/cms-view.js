/**
 * MAERS CMS - View Layer (cms-view.js)
 * 职责：搜索UI、标签UI、渲染引擎、图片灯箱
 * 依赖：MAERS.Utils.Search, MAERS.CMS.Core, MAERS.ModuleConfig
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.CMS = MAERS.CMS || {};

    const CmsView = (function () {

        // ================= 内部状态引用 =================
        let AppState = null;
        let CONFIG = null;
        let IS_ADMIN = false;

        // ================= 渲染控制 =================
        let currentRenderTask = 0;
        let gridEventsDelegated = false;

        // ================= 初始化 =================
        function init(appState, config) {
            AppState = appState;
            CONFIG = config;
            IS_ADMIN = MAERS.CMS.Controller.CONFIG.IS_ADMIN;

            // 初始化灯箱
            initLightbox();

            // Admin Feature Init
            if (IS_ADMIN) initAdminFeatures();
        }

        // ================= 0. Admin UI Logic (Moved from Core) =================

        function initAdminFeatures() {
            const headerRight = document.querySelector('.header-right');
            if (headerRight && IS_ADMIN) {
                const btnGroup = document.createElement('div');
                btnGroup.style.display = 'flex';
                btnGroup.style.gap = '10px';
                btnGroup.innerHTML = `<button class="tag-toggle-btn" onclick="MAERS.CMS.View.uiCreateNode('folder')">＋📁</button><button class="tag-toggle-btn" onclick="MAERS.CMS.View.uiCreateNode('note')">＋📝</button>`;
                headerRight.appendChild(btnGroup);
            }

            // Global Click for "Place"
            document.addEventListener('click', (e) => {
                if (!AppState.pickedId) return;

                if (e.target.closest('.grid-item') ||
                    e.target.closest('#breadcrumb') ||
                    e.target.closest('button') ||
                    e.target.closest('input') ||
                    e.target.closest('.modal') ||
                    e.target.closest('.mini-tag')) {
                    return;
                }

                const current = AppState.pathStack[AppState.pathStack.length - 1];
                const pid = (current === 'root') ? 'root' : current.id;
                uiExecuteMove(pid);
            });
            
            // Global Right-Click for "Cancel Pick"
            document.addEventListener('contextmenu', (e) => {
                if (!AppState.pickedId) return;
                e.preventDefault();
                uiCancelPick();
                showToast('❌ 移动已取消');
            });
        }

        // UI Wrapper for Controller Actions

        async function uiCreateNode(type) {
            const t = prompt("Name:");
            if (!t) return;
            const current = AppState.pathStack[AppState.pathStack.length - 1];
            const pid = (current === 'root') ? 'root' : current.id;

            const res = await MAERS.CMS.Controller.createNode(pid, type, t);
            if (res.success) refreshView();
            else showToast(res.msg, 'error');
        }

        async function uiRenameNode(e, id, old) {
            e.stopPropagation();
            const t = prompt("Rename:", old);
            if (!t) return;
            const res = await MAERS.CMS.Controller.renameNode(id, t);
            if (res.success) refreshView();
        }

        async function uiDeleteNode(e, id) {
            e.stopPropagation();
            if (!confirm("Delete?")) return;
            const res = await MAERS.CMS.Controller.deleteNode(id);
            if (res.success) { showToast("Deleted"); refreshView(); }
        }

        function uiPickNode(e, id) {
            e.stopPropagation();
            if (AppState.pickedId === id) uiCancelPick();
            else {
                AppState.pickedId = id;
                showToast("📦 Picked. Click destination.");
                renderGrid((AppState.pathStack.length > 1 ? AppState.pathStack[AppState.pathStack.length - 1].children : AppState.root));
                startGhost(id);
            }
        }

        function uiCancelPick() {
            AppState.pickedId = null;
            stopGhost();
            renderGrid((AppState.pathStack.length > 1 ? AppState.pathStack[AppState.pathStack.length - 1].children : AppState.root));
        }

        async function uiExecuteMove(targetParentId) {
            if (targetParentId !== AppState.pickedId) {
                const res = await MAERS.CMS.Controller.moveNode(AppState.pickedId, targetParentId);
                if (res.success) {
                    refreshView();
                }
            }
            AppState.pickedId = null;
            stopGhost();
        }

        async function uiAddTag(e, id) {
            e.stopPropagation();
            const node = AppState.allNodes.find(n => n.id === id);
            const newTag = prompt("New Tag:");
            if (!newTag || (node.tags && node.tags.includes(newTag))) return;
            const updated = [...(node.tags || []), newTag];
            const res = await MAERS.CMS.Controller.updateTags(id, updated);
            if (res.success) refreshView();
        }

        async function uiRemoveTag(e, id, tag) {
            e.preventDefault(); e.stopPropagation();
            if (!confirm(`Delete tag #${tag}?`)) return;
            const node = AppState.allNodes.find(n => n.id === id);
            const updated = (node.tags || []).filter(t => t !== tag);
            const res = await MAERS.CMS.Controller.updateTags(id, updated);
            if (res.success) refreshView();
        }

        async function refreshView() {
            // Re-render current view based on updated data
            // Recalculate PathStack since objects are new
            const current = AppState.pathStack[AppState.pathStack.length - 1];
            const currentId = (current === 'root') ? 'root' : current.id;

            // Restore path stack logic
            if (currentId !== 'root') {
                const newPath = MAERS.Utils.Search.findPathNodes(AppState.root, currentId);
                if (newPath) AppState.pathStack = ['root', ...newPath];
                else AppState.pathStack = ['root']; // fallback
            } else {
                AppState.pathStack = ['root'];
            }

            const target = AppState.pathStack[AppState.pathStack.length - 1];
            renderGrid(target === 'root' ? AppState.root : target.children);
            renderBreadcrumb();
            refreshDrawerList();
        }

        // Ghost Visuals
        function startGhost(id) {
            let g = document.getElementById('move-ghost');
            if (!g) {
                g = document.createElement('div');
                g.id = 'move-ghost';
                g.style.cssText = "position:fixed;z-index:9999;pointer-events:none;background:rgba(120,255,214,0.9);color:#000;padding:8px 12px;border-radius:20px;box-shadow:0 4px 15px rgba(0,0,0,0.3);font-weight:bold;font-size:14px;backdrop-filter:blur(5px);border:1px solid rgba(255,255,255,0.5);display:none;";
                document.body.appendChild(g);
            }
            const node = AppState.allNodes.find(n => n.id === id);
            g.innerText = `📦 Moving: ${node ? node.title : id}`;
            g.style.display = 'block';
            document.addEventListener('mousemove', moveGhost);
        }

        function stopGhost() {
            const g = document.getElementById('move-ghost');
            if (g) g.style.display = 'none';
            document.removeEventListener('mousemove', moveGhost);
        }

        function moveGhost(e) {
            const g = document.getElementById('move-ghost');
            if (g) { g.style.left = e.clientX + 'px'; g.style.top = e.clientY + 'px'; }
        }

        function showToast(msg, type = 'success') {
            if (MAERS.Toast) type === 'error' ? MAERS.Toast.error(msg) : MAERS.Toast.success(msg);
            else alert(msg);
        }

        // ================= 1. 搜索与筛选 UI =================

        function setupSearchListeners() {
            const mainInput = document.getElementById('search-input');
            if (mainInput) {
                mainInput.addEventListener('input', (e) => {
                    autoResizeInput(e.target);
                    applyFilter();
                });
            }

            const drawerInput = document.getElementById('tag-drawer-search');
            if (drawerInput) {
                drawerInput.addEventListener('input', refreshDrawerList);
            }
        }

        function autoResizeInput(input) {
            const span = document.createElement('span');
            span.style.font = getComputedStyle(input).font;
            span.style.visibility = 'hidden';
            span.style.position = 'absolute';
            span.style.whiteSpace = 'pre';
            span.textContent = input.value || input.placeholder;
            document.body.appendChild(span);
            input.style.width = Math.max(260, Math.min(span.offsetWidth + 60, 600)) + 'px';
            document.body.removeChild(span);
        }

        function applyFilter() {
            const mainInput = document.getElementById('search-input');
            const keywordStr = mainInput ? mainInput.value.trim() : '';

            // 使用 MAERS.Utils.Search 的筛选算法
            const Search = MAERS.Utils && MAERS.Utils.Search;
            if (!Search) return;

            const results = Search.filterNodes(
                AppState.root,
                AppState.activeFilters,
                keywordStr
            );

            // 渲染
            if (AppState.activeFilters.size > 0 || keywordStr) {
                renderGrid(results, true);
            } else {
                const current = AppState.pathStack[AppState.pathStack.length - 1];
                const list = (current === 'root') ? AppState.root : current.children;
                renderGrid(list);
            }
        }

        // ================= 2. 标签侧边栏 UI =================

        function filterByTag(e, tag) {
            e.stopPropagation();
            if (AppState.activeFilters.has(tag)) AppState.activeFilters.delete(tag);
            else AppState.activeFilters.add(tag);
            applyFilter();
            refreshDrawerList();
        }

        function toggleTagDrawer() {
            const drawer = document.getElementById('tag-drawer');
            const overlay = document.getElementById('drawer-overlay');
            const active = drawer.classList.toggle('active');
            overlay.classList.toggle('active', active);
            if (active) refreshDrawerList();
        }

        function refreshDrawerList() {
            const listContainer = document.getElementById('drawer-list');
            const inputEl = document.getElementById('tag-drawer-search');
            if (!listContainer) return;

            const query = inputEl ? inputEl.value.trim().toLowerCase() : '';
            const tagCounts = {};

            AppState.allNodes.forEach(node => {
                (node.tags || []).forEach(t => {
                    let match = true;
                    if (query) {
                        const keys = query.split(/[,，]/).map(s => s.trim()).filter(s => s);
                        if (keys.length > 0) match = keys.some(k => t.toLowerCase().includes(k));
                    }
                    if (match) tagCounts[t] = (tagCounts[t] || 0) + 1;
                });
            });

            const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

            if (sorted.length === 0) {
                listContainer.innerHTML = '<div style="text-align:center;color:#666;margin-top:20px;">No tags found</div>';
            } else {
                listContainer.innerHTML = sorted.map(([tag, count]) => {
                    const active = AppState.activeFilters.has(tag) ? 'active' : '';
                    return `<div class="drawer-item ${active}" onclick="MAERS.CMS.View.selectTagFromDrawer('${tag}')"><span>#${tag}</span><span class="tag-count-badge">${count}</span></div>`;
                }).join('');
            }
        }

        function selectTagFromDrawer(tag) {
            if (AppState.activeFilters.has(tag)) AppState.activeFilters.delete(tag);
            else AppState.activeFilters.add(tag);
            applyFilter();
            refreshDrawerList();
        }

        function clearTagFilter() {
            AppState.activeFilters.clear();
            const mainInput = document.getElementById('search-input');
            if (mainInput) mainInput.value = '';
            applyFilter();
            refreshDrawerList();
        }

        // ================= 3. 渲染引擎 =================

        function setupGridEventDelegation() {
            if (gridEventsDelegated) return;
            const container = document.getElementById('grid-container');
            if (!container) return;

            // 点击事件委托
            container.addEventListener('click', (e) => {
                const tag = e.target.closest('.mini-tag');
                const actionBtn = e.target.closest('.action-mini');
                const card = e.target.closest('.grid-item');

                // 1. 标签点击
                if (tag) {
                    e.stopPropagation();
                    const tagName = tag.getAttribute('data-tag');
                    if (tagName) filterByTag(e, tagName);
                    return;
                }

                // 2. Admin 操作按钮
                if (actionBtn) {
                    return; // onclick 已在 HTML 中绑定
                }

                // 3. 卡片点击
                if (card) {
                    const nodeId = card.dataset.id;
                    const node = AppState.allNodes.find(n => n.id === nodeId);
                    if (!node) return;

                    if (IS_ADMIN && AppState.pickedId) {
                        if (node.type === 'folder') {
                            enterFolder(node);
                        }
                        return;
                    }

                    if (node.type === 'folder') enterFolder(node);
                    else if (MAERS.CMS.Core && MAERS.CMS.Core.openNote) MAERS.CMS.Core.openNote(node);
                    else if (MAERS.CMS.Editor && MAERS.CMS.Editor.openNote) MAERS.CMS.Editor.openNote(node);
                    else if (MAERS.CMS.Editor && MAERS.CMS.Editor.open) MAERS.CMS.Editor.open(node);
                    return;
                }
            });

            // 右键菜单 (Admin 模式)
            if (IS_ADMIN) {
                container.addEventListener('contextmenu', (e) => {
                    // 1. 如果处于移动状态，右键取消移动
                    if (AppState.pickedId) {
                        e.preventDefault();
                        e.stopPropagation();
                        uiCancelPick();
                        showToast('❌ 移动已取消');
                        return;
                    }
                    
                    // 2. 标签删除
                    const tag = e.target.closest('.mini-tag');
                    if (tag) {
                        e.preventDefault();
                        e.stopPropagation();
                        const tagName = tag.getAttribute('data-tag');
                        const nodeId = tag.getAttribute('data-node-id');
                        if (tagName && nodeId) {
                            uiRemoveTag(e, nodeId, tagName);
                        }
                    }
                });
            }

            gridEventsDelegated = true;
        }

        function renderGrid(list, isSearch = false) {
            const container = document.getElementById('grid-container');
            const taskId = ++currentRenderTask;

            setupGridEventDelegation();

            // Admin 拖拽排序
            if (IS_ADMIN && MAERS.CMS.Drag) {
                MAERS.CMS.Drag.setupContainer(container);
            }

            container.innerHTML = '';

            // 空列表处理
            if (!list || list.length === 0) {
                container.innerHTML = `<div class="empty-tip">${IS_ADMIN ? '<button onclick="MAERS.CMS.View.uiCreateNode(\'note\')">+ Create Note</button>' : 'Empty.'}</div>`;
                return;
            }

            // 预排序
            const sortedList = [...list].sort((a, b) => (a.type === b.type) ? 0 : (a.type === 'folder' ? -1 : 1));

            // 分片渲染
            let index = 0;
            const batchSize = 25;

            function renderBatch() {
                if (taskId !== currentRenderTask || index >= sortedList.length) return;

                const fragment = document.createDocumentFragment();
                const end = Math.min(index + batchSize, sortedList.length);

                for (let i = index; i < end; i++) {
                    const node = sortedList[i];
                    const el = document.createElement('div');
                    el.className = `grid-item type-${node.type}`;
                    el.dataset.id = node.id;

                    if (IS_ADMIN) {
                        el.draggable = true;
                        if (node.id === AppState.pickedId) el.classList.add('is-picked');
                    }

                    // 图标
                    const icon = (MAERS.ModuleConfig)
                        ? MAERS.ModuleConfig.getNodeIcon(node.type)
                        : (node.type === 'folder' ? '📁' : '📝');

                    const escapeHtml = MAERS.Utils.escapeHtml.bind(MAERS.Utils);
                    const escapeAttr = MAERS.Utils.escapeAttr.bind(MAERS.Utils);
                    const jsStr = MAERS.Utils.jsStr.bind(MAERS.Utils);

                    const safeTitle = escapeHtml(node.title);
                    const tagsHtml = (node.tags || []).map(t => {
                        const active = AppState.activeFilters.has(t) ? 'active' : '';
                        const dataAttrs = IS_ADMIN
                            ? `data-tag="${escapeAttr(t)}" data-node-id="${escapeAttr(node.id)}"`
                            : `data-tag="${escapeAttr(t)}"`;
                        return `<span class="mini-tag ${active}" ${dataAttrs}>#${escapeHtml(t)}</span>`;
                    }).join('');

                    const adminActions = IS_ADMIN ? `
                    <div class="card-actions">
                        <div class="action-mini" onclick='MAERS.CMS.View.uiPickNode(event, ${jsStr(node.id)})'>➦</div>
                        <div class="action-mini" onclick='MAERS.CMS.View.uiRenameNode(event, ${jsStr(node.id)}, ${jsStr(node.title)})'>✎</div>
                        <div class="action-mini act-del" onclick='MAERS.CMS.View.uiDeleteNode(event, ${jsStr(node.id)})'>×</div>
                        <div class="action-mini" onclick='MAERS.CMS.View.uiAddTag(event, ${jsStr(node.id)})'>＋</div>
                    </div>` : '';

                    el.innerHTML = `${adminActions}<div class="item-icon">${icon}</div><div class="item-title">${safeTitle}</div><div class="item-tags">${tagsHtml}</div>`;

                    // 拖拽事件
                    if (IS_ADMIN && MAERS.CMS.Drag) {
                        MAERS.CMS.Drag.setupItemDrag(el, node);
                    }

                    fragment.appendChild(el);
                }

                container.appendChild(fragment);
                index += batchSize;

                if (index < sortedList.length) {
                    requestAnimationFrame(renderBatch);
                }
            }

            renderBatch();
        }

        function renderBreadcrumb() {
            const container = document.getElementById('breadcrumb');
            if (!container) return;
            container.innerHTML = '';

            // Root 节点
            const rootSpan = document.createElement('span');
            rootSpan.className = `crumb-item ${AppState.pathStack.length === 1 ? 'active' : ''}`;
            rootSpan.innerText = 'Root';
            rootSpan.onclick = (e) => { e.stopPropagation(); navigateTo(-1); };

            if (IS_ADMIN) bindDragNav(rootSpan, -1);
            container.appendChild(rootSpan);

            for (let i = 1; i < AppState.pathStack.length; i++) {
                const node = AppState.pathStack[i];
                const sep = document.createElement('span');
                sep.className = 'crumb-separator';
                sep.innerText = ' / ';
                container.appendChild(sep);

                const item = document.createElement('span');
                item.className = `crumb-item ${i === AppState.pathStack.length - 1 ? 'active' : ''}`;
                item.innerText = node.title || node;
                item.onclick = (e) => { e.stopPropagation(); navigateTo(i); };

                if (IS_ADMIN) bindDragNav(item, i);
                container.appendChild(item);
            }

            function bindDragNav(el, index) {
                if (MAERS.CMS.Drag) {
                    MAERS.CMS.Drag.bindBreadcrumbDrop(el, index, (idx) => {
                        if (idx === -1) navigateTo(-1); else navigateTo(idx);
                    });
                }
            }
        }

        function navigateTo(index) {
            if (index === -1) {
                AppState.pathStack = ['root'];
                renderGrid(AppState.root);
            } else {
                AppState.pathStack = AppState.pathStack.slice(0, index + 1);
                const target = AppState.pathStack[AppState.pathStack.length - 1];
                renderGrid(target.children);
            }
            renderBreadcrumb();
        }

        function enterFolder(node) {
            AppState.pathStack.push(node);
            renderBreadcrumb();
            renderGrid(node.children);
        }

        function renderPageTitle() {
            const titleEl = document.querySelector('.header-title');
            if (!titleEl) return;

            if (MAERS.ModuleConfig) {
                titleEl.textContent = MAERS.ModuleConfig.getTitle(CONFIG.CURRENT_MODULE);
            } else {
                const iconMap = { notes: '✒️', literature: '📙', record: '📝' };
                const titleMap = { notes: 'Study Notes', literature: 'Literature', record: 'Records' };
                const icon = iconMap[CONFIG.CURRENT_MODULE] || '📂';
                titleEl.textContent = `${icon} ${titleMap[CONFIG.CURRENT_MODULE] || CONFIG.CURRENT_MODULE.toUpperCase()}`;
            }
        }

        // ================= 4. 图片灯箱 =================

        function initLightbox() {
            if (document.getElementById('img-lightbox')) return;
            const lightboxHtml = `
                <div id="img-lightbox" class="lightbox-overlay" onclick="MAERS.CMS.View.closeLightbox()">
                    <button class="lightbox-close">&times;</button>
                    <img id="lightbox-img" class="lightbox-img" src="" onclick="event.stopPropagation()">
                </div>
            `;
            document.body.insertAdjacentHTML('beforeend', lightboxHtml);

            // 点击监听
            document.addEventListener('click', (e) => {
                const target = e.target;

                // Debug log
                // if (target.tagName === 'IMG') {
                //     console.log('[MAERS.LightBox] Detected click on IMG. Src:', target.src);
                // }

                if (target.tagName === 'IMG') {
                    // check if it's a content image (inside main card or immersive editor)
                    // We basically allow any image unless it's explicitly strictly forbidden (which we don't have right now)
                    if (target.closest('.markdown-body') ||
                        target.closest('.immersive-layer') ||
                        target.closest('.main-card') ||
                        target.closest('#vditor-container') ||
                        target.closest('.vditor-content') ||
                        target.closest('.vditor-reset')) {

                        e.preventDefault();
                        e.stopPropagation();
                        showLightbox(target.src);
                        return;
                    }
                }

                // Fallback for Vditor wrappers
                const vditorImgWrapper = target.closest('.vditor-ir__node--preview');
                if (vditorImgWrapper) {
                    const img = vditorImgWrapper.querySelector('img');
                    if (img && (target === vditorImgWrapper || target.contains(img))) {
                        e.preventDefault();
                        e.stopPropagation();
                        showLightbox(img.src);
                    }
                }
            }, true);

            // ESC 键关闭
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') closeLightbox();
            });
        }

        function showLightbox(src) {
            const lb = document.getElementById('img-lightbox');
            const img = document.getElementById('lightbox-img');
            if (lb && img) {
                img.src = src;
                lb.classList.add('active');
                document.body.style.overflow = 'hidden';
            }
        }

        function closeLightbox() {
            const lb = document.getElementById('img-lightbox');
            if (lb) {
                lb.classList.remove('active');
                document.body.style.overflow = '';
                setTimeout(() => {
                    const img = document.getElementById('lightbox-img');
                    if (img) img.src = '';
                }, 300);
            }
        }

        // ================= 导出 API =================


        return {
            init,
            setupSearchListeners,
            applyFilter,
            filterByTag,
            toggleTagDrawer,
            refreshDrawerList,
            selectTagFromDrawer,
            clearTagFilter,
            renderGrid,
            renderBreadcrumb,
            renderPageTitle,
            navigateTo,
            enterFolder,
            showLightbox,
            closeLightbox,
            refreshView,
            // UI Actions
            uiCreateNode, uiRenameNode, uiDeleteNode, uiPickNode, uiCancelPick, uiAddTag, uiRemoveTag
        };
    })();

    // Mount to namespace
    MAERS.CMS.View = CmsView;

})(typeof window !== 'undefined' ? window : this);
