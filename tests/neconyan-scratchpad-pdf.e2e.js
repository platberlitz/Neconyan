/* global document, window, getComputedStyle, DOMParser */
/* eslint-disable playwright/no-conditional-in-test -- Baseline and phone variants share the fixture. */
import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { test } from './neconyan-conversation-durable-fixture.js';
import { applyIOSOnlyCss, installIPhoneSafari, IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import { settleCssTransitions } from './chat-scroll-regression-helpers.js';

const before = process.env.NECONYAN_SCRATCHPAD_BEFORE === '1';
if (before) test.use({ initialServerOptions: { checkoutRoot: '/srv/projects/Neconyan' } });
const session = { name: 'Café notes', pinnedNote: 'Keep the harbour open.', settings: {}, messages: [
    { role: 'user', text: 'A café in Lisbon.\n\n<script>window.PDF_ATTACK=true</script><img src="https://example.com/leak.png"><iframe src="https://example.com/leak"></iframe>',
        attachments: [{ name: 'notes.txt', size: 10, kind: 'text', mimeType: 'text/plain', text: 'ATTACHMENT-PRIVATE' }] },
    { role: 'assistant', assistant: 'miso', text: '**Olá, café.**\n\n[Unsafe](javascript:alert(1))\n\n' + Array.from({ length: 90 }, (_, i) => `Paragraph ${i}: The harbour stays open while the tide rises. Keep this whole sentence readable.`).join('\n\n'),
        reasoning: 'THINKING-PRIVATE', rehearsal: true, webSearch: { provider: 'brave', query: 'harbour', sources: [{ title: 'SOURCE-PRIVATE', url: 'https://example.com/harbour' }] } },
] };

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} exports a printable PDF transcript with explicit extras`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {} });
        if (phone) await installIPhoneSafari(account.context, { standalone: true });
        const page = await account.open();
        const open = async () => {
            await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'sessions' }));
            if (phone) await applyIOSOnlyCss(page);
        };
        await open();
        const created = page.waitForResponse('**/api/scratchpad/session/create');
        await page.getByRole('button', { name: 'New session', exact: true }).click();
        const { source } = (await created).request().postDataJSON();
        await account.post('/api/scratchpad/session/import', { source, session });
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).hideScratchpad());
        await open();
        const dialog = page.locator('dialog[open]').filter({ hasText: 'Export this session' });
        const prefix = `../screenshots/scratchpad-pdf/${phone ? 'phone' : 'desktop'}`;
        await page.getByRole('button', { name: 'Export current', exact: true }).click();
        await expect(dialog).toBeVisible();
        await page.evaluate(() => window.toastr?.remove());
        if (before) {
            await expect(dialog.locator('input[type="radio"]')).toHaveCount(2);
            await page.screenshot({ path: `${prefix}-before.png` });
            return;
        }
        await dialog.locator('input[type="radio"]').nth(2).check();
        await page.screenshot({ path: `${prefix}-after.png` });
        // A blocked popup keeps the export choices open and explains how to retry.
        await page.evaluate(() => { window.pdfOriginalOpen = window.open; window.open = () => null; });
        await dialog.getByRole('button', { name: 'Export', exact: true }).click();
        await expect(dialog.getByRole('alert')).toContainText('blocked');
        await expect(dialog.locator('input[type="radio"]').nth(2)).toBeChecked();
        await page.evaluate(() => { window.open = window.pdfOriginalOpen; delete window.pdfOriginalOpen; });
        const opened = page.waitForEvent('popup');
        await dialog.getByRole('button', { name: 'Export', exact: true }).click();
        const print = await opened;
        await print.setViewportSize({ width: phone ? 393 : 1280, height: phone ? 852 : 900 });
        await expect(print.getByRole('button', { name: 'Print / save PDF', exact: true })).toBeEnabled();
        await expect(print.locator('main')).toContainText('Olá, café.');
        await expect(print.locator('main')).toContainText('Rehearsal: a draft, not an event');
        await expect(print.locator('main')).not.toContainText('THINKING-PRIVATE');
        await expect(print.locator('main')).not.toContainText('ATTACHMENT-PRIVATE');
        await expect(print.locator('main')).not.toContainText('SOURCE-PRIVATE');
        await expect(print.locator('main script, main iframe, main img, main [onclick], main a[href^="javascript:"]')).toHaveCount(0);
        expect(await print.evaluate(() => window.opener)).toBeNull();
        expect(await print.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await print.screenshot({ path: `${prefix}-print.png` });
        await print.evaluate(() => { window.print = () => { document.body.dataset.printed = 'yes'; }; });
        await print.getByRole('button', { name: 'Print / save PDF', exact: true }).click();
        await expect(print.locator('body')).toHaveAttribute('data-printed', 'yes');
        const pdf = await print.pdf({ path: `${prefix}.pdf`, format: 'A4', printBackground: true });
        const result = await page.evaluate(async bytes => {
            const pdfjs = await import('/lib/pdf.min.mjs');
            pdfjs.GlobalWorkerOptions.workerSrc = '/lib/pdf.worker.min.mjs';
            const pdf = await pdfjs.getDocument({ data: Uint8Array.from(bytes) }).promise;
            const text = [];
            const renders = [];
            for (let number = 1; number <= pdf.numPages; number++) {
                const page = await pdf.getPage(number);
                text.push((await page.getTextContent()).items.map(item => item.str).join(' '));
                if (number === 1 || number === pdf.numPages) {
                    const viewport = page.getViewport({ scale: 1.2 });
                    const canvas = document.createElement('canvas');
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
                    renders.push(canvas.toDataURL('image/png').split(',')[1]);
                }
            }
            await pdf.destroy();
            return { pages: text.length, text: text.join('\n'), renders };
        }, [...pdf]);
        for (const [index, png] of result.renders.entries()) await fs.writeFile(`${prefix}-page-${index}.png`, Buffer.from(png, 'base64'));
        expect(result.pages).toBeGreaterThan(1);
        expect(result.text).toContain('Olá, café.');
        expect(result.text).toContain('Paragraph 89');
        expect(result.text).not.toMatch(/Print \/ save PDF|THINKING-PRIVATE|ATTACHMENT-PRIVATE|SOURCE-PRIVATE/);
        await print.close();

        for (const accent of [null, 'Pearl', 'Midnight Ink']) {
            if (accent) await page.locator(`.sb-accent-profile-apply[aria-label="Apply ${accent} accent profile"]`).evaluate(element => element.click());
            await settleCssTransitions(page);
            await page.getByRole('button', { name: 'Export current', exact: true }).click();
            await dialog.locator('input[type="radio"]').nth(2).check();
            for (const field of ['reasoning', 'sources', 'attachments']) await dialog.locator(`input[name="scratchpad-export-${field}"]`).check();
            const popup = page.waitForEvent('popup');
            await dialog.getByRole('button', { name: 'Export', exact: true }).click();
            const view = await popup;
            const button = view.getByRole('button', { name: 'Print / save PDF', exact: true });
            await expect(button).toBeEnabled();
            for (const extra of ['THINKING-PRIVATE', 'ATTACHMENT-PRIVATE', 'SOURCE-PRIVATE']) await expect(view.locator('main')).toContainText(extra);
            const colours = await button.evaluate(element => { const style = getComputedStyle(element); return [style.color, style.backgroundColor]; });
            const contrast = await page.evaluate(async colours => {
                const { contrastRatio } = await import('/scripts/theme-contrast.js');
                return contrastRatio(...colours.map(colour => colour.match(/[\d.]+/g).slice(0, 3).map(Number)));
            }, colours);
            expect(contrast, accent ?? 'default').toBeGreaterThanOrEqual(4.5);
            expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
            await view.close();
        }
    });
}

// Sanitisation needs a real DOM, so the transcript builder is checked in the browser.
test('the print transcript keeps chosen versions and only opted-in, safe content', async ({ app }) => {
    test.skip(before, 'The module does not exist before this change.');
    const account = await app.account({});
    const page = await account.open();
    const result = await page.evaluate(async () => {
        const { sessionPrintHtml } = await import('/scripts/scratchpad/pdf-export.js');
        const parse = html => new DOMParser().parseFromString(html, 'text/html');
        const first = sessionPrintHtml({ name: '<script>Title</script>', pinnedNote: 'A **goal**', messages: [
            { id: 'r2', role: 'assistant', state: 'done', text: 'Chosen reply', reasoning: 'SECRET-THOUGHT', rehearsal: true,
                swipeIndex: 1, swipes: [{ id: 'r1', role: 'assistant', state: 'done', text: 'OLD-REPLY' }, null],
                images: { secret: { url: 'GENERATED-PICTURE' } } },
            { role: 'assistant', state: 'pending', text: 'PENDING-REPLY' },
        ] });
        const second = parse(sessionPrintHtml({ name: 'Notes', messages: [{ role: 'user', text: '<style>body{display:none}</style><img src="https://example.com/leak"><a href="javascript:bad()">Unsafe</a>', attachments: [
            { name: 'pic.png', kind: 'image', dataUrl: 'data:image/png;base64,AAAA' },
            { name: 'bad.svg', kind: 'image', dataUrl: 'data:image/svg+xml;base64,AAAA' },
            { name: 'text.txt', kind: 'text', text: '<img src="https://example.com/secret">' },
        ] }] }, { attachments: true }));
        return { first, images: [...second.querySelectorAll('img')].map(image => image.getAttribute('src')),
            href: second.querySelector('section a')?.hasAttribute('href'), unsafe: second.querySelectorAll('body style, body script, body iframe').length,
            pre: second.querySelector('section pre')?.textContent };
    });
    expect(result.first).toContain('&lt;script&gt;Title&lt;/script&gt;');
    expect(result.first).toContain('<strong>goal</strong>');
    expect(result.first).toContain('version 2 of 2');
    expect(result.first).toContain('Rehearsal: a draft, not an event');
    expect(result.first).toContain('Chosen reply');
    expect(result.first).not.toMatch(/SECRET-THOUGHT|OLD-REPLY|GENERATED-PICTURE|PENDING-REPLY/);
    expect(result.images).toEqual(['data:image/png;base64,AAAA']);
    expect(result.href).toBe(false);
    expect(result.unsafe).toBe(0);
    expect(result.pre).toBe('<img src="https://example.com/secret">');
});
