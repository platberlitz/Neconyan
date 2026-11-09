/* global window, document, navigator, getComputedStyle */
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';

const html = '<aside class="harbour"><h2>Nova at the harbour</h2><p>The ferry leaves at dawn.</p><strong>Ready to explore</strong></aside>';
const css = '.harbour { padding: 20px; border: 2px solid #51788a; border-radius: 16px; background: #e3f2f6; color: #183642; }\n.harbour h2 { margin-top: 0; }';

async function checkPreviewButton(button) {
    for (const profile of [null, 'Pearl', 'Midnight Ink']) {
        await button.page().evaluate(name => {
            document.querySelector(name ? `.sb-accent-profile-apply[aria-label="Apply ${name} accent profile"]` : '.sb-accent-profile-apply').click();
        }, profile);
        const measured = await button.evaluate(async node => {
            void getComputedStyle(node).backgroundColor;
            await Promise.all(node.getAnimations().map(animation => animation.finished));
            const context = document.createElement('canvas').getContext('2d');
            const rgba = colour => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = colour;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data];
            };
            const blend = (front, back) => front.map((value, index) => index < 3 ? value * front[3] / 255 + back[index] * (1 - front[3] / 255) : 255);
            const layers = [];
            for (let parent = node; parent; parent = parent.parentElement) layers.unshift(rgba(getComputedStyle(parent).backgroundColor));
            const background = layers.reduce((back, front) => blend(front, back), [255, 255, 255, 255]);
            const ink = blend(rgba(getComputedStyle(node).color), background);
            const luminance = rgb => rgb.slice(0, 3).reduce((sum, value, index) => sum + (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index], 0);
            const a = luminance(ink), b = luminance(background);
            return { height: node.getBoundingClientRect().height, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), colour: getComputedStyle(node).color, fill: getComputedStyle(node).backgroundColor, ink, background };
        });
        expect(measured.height).toBeGreaterThanOrEqual(44);
        expect(measured.contrast, `${profile || 'default'}: ${JSON.stringify(measured)}`).toBeGreaterThanOrEqual(4.5);
    }
}

for (const phone of [false, true]) {
    test(`${phone ? 'iPhone stand-in' : 'desktop'} previews Scratchpad HTML and CSS without saving`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(settings) {
            settings.accountStorage = { ...settings.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        } });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const open = () => page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await open();
        const source = await page.evaluate(async () => {
            const ctx = await import('/scripts/scratchpad/context.js');
            return ctx.wireSource(ctx.currentSource());
        });
        const change = { type: 'character', character: 'Durable Nova', field: 'description', value: html };
        await account.post('/api/scratchpad/session/import', { source, session: { name: 'Harbour display', messages: [{ role: 'assistant', text:
            `Here is a compact status display.\n\`\`\`html\n${html}\n\`\`\`\n\`\`\`css\n${css}\n\`\`\`\n\`\`\`json\n{"keep":"copy"}\n\`\`\`\n\`\`\`\nUnlabelled code\n\`\`\`\n\`\`\`scratchpad-change\n${JSON.stringify(change)}\n\`\`\``,
        }] } });
        await open();
        if (phone) await applyIOSOnlyCss(page);
        const blocks = page.locator('.scratchpad-code-block');
        await expect(blocks).toHaveCount(4);
        await expect(blocks.locator('.scratchpad-copy')).toHaveCount(4);
        await expect(blocks.locator('.scratchpad-code-preview')).toHaveCount(2);
        await page.evaluate(() => {
            window.previewCopies = [];
            Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.previewCopies.push(text); } });
        });
        for (let index = 0; index < 4; index++) {
            expect(await blocks.nth(index).locator('.scratchpad-copy').evaluate(button => {
                const copy = button.getBoundingClientRect();
                const code = button.closest('.scratchpad-code-block').getBoundingClientRect();
                return copy.left >= code.left && copy.right <= code.right + 1 && copy.top >= code.top;
            })).toBe(true);
            await blocks.nth(index).getByRole('button', { name: 'Copy code', exact: true }).click();
        }
        expect((await page.evaluate(() => window.previewCopies)).map(text => text.trim())).toEqual([html, css, '{"keep":"copy"}', 'Unlabelled code']);
        await page.evaluate(() => window.toastr.remove());
        await blocks.first().getByRole('button', { name: 'Preview HTML/CSS' }).click();
        const frame = page.frameLocator('iframe[title="HTML and CSS preview"]');
        await expect(frame.locator('.harbour')).toBeVisible();
        expect(await frame.locator('.harbour').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(227, 242, 246)');
        expect(await page.locator('.scratchpad-html-preview-frame').evaluate(node => {
            const box = node.getBoundingClientRect();
            return box.left >= 0 && box.right <= document.documentElement.clientWidth;
        })).toBe(true);
        await expect(page.locator('.scratchpad-html-preview-frame')).toHaveAttribute('sandbox', '');
        await page.screenshot({ path: path.resolve('../screenshots/html-preview', `${phone ? 'phone' : 'desktop'}-scratchpad-after.png`) });
        await page.getByRole('button', { name: 'Close preview', exact: true }).click();
        await checkPreviewButton(blocks.first().getByRole('button', { name: 'Preview HTML/CSS' }));
        await blocks.nth(1).getByRole('button', { name: 'Preview HTML/CSS' }).click();
        await expect(frame.locator('.harbour')).toBeVisible();
        await page.getByRole('button', { name: 'Close preview', exact: true }).click();

        const original = (await account.post('/api/characters/get', { avatar_url: account.avatar })).data.description;
        await page.locator('.scratchpad-change').getByRole('button', { name: 'Review', exact: true }).click();
        await checkPreviewButton(page.locator('.scratchpad-review').getByRole('button', { name: 'Preview HTML/CSS' }));
        const editor = page.getByRole('textbox', { name: 'Proposed text', exact: true });
        await editor.fill('<style>.edited { color: rgb(12, 34, 56); }</style><p class="edited">Edited {{char}}</p>');
        await page.locator('.scratchpad-review').getByRole('button', { name: 'Preview HTML/CSS' }).click();
        await expect(frame.locator('.edited')).toHaveText('Edited {{char}}');
        expect(await frame.locator('.edited').evaluate(node => getComputedStyle(node).color)).toBe('rgb(12, 34, 56)');
        await page.getByRole('button', { name: 'Close preview', exact: true }).click();
        await expect(editor).toHaveValue('<style>.edited { color: rgb(12, 34, 56); }</style><p class="edited">Edited {{char}}</p>');
        await page.getByRole('button', { name: 'Not now', exact: true }).click();
        expect((await account.post('/api/characters/get', { avatar_url: account.avatar })).data.description).toBe(original);

        const requests = [];
        const blocked = [];
        await page.route('https://preview-blocked.invalid/**', async route => {
            requests.push(route.request().url());
            await route.abort();
        });
        page.on('requestfailed', request => {
            if (request.url().includes('preview-blocked.invalid')) blocked.push(request.failure().errorText);
        });
        await page.evaluate(async () => {
            const { showHtmlPreview } = await import('/scripts/scratchpad/html-preview.js');
            void showHtmlPreview({ html: '<base href="https://preview-blocked.invalid"><meta http-equiv="refresh" content="0;url=https://preview-blocked.invalid"><script>parent.document.body.dataset.previewEscaped = "yes"</script><img src="https://preview-blocked.invalid/image" onerror="parent.document.body.dataset.previewEscaped = \'yes\'"><a href="https://preview-blocked.invalid">Blocked link</a><iframe src="https://preview-blocked.invalid"></iframe><p>{{getvar::secret}}</p>', css: '@import "https://preview-blocked.invalid/style"; p { background-image: url(https://preview-blocked.invalid/image2); }' });
        });
        await expect(frame.locator('p')).toHaveText('{{getvar::secret}}');
        await expect(frame.locator('script, iframe, base, a[href], form')).toHaveCount(0);
        await frame.getByText('Blocked link').click();
        await expect(frame.locator('img')).toHaveJSProperty('complete', true);
        await expect(frame.locator('img')).toHaveJSProperty('naturalWidth', 0);
        expect(blocked.every(reason => /csp|content security policy/i.test(reason))).toBe(true);
        expect(requests).toEqual([]);
        expect(await page.locator('body').getAttribute('data-preview-escaped')).toBeNull();
        await page.getByRole('button', { name: 'Close preview', exact: true }).click();
        await page.evaluate(async () => { void (await import('/scripts/scratchpad/html-preview.js')).showHtmlPreview({ html: '', css: '.card { padding: 17px; }' }); });
        await expect(frame.locator('.card')).toContainText('Sample heading');
        expect(await frame.locator('.card').evaluate(node => getComputedStyle(node).padding)).toBe('17px');
        await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    });
}
