/** 可访问性只读审计：扫描现有页面，输出问题及节点，不修改产品源码或样式。 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page, request }) => {
    expect((await request.post('/__test/reset')).ok()).toBeTruthy();
    await page.addInitScript(() => {
        localStorage.setItem('autoThemeConfig', JSON.stringify({ version: 2, mode: 'system' }));
    });
});

const pages = [
    'index.html', 'notes.html', 'literature.html', 'record.html', 'games.html',
    'videos.html', 'space.html', 'music.html', 'album.html', 'photos.html', 'me.html',
    'admin-portal.html', 'admin-index.html', 'admin-cms.html', 'admin-music.html',
    'admin-album.html', 'admin-photos.html', 'admin-space.html'
];

for (const path of pages) {
    test(`页面可访问性审计：${path}`, async ({ page }, info) => {
        await page.goto('/' + path);
        await expect(page.locator('body')).toBeVisible();
        await page.waitForTimeout(600);
        await page.waitForFunction(() => document.getAnimations().every(animation =>
            animation.effect.getComputedTiming().iterations === Infinity || animation.playState !== 'running'));
        const result = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
        await info.attach('accessibility-audit', {
            body: JSON.stringify({ page: path, project: info.project.name,
                violations: result.violations, incomplete: result.incomplete }, null, 2),
            contentType: 'application/json'
        });
        expect(result.violations.map(item => ({ id: item.id,
            nodes: item.nodes.map(node => ({ target: node.target, reason: node.failureSummary })) }))).toEqual([]);
    });
}
