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
        '/shared/icons.module.js',
        '/data-manage/admin/admin-confirm.module.js',
        '/custom/cms/admin/cms-controller.module.js',
        '/custom/cms/admin/cms-private-drafts.module.js',
        '/custom/cms/admin/cms-drag.module.js',
        '/custom/cms/admin/cms-tags-admin.module.js',
        '/custom/cms/admin/cms-tags-api.module.js',
        '/custom/cms/admin/tag-interactions.module.js',
        '/data-manage/admin/admin-base.module.js',
        '/data-manage/admin/admin-button-helper.module.js',
        '/data-manage/admin/admin-manager.module.js',
        '/data-manage/admin/admin-ui.module.js',
        '/data-manage/admin/local-only.module.js',
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
        '/plugins/vditor-assets/dist/js/katex/katex.min.css',
        '/plugins/vditor-assets/dist/js/katex/katex.min.js',
        '/plugins/vditor-assets/dist/js/katex/mhchem.min.js',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_AMS-Regular.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Caligraphic-Bold.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Caligraphic-Regular.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Fraktur-Bold.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Fraktur-Regular.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Main-Bold.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Main-BoldItalic.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Main-Italic.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Main-Regular.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Math-BoldItalic.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Math-Italic.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_SansSerif-Bold.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_SansSerif-Italic.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_SansSerif-Regular.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Script-Regular.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Size1-Regular.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Size2-Regular.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Size3-Regular.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Size4-Regular.woff2',
        '/plugins/vditor-assets/dist/js/katex/fonts/KaTeX_Typewriter-Regular.woff2',
        '/plugins/vditor-assets/dist/js/lute/lute.min.js',
        '/plugins/vditor-assets/dist/js/mermaid/mermaid.min.js',

        // 阅读器、同步和加密模块的离线依赖
        '/custom/cms/viewer/cms-reader.module.js',
        '/custom/cms/viewer/cms-reader-editor.module.js',
        '/custom/cms/viewer/cms-reader-source.module.js',
        '/custom/cms/viewer/cms-source-editor.module.js',
        '/plugins/ui-components/editor.module.js',
        '/plugins/ui-components/photoswipe.module.js',
        '/plugins/ui-components/photoswipe.css',
        '/custom/cms/admin/cms-editor.css',
        '/custom/cms/viewer/cms-scroll-sync.module.js',
        '/custom/cms/viewer/cms-backlinks.module.js',
        '/custom/cms/viewer/cms-diagrams.module.js',
        '/custom/cms/viewer/cms-reader-content.module.js',
        '/custom/cms/viewer/cms-reader-lifecycle.module.js',
        '/custom/cms/viewer/cms-reader.css',
        '/custom/cms/viewer/cms-reader-diagrams.css',
        '/data-manage/encrypt/lock-dialog.module.js',
        '/data-manage/upload-progress.module.js',
        '/data-manage/operation-progress.module.js',
        '/data-manage/encrypt/admin-session.module.js',
        '/data-manage/encrypt/auth-flow.module.js',
        '/data-manage/encrypt/group-unlock.module.js',
        '/data-manage/encrypt/password-groups.module.js',
        '/data-manage/encrypt/password-group-actions.module.js',
        '/data-manage/encrypt/password-group-choice.module.js',
        '/data-manage/encrypt/password-group-content.module.js',
        '/data-manage/sync/sync-manager.module.js',
        '/data-manage/sync/sync-requests.module.js',
        '/data-manage/sync/sync-documents.module.js',
        '/data-manage/sync/sync-toolbar.module.js',
        '/data-manage/sync/sync-media.module.js',
        '/data-manage/sync/sync-settings.module.js',
        '/data-manage/sync/sync-queue.module.js',
        '/data-manage/sync/sync-dependencies.module.js',
        '/data-manage/sync/relay-actions.module.js',
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
        '/static-style/site-guide.css', '/static-style/spatial-nav.css', '/static-style/whats-new.css',
        '/static-style/toast.css', '/static-style/splash.css', '/static-style/drag.css',
        '/static-style/sync-ui.css',
        '/custom/config.js', '/shared/flash-guard.js', '/shared/layout.module.js',
        '/shared/theme.module.js', '/shared/utils.module.js', '/shared/photo-date.module.js',
        '/shared/module-config.module.js', '/shared/simple-main.module.js',
        '/shared/spatial-nav.module.js', '/shared/style-injector.module.js',
        '/shared/toast.module.js', '/shared/content-url.module.js', '/shared/photos-url.module.js',
        '/shared/whats-new.module.js', '/data-manage/encrypt/crypto.module.js',
        '/data-manage/encrypt/private-drafts.module.js',
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
        '/ui/password-group.svg',
        '/ui/icon.ico', '/ui/icon-192.png', '/ui/icon-512.png', '/ui/icon-maskable.png', '/ui/music.webp',
        '/ui/album-icon.svg', '/ui/music-icon.svg', '/ui/games-icon.svg',
        '/ui/notes-icon.svg', '/ui/literature-icon.svg', '/ui/record-icon.svg',
        '/ui/space-icon.svg', '/ui/remove-cover.svg',
        '/ui/music-headphone.svg', '/ui/music-class.svg', '/ui/music-collection.svg',
        '/ui/music-home.svg', '/ui/music-singer.svg',
        '/ui/album-nature.svg', '/ui/album-arch.svg', '/ui/album-city.svg',
        '/ui/album-human.svg', '/ui/album-ani.svg', '/ui/album-bio.svg',
        '/ui/album-exhibit.svg', '/ui/album-avatar.svg',
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
        '/custom/cms/viewer/cms-page.module.js',
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
        '/custom/photos/viewer/photos-lightbox.module.js',
        '/custom/photos/admin/photos-controller.module.js', '/custom/photos/admin/photos-cms-adapter.module.js',
        '/custom/photos/admin/photos-private-drafts.module.js',
        '/custom/photos/viewer/photos-viewer.css', '/custom/photos/viewer/photos-header-btn.css',
        '/custom/album/main.module.js', '/custom/album/viewer/album-viewer.css',
        '/custom/space/viewer/space-view.module.js', '/custom/space/viewer/space-render.module.js',
        '/custom/space/viewer/space-viewer.css',
        '/custom/zmobile adaptation/mobile-global.css', '/custom/zmobile adaptation/mobile-index.css',
        '/custom/zmobile adaptation/mobile-music.css', '/custom/zmobile adaptation/mobile-games.css',
        '/custom/zmobile adaptation/mobile-literature.css', '/custom/zmobile adaptation/mobile-literature.js',
        '/custom/zmobile adaptation/mobile-photos.css',
        '/custom/zmobile adaptation/mobile-record.css', '/custom/zmobile adaptation/mobile-cms.css',
        '/custom/zmobile adaptation/mobile-album.css', '/custom/zmobile adaptation/mobile-space.css',
        '/custom/zmobile adaptation/mobile-spatial-nav.css',
        '/plugins/vditor-assets/index.css'
    ];

    async function readIndex(path) {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`离线索引下载失败（${response.status}）：${path}`);
        return await response.json();
    }

    async function discoverAlbumTags() {
        const albums = await readIndex('/data/album-config.json');
        if (!Array.isArray(albums)) throw new Error('相册索引格式无效');
        return albums.filter(album => !album._enc && !album._private_id && !album._private && typeof album.id === 'string')
            .map(album => `/data/tags/photos-${encodeURIComponent(album.id)}-tag-categories.json`);
    }

    function assetPath(path) {
        if (/^https?:\/\//i.test(path)) return path;
        const encoded = '/' + path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
        const mediaBase = (window.MAERS?.Config?.MEDIA_PUBLIC_BASE || '').replace(/\/+$/, '');
        return mediaBase && /^\/photos\//.test(encoded) ? mediaBase + encoded : encoded;
    }

    // ── 发现：相册缩略图与可选大图 ──
    async function discoverPhotos(includeAvif) {
        const index = await readIndex('/data/photos-data.json');
        if (!index || typeof index !== 'object' || Array.isArray(index)) throw new Error('图片索引格式无效');
        const paths = [];
        for (const photos of Object.values(index)) {
            if (!Array.isArray(photos)) continue;
            for (const photo of photos) {
                if (photo.thumb) paths.push(assetPath(photo.thumb));
                if (includeAvif && photo.preview) paths.push(assetPath(photo.preview));
            }
        }
        return paths;
    }

    // ── 发现：Markdown 文档（不含封面图）──
    async function discoverMarkdown() {
        const { markdownUrl } = await import('../../shared/content-url.module.js');
        const trees = ['games-tree.json', 'literature-tree.json', 'videos-tree.json',
                       'notes-tree.json', 'record-tree.json', 'space-tree.json'];
        const documents = await Promise.all(trees.map(async file => {
            const tree = await readIndex('/data/' + file);
            if (!Array.isArray(tree?.root)) throw new Error(`文档索引格式无效：${file}`);
            const pending = [...tree.root];
            const paths = [];
            while (pending.length) {
                const node = pending.pop();
                if (typeof node.content === 'string' && node.content.endsWith('.md')) {
                    paths.push(new URL(markdownUrl(node.content), location.origin + '/').href);
                }
                if (Array.isArray(node.children)) pending.push(...node.children);
            }
            return paths;
        }));
        return documents.flat();
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
            downloaded = status?.complete === true && !!status.cacheName?.startsWith('maers-cache-') &&
                (await caches.keys()).includes(status.cacheName);
        } catch (e) { /* 存储不可用或标记无效时，不显示已下载 */ }

        // 异步核验期间可能开始下载或收到新的状态事件，忽略过期结果。
        if (check !== statusCheck || b.classList.contains('busy')) return;
        if (!downloaded) {
            try { localStorage.removeItem(OFFLINE_STATUS_KEY); } catch (e) {}
        }
        b.classList.toggle('done', downloaded);
        if (!downloaded && b.classList.contains('failed')) return;
        b.classList.remove('failed');
        b.innerHTML = downloaded ? IC_OK : IC_DL;
        b.title = downloaded ? '已下载 · 点击更新' : '下载离线包';
        b.setAttribute('aria-label', b.title);
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
                html.light-mode .od-sheet{background:#fff;box-shadow:none}
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
            .od-btn { position: static; width: 36px; height: 36px; padding: 8px; min-height: 36px; border: 0; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-sub); background: transparent; cursor: pointer; }
            .od-btn:hover{background:rgba(255,255,255,0.16);color:#fff;transform:scale(1.1)}
            .od-btn:active{transform:scale(.93)}
            .od-btn.done{color:#4ade80;background:rgba(74,222,128,0.1)}
            .od-btn.busy{pointer-events:none}
            html.light-mode .od-btn{background:rgba(255,255,255,0.88);border-color:rgba(0,0,0,0.16);color:rgba(0,0,0,0.68);box-shadow:none}
            html.light-mode .od-btn:hover{background:#fff;border-color:rgba(0,0,0,0.22);color:#000;box-shadow:none}
            html.light-mode .od-btn.done{color:#16a34a;background:rgba(22,163,74,0.1);border-color:rgba(22,163,74,0.25)}
            .od-pct{font-size:11px;font-weight:700;font-family:system-ui,sans-serif}
            @media(max-width:768px){.od-btn{bottom:80px;right:16px}}
        `;
        document.head.appendChild(s);

        const b = document.createElement('button');
        b.className = 'od-btn app-icon-button';
        b.setAttribute('aria-label', '保存离线内容');
        b.title = '下载离线包';
        b.setAttribute('aria-label', b.title);
        b.innerHTML = IC_DL;
        b.onclick = onClickDownload;
        (document.querySelector('.app-sidebar-actions') || document.body).appendChild(b);

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
        b.classList.remove('done', 'failed');
        const progress = document.createElement('span');
        progress.className = 'od-pct';
        progress.textContent = '0%';
        b.replaceChildren(progress);
        b.title = '下载中...';
        b.setAttribute('aria-label', b.title);

        let failure = '离线包下载失败 · 点击重试';
        try {
            localStorage.removeItem(OFFLINE_STATUS_KEY);
            const [photos, markdown, albumTags] = await Promise.all([
                discoverPhotos(includeAvif),
                discoverMarkdown(),
                discoverAlbumTags()
            ]);

            const urls = [...new Set([...FRAMEWORK, ...photos, ...markdown, ...albumTags])];
            const total = urls.length;

            // 找到当前 SW 的缓存
            const names = await caches.keys();
            const cn = names.find(n => n.startsWith('maers-cache-') && n !== 'maers-cache-offline') || 'maers-cache-offline';
            const cache = await caches.open(cn);
            let done = 0;

            // 分批下载
            for (let i = 0; i < urls.length; i += 10) {
                const batch = await Promise.allSettled(
                    urls.slice(i, i + 10).map(async u => {
                        const r = await fetch(u);
                        // 未设置加密的站点没有密钥环文件。
                        if (u === '/data/crypto-keyring.json' && r.status === 404) return;
                        if (!r.ok) throw new Error(`下载失败（${r.status}）：${u}`);
                        // 存两份 key：原始路径 + 实际返回的版本化路径
                        await cache.put(u, r.clone());
                        if (r.url && r.url !== new URL(u, location.href).href) {
                            await cache.put(r.url, r);
                        }
                    })
                );
                done += batch.filter(result => result.status === 'fulfilled').length;
                progress.textContent = `${Math.floor(done / total * 100)}%`;
            }

            if (done !== total) {
                failure = `离线包下载不完整（${done}/${total}） · 点击重试`;
                throw new Error(failure);
            }
            localStorage.setItem(OFFLINE_STATUS_KEY, JSON.stringify({ cacheName: cn, complete: true, downloadedAt: Date.now() }));
            b.classList.remove('busy');
            await syncDownloadStatus();

        } catch (error) {
            console.warn('[MAERS] 离线包下载未完成:', error);
            b.classList.remove('busy');
            b.classList.add('failed');
            progress.textContent = '重试';
            b.title = failure;
            b.setAttribute('aria-label', failure);
            window.MAERS?.Toast?.error?.(failure);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
