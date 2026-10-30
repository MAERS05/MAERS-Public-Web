/** 独立可访问性审计配置；默认功能回归沿用原配置。 */
import { defineConfig } from '@playwright/test';
import base from './playwright.config.mjs';

export default defineConfig({
    ...base,
    testMatch: '**/*.audit.mjs',
    outputDir: './test-results/accessibility'
});
