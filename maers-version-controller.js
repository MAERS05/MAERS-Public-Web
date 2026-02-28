/**
 * MAERS Service Worker - Global Cache & Version Controller
 * 
 * 作用：拦截浏览器的网络请求，在 URL 后附加版本号参数，穿透 Cloudflare/浏览器 缓存。
 * 注意：此文件只控制【前端文件】的缓存（JS/CSS/JSON/HTML），后端 Python 文件不经过浏览器，无需管理。
 * 
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  版本匹配优先级（从高到低）                                        │
 * │                                                                  │
 * │  1. files   → 单文件精确覆盖（用于紧急热修复某一个文件）              │
 * │  2. groups  → 按模块分组覆盖（推荐日常使用 ⭐）                     │
 * │  3. default → 全站兜底（大版本发布时修改）                          │
 * └──────────────────────────────────────────────────────────────────┘
 * 
 * ===== 使用教学 =====
 * 
 * 【场景 1】改了 CMS 相关的几个 JS 文件
 *   → 找到下方 groups.cms.version，把数字加 1：
 *     version: '1'  改成  version: '2'
 * 
 * 【场景 2】改了全站 CSS 样式
 *   → 找到下方 groups.styles.version，把数字加 1
 * 
 * 【场景 3】同时改了 CMS 和音乐模块
 *   → 分别把 groups.cms.version 和 groups.music.version 各加 1
 * 
 * 【场景 4】大版本发布（改了很多东西）
 *   → 直接修改最上面的 default 值，例如 '2026.0217-1700' 改成 '2026.0224-1200'
 *     这会让所有未被分组覆盖的文件全部刷新
 * 
 * 【场景 5】只改了一个文件要紧急修复
 *   → 在最下面的 files 中添加一行（注意引号！）：
 *     'shared/utils.module.js': 'hotfix-1'
 */

const VERSION_CONFIG = {
    // ════════════════════════════════════════════
    // 📅 全局默认版本（兜底，优先级最低）
    // 大版本发布时修改这里
    // ════════════════════════════════════════════
    default: '2026.0228-0000',

    // ════════════════════════════════════════════
    // 📦 分组版本（推荐日常使用 ⭐）
    // 改了哪个模块就把对应的 version 数字 +1
    // paths 是自动匹配的路径前缀，一般不需要修改
    // ════════════════════════════════════════════
    groups: {
        // 🎨 全局样式 (CSS)
        styles: {
            version: '1',   // ← 改了 CSS？把这个数字 +1
            paths: ['static-style/', 'custom/zmobile adaptation/']
        },
        // 📝 CMS 核心内容管理
        cms: {
            version: '1',   // ← 改了 CMS？把这个数字 +1
            paths: ['custom/cms/']
        },
        // 📚 文学模块
        literature: {
            version: '1',
            paths: ['custom/literature/', 'data/literature-tree.json']
        },
        // 📓 笔记模块
        notes: {
            version: '1',
            paths: ['custom/notes/', 'data/notes-tree.json']
        },
        // 📅 记录模块
        record: {
            version: '1',
            paths: ['custom/record/', 'data/record-tree.json']
        },
        // 🎮 游戏模块
        games: {
            version: '1',
            paths: ['custom/games/', 'data/games-tree.json']
        },
        // 🎵 音乐模块
        music: {
            version: '1',
            paths: ['custom/music/', 'data/music-data.json']
        },
        // 🖼️ 相册模块
        photos: {
            version: '1',
            paths: ['custom/photos/', 'custom/album/', 'data/photos-data.json', 'data/album-config.json']
        },
        // 🛠️ 基础设施 (shared + data-manage)
        shared: {
            version: '1',
            paths: ['shared/', 'data-manage/']
        },
        // 🌌 空间模块
        space: {
            version: '1',
            paths: ['custom/space/', 'data/space-tree.json']
        },
        // 🏠 首页
        index: {
            version: '1',
            paths: ['custom/index/', 'data/index-cards.json']
        }
    },

    // ════════════════════════════════════════════
    // 📌 单文件覆盖（最高优先级，紧急热修复用）
    //
    // ⚠️ 语法格式（键和值都必须加引号！）：
    //    '文件路径': '版本号'
    //
    // ✅ 正确写法：
    //    'shared/utils.module.js': 'hotfix-1',
    //    'static-style/style.css': 'v2',
    //
    // ❌ 错误写法：
    //    shared/utils.module.js: hotfix-1     ← 没加引号，会报错！
    //    _studio/server.py: 'v1'              ← 后端文件，浏览器不会请求，写了也没用！
    //
    // 修复完成后记得删掉对应行，避免配置越积越多。
    // ════════════════════════════════════════════
    files: {
        // 在这里添加，格式：'文件路径': '版本号',
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
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});

/**
 * 根据请求路径确定版本号
 * 优先级: files > groups > default
 */
function resolveVersion(pathname) {
    // 1. 最高优先级：单文件精确匹配
    for (const [path, ver] of Object.entries(VERSION_CONFIG.files)) {
        if (pathname.endsWith(path)) {
            return ver;
        }
    }

    // 2. 中优先级：分组前缀匹配
    // 去掉开头的 / 以便与配置的相对路径匹配
    const relativePath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
    for (const [groupName, group] of Object.entries(VERSION_CONFIG.groups)) {
        for (const prefix of group.paths) {
            if (relativePath.startsWith(prefix)) {
                return `${groupName}-${group.version}`;
            }
        }
    }

    // 3. 兜底：全局默认版本
    return VERSION_CONFIG.default;
}

// 监听所有网络请求
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (url.origin === location.origin) {

        // 排除非 GET、API 请求、上传接口、SW 自身、已带版本号的请求
        if (event.request.method !== 'GET' ||
            url.pathname.startsWith('/api/') ||
            url.pathname === '/upload' ||
            url.pathname === '/delete' ||
            url.pathname === '/reorder' ||
            url.pathname.includes('sw.js') ||
            url.searchParams.has('maers_ver')) {
            return;
        }

        // 确定版本号并构造 Cache Busting URL
        const version = resolveVersion(url.pathname);
        const newUrl = new URL(url.toString());
        newUrl.searchParams.set('maers_ver', version);

        event.respondWith(
            fetch(newUrl, {
                method: event.request.method,
                headers: event.request.headers,
                mode: 'cors',
                credentials: event.request.credentials
            }).catch(() => {
                // 离线回退
                return fetch(event.request);
            })
        );
    }
});
