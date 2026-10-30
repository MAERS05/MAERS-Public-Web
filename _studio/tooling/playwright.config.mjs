/** 浏览器回归配置：隔离后端、桌面深浅色与移动端。 */
import { defineConfig, devices } from '@playwright/test';
const port = process.env.MAERS_E2E_PORT || '8765';
export default defineConfig({
    testDir: './e2e', workers: 1, retries: 0, timeout: 45000,
    forbidOnly: !!process.env.CI,
    use: { baseURL: `http://127.0.0.1:${port}`, channel: process.env.MAERS_E2E_CHANNEL || undefined, serviceWorkers: 'block',
        trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    webServer: { command: 'python -B ../tests/browser_server.py',
        url: `http://127.0.0.1:${port}/index.html`, reuseExistingServer: false, timeout: 30000 },
    projects: [
        { name: 'desktop-dark', use: { ...devices['Desktop Chrome'], colorScheme: 'dark' } },
        { name: 'desktop-light', use: { ...devices['Desktop Chrome'], colorScheme: 'light' } },
        { name: 'mobile-light', use: { ...devices['Pixel 7'], colorScheme: 'light' } }
    ]
});
