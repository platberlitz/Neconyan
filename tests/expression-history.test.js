import { describe, expect, test, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isExpressionSource, readMessageExpression, writeMessageExpression } from '../public/scripts/expression-history.js';
import { expressionLabelFromFilename, isExpressionLabel, nextExpressionSpriteName } from '../public/scripts/extensions/expressions/expression-labels.js';
import { applyExpressionMemberPrompt, readExpressionSets, resolveExpressionMember } from '../public/scripts/extensions/expressions/expression-sets.js';
import { EventEmitter } from '../public/lib/eventemitter.js';

const core = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const expressions = readFileSync(new URL('../public/scripts/extensions/expressions/index.js', import.meta.url), 'utf8');
const companion = readFileSync(new URL('../public/scripts/extensions/in-chat-agents/companion/companion-runner.js', import.meta.url), 'utf8');
const extract = (source, name) => source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0].replace(/^export /, '');

describe('exact expression history', () => {
    test('keeps variants and explicit resets independent per swipe through JSON storage', () => {
        const message = { extra: { keep: 1 }, swipe_id: 0, swipe_info: [{ extra: { keep: 2 } }, { extra: {} }] };
        expect(writeMessageExpression(message, 'Cat.png', '/characters/Cat/joy-2.webp?t=1')).toBe(true);
        message.swipe_id = 1;
        expect(readMessageExpression(message, 'Cat.png')).toBeUndefined();
        writeMessageExpression(message, 'Cat.png', null);
        const stored = JSON.parse(JSON.stringify(message));
        expect(readMessageExpression(stored, 'Cat.png').src).toBeNull();
        stored.swipe_id = 0;
        expect(readMessageExpression(stored, 'Cat.png').src).toBe('/characters/Cat/joy-2.webp?t=1');
        expect(stored.extra.keep).toBe(1);
        expect(stored.swipe_info[0].extra.keep).toBe(2);
        expect(readMessageExpression(stored, 'Other.png')).toBeUndefined();
    });

    for (const src of ['https://other.test/a.png', '//other.test/a.png', '/api/secret.png', '/characters/%2e%2e/api/a.png', '/characters/a%5cb.png', '/characters/a.png#x', ' ', undefined]) {
        test(`rejects unsafe imported source ${src}`, () => {
            expect(isExpressionSource(src)).toBe(false);
        });
    }

    test('accepts the server’s unescaped multiword sprite paths', () => {
        expect(isExpressionSource('/characters/Expression Cat/joy variant.png?t=1')).toBe(true);
    });

    test('captures message, swipe, chat load, author and text, and a newer choice invalidates old work', () => {
        const message = { mes: 'same reply', name: 'Cat', avatar: 'Cat.png' };
        const state = { generation: 1, id: 'chat', chat: [message] };
        const runtime = vm.createContext({ ...state, getChatGeneration: () => state.generation, getCurrentChatId: () => state.id,
            getMessageExpressionAvatar: m => m?.avatar });
        vm.runInContext(`const expressionRequests = new WeakMap();\n${extract(core, 'captureExpressionTarget')}\n${extract(core, 'isExpressionTargetCurrent')}`, runtime);
        const old = runtime.captureExpressionTarget(message);
        expect(runtime.isExpressionTargetCurrent(old)).toBe(true);
        runtime.captureExpressionTarget(message);
        expect(runtime.isExpressionTargetCurrent(old)).toBe(false);
        for (const mutate of [() => state.generation++, () => { state.id += 'x'; }, () => message.swipe_id = 1,
            () => message.mes += ' edited', () => message.name += ' renamed', () => message.avatar = 'Other.png']) {
            const target = runtime.captureExpressionTarget(message);
            mutate();
            expect(runtime.isExpressionTargetCurrent(target)).toBe(false);
        }
    });

    test('loaded messages and existing swipes are read-only, identical new replies still need classification', () => {
        const message = { mes: 'same', swipe_id: 0, swipes: ['same', 'other'] };
        const chat = [message];
        const runtime = vm.createContext({ getContext: () => ({ chat }), getMessageExpressionAvatar: () => 'Cat.png' });
        vm.runInContext(`let processedExpressions = new WeakMap();\n${['getExpressionClassificationSnapshot', 'rememberExpressionMessage', 'seedExpressionHistory', 'needsExpression'].map(name => extract(expressions, name)).join('\n')}`, runtime);
        runtime.seedExpressionHistory();
        expect(runtime.needsExpression(message)).toBe(false);
        message.swipe_id = 1; message.mes = 'other';
        expect(runtime.needsExpression(message)).toBe(false);
        expect(runtime.needsExpression({ mes: 'same' })).toBe(true);
        message.mes = 'edited';
        expect(runtime.needsExpression(message)).toBe(true);
    });

    for (const name of ['runSingleCompanionAgent', 'runBatchCompanionAgents']) {
        test(`${name} discards delayed results without cancellation writes to the new swipe`, async () => {
            const message = { mes: 'old', swipe_id: 0 };
            const agent = { id: 'expression', companion: {} };
            let release;
            const request = new Promise(resolve => { release = resolve; });
            const write = jest.fn();
            const runtime = vm.createContext({ chat: [message], getChatGeneration: () => 1, getCurrentChatId: () => 'chat',
                captureMessageTargetState: message => ({ swipe: message.swipe_id }),
                isMessageTargetCurrent: (message, state) => message.swipe_id === state.swipe,
                getAgentPostProcessingTarget: () => undefined,
                areAgentsGloballyEnabled: () => true, getCompanionReferenceIds: () => [], MEMORY_SHARD_TEMPLATE_ID: 'tpl-memory-shard',
                isValidCompanionTargetMessage: () => true, isAgentRuntimeAllowed: () => true, getCompanionConfig: () => ({ maxTokens: 100 }),
                getCompanionResultContent: () => '', getCompanionResults: () => ({}), getAgentGenerationCancelRevision: () => 0,
                buildCompanionPromptMessages: async () => [], buildBatchPromptPayload: async () => ({ promptMessages: [], taskPayloads: [] }),
                getUnitExtraContextSections: () => [], requestPromptTransform: () => request, MAX_AGENT_MAX_TOKENS: 100,
                setCompanionResult: write, restoreCompanionResult: write, emitCompanionResultsUpdated: write, DOMException,
            });
            vm.runInContext(`${extract(companion, 'captureCompanionTarget')}\n${extract(companion, name)}`, runtime);
            const pending = runtime[name](name.includes('Batch') ? [agent] : agent, 0, 'normal', 0);
            await Promise.resolve();
            message.swipe_id = 1;
            release({ output: 'joy' });
            await pending;
            expect(write).not.toHaveBeenCalled();
        });
    }
});

describe('expression asset snapshots', () => {
    test('generation follows the folder owner rather than a later group speaker or an imported duplicate', () => {
        const member = { id: 'mira', name: 'Mira', folder: 'cast/mira', description: 'Original notes' };
        const original = { name: 'Original cast', avatar: 'original.png', data: { extensions: { expression_sets: { members: [member], active: 'mira' } } } };
        const copy = { name: 'Imported cast', avatar: 'copy.png', data: { extensions: { expression_sets: { members: [{ ...member, description: 'Imported notes' }], active: 'mira' } } } };
        const nova = { name: 'Nova', avatar: 'nova.png' };
        let message = { name: copy.name, original_avatar: copy.avatar };
        const characters = [original, copy, nova];
        const runtime = vm.createContext({ getContext: () => ({ characters, groupId: 'group' }), getLastCharacterMessage: () => message,
            getExpressionCharacter: (target = message) => characters.find(character => character.avatar === target.original_avatar),
            readExpressionSets, applyExpressionMemberPrompt, extension_settings: { expressionOverrides: [] },
            getExpressionSpritePromptContext: name => ({ characterName: name, characterCard: name }),
        });
        const helpers = ['getExpressionFolderCharacter', 'getExpressionGenerationTarget'];
        vm.runInContext(helpers.map(name => extract(expressions, name)).join('\n'), runtime);
        expect(runtime.getExpressionGenerationTarget('cast/mira').characterAvatar).toBe('copy.png');
        expect(runtime.getExpressionGenerationTarget('cast/mira').promptContext.characterCard).toContain('Imported notes');
        message = { name: 'Nova', original_avatar: 'nova.png' };
        expect(runtime.getExpressionGenerationTarget('Original cast').characterAvatar).toBe('original.png');
        expect(runtime.getExpressionGenerationTarget('cast/mira', { original_avatar: 'copy.png' }).characterAvatar).toBe('copy.png');
    });

    test('failed classifications release their settings listener and later schemas include custom labels', async () => {
        const eventSource = new EventEmitter();
        const generateRaw = jest.fn().mockRejectedValueOnce(new Error('Failed before settings were prepared'));
        const runtime = vm.createContext({ eventSource, event_types: { TEXT_COMPLETION_SETTINGS_READY: 'ready' },
            extension_settings: { expressions: { api: 2, promptType: 0, fallback_expression: 'neutral' } },
            EXPRESSION_API: { local: 0, llm: 2, webllm: 3, agent: 4, none: 99 }, PROMPT_TYPE: { raw: 0, full: 1 },
            sampleClassifyText: text => text, waitUntilCondition: async () => {}, online_status: 'connected',
            getExpressionsList: async () => ['joy', 'joy-soft'], substituteParamsExtended: () => 'Classify',
            generateRaw, isJsonSchemaSupported: () => true, parseLlmResponse: response => response,
            toastr: { error: jest.fn() }, console: { error: jest.fn() },
        });
        vm.runInContext(`let inApiCall = false;\n${['getJsonSchema', 'onTextGenSettingsReady', 'getExpressionLabel'].map(name => extract(expressions, name)).join('\n')}`, runtime);
        expect(await runtime.getExpressionLabel('Hello')).toBe('neutral');
        expect(eventSource.events.ready).toHaveLength(0);
        const args = {};
        generateRaw.mockImplementationOnce(async () => { await eventSource.emit('ready', args); return 'joy-soft'; });
        expect(await runtime.getExpressionLabel('Hello again')).toBe('joy-soft');
        expect(args.json_schema.properties.emotion.enum).toEqual(['joy', 'joy-soft']);
        expect(eventSource.events.ready).toHaveLength(0);
    });

    test('uploads and the last-expression lookup use the displayed card name, including folder overrides', () => {
        const overrides = [];
        const runtime = vm.createContext({ resolveExpressionMember, extension_settings: { expressionOverrides: overrides } });
        vm.runInContext(extract(expressions, 'spriteFolderNameFromCharacter'), runtime);
        const character = { name: 'Mira and Sol', avatar: 'cast-2.png' };
        expect(runtime.spriteFolderNameFromCharacter(character)).toBe('Mira and Sol');
        overrides.push({ name: 'cast-2', path: 'cast/formal' });
        expect(runtime.spriteFolderNameFromCharacter(character)).toBe('cast/formal');
    });

    test('a newly added custom label wins over a stale server label before settings finish saving', () => {
        const runtime = vm.createContext({ expressionLabelFromFilename, extension_settings: { expressions: { custom: ['joy-soft'] } } });
        vm.runInContext(extract(expressions, 'getExpressionImageData'), runtime);
        const image = runtime.getExpressionImageData({ label: 'joy', path: '/characters/cast/joy-soft-2%20variant.png?t=12' });
        expect(image.expression).toBe('joy-soft');
        expect(image.fileName).toBe('joy-soft-2 variant.png');
        expect(image.isCustom).toBe(true);
    });

    test('switching cards while an image is generated keeps its original person, prompt and destination', async () => {
        const member = { id: 'mira', name: 'Mira', folder: 'cast/mira', description: 'Silver hair.' };
        const character = { name: 'Mira and Sol', avatar: 'cast.png', data: { extensions: { expression_sets: { members: [member], active: 'mira' } } } };
        let context = { characters: [character], characterId: 0 };
        let release;
        const generation = new Promise(resolve => { release = resolve; });
        const generate = jest.fn(() => generation);
        const upload = jest.fn(async () => 'joy');
        const runtime = vm.createContext({ getContext: () => context, getLastCharacterMessage: () => ({ name: 'Mira and Sol', original_avatar: 'cast.png' }),
            getExpressionCharacter: () => context.characters[context.characterId],
            readExpressionSets, applyExpressionMemberPrompt, getExpressionSpritePromptContext: () => ({ characterName: 'Mira and Sol', characterCard: 'Shared history' }),
            spriteCache: {}, extension_settings: { expressions: {}, expressionOverrides: [] }, nextExpressionSpriteName, maybeGenerateExpressionSprite: generate, uploadSpriteCommand: upload,
            throwIfExpressionGenerationStopped: () => {}, setExpressionGenerationBusy: () => {}, inSpriteGeneration: true,
        });
        vm.runInContext(['getExpressionFolderCharacter', 'getExpressionGenerationTarget', 'generateUniqueSpriteName', 'generateAndUploadExpressionSprite'].map(name => extract(expressions, name)).join('\n'), runtime);
        const pending = runtime.generateAndUploadExpressionSprite('joy', member.folder, { showToast: false });
        context = { characters: [{ name: 'Another character', avatar: 'other.png' }], characterId: 0 };
        member.description = 'Changed during generation';
        release('/generated/mira.png');
        expect(await pending).toBe(true);
        expect(generate.mock.calls[0][3].characterName).toBe('Mira');
        expect(generate.mock.calls[0][3].characterCard).toContain('Silver hair.');
        expect(upload).toHaveBeenCalledWith({ name: 'cast.png', label: 'joy', folder: 'cast/mira', spriteName: 'joy' }, '/generated/mira.png');
    });
});

describe('sprite upload failures are not reported as success', () => {
    function uploadRuntime(fetchImpl) {
        const spriteCache = { Cat: [] };
        const toastr = { error: jest.fn(), success: jest.fn() };
        const runtime = vm.createContext({
            console: { debug: jest.fn(), error: jest.fn() },
            fetch: fetchImpl,
            File: class { constructor() {} },
            FormData: class { #m = new Map(); append(k, v) { this.#m.set(k, v); } get(k) { return this.#m.get(k); } },
            toastr,
            t: (strings, ...values) => String.raw({ raw: strings }, ...values),
            MODULE_NAME: 'expressions',
            spriteCache,
            getChatGeneration: () => 1,
            getCurrentChatId: () => 'chat',
            $: () => ({ data: () => 'Cat' }),
            getRequestHeaders: () => ({}),
            fetchImagesNoCache: async () => {},
            validateImages: async () => {},
            validateExpressionSpriteName: () => true,
            isExpressionLabel,
            getLastCharacterMessage: () => ({ name: 'Cat', original_avatar: 'Cat.png' }),
            findChar: () => ({ name: 'Cat' }),
            spriteFolderNameFromCharacter: () => 'Cat',
        });
        vm.runInContext(`${extract(expressions, 'handleFileUpload')}\n${extract(expressions, 'uploadSpriteCommand')}`, runtime);
        return { runtime, toastr };
    }

    test('a rejected server upload throws instead of returning a sprite name', async () => {
        const { runtime, toastr } = uploadRuntime(async (url) => url === 'blob:image'
            ? { blob: async () => new Uint8Array() }
            : { ok: false, status: 500 });
        await expect(runtime.uploadSpriteCommand({ name: 'Cat', label: 'joy', folder: 'Cat' }, 'blob:image')).rejects.toThrow('Sprite upload failed');
        expect(toastr.error).toHaveBeenCalledWith('Failed to upload image');
    });

    test('an accepted upload still returns the sprite name', async () => {
        const { runtime } = uploadRuntime(async (url) => url === 'blob:image'
            ? { blob: async () => new Uint8Array() }
            : { ok: true, json: async () => ({}) });
        await expect(runtime.uploadSpriteCommand({ name: 'Cat', label: 'joy', folder: 'Cat' }, 'blob:image')).resolves.toBe('joy');
    });
});
