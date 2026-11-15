/** 首页：清晰的公开内容入口，不显示尚未解锁的私密项。 */
import { initLayout } from '../../../shared/layout.module.js';
import { initTheme } from '../../../shared/theme.module.js';
import { getNavData, navigationInfo } from '../../../shared/spatial-nav.module.js';
import { initWhatsNew } from '../../../shared/whats-new.module.js';
import { isEncryptedRecord } from '../../../data-manage/encrypt/crypto.module.js';
import { revealInPlace } from '../../../data-manage/encrypt/secret-unlock.module.js';
import { icon } from '../../../shared/icons.module.js';
import { Utils } from '../../../shared/utils.module.js';
initLayout();
initTheme();
initWhatsNew();

async function renderHome() {
    const grid = document.querySelector('.nav-grid');
    if (!grid) return;
    try {
        const data = await getNavData();
        await revealInPlace(data);
        grid.replaceChildren();
        for (const item of data.filter(item => !isEncryptedRecord(item))) {
            const info = navigationInfo(item);
            const card = document.createElement('a');
            card.className = 'nav-card';
            card.id = item.id;
            card.href = item.url;
            card.innerHTML = '<span class="card-icon">' + icon(info.icon, 24) +
                '</span><span class="card-copy"><span class="card-title">' + Utils.escapeHtml(info.title) +
                '</span><span class="card-desc">' + Utils.escapeHtml(info.description) +
                '</span></span><span class="card-arrow">' + icon('forward', 18) + '</span>';
            grid.append(card);
        }
        if (!grid.children.length) grid.innerHTML = '<p class="home-empty">这里还没有公开内容。</p>';
    } catch (error) {
        console.error('[MAERS.Home] 导航读取失败：', error);
        grid.innerHTML = '<p class="home-empty">暂时无法读取内容，请稍后刷新。</p>';
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderHome);
else renderHome();
