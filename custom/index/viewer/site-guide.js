/** 网站引导：开源版本的通用使用入口，不包含原作者操作录屏。 */
(function () {
    const init = () => {
        if (document.getElementById('site-guide-btn')) return;
        document.body.insertAdjacentHTML('afterbegin', `
            <div class="site-guide-wrapper" id="site-guide-btn">网站引导 ·</div>
            <div class="video-modal" id="video-modal">
                <div class="video-modal-content">
                    <span class="video-close">&times;</span>
                    <div style="padding: 36px; color: var(--text-main); background: var(--bg-base);">
                        <h2>使用说明</h2>
                        <p>首页卡片进入对应内容模块；开源版本初始内容为空。</p>
                        <p>部署与使用请阅读仓库 README。</p>
                    </div>
                </div>
            </div>`);
        const modal = document.getElementById('video-modal');
        const close = () => { modal.style.display = 'none'; };
        document.getElementById('site-guide-btn').onclick = () => { modal.style.display = 'flex'; };
        modal.querySelector('.video-close').onclick = close;
        modal.onclick = event => { if (event.target === modal) close(); };
        window.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
