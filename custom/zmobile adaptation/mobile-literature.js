/**
 * MAERS Literature Mobile Adaptation
 * 适配移动端触摸事件，将触摸滑动转换为滚轮事件，以驱动 FlowEngine
 */
(function () {
    let touchStartX = null;
    let touchStartY = null;
    const TARGET_SELECTOR = '#viewport'; // 必须匹配 FlowEngine 监听的容器 ID

    // 监听全局 touchstart，但只处理目标元素内的
    document.addEventListener('touchstart', (e) => {
        const target = e.target.closest(TARGET_SELECTOR);
        if (!target) return;

        // 如果是网格模式 (Grid Mode)，交由原生滚动处理，不拦截
        if (target.classList.contains('grid-mode')) return;

        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: false });

    document.addEventListener('touchmove', (e) => {
        if (touchStartX === null) return;

        const target = e.target.closest(TARGET_SELECTOR);
        if (!target) return;
        if (target.classList.contains('grid-mode')) return;

        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;

        const deltaX = x - touchStartX;
        const deltaY = y - touchStartY;

        // 主要是水平滑动 logic
        // 阈值设为 5px 以避免过度敏感
        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 5) {
            // 阻止浏览器默认的左右滑动翻页或滚动行为
            e.preventDefault();

            // 构造合成的 WheelEvent
            // 逻辑映射: 手指向左滑 (deltaX < 0) => 想要看右侧内容 => 相当于鼠标滚轮向下 (deltaY > 0)
            // 增加系数增强移动端灵敏度
            const wheelDelta = -deltaX * 2.0;

            const wheelEvent = new WheelEvent('wheel', {
                deltaY: wheelDelta,
                bubbles: true,      // 必须冒泡才能被 viewport 捕获
                cancelable: true,
                view: window
            });

            // 分发事件给目标 (通常是 viewport 或其子元素)
            target.dispatchEvent(wheelEvent);

            // 更新坐标以实现连续滑动
            touchStartX = x;
            touchStartY = y;
        }
    }, { passive: false });

    document.addEventListener('touchend', () => {
        touchStartX = null;
        touchStartY = null;
    });

    console.log('[Mobile Adaptation] Literature touch events initialized.');
})();
