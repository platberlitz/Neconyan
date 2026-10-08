import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    regexFromString: jest.fn(value => {
        const match = String(value ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
        return match ? new RegExp(match[1], match[2]) : new RegExp(String(value ?? ''));
    }),
    uuidv4: jest.fn(() => 'test-uuid'),
}));

const {
    AGENT_REGEX_PLACEMENT,
    applyRegexScriptList,
} = await import('../public/scripts/extensions/in-chat-agents/regex-scripts.js');

const templateDir = new URL('../public/scripts/extensions/in-chat-agents/templates/', import.meta.url);
const indexSourceUrl = new URL('../public/scripts/extensions/in-chat-agents/index.js', import.meta.url);
const sourceFilenames = [
    'achievements-tracker.json',
    'actor-interview-companion.json',
    'afflictions-blessings.json',
    'almanac-generator.json',
    'beat-planner.json',
    'chat-only-companion.json',
    'chatroom-companion.json',
    'clock-is-lying.json',
    'continuity-companion.json',
    'continuity-pins.json',
    'cyoa-choices-skill-checks.json',
    'dialogue-humaniser.json',
    'directors-commentary-companion.json',
    'doors-fate-checks.json',
    'doors.json',
    'drift-tracker.json',
    'entanglement-tracker.json',
    'event-tracker.json',
    'format-fixer.json',
    'four-winds.json',
    'friction-keeper.json',
    'improbable-effects.json',
    'intent-reader.json',
    'item-tracker.json',
    'knowledge-guard.json',
    'length-trimmer.json',
    'lorebook-scout-companion.json',
    'meanwhile-impossibly.json',
    'memory-shard-companion.json',
    'message-inbox-companion.json',
    'motif-tracker.json',
    'npc-profiles.json',
    'omen-tracker.json',
    'pace-setter.json',
    'parallel-tracker.json',
    'plot-compass-companion.json',
    'proofreader.json',
    'relationship-lens-companion.json',
    'relationship-tracker.json',
    'repeat-spotter.json',
    'repetition-breaker.json',
    'reputation-tracker.json',
    'scene-tracker.json',
    'secrets-tracker.json',
    'small-miracles.json',
    'status-tracker.json',
    'the-becoming.json',
    'the-census.json',
    'the-committee.json',
    'the-ledger.json',
    'the-turning.json',
    'thin-places-tracker.json',
    'thought-cabinet.json',
    'time-tracker.json',
    'user-agency-guard.json',
    'what-the-town-knows.json',
    'world-detail.json',
];

function readTemplate(filename) {
    return JSON.parse(fs.readFileSync(new URL(filename, templateDir), 'utf8'));
}

function readIndexSetBody(name) {
    const source = fs.readFileSync(indexSourceUrl, 'utf8');
    const match = source.match(new RegExp(`${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));

    if (!match) {
        throw new Error(`Missing set definition: ${name}`);
    }

    return match[1];
}

function readIndexFunctionBody(name) {
    const source = fs.readFileSync(indexSourceUrl, 'utf8');
    const start = source.indexOf(`function ${name}(`);

    if (start === -1) {
        throw new Error(`Missing function definition: ${name}`);
    }

    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i++) {
        if (source[i] === '{') {
            depth++;
        } else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, i + 1);
            }
        }
    }

    throw new Error(`Unterminated function: ${name}`);
}

async function importAgentStore() {
    jest.resetModules();

    await jest.unstable_mockModule('../public/script.js', () => ({
        getRequestHeaders: jest.fn(() => ({})),
        saveSettings: jest.fn(async () => true),
        saveSettingsDebounced: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
        extension_settings: {},
        getContext: jest.fn(() => ({ groupId: null })),
    }));

    await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
        regexFromString: jest.fn(value => {
            const match = String(value ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
            return match ? new RegExp(match[1], match[2]) : new RegExp(String(value ?? ''));
        }),
        uuidv4: jest.fn(() => 'test-uuid'),
    }));

    return await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
}

function findCatalogTemplate(catalog, templateId) {
    const template = catalog.find(template => template.id === templateId);

    if (!template) {
        throw new Error(`Missing catalog template: ${templateId}`);
    }

    return template;
}

function renderChatroomOutput(source) {
    const chatroom = readTemplate('chatroom-companion.json');
    return applyRegexScriptList(source, chatroom.regexScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
        isMarkdown: true,
    });
}

const updatingExistingStatsSection = '## Updating Existing Stats\n\nIf an existing [USER_STATS] block is provided, update it instead of generating a new one.\n\nWhen applying a [LEVEL_UP]:\n- Increase Level by 1.\n- Apply skill increases.\n- Add earned perk, if any.\n- Preserve existing traits, perks, weaknesses, and notes unless changed.\n- Keep stats consistent and setting-specific.\n[/USER_STATS]';

function expectLevelUpStatsDefaults(levelUp, stats) {
    expect(levelUp.companion).toEqual(expect.objectContaining({
        batch: true,
    }));
    expect(levelUp.companion.batchAgentIds).toContain('tpl-user-based-stats-generator');
    expect(levelUp.companion.sendContextToCompanions).toBe(true);
    expect(levelUp.companion.contextRecipientAgentIds).toContain('tpl-user-based-stats-generator');
    expect(stats.companion).toEqual(expect.objectContaining({
        batch: true,
    }));
    expect(stats.companion.batchAgentIds).toContain('tpl-level-up-companion');
    expect(stats.companion.sendContextToCompanions).toBe(true);
    expect(stats.companion.contextRecipientAgentIds).toContain('tpl-level-up-companion');
    expect(stats.companion.dependencies).toContain('tpl-level-up-companion');
    expect(stats.companion.waitForDependencies).toBe(true);
}

function expectExistingStatsSectionOnStatsTemplate(levelUp, stats) {
    expect(levelUp.prompt).not.toContain('## Updating Existing Stats');
    expect(stats.prompt).toContain(updatingExistingStatsSection);
    expect(stats.prompt.endsWith(updatingExistingStatsSection)).toBe(true);
}

describe('in-chat agent bundled templates', () => {
    test('closed tracker blocks include every body line while legacy blocks leave following prose alone', () => {
        const bundles = readTemplate('regex-bundles.json');
        for (const [id, tag, fields] of [
            ['scene-tracker', 'SCENE', 'A|B|C'], ['time-tracker', 'TIME', 'A|B|C'],
            ['relationship-tracker', 'METER', 'A|B|C|D|E'], ['status-tracker', 'STATUS', 'A|B|C'],
            ['event-tracker', 'EVENT', 'A|B|C'], ['achievements-tracker', 'ACH', 'A|B|C'],
            ['reputation-tracker', 'REP', 'A|B|C'], ['secrets-tracker', 'SECRET', 'A|B|C'],
            ['item-tracker', 'ITEM', 'A|B|C'], ['world-detail', 'WORLD', 'A|B'],
        ]) {
            const suffix = '\nNarrative outside.\n[NEXT]untouched[/NEXT]';
            const render = text => applyRegexScriptList(text, bundles[`tpl-${id}`], AGENT_REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true });
            const closed = render(`[${tag}|${fields}]\nfirst detail\nsecond detail\n[/${tag}]${suffix}`);
            expect(closed).toContain('first detail\nsecond detail');
            expect(closed).not.toContain(`[/${tag}]`);
            expect(closed.endsWith(suffix)).toBe(true);
            expect(render(`[${tag}|${fields}]\nfirst detail${suffix}`).endsWith(suffix)).toBe(true);
            expect(readTemplate(`${id}.json`).version).toBe(1);
        }
    });

    test('NPC upgrades keep the relationship inside the card and consume the closing tag', () => {
        const script = readTemplate('regex-bundles.json')['tpl-npc-profiles'].filter(script => script.scriptName === 'Replace NPC Upgrade');
        const body = '[NPC:UP|Alice|MAJOR]\nb: basics\na: appearance\np: personality\nh: history';
        const render = text => applyRegexScriptList(text, script, AGENT_REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true });
        const html = render(`${body}\nr: trusted friend\n[/NPC]\nFollowing narrative.`);
        expect(html).toContain('Relationship: <span>trusted friend</span>');
        expect(html).not.toContain('[/NPC]');
        expect(html.endsWith('</details>\nFollowing narrative.')).toBe(true);
        expect(render(`${body}\n[/NPC]`).endsWith('</details>')).toBe(true);
    });

    test('Chat Only recognises long and non-ASCII speaker names as separate turns', () => {
        const names = ['You', '美咲', 'Михаил', 'Élodie', `Captain ${'Longname'.repeat(12)}`];
        const html = applyRegexScriptList(names.map(name => `${name}: greeting`).join('\n'), readTemplate('chat-only-companion.json').regexScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true });
        expect(html.match(/ica--chatonly-turn/g)).toHaveLength(names.length);
        for (const name of names) expect(html).toContain(`>${name}</b>`);
    });

    test('an incomplete template asset load can retry without publishing unformatted templates', async () => {
        const source = fs.readFileSync(indexSourceUrl, 'utf8');
        const fn = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'loadTemplates');
        for (const failedAsset of ['index.json', 'regex-bundles.json', 'groups.json']) {
            let fail = true;
            const assets = { 'index.json': [{ id: 'tpl-example' }], 'regex-bundles.json': { 'tpl-example': [{ id: 'rule' }] }, 'groups.json': [] };
            const runtime = { templates: [], templateRegexBundles: {}, templateLoadError: null, console: { warn: jest.fn() },
                REMOVED_BUNDLED_TEMPLATE_IDS: new Set(), REMOVED_BUNDLED_GROUP_IDS: new Set(),
                getTemplateAssetUrl: name => name, loadBuiltinGroups: jest.fn(),
                fetch: jest.fn(async name => ({ ok: !fail || name !== failedAsset, json: async () => assets[name] })),
            };
            runtime.mergeTemplateDefaults = template => ({ ...template, regexScripts: runtime.templateRegexBundles[template.id] });
            vm.createContext(runtime);
            vm.runInContext(source.slice(fn.start, fn.end), runtime);
            await runtime.loadTemplates();
            expect(runtime.templates).toEqual([]);
            expect(runtime.templateLoadError).not.toBeNull();
            fail = false;
            await runtime.loadTemplates();
            expect(runtime.templates[0].regexScripts).toEqual([{ id: 'rule' }]);
            expect(runtime.templateLoadError).toBeNull();
        }
    });

    test('keeps source files synced with the template browser catalog', () => {
        const catalog = readTemplate('index.json');

        for (const filename of sourceFilenames) {
            const source = readTemplate(filename);
            const catalogTemplate = catalog.find(template => template.id === source.id);
            expect(catalogTemplate).toEqual(source);
        }
    });

    test('tracker extractors compile and retain complete canonical blocks', () => {
        const examples = new Map([
            ['tpl-achievements-tracker', '[ACH|First Step|COMMON|Started]\nunlocked: began\n[/ACH]'],
            ['tpl-direction-menu', '[DIRECTIONS]\n1. Continue\n[/DIRECTIONS]'],
            ['tpl-event-tracker', '[EVENT|QUEST|Find it|Soon]\ncontext: stakes\n[/EVENT]'],
            ['tpl-item-tracker', '[ITEM|GAINED|Key|Brass]\nnote: found\n[/ITEM]'],
            ['tpl-npc-profiles', '[NPC:REF|Ava|red scarf|wary][/NPC]'],
            ['tpl-parallel-tracker', '[PARALLEL|Background|threat]\n- A\n- B\n- C\n[/PARALLEL]'],
            ['tpl-relationship-tracker', '[METER|Ava|5/10|6/10|Friendly|STABLE]\nreason\n[/METER]'],
            ['tpl-reputation-tracker', '[REP|Town|Helpful|RISING]\ncause: rescue\n[/REP]'],
            ['tpl-scene-tracker', '[SCENE|Harbor|Dusk|Foggy]\ndetail: bells\n[/SCENE]'],
            ['tpl-secrets-tracker', '[SECRET|Ava|Map|No one]\ncontext: hidden\n[/SECRET]'],
            ['tpl-status-tracker', '[STATUS|Ava|Tired|MILD]\nnote: travel\n[/STATUS]'],
            ['tpl-time-tracker', '[TIME|Day 2|Tuesday|Dusk]\nnote: later\n[/TIME]'],
            ['tpl-world-detail', '[WORLD|CULTURE|Harbor]\ndetail: bells\n[/WORLD]'],
            ['tpl-cyoa-choices-skill-checks', '[CHOICES]\n1. Continue\n[/CHOICES]'],
            ['tpl-afflictions-blessings', '[AFFLICT|Ava|Weightless|WORSENING]\nnote: rising\n[/AFFLICT]'],
            ['tpl-almanac-generator', '[ALMANAC]\nName: Ava\n[/ALMANAC]'],
            ['tpl-clock-is-lying', '[HOUR|Noon|Dusk|LOOSE]\nnote: slipping\n[/HOUR]'],
            ['tpl-doors', '[DOORS]\n1. Continue\n[/DOORS]'],
            ['tpl-doors-fate-checks', '[DOORS]\n1. Continue\n[/DOORS]'],
            ['tpl-drift-tracker', '[DRIFT|3|RISING]\nnote: odd\n[/DRIFT]'],
            ['tpl-entanglement-tracker', '[THREAD|Ava and Ben|Rope|Fraying]\nnote: strain\n[/THREAD]'],
            ['tpl-four-winds', '[WINDS]\nA. North\n[/WINDS]'],
            ['tpl-improbable-effects', '[EFFECT|Held|Brass Key|Smug]\nnote: hums\n[/EFFECT]'],
            ['tpl-meanwhile-impossibly', '[ELSEWHERE|Harbor|Closing]\n- A\n- B\n- C\n[/ELSEWHERE]'],
            ['tpl-motif-tracker', '[MOTIF|Bells|3|Warning]\nnote: heard\n[/MOTIF]'],
            ['tpl-omen-tracker', '[OMEN|Crows|Ill|Soon]\ncontext: dusk\n[/OMEN]'],
            ['tpl-small-miracles', '[CERT|First Door|MINOR|Section 3]\nstamp: sealed\n[/CERT]'],
            ['tpl-the-becoming', '[BECOMING|Ava|The Quiet One|Rising]\nnote: earned\n[/BECOMING]'],
            ['tpl-the-census', '[CENSUS:PASSERBY|Ava]\nb: Ava | 30s | Courier\na: Red scarf\np: Wary\n[/CENSUS]'],
            ['tpl-the-committee', '[VOICE|Logic|Doubt|FAIL]\nsays: no\n[/VOICE]'],
            ['tpl-the-ledger', '[LEDGER|Ava|One name|Dusk]\ncontext: bargain\n[/LEDGER]'],
            ['tpl-the-turning', '[TURNING]\nAva reaches 2\n[/TURNING]'],
            ['tpl-thin-places-tracker', '[THIN|Harbor|Bells|OPEN]\nnote: leaks\n[/THIN]'],
            ['tpl-thought-cabinet', '[THOUGHT|The Bells|Forming|2 of 3]\nnote: settling\n[/THOUGHT]'],
            ['tpl-what-the-town-knows', '[RUMOR|Ava|Walks on water|GROWING]\ncause: witness\n[/RUMOR]'],
        ]);
        const catalog = readTemplate('index.json');

        for (const [templateId, example] of examples) {
            const template = findCatalogTemplate(catalog, templateId);
            const pattern = new RegExp(template.postProcess.extractPattern, 'g');
            expect(example.match(pattern)).toEqual([example]);

            const closingTag = example.match(/\[\/([A-Z]+)\]$/)?.[0];
            const malformedThenComplete = `${example.slice(0, -closingTag.length)}\n${example}`;
            expect(malformedThenComplete.match(pattern)).toEqual([example]);
        }

        const skillChecks = findCatalogTemplate(catalog, 'tpl-cyoa-choices-skill-checks');
        const trimScript = skillChecks.regexScripts.find(script => script.scriptName === 'Trim Choices');
        expect(() => new RegExp(trimScript.findRegex.slice(1, trimScript.findRegex.lastIndexOf('/')), 'g')).not.toThrow();
    });

    test('renders NPC blocks without leaving closing tags behind', () => {
        const scripts = readTemplate('regex-bundles.json')['tpl-npc-profiles'];
        const samples = [
            '[NPC:REF|Ava|red scarf|wary][/NPC]',
            '[NPC:REF|Ava|red scarf|wary]\n[/NPC]',
            '[NPC:REL|Ava|now trusts him][/NPC]',
            '[NPC:REL|Ava|now trusts him]\n[/NPC]',
            '[NPC:MINOR|Ava]\nb: Ava | 30s | Courier\na: Red scarf\np: Wary\n[/NPC]',
        ];

        for (const sample of samples) {
            const html = applyRegexScriptList(sample, scripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
                isMarkdown: true,
            });

            expect(html).toContain('Ava');
            expect(html).not.toContain('[/NPC]');
        }
    });

    test('renders Ethereality blocks without leaving closing tags behind', () => {
        const bundles = readTemplate('regex-bundles.json');
        const samples = [
            ['tpl-drift-tracker', '[DRIFT|3|RISING]\nnote: odd\n[/DRIFT]'],
            ['tpl-the-census', '[CENSUS:PASSERBY|Ava]\nb: Ava | 30s | Courier\na: Red scarf\np: Wary\n[/CENSUS]'],
            ['tpl-the-census', '[CENSUS:SIGHTING|Ava|red scarf|wary]'],
            ['tpl-the-census', '[CENSUS:AMENDED|Ava|now trusts him]'],
            ['tpl-doors', '[DOORS]\n1. Continue\n2. Wait\n[/DOORS]'],
            ['tpl-doors-fate-checks', '[DOORS]\n1. Continue\n2. Wait\n[/DOORS]'],
            ['tpl-four-winds', '[WINDS]\nA. North\nB. South\nC. East\nD. West\n[/WINDS]'],
            ['tpl-the-turning', '[TURNING]\nAva reaches 2\n[/TURNING]'],
            ['tpl-almanac-generator', '[ALMANAC]\nName: Ava\n[/ALMANAC]'],
        ];

        for (const [templateId, sample] of samples) {
            const scripts = bundles[templateId];
            expect(Array.isArray(scripts)).toBe(true);

            const html = applyRegexScriptList(sample, scripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
                isMarkdown: true,
            });

            expect(html).not.toMatch(/\[\/?[A-Z]+[:|\]]/);
            expect(html).toContain('<');
        }
    });

    test('keeps Level Up and User-based Stats connected by default', () => {
        const catalog = readTemplate('index.json');

        expectLevelUpStatsDefaults(
            findCatalogTemplate(catalog, 'tpl-level-up-companion'),
            findCatalogTemplate(catalog, 'tpl-user-based-stats-generator'),
        );
        expectLevelUpStatsDefaults(
            readTemplate('level-up-companion.json'),
            readTemplate('user-based-stats-generator.json'),
        );
    });

    test('keeps existing stat update instructions on User-based Stats', () => {
        const catalog = readTemplate('index.json');

        expectExistingStatsSectionOnStatsTemplate(
            findCatalogTemplate(catalog, 'tpl-level-up-companion'),
            findCatalogTemplate(catalog, 'tpl-user-based-stats-generator'),
        );
        expectExistingStatsSectionOnStatsTemplate(
            readTemplate('level-up-companion.json'),
            readTemplate('user-based-stats-generator.json'),
        );
    });

    test('keeps bundled companion prompts free of negative wrappers and uppercase protocols', () => {
        const companionFilenames = sourceFilenames.filter(filename => filename.includes('companion'));
        const negativeWrapperPattern = /\b(?:Do not|Don't|Never|Return only|Output only|strictly|AI agent|as an AI|LLM)\b/i;
        const uppercaseProtocolPattern = /\b(?:CHATROOM_STYLE|CHATROOM_END|PHONE_NONE|PHONE_START|PHONE_TEXT|PHONE_END|LETTER_START|LETTER_TEXT|LETTER_END|OBJECTIVE:|## TIMELINE|## CHARACTERS|## RELATIONSHIPS|## EVENTS|## DIALOGUE KEYS|## THREADS|## NOW)\b/;
        const vagueCompanionPromptPattern = /\b(?:shape|shapes|pressure|pressures|beat|beats)\b/i;

        for (const filename of companionFilenames) {
            const template = readTemplate(filename);
            const prompt = String(template.prompt ?? '');
            expect(prompt).not.toMatch(negativeWrapperPattern);
            expect(prompt).not.toMatch(uppercaseProtocolPattern);
            expect(prompt).not.toMatch(vagueCompanionPromptPattern);
        }
    });

    test('gives companion templates valid update versions', () => {
        const companionFilenames = sourceFilenames.filter(filename => filename.includes('companion'));

        for (const filename of companionFilenames) {
            const template = readTemplate(filename);
            expect(Number.isInteger(template.version) && template.version > 0).toBe(true);
        }
    });

    test('keeps template update versions in sync with their catalogue', () => {
        const catalog = readTemplate('index.json');
        expect(catalog.every(template => Number.isInteger(template.version) && template.version > 0)).toBe(true);
        for (const filename of fs.readdirSync(templateDir).filter(name => name.endsWith('.json') && !['index.json', 'groups.json', 'regex-bundles.json'].includes(name))) {
            const template = readTemplate(filename);
            expect(catalog.find(item => item.id === template.id).version).toBe(template.version);
        }
        const expressions = catalog.find(template => template.id === 'tpl-expressions-agent');
        expect(expressions.version).toBe(1);
        expect(expressions.prompt).toContain('{{availableExpressions}}');
    });

    test('keeps choice-menu templates from including the system prompt by default', () => {
        const catalog = readTemplate('index.json');

        for (const templateId of ['tpl-cyoa-choices', 'tpl-direction-menu']) {
            const template = findCatalogTemplate(catalog, templateId);
            expect(template.companion).toEqual(expect.objectContaining({
                includeSystemPrompt: false,
            }));
            expect(template.prompt).toContain('repair task');
            expect(template.prompt).not.toContain('End EVERY');
            expect(template.prompt).not.toContain('EXACT');
        }
    });

    test('teaches the empty-output sentinel to conditional trackers only', () => {
        // Trackers that report a change report nothing on a quiet turn, which the companion layer
        // renders as literally nothing. Templates that emit output every scene are excluded, since a
        // sentinel there would give the model permission to skip work it is supposed to do.
        const sentinelTemplates = [
            'achievements-tracker.json',
            'event-tracker.json',
            'item-tracker.json',
            'npc-profiles.json',
            'relationship-tracker.json',
            'reputation-tracker.json',
            'scene-tracker.json',
            'secrets-tracker.json',
            'status-tracker.json',
            'time-tracker.json',
        ];
        const alwaysEmittingTemplates = [
            'parallel-tracker.json',
            'world-detail.json',
            'cyoa-choices.json',
            'cyoa-choices-skill-checks.json',
            'direction-menu.json',
        ];
        const catalog = readTemplate('index.json');

        for (const filename of sentinelTemplates) {
            const template = readTemplate(filename);
            expect(template.prompt).toContain('tracker-none');
            expect(findCatalogTemplate(catalog, template.id).prompt).toContain('tracker-none');
        }

        for (const filename of alwaysEmittingTemplates) {
            expect(readTemplate(filename).prompt).not.toContain('tracker-none');
        }
    });

    test('keeps tracker templates from including the system prompt by default', () => {
        const catalog = readTemplate('index.json');

        for (const template of catalog.filter(template => template.category === 'tracker')) {
            expect(template.companion).toEqual(expect.objectContaining({
                includeSystemPrompt: false,
            }));
        }
    });

    test('does not ship retired writing helpers in the catalog', () => {
        const catalog = readTemplate('index.json');
        expect(catalog.find(template => template.id === 'tpl-prose-polisher')).toBeUndefined();
        expect(catalog.find(template => template.id === 'tpl-grounded-prose-polisher')).toBeUndefined();
        expect(catalog.find(template => template.id === 'tpl-npc-motivator')).toBeUndefined();
        expect(fs.existsSync(new URL('grounded-prose-polisher.json', templateDir))).toBe(false);
    });

    test('bundles companion templates as sidecar execution agents', async () => {
        const catalog = readTemplate('index.json');
        const continuity = findCatalogTemplate(catalog, 'tpl-continuity-companion');
        const relationship = findCatalogTemplate(catalog, 'tpl-relationship-lens-companion');

        expect(continuity).toEqual(expect.objectContaining({
            category: 'companion',
            execution: 'companion',
            phase: 'post',
        }));
        expect(continuity.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            format: 'markdown',
            feedback: { enabled: true, depth: 2 },
            batch: false,
            maxTokens: 64000,
        }));
        expect(relationship.companion).toEqual(expect.objectContaining({
            trigger: 'manual',
            displayMode: 'panel',
            includeCharacterCard: true,
            includePersona: true,
            includeWorldInfo: true,
            feedback: { enabled: false, depth: 1 },
        }));

        const commentary = findCatalogTemplate(catalog, 'tpl-directors-commentary-companion');
        const interview = findCatalogTemplate(catalog, 'tpl-actor-interview-companion');
        const lorebookScout = findCatalogTemplate(catalog, 'tpl-lorebook-scout-companion');
        const memoryShard = findCatalogTemplate(catalog, 'tpl-memory-shard-companion');
        const chatroom = findCatalogTemplate(catalog, 'tpl-chatroom-companion');
        const chatOnly = findCatalogTemplate(catalog, 'tpl-chat-only-companion');
        const messageInbox = findCatalogTemplate(catalog, 'tpl-message-inbox-companion');

        for (const template of [commentary, interview, lorebookScout, memoryShard, chatroom, chatOnly, messageInbox]) {
            expect(template).toEqual(expect.objectContaining({
                category: 'companion',
                execution: 'companion',
                phase: 'post',
                enabled: false,
            }));
        }
        expect(commentary.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            batch: false,
        }));
        expect(commentary.prompt).toContain('[Selected Director Commentary Voice]');
        expect(commentary.prompt).toContain('[Director Commentary Voice]');
        expect(interview.companion).toEqual(expect.objectContaining({
            trigger: 'manual',
            includeCharacterCard: true,
        }));
        expect(lorebookScout.companion).toEqual(expect.objectContaining({
            trigger: 'manual',
            includeWorldInfo: true,
        }));
        expect(memoryShard.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            minContextTokens: 30000,
            contextMessages: 30,
            includeHistory: true,
            feedback: { enabled: true, depth: 1 },
            maxTokens: 64000,
            // Every shard stays in context, including ones whose host message the shard's own
            // "hide story above this shard" button has since hidden.
            includeInChatHistory: true,
            includeAllChatHistory: true,
            keepInChatHistoryWhenHostHidden: true,
        }));
        expect(memoryShard.prompt).toContain('# MEMORY SHARD: [ID]-[NEXT NUM]');
        expect(memoryShard.prompt).toContain('# CONSOLIDATED MEMORY SHARD: [ID]-MASTER');
        expect(memoryShard.prompt).toContain('## Shard Reference Key');
        expect(chatroom.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            format: 'html',
            rawPrompt: true,
            includeWorldInfo: true,
            includeHistory: true,
            historyDepth: 1,
            feedback: { enabled: false, depth: 1 },
            maxTokens: 64000,
        }));
        expect(chatroom.regexScripts).toHaveLength(6);
        expect(chatroom.prompt).toContain('chatroom-style|active-style');
        expect(chatroom.prompt).toContain('chatroom|Username|label|tone|Post/comment');
        expect(chatroom.prompt).toContain('post/comment field on one line');
        expect(chatroom.prompt).toContain('Keep the post/comment field clean');
        expect(chatroom.prompt).toContain('[Chatroom Extra Character Cards]');
        expect(chatroom.prompt).toContain('[Custom Chatroom Style]');
        expect(chatroom.prompt).toContain('- custom: follow [Custom Chatroom Style]');
        expect(chatroom.prompt).toContain('thread-board/4chan');
        expect(chatroom.prompt).toContain('Use unique post labels instead of repeating Anon');
        expect(chatroom.prompt).toContain('- reddit:');
        expect(chatroom.regexScripts.map(script => script.id)).toContain('chatroom-message-row-greentext');
        expect(chatroom.regexScripts.map(script => script.id)).toContain('chatroom-greentext-continuation');
        expect(chatroom.prompt).not.toContain('No NSFW chat styles');
        expect(chatroom.prompt).not.toContain('targeted slurs');

        expect(chatOnly.companion).toEqual(expect.objectContaining({
            trigger: 'manual',
            displayMode: 'panel',
            format: 'markdown',
            rawPrompt: true,
            includeCharacterCard: true,
            includePersona: true,
            includeWorldInfo: true,
            includeAuthorsNote: true,
            includeHistory: true,
            historyDepth: 6,
            feedback: { enabled: false, depth: 1 },
            maxTokens: 64000,
        }));
        expect(chatOnly.prompt).toContain('private side-channel conversation');
        expect(chatOnly.prompt).toContain('[Your previous notes]');
        expect(chatOnly.prompt).toContain('Chat Only textbox');
        expect(chatOnly.prompt).toContain('[Chat Only side chat]');
        expect(chatOnly.prompt).toContain('You: the user\'s newest aside');
        expect(chatOnly.prompt).toContain('Actions appear as plain prose');
        expect(chatOnly.prompt).not.toContain('**You:**');
        expect(chatOnly.regexScripts).toHaveLength(1);
        expect(chatOnly.regexScripts[0]).toEqual(expect.objectContaining({
            id: 'chat-only-transcript-row',
            placement: [AGENT_REGEX_PLACEMENT.AI_OUTPUT],
            markdownOnly: true,
        }));
        expect(chatOnly.regexScripts[0].replaceString).toContain('ica--chatonly-turn');
        expect(chatOnly.regexScripts[0].replaceString).toContain('ica--chatonly-speaker');
        expect(chatOnly.regexScripts[0].replaceString).toContain('ica--chatonly-message');
        expect(chatOnly.regexScripts[0].replaceString).toContain('white-space:pre-wrap');

        // Speaker names are not limited to ASCII letters: a Japanese speaker after 'You' gets its own turn.
        const transcript = 'You: hello there\n美咲: こんにちは\nÉlodie: salut';
        const rendered = applyRegexScriptList(transcript, chatOnly.regexScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
            isMarkdown: true,
            substituteParamsFn: value => value,
            substituteParamsExtendedFn: value => value,
        });
        expect(rendered.match(/ica--chatonly-turn/g)).toHaveLength(3);
        expect(rendered).toContain('>美咲</b>');
        expect(rendered).toContain('>Élodie</b>');
        expect(rendered).not.toContain('hello there\n美咲');

        expect(messageInbox.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            format: 'html',
            rawPrompt: true,
            includeWorldInfo: true,
            includeAuthorsNote: true,
            includeHistory: false,
            feedback: { enabled: false, depth: 1 },
            maxTokens: 64000,
        }));
        expect(messageInbox.regexScripts).toHaveLength(6);
        expect(messageInbox.prompt).toContain('phone-none');
        expect(messageInbox.prompt).toContain('phone-start|thread-title|status');
        expect(messageInbox.prompt).toContain('letter-start|title-or-seal|status');
        expect(messageInbox.prompt).toContain('fantasy, medieval');
        expect(messageInbox.regexScripts.map(script => script.id)).toEqual(expect.arrayContaining([
            'message-inbox-phone-shell-open',
            'message-inbox-phone-text-row',
            'message-inbox-letter-shell-open',
            'message-inbox-letter-text-row',
        ]));

        const plotCompass = findCatalogTemplate(catalog, 'tpl-plot-compass-companion');
        expect(plotCompass).toEqual(expect.objectContaining({
            category: 'companion',
            execution: 'companion',
            phase: 'post',
            enabled: false,
        }));
        expect(plotCompass.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            rawPrompt: true,
            includeHistory: true,
            historyDepth: 1,
            feedback: { enabled: true, depth: 1 },
            maxTokens: 64000,
        }));
        expect(plotCompass.prompt).toContain('[Plot Compass Objective]');
        expect(plotCompass.prompt).not.toContain('first line of [Your previous notes]');

        const { isCompanionAgent, normalizeAgent } = await importAgentStore();
        const saved = normalizeAgent({
            ...continuity,
            id: 'saved-continuity-companion',
            sourceTemplateId: continuity.id,
        });

        expect(saved.category).toBe('companion');
        expect(saved.execution).toBe('companion');
        expect(isCompanionAgent(saved)).toBe(true);
        expect(saved.companion.maxTokens).toBe(64000);
    });

    test('renders orphan greentext continuation lines inside the Chatroom interface', () => {
        const html = renderChatroomOutput([
            'chatroom-style|thread-board/4chan',
            'chatroom|Anon #009|checked|18|>be the Martyred Maiden',
            '>spend your free time sharpening a sword and eating sweets',
            'chatroom-end',
        ].join('\n'));

        expect(html).toContain('>be the Martyred Maiden');
        expect(html).toContain('>spend your free time sharpening a sword and eating sweets');
        expect(html).toContain('font-family:ui-monospace');
        expect(html).toContain('display:flex;flex-direction:column');
        expect(html).not.toContain('grid-template-columns:minmax(86px,auto) 1fr');
        expect(html).not.toMatch(/^>spend your free time/m);
    });

    test('uses only known modal subcategories in the catalog', async () => {
        const { AGENT_SUBCATEGORIES } = await importAgentStore();
        const knownSubcategories = new Set(Object.keys(AGENT_SUBCATEGORIES));
        const catalog = readTemplate('index.json');
        const unknownSubcategories = catalog
            .map(template => template.subcategory)
            .filter(subcategory => subcategory !== undefined && subcategory !== null)
            .filter(subcategory => !knownSubcategories.has(subcategory));

        expect(unknownSubcategories).toEqual([]);
    });

    test('assigns tracker and content templates to modal subcategories', () => {
        const catalog = readTemplate('index.json');

        for (const template of catalog.filter(template => ['tracker', 'content'].includes(template.category))) {
            expect(typeof template.subcategory).toBe('string');
            expect(template.subcategory.trim()).not.toBe('');
        }
    });

    test('does not keep modal subcategory metadata on saved agent shapes', async () => {
        const { normalizeAgent } = await importAgentStore();
        const agent = normalizeAgent({
            id: 'saved-scene-tracker',
            name: 'Scene Tracker',
            category: 'tracker',
            subcategory: 'world',
            sourceTemplateId: 'tpl-scene-tracker',
        });

        expect(agent).not.toHaveProperty('subcategory');
    });

    test('hides Pathfinder from the in-chat template browser without purging the internal agent', () => {
        const pathfinderTemplateId = '\'tpl-pathfinder\'';

        expect(readIndexSetBody('HIDDEN_TEMPLATE_BROWSER_IDS')).toContain(pathfinderTemplateId);
        expect(readIndexSetBody('INTERNAL_BUNDLED_TEMPLATE_IDS')).toContain(pathfinderTemplateId);
        expect(readIndexSetBody('REMOVED_BUNDLED_TEMPLATE_IDS')).not.toContain(pathfinderTemplateId);
        expect(readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS')).not.toContain(pathfinderTemplateId);
    });

    test('installs the Proofreader by default as a post-phase rewrite agent', () => {
        const proofreader = readTemplate('proofreader.json');

        expect(readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS')).toContain('\'tpl-proofreader\'');
        expect(readIndexSetBody('REMOVED_BUNDLED_TEMPLATE_IDS')).toContain('\'tpl-unscheduled-phenomena\'');
        expect(proofreader.phase).toBe('post');
        expect(proofreader.enabled).toBe(false);
        expect(proofreader.postProcess).toMatchObject({ promptTransformEnabled: true, promptTransformMode: 'rewrite' });
        expect(proofreader.prompt).toContain('Output ONLY the revised message.');
    });

    test('installs the Dialogue Humaniser by default as a post-phase rewrite that runs before the Proofreader', () => {
        const humaniser = readTemplate('dialogue-humaniser.json');
        const proofreader = readTemplate('proofreader.json');

        expect(humaniser).toMatchObject({
            id: 'tpl-dialogue-humaniser',
            name: 'Dialogue Humaniser',
            category: 'content',
            subcategory: 'prose-quality',
            phase: 'post',
            execution: 'inline',
            enabled: false,
        });
        expect(humaniser.postProcess).toMatchObject({ promptTransformEnabled: true, promptTransformMode: 'rewrite' });
        expect(humaniser.companion).toMatchObject({ includeCharacterCard: true, includePersona: true });
        expect(humaniser.injection.order).toBeLessThan(proofreader.injection.order);
        expect(humaniser.prompt).toContain('You are a dialogue editor for prose fiction.');
        expect(humaniser.prompt).toContain('Output ONLY the revised message.');
        expect(humaniser.prompt).toContain('Leave all other narration untouched.');
        expect(humaniser.prompt).not.toMatch(/roleplay|\u2014/i);
        expect(readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS')).toContain('\'tpl-dialogue-humaniser\'');
    });

    test('installs the reply rewrite chain by default in a fixed running order with the recent chat each pass needs', () => {
        const defaults = readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS');
        const chain = [
            ['format-fixer.json', 'tpl-format-fixer', 'Format Fixer', 0],
            ['user-agency-guard.json', 'tpl-user-agency-guard', 'User Agency Guard', 2],
            ['knowledge-guard.json', 'tpl-knowledge-guard', 'Knowledge Guard', 6],
            ['friction-keeper.json', 'tpl-friction-keeper', 'Friction Keeper', 4],
            ['dialogue-humaniser.json', 'tpl-dialogue-humaniser', 'Dialogue Humaniser', 4],
            ['repetition-breaker.json', 'tpl-repetition-breaker', 'Repetition Breaker', 6],
            ['length-trimmer.json', 'tpl-length-trimmer', 'Length Trimmer', 0],
            ['proofreader.json', 'tpl-proofreader', 'Proofreader', 4],
        ];
        const orders = [];

        for (const [filename, id, name, contextMessages] of chain) {
            const template = readTemplate(filename);
            expect(template).toMatchObject({ id, name, category: 'content', phase: 'post', execution: 'inline', enabled: false });
            expect(template.postProcess).toMatchObject({
                promptTransformEnabled: true,
                promptTransformMode: 'rewrite',
                promptTransformContextMessages: contextMessages,
            });
            expect(template.prompt).toContain('Output ONLY the revised message.');
            expect(`${template.prompt}\n${template.description}`).not.toMatch(/roleplay|\u2014/i);
            expect(defaults).toContain(`'${id}'`);
            orders.push(template.injection.order);
        }

        expect(orders).toEqual([...orders].sort((a, b) => a - b));
        expect(new Set(orders).size).toBe(orders.length);
        expect(readTemplate('length-trimmer.json').settings).toEqual({ lengthTarget: 'About 300 to 450 words' });
        expect(readTemplate('length-trimmer.json').prompt).toContain('{{lengthTarget}}');
        expect(readTemplate('knowledge-guard.json').prompt).toContain('{{persona}}');
    });

    test('installs the fast pre-generation wrap notes by default, disabled, and says which agents not to run them with', () => {
        const catalog = readTemplate('index.json');
        const names = new Set(catalog.map(template => template.name));
        const notes = new Map([
            ['intent-reader.json', { avoid: ['Beat Planner'] }],
            ['continuity-pins.json', { avoid: ['Continuity Companion', 'Scene Tracker', 'Status Tracker', 'Item Tracker'] }],
            ['beat-planner.json', { avoid: ['Intent Reader', 'Plot Compass', 'Scene Driving Force', 'Scene Pressure Cocktail', 'Combined Director\'s Cut', 'Chaos Mode'] }],
            ['pace-setter.json', { avoid: ['Length Trimmer', 'Scene Pressure Cocktail', 'Combined Director\'s Cut'] }],
            ['repeat-spotter.json', { avoid: ['Repetition Breaker'], fine: ['Grounded Prose', 'Proofreader'] }],
        ]);

        for (const [filename, { avoid, fine = [] }] of notes) {
            const template = readTemplate(filename);
            expect(template).toMatchObject({ category: 'content', phase: 'pre', enabled: false });
            expect(template.preProcess).toMatchObject({ mode: 'intercept', interceptTiming: 'pre-generation', applyMode: 'wrap', wrapPosition: 'after' });
            expect(template.preProcess.maxTokens).toBeLessThanOrEqual(400);
            expect(template.preProcess.wrapPrefix).not.toMatch(/\{\{/);
            expect(template.conditions.generationTypes).not.toContain('impersonate');
            expect(`${template.description}\n${template.prompt}`).not.toMatch(/\u2014/);
            const [, avoidList = '', fineList = ''] = template.description.match(/Don't run it with: ([^.]+)\.(?: Fine alongside ([^.]+)\.)?$/) ?? [];
            expect(avoidList.split(', ')).toEqual(avoid);
            expect(fineList ? fineList.split(' and ') : []).toEqual(fine);
            for (const name of [...avoid, ...fine]) {
                expect(names).toContain(name);
            }
            expect(readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS')).toContain(`'${template.id}'`);
            expect(readIndexSetBody('HIDDEN_TEMPLATE_BROWSER_IDS')).not.toContain(`'${template.id}'`);
        }
    });

    test('installs Pura\'s trackers by default, disabled, and keeps the Ethereality kit library-only', () => {
        const groups = readTemplate('groups.json');
        const catalog = readTemplate('index.json');
        const defaults = readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS');
        const kit = id => groups.find(group => group.id === id).agentTemplateIds;
        const puraTrackers = kit('grp-pura-trackers');

        expect(puraTrackers.length).toBeGreaterThan(10);
        for (const id of puraTrackers) {
            expect(defaults).toContain(`'${id}'`);
            expect(catalog.find(template => template.id === id)?.enabled).toBe(false);
        }
        for (const id of kit('grp-pura-ethereality-trackers')) {
            expect(defaults).not.toContain(`'${id}'`);
        }
    });

    test('keeps every catalog template category renderable in the browser', async () => {
        const { AGENT_CATEGORIES } = await importAgentStore();
        const catalog = readTemplate('index.json');
        const knownCategories = Object.keys(AGENT_CATEGORIES);

        const unknownCategories = catalog
            .map(template => template.category)
            .filter(category => !knownCategories.includes(category));

        expect(unknownCategories).toEqual([]);
    });

    test('surfaces bundled content templates such as HTML Toggle in the browser', () => {
        const catalog = readTemplate('index.json');
        const htmlToggle = findCatalogTemplate(catalog, 'tpl-html-toggle');

        expect(htmlToggle.category).toBe('content');
        expect(htmlToggle.subcategory).toBe('behaviour');

        // 'custom' stays in AGENT_CATEGORIES as a fallback for user/saved agents
        // even though no bundled templates ship in that category anymore.
        const orderSource = readIndexFunctionBody('getTemplateBrowserCategoryOrder');
        expect(orderSource).not.toContain('category !== \'custom\'');
        expect(orderSource).toContain('AGENT_CATEGORIES');
    });
});
