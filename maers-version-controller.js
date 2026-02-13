/**
 * MAERS Service Worker - Global Cache & Version Controller
 * 
 * 作用：拦截所有网络请求，附加全局版本号，强行穿透 Clouflare/Browser 缓存。
 * 更新方式：
 * 1. 修改 VERSION_CONFIG.default 可更新全站所有默认文件。
 * 2. 在 VERSION_CONFIG.files 中添加特定文件路径和版本号，可单独更新该文件。
 */

const VERSION_CONFIG = {
    // 📅 全局默认版本 (未在下方单独配置的文件都使用此版本)
    default: '2026.0215-0000',

    // 📂 单独文件版本配置 (路径匹配规则: url.pathname.endsWith(key))
    // 示例: 'custom/style.css': 'v2'
    files: {
        // --- 常用数据文件 (取消注释并修改版本号以更新) ---

        // 🏠 首页数据
        // 'data/index-cards.json': 'v1.1',

        // 🎵 音乐数据
        // 'data/music-data.json': 'v1.1',

        // 🖼️ 相册数据 (如果是 .json 格式)
        // 'data/photos-data.json': 'v1.1',

        // 📝 笔记目录
        // 'data/notes-tree.json': 'v1.1',

        // 📅 记录/日记目录
        // 'data/record-tree.json': 'v1.1',

        // 📚 文学/文章目录
        // 'data/literature-tree.json': 'v1.1',

        // 🎮 游戏目录
        // 'data/games-tree.json': 'v1.1',

        // 🌌 空间/项目目录
        // 'data/space-tree.json': 'v1.1',

        // 🎨 样式文件 (如果改了 CSS)
        // 'static-style/style.css': 'v1.1',
    }
};

const CACHE_NAME = `maers-cache-${VERSION_CONFIG.default}`;

// 监听安装事件
self.addEventListener('install', (event) => {
    // 强制跳过等待，立即接管页面
    self.skipWaiting();
});

// 监听激活事件
self.addEventListener('activate', (event) => {
    // 立即接管所有已打开的页面客户端
    event.waitUntil(clients.claim());

    // 清理旧版本的缓存
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    // 只清理旧的默认版本缓存，确保主要版本更新时清理垃圾
                    // 注意：这可能会清理掉旧的 default 版本的缓存，但在新机制下影响不大
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

// 监听所有网络请求
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // 1. 拦截策略优化
    if (url.origin === location.origin) {

        // 排除：
        // - 非 GET 请求 (POST/PUT/DELETE 等通常包含 Body，不应加版本号拦截)
        // - 以 /api/ 开头的 API 请求
        // - 常见的上传/操作接口 (/upload, /delete, /reorder)
        // - Service Worker 自身
        if (event.request.method !== 'GET' ||
            url.pathname.startsWith('/api/') ||
            url.pathname === '/upload' ||
            url.pathname === '/delete' ||
            url.pathname === '/reorder' ||
            url.pathname.includes('sw.js') ||
            url.searchParams.has('maers_ver')) {
            return;
        }

        // 2. 确定版本号
        let version = VERSION_CONFIG.default;

        // 检查是否有特定文件配置
        // 遍历配置的文件列表，如果请求路径以配置的路径结尾，则使用特定版本
        for (const [path, specificVer] of Object.entries(VERSION_CONFIG.files)) {
            if (url.pathname.endsWith(path)) {
                version = specificVer;
                break;
            }
        }

        // 3. 构造带版本号的新请求 (Cache Busting)
        // 这会让 Cloudflare 认为这是一个全新的 URL，从而回源拉取最新文件
        const newUrl = new URL(url.toString());
        newUrl.searchParams.set('maers_ver', version);

        // 4. 实际上我们不需要真的去 Cache API 存取，
        // 只要修改请求 URL 发出去，就能利用浏览器的标准 HTTP 缓存机制（但 URL 变了，所以是新的）
        // 这种策略叫 "Cache Busting via Query String"

        event.respondWith(
            fetch(newUrl, {
                method: event.request.method,
                headers: event.request.headers,
                mode: 'cors',
                credentials: event.request.credentials
            }).catch(() => {
                // 如果网络失败（离线），尝试回退到普通的请求（可能在缓存里）
                return fetch(event.request);
            })
        );
    }
});
