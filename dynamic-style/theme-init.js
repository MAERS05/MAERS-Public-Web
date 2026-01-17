(function () {
    // 🔥 防止白色闪烁 (FOUC) - 立即应用背景色
    try {
        var isDark = true; // 默认深色
        var savedTheme = localStorage.getItem('theme');
        var config = JSON.parse(localStorage.getItem('autoThemeConfig')) || { enabled: false };

        if (config.enabled) {
            var now = new Date();
            var mins = now.getHours() * 60 + now.getMinutes();
            var d = (config.dayTime || "07:00").split(':');
            var n = (config.nightTime || "19:00").split(':');
            var s = parseInt(d[0]) * 60 + parseInt(d[1]);
            var e = parseInt(n[0]) * 60 + parseInt(n[1]);
            if (mins >= s && mins < e) isDark = false;
        } else if (savedTheme === 'light-mode') {
            isDark = false;
        } else if (!savedTheme && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
            isDark = false;
        }

        // 立即应用背景色样式 (阻塞式内联)
        var bgColor = isDark ? '#0a0a0a' : '#ffffff';
        var textColor = isDark ? '#e0e0e0' : '#1a1a1a';
        document.documentElement.style.backgroundColor = bgColor;
        document.documentElement.style.color = textColor;

        // 应用主题类
        if (!isDark) document.documentElement.classList.add('light-mode');

    } catch (e) {
        // 失败时使用默认深色
        document.documentElement.style.backgroundColor = '#0a0a0a';
        document.documentElement.style.color = '#e0e0e0';
    }

    // 1. 恢复缩放状态
    try {
        if (localStorage.getItem('globalZoomState') === 'true') {
            document.documentElement.classList.add('shrink-view');
        }
    } catch (e) { }

    try {
        // 检测页面是否已经有图标了，如果没有才添加
        if (!document.querySelector("link[rel*='icon']")) {
            var link = document.createElement('link');
            link.type = 'image/svg+xml';
            link.rel = 'icon';

            // 👇 重点：把您的图标路径写在这里
            // 建议直接用文件路径，比那一长串乱码更干净、且能被浏览器缓存
            link.href = 'ui/icon.svg';

            // 如果您非要用那串 Base64 乱码，就取消下面这行的注释，把乱码填进去：
            // link.href = 'data:image/svg+xml;base64,PHN2Zy...这里填那一堆乱码...';

            document.getElementsByTagName('head')[0].appendChild(link);
        }
    } catch (e) { }
})();
