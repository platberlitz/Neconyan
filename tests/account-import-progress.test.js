import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/scripts/neconyan-tabs.js', import.meta.url), 'utf8');
const functions = ['showImportProgress', 'showNativeImportProgress', 'setSillyTavernImportBusy'].map(name =>
    source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0]).join('\n');

test('finishing the checking stage shows file counts, and stopping clears the previous progress', () => {
    const attributes = new Map([['value', 100]]);
    const progress = { hidden: true, removeAttribute: name => attributes.delete(name) };
    const progressLabel = { textContent: '' };
    const context = { getImporterRefs: () => ({ progress, progressLabel }), getImporterState: () => ({}), updateSillyTavernImportInteractivity: jest.fn() };
    runInNewContext(functions, context);
    context.setSillyTavernImportBusy(true);
    context.showNativeImportProgress({ stage: 'Checking chats, characters and settings', completed: 120, total: 120 });
    expect(progressLabel.textContent).toBe('Checking chats, characters and settings (120 of 120)');
    expect(attributes.has('value')).toBe(false);
    expect(progress.hidden).toBe(false);
    context.setSillyTavernImportBusy(false);
    expect(progress.hidden).toBe(true);
    expect(progressLabel.textContent).toBe('');
});
