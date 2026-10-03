import {
    characters,
    eventSource,
    event_types,
    flushCharacterSaveDebounced,
    getChatGeneration,
    getCurrentChatId,
    getOneCharacter,
    getRequestHeaders,
    printCharactersDebounced,
    select_selected_character,
    this_chid,
} from '../script.js';
import { selected_group } from './group-chats.js';
import { ToolManager } from './tool-calling.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { buildAssistantReview, buildNoteProposalReview } from './neconyan-assistant-review.js';
import { NOTE_TOOL_DEFINITIONS } from './notebooks/assistant-note-tools.js';
import { formatDiff } from './notebooks/line-diff.js';
import { loadWorldInfo, world_names } from './world-info.js';
import { updateEntry } from './extensions/in-chat-agents/pathfinder/entry-manager.js';
import {
    areAgentsLoaded,
    getAgentById,
    getAgents,
    saveAgent,
} from './extensions/in-chat-agents/agent-store.js';
import { extension_settings } from './extensions.js';
import { getPresetManager } from './preset-manager.js';
import { getCurrentUserHandle } from './user.js';
import { getExtensionCapability } from './neconyan-conversation/extension-capabilities.js';
import { isNeconyanAssistant } from './neconyan-assistant-knowledge.js';
import { ASK_FIRST, CONFIRM_PROTOCOL, CREATE_CHARACTER_GUIDE, USER_CONFIRMED_DESCRIPTION } from './neconyan-assistant-tool-guidance.js';

const TOOL_PREFIX = 'Neconyan_Assistant_';
const registeredTools = new Set();
const editableCharacterFields = Object.freeze([
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions',
]);
const editableAgentFields = Object.freeze([
    'name', 'description', 'prompt', 'tags', 'favorite', 'connectionProfile', 'modelOverride',
]);
const editableLorebookFields = Object.freeze(['title', 'content']);
const supportedPresetApis = new Set(['kobold', 'novel', 'openai', 'textgenerationwebui']);

const presetFields = Object.freeze({
    kobold: new Set([
        'grammar', 'temp', 'top_p', 'top_k', 'top_a', 'min_p', 'typical', 'tfs',
        'rep_pen', 'rep_pen_range', 'rep_pen_slope', 'mirostat', 'mirostat_tau',
        'mirostat_eta', 'sampler_order',
    ]),
    novel: new Set([
        'prefix', 'temperature', 'top_p', 'top_k', 'top_a', 'min_p', 'typical_p',
        'tail_free_sampling', 'repetition_penalty', 'repetition_penalty_range',
        'repetition_penalty_slope', 'repetition_penalty_frequency',
        'repetition_penalty_presence', 'phrase_rep_pen', 'mirostat_tau', 'mirostat_lr',
        'max_length', 'max_context', 'order',
    ]),
    openai: new Set([
        'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k', 'top_a',
        'min_p', 'typical_p', 'repetition_penalty', 'seed', 'n', 'openai_max_context', 'openai_max_tokens',
        'new_chat_prompt', 'new_group_chat_prompt', 'new_example_chat_prompt',
        'continue_nudge_prompt', 'impersonation_prompt', 'assistant_prefill', 'continue_prefill',
        'send_if_empty', 'squash_system_messages', 'names_behavior', 'media_inlining',
        'use_sysprompt',
    ]),
    textgenerationwebui: new Set([
        'temp', 'temperature_last', 'rep_pen', 'rep_pen_range', 'rep_pen_decay', 'rep_pen_slope',
        'no_repeat_ngram_size', 'top_k', 'top_p', 'top_a', 'tfs', 'epsilon_cutoff', 'eta_cutoff',
        'typical_p', 'min_p', 'penalty_alpha', 'num_beams', 'length_penalty', 'min_length',
        'dynatemp', 'min_temp', 'max_temp', 'dynatemp_exponent', 'smoothing_factor',
        'smoothing_curve', 'dry_allowed_length', 'dry_multiplier', 'dry_base',
        'dry_sequence_breakers', 'dry_penalty_last_n', 'max_tokens_second', 'encoder_rep_pen',
        'freq_pen', 'presence_pen', 'skew', 'do_sample', 'early_stopping', 'seed', 'add_bos_token',
        'ban_eos_token', 'skip_special_tokens', 'include_reasoning', 'mirostat_mode',
        'mirostat_tau', 'mirostat_eta', 'grammar_string', 'negative_prompt', 'sampler_order',
    ]),
});

const presetNumericRanges = Object.freeze({
    temperature: [0, 4], temp: [0, 4], top_p: [0, 1], top_a: [0, 1], min_p: [0, 1],
    typical: [0, 1], typical_p: [0, 1], tfs: [0, 1], tail_free_sampling: [0, 1],
    frequency_penalty: [-2, 2], presence_penalty: [-2, 2], repetition_penalty: [0, 10],
    rep_pen: [0, 10], rep_pen_range: [0, 1000000], repetition_penalty_range: [0, 1000000],
    rep_pen_slope: [0, 10], repetition_penalty_slope: [0, 10],
    repetition_penalty_frequency: [-10, 10], repetition_penalty_presence: [-10, 10],
    mirostat: [0, 2], mirostat_mode: [0, 2], mirostat_tau: [0, 100], mirostat_eta: [0, 10],
    mirostat_lr: [0, 10], top_k: [0, 1000000], seed: [-1, 2147483647], n: [1, 128],
    openai_max_context: [1, 1000000], openai_max_tokens: [1, 1000000], max_length: [0, 1000000],
    max_context: [1, 1000000], no_repeat_ngram_size: [0, 1000000], epsilon_cutoff: [0, 1],
    eta_cutoff: [0, 1], penalty_alpha: [0, 10], num_beams: [1, 1000], length_penalty: [-10, 10],
    min_length: [0, 1000000], min_temp: [0, 4], max_temp: [0, 4], dynatemp_exponent: [0, 10],
    smoothing_factor: [0, 10], smoothing_curve: [0, 10], dry_allowed_length: [0, 1000000],
    dry_multiplier: [0, 10], dry_base: [0, 10], dry_penalty_last_n: [0, 1000000],
    max_tokens_second: [0, 1000000], encoder_rep_pen: [0, 10], freq_pen: [-10, 10],
    presence_pen: [-10, 10], skew: [-10, 10], names_behavior: [0, 10],
});

const presetNumericRangesByApi = Object.freeze({
    kobold: {
        temp: [0, 4], top_k: [0, 100], rep_pen: [1, 3], rep_pen_range: [0, 4096],
        mirostat_tau: [0, 20], mirostat_eta: [0, 1],
    },
    novel: {
        temperature: [0.1, 2.5], repetition_penalty: [1, 8], top_k: [0, 300],
        mirostat_tau: [0, 6], mirostat_lr: [0, 1],
    },
    openai: {
        temperature: [0, 2], top_k: [0, 500], openai_max_context: [512, 2000000], openai_max_tokens: [1, 128000],
    },
    textgenerationwebui: {
        temp: [0, 5], max_temp: [0, 5], top_k: [0, 1000000], rep_pen: [0, 10],
    },
});

const integerPresetFields = new Set([
    'top_k', 'rep_pen_range', 'repetition_penalty_range', 'mirostat', 'mirostat_mode',
    'seed', 'n', 'openai_max_context', 'openai_max_tokens', 'max_length', 'max_context',
    'no_repeat_ngram_size', 'num_beams', 'min_length', 'dry_allowed_length',
    'dry_penalty_last_n', 'max_tokens_second', 'names_behavior',
]);

let activeRegistration = null;
let registrationRevision = 0;
// ponytail: one assistant edit lane; resource-specific queues remain authoritative.
let assistantEditChain = Promise.resolve();

class AssistantContextError extends Error {
    constructor(message = 'The assistant tool call is stale or cancelled.') {
        super(message);
        this.code = 'ASSISTANT_CONTEXT_STALE';
    }
}

class AssistantConflictError extends Error {
    constructor(message) {
        super(message);
        this.code = 'ASSISTANT_CONFLICT';
    }
}

function clone(value) {
    return structuredClone(value);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value, key) {
    return isPlainObject(value) && Object.hasOwn(value, key);
}

function requiredString(input, key, { nonempty = true } = {}) {
    if (!own(input, key) || typeof input[key] !== 'string' || (nonempty && !input[key].trim())) {
        throw new Error(`${key} must be a ${nonempty ? 'non-empty ' : ''}string.`);
    }
    return input[key];
}

function requireObject(input, key) {
    if (!own(input, key) || !isPlainObject(input[key])) throw new Error(`${key} must be an object.`);
    return input[key];
}

function parseUid(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
    throw new Error('uid must be a non-negative integer.');
}

function valuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function reviewValue(value) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function currentCharacter() {
    return characters?.[this_chid] ?? null;
}

function getActiveAssistantContext() {
    const character = currentCharacter();
    const chatId = getCurrentChatId?.();
    const metadata = character?.data?.extensions?.neconyan_assistant;
    if (selected_group || !character || chatId === undefined || chatId === null || chatId === ''
        || !isNeconyanAssistant(character)) {
        return null;
    }

    return {
        account: getCurrentUserHandle(),
        chatId: String(chatId),
        generation: getChatGeneration?.() ?? null,
        avatar: String(character.avatar || ''),
        assistantId: String(metadata.id),
    };
}

function contextKey(context) {
    return context ? [context.account, context.chatId, context.avatar, context.assistantId].join('\u0000') : '';
}

function isRegistrationCurrent(registration) {
    const live = getActiveAssistantContext();
    return Boolean(activeRegistration?.revision === registration.revision
        && live
        && contextKey(live) === contextKey(registration));
}

function createGuard(registration, invocationContext = {}) {
    const signal = invocationContext?.signal ?? null;
    const callerIsCurrent = typeof invocationContext?.isCurrent === 'function' ? invocationContext.isCurrent : () => true;
    const invocation = getActiveAssistantContext();
    const isCurrent = () => {
        try {
            const live = getActiveAssistantContext();
            return !signal?.aborted && callerIsCurrent() && Boolean(invocation && live)
                && contextKey(live) === contextKey(invocation) && live.generation === invocation.generation
                && isRegistrationCurrent(registration);
        } catch {
            return false;
        }
    };
    const assert = () => {
        if (!isCurrent()) throw new AssistantContextError();
    };
    const supplied = invocationContext?.callId;
    const callId = typeof supplied === 'string' && supplied.length > 0 && supplied.length <= 200 ? supplied : crypto.randomUUID();
    return { signal, isCurrent, invocation, assert, callId };
}

function runTool(registration, handler, askFirst) {
    return async (parameters, invocationContext) => {
        const guard = createGuard(registration, invocationContext);
        try {
            guard.assert();
            if (askFirst && parameters?.userConfirmed !== true) {
                return { status: 'needs_confirmation', reason: 'Nothing was changed. Ask the user in chat first, then call again with userConfirmed set to true once their next message confirms.', askFirst };
            }
            return await handler(parameters, guard);
        } catch (error) {
            if (error?.code === 'ASSISTANT_CONTEXT_STALE' || error?.name === 'AbortError') {
                return { status: 'cancelled', reason: error?.message || 'The assistant tool call became stale or was cancelled.' };
            }
            if (['ASSISTANT_CONFLICT', 'PATHFINDER_ENTRY_CHANGED'].includes(error?.code)) return { status: 'conflict', reason: error.message };
            console.warn('[Neconyan] Assistant tool failed.', error);
            return { status: 'failure', error: error instanceof Error ? error.message : String(error) };
        }
    };
}

function jsonHeaders() {
    return { ...getRequestHeaders(), 'Content-Type': 'application/json' };
}

async function postJson(url, body) {
    const response = await fetch(url, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `${url} returned ${response.status}`);
    return payload;
}

function enqueueAssistantEdit(task) {
    const run = assistantEditChain.then(task);
    assistantEditChain = run.catch(() => {});
    return run;
}

async function confirmEdit(review, guard) {
    guard.assert();
    const result = await callGenericPopup(buildAssistantReview(review), POPUP_TYPE.CONFIRM, '', { wide: true, large: true });
    guard.assert();
    return result === POPUP_RESULT.AFFIRMATIVE;
}

function shortHash(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value)) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

async function postNotebook(route, body) {
    const response = await fetch(`/api/notebooks${route}`, {
        method: 'POST',
        headers: { ...jsonHeaders(), 'X-Neconyan-Account': getCurrentUserHandle() },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (payload && typeof payload === 'object' && typeof payload.status === 'string') return payload;
    return { status: 'failure', message: `Notes could not be reached (${response.status}). Nothing was saved.` };
}

function noteTool(kind) {
    return async (parameters, guard) => {
        const invocation = guard.invocation ?? {};
        const callId = `browser:${shortHash(`${invocation.account}:${invocation.chatId}`)}:${invocation.generation ?? 0}:${guard.callId}`;
        const args = { ...(parameters ?? {}) };
        const result = await postNotebook('/assistant/tool', { callId, tool: kind, args });
        guard.assert();
        if (result.status !== 'needs_approval' || !result.proposalId) return result;
        const proposal = await postNotebook('/assistant/proposal', { proposalId: result.proposalId, full: true });
        guard.assert();
        if (proposal.status !== 'success') return result;
        const diff = typeof proposal.before === 'string' && typeof proposal.after === 'string'
            ? formatDiff(proposal.before, proposal.after) : '';
        const choice = await callGenericPopup(buildNoteProposalReview({ summary: proposal.summary ?? result.summary, diff }),
            POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: 'Save change', cancelButton: 'Not now' });
        guard.assert();
        if (choice !== POPUP_RESULT.AFFIRMATIVE) {
            return { ...result, message: 'Not saved yet. The change is waiting under Notes > Assistant changes.' };
        }
        return postNotebook('/assistant/decide', { proposalId: result.proposalId, proposalHash: proposal.proposalHash, decision: 'allow' });
    };
}

function bookNames() {
    return Array.isArray(world_names) ? world_names.filter(name => typeof name === 'string' && name) : [];
}

function requireBook(name) {
    const book = requiredString({ name }, 'name');
    if (!bookNames().includes(book)) throw new Error(`Lorebook "${book}" is not available.`);
    return book;
}

function entryValues(bookData) {
    return Object.values(bookData?.entries ?? {}).filter(entry => entry && typeof entry === 'object');
}

function projectEntry(entry, includeContent = true) {
    return {
        uid: entry.uid,
        title: String(entry.comment ?? ''),
        label: String(entry.comment || entry.key?.[0] || ''),
        ...(includeContent ? { content: String(entry.content ?? '') } : {}),
        disabled: Boolean(entry.disable),
    };
}

function findBookEntry(bookData, uid) {
    const entry = entryValues(bookData).find(candidate => candidate.uid === uid);
    if (!entry || entry.agentBlacklisted) throw new Error(`Entry UID ${uid} was not found.`);
    return entry;
}

async function listLorebooks(_input, guard) {
    guard.assert();
    return { status: 'success', books: bookNames().map(name => ({ name })) };
}

async function listLorebookEntries(input, guard) {
    const book = requireBook(requiredString(input, 'book'));
    const data = await loadWorldInfo(book);
    guard.assert();
    if (!data) throw new Error(`Lorebook "${book}" could not be loaded.`);
    return { status: 'success', book, entries: entryValues(data).filter(entry => !entry.agentBlacklisted).map(entry => projectEntry(entry, false)) };
}

async function readLorebookEntry(input, guard) {
    const book = requireBook(requiredString(input, 'book'));
    const uid = parseUid(input?.uid);
    const data = await loadWorldInfo(book);
    guard.assert();
    if (!data) throw new Error(`Lorebook "${book}" could not be loaded.`);
    return { status: 'success', book, entry: projectEntry(findBookEntry(data, uid)) };
}

async function editLorebookEntry(input, guard) {
    const book = requireBook(requiredString(input, 'book'));
    const uid = parseUid(input?.uid);
    const field = requiredString(input, 'field');
    if (!editableLorebookFields.includes(field)) throw new Error(`Lorebook field "${field}" cannot be edited.`);
    const value = requiredString(input, 'value', { nonempty: false });
    const initialData = await loadWorldInfo(book);
    guard.assert();
    if (!initialData) throw new Error(`Lorebook "${book}" could not be loaded.`);
    const initialEntry = findBookEntry(initialData, uid);
    const before = projectEntry(initialEntry);
    if (own(input, 'expected')) {
        const expected = requireObject(input, 'expected');
        if (!own(expected, 'title') || !own(expected, 'content') || typeof expected.title !== 'string' || typeof expected.content !== 'string') {
            throw new Error('expected must contain exact string title and content fields.');
        }
        if (expected.title !== before.title || expected.content !== before.content) throw new AssistantConflictError('The supplied lorebook snapshot is already stale.');
    }
    const after = { ...before, [field]: value };
    if (before[field] === value) return { status: 'success', committed: false, book, entry: after };
    if (!await confirmEdit({ resource: 'lorebook', target: `${book} / ${uid}`, field, before: before[field], after: value }, guard)) {
        return { status: 'cancelled', reason: 'The edit was declined.' };
    }

    return enqueueAssistantEdit(async () => {
        guard.assert();
        const latestData = await loadWorldInfo(book);
        guard.assert();
        if (!latestData) throw new Error(`Lorebook "${book}" could not be loaded.`);
        const latest = projectEntry(findBookEntry(latestData, uid));
        if (latest.title !== before.title || latest.content !== before.content) throw new AssistantConflictError('The lorebook entry changed while the edit was waiting for its save turn.');
        const saved = await updateEntry(
            book,
            uid,
            field === 'content' ? value : undefined,
            field === 'title' ? value : undefined,
            { title: before.title, content: before.content },
            { allowDisabledExpected: true, exactExpected: true, signal: guard.signal, isCurrent: guard.isCurrent },
        );
        return { status: 'success', committed: true, refreshFailed: Boolean(saved?.refreshFailed) || !guard.isCurrent(), book, entry: after };
    });
}

function projectAgent(agent) {
    return {
        id: agent.id,
        name: String(agent.name ?? ''),
        description: String(agent.description ?? ''),
        prompt: String(agent.prompt ?? ''),
        tags: Array.isArray(agent.tags) ? [...agent.tags] : [],
        favorite: Boolean(agent.favorite),
        connectionProfile: String(agent.connectionProfile ?? ''),
        modelOverride: String(agent.modelOverride ?? ''),
    };
}

function requireAgentsReady() {
    if (!areAgentsLoaded()) throw new Error('The agent library is still loading.');
}

async function listAgents(_input, guard) {
    requireAgentsReady();
    guard.assert();
    return { status: 'success', agents: getAgents().map(agent => ({ id: agent.id, name: String(agent.name ?? '') })) };
}

async function readAgent(input, guard) {
    requireAgentsReady();
    const id = requiredString(input, 'id');
    const agent = getAgentById(id);
    guard.assert();
    if (!agent) throw new Error(`Agent "${id}" was not found.`);
    return { status: 'success', agent: projectAgent(agent) };
}

function liveConnectionProfileIds() {
    return new Set((extension_settings?.connectionManager?.profiles ?? [])
        .map(profile => profile?.id)
        .filter(id => typeof id === 'string' && id));
}

function validateAgentValue(field, value) {
    if (['name', 'description', 'prompt', 'modelOverride'].includes(field)) {
        if (typeof value !== 'string' || (field === 'name' && !value.trim())) throw new Error(`${field} must be a string.`);
        return value;
    }
    if (field === 'favorite') {
        if (typeof value !== 'boolean') throw new Error('favorite must be boolean.');
        return value;
    }
    if (field === 'tags') {
        if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string' || !tag.trim())) throw new Error('tags must be non-empty strings.');
        const tags = value.map(tag => tag.trim());
        if (new Set(tags).size !== tags.length) throw new Error('tags must contain unique values.');
        return tags;
    }
    if (field === 'connectionProfile') {
        if (typeof value !== 'string') throw new Error('connectionProfile must be a string.');
        const profile = value.trim();
        if (profile && !liveConnectionProfileIds().has(profile)) throw new Error(`Connection profile "${profile}" is not available.`);
        return profile;
    }
    throw new Error(`Agent field "${field}" cannot be edited.`);
}

function agentEditorOpen() {
    return [...document.querySelectorAll('#ica--editor, #pf--settings')]
        .some(editor => editor.getClientRects().length > 0 && getComputedStyle(editor).visibility !== 'hidden');
}

async function editAgent(input, guard) {
    requireAgentsReady();
    const { isAgentGenerationActive } = await import('./extensions/in-chat-agents/agent-runner.js');
    guard.assert();
    const assertEditable = () => {
        if (agentEditorOpen() || isAgentGenerationActive()) throw new Error('Finish the active agent run and close the agent editor before editing an agent from chat.');
    };
    assertEditable();
    const id = requiredString(input, 'id');
    const field = requiredString(input, 'field');
    if (!editableAgentFields.includes(field)) throw new Error(`Agent field "${field}" cannot be edited.`);
    const agent = getAgentById(id);
    if (!agent) throw new Error(`Agent "${id}" was not found.`);
    const value = validateAgentValue(field, input?.value);
    const before = clone(projectAgent(agent)[field]);
    if (valuesEqual(before, value)) return { status: 'success', committed: false, agent: projectAgent(agent) };
    if (!await confirmEdit({ resource: 'agent', target: id, field, before: reviewValue(before), after: reviewValue(value) }, guard)) {
        return { status: 'cancelled', reason: 'The edit was declined.' };
    }
    return enqueueAssistantEdit(async () => {
        guard.assert();
        assertEditable();
        const saved = await saveAgent(id, {
            isCurrent: guard.isCurrent,
            update: latest => {
                guard.assert();
                assertEditable();
                if (!latest || !valuesEqual(latest[field], before)) throw new AssistantConflictError('The agent changed while the edit was waiting for its save turn.');
                latest[field] = clone(validateAgentValue(field, value));
                return latest;
            },
        });
        if (!saved) throw new Error(`Agent "${id}" was not saved.`);
        const refreshFailed = !guard.isCurrent();
        if (!refreshFailed && typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            globalThis.dispatchEvent(new CustomEvent('neconyan:assistant-agent-updated', { detail: { id, field } }));
        }
        return { status: 'success', committed: true, refreshFailed, agent: projectAgent(saved) };
    });
}

function requirePresetApi(apiId) {
    const api = requiredString({ apiId }, 'apiId');
    if (!supportedPresetApis.has(api)) throw new Error(`Preset API "${api}" is not supported by assistant tools.`);
    return api;
}

function getPreset(apiId, name) {
    const manager = getPresetManager(apiId);
    if (!manager) throw new Error(`Preset manager "${apiId}" is not ready.`);
    const preset = manager.getCompletionPresetByName(name);
    if (!preset || typeof preset !== 'object') throw new Error(`Preset "${name}" was not found.`);
    return { manager, preset: clone(preset) };
}

function projectPreset(apiId, preset) {
    const result = {};
    for (const field of presetFields[apiId]) if (Object.hasOwn(preset, field)) result[field] = clone(preset[field]);
    return result;
}

function validatePresetValue(apiId, field, value, current) {
    if (!presetFields[apiId]?.has(field)) throw new Error(`Preset field "${field}" cannot be edited.`);
    if (Array.isArray(current)) {
        if (!Array.isArray(value) || value.some(item => typeof item !== 'number' || !Number.isSafeInteger(item))
            || value.length !== current.length || new Set(value).size !== value.length || value.some(item => !current.includes(item))) {
            throw new Error(`${field} must reorder the existing numeric sampler IDs.`);
        }
        return [...value];
    }
    if (typeof current === 'boolean') {
        if (typeof value !== 'boolean') throw new Error(`${field} must be boolean.`);
        return value;
    }
    if (typeof current === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
        if (integerPresetFields.has(field) && !Number.isSafeInteger(value)) throw new Error(`${field} must be an integer.`);
        const range = presetNumericRangesByApi[apiId]?.[field] ?? presetNumericRanges[field];
        if (range && (value < range[0] || value > range[1])) throw new Error(`${field} must be between ${range[0]} and ${range[1]}.`);
        return value;
    }
    if (typeof current === 'string') {
        if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
        return value;
    }
    throw new Error(`${field} has an unsupported preset value type.`);
}

async function listPresets(input, guard) {
    const apiId = requirePresetApi(requiredString(input, 'apiId'));
    const manager = getPresetManager(apiId);
    if (!manager) throw new Error(`Preset manager "${apiId}" is not ready.`);
    guard.assert();
    return { status: 'success', apiId, presets: manager.getAllPresets().map(name => ({ name })) };
}

async function readPreset(input, guard) {
    const apiId = requirePresetApi(requiredString(input, 'apiId'));
    const name = requiredString(input, 'name');
    const { preset } = getPreset(apiId, name);
    guard.assert();
    return { status: 'success', apiId, name, preset: projectPreset(apiId, preset) };
}

async function editPreset(input, guard) {
    const apiId = requirePresetApi(requiredString(input, 'apiId'));
    const name = requiredString(input, 'name');
    const field = requiredString(input, 'field');
    const { manager, preset: initial } = getPreset(apiId, name);
    if (manager.hasUnsavedChanges()) throw new Error('Save or discard the current preset fields before using an assistant edit.');
    if (!Object.hasOwn(initial, field)) throw new Error(`Preset field "${field}" is not present in this preset.`);
    const value = validatePresetValue(apiId, field, input?.value, initial[field]);
    const before = clone(initial[field]);
    if (valuesEqual(before, value)) return { status: 'success', committed: false, apiId, name, preset: projectPreset(apiId, initial) };
    if (!await confirmEdit({ resource: 'model preset', target: `${apiId} / ${name}`, field, before: reviewValue(before), after: reviewValue(value) }, guard)) {
        return { status: 'cancelled', reason: 'The edit was declined.' };
    }

    return enqueueAssistantEdit(async () => {
        guard.assert();
        if (manager.hasUnsavedChanges()) throw new Error('Save or discard the current preset fields before using an assistant edit.');
        const { preset: latest } = getPreset(apiId, name);
        if (!valuesEqual(latest[field], before)) throw new AssistantConflictError('The preset changed while the edit was waiting for its save turn.');
        const updated = clone(latest);
        updated[field] = clone(value);
        await manager.savePreset(name, updated, { select: false, isCurrent: guard.isCurrent });
        let refreshFailed = !guard.isCurrent();
        try {
            if (!refreshFailed && manager.getSelectedPresetName() === name) await manager.selectPreset(manager.findPreset(name));
        } catch (error) {
            refreshFailed = true;
            console.warn('[Neconyan] Preset UI refresh failed after a committed assistant edit.', error);
        }
        return { status: 'success', committed: true, refreshFailed, apiId, name, preset: projectPreset(apiId, updated) };
    });
}

function projectCharacter(character) {
    const result = { avatar: String(character.avatar || '') };
    for (const field of editableCharacterFields) {
        const value = character.data?.[field] ?? character[field];
        if (value !== undefined) result[field] = String(value ?? '');
    }
    return result;
}

function requireKnownAvatar(avatar) {
    const normalized = requiredString({ avatar }, 'avatar');
    if (!characters.some(character => character?.avatar === normalized)) throw new Error(`Character "${normalized}" is not available.`);
    return normalized;
}

async function refreshCharacter(avatar, guard) {
    if (await flushCharacterSaveDebounced() === false) throw new Error('The current character has an unsaved edit that could not be saved.');
    guard.assert();
    const loaded = await getOneCharacter(avatar, { isCurrent: guard.isCurrent });
    guard.assert();
    if (loaded === false) throw new Error(`Character "${avatar}" could not be read.`);
    const character = characters.find(candidate => candidate?.avatar === avatar);
    if (!character) throw new Error(`Character "${avatar}" could not be read.`);
    return character;
}

async function listCharacters(_input, guard) {
    guard.assert();
    return { status: 'success', characters: characters.filter(character => character?.avatar).map(character => ({ avatar: character.avatar, name: String(character.data?.name ?? character.name ?? '') })) };
}

async function readCharacter(input, guard) {
    const avatar = requireKnownAvatar(requiredString(input, 'avatar'));
    const character = await refreshCharacter(avatar, guard);
    guard.assert();
    return { status: 'success', character: projectCharacter(character) };
}

async function createCharacter(input, guard) {
    const card = requireObject(input, 'character');
    const name = requiredString(card, 'name').trim();
    if (name.length > 200 || /[\\/\x00-\x1f]/.test(name) || /^\.+$/.test(name)) throw new Error('Use a character name of 1–200 characters without path separators.');
    const fields = {};
    for (const [key, value] of Object.entries(card)) {
        if (!editableCharacterFields.includes(key) || typeof value !== 'string' || value.length > 100000) throw new Error(`Invalid character field: ${key}`);
        fields[key] = value;
    }
    fields.name = name;
    // An empty or null prompt means "no generated avatar": the server then uses the default Neconyan picture.
    const avatarPrompt = typeof input.avatarPrompt === 'string' ? input.avatarPrompt.trim() : '';
    if (avatarPrompt.length > 10000) throw new Error('The avatar prompt is too long.');
    const characterNote = typeof input.characterNote === 'string' ? input.characterNote : '';
    if (characterNote.length > 100000) throw new Error('The character note is too long.');
    const alternateGreetings = input.alternateGreetings ?? [];
    if (!Array.isArray(alternateGreetings) || alternateGreetings.length > 20 || alternateGreetings.some(greeting => typeof greeting !== 'string' || greeting.length > 100000)) throw new Error('alternateGreetings must be a list of up to 20 strings.');
    if (!await confirmEdit({ resource: 'new character', target: name, field: 'Character and optional generated avatar', before: '', after: JSON.stringify({ ...fields, characterNote, alternateGreetings, avatarPrompt }, null, 2) }, guard)) {
        return { status: 'cancelled', reason: 'Character creation was declined.' };
    }
    let image = null;
    if (avatarPrompt) {
        const qig = getExtensionCapability('quick-image-gen');
        if (!qig?.generateImage) throw new Error('Enable Quick Image Gen and configure an image provider first.');
        const entry = await qig.generateImage(avatarPrompt, '', { character: { ...fields, data: fields }, characterName: name, signal: guard.signal });
        guard.assert();
        if (!entry?.url) throw new Error('Quick Image Gen returned no avatar.');
        const url = new URL(entry.url, location.href);
        if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== location.origin) throw new Error('Quick Image Gen must return a local image.');
        const response = await fetch(url.href, { signal: guard.signal });
        if (!response.ok) throw new Error('The generated avatar could not be loaded.');
        image = await response.blob();
        if (!/^image\/(png|jpeg|webp)$/.test(image.type) || image.size > 20 * 1024 * 1024) throw new Error('The generated avatar must be a PNG, JPEG or WebP under 20 MiB.');
    }
    return enqueueAssistantEdit(async () => {
        guard.assert();
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.set(key === 'name' ? 'ch_name' : key, value);
        if (characterNote) {
            form.set('depth_prompt_prompt', characterNote);
            form.set('depth_prompt_depth', '4');
            form.set('depth_prompt_role', 'system');
        }
        for (const greeting of alternateGreetings) form.append('alternate_greetings', greeting);
        if (image) form.set('avatar', image, 'avatar.' + image.type.split('/')[1]);
        // Let the existing creation endpoint allocate a fresh filename; never overwrite a card.
        const headers = new Headers(getRequestHeaders());
        headers.delete('Content-Type');
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        const avatar = await response.text();
        if (!response.ok) throw new Error('Character creation failed: ' + response.status);
        let refreshFailed = !guard.isCurrent();
        if (!refreshFailed) {
            try {
                refreshFailed = await getOneCharacter(avatar, { isCurrent: guard.isCurrent, allowInsert: true }) === false;
                printCharactersDebounced();
            } catch { refreshFailed = true; }
        }
        return { status: 'success', committed: true, avatar, name, generatedAvatar: Boolean(image), refreshFailed };
    });
}

async function editCharacter(input, guard) {
    const avatar = requireKnownAvatar(requiredString(input, 'avatar'));
    const field = requiredString(input, 'field');
    if (!editableCharacterFields.includes(field)) throw new Error(`Character field "${field}" cannot be edited.`);
    const rawValue = requiredString(input, 'value', { nonempty: false });
    const value = field === 'name' ? rawValue.trim() : rawValue;
    if (field === 'name' && !value) throw new Error('Character name must not be empty.');
    const initialCharacter = await refreshCharacter(avatar, guard);
    guard.assert();
    const before = projectCharacter(initialCharacter);
    if (!Object.hasOwn(before, field)) throw new Error(`Character field "${field}" is not present.`);
    const assistantId = initialCharacter.data?.extensions?.neconyan_assistant?.id;
    if (before[field] === value) return { status: 'success', committed: false, character: before };
    if (!await confirmEdit({ resource: 'character', target: avatar, field, before: before[field], after: value }, guard)) {
        return { status: 'cancelled', reason: 'The edit was declined.' };
    }

    return enqueueAssistantEdit(async () => {
        guard.assert();
        const latestCharacter = await refreshCharacter(avatar, guard);
        guard.assert();
        const latest = projectCharacter(latestCharacter);
        if (latest[field] !== before[field] || latestCharacter.data?.extensions?.neconyan_assistant?.id !== assistantId) throw new AssistantConflictError('The character changed while the edit was waiting for its save turn.');
        await postJson('/api/characters/edit-attribute', { avatar_url: avatar, ch_name: latest.name, field, value });
        let refreshed = { ...latest, [field]: value };
        const form = document.getElementById?.('form_create');
        const editingTarget = () => currentCharacter()?.avatar === avatar && form?.getAttribute('actiontype') === 'editcharacter' && form.getClientRects().length > 0;
        const dirtyEditor = () => editingTarget() && ['unsaved', 'saving', 'error'].includes(document.getElementById('sb_character_save_status')?.dataset.saveStatus);
        let refreshFailed = !guard.isCurrent() || Boolean(dirtyEditor());
        try {
            if (!refreshFailed) {
                const loaded = await getOneCharacter(avatar, { isCurrent: guard.isCurrent });
                refreshFailed = loaded === false || !guard.isCurrent();
                if (!refreshFailed) {
                    const index = characters.findIndex(character => character?.avatar === avatar);
                    const character = characters[index];
                    refreshed = projectCharacter(character);
                    await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id: index, character } });
                    refreshFailed = !guard.isCurrent() || Boolean(dirtyEditor());
                    if (!refreshFailed) {
                        printCharactersDebounced();
                        if (editingTarget()) select_selected_character(index, { switchMenu: false });
                    }
                }
            }
        } catch (error) {
            refreshFailed = true;
            console.warn('[Neconyan] Character UI refresh failed after a committed assistant edit.', error);
        }
        return { status: 'success', committed: true, refreshFailed, character: refreshed };
    });
}

function register(name, displayName, description, parameters, registration, action, askFirst) {
    if (askFirst) {
        description = `${description} ${CONFIRM_PROTOCOL}`;
        parameters = {
            ...parameters,
            required: [...(parameters.required ?? []), 'userConfirmed'],
            properties: { ...parameters.properties, userConfirmed: { type: 'boolean', description: USER_CONFIRMED_DESCRIPTION } },
        };
    }
    ToolManager.registerFunctionTool({
        name,
        displayName,
        description,
        parameters,
        action: runTool(registration, action, askFirst),
        shouldRegister: () => isRegistrationCurrent(registration),
        stealth: false,
    });
    registeredTools.add(name);
}

function registerAll(registration) {
    const book = { type: 'string', description: 'Exact lorebook name.' };
    const uid = { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'string', pattern: '^\\d+$' }] };
    const agentId = { type: 'string', description: 'Exact agent ID.' };
    const apiId = { type: 'string', enum: [...supportedPresetApis] };
    const preset = { type: 'string', description: 'Exact preset name.' };
    const avatar = { type: 'string', description: 'Exact known character avatar filename.' };
    const field = values => ({ type: 'string', enum: values });

    register(`${TOOL_PREFIX}ListLorebooks`, 'List lorebooks', 'List real lorebooks in the current profile.', { type: 'object', properties: {} }, registration, listLorebooks);
    register(`${TOOL_PREFIX}ListLorebookEntries`, 'List lorebook entries', 'List readable entries, including ordinary disabled entries.', { type: 'object', required: ['book'], properties: { book } }, registration, listLorebookEntries);
    register(`${TOOL_PREFIX}ReadLorebookEntry`, 'Read lorebook entry', 'Read one readable lorebook entry by exact UID.', { type: 'object', required: ['book', 'uid'], properties: { book, uid } }, registration, readLorebookEntry);
    register(`${TOOL_PREFIX}EditLorebookEntry`, 'Edit lorebook entry', 'Edit exactly one lorebook title or content field after review.', { type: 'object', required: ['book', 'uid', 'field', 'value'], properties: { book, uid, field: field(editableLorebookFields), value: { type: 'string' }, expected: { type: 'object' } } }, registration, editLorebookEntry, ASK_FIRST.editLorebookEntry);
    register(`${TOOL_PREFIX}ListAgents`, 'List in-chat agents', 'List the current profile in-chat agents.', { type: 'object', properties: {} }, registration, listAgents);
    register(`${TOOL_PREFIX}ReadAgent`, 'Read in-chat agent', 'Read one in-chat agent by exact ID.', { type: 'object', required: ['id'], properties: { id: agentId } }, registration, readAgent);
    register(`${TOOL_PREFIX}EditAgent`, 'Edit in-chat agent', 'Edit exactly one safe agent field after review.', { type: 'object', required: ['id', 'field', 'value'], properties: { id: agentId, field: field(editableAgentFields), value: {} } }, registration, editAgent, ASK_FIRST.editAgent);
    register(`${TOOL_PREFIX}ListModelPresets`, 'List model presets', 'List supported saved model presets without connection secrets.', { type: 'object', required: ['apiId'], properties: { apiId } }, registration, listPresets);
    register(`${TOOL_PREFIX}ReadModelPreset`, 'Read model preset', 'Read only safe editable fields from one model preset.', { type: 'object', required: ['apiId', 'name'], properties: { apiId, name: preset } }, registration, readPreset);
    register(`${TOOL_PREFIX}EditModelPreset`, 'Edit model preset', 'Edit exactly one safe model preset field after review.', { type: 'object', required: ['apiId', 'name', 'field', 'value'], properties: { apiId, name: preset, field: { type: 'string' }, value: {} } }, registration, editPreset, ASK_FIRST.editModelPreset);
    register(`${TOOL_PREFIX}ListCharacters`, 'List characters', 'List known character records by safe fields.', { type: 'object', properties: {} }, registration, listCharacters);
    register(`${TOOL_PREFIX}CreateCharacter`, 'Create character', CREATE_CHARACTER_GUIDE, { type: 'object', required: ['character'], additionalProperties: false, properties: {
        character: { type: 'object', required: ['name'], additionalProperties: false, properties: Object.fromEntries(editableCharacterFields.map(key => [key, { type: 'string' }])) },
        characterNote: { type: 'string', description: 'Character Note text (the PList in the recommended format). Stored at depth 4 with the system role.' },
        alternateGreetings: { type: 'array', items: { type: 'string' }, description: 'Extra greetings after first_mes; the recommended format uses three.' },
        avatarPrompt: { type: 'string', description: 'Quick Image Gen prompt for the avatar. Omit it or leave it empty to use the default Neconyan picture.' },
    } }, registration, createCharacter, ASK_FIRST.createCharacter);
    register(`${TOOL_PREFIX}ReadCharacter`, 'Read character', 'Read one known character by exact avatar filename.', { type: 'object', required: ['avatar'], properties: { avatar } }, registration, readCharacter);
    // ponytail: the Character Note is not editable here because /api/characters/edit-attribute only writes flat fields; add a dedicated route if that is ever needed.
    register(`${TOOL_PREFIX}EditCharacter`, 'Edit character', 'Edit exactly one safe character field after review.', { type: 'object', required: ['avatar', 'field', 'value'], properties: { avatar, field: field(editableCharacterFields), value: { type: 'string' } } }, registration, editCharacter, ASK_FIRST.editCharacter);
    for (const [name, definition] of Object.entries(NOTE_TOOL_DEFINITIONS)) {
        register(`${TOOL_PREFIX}${name}`, definition.displayName, definition.description, definition.schema, registration, noteTool(definition.kind));
    }
}

export function unregisterNeconyanAssistantTools() {
    for (const name of registeredTools) ToolManager.unregisterFunctionTool(name);
    registeredTools.clear();
    activeRegistration = null;
    registrationRevision++;
}

/** Registers tools only for the active individual-chat assistant card metadata. */
export function registerNeconyanAssistantTools() {
    const context = getActiveAssistantContext();
    if (!context) {
        unregisterNeconyanAssistantTools();
        return false;
    }
    if (activeRegistration && contextKey(activeRegistration) === contextKey(context)) return true;
    unregisterNeconyanAssistantTools();
    const registration = { ...context, revision: ++registrationRevision };
    activeRegistration = registration;
    registerAll(registration);
    return true;
}

export function syncNeconyanAssistantTools() {
    return registerNeconyanAssistantTools();
}
