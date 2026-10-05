import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const koboldSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'kai-settings.js'), 'utf8');

// Preset managers read the visible option text back as the preset's name (getSelectedPresetName,
// findPreset, getAllPresets, the context template handler, the /preset command). The run-time
// localiser must therefore never translate the options of a preset selector, so each one carries
// data-i18n-ignore. A new preset selector fails here until its author decides.
const presetSelects = [...indexHtml.matchAll(/<select\b[^>]*\bdata-preset-manager-for="([^"]+)"[^>]*>/g)]
    .map(match => ({ manager: match[1], tag: match[0] }));

test('every preset selector is marked as data so the localiser leaves its option text alone', () => {
    expect(presetSelects.map(select => select.manager).sort()).toEqual([
        'context', 'instruct', 'kobold', 'novel', 'openai', 'reasoning', 'sysprompt', 'textgenerationwebui',
    ]);
    const unmarked = presetSelects.filter(({ tag }) => !/\sdata-i18n-ignore(\s|>|=)/.test(tag)).map(select => select.manager);
    expect(unmarked).toEqual([]);
});

test('the KoboldAI GUI placeholder option is still translated by its key after the list is rebuilt', () => {
    const appended = koboldSource.match(/\.append\('(<option value="gui"[^']*>[^<]*<\/option>)'\)/);
    expect(appended).not.toBeNull();
    expect(appended[1]).toContain('data-i18n="guikoboldaisettings"');
    // The static option in index.html uses the same key, so boot and rebuild show the same text.
    expect(indexHtml).toMatch(/<option value="gui" data-i18n="guikoboldaisettings">GUI KoboldAI Settings<\/option>/);
});
