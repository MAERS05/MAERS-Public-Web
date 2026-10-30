/**
 * MAERS Global Configuration (config.js)
 * 全局设置与环境变量
 * @version 1.0.0
 */

window.MAERS = window.MAERS || {};
window.MAERS.Config = {
    // API 基础路径 (仅本地管理模式使用)
    // 线上静态部署时，所有 API 请求均由 IS_ADMIN 拦截，此值不会被触发
    API_BASE: window.location.protocol === 'http:' || window.location.protocol === 'https:'
        ? window.location.origin : '',

    // 公开原图入口；改为空字符串时使用站点内相对路径，存量文件键无需变化。
    MEDIA_PUBLIC_BASE: '',

    // 动画延迟配置 (ms)
    ANIMATION_DELAY: 300,
    HIGHLIGHT_DELAY: 600,
    DEBOUNCE_DELAY: 300
};
