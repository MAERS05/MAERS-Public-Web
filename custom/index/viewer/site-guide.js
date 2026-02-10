/**
 * MAERS Site Guide (site-guide.js)
 * 首页网站引导按钮与视频弹窗逻辑
 */

(function () {
    const init = () => {
        // 1. 防止重复注入
        if (document.querySelector('.site-guide-wrapper')) return;

        // 3. 构建 HTML 结构
        const html = `
        <div class="site-guide-wrapper" id="site-guide-btn">
            网站引导
        </div>
        
        <div class="video-modal" id="video-modal">
            <div class="video-modal-content">
                <span class="video-close">&times;</span>
                <video id="guide-video" controls preload="none">
                    <source src="_说明/site-guide.mp4" type="video/mp4">
                    您的浏览器不支持视频播放。
                </video>
            </div>
        </div>`;

        if (document.body) {
            document.body.insertAdjacentHTML('afterbegin', html);
        } else {
            console.error('[MAERS] document.body is not available for site-guide injection.');
            return;
        }

        // 4. 事件绑定
        const btn = document.getElementById('site-guide-btn');
        const modal = document.getElementById('video-modal');
        const closeBtn = document.querySelector('.video-close');
        const video = document.getElementById('guide-video');

        if (btn) {
            btn.addEventListener('click', () => {
                modal.style.display = 'flex';
                if (video) {
                    video.currentTime = 0;
                    video.play();
                }
            });
        }

        const closeModal = () => {
            modal.style.display = 'none';
            if (video) {
                video.pause();
            }
        };

        if (closeBtn) {
            closeBtn.addEventListener('click', closeModal);
        }

        window.addEventListener('click', (event) => {
            if (event.target === modal) {
                closeModal();
            }
        });

        // ESC 键退出同步
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') {
                closeModal();
            }
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
