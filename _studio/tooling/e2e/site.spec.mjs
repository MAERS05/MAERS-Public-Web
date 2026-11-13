/** 页面渲染、阅读器交互与真实鉴权保存的浏览器回归。 */
import { test, expect } from './fixtures.mjs';
async function openGitModal(page) {
    await page.evaluate(async () => {
        const { gitCommitManager } = await import('/data-manage/sync/git-commit.module.js');
        await gitCommitManager.openCommitModal();
    });
}

/** 点击只代表事件已派发；确认写入和保存状态后再刷新，避免中断请求。 */
async function saveCardsAndReload(page, endpoint) {
    const button = page.locator('#global-save-btn');
    const [response] = await Promise.all([
        page.waitForResponse(result => new URL(result.url()).pathname === endpoint && result.request().method() === 'POST'),
        button.click()
    ]);
    expect(response.ok()).toBe(true);
    await expect(button).toHaveText('✅ 已保存');
    await page.reload();
}

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
    await openGitModal(page);
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
    await openGitModal(page);
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
        await openGitModal(page);
        await expect(page.locator('#git-env-text')).toHaveText('本地模式');
        await expect(page.locator('#git-cloud-config-drawer')).not.toBeVisible();
        await expect(page.locator('#git-modal-submit')).toBeDisabled();
        await expect(page.locator('#git-changes-panel')).toContainText(state === '旧版' ? '完整退出后台' : '暂时没有响应');
        expect(pushes).toBe(0);
    });
}

test('云端同步入口与草稿弹窗准确说明待电脑合并', async ({ page }) => {
    let count = 2, unavailable = false;
    await page.route(/\/relay-fixture\/api\/pull(?:\?|$)/, route => route.fulfill({
        status: unavailable ? 503 : 200,
        json: {
            items: Array.from({ length: count }, (_, index) => ({
                key: `draft-${index}`,
                data: { module: 'space', action: 'update_tags', data: { id: `site-${index}`, tags: [] } }
            }))
        }
    }));
    await page.goto('/admin-portal.html');
    await expect(page.locator('#maers-sync-btn')).toBeVisible();
    await page.evaluate(async () => {
        const { syncManager } = await import('/data-manage/sync/sync-manager.module.js');
        syncManager.isLocalHost = () => false;
        syncManager.config.relay = {endpoint:`${location.origin}/relay-fixture`,secret:'mock'};
        await syncManager.checkPendingRelayItems();
    });
    const toolbar = page.locator('#maers-sync-btn');
    await expect(toolbar).toHaveText('云端草稿(2)');
    await expect(toolbar).toHaveAttribute('title', /电脑本地后台拉取合并/);
    await toolbar.click();
    const title = page.locator('[data-role="git-count-title"]');
    await expect(title).toHaveText('待电脑合并草稿(2)');
    await expect(page.locator('#maers-sync-modal')).not.toContainText('Git 一键提交');
    count = 3;
    await page.evaluate(async () => {
        const { syncManager } = await import('/data-manage/sync/sync-manager.module.js');
        await syncManager.checkPendingRelayItems();
    });
    await expect(title).toHaveText('待电脑合并草稿(3)');
    await expect(toolbar).toHaveText('云端草稿(3)');
    await page.locator('#btn-open-git-commit').click();
    await expect(page.locator('#maers-git-commit-modal .mlock-title')).toHaveText('云端草稿');
    await expect(page.locator('#git-changes-panel')).toContainText('待电脑合并草稿 3 条');
    await expect(page.locator('#git-modal-submit')).toBeDisabled();
    await expect(page.locator('#git-modal-submit')).toHaveText('待电脑合并后发布');
    await page.locator('#git-modal-cancel').click();

    count = 0;
    await toolbar.click();
    await page.locator('#btn-open-git-commit').click();
    await expect(page.locator('#git-changes-panel')).toContainText('队列为空');
    await expect(page.locator('#git-changes-panel')).not.toContainText('已安全保存');
    await page.locator('#git-modal-cancel').click();
    unavailable = true;
    await toolbar.click();
    await page.locator('#btn-open-git-commit').click();
    await expect(page.locator('#git-changes-panel')).toContainText('读取草稿失败');
    await expect(page.locator('#git-changes-panel')).not.toContainText('队列为空');
});

for (const module of ['literature', 'games', 'videos']) {
    test(`手机上传封面按真实图片索引展示：${module}`, async ({ page, request }) => {
        const seeded = await request.post('/__test/cloud-covers');
        expect(seeded.ok()).toBeTruthy();
        const row = (await seeded.json())[module];
        expect(row.thumb).toMatch(/^photos\/thumbnails\/[^/]+\/[^/]+\.webp$/);
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
        await expect(cover).toHaveAttribute('src', row.thumb);
        await expect.poll(() => cover.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
        await expect.poll(() => imageResponses.some(response => response.path === `/${row.thumb}`
            && response.status === 200)).toBe(true);
        if (module === 'games') {
            const url = await page.evaluate(async coverImage => {
                const { GamesView } = await import('/custom/games/viewer/games-view.module.js');
                return GamesView._getCoverUrl({ coverImage });
            }, row.path);
            expect(url).toBe(row.thumb);
        }
        expect(imageErrors).toEqual([]);
    });
}

for (const target of [
    { name: '首页', page: '/admin-index.html', save: '/api/save_index_cards', card: '.nav-card' },
    { name: '门户', page: '/admin-portal.html', save: '/api/save_modules', card: '.admin-card' }
]) {
    test(`${target.name}卡片新增失败可重试且编辑删除仍可保存`, async ({ page }) => {
        let rejectSave = true;
        await page.route(`**${target.save}`, route => rejectSave
            ? route.fulfill({ status: 500, json: { error: 'test failure' } })
            : route.continue());
        await page.goto(target.page);
        await page.locator('.functional-card').click();
        const modal = page.locator('.admin-modal');
        await modal.locator('[name="title"]').fill('新增入口');
        await modal.locator('[name="icon"]').fill('📝');
        await modal.locator('[name="url"]').fill('https://example.test');
        if (target.name === '首页') await modal.locator('[name="description"]').fill('入口说明');
        await modal.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(modal).toBeVisible();
        await expect(modal.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
        await expect(page.locator(target.card).filter({ hasText: '新增入口' })).toHaveCount(0);
        rejectSave = false;
        await modal.getByRole('button', { name: 'Create', exact: true }).click();
        await expect(modal).toHaveCount(0);
        const created = page.locator(target.card).filter({ hasText: '新增入口' });
        await expect(created).toHaveCount(1);
        await created.hover();
        await created.getByTitle('重命名', { exact: true }).click();
        await modal.locator('[name="title"]').fill('重命名入口');
        await modal.getByRole('button', { name: 'Save', exact: true }).click();
        await saveCardsAndReload(page, target.save);
        const renamed = page.locator(target.card).filter({ hasText: '重命名入口' });
        await expect(renamed).toHaveCount(1);
        await renamed.hover();
        await renamed.getByTitle('删除/恢复', { exact: true }).click();
        await saveCardsAndReload(page, target.save);
        await expect(renamed).toHaveCount(0);
    });
}

test('网页信息回填与中英文逗号标签经过通用表单保存', async ({ page, request }) => {
    await page.route('**/api/space/fetch_meta', route => route.fulfill({ json: {
        title: '抓取的网站', description: '测试描述', icon_url: '/ui/logo.svg'
    } }));
    await page.goto('/admin-space.html');
    await page.locator('.add-card-wrapper').click();
    const modal = page.locator('.admin-modal');
    await modal.locator('[name="url"]').fill('https://example.test');
    await modal.locator('.btn-fetch-meta').click();
    await expect(modal.locator('[name="name"]')).toHaveValue('抓取的网站');
    await expect(modal.locator('[name="content"]')).toHaveValue('测试描述');
    await expect(modal.locator('[name="icon"]')).toHaveValue('/ui/logo.svg');
    await modal.locator('[name="tags"]').fill('技术， 收藏,  资料');
    await modal.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(modal).toHaveCount(0);
    const tree = await (await request.get('/data/space-tree.json')).json();
    expect(tree.root[0].tags).toEqual(['技术', '收藏', '资料']);
    expect(tree.root[0].name).toBe('抓取的网站');
});

test('首页卡片与深浅色、移动端布局', async ({ page, pageErrors }, info) => {
    await page.goto('/index.html');
    await expect(page.locator('.nav-card').first()).toBeVisible();
    await expect(page.locator('html')).toHaveClass(info.project.name.includes('light') ? /light-mode/ : /^(?!.*light-mode).*$/);
    const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(size.width).toBeLessThanOrEqual(size.viewport + 2);
    await page.locator('.nav-card').first().click();
    await expect(page).toHaveURL(/\/notes$/);
    expect(pageErrors).toEqual([]);
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

test('本地后台登记后免密管理全部，长按 Logo 只负责跳转', async ({ page }, info) => {
    await page.goto('/admin');
    await expect(page.getByRole('button', { name: '加密设置' })).toBeVisible();
    await page.evaluate(async () => {
        const K = await import('/data-manage/encrypt/keyring.module.js');
        const C = await import('/data-manage/encrypt/crypto.module.js');
        const { localFetch } = await import('/data-manage/api-client.module.js');
        const admin = await K.createKeyring('LocalAdminPassword');
        const group = await K.createKeyring('LocalGroupPassword');
        const id = 'g_' + 'a'.repeat(32);
        const key = await C.importDataKey(admin.dekRaw);
        await K.saveKeyring({ ...admin.keyring, master_only: true, groups: {
            [id]: { ...group.keyring, name: '本地自动组',
                master_wrap: await K.wrapMasterGroup(id, group.keyring, group.dekRaw, key) }
        } });
        C.setSessionKeyRaw(admin.dekRaw);
        C.setSessionKeyRaw(group.dekRaw, id);
        const rows = [await C.wrapRecord({ id: 'private-card', title: '自动管理内容', url: 'notes.html' },
            await C.importDataKey(group.dekRaw), id)];
        const response = await localFetch('/api/save_index_cards', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows)
        });
        if (!response.ok) throw Error('本机登记夹具创建失败');
        C.clearSessionKey();
    });
    await page.goto('/index.html');
    const logo = page.locator('#brand-logo');
    await expect(logo).toBeVisible();
    const box = await logo.boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (info.project.use.isMobile) {
        const touch = await page.context().newCDPSession(page);
        try {
            await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            await expect(page.getByRole('dialog')).toContainText('是否跳转后台？');
            await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } finally { await touch.detach(); }
    } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await expect(page.getByRole('dialog')).toContainText('是否跳转后台？');
        await page.mouse.up();
    }
    await page.getByRole('dialog').getByRole('button', { name: '是', exact: true }).click();
    await expect(page).toHaveURL(/\/admin-portal$/);
    await expect(page.locator('#admin-grid .admin-card').first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goto('/index.html');
    await expect(page.locator('#private-card')).toBeVisible();
    await page.evaluate(() => sessionStorage.clear());
    await page.goto('/admin');
    await expect(page.locator('#admin-grid .admin-card').first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('首页 Logo 取消长按且保留单击缩放', async ({ page }) => {
    await page.goto('/index.html');
    const logo = page.locator('#brand-logo');
    await expect(logo).toBeVisible();
    await page.clock.install({ time: new Date('2026-10-27T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-27T00:00:01Z'));
    const pointer = { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 10, clientY: 10 };
    for (const type of ['pointerup', 'pointercancel', 'pointermove', 'pointerleave', 'blur', 'multitouch']) {
        await logo.dispatchEvent('pointerdown', pointer);
        await page.clock.runFor(1499);
        await expect(page).toHaveURL(/\/$/);
        if (type === 'blur') {
            await page.evaluate(() => window.dispatchEvent(new Event('blur')));
        } else if (type === 'multitouch') {
            await logo.dispatchEvent('pointerdown', { ...pointer, pointerId: 2, isPrimary: false });
        } else {
            await logo.dispatchEvent(type, { ...pointer, clientX: type === 'pointermove' ? 30 : 10 });
        }
        await page.clock.runFor(1600);
        await expect(page).toHaveURL(/\/$/);
        await expect(page.locator('.mlock-overlay')).toHaveCount(0);
    }
    await logo.click();
    await expect(page.locator('html')).toHaveClass(/shrink-view/);
    await expect(page).toHaveURL(/\/$/);
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
test('打开阅读器并跟随双链', async ({ page, pageErrors }) => {
    await page.goto('/notes.html?openNoteId=browser-note');
    await expect(page.locator('#reader-content h1')).toHaveText('浏览器测试');
    await page.locator('#reader-content .cms-wikilink').click();
    await expect(page.locator('#reader-content h1')).toHaveText('第二篇');
    await page.locator('#immersive-reader .close-btn').click();
    await expect(page.locator('#immersive-reader')).not.toHaveClass(/active/);
    await expect(page.locator('#immersive-reader')).toHaveCSS('opacity', '0');
    await expect(page.locator('#immersive-reader')).toHaveCSS('pointer-events', 'none');
    expect(pageErrors).toEqual([]);
});
for (const renderer of ['vditor', 'plain-text']) {
    test(`阅读器阻止 HTML 脚本执行：${renderer}`, async ({ page }) => {
        const markdown = '# 安全阅读\n\n<img src="/__missing_probe.png" onerror="window.__readerXssProbe=1">\n'
            + '<svg onload="window.__readerXssProbe=1"></svg>\n'
            + '<a href="javascript:window.__readerXssProbe=1">危险链接</a>';
        if (renderer !== 'vditor') {
            await page.route('**/plugins/vditor-assets/method.min.js*', route => route.abort());
        }
        await page.route('**/markdown/notes/browser.md*', route => route.fulfill({
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
    await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('# 已保存正文\n\n通过浏览器验证。');
    const saved = page.waitForResponse(r => r.url().includes('/api/cms/node') && r.request().method() === 'POST');
    await page.locator('#btn-save-source').click();
    expect((await saved).status()).toBe(200);
    const tree = await (await request.get('/api/cms/fetch?module=notes')).json();
    const note = tree.root.find(node => node.id === 'browser-note');
    expect(await (await request.get('/' + note.content)).text()).toContain('已保存正文');
    await page.reload();
    await expect(page.locator('#reader-content h1')).toHaveText('已保存正文');
});

test('正文读取失败时禁止覆盖，只改标题保留真实正文', async ({ page, request }) => {
    const original = await (await request.get('/markdown/notes/browser.md')).text();
    const writes = [];
    page.on('request', req => {
        if (req.method() === 'POST' && req.url().includes('/api/cms/node')) writes.push(req.postDataJSON());
    });
    await page.route('**/markdown/notes/browser.md*', route => route.fulfill({status:503, body:'offline'}));
    await page.goto('/admin-cms.html?module=notes&openNoteId=browser-note');
    await expect(page.locator('#reader-content')).toContainText('文档加载失败');
    await page.locator('#btn-toggle-source').click();
    await page.getByRole('textbox', { name: 'Markdown 源码' }).fill('不应写入磁盘');
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
    expect(await (await request.get('/' + node.content)).text()).toBe(original);
});

test('后台完整备份入口可以创建并重新校验隔离数据', async ({ page }) => {
    await page.goto('/admin-portal.html');
    await page.getByRole('button', {name:'备份与恢复',exact:true}).click();
    await expect(page.getByRole('button',{name:'备份本机',exact:true})).toBeVisible();
    const created = page.waitForResponse(response => response.url().endsWith('/api/admin/backup') && response.request().method() === 'POST');
    await page.getByRole('button',{name:'备份本机',exact:true}).click();
    expect((await created).status()).toBe(200);
    await expect(page.getByRole('button',{name:'校验',exact:true}).first()).toBeVisible();
    const verified = page.waitForResponse(response => response.url().endsWith('/api/admin/verify_backup'));
    await page.getByRole('button',{name:'校验',exact:true}).first().click();
    expect((await verified).status()).toBe(200);
});

test('真实浏览器打包版本可通过后端加锁并完整解锁正文', async ({ page, request }) => {
    const original = await (await request.get('/markdown/notes/browser.md')).text();
    await page.goto('/admin-cms.html?module=notes');
    await expect(page.locator('#grid-container .grid-item.type-note').first()).toBeAttached();
    const locked = await page.evaluate(async () => {
        const K = await import('/data-manage/encrypt/keyring.module.js');
        const C = await import('/data-manage/encrypt/crypto.module.js');
        const L = await import('/data-manage/encrypt/admin-lock.module.js');
        const controller = await import('/custom/cms/admin/cms-controller.module.js');
        const created = await K.createKeyring('BrowserSafetyPassword');
        const content = await K.createKeyring('ContentGroupPassword');
        const group = 'g_' + 'a'.repeat(32);
        const master = await C.importDataKey(created.dekRaw);
        await K.saveKeyring({ ...created.keyring, master_only: true, groups: {
            [group]: { ...content.keyring, name: '正文组',
                master_wrap: await K.wrapMasterGroup(group, content.keyring, content.dekRaw, master) }
        } });
        C.setSessionKeyRaw(created.dekRaw);
        C.setSessionKeyRaw(content.dekRaw, group);
        const node = controller.AppState.allNodes.find(item => item.id === 'browser-note');
        const packed = await L.packCmsNodeForLock(node, controller.AppState.lockedNodes, { group });
        const result = await controller.lockNode(node.id, packed.enc, packed.covers, packed.sources, packed.group);
        return {success:result.success,enc:packed.enc,group:packed.group};
    });
    expect(locked.success).toBe(true);
    expect((await request.get('/markdown/notes/browser.md')).status()).toBe(200);
    expect((await request.post('/__test/publish')).ok()).toBeTruthy();
    expect((await request.get('/__test/published/markdown/notes/browser.md')).status()).toBe(404);
    expect(await (await request.get('/__test/published/data/notes-tree.json')).text()).not.toContain('浏览器测试');
    const restored = await page.evaluate(async ({enc, group}) => {
        const C = await import('/data-manage/encrypt/crypto.module.js');
        const controller = await import('/custom/cms/admin/cms-controller.module.js');
        const node = await C.decryptRecord(enc, await C.getSessionKey(group));
        return controller.unlockNode(node.id,node);
    }, locked);
    expect(restored.success).toBe(true);
    const tree = await (await request.get('/api/cms/fetch?module=notes')).json();
    const node = tree.root.find(item => item.id === 'browser-note');
    expect(await (await request.get('/' + node.content)).text()).toBe(original);
});

test('相册解密按钮先分流，换组保留密文，确认解密才恢复公开', async ({ page, request }, info) => {
    await page.goto('/admin-album.html');
    await expect(page.locator('#category-grid .func-card')).toBeVisible();
    const sourceGroup = 'g_' + 'c'.repeat(32);
    const targetGroup = 'g_' + 'd'.repeat(32);
    await page.evaluate(async ({group, targetGroup}) => {
        const K = await import('/data-manage/encrypt/keyring.module.js');
        const C = await import('/data-manage/encrypt/crypto.module.js');
        const L = await import('/data-manage/encrypt/admin-lock.module.js');
        const { localFetch } = await import('/data-manage/api-client.module.js');
        const primary = await K.createKeyring('AlbumBrowserPassword');
        const secondary = await K.createKeyring('AlbumGroupPassword');
        const target = await K.createKeyring('AlbumTargetPassword');
        const master = await C.importDataKey(primary.dekRaw);
        primary.keyring.master_only = true;
        primary.keyring.groups = {
            [group]: { ...secondary.keyring, name: '相册测试组',
                master_wrap: await K.wrapMasterGroup(group, secondary.keyring, secondary.dekRaw, master) },
            [targetGroup]: { ...target.keyring, name: '相册目标组',
                master_wrap: await K.wrapMasterGroup(targetGroup, target.keyring, target.dekRaw, master) }
        };
        await K.saveKeyring(primary.keyring);
        C.setSessionKeyRaw(primary.dekRaw);
        C.setSessionKeyRaw(secondary.dekRaw, group);
        C.setSessionKeyRaw(target.dekRaw, targetGroup);
        const response = await localFetch('/api/add_category', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'private-demo', title: '相册解密测试' })
        });
        if (!response.ok || !await L.lockAlbumCategoryFlow('private-demo', { group })) {
            throw new Error('加密相册夹具创建失败');
        }
    }, {group:sourceGroup, targetGroup});
    await page.reload();

    const card = page.locator('.category-card').filter({ hasText: '相册解密测试' });
    const dialog = page.getByRole('dialog');
    const openActions = async () => {
        await card.hover();
        await card.getByTitle('解密或更换加密组', { exact: true }).click();
        await expect(dialog.locator('.mlock-title')).toHaveText('解密或更换加密组');
    };
    const publishedAlbum = async () => (await (await request.get('/data/album-config.json')).json())[0];
    await openActions();
    await expect(dialog.getByLabel('密码组', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '解密', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect((await publishedAlbum())._group).toBe(sourceGroup);

    await openActions();
    await dialog.getByRole('button', { name: '更换密码组', exact: true }).click();
    const target = dialog.getByRole('group', { name: '密码组', exact: true });
    await expect(target.getByRole('button')).toHaveText(['当前:相册测试组', '相册目标组']);
    await expect(target.getByRole('button').first()).toBeDisabled();
    await target.getByRole('button', { name: '相册目标组', exact: true }).click();
    await expect(target.getByRole('button', { name: '相册目标组', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await Promise.all([
        page.waitForEvent('framenavigated'),
        dialog.getByRole('button', { name: '更换', exact: true }).click()
    ]);
    const reassigned = await publishedAlbum();
    expect(reassigned._enc).toMatch(/^enc:/);
    expect(reassigned._group).toBe(targetGroup);

    await openActions();
    page.once('dialog', confirmation => confirmation.accept());
    await dialog.getByRole('button', { name: '解密', exact: true }).click();
    await expect.poll(async () => (await publishedAlbum()).id).toBe('private-demo');
    await expect(card.getByTitle('对外加密此相册', { exact: true })).toBeAttached();
});

test('后台验证一次后编辑和上传私密文章，发布端不包含私密内容', async ({ page, request }) => {
    await page.goto('/admin-cms.html?module=notes');
    await expect(page.locator('#grid-container .grid-item.type-note').first()).toBeAttached();
    const protectedRecord = await page.evaluate(async () => {
        const K = await import('/data-manage/encrypt/keyring.module.js');
        const C = await import('/data-manage/encrypt/crypto.module.js');
        const L = await import('/data-manage/encrypt/admin-lock.module.js');
        const controller = await import('/custom/cms/admin/cms-controller.module.js');
        const created = await K.createKeyring('BrowserSafetyPassword');
        await K.saveKeyring(created.keyring);
        C.setSessionKeyRaw(created.dekRaw);
        const protectedRecord = await L.protectCmsNode('notes', 'browser-note', 'default');
        await controller.loadData();
        return protectedRecord;
    });
    expect(protectedRecord).toBe(true);
    expect((await request.post('/__test/publish')).ok()).toBeTruthy();
    expect(await (await request.get('/__test/published/data/notes-tree.json')).text()).not.toContain('浏览器测试');
    expect((await request.get('/__test/published/markdown/notes/browser.md')).status()).toBe(404);
    await page.reload();
    const card = page.locator('#grid-container .grid-item.type-note').filter({hasText:'浏览器测试'});
    await expect(card).toBeVisible();
    await expect(page.locator('.locked-card')).toHaveCount(0);
    await card.hover();
    await card.getByTitle('解密或更换加密组', { exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await card.click();
    await expect(page.locator('#reader-content')).toContainText('正文内容');
    const renamed = page.waitForResponse(response => response.url().includes('action=update'));
    await page.locator('#edit-title-input').fill('私密编辑');
    await page.locator('#edit-title-input').press('Tab');
    expect((await renamed).ok()).toBe(true);
    await expect(page.locator('.toast-success').last()).toContainText('标题已更新');
    await page.locator('#btn-open-external').click();
    const drawer = page.locator('#cms-source-drawer');
    await expect(drawer).not.toHaveClass(/collapsed/);
    const source = page.getByRole('textbox', { name: 'Markdown 源码' });
    await expect(source).toBeVisible();
    await source.fill('# 私密编辑\n\nPRIVATE_BROWSER_EDIT');
    const [uploaded] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/upload'),
        page.locator('#cms-md-img-input').setInputFiles({name:'private.png',mimeType:'image/png',
            buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cM1UAAAAASUVORK5CYII=','base64')})
    ]);
    expect(uploaded.ok()).toBe(true);
    await expect(source).toContainText(/photos\/images\//);
    await expect(drawer).not.toHaveClass(/collapsed/);
    const [saved] = await Promise.all([
        page.waitForResponse(response => response.url().includes('action=update')),
        page.locator('#btn-save-source').click()
    ]);
    expect(saved.ok()).toBe(true);
    expect((await request.post('/__test/publish')).ok()).toBeTruthy();
    const published = await (await request.get('/__test/published/data/notes-tree.json')).text();
    expect(published).not.toContain('PRIVATE_BROWSER_EDIT');
    expect(published).not.toContain('私密编辑');
    expect((await request.get('/__test/published/markdown/notes/browser.md')).status()).toBe(404);
    await page.reload();
    await expect(page.locator('#grid-container .grid-item.type-note').filter({hasText:'私密编辑'})).toBeVisible();
    await page.evaluate(async () => {
        const session = await import('/data-manage/encrypt/admin-session.module.js');
        const crypto = await import('/data-manage/encrypt/crypto.module.js');
        const { localFetch } = await import('/data-manage/api-client.module.js');
        const disabled = await localFetch('/api/crypto/local-access', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
        if (!disabled.ok) throw Error('关闭本机免密失败');
        await session.closeAdminSession();
        crypto.clearSessionKey();
    });
    // 桌面启动器使用无扩展名 /admin，必须在主页验证，而不是进入模块后才验证。
    await page.goto('/admin');
    const unlockDialog = page.getByRole('dialog');
    await unlockDialog.getByPlaceholder('输入主密码...').fill('BrowserSafetyPassword');
    await unlockDialog.getByRole('button', { name: '确定', exact: true }).click();
    await expect(page.getByRole('button', {name:'备份与恢复',exact:true})).toBeVisible();
    await expect(page.locator('.mlock-overlay')).toHaveCount(0);
    await page.evaluate(() => { location.href = '/admin-cms.html?module=notes'; });
    await expect(page).toHaveURL(/\/admin-cms\?module=notes$/);
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
