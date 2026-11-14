/* global document, getComputedStyle, window */
/* eslint-disable playwright/no-standalone-expect -- Shared assertions run through the Chromium and WebKit fixtures. */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT, installIPhoneSafari, applyIOSOnlyCss } from './ios-safari-emulation.js';

const webkitTest = test.extend({ browserName: 'webkit' });

async function openEntry(app, phone) {
    const account = await app.account({ phone, contextOptions: phone ? IPHONE_SAFARI_CONTEXT : {}, configureSettings(saved) {
        saved.firstRun = false;
        saved.accountStorage = { ...saved.accountStorage, 'NeconyanTutorialStatus.v1': 'skipped' };
        saved.power_user.neconyan_shell_style = 'windows-98';
    } });
    if (phone) await installIPhoneSafari(account.context, { standalone: false });
    await account.post('/api/worldinfo/edit', { name: 'Workshop notes', data: { entries: {
        0: { uid: 0, key: ['workshop'], keysecondary: [], content: 'A quiet workshop overlooking the harbour.', comment: 'The workshop',
            constant: false, selective: true, disable: false, order: 100, position: 0, depth: 4, probability: 100, useProbability: true, addMemo: true },
    } } });
    const page = await account.open({ workspace: false });
    await page.locator('#preloader').waitFor({ state: 'detached', timeout: 90000 });
    await page.evaluate(() => window.NeconyanShell.openTab('characters', 'world-info'));
    await page.locator('.neconyan-lorebook-book-open').filter({ hasText: 'Workshop notes' }).click();
    await page.locator('#world_popup_entries_list button.inline-drawer-toggle').first().click();
    const advanced = page.locator('#WorldInfo .neconyan-entry-advanced:visible');
    await expect(advanced).toBeVisible();
    if (phone) await applyIOSOnlyCss(page);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.toastr.remove());
    return { account, page, advanced };
}

async function expectAlignedFields(advanced, { narrow = false, recursion = false } = {}) {
    const geometry = await advanced.evaluate(root => {
        const names = ['scanDepth', 'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'automationId',
            'group', 'groupWeight', 'sticky', 'cooldown', 'delay', 'characterFilter', 'triggers'];
        if (root.querySelector('[name="delay_until_recursion"]').checked) names.push('delayUntilRecursionLevel');
        const controls = Object.fromEntries(names.map(name => {
            let control = root.querySelector(`[name="${name}"]`);
            if (control.hidden) control = control.parentElement.querySelector('.sb-select-picker-button');
            return [name, control.getBoundingClientRect().toJSON()];
        }));
        const flags = [...root.querySelectorAll('.neconyan-entry-flags input')].map(node => node.getBoundingClientRect().toJSON());
        return { controls, flags, overflow: root.scrollWidth - root.clientWidth };
    });
    const { controls, flags } = geometry;
    for (const [name, box] of Object.entries(controls)) {
        expect(box.width, `${name} width`).toBeCloseTo(controls.scanDepth.width, 0);
        expect(box.height, `${name} height`).toBeCloseTo(controls.scanDepth.height, 0);
        expect(box.height, `${name} touch height`).toBeGreaterThanOrEqual(44);
        if (narrow) expect(box.x, `${name} single column`).toBeCloseTo(controls.scanDepth.x, 0);
    }
    if (!narrow) {
        const pairs = [['scanDepth', 'caseSensitive'], ['matchWholeWords', 'useGroupScoring'], ['group', 'groupWeight'],
            ['sticky', 'cooldown'], ['characterFilter', 'triggers']];
        if (recursion) pairs.push(['automationId', 'delayUntilRecursionLevel']);
        for (const [left, right] of pairs) {
            expect(controls[left].y, `${left}/${right} top`).toBeCloseTo(controls[right].y, 0);
            expect(controls[left].x, `${left} column`).toBeCloseTo(controls.scanDepth.x, 0);
            expect(controls[right].x, `${right} column`).toBeCloseTo(controls.caseSensitive.x, 0);
        }
        for (let index = 0; index < 8; index += 2) {
            expect(flags[index].x).toBeCloseTo(controls.scanDepth.x, 0);
            expect(flags[index + 1].x).toBeCloseTo(controls.caseSensitive.x, 0);
            expect(flags[index].y).toBeCloseTo(flags[index + 1].y, 0);
        }
        for (let index = 8; index < 11; index++) {
            expect(flags[index].x).toBeCloseTo(controls.scanDepth.x, 0);
            expect(flags[index + 3].x).toBeCloseTo(controls.caseSensitive.x, 0);
            expect(flags[index].y).toBeCloseTo(flags[index + 3].y, 0);
        }
    }
    expect(geometry.overflow).toBeLessThanOrEqual(1);
}

for (const [runner, browserType] of [[test, 'chromium'], [webkitTest, 'webkit']]) {
    for (const phone of [true, false]) {
        runner(`Lorebook advanced disclosure on ${phone ? 'phone' : 'desktop'} (${browserType})`, async ({ app }) => {
            test.setTimeout(180000);
            const { advanced } = await openEntry(app, phone);
            const summary = advanced.locator('summary');
            const indicator = summary.locator('.fa-chevron-down');
            await expect(summary).toHaveText('Advanced entry settings');
            await expect(indicator).toHaveAttribute('aria-hidden', 'true');
            await summary.scrollIntoViewIfNeeded();
            const geometry = await summary.evaluate(node => {
                const box = node.getBoundingClientRect();
                const icon = node.querySelector('i');
                const iconBox = icon.getBoundingClientRect();
                const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                return { height: box.height, hit: node === hit || node.contains(hit), iconWidth: iconBox.width,
                    mask: getComputedStyle(icon, '::before').maskImage, overflow: node.scrollWidth - node.clientWidth };
            });
            expect(geometry.height).toBeGreaterThanOrEqual(44);
            expect(geometry.hit).toBe(true);
            expect(geometry.iconWidth).toBeGreaterThan(0);
            expect(geometry.mask).not.toBe('none');
            expect(geometry.overflow).toBeLessThanOrEqual(1);
            await expect(advanced).not.toHaveAttribute('open');
            if (phone) await summary.tap();
            else await summary.click();
            await expect(advanced).toHaveAttribute('open');
            await expect(indicator).toHaveCSS('rotate', '180deg');
            await summary.press('Space');
            await expect(advanced).not.toHaveAttribute('open');
            await summary.press('Enter');
            await expect(advanced).toHaveAttribute('open');
            expect(app.provider.calls).toHaveLength(0);
        });

        runner(`Lorebook entry fields align and save on ${phone ? 'phone' : 'desktop'} (${browserType})`, async ({ app }) => {
            test.setTimeout(180000);
            const { account, page, advanced } = await openEntry(app, phone);
            await advanced.locator('summary').click();
            await expectAlignedFields(advanced);
            await expect(advanced.locator('[name="delayUntilRecursionLevel"]')).toBeHidden();
            await advanced.locator('[name="delay_until_recursion"]').check();
            await expect(advanced.locator('[name="delayUntilRecursionLevel"]')).toBeVisible();
            await expectAlignedFields(advanced, { recursion: true });
            await advanced.locator('[name="groupOverride"]').check();
            await advanced.locator('[name="character_exclusion"]').check();
            await advanced.locator('[name="group"]').fill('workshop');
            await advanced.locator('[name="groupWeight"]').fill('125');
            await advanced.locator('[name="sticky"]').fill('2');
            await advanced.locator('[name="cooldown"]').fill('3');
            await advanced.locator('[name="delay"]').fill('4');
            await expect.poll(async () => (await account.post('/api/worldinfo/get', { name: 'Workshop notes' })).entries[0], { timeout: 15000 }).toMatchObject({
                groupOverride: true, characterFilter: { isExclude: true }, group: 'workshop', groupWeight: 125,
                sticky: 2, cooldown: 3, delay: 4, delayUntilRecursion: true,
            });
            // Longer translations and unequal label lengths must not move paired controls off their shared row.
            await advanced.evaluate(root => {
                for (const name of ['scanDepth', 'group', 'triggers']) {
                    root.querySelector(`[name="${name}"]`).closest('.neconyan-entry-field').querySelector('.neconyan-entry-field-heading').textContent =
                        'A longer translated setting label that needs several lines';
                }
            });
            await expectAlignedFields(advanced, { recursion: true });
            if (phone) {
                await page.setViewportSize({ width: 320, height: 852 });
                await expectAlignedFields(advanced, { narrow: true, recursion: true });
            }
            expect(app.provider.calls).toHaveLength(0);
        });
    }
}
