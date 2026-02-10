/**
 * @module custom/cms/admin/tag-interactions.module.js
 * @description 标签交互模块 - 右键菜单（重命名、删除、排序）
 */

// 注入样式
if (!document.getElementById('tag-interactions-styles')) {
    const style = document.createElement('style');
    style.id = 'tag-interactions-styles';
    style.textContent = `
        .tag-context-menu { animation: menuFadeIn 0.15s ease-out; }
        @keyframes menuFadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        .tag-menu-option { padding: 8px 16px; cursor: pointer; font-size: 0.9rem; color: var(--text-main); transition: background 0.2s; user-select: none; }
        .tag-menu-option:hover { background: rgba(255, 255, 255, 0.1); }
        .tag-menu-option.delete-option { color: #ff6b6b; }
        .tag-menu-option.delete-option:hover { background: rgba(255, 107, 107, 0.1); }
        .mini-tag.reorder-source, .space-tag.reorder-source, .photo-tag-chip.reorder-source { outline: 2px solid #78ffd6; outline-offset: 2px; }
        .mini-tag.reorder-target, .space-tag.reorder-target, .photo-tag-chip.reorder-target { cursor: pointer; opacity: 0.7; }
        .mini-tag.reorder-target:hover, .space-tag.reorder-target:hover, .photo-tag-chip.reorder-target:hover { background: rgba(120, 255, 214, 0.2); }
        .light-mode .tag-context-menu { background: #fff; border-color: rgba(0,0,0,0.1); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
        .light-mode .tag-menu-option:hover { background: rgba(0,0,0,0.05); }
    `;
    document.head.appendChild(style);
}

// 排序状态
let reorderMode = { active: false, sourceTag: null, sourceIndex: null, tagsContainer: null, getTags: null, onTagsUpdate: null };
let cancelReorderListener = null;

export function setupTagDragAndMenu({ tagsContainer, getTags, onTagsUpdate }) {
    if (!tagsContainer || tagsContainer._tagInteractionsSetup) return;
    tagsContainer._tagInteractionsSetup = true;

    // Use Capture Phase to intercept events before other handlers (e.g. filter onclick)

    // Context Menu
    tagsContainer.addEventListener('contextmenu', (e) => {
        const tagEl = e.target.closest('.mini-tag, .space-tag, .photo-tag-chip');
        if (!tagEl) return;

        e.preventDefault();
        e.stopPropagation();
        const allTags = Array.from(tagsContainer.querySelectorAll('.mini-tag, .space-tag, .photo-tag-chip'));
        showContextMenu(e, tagEl.textContent.trim().replace(/^#/, ''), allTags.indexOf(tagEl), tagEl, tagsContainer, getTags, onTagsUpdate);
    }, true);

    // Click (Reorder)
    tagsContainer.addEventListener('click', (e) => {
        const tagEl = e.target.closest('.mini-tag, .space-tag, .photo-tag-chip');
        if (!tagEl) return;

        if (reorderMode.active && tagEl !== reorderMode.sourceTag) {
            if (reorderMode.tagsContainer !== tagsContainer) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const allTags = Array.from(tagsContainer.querySelectorAll('.mini-tag, .space-tag, .photo-tag-chip'));
            handleReorder(tagEl, allTags.indexOf(tagEl));
        }
    }, true);
}

function showContextMenu(e, tagText, tagIndex, tagEl, tagsContainer, getTags, onTagsUpdate) {
    document.querySelector('.tag-context-menu')?.remove();

    const menu = document.createElement('div');
    menu.className = 'tag-context-menu';
    menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;background:var(--pill-bg);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:4px 0;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:10000;min-width:120px;`;

    // 重命名
    const rename = document.createElement('div');
    rename.className = 'tag-menu-option';
    rename.textContent = '✎ 重命名';
    rename.onclick = async () => {
        menu.remove();
        const newName = prompt(`重命名标签 "${tagText}":`, tagText);
        if (newName?.trim() && newName.trim() !== tagText) {
            const tags = [...getTags()];
            tags[tagIndex] = newName.trim();
            if (await onTagsUpdate(tags)) {
                tagEl.textContent = (tagEl.textContent.startsWith('#') ? '#' : '') + newName.trim();
            }
        }
    };

    // 排序
    const reorder = document.createElement('div');
    reorder.className = 'tag-menu-option';
    reorder.textContent = '⇅ 排序';
    reorder.onclick = () => {
        menu.remove();
        startReorder(tagEl, tagIndex, tagsContainer, getTags, onTagsUpdate);
    };

    // 删除
    const del = document.createElement('div');
    del.className = 'tag-menu-option delete-option';
    del.textContent = '✕ 删除';
    del.onclick = async () => {
        menu.remove();
        if (confirm(`删除标签 #${tagText}?`)) {
            await onTagsUpdate(getTags().filter((_, i) => i !== tagIndex));
            tagEl.remove();
        }
    };

    menu.append(rename, reorder, del);
    document.body.appendChild(menu);

    setTimeout(() => document.addEventListener('click', function close() {
        menu.remove();
        document.removeEventListener('click', close);
    }), 100);
}

function startReorder(sourceTag, sourceIndex, tagsContainer, getTags, onTagsUpdate) {
    if (cancelReorderListener) {
        document.removeEventListener('click', cancelReorderListener);
        cancelReorderListener = null;
    }

    reorderMode = { active: true, sourceTag, sourceIndex, tagsContainer, getTags, onTagsUpdate };
    sourceTag.classList.add('reorder-source');

    tagsContainer.querySelectorAll('.mini-tag, .space-tag, .photo-tag-chip').forEach(tag => {
        if (tag !== sourceTag) tag.classList.add('reorder-target');
    });

    setTimeout(() => {
        cancelReorderListener = cancelReorder;
        document.addEventListener('click', cancelReorderListener);
    }, 100);
}

async function handleReorder(targetTag, targetIndex) {
    const { sourceIndex, tagsContainer, getTags, onTagsUpdate } = reorderMode;
    const tags = [...getTags()];
    const [moved] = tags.splice(sourceIndex, 1);
    tags.splice(targetIndex > sourceIndex ? targetIndex : targetIndex + 1, 0, moved);

    if (await onTagsUpdate(tags)) {
        const allTags = tagsContainer.querySelectorAll('.mini-tag, .space-tag, .photo-tag-chip');
        allTags.forEach((tag, i) => {
            tag.textContent = (tag.textContent.startsWith('#') ? '#' : '') + tags[i];
        });
    }
    cancelReorder();
}

function cancelReorder() {
    if (!reorderMode.active) return;
    if (cancelReorderListener) {
        document.removeEventListener('click', cancelReorderListener);
        cancelReorderListener = null;
    }
    reorderMode.sourceTag?.classList.remove('reorder-source');
    reorderMode.tagsContainer?.querySelectorAll('.mini-tag, .space-tag, .photo-tag-chip').forEach(t => t.classList.remove('reorder-target'));
    reorderMode = { active: false, sourceTag: null, sourceIndex: null, tagsContainer: null, getTags: null, onTagsUpdate: null };
}
