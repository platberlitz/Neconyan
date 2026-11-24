import { beforeEach, describe, expect, jest, test } from '@jest/globals';

let extensionSettings;
let getContextSpy;

beforeEach(async () => {
    jest.resetModules();
    extensionSettings = {
        'Neconyan-Deep-Swipe': {
            enabled: false,
            swipeNavigation: true,
            userSwipes: true,
            assistantSwipes: true,
        },
    };
    getContextSpy = jest.fn(() => ({ chat: [], swipe: { state: () => 'none' } }));
    await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
        extension_settings: extensionSettings,
        getContext: getContextSpy,
    }));
    await jest.unstable_mockModule('../public/script.js', () => ({
        isGenerating: () => false,
        restoreHeldChatReadingPosition: jest.fn(),
    }));
});

describe('Deep Swipe navigation guards', () => {
    test('a disabled extension does not read chat context or inject navigation', async () => {
        const ui = await import('../public/scripts/extensions/third-party/Neconyan-Deep-Swipe/ui.js');
        ui.addSwipeNavigationToMessage(0);
        expect(getContextSpy).not.toHaveBeenCalled();
    });

    test('disabled swipe navigation does not read chat context or inject navigation', async () => {
        extensionSettings['Neconyan-Deep-Swipe'].enabled = true;
        extensionSettings['Neconyan-Deep-Swipe'].swipeNavigation = false;
        const ui = await import('../public/scripts/extensions/third-party/Neconyan-Deep-Swipe/ui.js');
        ui.addSwipeNavigationToMessage(0);
        expect(getContextSpy).not.toHaveBeenCalled();
    });

    test('an enabled navigation setting reaches the normal message path', async () => {
        extensionSettings['Neconyan-Deep-Swipe'].enabled = true;
        extensionSettings['Neconyan-Deep-Swipe'].swipeNavigation = true;
        const ui = await import('../public/scripts/extensions/third-party/Neconyan-Deep-Swipe/ui.js');
        ui.addSwipeNavigationToMessage(0);
        expect(getContextSpy).toHaveBeenCalled();
    });

    test('addUiToAllMessages schedules no retry timer when no chat rows are rendered', async () => {
        extensionSettings['Neconyan-Deep-Swipe'].enabled = true;
        extensionSettings['Neconyan-Deep-Swipe'].swipeNavigation = true;
        const previousDocument = global.document;
        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
        global.document = { querySelectorAll: jest.fn(() => []) };
        try {
            const ui = await import('../public/scripts/extensions/third-party/Neconyan-Deep-Swipe/ui.js');
            ui.addUiToAllMessages();
            expect(setTimeoutSpy).not.toHaveBeenCalled();
        } finally {
            setTimeoutSpy.mockRestore();
            global.document = previousDocument;
        }
    });

    test('Deep Swipe wires CHAT_CHANGED and boot without delayed addUiToAllMessages timers', async () => {
        const fs = await import('node:fs');
        const source = fs.readFileSync(new URL('../public/scripts/extensions/third-party/Neconyan-Deep-Swipe/index.js', import.meta.url), 'utf8');
        expect(source).not.toMatch(/setTimeout\s*\([^)]*addUiToAllMessages/);
    });
});
