/* global document, window */
/* eslint-disable playwright/no-conditional-in-test -- Both viewport sizes exercise the same attachment flow. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';

function pdfFile(text) {
    const stream = `BT /F1 12 Tf 50 740 Td (${text}) Tj ET`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let result = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => { offsets.push(result.length); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = result.length;
    result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return { name: 'reading.pdf', mimeType: 'application/pdf', buffer: Buffer.from(result) };
}

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} sends files and images through the plus menu and keeps them in follow-ups`, async ({ app }) => {
        test.setTimeout(180000);
        const account = await app.account({ phone });
        let page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-composer')).toBeEnabled();
        await page.getByRole('tab', { name: 'Context', exact: true }).click();
        await page.locator('#scratchpad-connection-miso').selectOption('durable');
        await page.getByRole('checkbox', { name: 'Stream replies' }).uncheck();
        await page.getByRole('tab', { name: 'Chat', exact: true }).click();

        const input = page.locator('input[type="file"][aria-label="Attach files"]');
        await input.setInputFiles(Array.from({ length: 9 }, (_, index) => ({ name: `${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Too many files.') })));
        await expect(page.locator('#toast-container')).toContainText('Attach up to eight files');
        await input.setInputFiles({ name: 'binary.dat', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 255]) });
        await expect(page.locator('#toast-container')).toContainText('This file is not readable text');
        await input.setInputFiles(pdfFile(''));
        await expect(page.locator('#toast-container')).toContainText('This PDF has no readable text');
        await expect(page.locator('.scratchpad-draft-attachments .scratchpad-file')).toHaveCount(0);
        await expect(page.locator('.scratchpad-plus')).toBeEnabled();
        await page.evaluate(() => window.toastr?.remove());

        const literal = '{"colour":"amber","literal":"{{user}} {{random::red::blue}}"}';
        const png = await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 96; canvas.height = 64;
            const context = canvas.getContext('2d');
            context.fillStyle = '#e7ad54'; context.fillRect(0, 0, 96, 64);
            return canvas.toDataURL().split(',')[1];
        });
        await page.locator('.scratchpad-plus').click();
        await expect(page.locator('.scratchpad-compose-menu')).toBeVisible();
        await expect(page.locator('.scratchpad-web-toggle')).toHaveText('Web search');
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Attach files', exact: true }).click();
        const picker = await chooser;
        expect(picker.isMultiple()).toBe(true);
        await picker.setFiles([
            { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('The meeting starts at nine.') },
            { name: 'palette.json', mimeType: 'application/json', buffer: Buffer.from(literal) },
            pdfFile('A PDF says the observatory opens at dusk.'),
            { name: 'amber.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') },
            { name: 'remove-me.csv', mimeType: 'text/csv', buffer: Buffer.from('name,value\ntest,1') },
        ]);
        await expect(page.locator('.scratchpad-draft-attachments .scratchpad-file')).toHaveCount(5);
        await expect(page.locator('.scratchpad-send')).toBeEnabled();
        await page.getByRole('button', { name: 'Remove remove-me.csv', exact: true }).click();
        await expect(page.locator('.scratchpad-draft-attachments .scratchpad-file')).toHaveCount(4);
        await expect(page.locator('.scratchpad-draft-attachments img')).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(phone ? 393 : 1280);
        await page.locator('.scratchpad-composer').fill('Read these files and describe the image.');
        await page.locator('.scratchpad-draft-attachments').evaluate(element => { element.scrollTop = element.scrollHeight; });
        await page.locator('.scratchpad-plus').click();
        const menu = await page.locator('.scratchpad-compose-menu').boundingBox();
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.y).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(phone ? 393 : 1280);
        await page.evaluate(() => window.toastr?.remove());
        await page.screenshot({ path: `../screenshots/scratchpad-attachments-${phone ? 'phone' : 'desktop'}-after.png`, scale: 'css' });
        await page.keyboard.press('Escape');

        // A rejected submission keeps both the typed message and prepared files.
        await page.route('**/api/scratchpad/send', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture unavailable.' }) }), { times: 1 });
        const rejected = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        expect((await rejected).status()).toBe(503);
        await expect(page.locator('.scratchpad-send')).toBeEnabled();
        await expect(page.locator('.scratchpad-draft-attachments .scratchpad-file')).toHaveCount(4);
        await expect(page.locator('.scratchpad-composer')).toHaveValue('Read these files and describe the image.');

        app.provider.mode.reply = { choices: [{ message: { content: 'The files contain notes, a palette and observatory opening hours. The image is amber.' } }] };
        const accepted = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const response = await accepted;
        expect(response.ok(), await response.text()).toBe(true);
        const sent = response.request().postDataJSON();
        expect(sent.attachments.map(file => file.name)).toEqual(['notes.txt', 'palette.json', 'reading.pdf', 'amber.png']);
        await account.settled((await response.json()).job.id);
        await expect(page.locator('.scratchpad-draft-attachments .scratchpad-file')).toHaveCount(0);
        await expect(page.locator('.scratchpad-file-preview')).toHaveCount(4);
        const content = app.provider.calls.at(-1).messages.at(-1).content;
        expect(JSON.stringify(content)).toContain('The meeting starts at nine.');
        expect(JSON.stringify(content)).toContain('A PDF says the observatory opens at dusk.');
        expect(content.find(part => part.text?.includes('palette.json')).text).toContain(literal);
        expect(content.find(part => part.type === 'image_url').image_url.url).toBe(sent.attachments[3].dataUrl);

        await page.close();
        page = await account.open();
        await page.evaluate(async () => (await import('/scripts/scratchpad/index.js')).openScratchpad({ tab: 'chat' }));
        await expect(page.locator('.scratchpad-file-preview')).toHaveCount(4);
        await page.locator('.scratchpad-file-preview').filter({ hasText: 'reading.pdf' }).locator('summary').click();
        await expect(page.locator('.scratchpad-file-preview pre').filter({ hasText: 'observatory' })).toBeVisible();
        await page.locator('.scratchpad-composer').fill('When does the observatory open?');
        const followup = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const next = await followup;
        expect(next.ok(), await next.text()).toBe(true);
        await account.settled((await next.json()).job.id);
        expect(app.provider.calls.at(-1).messages.some(message => JSON.stringify(message.content) === JSON.stringify(content))).toBe(true);

        // Attachment-only messages are accepted without inventing text in the editor.
        await page.locator('input[type="file"][aria-label="Attach files"]').setInputFiles({ name: 'only.txt', mimeType: 'text/plain', buffer: Buffer.from('File-only message.') });
        await expect(page.locator('.scratchpad-draft-attachments .scratchpad-file')).toHaveCount(1);
        const only = page.waitForResponse('**/api/scratchpad/send');
        await page.locator('.scratchpad-send').click();
        const last = await only;
        expect(last.ok(), await last.text()).toBe(true);
        expect(last.request().postDataJSON().text).toBe('');
        await account.settled((await last.json()).job.id);
        expect(app.provider.calls.at(-1).messages.at(-1).content).toContain('File-only message.');
    });
}
