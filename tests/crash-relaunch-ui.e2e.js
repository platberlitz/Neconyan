/* global document, globalThis, sessionStorage, localStorage, getComputedStyle, Storage */
import path from 'node:path';
import { test, expect } from '@playwright/test';

const base = process.env.NECONYAN_TEST_BASE_URL;
test.skip(!base, 'Requires this worktree\'s disposable preview.');
test.setTimeout(120000);
const screenshots = path.resolve('../screenshots');

for (const viewport of [{ width: 393, height: 852, name: 'phone' }, { width: 1280, height: 900, name: 'desktop' }]) {
    test(`${viewport.name}: recovery reader, accents and retained error stay readable`, async ({ browser }) => {
        const context = await browser.newContext({ viewport, hasTouch: viewport.name === 'phone', isMobile: viewport.name === 'phone' });
        const page = await context.newPage();
        try {
            await page.addInitScript(() => {
                if (sessionStorage.getItem('crash-ui-seeded')) return;
                sessionStorage.setItem('crash-ui-seeded', 'yes'); sessionStorage.setItem('neconyan.crash-tab.v1', 'ui-test-tab');
                const at = Date.now();
                localStorage.setItem('neconyan.crash-session.v1:ui-test-tab', JSON.stringify({ schema: 1, documentId: 'ui-old-document', state: 'running', heartbeatAt: at, snapshot: {
                    schema: 1, pageSessionId: 'ui-old-document', at: at - 4000, view: 'chat', mode: 'roleplay', chat: { messageCount: 58, estimatedTextBytes: 340000 },
                    generation: { phase: 'post-agents', location: 'server' }, agents: { running: [{ label: 'Format Fixer', phase: 'post', location: 'server' }, { label: 'Proofreader', phase: 'post', location: 'server' }] },
                }, events: [] }));
            });
            await page.goto(base, { waitUntil: 'domcontentloaded' });
            const read = page.getByRole('button', { name: 'Read report', exact: true });
            await expect(read).toBeVisible();
            await expect.poll(() => page.evaluate(() => globalThis.NeconyanCrashDiagnostics?.getActivity()?.snapshot.ready), { timeout: 60000 }).toBe(true);
            await page.evaluate(async () => {
                const core = await import('/script.js');
                await core.newAssistantChat({ temporary: true });
                core.setOnlineStatus('Crash fixture connected');
                core.activateSendButtons({ emitGenerationEnded: false });
                const home = await import('/scripts/welcome-screen.js'); home.hideWelcomeHome();
                globalThis.NeconyanShell?.closeWorkspace?.();
                const skip = Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Skip' && button.getBoundingClientRect().width);
                skip?.click();
            });
            await expect(page.locator('#send_but')).toBeVisible();
            await expect(page.getByText(/Last known activity: 58 messages/)).toBeVisible();
            const overlap = await page.evaluate(() => {
                const notice = document.querySelector('.neconyan-crash-notice')?.closest('.toast')?.getBoundingClientRect();
                const send = document.querySelector('#send_but')?.getBoundingClientRect();
                return Boolean(notice && send && notice.right > send.left && notice.left < send.right && notice.bottom > send.top && notice.top < send.bottom);
            });
            expect(overlap).toBe(false);
            await page.screenshot({ path: path.join(screenshots, `after-notice-${viewport.name}.png`) });
            await read.click();
            const textbox = page.getByRole('textbox', { name: 'Saved crash reports' });
            await expect(textbox).toBeVisible();
            expect(await textbox.inputValue()).toContain('Proofreader');
            expect(await textbox.inputValue()).toContain('definite cause');
            for (const tone of ['Dark', 'Light']) {
                await page.evaluate(tone => {
                    const select = document.querySelector('#themes');
                    if (select) { select.value = tone === 'Dark' ? 'Neconyan Calico Dark' : 'Neconyan Calico'; select.dispatchEvent(new Event('change', { bubbles: true })); }
                }, tone);
                for (const accent of ['default', 'Mint Glass', 'Plum Wine']) {
                    if (accent !== 'default') await page.evaluate(async name => {
                        const { power_user } = await import('/scripts/power-user.js');
                        const index = power_user.sb_accent_profiles.findIndex(profile => profile.name === name);
                        document.querySelector(`[data-accent-profile-index="${index}"]`)?.click();
                    }, accent);
                    await expect.poll(() => textbox.isVisible()).toBe(true);
                    const measure = () => textbox.evaluate(node => {
                        const content = node.closest('.neconyan-crash-report');
                        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
                        const paint = canvas.getContext('2d', { willReadFrequently: true });
                        const rgba = value => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = value; paint.fillRect(0, 0, 1, 1); return Array.from(paint.getImageData(0, 0, 1, 1).data); };
                        const composite = (front, back) => front.slice(0, 3).map((value, index) => value * front[3] / 255 + back[index] * (1 - front[3] / 255)).concat(255);
                        const light = value => { const c = value.slice(0, 3).map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722; };
                        return Array.from((content.closest('dialog') || content).querySelectorAll('button')).map(button => {
                            const style = getComputedStyle(button), rect = button.getBoundingClientRect();
                            let backgroundRgba = rgba(getComputedStyle(document.body).getPropertyValue('--neco-canvas'));
                            const parents = []; for (let parent = button.parentElement; parent; parent = parent.parentElement) parents.push(parent);
                            for (const parent of parents.reverse()) backgroundRgba = composite(rgba(getComputedStyle(parent).backgroundColor), backgroundRgba);
                            backgroundRgba = composite(rgba(style.backgroundColor), backgroundRgba);
                            const text = light(composite(rgba(style.color), backgroundRgba)), background = light(backgroundRgba);
                            return { label: button.textContent, height: rect.height, contrast: (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05) };
                        });
                    });
                    await expect.poll(async () => Math.min(...(await measure()).map(row => row.contrast))).toBeGreaterThanOrEqual(4.5);
                    const measurements = await measure();
                    for (const result of measurements) { expect(result.height, result.label).toBeGreaterThanOrEqual(44); expect(result.contrast, `${tone}/${accent}/${result.label}`).toBeGreaterThanOrEqual(4.5); }
                }
            }
            await page.screenshot({ path: path.join(screenshots, `after-reader-${viewport.name}.png`) });
            await page.keyboard.press('Escape');
            await expect(textbox).toHaveCount(0);
            await page.locator('.neconyan-crash-notice [data-crash-action="dismiss"]').click();
            await page.reload();
            await expect(page.getByRole('button', { name: 'Read report', exact: true })).toHaveCount(0);
            await expect.poll(() => page.evaluate(() => globalThis.NeconyanCrashDiagnostics?.getActivity()?.snapshot.ready), { timeout: 60000 }).toBe(true);
            await page.evaluate(() => {
                const original = Storage.prototype.setItem;
                Storage.prototype.setItem = function (key, value) { if (key.startsWith('neconyan.crash')) throw new Error('Fixture storage failure'); return original.call(this, key, value); };
                globalThis.NeconyanCrashDiagnostics.capture('fixture-error', new Error('Long stack line ' + 'x'.repeat(10000)));
                globalThis.NeconyanCrashDiagnostics.openReports();
            });
            await expect(textbox).toBeVisible();
            await expect(page.getByText(/Could not save to browser storage/)).toBeVisible();
            const width = await page.evaluate(() => document.documentElement.scrollWidth);
            expect(width).toBeLessThanOrEqual(viewport.width);
            await page.screenshot({ path: path.join(screenshots, `after-storage-failure-${viewport.name}.png`) });
        } finally { await context.close(); }
    });
}
