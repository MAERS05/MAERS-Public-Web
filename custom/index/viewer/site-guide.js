/** 首页说明：次要入口停靠在侧栏，点击后查看公开模板的使用说明。 */
(function () {
    function init() {
        if (document.getElementById('site-guide-btn')) return;
        const button = document.createElement('button');
        button.id = 'site-guide-btn';
        button.className = 'site-guide-wrapper app-icon-button';
        button.type = 'button';
        button.title = '使用说明';
        button.setAttribute('aria-label', '使用说明');
        button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3M12 17h.01"/></svg>';
        const modal = document.createElement('dialog');
        modal.className = 'site-guide-dialog';
        modal.setAttribute('aria-label', '使用说明');
        modal.innerHTML = '<button class="site-guide-close app-icon-button" type="button" aria-label="关闭说明" title="关闭说明"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button><div class="site-guide-content"><h2>使用说明</h2><p>从左侧导航或首页入口打开笔记、文学、照片等内容模块。</p><p>公开模板初始内容为空，可从管理入口添加自己的内容。</p><p>部署、存储与同步配置请阅读仓库 README 和开源版本说明。</p></div>';
        (document.querySelector('.app-sidebar-actions') || document.body).append(button);
        document.body.append(modal);
        button.onclick = () => modal.showModal();
        modal.querySelector('button').onclick = () => modal.close();
        modal.addEventListener('close', () => { button.focus(); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
