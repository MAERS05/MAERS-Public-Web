/**
 * MAERS Photos Mobile Adaptation
 * 适配移动端灯箱(Lightbox)触摸事件，将触摸滑动转换为滚轮事件，以驱动 PC 端的图库切换逻辑
 */
(function () {
    let touchStartX = null;
    let touchStartY = null;
    const LIGHTBOX_SELECTOR = '#lightbox';

    // 监听全局 touchstart，但只处理灯箱激活状态下的事件
    document.addEventListener('touchstart', (e) => {
        const lightbox = document.getElementById('lightbox');
        // 只有当灯箱存在且激活时才处理
        if (!lightbox || !lightbox.classList.contains('active')) return;

        // 确保触摸在灯箱范围内
        if (!e.target.closest(LIGHTBOX_SELECTOR)) return;

        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: false });

    document.addEventListener('touchmove', (e) => {
        const lightbox = document.getElementById('lightbox');
        if (!lightbox || !lightbox.classList.contains('active')) return;
        if (touchStartX === null) return;

        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;

        const deltaX = x - touchStartX;
        const deltaY = y - touchStartY;

        // 我们只关心明显的水平滑动，且水平位移明显大于垂直位移
        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 30) {
            if (e.cancelable) e.preventDefault(); // 阻止浏览器翻页或滚动（仅当事件可取消时）

            // 映射逻辑:
            // 左滑 (deltaX < 0) -> 下一张 -> 对应 Wheel deltaY > 0
            // 右滑 (deltaX > 0) -> 上一张 -> 对应 Wheel deltaY < 0
            const wheelDelta = -deltaX;

            // 将事件派发给 lightbox 元素，因为 photos-view.module.js 监听的是 lb 的 wheel 事件
            const wheelEvent = new WheelEvent('wheel', {
                deltaY: wheelDelta,
                bubbles: true,
                cancelable: true,
                view: window
            });

            lightbox.dispatchEvent(wheelEvent);

            // 重置以避免一次滑动触发多次切换 (因为原有逻辑有 throttle 保护，这里可以稍微放松，但为了更明确的一次一手势，最好重置)
            // 不过考虑到原生 wheel 也是连续的，我们重置 touchStartX 相当于要求用户"抬起重滑"或者"停顿后重滑"
            // 实际上 photos-view.js 内部有 250ms 的 throttle，所以这里连续触发问题不大，
            // 但为了避免一次长滑动触发几十次，还是重置一下比较稳妥，模仿"一页一页翻"的感觉
            touchStartX = null;
            touchStartY = null;
        }
    }, { passive: false });

    document.addEventListener('touchend', () => {
        touchStartX = null;
        touchStartY = null;
    });

    console.log('[Mobile Adaptation] Photos lightbox touch events initialized.');
})();
