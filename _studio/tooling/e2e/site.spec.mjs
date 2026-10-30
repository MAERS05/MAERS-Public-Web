/** 页面渲染、阅读器交互与真实鉴权保存的浏览器回归。 */
import { test, expect } from '@playwright/test';
test('本地 Git 显示真实阶段并区分推送结果', async ({ page }) => {
    let progress = { api_version: 1, step: 'pre_check', msg: '正在执行提交前检查…' };
    let finishPush;
    let pushes = 0;
    await page.route('**/api/git/status', route => route.fulfill({ json: {
        success: true, branch: 'main', change_count: 1,
        changes: [{ status: 'M', file: '中文<文件>.md' }]
    } }));
    await page.route('**/api/git/progress', route => route.fulfill({ json: progress }));
    await page.route('**/api/git/commit-push', async route => {
        pushes++;
        const result = await new Promise(resolve => { finishPush = resolve; });
        await route.fulfill({ json: result });
    });
    await page.goto('/admin-portal.html');
    await page.evaluate(async () => {
        const { gitCommitManager } = await import('/data-manage/sync/git-commit.module.js');
        await gitCommitManager.openCommitModal();
    });
    const submit = page.locator('#git-modal-submit');
    await expect(page.locator('#git-commit-msg-input')).toHaveValue(/^chore: 本地改动 /);
    await expect(page.locator('#git-changes-panel')).toContainText('中文<文件>.md');
    await submit.click();
    await expect(submit).toHaveText('正在检查…');
    progress = { api_version: 1, step: 'push', msg: '本地提交已保存，正在执行推送（含推送前完整测试）…' };
    await expect(submit).toHaveText('已提交，正在校验并推送…');
    await expect(page.locator('#git-changes-panel')).toContainText('本地提交已保存');
    await page.locator('#git-modal-cancel').click();
    await expect(submit).not.toBeVisible();
    await page.evaluate(async () => {
        const { gitCommitManager } = await import('/data-manage/sync/git-commit.module.js');
        await gitCommitManager.openCommitModal();
    });
    await expect(submit).toHaveText('已提交，正在校验并推送…');
    expect(pushes).toBe(1);
    finishPush({ success: false, step: 'push_unknown', msg: '本地提交已保留；远端是否接收尚未确认' });
    await expect(submit).toHaveText('核对状态后重试');
    await expect(page.locator('#git-log-area')).not.toContainText('提交失败');
    finishPush = null;
    await submit.click();
    await expect.poll(() => Boolean(finishPush)).toBe(true);
    finishPush({ success: true, step: 'done', commit_hash: 'abc123', msg: '所有改动已成功提交并推送到 GitHub 远端！' });
    await expect(submit).toHaveText('推送成功');
    await expect(page.locator('#git-log-area')).toContainText('abc123');
});

for (const state of ['旧版', '无响应']) {
    test(`本地 Git ${state}后台保持本地模式并阻止提交`, async ({ page }) => {
        let pushes = 0;
        await page.route('**/api/git/progress', async route => {
            if (state === '旧版') await route.fulfill({ status: 404, json: { error: 'API not found' } });
            else {
                await new Promise(resolve => setTimeout(resolve, 2500));
                await route.abort();
            }
        });
        await page.route('**/api/git/commit-push', route => {
            pushes++;
            return route.fulfill({ json: { success: true } });
        });
        await page.goto('/admin-portal.html');
        await page.evaluate(async () => {
            const { gitCommitManager } = await import('/data-manage/sync/git-commit.module.js');
            await gitCommitManager.openCommitModal();
        });
        await expect(page.locator('#git-env-text')).toHaveText('本地模式');
        await expect(page.locator('#git-cloud-config-drawer')).not.toBeVisible();
        await expect(page.locator('#git-modal-submit')).toBeDisabled();
        await expect(page.locator('#git-changes-panel')).toContainText(state === '旧版' ? '完整退出后台' : '暂时没有响应');
        expect(pushes).toBe(0);
    });
}

test.beforeEach(async ({ page, request }) => {
    const reset = await request.post('/__test/reset');
    expect(reset.ok()).toBeTruthy();
    await page.addInitScript(() => {
        if (!localStorage.getItem('autoThemeConfig')) {
            localStorage.setItem('autoThemeConfig', JSON.stringify({ version: 2, mode: 'system' }));
        }
    });
});
for (const module of ['literature', 'games', 'videos']) {
    test(`手机上传封面按真实图片索引展示：${module}`, async ({ page, request }) => {
        const seeded = await request.post('/__test/cloud-covers');
        expect(seeded.ok()).toBeTruthy();
        const row = (await seeded.json())[module];
        expect(row.thumb).toMatch(/\/[a-f0-9]{64}\.webp$/);
        const imageResponses = [], imageErrors = [];
        page.on('response', response => {
            const path = new URL(response.url()).pathname;
            if (path.startsWith('/photos/')) {
                imageResponses.push({ path, status: response.status() });
                if (response.status() >= 400) imageErrors.push(path);
            }
        });
        if (module === 'games') await page.addInitScript(id => {
            localStorage.setItem('maers_playing_game_id', id);
        }, row.nodeId);
        await page.goto(`/${module}.html`);
        if (module === 'literature') {
            await expect.poll(() => page.locator('.book-cover').evaluateAll((elements, thumb) =>
                elements.some(element => element.style.backgroundImage.includes(thumb)), row.thumb),
                { timeout: 15000 }).toBe(true);
            await expect.poll(() => imageResponses.some(response => response.path === `/${row.thumb}`
                && response.status === 200), { timeout: 15000 }).toBe(true);
            await page.locator('.mode-text-btn').click();
        }
        const cover = module === 'games'
            ? page.locator('#playing-card-wrapper .item-cover-img').first()
            : page.locator('#grid-container .item-cover-img').first();
        await expect(cover).toHaveAttribute('src', row.preview);
        await expect.poll(() => cover.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
        await expect.poll(() => imageResponses.some(response => response.path === `/${row.preview}`
            && response.status === 200)).toBe(true);
        if (module === 'games') {
            const url = await page.evaluate(async coverImage => {
                const { GamesView } = await import('/custom/games/viewer/games-view.module.js');
                return GamesView._getCoverUrl({ coverImage });
            }, row.path);
            expect(url).toBe(row.preview);
        }
        expect(imageErrors).toEqual([]);
    });
}

test('首页卡片与深浅色、移动端布局', async ({ page }, info) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/index.html');
    await expect(page.locator('.nav-card').first()).toBeVisible();
    await expect(page.locator('html')).toHaveClass(info.project.name.includes('light') ? /light-mode/ : /^(?!.*light-mode).*$/);
    const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(size.width).toBeLessThanOrEqual(size.viewport + 2);
    await page.locator('.nav-card').first().click();
    await expect(page).toHaveURL(/notes.html/);
    expect(errors).toEqual([]);
});

test('首页脚本等待时先显示正确主题，导航数据只请求一次', async ({ page }, info) => {
    let resume;
    const gate = new Promise(resolve => { resume = resolve; });
    let dataRequests = 0;
    page.on('request', request => {
        if (new URL(request.url()).pathname === '/data/index-cards.json') dataRequests++;
    });
    await page.addInitScript(() => {
        window.homeDomReady = false;
        document.addEventListener('DOMContentLoaded', () => { window.homeDomReady = true; });
    });
    await page.route('**/shared/theme/theme-drag.module.js', async route => {
        await gate;
        await route.continue();
    });
    try {
        await page.goto('/index.html', { waitUntil: 'commit' });
        await expect(page.locator('.brand-title')).toBeVisible();
        expect(await page.evaluate(() => window.homeDomReady)).toBe(false);
        await expect(page.locator('html')).not.toHaveClass(/js-loading/);
        await expect(page.locator('html')).toHaveClass(info.project.name.includes('light') ? /light-mode/ : /^(?!.*light-mode).*$/);
    } finally { resume(); }
    await expect(page.locator('.nav-card').first()).toBeVisible();
    await expect(page.locator('#spatial-nav-container')).toBeAttached();
    await page.waitForLoadState('networkidle');
    expect(dataRequests).toBe(1);
});

test('加锁子页面在守卫完成前保持隐藏', async ({ page }) => {
    let resume, requested;
    const gate = new Promise(resolve => { resume = resolve; });
    const requestStarted = new Promise(resolve => { requested = resolve; });
    await page.route('**/data/index-cards.json', async route => {
        requested();
        const guard = await gate;
        await route.fulfill({ json: [{ _guard: guard }] });
    });
    try {
        await page.goto('/notes.html', { waitUntil: 'commit' });
        await requestStarted;
        await expect(page.locator('html')).toHaveClass(/js-loading/);
        await expect(page.locator('body')).toHaveCSS('visibility', 'hidden');
        const hash = await page.evaluate(async () => {
            const { pageGuardHash } = await import('/data-manage/encrypt/secret-unlock.module.js');
            return pageGuardHash('notes');
        });
        resume(hash);
        await expect(page.locator('#maers-404')).toBeVisible();
        await expect(page.locator('html')).not.toHaveClass(/js-loading/);
    } finally { resume(''); }
});

for (const nativeTransition of [true, false]) {
    test(`主题滑块连续移动：${nativeTransition ? '页面快照' : 'CSS 兼容'}`, async ({ page }) => {
        if (!nativeTransition) await page.addInitScript(() => { document.startViewTransition = undefined; });
        await page.goto('/index.html');
        await expect(page.locator('.nav-card').first()).toBeVisible();
        const before = await page.locator('.ball').evaluate(element => element.getBoundingClientRect().x);
        const wasLight = await page.locator('html').evaluate(root => root.classList.contains('light-mode'));
        await page.locator('.theme-switch-label').click();
        await page.waitForFunction(native => document.getAnimations().some(animation => native
            ? animation.effect?.pseudoElement === '::view-transition-group(theme-switch-knob)'
            : animation instanceof CSSTransition && animation.transitionProperty === 'transform'
                && animation.effect?.target?.classList.contains('ball')), nativeTransition);
        const sample = await page.evaluate(native => {
            const animation = document.getAnimations().find(item => native
                ? item.effect?.pseudoElement === '::view-transition-group(theme-switch-knob)'
                : item instanceof CSSTransition && item.transitionProperty === 'transform'
                    && item.effect?.target?.classList.contains('ball'));
            animation.pause();
            animation.currentTime = 250;
            const position = native
                ? new DOMMatrix(getComputedStyle(document.documentElement,
                    '::view-transition-group(theme-switch-knob)').transform).m41
                : document.querySelector('.ball').getBoundingClientRect().x;
            const duration = animation.effect.getTiming().duration;
            animation.play();
            return { position, duration };
        }, nativeTransition);
        expect(sample.duration).toBe(500);
        const target = before + (wasLight ? 24 : -24);
        expect(sample.position).toBeGreaterThan(Math.min(before, target) + 0.1);
        expect(sample.position).toBeLessThan(Math.max(before, target) - 0.1);
        await expect(page.locator('.ball')).toHaveJSProperty('offsetWidth', 20);
        await expect(page.locator('html')).not.toHaveClass(/theme-crossfade|theme-switching/);
        expect(await page.locator('.theme-switch-checkbox').isChecked()).toBe(wasLight);
        await expect(page.locator('#mode-icon')).toHaveCSS('opacity', wasLight ? '1' : '0');
        await expect(page.locator('.mode-icon-sun')).toHaveCSS('opacity', wasLight ? '0' : '1');
        // 同一帧内连续点击两次，不能被快照前的勾选还原吞掉。
        await page.evaluate(async () => {
            const label = document.querySelector('.theme-switch-label');
            label.click();
            label.click();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        expect(await page.locator('.theme-switch-checkbox').isChecked()).toBe(wasLight);
        expect(await page.locator('html').evaluate(root => root.classList.contains('light-mode'))).toBe(!wasLight);
    });
}
test('打开阅读器并跟随双链', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/notes.html?openNoteId=browser-note');
    await expect(page.locator('#reader-content h1')).toHaveText('浏览器测试');
    await page.locator('#reader-content .cms-wikilink').click();
    await expect(page.locator('#reader-content h1')).toHaveText('第二篇');
    await page.locator('#immersive-reader .close-btn').click();
    await expect(page.locator('#immersive-reader')).not.toHaveClass(/active/);
    await expect(page.locator('#immersive-reader')).toHaveCSS('opacity', '0');
    await expect(page.locator('#immersive-reader')).toHaveCSS('pointer-events', 'none');
    expect(errors).toEqual([]);
});
for (const renderer of ['vditor', 'marked-only', 'none']) {
    test(`阅读器阻止 HTML 脚本执行：${renderer}`, async ({ page }) => {
        const markdown = '# 安全阅读\n\n<img src="/__missing_probe.png" onerror="window.__readerXssProbe=1">\n'
            + '<svg onload="window.__readerXssProbe=1"></svg>\n'
            + '<a href="javascript:window.__readerXssProbe=1">危险链接</a>';
        if (renderer !== 'vditor') {
            await page.route('**/plugins/vditor-assets/index.min.js*', route => route.abort());
        }
        if (renderer === 'none') {
            await page.route('**/plugins/marked.min.js*', route => route.abort());
        }
        await page.route('**/data/notes/browser.md*', route => route.fulfill({
            status: 200, contentType: 'text/markdown; charset=utf-8', body: markdown
        }));
        await page.goto('/notes.html?openNoteId=browser-note');
        const content = page.locator('#reader-content');
        if (renderer === 'vditor') {
            await expect(content.locator('h1')).toHaveText('安全阅读');
        } else {
            await expect(content.locator('pre')).toHaveText(markdown);
            await expect(content.locator('img, svg, a')).toHaveCount(0);
        }
        await expect(content.locator('[onerror], [onload], a[href^="javascript:"]')).toHaveCount(0);
        expect(await page.evaluate(() => window.__readerXssProbe)).toBeUndefined();
    });
}

test('管理阅读器源码保存后刷新仍可读取', async ({ page, request }) => {
    await page.goto('/admin-cms.html?module=notes&openNoteId=browser-note');
    await expect(page.locator('#reader-content h1')).toHaveText('浏览器测试');
    await page.locator('#btn-toggle-source').click();
    await page.locator('#cms-source-textarea').fill('# 已保存正文\n\n通过浏览器验证。');
    const saved = page.waitForResponse(r => r.url().includes('/api/cms/node') && r.request().method() === 'POST');
    await page.locator('#btn-save-source').click();
    expect((await saved).status()).toBe(200);
    expect(await (await request.get('/data/notes/browser.md')).text()).toContain('已保存正文');
    await page.reload();
    await expect(page.locator('#reader-content h1')).toHaveText('已保存正文');
});

test('正文读取失败时禁止覆盖，只改标题保留真实正文', async ({ page, request }) => {
    const original = await (await request.get('/data/notes/browser.md')).text();
    const writes = [];
    page.on('request', req => {
        if (req.method() === 'POST' && req.url().includes('/api/cms/node')) writes.push(req.postDataJSON());
    });
    await page.route('**/data/notes/browser.md*', route => route.fulfill({status:503, body:'offline'}));
    await page.goto('/admin-cms.html?module=notes&openNoteId=browser-note');
    await expect(page.locator('#reader-content')).toContainText('文档加载失败');
    await page.locator('#btn-toggle-source').click();
    await page.locator('#cms-source-textarea').fill('不应写入磁盘');
    await page.locator('#btn-save-source').click();
    await expect(page.locator('.toast-error').last()).toContainText('尚未成功读取');
    expect(writes).toHaveLength(0);
    const saved = page.waitForResponse(r => r.url().includes('/api/cms/node') && r.request().method() === 'POST');
    await page.locator('#edit-title-input').fill('safe-title');
    await page.locator('#edit-title-input').press('Tab');
    expect((await saved).status()).toBe(200);
    expect(writes[0].data).toEqual({title:'safe-title'});
    const tree = await (await request.get('/api/cms/fetch?module=notes')).json();
    const node = tree.root.find(item => item.id === 'browser-note');
    expect(await (await request.get('/data/' + node.content)).text()).toBe(original);
});

test('后台完整备份入口可以创建并重新校验隔离数据', async ({ page }) => {
    await page.goto('/admin-portal.html');
    await page.getByRole('button', {name:'备份与恢复',exact:true}).click();
    await expect(page.getByRole('button',{name:'创建完整备份',exact:true})).toBeVisible();
    const created = page.waitForResponse(response => response.url().endsWith('/api/admin/backup') && response.request().method() === 'POST');
    await page.getByRole('button',{name:'创建完整备份',exact:true}).click();
    expect((await created).status()).toBe(200);
    await expect(page.getByRole('button',{name:'校验',exact:true}).first()).toBeVisible();
    const verified = page.waitForResponse(response => response.url().endsWith('/api/admin/verify_backup'));
    await page.getByRole('button',{name:'校验',exact:true}).first().click();
    expect((await verified).status()).toBe(200);
});

test('真实浏览器打包版本可通过后端加锁并完整解锁正文', async ({ page, request }) => {
    const original = await (await request.get('/data/notes/browser.md')).text();
    await page.goto('/admin-cms.html?module=notes');
    await expect(page.locator('#grid-container .grid-item.type-note').first()).toBeAttached();
    const locked = await page.evaluate(async () => {
        const K = await import('/data-manage/encrypt/keyring.module.js');
        const C = await import('/data-manage/encrypt/crypto.module.js');
        const L = await import('/data-manage/encrypt/admin-lock.module.js');
        const controller = await import('/custom/cms/admin/cms-controller.module.js');
        const created = await K.createKeyring('BrowserSafetyPassword');
        await K.saveKeyring(created.keyring);
        C.setSessionKeyRaw(created.dekRaw);
        const node = controller.AppState.allNodes.find(item => item.id === 'browser-note');
        const packed = await L.packCmsNodeForLock(node, controller.AppState.lockedNodes);
        const result = await controller.lockNode(node.id, packed.enc, packed.covers, packed.sources);
        return {success:result.success,enc:packed.enc};
    });
    expect(locked.success).toBe(true);
    expect((await request.get('/data/notes/browser.md')).status()).toBe(404);
    const restored = await page.evaluate(async enc => {
        const C = await import('/data-manage/encrypt/crypto.module.js');
        const controller = await import('/custom/cms/admin/cms-controller.module.js');
        const node = await C.decryptRecord(enc, await C.getSessionKey());
        return controller.unlockNode(node.id,node);
    }, locked.enc);
    expect(restored.success).toBe(true);
    const tree = await (await request.get('/api/cms/fetch?module=notes')).json();
    const node = tree.root.find(item => item.id === 'browser-note');
    expect(await (await request.get('/data/' + node.content)).text()).toBe(original);
});

test('后台验证一次后编辑和上传私密文章，发布端始终保留密文', async ({ page, request }) => {
    await page.goto('/admin-cms.html?module=notes');
    await expect(page.locator('#grid-container .grid-item.type-note').first()).toBeAttached();
    await page.evaluate(async () => {
        const K = await import('/data-manage/encrypt/keyring.module.js');
        const C = await import('/data-manage/encrypt/crypto.module.js');
        const L = await import('/data-manage/encrypt/admin-lock.module.js');
        const controller = await import('/custom/cms/admin/cms-controller.module.js');
        const created = await K.createKeyring('BrowserSafetyPassword');
        await K.saveKeyring(created.keyring);
        C.setSessionKeyRaw(created.dekRaw);
        await L.protectCmsNode('notes', 'browser-note');
        await controller.loadData();
    });
    await page.reload();
    const card = page.locator('#grid-container .grid-item.type-note').filter({hasText:'浏览器测试'});
    await expect(card).toBeVisible();
    await expect(page.locator('.locked-card')).toHaveCount(0);
    await card.click();
    await expect(page.locator('#reader-content')).toContainText('正文内容');
    const renamed = page.waitForResponse(response => response.url().includes('action=update'));
    await page.locator('#edit-title-input').fill('私密编辑');
    await page.locator('#edit-title-input').press('Tab');
    expect((await renamed).ok()).toBe(true);
    await page.locator('#btn-open-external').click();
    const source = page.locator('#cms-source-textarea');
    await expect(source).toBeVisible();
    await source.fill('# 私密编辑\n\nPRIVATE_BROWSER_EDIT');
    const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === '/upload');
    await page.locator('#cms-md-img-input').setInputFiles({name:'private.png',mimeType:'image/png',
        buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cM1UAAAAASUVORK5CYII=','base64')});
    expect((await uploaded).ok()).toBe(true);
    await expect(source).toHaveValue(/photos\/images\//);
    const saved = page.waitForResponse(response => response.url().includes('action=update'));
    await page.locator('#btn-save-source').click();
    expect((await saved).ok()).toBe(true);
    const published = await (await request.get('/data/notes-tree.json')).text();
    expect(published).not.toContain('PRIVATE_BROWSER_EDIT');
    expect(published).not.toContain('私密编辑');
    expect((await request.get('/data/notes/browser.md')).status()).toBe(404);
    await page.reload();
    await expect(page.locator('#grid-container .grid-item.type-note').filter({hasText:'私密编辑'})).toBeVisible();
    await page.evaluate(async () => {
        const session = await import('/data-manage/encrypt/admin-session.module.js');
        const crypto = await import('/data-manage/encrypt/crypto.module.js');
        await session.closeAdminSession();
        crypto.clearSessionKey();
    });
    // 桌面启动器使用无扩展名 /admin，必须在主页验证，而不是进入模块后才验证。
    await page.goto('/admin');
    await page.getByPlaceholder('输入主密码...').fill('BrowserSafetyPassword');
    await page.locator('.mlock-overlay [data-act="ok"]').click();
    await expect(page.getByRole('button', {name:'备份与恢复',exact:true})).toBeVisible();
    await expect(page.locator('.mlock-overlay')).toHaveCount(0);
    await page.goto('/admin-cms.html?module=notes');
    await expect(page.locator('#grid-container .grid-item.type-note').filter({hasText:'私密编辑'})).toBeVisible();
    await expect(page.locator('.mlock-overlay')).toHaveCount(0);
});

test('CMS 管理页按钮后注入也能切换整页明亮主题', async ({ page }, info) => {
    await page.addInitScript(() => {
        if (!sessionStorage.getItem('maers-theme-test-seeded')) {
            localStorage.setItem('autoThemeConfig', JSON.stringify({version:2,mode:'manual'}));
            localStorage.setItem('theme', 'dark-mode');
            sessionStorage.setItem('maers-theme-test-seeded', '1');
        }
    });
    await page.goto('/admin-cms.html?module=notes');
    await expect(page.locator('.search-input')).toBeVisible();
    await expect(page.locator('.theme-switch-checkbox')).toBeChecked();
    const darkCard = await page.locator('.main-card').evaluate(element => getComputedStyle(element).backgroundColor);
    await page.locator('.theme-switch-label').click();
    await expect(page.locator('html')).toHaveClass(/light-mode/);
    await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.locator('.main-card')).not.toHaveCSS('background-color', darkCard);
    await expect(page.locator('.mode-icon-sun')).toHaveCSS('opacity', '1');
    await expect(page.locator('#mode-icon')).toHaveCSS('opacity', '0');
    await expect(page.locator('html')).not.toHaveClass(/theme-crossfade|theme-switching/);
    await page.screenshot({path:info.outputPath('light-theme.png')});
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/light-mode/);
    await expect(page.locator('.theme-switch-checkbox')).not.toBeChecked();
});
test('拆分后的更新日志弹窗仍能编辑并持久化', async ({ page, request }) => {
    await page.goto('/admin-index.html');
    await page.locator('#changelog-edit-btn').click();
    await expect(page.locator('#changelog-modal-box')).toBeVisible();
    await page.locator('#cl-new-entries').fill('浏览器回归记录');
    await page.locator('#cl-add-btn').click();
    await page.locator('#cl-save-btn').click();
    await expect(page.locator('#changelog-modal-overlay')).not.toBeVisible();
    const logs = await (await request.get('/data/changelog.json')).json();
    expect(logs[0].entries).toContain('浏览器回归记录');
});

test('密集思维导图紧凑适配，缩放与折叠不重叠、不丢节点连线', async ({ page, isMobile }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const lines = ['- 导图测试'];
    for (let i = 0; i < 6; i++) {
        lines.push('  - 模块 ' + i);
        for (let j = 0; j < 7; j++) lines.push('    - ' + (j === 1
            ? '自动换行的长节点，需要按文字实际边界避让。'.repeat(3) : '步骤 ' + j));
    }
    lines.push('  - 手动<br>换行\\n继续');
    const markdown = ['mindmap', 'markmap'].map(type => '```' + type + '\n' + lines.join('\n') + '\n```').join('\n\n');
    await page.route('**/data/notes/browser.md*', route => route.fulfill({
        status: 200, contentType: 'text/markdown; charset=utf-8', body: markdown
    }));
    await page.goto('/notes.html?openNoteId=browser-note');
    for (const type of ['mindmap', 'markmap']) {
        const card = page.locator('.language-' + type).filter({ has: page.locator('svg[data-mindmap]') });
        const svg = card.locator(':scope > svg');
        await expect(svg.locator('[data-mindmap-node]')).toHaveCount(50);
        await expect(card).toHaveClass(/cms-svg-interactive/);
        const viewport = () => svg.evaluate(element => {
            const m = element.getScreenCTM(), frame = element.getBoundingClientRect();
            return { scale: m.a, x: (frame.x + frame.width / 2 - m.e) / m.a,
                y: (frame.y + frame.height / 2 - m.f) / m.d };
        });
        const expectViewport = async before => {
            await expect.poll(async () => {
                const after = await viewport();
                return Math.max(...Object.keys(before).map(key => Math.abs(before[key] - after[key])));
            }).toBeLessThan(0.001);
        };
        const inlineView = await viewport();
        await card.locator('.cms-diagram-fs-btn').click();
        await expectViewport(inlineView);
        const geometry = async (fit = false) => {
            const result = await svg.evaluate(element => {
                const boxes = [...element.querySelectorAll('[data-mindmap-node] > rect')].map(rect => rect.getBoundingClientRect().toJSON());
                const frame = element.getBoundingClientRect();
                return { count: boxes.length, edges: element.querySelectorAll('path').length,
                    overlap: boxes.some((a, i) => boxes.slice(i + 1).some(b =>
                        a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom)),
                    fits: boxes.every(a => a.x >= frame.x - 1 && a.right <= frame.right + 1 && a.y >= frame.y - 1 && a.bottom <= frame.bottom + 1) };
            });
            expect(result.overlap).toBe(false);
            expect(result.edges).toBe(result.count - 1);
            if (fit) expect(result.fits).toBe(true);
        };
        await geometry(true);
        if (isMobile) {
            const touch = await page.context().newCDPSession(page);
            const send = (type, touchPoints) => touch.send('Input.dispatchTouchEvent', { type, touchPoints });
            const root = svg.locator('[role="button"][aria-label="导图测试"]');
            await root.tap();
            await expect(svg.locator('[data-mindmap-node]')).toHaveCount(1);
            await root.tap();
            await expect(svg.locator('[data-mindmap-node]')).toHaveCount(50);
            await expect(svg).not.toHaveAttribute('data-mindmap-animating', 'true');
            const rect = await root.locator('rect').boundingBox();
            // 从可折叠节点开始双指缩放，同时移动中心；随后保持间距进行双指平移。
            let points = [{ id: 1, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }];
            points.push({ id: 2, x: points[0].x + 60, y: points[0].y });
            const before = await viewport();
            await send('touchStart', points);
            const beforePinch = await svg.getAttribute('viewBox');
            points = points.map((p, i) => ({ ...p, x: p.x + (i ? 24 : -12), y: p.y + 12 }));
            await send('touchMove', points);
            await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(beforePinch);
            expect((await viewport()).scale / before.scale).toBeCloseTo(1.6, 1);
            const scaled = await viewport();
            const beforePan = await svg.getAttribute('viewBox');
            points = points.map(p => ({ ...p, x: p.x + 12, y: p.y + 8 }));
            await send('touchMove', points);
            await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(beforePan);
            const panned = await viewport();
            expect(panned.scale).toBeCloseTo(scaled.scale, 5);
            expect((scaled.x - panned.x) * scaled.scale).toBeCloseTo(12, 1);
            expect((scaled.y - panned.y) * scaled.scale).toBeCloseTo(8, 1);
            // 松开一指不跳动，剩余一指可继续拖动，手势后不误触折叠。
            await send('touchEnd', points.slice(1));
            expect((await viewport()).scale).toBeCloseTo(panned.scale, 5);
            const beforeOneFinger = await svg.getAttribute('viewBox');
            points = [{ ...points[0], x: points[0].x + 10, y: points[0].y + 6 }];
            await send('touchMove', points);
            await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(beforeOneFinger);
            expect((panned.x - (await viewport()).x) * panned.scale).toBeCloseTo(10, 1);
            await send('touchEnd', []);
            await expect(root).toHaveAttribute('aria-expanded', 'true');
            await expect(svg.locator('[data-mindmap-node]')).toHaveCount(50);
            await expect(card).not.toHaveClass(/cms-svg-dragging/);
            await touch.detach();
        }
        const frame = await svg.boundingBox();
        await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
        for (const delta of [300, -600, 300]) {
            const before = await svg.getAttribute('viewBox');
            await page.mouse.wheel(0, delta);
            await expect.poll(() => svg.getAttribute('viewBox')).not.toBe(before);
            await geometry();
        }
        const branch = svg.locator('[role="button"][aria-label="模块 2"]');
        const motion = await branch.evaluate(async element => {
            const svg = element.ownerSVGElement;
            element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            const active = svg.hasAttribute('data-mindmap-animating');
            const before = [...svg.querySelectorAll('path')].map(path => path.getAttribute('d'));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return { active, moving: [...svg.querySelectorAll('path')].some((path, i) => path.getAttribute('d') !== before[i]),
                ghost: [...svg.querySelectorAll('[data-mindmap-node], path')].some(node => getComputedStyle(node).opacity !== '1') };
        });
        expect(motion).toEqual({ active: true, moving: true, ghost: false });
        await expect(svg.locator('[data-mindmap-node]')).toHaveCount(43);
        await geometry();
        await branch.focus();
        await branch.press('Enter');
        await expect(svg).not.toHaveAttribute('data-mindmap-animating', 'true');
        await expect(svg.locator('[data-mindmap-node]')).toHaveCount(50);
        await expect(branch).toBeFocused();
        await geometry();
        await branch.evaluate(element => {
            const svg = element.ownerSVGElement;
            for (let i = 0; i < 2; i++) svg.querySelector('[aria-label="模块 2"]')
                .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await expect(svg).not.toHaveAttribute('data-mindmap-animating', 'true');
        await expect(svg.locator('[data-mindmap-node]')).toHaveCount(50);
        await geometry();
        const view = await viewport();
        await page.keyboard.press('Escape');
        await expect(card).not.toHaveClass(/cms-diagram-card--fullscreen/);
        await expectViewport(view);
        expect(await card.evaluate(element => element.clientHeight)).toBeLessThanOrEqual(420);
        await geometry();
    }
    expect(errors).toEqual([]);
});
