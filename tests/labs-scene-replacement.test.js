import { mergeSavedSceneReplacement } from '../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/scenes.js';

test('scene retries preserve previous and later replies until replacements are saved', () => {
    const previous = { turns: [1, 2, 3].map(index => ({ index, text: `Saved ${index}` })), caveats: [] };
    const waiting = mergeSavedSceneReplacement(previous, { turns: [{ index: 2, waiting: true, text: '' }] });
    expect(waiting.turns).toEqual(previous.turns);
    const failed = mergeSavedSceneReplacement(waiting, { error: 'Unknown outcome', turns: [{ index: 2, error: 'Unknown outcome', text: '' }] });
    expect(failed.turns).toEqual(previous.turns);
    expect(failed.error).toBe('Unknown outcome');
    const saved = mergeSavedSceneReplacement(previous, { turns: [{ index: 2, text: 'New saved reply', waiting: false }] });
    expect(saved.turns.map(turn => turn.text)).toEqual(['Saved 1', 'New saved reply', 'Saved 3']);
    expect(previous.turns[1].text).toBe('Saved 2');
});
