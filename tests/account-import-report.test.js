import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/scripts/account-import.js', import.meta.url), 'utf8');
const start = source.indexOf('export function describeAccountImportSkips(');
const end = source.indexOf('/** The screen shows', start);
const context = { SKIPPED_SHOWN: 20 };
vm.createContext(context);
vm.runInContext(source.slice(start, end).replace('export function', 'function'), context);
const formatReport = context.describeAccountImportSkips;

test('intentional exclusions are named with reasons and are never described as damaged', () => {
    const text = formatReport({ excludedCount: 1, excluded: [{ file: 'entity-date-added.json', reason: 'Account bookkeeping is not needed.' }], personaSettingsOnly: true });
    expect(text).toContain('1 file was left out on purpose:');
    expect(text).toContain('entity-date-added.json: Account bookkeeping is not needed.');
    expect(text).toContain('Only persona names and descriptions were read from settings.json.');
    expect(text).not.toContain('damaged');
});

test('a mixed report distinguishes damage from deliberate omissions and does not claim everything imported', () => {
    const text = formatReport({ excludedCount: 1, excluded: [{ file: 'themes/Old.json', reason: 'Your current appearance is kept.' }],
        skippedCount: 1, skipped: [{ file: 'characters/Broken.png', reason: 'Cannot read \'characters/Broken.png\': Invalid PNG.' }] });
    expect(text).toContain('left out on purpose');
    expect(text).toContain('1 file was damaged and could not be imported:');
    expect(text).toContain('characters/Broken.png');
    expect(text).toContain('Other selected files were imported.');
    expect(text).not.toContain('Everything else was imported.');
});

test('long exclusion reports point to the full downloadable file list', () => {
    const excluded = Array.from({ length: 30 }, (_, index) => ({ file: `themes/Theme ${index}.json`, reason: 'Not imported.' }));
    const text = formatReport({ excludedCount: 30, excluded });
    expect(text).toContain('Theme 19.json'); expect(text).not.toContain('Theme 20.json');
    expect(text).toContain('10 more. Download the report for the full list.');
    expect(formatReport({ skippedCount: 0, excludedCount: 0 })).toBe('');
});

test('partly used settings are explained even without other excluded files', () => {
    expect(formatReport({ skippedCount: 0, excludedCount: 0, personaSettingsOnly: true, parts: ['personas'] })).toBe(
        'Selected libraries: Personas.\n\nOnly persona names and descriptions were read from settings.json. Other settings in that file were not imported.');
});
