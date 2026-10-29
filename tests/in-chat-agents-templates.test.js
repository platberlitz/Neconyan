import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import css from '@adobe/css-tools';
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
    'character-authenticity.json',
    'chat-only-companion.json',
    'chatroom-companion.json',
    'clock-is-lying.json',
    'continuity-companion.json',
    'continuity-corrector.json',
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
    'nsfw-enhancer.json',
    'omen-tracker.json',
    'pace-setter.json',
    'parallel-tracker.json',
    'parallel-tracker-extended.json',
    'plot-compass-companion.json',
    'position-tracker-companion.json',
    'prompt-adherence-checker.json',
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
    'visual-map-companion.json',
    'vitals-companion.json',
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

function renderPositionTrackerOutput(source) {
    const tracker = readTemplate('position-tracker-companion.json');
    return applyRegexScriptList(source, tracker.regexScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
        isMarkdown: true,
    });
}

function renderVitalsOutput(source) {
    const vitals = readTemplate('vitals-companion.json');
    return applyRegexScriptList(source, vitals.regexScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
        isMarkdown: true,
    });
}

function renderVisualMapOutput(source) {
    const visualMap = readTemplate('visual-map-companion.json');
    return applyRegexScriptList(source, visualMap.regexScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
        isMarkdown: true,
    });
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
            ['tpl-parallel-tracker-extended', '[OFFSCREEN|Background|threat]\nScene 1: Docks - Ava\nA\n\nScene 2: Inn - Ben\nB\n\nScene 3: Road - Cy\nC\n[/OFFSCREEN]'],
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
        expect(expressions.version).toBe(2);
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
            'parallel-tracker-extended.json',
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

        const positionTracker = findCatalogTemplate(catalog, 'tpl-position-tracker-companion');
        expect(positionTracker).toEqual(expect.objectContaining({
            category: 'companion',
            execution: 'companion',
            phase: 'post',
            enabled: false,
            icon: 'fa-map-location-dot',
        }));
        expect(positionTracker.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            format: 'html',
            rawPrompt: true,
            includeHistory: true,
            historyDepth: 1,
            feedback: { enabled: false, depth: 1 },
            maxTokens: 64000,
        }));
        expect(positionTracker.prompt).toContain('who|character|range|exact spot|what they are doing');
        expect(positionTracker.prompt).toContain('tracker-none');
        expect(positionTracker.prompt).toContain('{{user}}');
        expect(positionTracker.regexScripts.map(script => script.id)).toEqual([
            'position-tracker-fence-cleanup',
            'position-tracker-map-open',
            'position-tracker-place',
            'position-tracker-who-here',
            'position-tracker-who-near',
            'position-tracker-who-far',
            'position-tracker-who-other',
            'position-tracker-moves-open',
            'position-tracker-move',
            'position-tracker-map-close',
        ]);
        expect(readIndexSetBody('BUNDLED_REGEX_POST_DEFAULT_EXCLUDED_TEMPLATE_IDS')).toContain('POSITION_TRACKER_TEMPLATE_ID');
        expect(readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS')).toContain('\'tpl-position-tracker-companion\'');
        expect(readIndexSetBody('HIDDEN_TEMPLATE_BROWSER_IDS')).not.toContain('\'tpl-position-tracker-companion\'');
        expect(positionTracker.enabled).toBe(false);
        const companionGroup = JSON.parse(fs.readFileSync(new URL('groups.json', templateDir), 'utf8'))
            .find(group => group.id === 'grp-companions');
        expect(companionGroup.agentTemplateIds).toContain('tpl-position-tracker-companion');

        const visualMap = findCatalogTemplate(catalog, 'tpl-visual-map-companion');
        expect(visualMap).toEqual(expect.objectContaining({
            category: 'companion',
            execution: 'companion',
            phase: 'post',
            enabled: false,
            icon: 'fa-map',
        }));
        expect(visualMap.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            format: 'html',
            rawPrompt: true,
            includeHistory: true,
            historyDepth: 1,
            maxTokens: 64000,
        }));
        expect(visualMap.prompt).toContain('place|place name|direction|kind|short detail');
        expect(visualMap.prompt).toContain('pin|character|exact spot|what they are doing');
        expect(visualMap.prompt).toContain('tracker-none');
        expect(visualMap.prompt).toContain('{{user}}');
        expect(visualMap.regexScripts.map(script => script.id)).toEqual([
            'visual-map-fence-cleanup',
            'visual-map-lead-cleanup',
            'visual-map-tail-cleanup',
            'visual-map-map-open',
            'visual-map-place',
            'visual-map-pin',
            'visual-map-trail-open',
            'visual-map-move',
            'visual-map-map-close',
        ]);
        expect(readIndexSetBody('BUNDLED_REGEX_POST_DEFAULT_EXCLUDED_TEMPLATE_IDS')).toContain('VISUAL_MAP_TEMPLATE_ID');
        expect(readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS')).toContain('\'tpl-visual-map-companion\'');
        expect(readIndexSetBody('HIDDEN_TEMPLATE_BROWSER_IDS')).not.toContain('\'tpl-visual-map-companion\'');
        expect(companionGroup.agentTemplateIds).toContain('tpl-visual-map-companion');

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

    test('renders Visual Map lines as a drawn map, tolerating loose fast-model output', () => {
        const html = renderVisualMapOutput([
            'Here is the map:',
            '```text',
            'map-start|The Gilded Lantern|Late evening, rain',
            'place|Common room|here|room|Crowded tables',
            'pin|{{user}}|Bar counter|Waiting for a drink',
            'pin|Mara|Corner booth|Counting coins',
            '- PLACE | Kitchen | East | Room | Steam and pans',
            '* WHO | Old Tobin | By the stove | Stirring',
            'place|Watchtower|north east|castle|Above the gate',
            'place|Harbour docks|far|water|Ships unloading',
            'place|Lost caravan|unknown',
            'move|Mara|Guest rooms|Common room',
            'MOVE | Tobin | Cellar | Kitchen',
            'MAP_END',
            '```',
            'Hope that helps!',
        ].join('\n'));

        expect(html).not.toMatch(/```|map[-_ ]?start|place\s*\||pin\s*\||who\s*\||move\s*\||map[-_ ]?end|Here is the map|Hope that helps/i);
        expect(html).toContain('<span class="vm-title">The Gilded Lantern</span>');
        expect(html).toContain('<span class="vm-time">Late evening, rain</span>');
        expect(html).toContain('data-vm-d="here" data-vm-k="room"');
        expect(html).toContain('data-vm-d="East" data-vm-k="Room"');
        expect(html).toContain('data-vm-d="northeast" data-vm-k="castle"');
        expect(html).toContain('data-vm-d="far" data-vm-k="water"');
        expect(html).toContain('data-vm-d="unknown"');
        expect(html.match(/class="vm-place"/g)).toHaveLength(5);
        expect(html.match(/class="vm-pin"/g)).toHaveLength(3);
        expect(html).toContain('<div class="vm-who">{{user}}</div>');
        expect(html).toContain('<span class="vm-marker"><span>O</span></span>');
        expect(html.match(/class="vm-trail"/g)).toHaveLength(1);
        expect(html.match(/class="vm-step"/g)).toHaveLength(2);
        expect(html).toContain('<b>Mara</b><span class="vm-from">Guest rooms</span>');
        expect(html).toContain('class="vm-rose"');
        expect(html.match(/<div\b/g).length).toBe(html.match(/<\/div>/g).length);

        const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
        const sheet = css.parse(style, { silent: true });
        expect(sheet.stylesheet.parsingErrors).toEqual([]);
        expect(style).not.toContain('://');
    });

    test('renders Position Tracker lines as a grouped, range-coloured map', () => {
        const html = renderPositionTrackerOutput([
            '```text',
            'map-start|The Gilded Lantern|Late evening, rain',
            'place|Common room|Crowded taproom',
            'who|Ash|here|Bar counter|Haggling with the barkeep',
            'who|Mara|Here|Corner booth|Watching the door',
            'who|{{user}}|here|By the fire|Drying off',
            'place|Kitchen|Behind the bar',
            'who|Tobin|near|Beside the stove|Listening in',
            'place|Harbour docks|Two streets west',
            'who|Captain Reyes|far|Deck of the Seawitch|Loading crates',
            'place|Unknown',
            'who|The Stranger|unknown|?',
            'move|Mara|Upstairs hallway|Common room',
            'move|Tobin|Common room|Kitchen',
            'map-end',
            '```',
        ].join('\n'));

        expect(html).not.toMatch(/```|map-start|place\||who\||move\||map-end/);
        expect(html).toContain('>The Gilded Lantern</div>');
        expect(html).toContain('>Late evening, rain</small>');
        expect(html).toContain('>Common room</div>');
        expect(html).toContain('>Unknown</div>');
        expect(html.match(/>In scene<\/small>/g)).toHaveLength(3);
        expect(html.match(/>Nearby<\/small>/g)).toHaveLength(1);
        expect(html.match(/>Away<\/small>/g)).toHaveLength(1);
        expect(html).toContain('>unknown</small>');
        expect(html).toContain('>A</span>');
        expect(html).toContain('>C</span>');
        expect(html).toContain('>u</span>');
        expect(html).toContain('fa-solid fa-route');

        const [placeHtml, movesHtml] = html.split('Recent moves');
        expect(html.match(/Recent moves/g)).toHaveLength(1);
        expect(movesHtml).toContain('<b style="overflow-wrap:anywhere">Mara</b><span style="opacity:.7;overflow-wrap:anywhere">Upstairs hallway</span>');
        expect(movesHtml).toContain('<b style="overflow-wrap:anywhere">Tobin</b>');
        expect(movesHtml).not.toContain('fa-location-dot');

        const places = placeHtml.split('fa-solid fa-location-dot').slice(1);
        expect(places).toHaveLength(4);
        expect(places.map(place => place.match(/<b style="overflow-wrap:anywhere">/g).length)).toEqual([3, 1, 1, 1]);
        expect(places[0]).toContain('>Ash</b>');
        expect(places[1]).not.toContain('Mara');
        expect(html).toContain('>Position map</div>');
        expect(html.match(/<div\b/g).length).toBe(html.match(/<\/div>/g).length);
    });

    test('seeds Vitals by default, switched off, as a Flash-sized companion that feeds the main reply', () => {
        const catalog = readTemplate('index.json');
        const vitals = findCatalogTemplate(catalog, 'tpl-vitals-companion');
        expect(vitals).toEqual(readTemplate('vitals-companion.json'));
        expect(vitals).toEqual(expect.objectContaining({
            category: 'companion',
            execution: 'companion',
            phase: 'post',
            enabled: false,
            icon: 'fa-heart-pulse',
        }));
        expect(vitals.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            format: 'html',
            rawPrompt: true,
            includeHistory: true,
            historyDepth: 1,
            feedback: { enabled: true, depth: 1 },
            maxTokens: 64000,
        }));
        expect(vitals.companion.contextMessages).toBeLessThanOrEqual(6);
        expect(vitals.prompt.length).toBeLessThan(2500);
        for (const stat of ['Health', 'Satiety', 'Hydration', 'Energy', 'Morale']) {
            expect(vitals.prompt).toContain(`bar|${stat}|value|change|reason`);
        }
        expect(vitals.prompt).toContain('tracker-none');
        expect(readIndexSetBody('BUNDLED_REGEX_POST_DEFAULT_EXCLUDED_TEMPLATE_IDS')).toContain('VITALS_TEMPLATE_ID');
        expect(readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS')).toContain('\'tpl-vitals-companion\'');
        expect(readIndexSetBody('HIDDEN_TEMPLATE_BROWSER_IDS')).not.toContain('\'tpl-vitals-companion\'');
        const companionGroup = JSON.parse(fs.readFileSync(new URL('groups.json', templateDir), 'utf8'))
            .find(group => group.id === 'grp-companions');
        expect(companionGroup.agentTemplateIds).toContain('tpl-vitals-companion');
    });

    test('renders Vitals lines as tiered bars with changes and status chips', () => {
        const html = renderVitalsOutput([
            '```',
            'vitals|Ash|Bruised and hungry, but still pushing on',
            'bar|Health|18|-12|took a club to the ribs',
            'bar|Satiety|41%|-6|no food since dawn',
            'bar|Hydration|57|+15|drank from the stream',
            'bar|Energy|100/100|0|steady',
            'bar|Morale|75|+4|escaped the bandits',
            'bar|Luck|lucky',
            'status|Bruised ribs|bad',
            'status|Adrenaline|Good',
            'status|Soaked',
            'vitals-end',
            '```',
        ].join('\n'));

        expect(html).not.toMatch(/```|vitals\||bar[|~]|status\||vitals-end|\[\[vitals-change/);
        expect(html).toContain('>Ash</div>');
        expect(html).toContain('>Bruised and hungry, but still pushing on</div>');
        expect(html.match(/>Critical<\/small>/g)).toHaveLength(1);
        expect(html.match(/>Low<\/small>/g)).toHaveLength(1);
        expect(html.match(/>Fair<\/small>/g)).toHaveLength(1);
        expect(html.match(/>Good<\/small>/g)).toHaveLength(2);
        expect(html).toContain('width:18%');
        expect(html).toContain('width:41%');
        expect(html).toContain('width:100%');
        for (const icon of ['fa-heart-pulse', 'fa-drumstick-bite', 'fa-droplet', 'fa-bolt', 'fa-face-smile', 'fa-circle-half-stroke']) {
            expect(html).toContain(`fa-solid ${icon}`);
        }
        expect(html.match(/fa-caret-down"><\/i>\d+/g)).toEqual(['fa-caret-down"></i>12', 'fa-caret-down"></i>6']);
        expect(html.match(/fa-caret-up"><\/i>\d+/g)).toEqual(['fa-caret-up"></i>15', 'fa-caret-up"></i>4']);
        expect(html).toContain('>lucky</b>');
        expect(html).toContain('fa-triangle-exclamation" style="font-size:.9em"></i>Bruised ribs</span>');
        expect(html).toContain('fa-circle-check" style="font-size:.9em"></i>Adrenaline</span>');
        expect(html).toContain('fa-circle-info" style="font-size:.9em"></i>Soaked</span>');
        expect(html.match(/<div\b/g).length).toBe(html.match(/<\/div>/g).length);

        expect(renderVitalsOutput('tracker-none')).toContain('No vitals to show yet');
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

    test('Proofreader replaces kiss similes and repairs formatting after every removal', () => {
        const proofreader = readTemplate('proofreader.json');

        expect(proofreader.prompt).toContain('Character kisses like they X: Y, and Z');
        expect(proofreader.prompt).toContain('# Formatting Pass');
        expect(proofreader.prompt).toContain('rejoin it as ONE quotation');
        expect(proofreader.prompt).toContain('Did the Formatting Pass leave no gaps');
        expect(proofreader.prompt).not.toContain('29 rules');
        expect(proofreader.prompt).toContain('30. Handover endings');
    });

    test('Friction Keeper leaves tracker blocks and tags untouched', () => {
        const keeper = readTemplate('friction-keeper.json');

        expect(keeper.prompt).toContain('Copy every tracker block, status panel, HTML or <font> tag');
        expect(keeper.prompt).toContain('Every tracker block, status panel and tag is still present');
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

    test('installs the NSFW Enhancer by default as a post-phase rewrite that leaves other text and the user alone', () => {
        const enhancer = readTemplate('nsfw-enhancer.json');

        expect(enhancer).toMatchObject({
            id: 'tpl-nsfw-enhancer',
            name: 'NSFW Enhancer',
            category: 'content',
            subcategory: 'prose-quality',
            phase: 'post',
            execution: 'inline',
            enabled: false,
        });
        expect(enhancer.injection.order).toBeGreaterThan(readTemplate('friction-keeper.json').injection.order);
        expect(enhancer.injection.order).toBeLessThan(readTemplate('dialogue-humaniser.json').injection.order);
        expect(enhancer.prompt).toContain('When the response has no intimate content, return it unchanged.');
        expect(enhancer.prompt).toContain('Write nothing for {{user}}');
        expect(enhancer.prompt).toContain('Keep every character an adult');
        expect(enhancer.id).not.toBe('tpl-nsfw-mode');
        expect(readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS')).toContain('\'tpl-nsfw-enhancer\'');
    });

    test('installs the reply rewrite chain by default in a fixed running order with the recent chat each pass needs', () => {
        const defaults = readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS');
        const chain = [
            ['continuity-corrector.json', 'tpl-continuity-corrector', 'Continuity Corrector', 12],
            ['character-authenticity.json', 'tpl-character-authenticity', 'Character Authenticity Checker', 8],
            ['prompt-adherence-checker.json', 'tpl-prompt-adherence-checker', 'Prompt Adherence Checker', 4],
            ['format-fixer.json', 'tpl-format-fixer', 'Format Fixer', 0],
            ['user-agency-guard.json', 'tpl-user-agency-guard', 'User Agency Guard', 2],
            ['knowledge-guard.json', 'tpl-knowledge-guard', 'Knowledge Guard', 6],
            ['friction-keeper.json', 'tpl-friction-keeper', 'Friction Keeper', 4],
            ['nsfw-enhancer.json', 'tpl-nsfw-enhancer', 'NSFW Enhancer', 4],
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
        for (const macro of ['{{persona}}', '{{active-lore}}', '{{active-authors-note}}', '{{secrets-tracker}}']) {
            expect(readTemplate('knowledge-guard.json').prompt).toContain(macro);
        }
        for (const macro of ['{{group-cards}}', '{{mewmory-facts}}', '{{mewmory-interview}}', '{{mesExamplesRaw}}']) {
            expect(readTemplate('character-authenticity.json').prompt).toContain(macro);
        }
        for (const macro of ['{{tracker-state}}', '{{active-lore}}', '{{active-authors-note}}', '{{persona}}', '{{mewmory-facts}}', '{{group-cards}}', '{{description}}', '{{scenario}}']) {
            expect(readTemplate('continuity-corrector.json').prompt).toContain(macro);
        }
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
