/**
 * MAERS Service Worker - Global Cache & Version Controller
 * 
 * 作用：拦截所有网络请求，附加全局版本号，强行穿透 Clouflare/Browser 缓存。
 * 更新方式：每次发布新版本前，更新下方的 VERSION 常量即可。
 */

const VERSION = '2026.02.03-2326'; // 📅 修改此处触发全站更新
const CACHE_NAME = `maers-cache-${VERSION}`;

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

    // 1. 只拦截同源请求 (本站的 JS, CSS, JSON, HTML)
    if (url.origin === location.origin) {

        // 排除 API 请求、sw.js 自身、以及已经带有版本号的请求
        if (url.pathname.startsWith('/api/') ||
            url.pathname.includes('sw.js') ||
            url.searchParams.has('maers_ver')) {
            return;
        }

        // 2. 构造带版本号的新请求 (Cache Busting)
        // 这会让 Cloudflare 认为这是一个全新的 URL，从而回源拉取最新文件
        const newUrl = new URL(url.toString());
        newUrl.searchParams.set('maers_ver', VERSION);

        // 3. 实际上我们不需要真的去 Cache API 存取，
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
