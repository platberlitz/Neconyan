import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testMatch: 'roleplay-chat-reveal-baseline.manual.js',
    workers: 1,
    fullyParallel: false,
    use: {
        video: 'off',
        screenshot: 'off',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
});
