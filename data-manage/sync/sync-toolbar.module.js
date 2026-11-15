/** 同步顶栏展示：模式入口、云端草稿与本地 Git 数量，状态仍由同步门面持有。 */

export function injectSyncControl(manager, targetContainer) {
    if (!targetContainer || document.getElementById('maers-sync-btn')) return;

    // 模式、同步与 发布更新共用一个设置入口
    const btn = document.createElement('button');
    btn.id = 'maers-sync-btn';
    btn.className = 'maers-toolbar-btn';
    btn.onclick = (e) => {
        e.stopPropagation();
        manager.openSettingsModal();
    };

    targetContainer.insertBefore(btn, targetContainer.firstChild);
    manager.updateButtonBadge();

    // 启动时异步检测状态与草稿
    setTimeout(() => {
        manager.checkPendingRelayItems();
    }, 1200);
}

export function syncControlLabel(manager) {
    const count = manager.pendingItemsCount;
    const unavailable = count === null;
    if (!manager.isLocalHost()) {
        return unavailable ? '草稿读取失败' : count > 0 ? `云端草稿(${count})` : '云端模式';
    }
    const parts = [];
    if (unavailable) parts.push('草稿读取失败');
    else if (count > 0) parts.push(`待合并(${count})`);
    if (manager.pendingGitCount > 0) parts.push(`待发布(${manager.pendingGitCount})`);
    return parts.length ? parts.join(' · ') : '本地模式';
}

export function updateSyncModalBadge(manager) {
    const modal = document.getElementById('maers-sync-modal');
    if (!modal) return;
    const count = manager.pendingItemsCount ?? '读取失败';
    const gitTitle = modal.querySelector('[data-role="git-count-title"]');
    if (gitTitle) gitTitle.textContent = manager.isLocalHost()
        ? `发布更新(${manager.pendingGitCount})`
        : `待电脑合并草稿(${count})`;
    const pullBtn = modal.querySelector('#btn-manual-pull');
    if (pullBtn) pullBtn.textContent = `拉取合并 (${count})`;
}

export function updateSyncToolbarButton(manager) {
    const btn = document.getElementById('maers-sync-btn');
    if (!btn) return;

    btn.classList.remove('maers-toolbar-btn--sync-local', 'maers-toolbar-btn--sync-relay', 'maers-toolbar-btn--sync-pending');
    btn.textContent = manager.getButtonLabel();

    if (manager.isLocalHost()) {
        btn.title = manager.pendingItemsCount > 0
            ? `有 ${manager.pendingItemsCount} 条云端草稿待合并；打开同步与发布`
            : '打开同步与发布';
        btn.classList.add(manager.pendingGitCount > 0 || manager.pendingItemsCount > 0
            ? 'maers-toolbar-btn--sync-pending' : 'maers-toolbar-btn--sync-local');
    } else {
        btn.title = '查看云端草稿与同步设置；草稿需在电脑本地后台拉取合并并发布后生效';
        btn.classList.add('maers-toolbar-btn--sync-relay');
    }
}
