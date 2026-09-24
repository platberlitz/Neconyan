import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
function runtime() {
    const state = { pinned: true, mobile: false, open: true, shell: false, frames: [], stored: new Map() };
    const context = vm.createContext({
        nnState: { characterDrawer: { displacedWhilePinned: false, restoreFrame: 0 } },
        document: { getElementById: () => ({ checked: state.pinned }) },
        window: { requestAnimationFrame: callback => state.frames.push(callback) },
        isMobileViewport: () => state.mobile,
        isCharacterPanelOpen: () => state.open,
        closeCharacterPanel: () => { state.open = false; },
        toggleCharacterPanel: () => { state.open = !state.open; },
        isShellOpen: () => state.shell,
        getShellAccountStorage: () => ({ getItem: key => state.stored.get(key), setItem: (key, value) => state.stored.set(key, value) }),
    });
    for (const name of ['isCharacterPanelPinned', 'closeCharacterPanelUnlessPinned', 'displaceCharacterPanel', 'rememberCharacterPanelOpenState', 'restorePinnedCharacterPanel', 'queuePinnedCharacterPanelRestore']) {
        vm.runInContext(source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0], context);
    }
    return { state, context };
}

describe('pinned character panel lifecycle', () => {
    test('workspace navigation preserves the docked panel only on desktop', () => {
        const { state, context } = runtime();
        context.closeCharacterPanelUnlessPinned();
        expect(state.open).toBe(true);
        state.mobile = true;
        context.closeCharacterPanelUnlessPinned();
        expect(state.open).toBe(false);
        state.mobile = false; state.pinned = false; state.open = true;
        context.closeCharacterPanelUnlessPinned();
        expect(state.open).toBe(false);
    });

    test('restores a displaced dock after settings close, preserving the saved open preference', () => {
        const { state, context } = runtime();
        state.stored.set('NavOpened', 'true');
        context.displaceCharacterPanel();
        context.rememberCharacterPanelOpenState(true, false);
        expect(state.stored.get('NavOpened')).toBe('true');
        state.shell = true;
        context.queuePinnedCharacterPanelRestore(); state.frames.shift()();
        expect(state.open).toBe(false);
        state.shell = false;
        context.queuePinnedCharacterPanelRestore(); state.frames.shift()();
        expect(state.open).toBe(true);
        expect(context.nnState.characterDrawer.displacedWhilePinned).toBe(false);
    });

    test('reload restores an open dock but respects an explicit close', () => {
        const { state, context } = runtime();
        state.open = false; state.stored.set('NavOpened', 'true');
        context.restorePinnedCharacterPanel();
        expect(state.open).toBe(true);
        state.open = false;
        context.rememberCharacterPanelOpenState(true, false);
        context.restorePinnedCharacterPanel();
        expect(state.open).toBe(false);
    });
});
