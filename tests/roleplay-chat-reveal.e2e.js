/* eslint-env browser */
import { expect } from '@playwright/test';
import { test } from './neconyan-conversation-durable-fixture.js';
import { IPHONE_SAFARI_CONTEXT } from './ios-safari-emulation.js';
import {
    captureChat,
    createCharacter,
    createGroup,
    dismissTourAndToasts,
    expectHomeEntryReveal,
    expectNoErrorToasts,
    expectNoRevealReset,
    openGroup,
    openHome,
    openReadyPage,
    runSoloSwitch,
    seedGroupChat,
    seedTwoChats,
    selectCharacter,
    settleProbe,
    startRevealProbe,
    VIEWPORTS,
    waitForReadable,
} from './roleplay-chat-reveal-support.js';

test.setTimeout(240000);

test.describe('Roleplay chat reveal', () => {
    test('candidate solo switch stays readable on phone and desktop', async ({ app, browserName }) => {
        for (const viewport of VIEWPORTS) {
            const { result } = await runSoloSwitch(app, { browserName, viewport });
            expectNoRevealReset(result);
        }
        expect(app.navigationErrors).toEqual([]);
    });

    test('Home entry stays readable after first readable text', async ({ app, browserName }) => {
        const account = await app.account({ phone: true, contextOptions: { reducedMotion: 'no-preference' } });
        const secondAvatar = await createCharacter(account, 'Reveal Home', 'Home greeting.');
        const page = await openReadyPage(account);
        await seedTwoChats(page, account.avatar, secondAvatar);
        await dismissTourAndToasts(page);
        await openHome(page);

        await startRevealProbe(page);
        await selectCharacter(page, secondAvatar);
        const homeResult = await settleProbe(page);
        // The Home entrance is the one place where a one-frame dip during the
        // 360 ms fade is treated as motion; every other case is strict.
        expectHomeEntryReveal(homeResult);
        await captureChat(page, `${browserName}-candidate-home-after`);

        await expectNoErrorToasts(page);
        expect(app.navigationErrors).toEqual([]);
    });

    test('group load never hides after first readable text', async ({ app, browserName }) => {
        const account = await app.account({ phone: true, contextOptions: { reducedMotion: 'no-preference' } });
        const secondAvatar = await createCharacter(account, 'Reveal Kit', 'Kit greeting.');
        const { group, stamp } = await createGroup(account, secondAvatar);
        await seedGroupChat(account, group, stamp);
        const page = await openReadyPage(account);

        await selectCharacter(page, account.avatar);
        await waitForReadable(page);
        await dismissTourAndToasts(page);

        await startRevealProbe(page);
        await openGroup(page, group.id);
        expectNoRevealReset(await settleProbe(page));
        await captureChat(page, `${browserName}-candidate-group-after`);

        await expectNoErrorToasts(page);
        expect(app.navigationErrors).toEqual([]);
    });

    test('reduced motion never hides after first readable text', async ({ app, browserName }) => {
        const account = await app.account({ phone: true, contextOptions: { reducedMotion: 'reduce' } });
        const secondAvatar = await createCharacter(account, 'Reveal Quiet', 'Quiet greeting.');
        const page = await openReadyPage(account);
        await seedTwoChats(page, account.avatar, secondAvatar);
        await dismissTourAndToasts(page);

        await startRevealProbe(page);
        await selectCharacter(page, secondAvatar);
        expectNoRevealReset(await settleProbe(page));
        await captureChat(page, `${browserName}-reduced-after`);

        await expectNoErrorToasts(page);
        expect(app.navigationErrors).toEqual([]);
    });

    test('iPhone Safari spoof never hides after first readable text', async ({ app, browserName }) => {
        const account = await app.account({
            phone: true,
            contextOptions: { ...IPHONE_SAFARI_CONTEXT, reducedMotion: 'no-preference' },
        });
        const secondAvatar = await createCharacter(account, 'Reveal Safari', 'Safari greeting.');
        const page = await openReadyPage(account, { ios: true });
        expect(await page.evaluate(() => document.body.classList.contains('safari'))).toBe(true);
        await seedTwoChats(page, account.avatar, secondAvatar);
        await dismissTourAndToasts(page);

        await startRevealProbe(page);
        await selectCharacter(page, secondAvatar);
        expectNoRevealReset(await settleProbe(page));
        await captureChat(page, `${browserName}-ios-spoof-after`);

        await expectNoErrorToasts(page);
        expect(app.navigationErrors).toEqual([]);
    });
});
