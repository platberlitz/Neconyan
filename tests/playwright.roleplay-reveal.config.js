import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testMatch: 'roleplay-chat-reveal.e2e.js',
    workers: 1,
    fullyParallel: false,
    use: {
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
});
