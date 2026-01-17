/**
 * MAERS Album Admin (album-admin.js)
 * 相册分类管理逻辑
 * 依赖: MAERS.Toast
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.Album = MAERS.Album || {};

    const grid = document.getElementById('category-grid');
    const saveBtn = document.getElementById('save-order-btn');
    let initialData = [];
    let currentData = [];
    let pickedIndex = null;

    document.addEventListener('contextmenu', (e) => {
        if (pickedIndex !== null) {
            e.preventDefault();
            pickedIndex = null;
            document.body.classList.remove('is-reordering');
            render();
        }
    });

    async function init() {
        await loadData();
        render();
    }

    async function loadData() {
        try {
            const res = await fetch(`dynamic-style/album-config.json?v=${Date.now()}`);
            if (res.ok) initialData = await res.json();
            else initialData = (typeof CATEGORY_CONFIG !== 'undefined') ? JSON.parse(JSON.stringify(CATEGORY_CONFIG)) : [];
            currentData = JSON.parse(JSON.stringify(initialData));
            checkChanges();
        } catch (e) { console.error("Load failed", e); }
    }

    function checkChanges() {
        const hasDeleted = currentData.some(item => item._deleted);
        const currentIds = currentData.map(c => c.id).join(',');
        const initialIds = initialData.map(c => c.id).join(',');
        const hasChanges = hasDeleted || (currentIds !== initialIds);
        if (hasChanges) {
            saveBtn.style.display = 'flex';
            saveBtn.classList.add('has-changes');
        } else {
            saveBtn.style.display = 'none';
            saveBtn.classList.remove('has-changes');
        }
    }

    function render() {
        grid.innerHTML = '';
        currentData.forEach((cat, index) => {
            const card = document.createElement('div');
            card.className = `category-card ${cat.style_class || ''}`;
            if (pickedIndex === index) card.classList.add('is-picked');
            if (cat._deleted) card.classList.add('pending-delete');
            card.onclick = (e) => {
                if (pickedIndex !== null) {
                    if (pickedIndex === index) { pickedIndex = null; document.body.classList.remove('is-reordering'); }
                    else { handleMove(pickedIndex, index); }
                    render();
                    return;
                }
                if (cat._deleted) return;
                if (e.target.closest('.action-btn')) return;
                window.location.href = `admin-photos.html?id=${cat.id}`;
            };
            const safeTitle = cat.title.replace(/'/g, "\\'");
            const safeSub = cat.subtitle.replace(/'/g, "\\'");
            const safeIcon = cat.icon.replace(/'/g, "\\'");
            card.innerHTML = `
                <div class="card-bg-glow"></div>
                <div class="admin-actions">
                    <div class="action-btn btn-move" title="点击选中，再点击另一卡片即可交换位置" onclick="MAERS.Album.Admin.startMove(event, ${index})">≡</div>
                    <div class="action-btn btn-edit" title="编辑" onclick="MAERS.Album.Admin.editCategory(event, ${index}, '${safeTitle}', '${safeSub}', '${safeIcon}')">✎</div>
                    <div class="action-btn btn-del" title="${cat._deleted ? '撤销删除' : '删除'}" onclick="MAERS.Album.Admin.toggleDelete(event, ${index})">🗑</div>
                </div>
                <div class="card-icon">${cat.icon}</div>
                <div class="text-group">
                    <div class="card-title">${cat.title}</div>
                    <div class="card-subtitle">${cat.subtitle}</div>
                </div>
            `;
            grid.appendChild(card);
        });
        const addBtn = document.createElement('div');
        addBtn.className = 'category-card func-card';
        addBtn.onclick = addNewCategory;
        addBtn.innerHTML = `<div class="func-icon">＋</div><div class="func-text">ADD NEW CATEGORY</div>`;
        grid.appendChild(addBtn);
    }

    function startMove(e, index) {
        e.stopPropagation();
        pickedIndex = index;
        document.body.classList.add('is-reordering');
        render();
    }

    function handleMove(fromIdx, toIdx) {
        if (currentData[toIdx]._deleted) return;
        const item = currentData.splice(fromIdx, 1)[0];
        currentData.splice(toIdx, 0, item);
        pickedIndex = null;
        document.body.classList.remove('is-reordering');
        checkChanges();
    }

    function toggleDelete(e, index) {
        e.stopPropagation();
        if (pickedIndex !== null) return;
        currentData[index]._deleted = !currentData[index]._deleted;
        render();
        checkChanges();
    }

    function editCategory(e, index, oldTitle, oldSub, oldIcon) {
        e.stopPropagation();
        if (pickedIndex !== null) return;
        const item = currentData[index];
        const title = prompt("修改标题:", oldTitle); if (title === null) return;
        const subtitle = prompt("修改副标题:", oldSub); if (subtitle === null) return;
        const icon = prompt("修改图标:", oldIcon); if (icon === null) return;
        fetch('/api/update_category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id, title, subtitle, icon })
        }).then(res => { if (res.ok) { loadData(); render(); } });
    }

    if (saveBtn) {
        saveBtn.onclick = async () => {
            const originalText = saveBtn.innerText;
            saveBtn.innerText = "⏳";
            try {
                const toDelete = currentData.filter(c => c._deleted);
                for (let item of toDelete) {
                    await fetch('/api/delete_category', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: item.id })
                    });
                }
                const remaining = currentData.filter(c => !c._deleted);
                const idList = remaining.map(c => c.id);
                await fetch('/api/reorder_category', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(idList)
                });
                alert("✅ 所有更改已保存");
                await loadData(); render();
            } catch (e) { console.error(e); alert("❌ 保存失败"); }
            finally { saveBtn.innerText = originalText; }
        };
    }

    async function addNewCategory() {
        const title = prompt("分类标题 (中文):"); if (!title) return;
        const subtitle = prompt("副标题 (英文):");
        const icon = prompt("图标 (Emoji):");
        const id = prompt("分类ID (英文小写,不可修改):");
        if (title && id) {
            try {
                const res = await fetch('/api/add_category', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, subtitle, icon, id })
                });
                if (res.ok) {
                    await loadData();
                    render();
                    MAERS.Toast && MAERS.Toast.success("✅ 添加成功");
                } else {
                    MAERS.Toast && MAERS.Toast.error("❌ 添加失败");
                }
            } catch (e) { MAERS.Toast && MAERS.Toast.error("网络错误: " + e.message); }
        }
    }

    // Mount to namespace
    MAERS.Album.Admin = {
        init,
        loadData,
        render,
        startMove,
        handleMove,
        toggleDelete,
        editCategory,
        addNewCategory
    };

    // Initialize
    init();

})(typeof window !== 'undefined' ? window : this);
