/**
 * MAERS Album Admin (album-admin.module.js)
 * 相册分类管理逻辑 - Unified Batch Logic
 * 依赖: AdminCore
 * @version 3.0.0 - ES6 Module
 */

// Import Config
import '../viewer/album-config.module.js';

// 依赖声明
let AdminCore;

// 依赖注入
export function initAlbumAdmin(adminCore) {
    AdminCore = adminCore;
}

const grid = document.getElementById('category-grid');
// We ignore the static save-btn in DOM, using AdminCore.SaveButton
let currentData = [];
let manager = null;

async function init() {
    if (!grid) return;

    await loadData();

    // Init Manager
    if (!AdminCore?.BatchItemManager) {
        console.error('AdminCore.BatchItemManager not found!');
        return;
    }

    manager = new AdminCore.BatchItemManager({
        list: currentData,
        onUpdate: render,
        onChange: () => AdminCore?.SaveButton?.show()
    });

    // Init Save Button
    if (AdminCore?.SaveButton) {
        AdminCore.SaveButton.init(
            document.body,
            handleSave,
            async () => {
                // On Cancel: Reset to initial snapshot
                if (manager) {
                    manager.reset();
                    if (AdminCore.Feedback) AdminCore.Feedback.notifyCancel();
                }
            }
        );
    }

    render();
}

async function loadData() {
    if (!grid) return;
    try {
        const res = await fetch(`custom/album/admin/album-config.json?v=${Date.now()}`);
        let initialData = [];
        if (res.ok) initialData = await res.json();
        else initialData = (window.CATEGORY_CONFIG) ? JSON.parse(JSON.stringify(window.CATEGORY_CONFIG)) : [];

        // Deep copy for editing
        currentData = JSON.parse(JSON.stringify(initialData));

        // If manager exists, update its list reference
        if (manager) manager.setList(currentData);

    } catch (e) {
        console.error("Load failed", e);
        if (window.MAERS?.Toast) window.MAERS.Toast.error("❌ 数据加载失败");
    }
}

async function handleSave() {
    try {
        const btn = document.getElementById('global-save-btn');
        if (btn) btn.textContent = 'Saving...';

        // 1. Delete Items marked as _deleted
        const toDelete = currentData.filter(c => c._deleted);
        for (let item of toDelete) {
            await fetch('/api/delete_category', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: item.id })
            });
        }

        // 2. Reorder remaining
        const remaining = currentData.filter(c => !c._deleted);
        const idList = remaining.map(c => c.id);
        await fetch('/api/reorder_category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(idList)
        });

        // 3. Reload
        await loadData();
        render(); // Trigger view update

        // Hide SaveBar
        if (AdminCore?.SaveButton) AdminCore.SaveButton.hide();

        if (AdminCore.Feedback) AdminCore.Feedback.notifySaveSuccess();
    } catch (e) {
        console.error(e);
        if (AdminCore.Feedback) AdminCore.Feedback.notifySaveFail();
        else alert("保存失败");
    }
}

function render() {
    if (!grid) return;
    grid.innerHTML = '';



    currentData.forEach((cat, index) => {
        const card = document.createElement('div');
        // Get classes from manager
        const extraClasses = manager ? manager.getItemClass(index) : '';
        card.className = `category-card ${cat.style_class || ''} ${extraClasses}`;

        // 添加序号属性
        if (manager && manager.selectedIndices.includes(index)) {
            const orderNum = manager.selectedIndices.indexOf(index) + 1;
            card.setAttribute('data-order-num', orderNum);
        }

        card.onclick = (e) => {
            if (e.target.closest('.action-btn')) return;

            if (manager && manager.selectedIndices.length > 0) {
                if (manager.selectedIndices.includes(index)) {
                    manager.toggleSelect(index);
                } else {
                    manager.moveTo(index);
                }
                return;
            }

            if (cat._deleted) return;
            window.location.href = `admin-photos.html?id=${cat.id}`;
        };

        // Build card content using DOM API
        const bg = document.createElement('div');
        bg.className = 'card-bg-glow';
        card.appendChild(bg);

        // Admin Buttons
        if (AdminCore?.AdminButtonHelper) {
            const adminEl = AdminCore.AdminButtonHelper.render({
                index: index,
                isDeleted: cat._deleted,
                onSort: (e) => uiToggleSelect(e, index),
                onEdit: (e) => uiEdit(e, index, cat.title, cat.subtitle, cat.icon),
                onDelete: (e) => uiToggleDelete(e, index),
                extraClass: '',
                containerClass: 'admin-actions'
            });
            card.appendChild(adminEl);
        }

        // Icon
        const iconDiv = document.createElement('div');
        iconDiv.className = 'card-icon';
        iconDiv.innerHTML = cat.icon;
        card.appendChild(iconDiv);

        // Text Group
        const textGroup = document.createElement('div');
        textGroup.className = 'text-group';

        const titleDiv = document.createElement('div');
        titleDiv.className = 'card-title';
        titleDiv.textContent = cat.title;

        const subDiv = document.createElement('div');
        subDiv.className = 'card-subtitle';
        subDiv.textContent = cat.subtitle;

        textGroup.appendChild(titleDiv);
        textGroup.appendChild(subDiv);
        card.appendChild(textGroup);



        grid.appendChild(card);
    });

    const addBtn = document.createElement('div');
    addBtn.className = 'category-card func-card';
    addBtn.onclick = addNewCategory;
    addBtn.innerHTML = `<div class="func-icon">＋</div><div class="func-text">ADD NEW CATEGORY</div>`;
    grid.appendChild(addBtn);
}

// UI Bridges
export function uiToggleSelect(e, index) {
    e.stopPropagation();
    if (manager) manager.toggleSelect(index);
}

export function uiToggleDelete(e, index) {
    e.stopPropagation();
    if (manager) manager.toggleDelete(index);
}

export function uiEdit(e, index, oldTitle, oldSub, oldIcon) {
    e.stopPropagation();
    if (manager.isDeleted(index)) return;

    const item = currentData[index];

    // 1. Title
    const title = prompt("修改标题:", oldTitle);
    if (title === null) return;

    // 2. Subtitle
    const subtitle = prompt("修改副标题:", oldSub);
    if (subtitle === null) return;

    // 3. Icon
    const icon = prompt("修改图标 (输入 SVG 路径，例如 ui/album-nature.svg) 或 Emoji:", oldIcon.includes('src=') ? _extractSrc(oldIcon) : oldIcon);
    if (icon === null) return;

    let changed = false;
    if (title !== oldTitle) { item.title = title; changed = true; }
    if (subtitle !== oldSub) { item.subtitle = subtitle; changed = true; }

    // Icon logic
    if (icon !== (oldIcon.includes('src=') ? _extractSrc(oldIcon) : oldIcon)) {
        if ((icon.includes('/') || icon.includes('.')) && !icon.trim().startsWith('<')) {
            item.icon = `<img src="${icon}" style="width: 1em; height: 1em;">`;
        } else {
            item.icon = icon;
        }
        changed = true;
    }

    if (changed) {
        render();
        AdminCore?.SaveButton?.show();
    }
}

function _extractSrc(html) {
    const match = html.match(/src=['"]([^'"]+)['"]/);
    return match ? match[1] : html;
}

export async function addNewCategory() {
    const title = prompt("分类标题 (中文):");
    if (title === null) return;

    const subtitle = prompt("副标题 (英文):");
    if (subtitle === null) return;

    const iconInput = prompt("图标 (输入 SVG 路径，例如 ui/album-new.svg) 或 Emoji:");
    if (iconInput === null) return;

    const id = prompt("分类ID (英文小写,不可修改):");
    if (id === null) return;

    let finalIcon = iconInput;
    if (finalIcon && (finalIcon.includes('/') || finalIcon.includes('.')) && !finalIcon.trim().startsWith('<')) {
        finalIcon = `<img src="${finalIcon}" style="width: 1em; height: 1em;">`;
    }

    if (title && id) {
        try {
            const res = await fetch('/api/add_category', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, subtitle, icon: finalIcon, id })
            });
            if (res.ok) {
                await loadData();
                render(); // Trigger view update

                // Hide SaveBar (just in case)
                if (AdminCore?.SaveButton) AdminCore.SaveButton.hide();

                if (AdminCore.Feedback) AdminCore.Feedback.notifyAddSuccess();
            } else {
                if (AdminCore.Feedback) AdminCore.Feedback.notifyAddFail();
                else alert("添加失败");
            }
        } catch (e) {
            if (AdminCore.Feedback) AdminCore.Feedback.notifyError("Error: " + e.message);
            else alert("Error: " + e.message);
        }
    }
}

// 导出 Admin 对象（向后兼容）
export const AlbumAdmin = {
    init,
    uiToggleSelect,
    uiToggleDelete,
    uiEdit,
    addNewCategory
};

// Initialize
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
