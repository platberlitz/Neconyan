/* eslint-disable playwright/no-standalone-expect -- These are Jest table-driven tests. */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeAgentExpressionLabel, resolveExpressionsAgentProfile } from '../public/scripts/extensions/expressions/expressions-agent-utils.js';
import { personaExpressionFolder, personaExpressionSelection } from '../public/scripts/extensions/expressions/persona-expressions.js';

const index = readFileSync(new URL('../public/scripts/extensions/expressions/index.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../public/scripts/extensions/expressions/expressions-agent.js', import.meta.url), 'utf8');
const core = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
function load(runtime, source, names) {
    vm.runInContext(names.map(name => source.match(new RegExp(`^(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'))[0].replace(/^export /, '')).join('\n'), runtime);
}

function setup() {
    const agent = { id: 'tpl-expressions-agent', enabled: true, execution: 'companion', connectionProfile: 'independent', companion: { trigger: 'auto' } };
    const chat = [];
    const settings = { expressions: { api: 4, showDefault: false, custom: [], agentAutoGenerateSprites: false } };
    const store = {
        getAgents: () => [agent], getEnabledAgents: () => agent.enabled ? [agent] : [],
        isCompanionAgent: item => item.execution === 'companion', isAgentHidden: () => !!agent.hidden,
        getCompanionConfig: item => item.companion, saveAgent: jest.fn(),
    };
    const context = { chat, characterId: 0, groupId: null, name2: 'Cat' };
    const jq = { is: () => false, hide: () => jq, show: () => jq, css: () => jq, empty: () => jq, data: () => 'Cat' };
    const runtime = vm.createContext({
        console, chat, extension_settings: settings, generation: 1, id: 'chat',
        getContext: () => context, getAgentStore: async () => store,
        getCompanionShared: async () => ({
            isExpressionsAgent: item => (item.sourceTemplateId || item.id) === 'tpl-expressions-agent',
            getActiveCompanionResults: message => message.swipe_info?.[message.swipe_id ?? 0]?.extra?.inChatAgentCompanionResults ?? message.extra?.inChatAgentCompanionResults ?? {},
        }),
        EXPRESSIONS_AGENT_TEMPLATE_ID: 'tpl-expressions-agent', normalizeAgentExpressionLabel,
        getChatGeneration: () => runtime.generation, getCurrentChatId: () => runtime.id,
        getMessageExpressionAvatar: message => !message?.is_user && !message?.is_system ? message?.original_avatar : null,
        system_message_types: { NARRATOR: 'narrator' }, isVisualNovelMode: () => false, $: () => jq,
        getExpressionsList: async () => ['joy', 'anger', 'curiosity'], getSpriteFolderName: () => 'Cat',
        validateImages: jest.fn(async () => {}), forceUpdateVisualNovelMode: async () => {},
        sendExpressionCall: jest.fn(async () => true), removeExpression: jest.fn(),
        generateAndUploadExpressionSprite: jest.fn(async () => true),
        getExpressionGenerationTarget: jest.fn(() => ({ characterName: 'Cat', characterAvatar: 'Cat.png', uploadName: 'Cat.png' })),
        setExpressionGenerationBusy: value => { runtime.inSpriteGeneration = value; },
        throwIfExpressionGenerationStopped: () => {}, isExpressionGenerationAbortError: error => error?.name === 'AbortError',
        MODULE_NAME: 'expressions', EXPRESSION_API: { agent: 4, none: 99 },
        spriteCache: { Cat: [{ label: 'joy', files: [{ imageSrc: '/characters/Cat/joy.png' }] }] },
        inApiCall: false, inSpriteGeneration: false, processedExpressions: new WeakMap(),
    });
    vm.runInContext('const expressionRequests = new WeakMap();', runtime);
    load(runtime, core, ['captureExpressionTarget', 'isExpressionTargetCurrent']);
    load(runtime, bridge, ['getLatestAssistantMessage', 'getExpressionsAgent', 'getExpressionsAgentStatus', 'isExpressionsAgentAvailable', 'syncExpressionsAgentProfile', 'getAgentExpressionState']);
    load(runtime, index, ['getExpressionClassificationSnapshot', 'rememberExpressionMessage', 'seedExpressionHistory', 'needsExpression', 'getLastCharacterMessage', 'moduleWorker', 'onAgentExpressionUpdated', 'applyAgentExpressionUpdate']);
    const add = (status, content = '') => {
        const message = { name: 'Cat', original_avatar: 'Cat.png', mes: `Reply ${chat.length}`, extra: { inChatAgentCompanionResults: { [agent.id]: { status, content } } } };
        chat.push(message);
        return message;
    };
    return { runtime, agent, store, settings, chat, add };
}

function setupPersona() {
    const state = setup();
    const { runtime, agent, chat } = state;
    agent.companion.maxTokens = 64000;
    agent.prompt = 'Read the latest assistant reply. Choose from {{availableExpressions}}. Sprites: {{availableSprites}}.';
    const runner = {
        getAutomaticCompanionAgents: jest.fn(() => agent.enabled ? [agent] : []),
        getAgentGenerationCancelRevision: () => 7,
        buildCompanionPromptMessages: jest.fn(async scoped => [{ role: 'system', content: scoped.prompt }]),
        requestPromptTransform: jest.fn(async () => ({ output: 'joy' })),
    };
    Object.assign(runtime, {
        getPersonaExpressionRunner: async () => runner,
        RESET_SPRITE_LABEL: '#reset',
        getMessageExpressionAvatar: message => message?.is_user && message.force_avatar ? `persona:${message.force_avatar}` : message?.original_avatar,
        personaExpressionFolder, personaExpressionSelection, personaExpressionRequests: new WeakSet(),
        power_user: { persona_descriptions: { 'robin.png': { description: 'A green coat.' } } },
        getSavedMessageExpression: message => message?.extra?.neconyanExpression,
        getSpritesList: jest.fn(async folder => ['joy', 'neutral'].map(label => ({ label, files: [{ imageSrc: `/characters/${folder}/${label}.png` }] }))),
        recordMessageExpression: jest.fn(async (target, src) => {
            if (!runtime.isExpressionTargetCurrent(target)) return false;
            target.message.extra.neconyanExpression = { avatar: target.avatar, src };
            return true;
        }),
    });
    load(runtime, bridge, ['classifyPersonaExpression']);
    load(runtime, index, ['applyPersonaExpression', 'applyPersonaAgentExpression', 'chooseSpriteForExpression']);
    const pending = [];
    const apply = runtime.applyPersonaAgentExpression;
    runtime.applyPersonaAgentExpression = (...args) => {
        const promise = apply(...args);
        pending.push(promise);
        return promise;
    };
    const addPersona = (avatar = 'robin.png', text = 'I am delighted!') => {
        const message = { name: 'Robin', force_avatar: avatar, is_user: true, mes: text, extra: {} };
        chat.push(message);
        return message;
    };
    return { ...state, runner, addPersona, finish: () => Promise.all(pending) };
}

describe('Expressions Agent persona classification', () => {
    test('uses the recorded persona, its available labels and the saved agent without changing its configuration', async () => {
        const { runtime, runner, agent, addPersona, finish } = setupPersona();
        const before = structuredClone(agent);
        const message = addPersona();
        await runtime.applyPersonaExpression(0);
        await finish();
        const folder = await personaExpressionFolder('robin.png');
        expect(message.extra.neconyanExpression).toEqual({ avatar: 'persona:robin.png', src: `/characters/${folder}/joy.png` });
        const [scoped, index, type, options] = runner.buildCompanionPromptMessages.mock.calls[0];
        expect(index).toBe(0);
        expect(type).toBe('normal');
        expect(scoped.prompt).toContain('joy, neutral');
        expect(scoped.prompt).not.toContain('{{available');
        expect(scoped.prompt).toContain('persona\'s user-authored message');
        expect(scoped.companion).toMatchObject({ includePersona: false, includeCharacterCard: false, includeHistory: false });
        expect(options.extraContextSections[0].content).toContain('A green coat.');
        expect(options.extraContextSections[0].content).toContain(message.mes);
        expect(runner.requestPromptTransform).toHaveBeenCalledWith(expect.objectContaining({ connectionProfile: 'independent' }), expect.any(Array), 64000, expect.objectContaining({ cancelRevision: 7 }));
        expect(agent).toEqual(before);
        expect(runtime.sendExpressionCall).not.toHaveBeenCalled();
    });

    test('does not hold Send while the model is pending, and ignores duplicate render events', async () => {
        const { runtime, runner, addPersona, finish } = setupPersona();
        let release;
        const response = new Promise(resolve => { release = resolve; });
        runner.requestPromptTransform.mockReturnValue(response);
        addPersona();
        await runtime.applyPersonaExpression(0);
        await runtime.applyPersonaExpression(0);
        release({ output: 'joy' });
        await finish();
        expect(runner.requestPromptTransform).toHaveBeenCalledTimes(1);
        expect(runtime.recordMessageExpression).toHaveBeenCalledTimes(1);
    });

    test.each(['disabled', 'hidden', 'manual', 'inline', 'global-off', 'none', 'extension-off', 'no-sprites', 'empty', 'unrecorded', 'history'])('does not request a persona classification for %s', async kind => {
        const { runtime, runner, agent, settings, addPersona, finish } = setupPersona();
        const message = addPersona();
        if (kind === 'disabled') agent.enabled = false;
        if (kind === 'hidden') agent.hidden = true;
        if (kind === 'manual') agent.companion.trigger = 'manual';
        if (kind === 'inline') agent.execution = 'inline';
        if (kind === 'global-off') runner.getAutomaticCompanionAgents.mockReturnValue([]);
        if (kind === 'none') settings.expressions.api = 99;
        if (kind === 'extension-off') settings.disabledExtensions = ['expressions'];
        if (kind === 'no-sprites') runtime.getSpritesList.mockResolvedValue([]);
        if (kind === 'empty') message.mes = '';
        if (kind === 'unrecorded') delete message.force_avatar;
        if (kind === 'history') message.extra.neconyanExpression = { avatar: 'persona:robin.png', src: '/saved.png' };
        await runtime.applyPersonaExpression(0);
        await finish();
        expect(runner.requestPromptTransform).not.toHaveBeenCalled();
        expect(runtime.recordMessageExpression).not.toHaveBeenCalled();
    });

    test.each(['navigation', 'edit', 'delete', 'manual-selection', 'mode-change', 'disable-agent'])('discards a late result after %s', async change => {
        const { runtime, runner, agent, settings, chat, addPersona, finish } = setupPersona();
        const message = addPersona();
        runner.requestPromptTransform.mockImplementation(async () => {
            if (change === 'navigation') runtime.generation++;
            if (change === 'edit') message.mes = 'Changed';
            if (change === 'delete') chat.length = 0;
            if (change === 'manual-selection') runtime.captureExpressionTarget(message);
            if (change === 'mode-change') settings.expressions.api = 99;
            if (change === 'disable-agent') agent.enabled = false;
            return { output: 'joy' };
        });
        await runtime.applyPersonaExpression(0);
        await finish();
        expect(runner.requestPromptTransform).toHaveBeenCalledTimes(1);
        expect(runtime.recordMessageExpression).not.toHaveBeenCalled();
    });

    test('same-name personas keep separate sets when responses finish out of order', async () => {
        const { runtime, runner, addPersona, finish } = setupPersona();
        const first = addPersona();
        const second = addPersona('robin-alt.png', 'I feel calm.');
        let release;
        const response = new Promise(resolve => { release = resolve; });
        runner.requestPromptTransform.mockImplementationOnce(() => response).mockResolvedValueOnce({ output: 'neutral' });
        await runtime.applyPersonaExpression(0);
        await runtime.applyPersonaExpression(1);
        release({ output: 'joy' });
        await finish();
        expect(first.extra.neconyanExpression.src).toBe(`/characters/${await personaExpressionFolder('robin.png')}/joy.png`);
        expect(second.extra.neconyanExpression.src).toBe(`/characters/${await personaExpressionFolder('robin-alt.png')}/neutral.png`);
    });

    test('an invalid response preserves the manual default', async () => {
        const { runtime, runner, settings, addPersona, finish } = setupPersona();
        const src = `/characters/${await personaExpressionFolder('robin.png')}/neutral.png`;
        settings.expressions.personaSelections = { 'robin.png': src };
        runner.requestPromptTransform.mockResolvedValue({ output: 'anger' });
        const message = addPersona();
        await runtime.applyPersonaExpression(0);
        await finish();
        expect(message.extra.neconyanExpression.src).toBe(src);
        expect(runtime.recordMessageExpression).toHaveBeenCalledTimes(1);
    });
});

describe('Expressions Agent lifecycle', () => {
    test('QIG sharing resolves the current profile without overwriting the independent profile', async () => {
        const { agent, settings, runtime, store } = setup();
        expect(resolveExpressionsAgentProfile(agent, settings)).toBe('independent');
        settings.expressions.agentUseQigLlmProfile = true;
        settings['quick-image-gen'] = { llmOverrideEnabled: true, llmOverrideProfileId: 'shared-a' };
        expect(resolveExpressionsAgentProfile(agent, settings)).toBe('shared-a');
        settings['quick-image-gen'].llmOverrideProfileId = 'shared-b';
        expect(resolveExpressionsAgentProfile(agent, settings)).toBe('shared-b');
        settings.expressions.agentUseQigLlmProfile = false;
        expect(resolveExpressionsAgentProfile(agent, settings)).toBe('independent');
        await runtime.syncExpressionsAgentProfile();
        expect(agent.connectionProfile).toBe('independent');
        expect(store.saveAgent).not.toHaveBeenCalled();
    });

    test.each(['disabled', 'inline', 'hidden', 'manual'])('%s agents are not reported as ready', async state => {
        const { agent, runtime } = setup();
        if (state === 'disabled') agent.enabled = false;
        if (state === 'inline') agent.execution = 'inline';
        if (state === 'hidden') agent.hidden = true;
        if (state === 'manual') agent.companion.trigger = 'manual';
        expect((await runtime.getExpressionsAgentStatus()).status).toBe(state);
        expect(await runtime.isExpressionsAgentAvailable()).toBe(false);
    });

    test.each(['error', 'cancelled', 'pending'])('an earlier %s classification does not block a later completed reply', async status => {
        const { runtime, add } = setup();
        const old = add(status);
        const next = add('done', 'joy');
        await runtime.moduleWorker();
        expect(runtime.sendExpressionCall).toHaveBeenCalledWith('Cat', 'joy', expect.objectContaining({ target: expect.objectContaining({ message: next }) }));
        expect(Boolean(runtime.needsExpression(old))).toBe(status === 'pending');
    });

    test.each([[], [{ label: 'joy', files: [{}] }]].map(sprites => [sprites]))('missing sprites are generated even with an empty or incomplete sprite set', async sprites => {
        const { runtime, add, settings } = setup();
        settings.expressions.agentAutoGenerateSprites = true;
        runtime.spriteCache.Cat = sprites;
        add('done', 'anger');
        await runtime.moduleWorker();
        await Promise.resolve();
        expect(runtime.generateAndUploadExpressionSprite).toHaveBeenCalledTimes(1);
        expect(runtime.generateAndUploadExpressionSprite).toHaveBeenCalledWith('anger', 'Cat', expect.objectContaining({ generationTarget: { characterName: 'Cat', characterAvatar: 'Cat.png', uploadName: 'Cat.png' } }));
        await runtime.moduleWorker();
        expect(runtime.generateAndUploadExpressionSprite).toHaveBeenCalledTimes(1);
    });

    test('a missing sprite waits for an occupied generation slot instead of being forgotten', async () => {
        const { runtime, add, settings } = setup();
        settings.expressions.agentAutoGenerateSprites = true;
        runtime.inSpriteGeneration = true;
        const message = add('done', 'anger');
        await runtime.moduleWorker();
        expect(runtime.generateAndUploadExpressionSprite).not.toHaveBeenCalled();
        expect(runtime.needsExpression(message)).toBeTruthy();
        runtime.inSpriteGeneration = false;
        await runtime.moduleWorker();
        expect(runtime.generateAndUploadExpressionSprite).toHaveBeenCalledTimes(1);
    });

    test('delayed automatic generation keeps the classified author when a later speaker is present', async () => {
        const { runtime, add, settings } = setup();
        settings.expressions.agentAutoGenerateSprites = true;
        const original = add('done', 'anger');
        const later = add('pending');
        later.name = 'Another character';
        later.original_avatar = 'Other.png';
        await runtime.moduleWorker();
        expect(runtime.getExpressionGenerationTarget).toHaveBeenCalledWith('Cat', original);
    });

    test('loaded history stays untouched until its saved classification actually changes', async () => {
        const { runtime, agent, add } = setup();
        const message = add('done', 'joy');
        runtime.seedExpressionHistory();
        await runtime.moduleWorker();
        const update = jest.fn(() => runtime.moduleWorker());
        await runtime.onAgentExpressionUpdated({ messageIndex: 0, agentId: agent.id }, update);
        expect(update).not.toHaveBeenCalled();
        message.extra.inChatAgentCompanionResults[agent.id] = { status: 'done', content: 'anger' };
        await runtime.onAgentExpressionUpdated({ messageIndex: 0, agentId: agent.id }, update);
        expect(update).toHaveBeenCalledTimes(1);
        expect(runtime.sendExpressionCall).toHaveBeenCalledWith('Cat', 'anger', expect.any(Object));
    });

    test('an upload finishing after navigation does not redraw the new chat sprite list', async () => {
        const { runtime } = setup();
        let finish;
        runtime.fetch = () => new Promise(resolve => { finish = resolve; });
        runtime.getRequestHeaders = () => ({});
        runtime.fetchImagesNoCache = jest.fn();
        runtime.toastr = { error: jest.fn() };
        load(runtime, index, ['handleFileUpload']);
        const upload = runtime.handleFileUpload('/upload', { get: () => 'Cat' });
        runtime.generation++;
        finish({ ok: true, json: async () => ({}) });
        await expect(upload).resolves.toEqual({});
        expect(runtime.validateImages).not.toHaveBeenCalled();
        expect(runtime.fetchImagesNoCache).not.toHaveBeenCalled();
    });
});
