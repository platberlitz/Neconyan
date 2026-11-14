import { beforeEach, expect, jest, test } from '@jest/globals';

const base = '../public/scripts/extensions/third-party/sillytavern-character-colors/src';

jest.unstable_mockModule(`${base}/live-colors.js`, () => ({
    applyLiveColorChangesFromSnapshot: jest.fn(),
    captureEffectiveColorSnapshot: jest.fn(() => ({})),
    commit: jest.fn(),
    refreshEffectiveColorsAfterRestore: jest.fn(),
}));
jest.unstable_mockModule(`${base}/storage.js`, () => ({
    captureHistoryPinState: jest.fn(() => ({})),
    restoreHistoryPinState: jest.fn(),
}));

const state = await import(`${base}/state.js`);
const history = await import(`${base}/history.js`);

beforeEach(() => {
    state.setCharacterColors({});
    state.setGroupProfiles({});
    state.setColorHistory([]);
    state.setHistoryIndex(-1);
    state.selectedCharacterKeys.clear();
    state.setExpandedCharacterRows(new Set());
    state.setSwapMode(null);
});

function saveColour(color) {
    state.setCharacterColors({ nova: { name: 'Nova', color, baseColor: color } });
    history.saveHistory();
}

test('unchanged background saves do not consume the deletion undo step', () => {
    saveColour('#88bbff');
    state.setCharacterColors({});
    history.saveHistory();
    history.saveHistory();
    history.saveHistory();

    history.undo();
    expect(state.characterColors.nova.baseColor).toBe('#88bbff');
    history.redo();
    expect(state.characterColors).toEqual({});
});

test('an unchanged save after undo preserves the redo choice', () => {
    saveColour('#88bbff');
    saveColour('#ffbb88');
    history.undo();
    history.saveHistory();

    history.redo();
    expect(state.characterColors.nova.baseColor).toBe('#ffbb88');
});

test('a real edit after undo replaces the old redo choice', () => {
    saveColour('#88bbff');
    saveColour('#ffbb88');
    history.undo();
    saveColour('#aabbcc');
    history.redo();
    expect(state.characterColors.nova.baseColor).toBe('#aabbcc');

    history.undo();
    expect(state.characterColors.nova.baseColor).toBe('#88bbff');
    history.redo();
    expect(state.characterColors.nova.baseColor).toBe('#aabbcc');
});
