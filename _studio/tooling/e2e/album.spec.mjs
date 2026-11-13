/** 相册分类回归：写入确认、失败重试、读取异常及新增时保留未保存编辑。 */
import { test, expect } from './fixtures.mjs';

async function openSeededAlbum(page) {
    await page.goto('/admin-album.html');
    await expect(page.locator('.func-card')).toBeVisible();
    await page.evaluate(async () => {
        const { localFetch } = await import('/data-manage/api-client.module.js');
        const response = await localFetch('/api/add_category', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'existing', title: '原分类', subtitle: 'Existing', icon: '📷' })
        });
        if (!response.ok) throw new Error(`准备分类失败：HTTP ${response.status}`);
    });
    await page.reload();
    await expect(page.locator('#category-grid .card-title')).toHaveText('原分类');
}

async function renameCategory(page, title) {
    const card = page.locator('.category-card').filter({ hasText: '原分类' });
    await card.hover();
    await card.getByTitle('重命名', { exact: true }).click();
    const modal = page.locator('.admin-modal');
    await modal.locator('[name="title"]').fill(title);
    await modal.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(modal).toHaveCount(0);
}

async function fillNewCategory(page) {
    await page.locator('.func-card').click();
    const modal = page.locator('.admin-modal');
    await modal.locator('[name="title"]').fill('新分类');
    await modal.locator('[name="subtitle"]').fill('Created');
    await modal.locator('[name="icon"]').fill('📷');
    await modal.locator('[name="id"]').fill('created');
    return modal;
}

test('相册新增保留待保存编辑，保存确认后不依赖额外读取', async ({ page, request, pageErrors }) => {
    await openSeededAlbum(page);
    await renameCategory(page, '待保存分类');
    let reads = 0;
    await page.route('**/data/album-config.json*', route => {
        reads++;
        return route.fulfill({ status: 503, body: 'offline' });
    });
    const modal = await fillNewCategory(page);
    await modal.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('#category-grid .card-title')).toHaveText(['待保存分类', '新分类']);
    await expect(page.locator('.global-save-bar')).toHaveClass(/active/);
    const beforeSave = await (await request.get('/data/album-config.json')).json();
    expect(beforeSave.map(item => item.title)).toEqual(['原分类', '新分类']);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/reorder_category'));
    await page.locator('#global-save-btn').click();
    expect((await saved).ok()).toBe(true);
    await expect(page.locator('.toast-success').last()).toContainText('保存');
    expect(reads).toBe(0);
    await page.unroute('**/data/album-config.json*');
    await page.reload();
    await expect(page.locator('#category-grid .card-title')).toHaveText(['待保存分类', '新分类']);
    expect(pageErrors).toEqual([]);
});

test('相册保存被拒绝时保留编辑并可重试', async ({ page, request, pageErrors }) => {
    await openSeededAlbum(page);
    await renameCategory(page, '重试后保存');
    let reject = true;
    await page.route('**/api/update_category', route => reject
        ? route.fulfill({ status: 500, json: { error: 'test failure' } }) : route.continue());
    await page.locator('#global-save-btn').click();
    await expect(page.locator('.toast-error').last()).toContainText('保存分类失败：test failure');
    await expect(page.locator('#global-save-btn')).toBeEnabled();
    await expect(page.locator('.global-save-bar')).toHaveClass(/active/);
    await expect(page.locator('#category-grid .card-title')).toHaveText('重试后保存');
    expect((await (await request.get('/data/album-config.json')).json())[0].title).toBe('原分类');
    reject = false;
    const saved = page.waitForResponse(response => response.url().endsWith('/api/reorder_category'));
    await page.locator('#global-save-btn').click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(page.locator('#category-grid .card-title')).toHaveText('重试后保存');
    expect(pageErrors).toEqual([]);
});

test('相册初始配置无效时停止编辑，刷新后可重新创建', async ({ page, request, pageErrors }) => {
    await page.route('**/data/album-config.json*', route => route.fulfill({ json: { invalid: true } }));
    await page.goto('/admin-album.html');
    await expect(page.locator('.toast-error').last()).toContainText('分类数据格式无效');
    await expect(page.locator('.func-card')).toHaveCount(0);
    await page.unroute('**/data/album-config.json*');
    await page.reload();
    await page.route('**/api/add_category', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: 'invalid resource feedback' });
    });
    const modal = await fillNewCategory(page);
    await modal.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('#category-grid .card-title')).toHaveText('新分类');
    expect((await (await request.get('/data/album-config.json')).json()).map(item => item.id)).toEqual(['created']);
    expect(pageErrors).toEqual([]);
});

test('带标签图库正常初始化，筛选与右键删除标签可持久化', async ({ page, request, pageErrors }) => {
    const initializationErrors = [];
    page.on('console', message => {
        if (message.type() === 'error' && message.text().includes('[MAERS Photos]')) initializationErrors.push(message.text());
    });
    await openSeededAlbum(page);
    await page.evaluate(async () => {
        const { localFetch } = await import('/data-manage/api-client.module.js');
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cM1UAAAAASUVORK5CYII='), value => value.charCodeAt(0));
        const uploaded = await localFetch('/upload?category=existing&name=tags.png', {
            method: 'POST', body: new Blob([bytes], { type: 'image/png' })
        });
        if (!uploaded.ok) throw new Error(`准备图片失败：HTTP ${uploaded.status}`);
        const photo = await uploaded.json();
        const tagged = await localFetch('/api/photos/update_tags', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: photo.id, tags: ['标签一', '标签二'] })
        });
        if (!tagged.ok) throw new Error(`准备标签失败：HTTP ${tagged.status}`);
    });
    await page.goto('/admin-photos.html?id=existing');
    const tags = page.locator('#gallery-container .photo-tag-chip');
    await expect(tags).toHaveText(['标签一', '标签二']);
    await expect(page.locator('#global-save-btn')).toBeAttached();
    await tags.filter({ hasText: '标签一' }).click();
    await expect(tags.filter({ hasText: '标签一' })).toHaveClass(/active/);
    await tags.filter({ hasText: '标签二' }).click({ button: 'right' });
    await expect(page.locator('.tag-context-menu')).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    const [saved] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/photos/update_tags'
            && response.request().method() === 'POST'),
        page.locator('.tag-context-menu .delete-option').click()
    ]);
    expect(saved.ok()).toBe(true);
    await expect(tags).toHaveText(['标签一']);
    expect((await (await request.get('/data/photos-data.json')).json()).existing[0].tags).toEqual(['标签一']);
    await page.reload();
    await expect(tags).toHaveText(['标签一']);
    expect((await request.get('/ui/logo.svg')).ok()).toBe(true);
    expect(initializationErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
});
