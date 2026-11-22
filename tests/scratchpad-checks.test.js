import { describe, expect, test } from '@jest/globals';
import { cardCssSources, brokenCardSelectors, cardDefinedIds, checkCharacterCard, unbalancedHtml } from '../public/scripts/scratchpad/checks/card.js';
import { formatChecks, formatLorebookDetails, formatPresetValues, MAX_FINDINGS_PER_ITEM, targetLabel } from '../public/scripts/scratchpad/checks/index.js';
import { checkLorebook } from '../public/scripts/scratchpad/checks/lorebook.js';
import { scanMacroProblems } from '../public/scripts/scratchpad/checks/macros.js';
import { checkPreset } from '../public/scripts/scratchpad/checks/preset.js';

function cardData(overrides = {}) {
    return {
        name: 'Ada',
        description: 'A careful lighthouse keeper.',
        personality: 'Quiet and watchful.',
        scenario: '',
        first_mes: 'Hello there.',
        alternate_greetings: [],
        group_only_greetings: [],
        mes_example: '<START>\n{{user}}: Hello.\n{{char}}: Hello.',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        ...overrides,
    };
}

function card(overrides = {}) {
    return { name: 'Ada', avatar: 'Ada.png', shallow: false, data: cardData(overrides) };
}

function rules(result) {
    return result.findings.map(item => item.rule);
}

describe('Scratchpad macro checks', () => {
    test('finds unbalanced braces, unknown names and broken scoped forms', () => {
        const text = '{{char} {{unknownmacro}} {{//}}hidden{{///}} {{#if}}open';
        expect(rules({ findings: scanMacroProblems(text, { knownNames: ['char', 'user'] }) })).toEqual(expect.arrayContaining([
            'macro-unbalanced', 'macro-unknown', 'macro-scoped-comment',
        ]));
    });

    test('pairs scoped macros the way the macro engine does', () => {
        const knownNames = ['if', 'else', 'trim', 'setvar', 'getvar', 'user', 'char'];
        for (const text of [
            '{{if 1}}yes{{else}}no{{/if}}',
            'x{{trim}}  y  {{/trim}}z',
            '{{setvar::a}}val{{/setvar}}[{{getvar::a}}]',
            '{{if {{getvar::a}}}}h{{/if}}',
            '{{#user}} hi',
            '{{#if 1}}x{{/if}}',
            '{{time_UTC+2}}',
        ]) expect(scanMacroProblems(text, { knownNames })).toEqual([]);
        expect(scanMacroProblems('{{/if}}', { knownNames })).toEqual([expect.objectContaining({ rule: 'macro-unmatched-close', severity: 'info' })]);
    });

    test('structural problems still run without a macro registry', () => {
        expect(scanMacroProblems('{{char}', { knownNames: [] })).toContainEqual(expect.objectContaining({ rule: 'macro-unbalanced', severity: 'error' }));
        expect(scanMacroProblems('{{//}}hidden{{///}}', { knownNames: [] })).toContainEqual(expect.objectContaining({ rule: 'macro-scoped-comment' }));
        expect(scanMacroProblems('{{unknownmacro}}', { knownNames: [] })).toEqual([]);
    });

    test('leaves balanced known macros, nested arguments and raw comments alone', () => {
        expect(scanMacroProblems('{{char}} {{#if {{getvar::mood}}}}yes{{/if}} {{//}} a note {{//}}', { knownNames: ['char', 'if', 'getvar'] })).toEqual([]);
    });
});

describe('Scratchpad card checks', () => {
    test('reports a card with empty fields, broken greetings, CSS and macros', async () => {
        const character = card({
            name: '',
            description: '<style>.a { color: red; }',
            first_mes: '{{user}} smiles and says hello <b>there',
            alternate_greetings: ['', 'Again.', 'Again.'],
            mes_example: 'Ada: hello',
            creator_notes: '<style>#chat body { color: red; }</style>',
            system_prompt: '{{char} {{unknownmacro}}',
        });
        character.data.extensions = { world: 'Missing Book' };
        const result = await checkCharacterCard(character, {
            name: '', contextSize: 1000, knownMacros: ['char', 'user'], knownLorebooks: ['Existing Book'], extraBooks: ['Also Missing'],
            countTokens: text => Math.ceil(String(text).length / 4),
        });
        expect(rules(result)).toEqual(expect.arrayContaining([
            'card-writes-user', 'card-unbalanced-html',
            'card-example-format', 'card-empty-greeting', 'card-duplicate-greeting', 'card-unclosed-style', 'card-css-selector',
            'macro-unknown', 'macro-unbalanced', 'card-lorebook-missing',
        ]));
        expect(result.findings.every(item => item.target.kind === 'card' && item.message)).toBe(true);
    });

    test('reports empty essential fields', async () => {
        const result = await checkCharacterCard({ name: '', data: cardData({ name: '', description: '', first_mes: '' }) }, { contextSize: 4096 });
        expect(rules(result)).toEqual(expect.arrayContaining(['card-empty-name', 'card-empty-description', 'card-empty-first-message']));
    });

    test('gives a clean card no error or warning', async () => {
        const result = await checkCharacterCard(card(), {
            name: 'Ada', contextSize: 4096, knownMacros: ['char', 'user'], knownLorebooks: ['Existing Book'], extraBooks: [],
            countTokens: text => Math.ceil(String(text).length / 4),
        });
        expect(result.findings.filter(item => item.severity !== 'info')).toEqual([]);
        expect(result.name).toBe('Ada');
    });

    test('does not flag a card CSS id that its own HTML defines', async () => {
        const character = card({ first_mes: '<div id="x">Hello</div>', creator_notes: '<style>#x { color: red; }</style>' });
        const defined = await checkCharacterCard(character, { contextSize: 4096 });
        expect(defined.findings.some(item => item.rule === 'card-css-selector')).toBe(false);
        const missing = await checkCharacterCard(card({ first_mes: 'Hello', creator_notes: '<style>#missing { color: red; }</style>' }), { contextSize: 4096 });
        expect(missing.findings).toContainEqual(expect.objectContaining({ rule: 'card-css-selector', severity: 'warning' }));
    });

    test('warns when permanent card text takes over half the context', async () => {
        const result = await checkCharacterCard(card(), { contextSize: 10, countTokens: () => 6 });
        expect(result.findings).toContainEqual(expect.objectContaining({ rule: 'card-permanent-tokens', severity: 'warning' }));
    });

    test('does not mistake a mention of {{user}} for writing their actions', async () => {
        const result = await checkCharacterCard(card({ first_mes: '*She looks at {{user}} and smiles.* Hello there.' }), { contextSize: 4096 });
        expect(result.findings.some(item => item.rule === 'card-writes-user')).toBe(false);
        for (const first_mes of ['{{user}}: Hello.', '*{{user}} nods and walks in.*']) {
            const written = await checkCharacterCard(card({ first_mes }), { contextSize: 4096 });
            expect(written.findings).toContainEqual(expect.objectContaining({ rule: 'card-writes-user', severity: 'warning' }));
            expect(written.findings.find(item => item.rule === 'card-writes-user').message).toContain('appears to write');
        }
    });

    test('treats optional end tags as valid HTML', () => {
        expect(unbalancedHtml('<p>One<li>Two')).toBe('');
        expect(unbalancedHtml('<p>One<li>Two</p></li>')).toBe('');
        expect(unbalancedHtml('<div>Not closed')).toBe('<div>');
    });

    test('marks a shallow card as not fully checked', async () => {
        const result = await checkCharacterCard({ ...card(), shallow: true }, { contextSize: 4096 });
        expect(result.findings).toContainEqual(expect.objectContaining({ rule: 'card-shallow', severity: 'info' }));
    });

    test('recognises CSS that cannot work once it is scoped to .mes_text', () => {
        expect(brokenCardSelectors('#chat .x { color: red; } body { color: red; } .ok { color: red; }')).toEqual(['#chat .x', 'body']);
        expect(cardCssSources(card({ creator_notes: '<style>.a { color: red; }</style>' })).css).toContain('.a');
        expect(unbalancedHtml('A <b>bold</b> and <i>italic</i>.')).toBe('');
        expect(unbalancedHtml('A <b>bold sentence.')).toBe('<b>');
    });

    test('allows ids the card itself defines and flags shell or missing ids', () => {
        const character = card({ first_mes: '<div id="x">Hello</div>' });
        expect(cardDefinedIds(character)).toContain('x');
        expect(brokenCardSelectors('#x { color: red; }', cardDefinedIds(character))).toEqual([]);
        expect(brokenCardSelectors('#missing { color: red; }', cardDefinedIds(character))).toEqual(['#missing']);
        expect(brokenCardSelectors('#chat { color: red; }', cardDefinedIds(character))).toEqual(['#chat']);
        expect(brokenCardSelectors('html body { color: red; }', cardDefinedIds(character))).toEqual(['html body']);
    });
});

describe('Scratchpad preset checks', () => {
    const cleanChat = {
        kind: 'chat', api: 'Chat Completion', name: 'Clean',
        modules: [
            { id: 'chatHistory', name: 'Chat History', enabled: true, marker: true, content: '' },
            { id: 'charDescription', name: 'Char Description', enabled: true, marker: true, content: '' },
            { id: 'main', name: 'Main Prompt', enabled: true, marker: false, content: 'Write {{char}} next.' },
        ],
        values: { contextSize: 4096, replyLength: 512, samplers: [{ key: 'temperature', label: 'Temperature', value: 1 }] },
        connection: { source: 'openai', sourceLabel: 'OpenAI', model: 'test-model', modelContext: 8192 },
    };

    test('gives a clean preset no findings', () => {
        expect(checkPreset(cleanChat, { knownMacros: ['char'], modelContext: 8192 }).findings).toEqual([]);
    });

    test('finds missing slots, duplicate and empty modules, macro and sampler problems', () => {
        const preset = {
            kind: 'chat', name: 'Broken',
            modules: [
                { id: 'chatHistory', name: 'Chat History', enabled: false, marker: true, content: '' },
                { id: 'main', name: 'Main Prompt', enabled: true, marker: false, content: '' },
                { id: 'main', name: 'Main Prompt again', enabled: true, marker: false, content: '{{unknownmacro}}' },
            ],
            values: {
                contextSize: 100, replyLength: 100, continuePrefill: true, assistantPrefill: 'Sure',
                samplers: [{ key: 'temperature', label: 'Temperature', value: 2 }],
            },
            connection: { source: 'openai', sourceLabel: 'OpenAI', modelContext: 50 },
        };
        const result = checkPreset(preset, { knownMacros: ['char'], modelContext: 50 });
        expect(rules(result)).toEqual(expect.arrayContaining([
            'preset-slot-missing', 'preset-slot-off', 'preset-duplicate-id', 'preset-module-empty',
            'macro-unknown', 'preset-reply-length', 'preset-context-over-model', 'preset-temperature-extreme', 'preset-prefill-unsupported',
        ]));
    });

    test('separates Continue prefill from Claude Assistant Prefill', () => {
        const preset = structuredClone(cleanChat);
        preset.values.continuePrefill = true;
        preset.values.assistantPrefill = '';
        expect(checkPreset(preset, { knownMacros: ['char'] }).findings.some(item => item.rule === 'preset-prefill-unsupported')).toBe(false);
        preset.values.assistantPrefill = 'Start the answer with...';
        expect(checkPreset(preset, { knownMacros: ['char'] }).findings).toContainEqual(expect.objectContaining({ rule: 'preset-prefill-unsupported', severity: 'warning' }));
        preset.values.continuePrefill = false;
        expect(checkPreset(preset, { knownMacros: ['char'] }).findings).toContainEqual(expect.objectContaining({ rule: 'preset-prefill-unsupported' }));
    });

    test('checks Text Completion instruct settings', () => {
        const preset = {
            kind: 'text', name: 'Text',
            modules: [
                { id: 'sysprompt', name: 'System prompt', enabled: true, marker: false, content: 'Write.' },
                { id: 'context', name: 'Context template', enabled: true, marker: false, content: '' },
                { id: 'instruct', name: 'Instruct template', enabled: true, marker: false, content: '' },
            ],
            values: { contextSize: 2048, replyLength: 80, samplers: [], instructEnabled: true, instructPreset: '', contextPreset: 'ChatML' },
            connection: { source: 'ooba', sourceLabel: 'Text generation web UI' },
        };
        expect(rules(checkPreset(preset))).toContain('preset-instruct-template');
    });
});

describe('Scratchpad lorebook checks', () => {
    function book(entries) {
        return { entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) };
    }

    test('reports activation problems and always-on entries over budget', async () => {
        const loaded = book([
            { uid: 0, comment: 'Always', constant: true, key: [], content: 'x'.repeat(400) },
            { uid: 1, comment: 'Chance', key: ['ghost'], probability: 0, content: 'A ghost.' },
            { uid: 2, comment: 'No scan', key: ['tide'], scanDepth: 0, content: 'The tide.' },
            { uid: 3, comment: 'Off', key: ['x'], disable: true, content: 'Hidden content.' },
            { uid: 4, comment: 'Hidden', key: ['secret'], agentBlacklisted: true, content: 'SECRET' },
            { uid: 5, comment: 'Duplicate keys', key: ['tide', 'tide'], content: 'The tide again.' },
        ]);
        const result = await checkLorebook({
            name: 'Harbour', book: loaded, scanText: 'lighthouse', contextSize: 100,
            budget: { percent: 10, cap: 0 }, defaults: { caseSensitive: false, matchWholeWords: false },
        });
        expect(rules(result)).toEqual(expect.arrayContaining([
            'lorebook-probability-zero', 'lorebook-scan-depth-zero', 'lorebook-constant-over-budget',
            'lorebook-did-not-match', 'duplicate-key',
        ]));
        expect(result.findings.filter(item => item.rule === 'lorebook-did-not-match')).toHaveLength(1);
        expect(result.findings.find(item => item.rule === 'lorebook-did-not-match').message).toBe('3 entries did not match the recent text.');
        expect(result.findings.some(item => item.message.includes('Always-on entries use'))).toBe(true);
    });

    test('uses the book scan depth when an entry has no override', async () => {
        const loaded = book([{ uid: 0, comment: 'Ghost', key: ['ghost'], content: 'A ghost.' }]);
        const result = await checkLorebook({ name: 'Harbour', book: loaded, scanDepth: 0 });
        expect(rules(result)).toContain('lorebook-scan-depth-zero');
    });

    test('gives a clean lorebook no findings', async () => {
        const loaded = book([{ uid: 0, comment: 'Lamp', key: ['lighthouse'], content: 'The lamp is lit.', constant: true, probability: 100 }]);
        const result = await checkLorebook({
            name: 'Harbour', book: loaded, scanText: 'lighthouse', contextSize: 4000,
            budget: { percent: 25, cap: 0 }, defaults: { caseSensitive: false, matchWholeWords: false },
        });
        expect(result.findings).toEqual([]);
    });

    test('reports an empty or missing lorebook once', async () => {
        const result = await checkLorebook({ name: 'Empty', book: { entries: {} } });
        expect(rules(result)).toEqual(['lorebook-unavailable']);
    });
});

describe('Scratchpad check formatting', () => {
    test('names the item and caps long finding lists', () => {
        const findings = Array.from({ length: MAX_FINDINGS_PER_ITEM + 3 }, (_, index) => ({
            rule: 'rule', severity: index === 0 ? 'error' : 'info', target: { kind: 'card', name: 'Ada', field: 'description' }, message: `Finding ${index}.`,
        }));
        const text = formatChecks([{ kind: 'card', name: 'Ada', findings }]);
        expect(text.split('\n')).toHaveLength(MAX_FINDINGS_PER_ITEM + 1);
        expect(text).toContain('error | Character: Ada | description | Finding 0.');
        expect(text).toContain('3 more findings were left out.');
        expect(targetLabel({ kind: 'preset', name: 'P', module: 'main' })).toBe('Preset: P | module main');
        expect(targetLabel({ kind: 'lorebook', name: 'Book', uid: 2, title: 'Lamp' })).toBe('Lorebook: Book | uid 2 | Lamp');
    });

    test('cuts info before warnings and errors when the cap is reached', () => {
        const findings = [
            ...Array.from({ length: 45 }, (_, index) => ({ rule: 'info', severity: 'info', target: { kind: 'card', name: 'Ada' }, message: `Info ${index}.` })),
            ...Array.from({ length: 5 }, (_, index) => ({ rule: 'warning', severity: 'warning', target: { kind: 'card', name: 'Ada' }, message: `Warning ${index}.` })),
        ];
        const text = formatChecks([{ kind: 'card', name: 'Ada', findings }]);
        expect(text).toContain('Warning 0.');
        expect(text).toContain('Warning 4.');
        expect(text).toContain('+ 10 more'.replace('+ ', ''));
        expect(text).not.toContain('Info 44.');
        expect(text.split('\n')).toHaveLength(MAX_FINDINGS_PER_ITEM + 1);
    });

    test('says a clean item is clean', () => {
        expect(formatChecks([{ kind: 'preset', name: 'Clean', findings: [] }])).toBe('- ok | Preset: Clean | No problems found by the fixed checks.');
    });

    test('shares full activation detail, skipped entries and hidden counts without hidden content', () => {
        const lore = {
            details: { books: [{
                name: 'Harbour',
                settings: { scanDepth: 2, tokenBudget: 25, tokenBudgetCap: 0, recursive: true, maxRecursionSteps: 2, caseSensitive: false, matchWholeWords: true },
                shared: [{
                    uid: 0, title: 'Lamp', keys: ['lighthouse'], secondaryKeys: ['light'], selective: true, selectiveLogic: 3, constant: false,
                    probability: 100, order: 100, position: 0, depth: 4, excludeRecursion: false, preventRecursion: true, group: '', sticky: 0,
                    cooldown: 0, delay: 0, included: true, shareReason: null,
                }],
                skipped: [{ uid: 1, title: 'Off', keys: ['off'], reason: 'disabled' }],
                hiddenCount: 2,
            }] },
        };
        const text = formatLorebookDetails(lore);
        expect(text).toContain('Book settings: scan depth: 2 | token budget: 25%');
        expect(text).toContain('[shared] Lamp | uid: 0 | keys: lighthouse');
        expect(text).toContain('secondary keys: light');
        expect(text).toContain('prevent recursion: yes');
        expect(text).toContain('not shared: Off | uid: 1 | keys: off | reason: disabled');
        expect(text).toContain('2 entries are hidden from Agents and were not shared.');
        expect(text).not.toContain('SECRET');
    });

    test('shares sampler values and the model, never credentials or a URL', () => {
        const text = formatPresetValues({
            kind: 'chat',
            values: { contextSize: 8192, replyLength: 512, continuePrefill: false, samplers: [{ key: 'temperature', label: 'Temperature', value: 1 }, { key: 'top_p', label: 'Top P', value: 0.9 }] },
            connection: { source: 'custom', sourceLabel: 'Custom (OpenAI-compatible)', model: 'local-model', proxyPassword: 'secret', reverseProxy: 'https://user:pass@example.test/v1?key=1' },
        });
        expect(text).toContain('Connection: Custom (OpenAI-compatible) | Model: local-model');
        expect(text).toContain('Context size: 8192 | Reply length: 512');
        expect(text).toContain('Temperature: 1');
        expect(text).toContain('Continue prefill: off');
        expect(text).toContain('Assistant Prefill: none');
        const prefilled = formatPresetValues({
            kind: 'chat',
            values: { contextSize: 4096, replyLength: 256, continuePrefill: true, assistantPrefill: 'Start here.', samplers: [] },
            connection: { source: 'openai', sourceLabel: 'OpenAI' },
        });
        expect(prefilled).toContain('Continue prefill: on');
        expect(prefilled).toContain('Assistant Prefill: Start here.');
        expect(text).not.toContain('secret');
        expect(text).not.toContain('https://');
    });
});
