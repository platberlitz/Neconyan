/* global document, getComputedStyle, innerWidth, innerHeight */
import { expect } from '@playwright/test';
import { test, send } from './neconyan-conversation-durable-fixture.js';

test.setTimeout(180000);
test.skip(process.env.NECONYAN_CONVERSATION_TEST_DISPOSABLE !== '1', 'Requires a disposable server.');

for (const phone of [false, true]) {
    test(`${phone ? 'phone' : 'desktop'} assistant reads, reopens its approval and saves one confirmed edit`, async ({ app }, info) => {
        const account = await app.account({ phone });
        await account.post('/api/characters/merge-attributes', { avatars: [account.avatar], data: {
            data: { extensions: { neconyan_assistant: { id: 'nori-neutral', version: 1 } } },
        } });
        await account.post('/api/worldinfo/edit', { name: 'Assistant Manual', data: {
            entries: { 0: { uid: 0, comment: 'Test entry', key: ['test'], content: 'Before', disable: false } },
        } });
        const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
            id: name, type: 'function', function: { name: `Neconyan_Assistant_${name}`, arguments: JSON.stringify(args) },
        }] }, finish_reason: 'tool_calls' }] });
        app.provider.mode.reply = body => {
            const results = body.messages.filter(message => message.role === 'tool');
            if (!results.length) return tool('ReadLorebookEntry', { book: 'Assistant Manual', uid: 0 });
            if (results.length === 1) return tool('EditLorebookEntry', { book: 'Assistant Manual', uid: 0,
                field: 'content', value: 'After', expected: { title: 'Test entry', content: 'Before' }, userConfirmed: true });
            return { choices: [{ message: { role: 'assistant', content: 'The confirmed lorebook edit is saved.' } }] };
        };
        const page = await account.open();
        const accepted = await send(page, 'Yes, read the test entry and change its content to After. Also explain Shell Style Windows Aero.');
        const review = page.locator('dialog.popup[open]').filter({ has: page.locator('.neconyan-assistant-review') });
        await expect(review).toBeVisible({ timeout: 60000 });
        await expect(review.locator('pre').first()).toHaveText('Before');
        await expect(review.locator('pre').last()).toHaveText('After');
        expect(app.provider.calls).toHaveLength(2);
        expect(app.provider.calls[0].tools).toHaveLength(25);
        expect(JSON.stringify(app.provider.calls[0].messages)).toContain('appearance.shell-style');
        await page.close();
        const reopened = await account.open({ workspace: false });
        const pending = reopened.locator('dialog.popup[open]').filter({ has: reopened.locator('.neconyan-assistant-review') });
        await expect(pending).toBeVisible({ timeout: 30000 });
        const geometry = await pending.evaluate(dialog => {
            const box = dialog.getBoundingClientRect();
            const button = dialog.querySelector('.popup-button-ok');
            const control = button.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
                width: innerWidth, height: innerHeight, buttonHeight: control.height, display: getComputedStyle(button).display,
                overflow: document.documentElement.scrollWidth > innerWidth };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.width);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
        expect(geometry.overflow).toBe(false);
        expect(geometry.display).not.toBe('none');
        await reopened.screenshot({ path: info.outputPath('assistant-approval.png') });
        await pending.locator('.popup-button-ok').click();
        try {
            await account.settled(accepted.job.id);
        } catch (error) {
            const jobs = [await account.job(accepted.job.id)];
            for (const job of jobs) for (const id of job.children || []) jobs.push(await account.job(id));
            throw new Error(JSON.stringify(jobs.map(({ id, type, state, stage, error }) => ({ id, type, state, stage, error }))), { cause: error });
        }
        expect((await account.post('/api/worldinfo/get', { name: 'Assistant Manual' })).entries[0].content).toBe('After');
        expect((await account.branch()).messages.filter(message => message.mes === 'The confirmed lorebook edit is saved.')).toHaveLength(1);
        expect(app.provider.calls).toHaveLength(3);
        expect(app.provider.calls[2].messages.filter(message => message.role === 'tool')).toHaveLength(2);
    });
}
