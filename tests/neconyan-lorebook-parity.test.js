import { describe, expect, test } from '@jest/globals';
import {
    canTestEntryKeys, classifyKey, findKeyMatches, keyTestVerdictText, testEntryKeys,
} from '../public/scripts/neconyan-lorebook-keytest.js';
import {
    checkLorebookHealth, healthSignature, quickHealthCount, runLorebookHealth, sanitizeHealthPrefs,
} from '../public/scripts/neconyan-lorebook-health.js';
import { planLorebookRepair, repairChangeText, repairDefectText } from '../public/scripts/neconyan-lorebook-repair.js';
import {
    estimateTokens, formatTokenCount, measureTokenFootprint, tokenFootprintTitle, worldInfoTokenBudget,
} from '../public/scripts/neconyan-lorebook-tokens.js';
import { exportLorebookProject, parseLorebookImport } from '../public/scripts/neconyan-lorebook-tools-core.js';

const entry = (uid, fields = {}) => ({ uid, comment: `Entry ${uid}`, content: '', key: [], keysecondary: [], selective: false, ...fields });
const lorebook = (...entries) => ({ entries: Object.fromEntries(entries.map(item => [String(item.uid), item])) });

describe('Test keys', () => {
    test('classifies keys the way SillyTavern does', () => {
        expect(classifyKey('/(?:saber|artoria)/i')).toBe('regex');
        expect(classifyKey('/[unclosed/')).toBe('invalid-regex');
        expect(classifyKey('plain')).toBe('text');
    });

    test('finds plain, whole-word and regex matches', () => {
        expect(findKeyMatches('paris', 'Paris and PARIS').ranges).toEqual([{ start: 0, end: 5 }, { start: 10, end: 15 }]);
        expect(findKeyMatches('paris', 'Paris and PARIS', { caseSensitive: true }).ranges).toEqual([]);
        expect(findKeyMatches('cat', 'concatenate cat', { matchWholeWords: true }).ranges).toEqual([{ start: 12, end: 15 }]);
        expect(findKeyMatches('/sab(er)?/gi', 'Saber, sab').ranges).toEqual([{ start: 0, end: 5 }, { start: 7, end: 10 }]);
        expect(findKeyMatches('/[bad/', 'a /[bad/ key')).toMatchObject({ kind: 'invalid-regex', ranges: [{ start: 2, end: 8 }] });
    });

    test('reaches the same verdict as the keyword scan', () => {
        const base = entry(1, { key: ['saber'], keysecondary: ['sword', 'king'], selective: true, selectiveLogic: 0 });
        expect(testEntryKeys(base, 'Saber lifts the sword').verdict).toEqual({ outlook: 'inserted', reason: 'always', probability: 100 });
        expect(testEntryKeys(base, 'Saber rests').verdict.reason).toBe('secondary-logic-denied');
        expect(testEntryKeys(base, 'nothing here').verdict.reason).toBe('no-key-matched');
        expect(testEntryKeys({ ...base, disable: true }, 'Saber').verdict.reason).toBe('disabled');
        expect(testEntryKeys({ ...base, key: [] }, 'Saber').verdict.reason).toBe('no-keys');
        expect(testEntryKeys({ ...base, key: [], vectorized: true }, 'Saber').verdict.outlook).toBe('inconclusive');
        expect(testEntryKeys({ ...base, probability: 40 }, 'Saber sword').verdict).toEqual({ outlook: 'probabilistic', reason: 'probability-roll', probability: 40 });
        expect(testEntryKeys({ ...base, probability: 40, useProbability: false }, 'Saber sword').verdict.reason).toBe('always');

        const notAny = testEntryKeys({ ...base, selectiveLogic: 2 }, 'Saber and the king');
        expect(notAny.verdict.reason).toBe('secondary-logic-denied');
        expect(notAny.secondary.map(row => row.blocks)).toEqual([false, true]);
        expect(keyTestVerdictText(notAny)).toBe('Would not be inserted - the matched "NOT ANY" secondary keys block activation.');
        expect(testEntryKeys({ ...base, selectiveLogic: 1 }, 'Saber sword king').verdict.reason).toBe('secondary-logic-denied');
        expect(testEntryKeys({ ...base, selectiveLogic: 3 }, 'Saber sword').verdict.reason).toBe('secondary-logic-denied');
        expect(testEntryKeys({ ...base, selective: false }, 'Saber').secondary).toEqual([]);
    });

    test('uses global settings for unset entry options and entry settings over them', () => {
        const unset = entry(1, { key: ['Saber'], caseSensitive: null });
        expect(testEntryKeys(unset, 'saber').verdict.reason).toBe('always');
        expect(testEntryKeys(unset, 'saber', { caseSensitive: true }).verdict.reason).toBe('no-key-matched');
        expect(testEntryKeys({ ...unset, caseSensitive: false }, 'saber', { caseSensitive: true }).verdict.reason).toBe('always');
    });

    test('builds excerpts and highlight runs with primary winning ties', () => {
        const result = testEntryKeys(entry(1, { key: ['sword'], keysecondary: ['sword'], selective: true }), `${'x'.repeat(40)} sword end`);
        expect(result.primary[0].excerpt).toBe('…xxxxxxxxxxxxxxxxxxxxxxxxxxxxx sword end');
        expect(result.segments.filter(part => part.tone !== 'none')).toEqual([{ text: 'sword', tone: 'primary' }]);
        expect(canTestEntryKeys(entry(1, { key: ['a'], constant: true }))).toBe(false);
        expect(canTestEntryKeys(entry(1))).toBe(false);
    });
});

describe('Health check', () => {
    test('flags entry-level problems', () => {
        const { diagnostics } = checkLorebookHealth(lorebook(
            entry(0, { key: ['/[bad/'] }),
            entry(1, { key: ['a'], content: '<Entry 1>\nbody\n</Other>' }),
            entry(2, { key: ['b'], keysecondary: ['x'], constant: true }),
            entry(3, { key: ['c'], keysecondary: ['x'] }),
            entry(4, { key: ['d'], selective: true }),
            entry(5),
            entry(6, { vectorized: true }),
        ));
        expect(diagnostics.map(item => [item.rule, item.severity, item.entryIds.join()])).toEqual([
            ['invalid-regex', 'error', '0'],
            ['malformed-wrapper', 'error', '1'],
            ['secondary-keys-ignored', 'warning', '2'],
            ['secondary-keys-ignored', 'warning', '3'],
            ['never-activatable', 'warning', '5'],
            ['selective-without-secondary', 'info', '4'],
        ]);
        expect(diagnostics[2].message).toContain('is constant');
        expect(diagnostics[3].message).toContain('is not selective');
    });

    test('finds duplicate keys, respecting case sensitivity and shared groups', () => {
        const run = (...entries) => checkLorebookHealth(lorebook(...entries)).diagnostics.filter(item => item.rule === 'duplicate-key');
        const [duplicate] = run(entry(0, { key: ['Paris'] }), entry(1, { key: ['paris'] }), entry(2, { key: ['paris'], disable: true }));
        expect(duplicate).toMatchObject({ severity: 'warning', entryIds: ['0', '1'], details: 'Paris' });
        expect(duplicate.message).toBe('Entries "Entry 0" and "Entry 1" share the primary key \'Paris\' - they compete for the same activation.');
        expect(run(entry(0, { key: ['Paris'], caseSensitive: true }), entry(1, { key: ['paris'], caseSensitive: true }))).toEqual([]);
        expect(run(entry(0, { key: ['x'], group: 'g' }), entry(1, { key: ['x'], group: 'g' }))[0].severity).toBe('info');
    });

    test('finds recursion loops and self-triggers only in the full pass', () => {
        const book = lorebook(
            entry(0, { key: ['alpha'], content: 'mentions beta' }),
            entry(1, { key: ['beta'], content: 'mentions alpha' }),
            entry(2, { key: ['gamma'], content: 'gamma again' }),
            entry(3, { key: ['delta'], content: 'alpha', preventRecursion: true }),
        );
        const { diagnostics } = checkLorebookHealth(book);
        expect(diagnostics.map(item => [item.rule, item.details])).toEqual([
            ['recursion-cycle', 'Entry 0 → Entry 1 → Entry 0'],
            ['self-trigger', 'gamma'],
        ]);
        expect(checkLorebookHealth(book, { includeGraphRules: false }).diagnostics).toEqual([]);
        expect(quickHealthCount(book)).toBe(0);
    });

    test('mutes rules and hides findings marked not an issue', async () => {
        const book = lorebook(entry(0, { key: ['/[bad/'] }), entry(1));
        const all = checkLorebookHealth(book).diagnostics;
        const hidden = checkLorebookHealth(book, { prefs: { ignoredSignatures: [healthSignature(all[0])], mutedRules: ['never-activatable'] } });
        expect(hidden).toEqual({ diagnostics: [], hidden: 1 });
        expect(sanitizeHealthPrefs({ ignoredSignatures: ['a', '', 3, 'a'], mutedRules: ['duplicate-key', 'nope'] }))
            .toEqual({ ignoredSignatures: ['a'], mutedRules: ['duplicate-key'] });
        expect(sanitizeHealthPrefs(null)).toBeUndefined();
        const progress = [];
        const result = await runLorebookHealth(book, { onProgress: value => progress.push(value) });
        expect(result.diagnostics).toHaveLength(2);
        expect(progress.at(-1)).toBe(1);
        expect(await runLorebookHealth(book, { isCancelled: () => true })).toBeNull();
    });
});

describe('Broken id repair', () => {
    test('leaves clean books untouched', () => {
        const book = lorebook(entry(0), entry(1));
        const plan = planLorebookRepair(book);
        expect(plan.book).toBe(book);
        expect(plan.changes).toEqual([]);
    });

    test('fixes text, missing, duplicate and misfiled native ids', () => {
        const plan = planLorebookRepair({ entries: {
            0: entry(0),
            1: entry('7', { comment: 'Tavern' }),
            2: entry(0, { comment: 'Copy' }),
            3: { comment: 'No id', content: '' },
            9: entry(4, { comment: 'Misfiled', order: Number.NaN }),
        } });
        expect(plan.changes.map(repairChangeText)).toEqual([
            'Tavern: id "7" → 7',
            'Copy: id 0 → 8',
            'No id: id (missing) → 3',
            'Misfiled: slot "9" → "4"',
            'Misfiled: insertion order NaN → 100',
        ]);
        expect(Object.keys(plan.book.entries).sort()).toEqual(['0', '3', '4', '7', '8']);
        expect(Object.entries(plan.book.entries).every(([slot, item]) => slot === String(item.uid))).toBe(true);
    });

    test('fixes character book ids and reports what it cannot fix', () => {
        const plan = planLorebookRepair({ entries: [
            { id: 1, keys: ['a'], content: 'a' },
            { id: '1', keys: ['b'], content: 'b', priority: 'high' },
            { keys: ['c'], content: 'c' },
        ] });
        expect(plan.changes.map(repairChangeText)).toEqual(['b: id "1" → 2', 'b: priority "high" → (unset)', 'c: id (missing) → 3']);
        expect(plan.book.entries[1]).not.toHaveProperty('priority');
        const broken = planLorebookRepair({ entries: [{ id: 1, keys: 'a', content: 5 }] });
        expect(broken.defects.map(repairDefectText)).toEqual(['Entry 1: Content is not text', 'Entry 1: Keys is not a list of keywords']);
        expect(planLorebookRepair({ entries: 'nope' }).defects.map(repairDefectText)).toEqual(['The entries collection is malformed']);
    });
});

describe('Token footprint', () => {
    test('estimates and formats token counts', () => {
        expect(estimateTokens('abcdefgh')).toBe(2);
        expect(estimateTokens('巴黎ab')).toBe(3);
        expect([950, 1200, 1000, 24400].map(formatTokenCount)).toEqual(['950', '1.2k', '1k', '24k']);
        expect(worldInfoTokenBudget({ percent: 25, maxPromptTokens: 8000 })).toBe(2000);
        expect(worldInfoTokenBudget({ percent: 25, maxPromptTokens: 8000, cap: 500 })).toBe(500);
    });

    test('counts only enabled always-active entries against the budget', async () => {
        const book = lorebook(
            entry(0, { constant: true, content: 'x'.repeat(400) }),
            entry(1, { constant: true, content: 'x'.repeat(40) }),
            entry(2, { constant: true, disable: true, content: 'x'.repeat(4000) }),
            entry(3, { content: 'x'.repeat(4000) }),
        );
        const near = await measureTokenFootprint(book, { budget: 125 });
        expect(near).toMatchObject({ total: 110, nearBudget: true, overBudget: false });
        expect(near.items.map(item => item.uid)).toEqual(['0', '1']);
        const over = await measureTokenFootprint(book, { budget: 100, count: async text => text.length });
        expect(over).toMatchObject({ total: 440, overBudget: true, nearBudget: false });
        expect(tokenFootprintTitle(over)).toBe('Always active: ~440 tokens across 2 always-active entries of the 100 World Info budget (440%) - over budget! Click to inspect.');
    });
});

describe('Health check choices in project files', () => {
    test('workspace.lintPrefs round-trips through .stproj export and import, dropping unknown checks', () => {
        const book = { entries: { 0: { uid: 0, key: ['Paris'], content: 'Paris' } } };
        const history = { version: 1, commits: [], headCommitId: null, lintPrefs: { ignoredSignatures: ['self-trigger|0|Paris'], mutedRules: ['duplicate-key'] } };
        const exported = JSON.parse(JSON.stringify(exportLorebookProject('Book', book, history)));
        expect(exported.version).toBe(1);
        expect(exported.workspace.lintPrefs).toEqual(history.lintPrefs);
        exported.workspace.lintPrefs.mutedRules.push('not-a-rule');
        const imported = parseLorebookImport(exported, value => value);
        expect(imported.history.lintPrefs).toEqual(history.lintPrefs);
        delete exported.workspace.lintPrefs;
        expect(parseLorebookImport(exported, value => value).history).not.toHaveProperty('lintPrefs');
    });
});
