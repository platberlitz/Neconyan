import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    PURRKS_EXTENSION_KEY,
    PURRKS_CHAT_METADATA_KEY,
    MAX_PURRKS_PER_CARD,
    normalizePurrkId,
    ensureUniquePurrkId,
    normalizeCharacterPurrks,
    readCharacterPurrks,
    convertOrbFragmentsToPurrks,
    extractHeuristicPurrksFromCard,
    applyImportedCharacterPurrks,
    evaluateCharacterPurrks,
    advanceChatPurrksTurnState,
    buildAiPurrksGenerationMessages,
    parseAiGeneratedPurrksResponse,
    buildSceneDirectorMessages,
    parseSceneDirectorResponse,
} from '../src/purrks.js';
import {
    prepareRoleplayHistoryContent,
    buildRoleplayPromptExtensions,
} from '../src/generation/roleplay-prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

describe('Character Purrks model and evaluation', () => {
    test('normalizes IDs, avoids reserved Orb tool keys, and deduplicates', () => {
        expect(normalizePurrkId('  Night Stalker!! ')).toBe('night-stalker');
        expect(normalizePurrkId('moods')).toBe('purrk-moods');
        expect(normalizePurrkId('speaking_plan')).toBe('purrk-speaking_plan');

        const used = new Set(['combat-stance']);
        expect(ensureUniquePurrkId('Combat Stance', used)).toBe('combat-stance-2');
        expect(ensureUniquePurrkId('Combat Stance', used)).toBe('combat-stance-3');
    });

    test('normalizes Purrk items and caps card Purrks at 50', () => {
        const items = Array.from({ length: 60 }, (_, idx) => ({
            id: `Trait ${idx + 1}`,
            label: `Trait ${idx + 1}`,
            mode: idx % 2 === 0 ? 'always' : 'keyword',
            placement: idx % 3 === 0 ? 'system' : 'depth',
            depth: 6,
            role: 1,
            prompt: `Prompt directive ${idx + 1}`,
            keywords: 'sword, battle',
            cooldownTurns: 3,
        }));

        const normalized = normalizeCharacterPurrks({
            enabled: true,
            autoSceneProfileId: 'profile-1',
            items,
        });

        expect(normalized.enabled).toBe(true);
        expect(normalized.autoSceneProfileId).toBe('profile-1');
        expect(normalized.items).toHaveLength(MAX_PURRKS_PER_CARD);
        expect(normalized.items[0]).toMatchObject({
            id: 'trait-1',
            label: 'Trait 1',
            mode: 'always',
            placement: 'system',
            depth: 6,
            role: 'user',
            keywords: ['sword', 'battle'],
            cooldownTurns: 3,
        });
    });

    test('converts Orb mood and interactive fragments into native Purrks', () => {
        const orbFragments = {
            mood: [
                {
                    id: 'flustered',
                    label: 'Flustered & Defensive',
                    description: 'Activate when teased or complimented directly.',
                    prompt_text: '{{char}} stammers, avoids eye contact, and over-explains.',
                    negative_prompt: '{{char}} regains composure and stops stammering.',
                    cooldown_turns: 2,
                    enabled: true,
                },
            ],
            interactive: [
                {
                    id: 'battle_decision',
                    label: 'Tactical Stance',
                    field_type: 'decision',
                    decision_instructions: 'Choose whether {{char}} presses the attack or retreats.',
                    decision_outputs: {
                        attack: 'Press the advantage aggressively.',
                        retreat: 'Fall back to cover and regroup.',
                    },
                    enabled: true,
                },
                {
                    id: 'inventory_tracker',
                    label: 'Carried Gear',
                    injection_label: 'Current Inventory',
                    field_type: 'state',
                    description: 'Keep {{char}}\'s visible weapons and satchel contents consistent.',
                    enabled: true,
                },
                {
                    id: 'dialogue_polish',
                    label: 'No Modern Slang',
                    field_type: 'post_processing',
                    description: 'Keep {{char}}\'s diction formal and archaic.',
                    post_processing_gate: 'Does the reply contain modern slang?',
                    enabled: false,
                },
            ],
        };

        const converted = convertOrbFragmentsToPurrks(orbFragments);
        expect(converted).toHaveLength(4);

        expect(converted[0]).toMatchObject({
            id: 'flustered',
            label: 'Flustered & Defensive',
            mode: 'scene',
            placement: 'depth',
            depth: 4,
            role: 'system',
            prompt: '{{char}} stammers, avoids eye contact, and over-explains.',
            negativePrompt: '{{char}} regains composure and stops stammering.',
            condition: 'Activate when teased or complimented directly.',
            cooldownTurns: 2,
            enabled: true,
            source: 'orb',
        });

        expect(converted[1]).toMatchObject({
            id: 'battle_decision',
            mode: 'scene',
            placement: 'depth',
            source: 'orb',
        });
        expect(converted[1].prompt).toContain('attack: Press the advantage aggressively.');

        expect(converted[2]).toMatchObject({
            id: 'inventory_tracker',
            mode: 'always',
            placement: 'depth',
            depth: 4,
            source: 'orb',
        });

        expect(converted[3]).toMatchObject({
            id: 'dialogue_polish',
            mode: 'scene',
            placement: 'post_history',
            enabled: false,
            source: 'orb',
        });
    });

    test('heuristically extracts switchable Purrks from card sections and conditional rules on import', () => {
        const card = {
            name: 'Nyx',
            data: {
                name: 'Nyx',
                description: [
                    '### Speech Style',
                    'Nyx speaks in clipped, dry sentences with deadpan humour and quiet sighs.',
                    '',
                    '### Combat Mode',
                    'When fighting or cornered, Nyx drops all banter, tracks exits, and strikes from shadow.',
                ].join('\n'),
                personality: 'When complimented: Nyx pulls her hood lower and changes the subject.',
                post_history_instructions: 'Always show Nyx\'s ear twitches before she lies.',
                extensions: {
                    depth_prompt: {
                        prompt: 'Keep Nyx\'s lantern oil low during dungeon scenes.',
                        depth: 3,
                        role: 'system',
                    },
                },
            },
        };

        const extracted = extractHeuristicPurrksFromCard(card);
        expect(extracted.length).toBeGreaterThanOrEqual(4);
        expect(extracted.some(item => item.label === 'Speech & Voice' && item.mode === 'always')).toBe(true);
        expect(extracted.some(item => item.label === 'Combat & Abilities' && (item.mode === 'scene' || item.mode === 'keyword'))).toBe(true);
        expect(extracted.some(item => item.label === 'Character Note Directive' && item.depth === 3)).toBe(true);

        const cardForImport = structuredClone(card);
        const imported = applyImportedCharacterPurrks(cardForImport, { autoExtract: true });
        const purrks = readCharacterPurrks(cardForImport);
        expect(imported.items.length).toBeGreaterThanOrEqual(4);
        expect(purrks.items.length).toBeGreaterThanOrEqual(4);

        const cardSkipped = structuredClone(card);
        const skippedHeuristic = applyImportedCharacterPurrks(cardSkipped, { autoExtract: false });
        expect(skippedHeuristic).toBeNull();
        expect(readCharacterPurrks(cardSkipped).items).toHaveLength(0);
    });

    test('evaluates always, manual, keyword, scene, per-chat overrides, cooldowns, and negative aftermath', () => {
        const character = {
            name: 'Kira',
            data: {
                extensions: {
                    [PURRKS_EXTENSION_KEY]: {
                        enabled: true,
                        items: [
                            {
                                id: 'voice',
                                label: 'Core Voice',
                                enabled: true,
                                mode: 'always',
                                placement: 'system',
                                prompt: 'Use warm, theatrical cadence.',
                            },
                            {
                                id: 'rain-cloak',
                                label: 'Rain Cloak',
                                enabled: true,
                                mode: 'keyword',
                                placement: 'description',
                                keywords: ['rain', 'storm'],
                                prompt: 'Kira wears her oilskin cloak with the brass clasp.',
                            },
                            {
                                id: 'jealous',
                                label: 'Jealous Glare',
                                enabled: true,
                                mode: 'scene',
                                placement: 'depth',
                                depth: 2,
                                role: 'system',
                                condition: 'When {{user}} praises a rival.',
                                prompt: 'Kira narrows her eyes and interrupts with sharp questions.',
                                negativePrompt: 'Kira relaxes her shoulders and stops interrogating {{user}}.',
                                cooldownTurns: 2,
                            },
                            {
                                id: 'secret-oath',
                                label: 'Secret Oath',
                                enabled: false,
                                mode: 'manual',
                                placement: 'post_history',
                                prompt: 'Never reveal the vault cipher.',
                            },
                        ],
                    },
                },
            },
        };

        const messages = [
            { mes: 'The storm is rolling in over the harbour.' },
        ];

        // Turn 1: scene selects 'jealous', user overrides 'secret-oath' ON, keyword 'storm' matches 'rain-cloak'
        const chatMetadataTurn1 = {
            [PURRKS_CHAT_METADATA_KEY]: {
                overrides: { 'secret-oath': true },
                activeSceneIds: ['jealous'],
                prevActiveIds: [],
                cooldowns: {},
            },
        };

        const evalTurn1 = evaluateCharacterPurrks(character, {
            chatMetadata: chatMetadataTurn1,
            messages,
        });

        expect(evalTurn1.activeItems.map(entry => entry.item.id)).toEqual([
            'voice',
            'rain-cloak',
            'jealous',
            'secret-oath',
        ]);
        expect(evalTurn1.placements.system).toEqual(['Use warm, theatrical cadence.']);
        expect(evalTurn1.placements.description).toEqual(['Kira wears her oilskin cloak with the brass clasp.']);
        expect(evalTurn1.placements.post_history).toEqual(['Never reveal the vault cipher.']);
        expect(evalTurn1.placements.depth).toEqual([
            {
                id: 'jealous',
                label: 'Jealous Glare',
                prompt: 'Kira narrows her eyes and interrupts with sharp questions.',
                depth: 2,
                role: 'system',
                roleNumber: 0,
                isNegative: false,
            },
        ]);

        // Advance turn state: 'jealous' was active, now scene deactivates it without cooldown first
        const stateAfterTurn1 = advanceChatPurrksTurnState(
            chatMetadataTurn1[PURRKS_CHAT_METADATA_KEY],
            evalTurn1.evaluatedItems,
        );
        expect(stateAfterTurn1.prevActiveIds).toContain('jealous');
        expect(stateAfterTurn1.cooldowns.jealous).toBeUndefined();

        // If 'jealous' is paused due to cooldown, negativePrompt should NOT inject
        const evalCooldownTurn = evaluateCharacterPurrks(character, {
            chatMetadata: {
                [PURRKS_CHAT_METADATA_KEY]: {
                    ...stateAfterTurn1,
                    activeSceneIds: [],
                    cooldowns: { jealous: 2 },
                },
            },
            messages: [{ mes: 'Clear skies today.' }],
        });
        expect(evalCooldownTurn.placements.depth).toHaveLength(0);

        // If 'jealous' had no cooldown and deactivated from prevActiveIds, negativePrompt injects for 1 turn
        const evalNegativeTurn = evaluateCharacterPurrks(character, {
            chatMetadata: {
                [PURRKS_CHAT_METADATA_KEY]: {
                    overrides: {},
                    activeSceneIds: [],
                    prevActiveIds: ['jealous'],
                    cooldowns: {},
                },
            },
            messages: [{ mes: 'Clear skies today.' }],
        });
        expect(evalNegativeTurn.placements.depth).toEqual([
            {
                id: 'jealous:negative',
                label: 'Jealous Glare (aftermath)',
                prompt: 'Kira relaxes her shoulders and stops interrogating {{user}}.',
                depth: 2,
                role: 'system',
                roleNumber: 0,
                isNegative: true,
            },
        ]);
    });

    test('builds and parses AI Purrks generation and Scene Director responses', () => {
        const genMessages = buildAiPurrksGenerationMessages({
            name: 'Seraphina',
            description: 'An alchemist who panics when experiments smoke.',
        });
        expect(genMessages).toHaveLength(2);

        const parsedPurrks = parseAiGeneratedPurrksResponse(`\`\`\`json
{
  "purrks": [
    {
      "id": "lab-panic",
      "label": "Lab Panic",
      "mode": "scene",
      "placement": "depth",
      "depth": 2,
      "role": "system",
      "condition": "When an experiment goes wrong",
      "prompt": "Seraphina speaks rapidly and waves away smoke.",
      "negativePrompt": "Seraphina takes a deep breath and tidies her vials.",
      "cooldownTurns": 1
    }
  ]
}
\`\`\``);
        expect(parsedPurrks).toHaveLength(1);
        expect(parsedPurrks[0]).toMatchObject({
            id: 'lab-panic',
            label: 'Lab Panic',
            mode: 'scene',
            placement: 'depth',
            depth: 2,
            source: 'ai',
        });

        const directorMessages = buildSceneDirectorMessages(
            { name: 'Seraphina' },
            parsedPurrks,
            [{ name: 'User', is_user: true, mes: 'The alembic is hissing and billowing purple smoke!' }],
        );
        expect(directorMessages).toHaveLength(2);

        const activeIds = parseSceneDirectorResponse(
            '{"activeIds": ["lab-panic", "unknown-id"], "reason": "Smoke in the lab"}',
            parsedPurrks,
        );
        expect(activeIds).toEqual(['lab-panic']);
        expect(parseSceneDirectorResponse('{"activeIds":["lab-panic","unknown"]}', ['lab-panic'])).toEqual(['lab-panic']);
    });

    test('keeps blank editor items, imports only once and leaves inferred prompts off', () => {
        expect(normalizeCharacterPurrks({ items: [{ id: 'new', prompt: '' }] }).items).toHaveLength(1);
        const card = { data: { description: '### Speech Style\nSpeak in clipped, dry sentences with deadpan humour and quiet sighs.', extensions: {
            orb: { fragments: { mood: [{ id: 'shy', prompt_text: 'Look away.' }] } },
        } } };
        expect(readCharacterPurrks(card).items).toEqual([]);
        applyImportedCharacterPurrks(card);
        expect(readCharacterPurrks(card).items).toHaveLength(1);
        expect(readCharacterPurrks(card).items[0].enabled).toBe(false);
        applyImportedCharacterPurrks(card, { autoExtract: true });
        expect(readCharacterPurrks(card).items).toHaveLength(1);
        card.data.extensions.neconyan_purrks.items = [];
        applyImportedCharacterPurrks(card, { autoExtract: true });
        expect(readCharacterPurrks(card).items).toEqual([]);
        delete card.data.extensions.orb;
        delete card.data.extensions.neconyan_purrks;
        expect(applyImportedCharacterPurrks(card)).toBeNull();
        applyImportedCharacterPurrks(card, { autoExtract: true });
        expect(readCharacterPurrks(card).items.length).toBeGreaterThan(0);
        expect(readCharacterPurrks(card).items.every(item => !item.enabled)).toBe(true);
    });

    test('ignores system records in keyword lookback and matches short CJK keywords', () => {
        const config = { items: [{ id: 'rain', mode: 'keyword', keywords: ['雨'], prompt: 'Wet coat.' }] };
        const messages = [{ mes: '下雨了' }, ...Array.from({ length: 8 }, () => ({ is_system: true, mes: 'Hidden' }))];
        expect(evaluateCharacterPurrks(config, { messages }).activeItems).toHaveLength(1);
        expect(evaluateCharacterPurrks(config, { messages: [{ is_system: true, mes: '雨' }] }).activeItems).toHaveLength(0);
    });

    test('starts scoped cooldowns only after deactivation and advances all members once', () => {
        const config = { items: [{ id: 'mood', mode: 'scene', prompt: 'Tense.', negativePrompt: 'Relax.', cooldownTurns: 2 }] };
        const metadata = { neconyan_purrks: { activeSceneIds: ['a:mood', 'b:mood'] } };
        const evaluate = key => evaluateCharacterPurrks(config, { chatMetadata: metadata, characterKey: key }).evaluatedItems;
        const first = advanceChatPurrksTurnState(metadata.neconyan_purrks, [...evaluate('a'), ...evaluate('b')]);
        expect(first.prevActiveIds).toEqual(['a:mood', 'b:mood']);
        expect(first.cooldowns).toEqual({});
        metadata.neconyan_purrks = { ...first, activeSceneIds: [] };
        expect(evaluate('a')[0].injectNegative).toBe(true);
        const second = advanceChatPurrksTurnState(metadata.neconyan_purrks, [...evaluate('a'), ...evaluate('b')]);
        expect(second.cooldowns).toEqual({ 'a:mood': 2, 'b:mood': 2 });
        metadata.neconyan_purrks = second;
        const third = advanceChatPurrksTurnState(second, [...evaluate('a'), ...evaluate('b')]);
        expect(third.cooldowns).toEqual({ 'a:mood': 1, 'b:mood': 1 });
        config.enabled = false;
        metadata.neconyan_purrks = first;
        expect(evaluate('a')[0].injectNegative).toBe(false);
    });

    test('server roleplay prompt assembly substitutes macros and registers multi-depth Purrks', () => {
        const snapshot = {
            source: {
                locator: { group: false },
            },
            speakerNames: {
                character: 'Mittens',
                user: 'Tester',
            },
            mediaPolicy: null,
            attachments: [],
            experimentalMacroEngine: false,
            characterExamples: '',
            groupPrompt: null,
            metadata: {},
            regex: [],
            authorNote: null,
            personaPosition: 0,
            depthPrompt: {
                prompt: 'Base depth note for {{char}}.',
                depth: 4,
                role: 'system',
            },
            depthPrompts: [
                {
                    prompt: 'Base depth note for {{char}}.',
                    depth: 4,
                    role: 'system',
                },
                {
                    prompt: 'Purrk directive for {{char}} speaking to {{user}}.',
                    depth: 1,
                    role: 'user',
                },
            ],
            systemPrompt: 'Custom system prompt for {{char}}.',
            postHistory: { character: 'Post history for {{char}}.' },
            global: {
                trigger: 'normal',
                personaDescription: '',
                characterDescription: 'Description of {{char}}.',
                characterPersonality: '',
                characterDepthPrompt: 'Base depth note for {{char}}.\n\nPurrk directive for {{char}} speaking to {{user}}.',
                scenario: '',
                creatorNotes: '',
            },
        };

        const environment = {
            names: { char: 'Mittens', user: 'Tester' },
            character: {},
            evaluate(value) {
                return String(value ?? '')
                    .replace(/\{\{char\}\}/gi, this.names.char)
                    .replace(/\{\{user\}\}/gi, this.names.user);
            },
        };

        const prepared = prepareRoleplayHistoryContent(
            [{ chat_metadata: {} }, { name: 'Tester', is_user: true, mes: 'Hello!' }],
            snapshot,
            environment,
        );

        expect(prepared.depthPrompts).toHaveLength(2);
        expect(prepared.depthPrompts[0].prompt).toBe('Base depth note for Mittens.');
        expect(prepared.depthPrompts[1]).toMatchObject({
            prompt: 'Purrk directive for Mittens speaking to Tester.',
            depth: 1,
            role: 'user',
        });

        const extensions = buildRoleplayPromptExtensions(prepared, {
            ANBeforeEntries: [],
            ANAfterEntries: [],
            WIDepthEntries: [],
        });
        expect(extensions).toEqual([
            {
                key: 'DEPTH_PROMPT_0',
                content: 'Base depth note for Mittens.',
                position: 1,
                depth: 4,
                role: 'system',
            },
            {
                key: 'DEPTH_PROMPT_1',
                content: 'Purrk directive for Mittens speaking to Tester.',
                position: 1,
                depth: 1,
                role: 'user',
            },
        ]);
        snapshot.groupPrompt = {
            mode: 1, prefix: '', suffix: '', members: [{
                name: 'Mittens', selected: true, disabled: false,
                fields: { description: '', personality: '', scenario: '', mes_example: '' },
                depth: { prompt: 'Base note', depth: 4, role: 'system' },
                purrkDepths: [{ prompt: 'Separate instruction', depth: 1, role: 'user' }],
            }],
        };
        const groupPrepared = prepareRoleplayHistoryContent(
            [{ chat_metadata: {} }, { name: 'Tester', is_user: true, mes: 'Hello!' }], snapshot, environment,
        );
        expect(groupPrepared.depthPrompts).toEqual([
            { prompt: 'Base note', depth: 4, role: 'system' },
            { prompt: 'Separate instruction', depth: 1, role: 'user' },
        ]);
    });
});

describe('Character Purrks UI, CSS, and shell contracts', () => {
    const indexHtml = fs.readFileSync(path.join(repoRoot, 'public/index.html'), 'utf8');
    const purrksCss = fs.readFileSync(path.join(repoRoot, 'public/css/neconyan-purrks.css'), 'utf8');
    const tabsJs = fs.readFileSync(path.join(repoRoot, 'public/scripts/neconyan-tabs.js'), 'utf8');
    const creatorIndexJs = fs.readFileSync(path.join(repoRoot, 'public/scripts/creator/index.js'), 'utf8');

    test('ships neconyan-purrks.css as a deferred stylesheet with accent-aware tokens and reduced-motion guard', () => {
        expect(indexHtml).toContain('href="css/neconyan-purrks.css?v=20261105-sunken-reef" rel="preload" as="style" data-sb-deferred-style data-sb-media="all"');
        expect(purrksCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(purrksCss).not.toMatch(/!important/);
        expect(purrksCss).not.toMatch(/(^|\s)\/\//m);
        expect(purrksCss).toContain('@media (prefers-reduced-motion: reduce)');
    });

    test('wires Purrks into the Character Import panel, Classic Character Editor, Catelier, and bottom chat bar', () => {
        expect(indexHtml).toContain('id="sb_character_import_auto_purrks"');
        expect(indexHtml).toContain('id="character_purrks_block"');
        expect(indexHtml).toContain('id="option_toggle_purrks"');
        expect(tabsJs).toContain('sb-bottom-chat-purrks-btn');
        expect(creatorIndexJs).toContain('renderCreatorPurrks(this, main)');
    });

    test('gives the secondary row vertical headroom so the Purrks badge arc is not clipped', () => {
        const tabsCss = fs.readFileSync(path.join(repoRoot, 'public/css/neconyan-tabs.css'), 'utf8');
        const rules = [...tabsCss.matchAll(/\.sb-bottom-chat-secondary-row\s*\{([^}]*)\}/g)].map(match => match[1]);
        // The phone-only rule is the one that turns the row into a clipping scroll
        // container; the desktop rule stays display: contents and cannot clip.
        const phoneRule = rules.find(body => body.includes('overflow-y: hidden'));
        expect(phoneRule).toBeDefined();
        // The badge sits 3px above its button, so neconyan-purrks.css (a deferred
        // sheet, and after the core ones in the cascade) gives the row symmetric
        // padding-block with a matching negative margin-block: headroom inside the
        // padding box, no shift in the outer geometry.
        expect(purrksCss).toContain('top: -3px');
        const headroomRule = purrksCss.match(/\.sb-bottom-chat-secondary-row\s*\{([^}]*)\}/);
        expect(headroomRule).toBeDefined();
        expect(headroomRule[1]).toContain('padding-block: 4px;');
        expect(headroomRule[1]).toContain('margin-block: -4px;');
    });
});
