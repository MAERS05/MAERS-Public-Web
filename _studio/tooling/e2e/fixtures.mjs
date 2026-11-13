/** 浏览器回归夹具：每例重置沙盒真源，统一主题预置及页面异常收集。 */
import { test as base, expect } from '@playwright/test';

export { expect };
export const test = base.extend({
    isolatedData: [async ({ page, request }, use) => {
        const reset = await request.post('/__test/reset');
        expect(reset.ok()).toBeTruthy();
        await page.addInitScript(() => {
            if (!localStorage.getItem('autoThemeConfig')) {
                localStorage.setItem('autoThemeConfig', JSON.stringify({ version: 2, mode: 'system' }));
            }
        });
        await use();
    }, { auto: true }],
    pageErrors: async ({ page }, use) => {
        const errors = [];
        const capture = error => errors.push(error.message);
        page.on('pageerror', capture);
        try { await use(errors); }
        finally { page.off('pageerror', capture); }
    }
});
