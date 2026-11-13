/**
 * MAERS Service Worker - Global Cache & Version Controller
 * 
 * 作用：为静态资源附加缓存版本号，页面导航保持干净地址。
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
    default: '2026.1103-0002',

    // ════════════════════════════════════════════
    // 📦 分组版本（推荐日常使用 ⭐）
    // 改了哪个模块就把对应的 version 数字 +1
    // paths 是自动匹配的路径前缀，一般不需要修改
    // ════════════════════════════════════════════
    groups: {
        // 🎨 全局样式 (CSS)
        styles: {
            version: '3',   // ← 改了 CSS？把这个数字 +1
            paths: ['static-style/', 'custom/zmobile adaptation/', 'plugins/vditor-assets/', 'ui/']
        },
        // 📝 CMS 核心内容管理
        cms: {
            version: '3',   // ← 改了 CMS？把这个数字 +1
            paths: ['custom/cms/', 'admin-cms.html', 'notes.html', 'record.html', 'games.html', 'literature.html', 'videos.html']
        },
        // 📚 文学模块
        literature: {
            version: '2',
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
            version: '2',
            paths: ['custom/music/', 'data/music-data.json', 'music.html', 'admin-music.html']
        },
        // 🎬 影视模块
        videos: {
            version: '1',
            paths: ['custom/videos/', 'data/videos-tree.json']
        },
        // 🖼️ 相册模块
        photos: {
            version: '3',
            paths: ['custom/photos/', 'custom/album/', 'data/photos-data.json', 'data/album-config.json']
        },
        // 🛠️ 基础设施 (shared + data-manage)
        shared: {
            version: '3',
            paths: ['shared/', 'data-manage/', 'custom/zmobile localization/', 'custom/admin-portal/', 'plugins/ui-components/']
        },
        // 🌌 空间模块
        space: {
            version: '3',
            paths: ['custom/space/', 'data/space-tree.json']
        },
        // 🏠 首页
        index: {
            version: '2',
            paths: ['index.html', 'custom/index/', 'data/index-cards.json']
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
const LEGACY_CACHE_NAME = 'maers-cache-offline';

// 监听安装事件
self.addEventListener('install', (event) => {
    // 强制跳过等待，立即接管页面
    self.skipWaiting();
});

// 监听激活事件
self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        // 清理结束后通知页面，避免 controllerchange 早于缓存清理导致状态残留。
        const cacheNames = await caches.keys();
        const outdated = cacheNames.filter(name => name.startsWith('maers-cache-') &&
            name !== CACHE_NAME && name !== LEGACY_CACHE_NAME);
        await Promise.all(outdated.map(name => caches.delete(name)));
        await caches.open(CACHE_NAME);
        await clients.claim();
        const pages = await clients.matchAll({ type: 'window' });
        pages.forEach(page => page.postMessage({ type: 'MAERS_CACHE_CLEANED' }));
    })());
});

/**
 * 根据请求路径确定版本号
 * 优先级: files > groups > default
 */
function resolveVersion(pathname) {
    try { pathname = decodeURI(pathname); } catch { /* 非法编码使用原路径。 */ }
    // 1. 最高优先级：单文件精确匹配
    for (const [path, ver] of Object.entries(VERSION_CONFIG.files)) {
        if (pathname.endsWith(path)) {
            return ver;
        }
    }

    // 2. 中优先级：分组前缀匹配
    // 去掉开头的 / 以便与配置的相对路径匹配
    const relativePath = pathname.replace(/^\//, '') || 'index.html';
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

/** 版本精确匹配优先，站内查询参数可回退到已下载的原路径。 */
async function readOffline(versioned, original, isPage) {
    const keys = new Set([versioned.href, original.href]);
    if (original.origin === location.origin && original.search) {
        keys.add(original.origin + original.pathname);
    }
    if (isPage) {
        const pathname = /^\/photos\/[^/]+\/?$/.test(original.pathname) ? '/photos.html' :
            original.pathname.replace(/\/$/, '') || '/index.html';
        const page = pathname.includes('.') ? pathname : pathname + '.html';
        keys.add(new URL(page, location.origin).href);
        keys.add(new URL('/index.html', location.origin).href);
    }
    for (const key of keys) {
        for (const cacheName of [CACHE_NAME, LEGACY_CACHE_NAME]) {
            const cached = await caches.match(key, { cacheName, ignoreVary: true });
            if (cached) return isPage ? new Response(cached.body, {
                status: cached.status, statusText: cached.statusText, headers: cached.headers
            }) : cached;
        }
    }
    return new Response('Offline', { status: 503 });
}

// 监听所有网络请求
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const isPage = event.request.mode === 'navigate' || event.request.destination === 'document' ||
        Boolean(event.request.headers.get('accept')?.includes('text/html'));

    const remoteMedia = url.origin !== location.origin && url.protocol === 'https:' &&
        /^\/(?:photos\/(?:images|previews|thumbnails)\/|markdown\/.+\.md$)/.test(url.pathname);
    if (url.origin === location.origin || remoteMedia) {

        // 排除非 GET、API 请求、上传接口、SW 自身和已版本化的资源请求。
        if (event.request.method !== 'GET' ||
            event.request.headers.has('X-MAERS-Token') ||
            url.pathname.startsWith('/api/') ||
            url.pathname === '/upload' ||
            url.pathname === '/delete' ||
            url.pathname === '/reorder' ||
            url.pathname.includes('sw.js') ||
            (!isPage && url.searchParams.has('maers_ver'))) {
            return;
        }

        // 确定版本号并构造 Cache Busting URL
        const version = resolveVersion(url.pathname);
        const newUrl = new URL(url.toString());
        if (isPage) newUrl.searchParams.delete('maers_ver');
        else if (!remoteMedia) newUrl.searchParams.set('maers_ver', version);
        const revalidate = ['no-cache', 'no-store'].includes(event.request.cache);

        event.respondWith(
            fetch(newUrl, {
                method: event.request.method,
                headers: event.request.headers,
                mode: 'cors',
                redirect: event.request.redirect,
                cache: revalidate ? event.request.cache : 'default',
                // 公开 CDN 使用通配 CORS，不能沿用 img 请求的 include 凭据模式。
                credentials: remoteMedia ? 'omit' : event.request.credentials
            }).catch(() => readOffline(newUrl, url, isPage))
        );
    }
});
