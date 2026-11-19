import { defineConfig } from '@playwright/test';

export default defineConfig({
    testMatch: '*.e2e.js',
    retries: process.env.CI ? 1 : 0,
    use: {
        baseURL: process.env.NECONYAN_TEST_BASE_URL || 'http://127.0.0.1:4433',
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
        // Keep steps and errors from the original failure without capturing
        // the whole DOM and a filmstrip on every passing interaction.
        trace: process.env.CI ? {
            mode: 'retain-on-failure',
            snapshots: false,
            screenshots: false,
            sources: false,
        } : 'off',
    },
    workers: 4,
    fullyParallel: true,
});
