/**
 * MAERS Offline Download Manager (offline-download.js)
 * @version 3.0.0
 *
 * 下载策略：
 * - 框架（HTML/JS/CSS/JSON/SVG）：全部
 * - 相册缩略图（webp）：全部
 * - Markdown 文档：全部
 * - 封面图（CMS 页面）：不下载（占位图已有）
 * - 相册大图（avif）：可选
 */
(function () {
    'use strict';

    // ── 框架资源（全部必须下载）──
    const FRAMEWORK = [
        '/custom/cms/admin/cms-controller.module.js',
        '/custom/cms/admin/cms-drag.module.js',
        '/custom/cms/admin/cms-tags-admin.module.js',
        '/custom/cms/admin/cms-tags-api.module.js',
        '/custom/cms/admin/tag-interactions.module.js',
        '/data-manage/admin/admin-base.module.js',
        '/data-manage/admin/admin-button-helper.module.js',
        '/data-manage/admin/admin-manager.module.js',
        '/data-manage/admin/admin-ui.module.js',
        '/data-manage/sync/github-sync.module.js',
        '/plugins/vditor-assets/dist/css/content-theme/dark.css',
        '/plugins/vditor-assets/dist/css/content-theme/light.css',
        '/plugins/vditor-assets/dist/js/echarts/echarts.min.js',
        '/plugins/vditor-assets/dist/js/flowchart.js/flowchart.min.js',
        '/plugins/vditor-assets/dist/js/graphviz/full.render.js',
        '/plugins/vditor-assets/dist/js/graphviz/viz.js',
        '/plugins/vditor-assets/dist/js/highlight.js/highlight.pack.js',
        '/plugins/vditor-assets/dist/js/highlight.js/solidity.min.js',
        '/plugins/vditor-assets/dist/js/highlight.js/styles/dracula.css',
        '/plugins/vditor-assets/dist/js/highlight.js/styles/github.css',
        '/plugins/vditor-assets/dist/js/highlight.js/yul.min.js',
        '/plugins/vditor-assets/dist/js/i18n/zh_CN.js',
        '/plugins/vditor-assets/dist/js/icons/ant.js',
        '/plugins/vditor-assets/dist/js/lute/lute.min.js',
        '/plugins/vditor-assets/dist/js/mermaid/mermaid.min.js',

        // 阅读器、同步和加密模块的离线依赖
        '/custom/cms/viewer/cms-reader.module.js',
        '/custom/cms/viewer/cms-reader-editor.module.js',
        '/custom/cms/admin/cms-editor.css',
        '/custom/cms/viewer/cms-scroll-sync.module.js',
        '/custom/cms/viewer/cms-backlinks.module.js',
        '/custom/cms/viewer/cms-diagrams.module.js',
        '/custom/cms/viewer/cms-reader-content.module.js',
        '/custom/cms/viewer/cms-reader-lifecycle.module.js',
        '/custom/cms/viewer/cms-reader.css',
        '/custom/cms/viewer/cms-reader-diagrams.css',
        '/data-manage/encrypt/lock-dialog.module.js',
        '/data-manage/encrypt/admin-session.module.js',
        '/data-manage/encrypt/auth-flow.module.js',
        '/data-manage/sync/sync-manager.module.js',
        '/data-manage/sync/sync-settings.module.js',
        '/data-manage/sync/sync-queue.module.js',
        '/data-manage/sync/cloudflare-relay.module.js',
        '/data-manage/sync/git-commit.module.js',
        '/ui/double-chain.svg',
        '/ui/full-screen.svg',
        '/ui/exit-fullscreen.svg',
        '/plugins/vditor-assets/method.min.js',

        '/', '/index.html', '/music.html', '/videos.html', '/photos.html',
        '/games.html', '/notes.html', '/literature.html', '/record.html',
        '/space.html', '/album.html', '/me.html',
        '/static-style/theme.css', '/static-style/components.css',
        '/static-style/style.css', '/static-style/responsive.css',
        '/static-style/site-guide.css', '/static-style/spatial-nav.css',
        '/static-style/toast.css', '/static-style/splash.css', '/static-style/drag.css',
        '/static-style/sync-ui.css',
        '/custom/config.js', '/shared/flash-guard.js', '/shared/layout.module.js',
        '/shared/theme.module.js', '/shared/utils.module.js',
        '/shared/module-config.module.js', '/shared/simple-main.module.js',
        '/shared/spatial-nav.module.js', '/shared/style-injector.module.js',
        '/shared/toast.module.js',
        '/shared/whats-new.module.js', '/data-manage/encrypt/crypto.module.js',
        '/data-manage/encrypt/keyring.module.js', '/data-manage/encrypt/private-media.module.js',
        '/data-manage/encrypt/secret-unlock.module.js',
        '/shared/theme/theme-core.module.js', '/shared/theme/theme-drag.module.js',
        '/shared/theme/theme-zoom.module.js',
        '/data-manage/data-provider.module.js', '/data-manage/api-client.module.js',
        '/data-manage/encrypt/admin-lock.module.js',
        '/manifest.json',
        '/custom/zmobile localization/offline-download.js',
        // UI 图标（全部）
        '/ui/logo.svg', '/ui/index.svg', '/ui/story.svg', '/ui/moon.svg',
        '/ui/sun.svg', '/ui/set-up.svg', '/ui/secret-key.svg', '/ui/encryption.svg', '/ui/decryption.svg',
        '/ui/icon.ico', '/ui/icon-192.png', '/ui/icon-512.png', '/ui/icon-maskable.png', '/ui/music.png',
        '/ui/album-icon.svg', '/ui/music-icon.svg', '/ui/games-icon.svg',
        '/ui/notes-icon.svg', '/ui/literature-icon.svg', '/ui/record-icon.svg',
        '/ui/space-icon.svg', '/ui/remove-cover.svg',
        '/ui/music-headphone.svg', '/ui/music-class.svg', '/ui/music-collection.svg',
        '/ui/music-home.svg', '/ui/music-singer.svg',
        '/ui/album-nature.svg', '/ui/album-arch.svg', '/ui/album-city.svg',
        '/ui/album-human.svg', '/ui/album-ani.svg', '/ui/album-bio.svg',
        '/ui/album-life.svg', '/ui/album-exhibit.svg', '/ui/album-avatar.svg',
        '/ui/album-other.svg', '/ui/album-new.svg',
        '/ui/cms-history.svg', '/ui/cms-pin.svg', '/ui/cms-pin-slash.svg',
        // JSON 数据
        '/data/index-cards.json', '/data/music-data.json', '/data/games-tree.json',
        '/data/literature-tree.json', '/data/notes-tree.json', '/data/record-tree.json',
        '/data/videos-tree.json', '/data/space-tree.json', '/data/album-config.json',
        '/data/photos-data.json', '/data/changelog.json', '/data/crypto-keyring.json',
        '/data/tags/cms-games-tag-categories.json', '/data/tags/cms-literature-tag-categories.json',
        '/data/tags/cms-notes-tag-categories.json', '/data/tags/cms-record-tag-categories.json',
        '/data/tags/cms-tag-categories.json', '/data/tags/cms-videos-tag-categories.json',
        '/data/tags/photos-tag-categories.json', '/data/tags/space-tag-categories.json',
        // 模块 JS & CSS
        '/custom/index/viewer/index-viewer.module.js', '/custom/index/viewer/site-guide.js',
        '/custom/index/viewer/index.css',
        '/custom/music/main.module.js', '/custom/music/viewer/music.css',
        '/custom/music/viewer/music-control.module.js', '/custom/music/viewer/music-player-core.module.js',
        '/custom/music/viewer/music-player-iframe.module.js', '/custom/music/viewer/music-player-pip.module.js',
        '/custom/music/viewer/music-render.module.js', '/custom/music/viewer/music-state.module.js',
        '/custom/music/viewer/music-ui.module.js',
        '/custom/music/viewer/styles/music-controls.css', '/custom/music/viewer/styles/music-layout.css',
        '/custom/music/viewer/styles/music-playlist.css',
        '/custom/videos/main.module.js', '/custom/videos/viewer/videos.css',
        '/custom/games/main.module.js', '/custom/games/viewer/games-view.module.js',
        '/custom/games/viewer/games.css', '/custom/games/viewer/games-reset.css',
        '/custom/cms/main.module.js', '/custom/cms/cms-adapter.module.js',
        '/custom/cms/viewer/cms-view.module.js', '/custom/cms/viewer/cms-render.module.js',
        '/custom/cms/viewer/cms-state.module.js', '/custom/cms/viewer/cms-events.module.js',
        '/custom/cms/viewer/cms-search.module.js', '/custom/cms/viewer/cms-lightbox.module.js',
        '/custom/cms/viewer/cms-recent.module.js', '/custom/cms/viewer/cms-admin.module.js',
        '/custom/cms/viewer/cms-tags.module.js',
        '/custom/cms/viewer/render/cms-render-grid.module.js',
        '/custom/cms/viewer/render/cms-render-nav.module.js',
        '/custom/cms/viewer/tags/cms-tags-drawer.module.js',
        '/custom/cms/viewer/tags/cms-tags-filter.module.js',
        '/custom/cms/viewer/tags/cms-tags-render.module.js',
        '/custom/cms/viewer/tags/cms-tags-ui.module.js',
        '/custom/cms/viewer/cms-base.css', '/custom/cms/viewer/cms-theme-default.css',
        '/custom/notes/viewer/notes.css',
        '/custom/literature/main.module.js', '/custom/literature/viewer/literature-view.module.js',
        '/custom/literature/viewer/literature.css', '/custom/literature/viewer/literature-reset.css',
        '/custom/literature/viewer/flow/literature-flow-data.module.js',
        '/custom/literature/viewer/flow/literature-flow-engine.module.js',
        '/custom/literature/viewer/flow/literature-flow-render.module.js',
        '/custom/record/viewer/record.css',
        '/custom/photos/main.module.js', '/custom/photos/viewer/photos-view.module.js',
        '/custom/photos/admin/photos-controller.module.js', '/custom/photos/admin/photos-cms-adapter.module.js',
        '/custom/photos/viewer/photos-viewer.css', '/custom/photos/viewer/photos-header-btn.css',
        '/custom/album/main.module.js', '/custom/album/viewer/album-viewer.css',
        '/custom/space/viewer/space-view.module.js', '/custom/space/viewer/space-render.module.js',
        '/custom/space/viewer/space-viewer.css',
        '/custom/zmobile adaptation/mobile-global.css', '/custom/zmobile adaptation/mobile-index.css',
        '/custom/zmobile adaptation/mobile-music.css', '/custom/zmobile adaptation/mobile-games.css',
        '/custom/zmobile adaptation/mobile-literature.css', '/custom/zmobile adaptation/mobile-literature.js',
        '/custom/zmobile adaptation/mobile-photos.css', '/custom/zmobile adaptation/mobile-photos.js',
        '/custom/zmobile adaptation/mobile-record.css', '/custom/zmobile adaptation/mobile-cms.css',
        '/custom/zmobile adaptation/mobile-album.css', '/custom/zmobile adaptation/mobile-space.css',
        '/custom/zmobile adaptation/mobile-spatial-nav.css',
        '/plugins/marked.min.js', '/plugins/vditor-assets/index.min.js', '/plugins/vditor-assets/index.css'
    ];

    // ── 发现：相册 webp 缩略图 ──
    async function discoverThumbs() {
        try {
            const r = await fetch('/data/photos-data.json');
            if (!r.ok) return [];
            const d = await r.json();
            const out = [];
            for (const cat of Object.values(d)) {
                if (!Array.isArray(cat)) continue;
                for (const p of cat) {
                    if (p.thumb) out.push('/' + p.thumb);
                }
            }
            return out;
        } catch (e) { return []; }
    }

    // ── 发现：相册 avif 大图（可选）──
    async function discoverFullPhotos() {
        try {
            const r = await fetch('/data/photos-data.json');
            if (!r.ok) return [];
            const d = await r.json();
            const out = [];
            for (const cat of Object.values(d)) {
                if (!Array.isArray(cat)) continue;
                for (const p of cat) {
                    // 直接读 preview 字段（avif 格式）
                    if (p.preview) out.push('/' + p.preview);
                }
            }
            return [...new Set(out)];
        } catch (e) { return []; }
    }

    // ── 发现：Markdown 文档（不含封面图）──
    async function discoverMarkdown() {
        const trees = ['games-tree.json', 'literature-tree.json', 'videos-tree.json',
                       'notes-tree.json', 'record-tree.json', 'space-tree.json'];
        const out = [];
        for (const f of trees) {
            try {
                const r = await fetch('/data/' + f);
                if (!r.ok) continue;
                const t = await r.text();
                // 只取 markdown，不取封面图
                for (const m of t.matchAll(/"content"\s*:\s*"([^"]*\.md)"/g)) {
                    out.push('/data/' + m[1]);
                }
            } catch (e) {}
        }
        return out;
    }

    // ── SVG 图标 ──
    const IC_DL = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>`;
    const IC_OK = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    const OFFLINE_STATUS_KEY = 'maers-offline-ok';
    let statusCheck = 0;

    // 完成标记与缓存名绑定；缓存被清理后，页面同步恢复下载图标。
    async function syncDownloadStatus() {
        const check = ++statusCheck;
        const b = document.querySelector('.od-btn');
        if (!b || b.classList.contains('busy')) return;

        let downloaded = false;
        try {
            const status = JSON.parse(localStorage.getItem(OFFLINE_STATUS_KEY));
            downloaded = !!status?.cacheName?.startsWith('maers-cache-') &&
                (await caches.keys()).includes(status.cacheName);
        } catch (e) { /* 存储不可用或标记无效时，不显示已下载 */ }

        // 异步核验期间可能开始下载或收到新的状态事件，忽略过期结果。
        if (check !== statusCheck || b.classList.contains('busy')) return;
        if (!downloaded) {
            try { localStorage.removeItem(OFFLINE_STATUS_KEY); } catch (e) {}
        }
        b.classList.toggle('done', downloaded);
        b.innerHTML = downloaded ? IC_OK : IC_DL;
        b.title = downloaded ? '已下载 · 点击更新' : '下载离线包';
    }

    // ── 确认弹窗：是否下载 avif 大图 ──
    function askAvif() {
        return new Promise(resolve => {
            const s = document.createElement('style');
            s.textContent = `
                .od-mask{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);display:flex;align-items:flex-end;justify-content:center}
                .od-sheet{position:relative;box-sizing:border-box;background:#1a1a1e;border-radius:18px 18px 0 0;padding:28px 24px 40px;max-width:480px;width:100%;max-height:calc(100dvh - 24px);overflow-y:auto;font-family:system-ui,sans-serif}
                .od-sheet h3{margin:0 0 8px;font-size:16px;font-weight:600;color:#fff}
                .od-sheet p{margin:0 0 24px;font-size:13px;color:rgba(255,255,255,0.5);line-height:1.6}
                .od-sheet-btns{display:flex;flex-direction:column;gap:10px}
                .od-sheet-btn{padding:14px;border-radius:12px;border:none;font-size:15px;font-weight:500;cursor:pointer;transition:opacity .15s}
                .od-sheet-btn:active{opacity:0.7}
                .od-btn-yes{background:rgba(255,255,255,0.08);color:#fff}
                .od-btn-no{background:#2a7aef;color:#fff}
                .od-sheet-close{position:absolute;top:12px;right:12px;width:32px;height:32px;border:0;border-radius:50%;background:transparent;color:#aaa;font-size:24px;cursor:pointer}
                html.light-mode .od-sheet{background:#fff;box-shadow:0 -8px 30px rgba(0,0,0,0.12)}
                html.light-mode .od-sheet h3{color:#111}
                html.light-mode .od-sheet p{color:rgba(0,0,0,0.55)}
                html.light-mode .od-btn-yes{background:rgba(0,0,0,0.06);color:#222}
                html.light-mode .od-sheet-close{color:#666}
            `;
            document.head.appendChild(s);

            const mask = document.createElement('div');
            mask.className = 'od-mask';
            mask.innerHTML = `
                <div class="od-sheet" role="dialog" aria-modal="true" aria-labelledby="od-sheet-title">
                    <button type="button" class="od-sheet-close" aria-label="取消下载">×</button>
                    <h3 id="od-sheet-title">下载离线包</h3>
                    <p>是否同时下载相册高清大图？<br>选「否」只下载预览图，更快、更省流量，离线时相册仍可浏览但点击无法查看大图。</p>
                    <div class="od-sheet-btns">
                        <button class="od-sheet-btn od-btn-no">否，只下载预览图（推荐）</button>
                        <button class="od-sheet-btn od-btn-yes">是，同时下载高清大图</button>
                    </div>
                </div>
            `;
            const previousFocus = document.activeElement;
            const finish = choice => {
                mask.remove();
                s.remove();
                previousFocus?.focus();
                resolve(choice);
            };
            document.body.appendChild(mask);
            mask.querySelector('.od-btn-no').onclick = () => finish(false);
            mask.querySelector('.od-btn-yes').onclick = () => finish(true);
            mask.querySelector('.od-sheet-close').onclick = () => finish(null);
            mask.querySelector('.od-sheet-close').focus();
        });
    }

    // ── 初始化 UI ──
    function init() {
        const s = document.createElement('style');
        s.textContent = `
            .od-btn{position:fixed;bottom:24px;right:20px;z-index:9999;width:44px;height:44px;border-radius:50%;border:1px solid transparent;background:rgba(255,255,255,0.08);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);color:rgba(255,255,255,0.65);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .2s,color .2s,border-color .2s,box-shadow .2s,transform .15s;box-shadow:0 2px 10px rgba(0,0,0,0.25)}
            .od-btn:hover{background:rgba(255,255,255,0.16);color:#fff;transform:scale(1.1)}
            .od-btn:active{transform:scale(.93)}
            .od-btn.done{color:#4ade80;background:rgba(74,222,128,0.1)}
            .od-btn.busy{pointer-events:none}
            html.light-mode .od-btn{background:rgba(255,255,255,0.88);border-color:rgba(0,0,0,0.1);color:rgba(0,0,0,0.68);box-shadow:0 2px 10px rgba(0,0,0,0.12)}
            html.light-mode .od-btn:hover{background:#fff;border-color:rgba(0,0,0,0.22);color:#000;box-shadow:0 4px 14px rgba(0,0,0,0.16)}
            html.light-mode .od-btn.done{color:#16a34a;background:rgba(22,163,74,0.1);border-color:rgba(22,163,74,0.25)}
            .od-pct{font-size:11px;font-weight:700;font-family:system-ui,sans-serif}
            @media(max-width:768px){.od-btn{bottom:80px;right:16px}}
        `;
        document.head.appendChild(s);

        const b = document.createElement('button');
        b.className = 'od-btn';
        b.title = '下载离线包';
        b.innerHTML = IC_DL;
        b.onclick = onClickDownload;
        document.body.appendChild(b);

        navigator.serviceWorker?.addEventListener('controllerchange', syncDownloadStatus);
        navigator.serviceWorker?.addEventListener('message', event => {
            if (event.data?.type === 'MAERS_CACHE_CLEANED') syncDownloadStatus();
        });
        window.addEventListener('pageshow', syncDownloadStatus);
        window.addEventListener('focus', syncDownloadStatus);
        window.addEventListener('storage', event => {
            if (event.key === OFFLINE_STATUS_KEY || event.key === null) syncDownloadStatus();
        });
        syncDownloadStatus();
    }

    async function onClickDownload() {
        const b = document.querySelector('.od-btn');
        if (!b || b.classList.contains('busy') || document.querySelector('.od-mask')) return;

        // 弹窗询问是否下载 avif
        const includeAvif = await askAvif();
        if (includeAvif === null) return;

        b.classList.add('busy');
        b.classList.remove('done');
        b.innerHTML = '<span class="od-pct">0%</span>';
        b.title = '下载中...';

        try {
            localStorage.removeItem(OFFLINE_STATUS_KEY);
            // 发现动态资源
            const [thumbs, markdown, avifs] = await Promise.all([
                discoverThumbs(),
                discoverMarkdown(),
                includeAvif ? discoverFullPhotos() : Promise.resolve([])
            ]);

            const urls = [...new Set([...FRAMEWORK, ...thumbs, ...markdown, ...avifs])];
            const total = urls.length;

            // 找到当前 SW 的缓存
            const names = await caches.keys();
            const cn = names.find(n => n.startsWith('maers-cache-')) || 'maers-cache-offline';
            const cache = await caches.open(cn);
            let done = 0;

            // 分批下载
            for (let i = 0; i < urls.length; i += 10) {
                await Promise.allSettled(
                    urls.slice(i, i + 10).map(async u => {
                        try {
                            const r = await fetch(u);
                            if (r.ok) {
                                // 存两份 key：原始路径 + 实际返回的版本化路径
                                await cache.put(u, r.clone());
                                if (r.url && r.url !== new URL(u, location.href).href) {
                                    await cache.put(r.url, r);
                                }
                            }
                        } catch (e) {}
                        done++;
                    })
                );
                b.innerHTML = `<span class="od-pct">${Math.round(done / total * 100)}%</span>`;
            }

            localStorage.setItem(OFFLINE_STATUS_KEY, JSON.stringify({ cacheName: cn, downloadedAt: Date.now() }));
            b.classList.remove('busy');
            await syncDownloadStatus();

        } catch (e) {
            b.classList.remove('busy');
            b.innerHTML = IC_DL;
            b.title = '下载失败 · 重试';
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
