import { generationBlockedNotice } from '../generation-outcome-ui.js';
/**
 * Submit, observe and read back the server's named Roleplay workflows.
 *
 * Ordinary replies use browser generation. Controls that require a saved-message
 * transaction, or an explicit background caller, name one server workflow and
 * hand over only what the user typed or what a saved extension had already written
 * down, and then observe the accepted
 * job. The durable write is the server's; the browser reloads the chat it wrote
 * and adopts the result facts it needs for its own bookkeeping.
 *
 * A submission that loses its response keeps its key, so the same request replays
 * instead of paying twice, and a reopened page reattaches to the accepted job and
 * reads its permanent receipt back rather than submitting anything again.
 */
import { activateSendButtons, chat, chat_metadata, deactivateSendButtons, extension_prompts, getActiveGenerationAcknowledgement, getCurrentChatId, getRequestHeaders, isChatSaving, isGenerating, keepChatReadingPositionOnNextLoad, refreshCurrentChatFromSaved, saveChatConditional, saveSettings, setRoleplayJobControls, substituteParams, willRunNativeRoleplayWorkflow } from '../../script.js';
import { event_types, eventSource } from '../events.js';
import { activeGenerationInterceptors, extension_settings } from '../extensions.js';
import { COMPANION_HISTORY_PROMPT_KEY_PREFIX } from '../extensions/in-chat-agents/companion/companion-shared.js';
import { selected_group } from '../group-chats.js';
import { cancelJob, listJobs, observeJob, TERMINAL } from '../jobs.js';
import { MacroRegistry } from '../macros/engine/MacroRegistry.js';
import { readBrowserMacros } from '../extensions/third-party/MacroEnhanced/src/custom/browser-store.js';
import { roleplayAccountStamp } from '../roleplay-save-chain.js';
import { getCurrentUserHandle } from '../user.js';
import { getCurrentCharAvatar } from './context.js';
import { getRoleplaySourceMessageRevision } from './roleplay-source.js';
import { beginRoleplayReplacement } from './roleplay-replacement.js';
import { withAbortSignal } from '../abort.js';
import { imageInputIssueDetail, isImageInputIssue, roleplayImageOrigin } from '../prompt-media-policy.js';

const WORKFLOW_EVENT = 'neconyan:roleplay-workflow-finished';
const IMAGE_REFUSED_EVENT = 'neconyan:image-input-refused';
const RECONNECT_REASON = Symbol('roleplay-receipt-reconnect');
const STORY_RULES_KEY = 'sbstory_rules';
const STORY_DIRECTION_KEY = 'sbstory_direction';
const STORY_RULES_DEPTH = 1;
const STORY_DIRECTION_DEPTH = 0;

const observed = new Map();
const pending = new Map();
const waiters = new Map();
const adopted = new Map();
const reading = new Map();
let busyName = null;
let currentJobId = null;
let activeReload = null;
let activeDiscovery = null;

function syncJobControls() {
    const entry = [...observed.entries()].find(([, value]) => value.isCurrent());
    setRoleplayJobControls(entry?.[0] ?? null, entry ? () => {
        void cancelJob(entry[0], { account: entry[1].account, reason: 'user_cancelled' }).catch(() => {});
    } : null);
}

/**
 * One DEBUG line per accepted submission, naming the workflow the server owns.
 * Browsers hide DEBUG output behind the devtools filter by default, which is
 * the wanted behaviour for lines the ordinary user never needs to see.
 */
function logRoleplayAccepted(name) {
    console.debug('Roleplay workflow accepted', { name });
}

/** One DEBUG line per refusal, naming the single condition that refused it. */
function logRoleplayRefusal(fields) {
    console.debug('Roleplay workflow refused', fields);
}

/**
 * One promise per accepted key, resolved by whichever path reaches the durable
 * write first: the job observer or the receipt readback. A caller that must not
 * continue until the write is durable (Story Mode records its cut from the saved
 * result) waits on this, so the host generation call resolves after the reload.
 */
function awaitFinished(key) {
    let settled = null;
    const promise = new Promise(resolve => { settled = resolve; });
    const set = waiters.get(key) ?? new Set();
    set.add(settled);
    waiters.set(key, set);
    return promise;
}

function settleFinished(key, receipt) {
    const set = waiters.get(key);
    if (!set) return;
    waiters.delete(key);
    for (const resolve of set) resolve(receipt);
}

/** The named vocabulary a control may ask for. The server owns the mapping. */
export const ROLEPLAY_WORKFLOW_NAMES = Object.freeze([
    'roleplay.reply', 'roleplay.continue', 'roleplay.swipe', 'roleplay.correct',
    'story.passage', 'guided.response', 'guided.swipe', 'guided.regenerate', 'guided.correction',
    'deep-swipe.reply', 'deep-swipe.user',
]);

/**
 * Which message each named workflow answers, mirroring the server's own anchor.
 * The browser resolves the index so the server's independent derivation agrees:
 * a reply answers the whole chat including the user message just written, a
 * continuation answers the last block whoever wrote it (the host continues the
 * composer text it just added), a swipe or a correction answers the last model
 * message, and a Deep Swipe answers the message the user chose.
 */
export const ROLEPLAY_WORKFLOW_ANCHORS = Object.freeze({
    'roleplay.reply': 'end', 'roleplay.continue': 'block', 'roleplay.swipe': 'assistant',
    'roleplay.correct': 'assistant', 'story.passage': 'block',
    'guided.response': 'end', 'guided.swipe': 'assistant', 'guided.regenerate': 'assistant', 'guided.correction': 'assistant',
    'deep-swipe.reply': 'chosen', 'deep-swipe.user': 'chosen',
});

/**
 * A named workflow is only possible for one protected solo chat with a saved
 * connection. Anything else (a group turn, an unbound account, a quiet or
 * impersonation generation) has no server workflow and must not pretend to have one.
 */
export function isNativeRoleplayWorkflowReady() {
    try {
        roleplayAccountStamp();
    } catch {
        return false;
    }
    const locator = currentLocator();
    return Boolean(locator?.chat && locator.avatar);
}

function currentLocator() {
    const chatName = String(getCurrentChatId() || '').replace(/\.jsonl$/, '');
    const avatar = String(getCurrentCharAvatar() || '');
    if (!chatName || !avatar) return null;
    return { chat: chatName, avatar, group: false };
}

function matchesCurrentWorkflowLocator(locator) {
    if (!locator || String(getCurrentChatId() || '').replace(/\.jsonl$/, '') !== locator.chat) return false;
    // Sending a group message temporarily selects its speaker. That is still a
    // group chat, so the speaker's avatar must not block its saved reply readback.
    if (locator.group) return Boolean(selected_group) && String(selected_group) === locator.groupId;
    return !selected_group && currentLocator()?.avatar === locator.avatar;
}

/** The last block the host would continue, whoever wrote it, skipping hidden system blocks. */
export function finalBlockMessageIndex() {
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        if (chat[index]?.is_system !== true) return index;
    }
    return null;
}

/** The saved chat's own final model message, which is what a swipe or correction answers. */
export function finalModelMessageIndex() {
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];
        if (message?.is_user !== true && message?.role !== 'user' && message?.is_system !== true) return index;
    }
    return null;
}

function messageRevisionAt(index) {
    const message = chat[index];
    if (!message) throw new Error('The message this workflow answers is no longer in the chat.');
    return getRoleplaySourceMessageRevision(message);
}

/**
 * Resolve the page's macros in text a control hands over, as the browser prompt
 * would have. Returns null when a macro survives, so the caller keeps its own path.
 */
export function resolvePageText(value) {
    const text = String(substituteParams(String(value ?? '')) ?? '').trim();
    return text.includes('{{') ? null : text;
}

function pagePromptText(key) {
    const value = extension_prompts[key]?.value;
    if (typeof value !== 'string' || !value.trim()) return '';
    return String(substituteParams(value) ?? '').trim();
}

/** The Story Mode prompt the page carries right now, if Story Mode is shaping this chat. */
function storyPrompt() {
    const rules = pagePromptText(STORY_RULES_KEY);
    if (!rules || rules.includes('{{')) return null;
    const direction = pagePromptText(STORY_DIRECTION_KEY);
    return { rules, rulesDepth: STORY_RULES_DEPTH,
        direction: direction.includes('{{') ? '' : direction,
        directionDepth: STORY_DIRECTION_DEPTH };
}

/** Prompts the server rebuilds itself from the saved chat, card, persona and lorebooks. */
const SERVER_PROMPT_KEYS = new Set(['2_floating_prompt', 'PERSONA_DESCRIPTION', '__STORY_STRING__', 'QUIET_PROMPT', '3_vectors', '4_vectors_data_bank']);
const SERVER_PROMPT_PREFIXES = ['DEPTH_PROMPT', 'customDepthWI', 'customWIOutlet_', COMPANION_HISTORY_PROMPT_KEY_PREFIX];
/** Prompts written by work the server decides itself; text from them has no faithful page copy. */
const POLICY_PROMPT_PREFIXES = ['inchat_agent_', 'pathfinder_'];
const PAGE_KEY = /^[a-zA-Z0-9_-]{1,120}$/;
const PAGE_ROLES = ['system', 'user', 'assistant'];
const MAX_PAGE_PROMPTS = 32;
const MAX_PAGE_BYTES = 120 * 1024;
const SETTINGS_PROOF_ATTEMPTS = 10;

/**
 * The prompt additions only this page knows about (a Dialogue Colours instruction,
 * a /inject note, a summary), resolved exactly as the browser prompt would have
 * used them. The server rebuilds everything else itself. Returns null when any
 * addition cannot be carried faithfully, so the caller keeps the browser path
 * instead of silently generating without it. Each refusal logs one DEBUG line
 * naming the workflow and the refusing condition; a caller that is only probing
 * the decision can pass a collector to take the reason instead of a log line.
 */
export async function capturePagePrompts(name, collector = null) {
    const refuse = label => {
        if (typeof collector === 'function') collector(label);
        else logRoleplayRefusal({ name, reason: label });
        return null;
    };
    for (const interceptor of activeGenerationInterceptors()) {
        if (interceptor.key === 'DialogueColorsInterceptor') {
            if (await dialogueColorsReady()) await globalThis[interceptor.key]([], 0, () => {}, 'normal');
            continue;
        }
        if (interceptor.key === 'vectors_rearrangeChat') {
            continue;
        }
        return refuse('interceptor');
    }
    const page = [];
    let bytes = 0;
    for (const key of Object.keys(extension_prompts).sort()) {
        const entry = extension_prompts[key];
        if (!entry || typeof entry.value !== 'string' || !entry.value.trim()) continue;
        if (Number(entry.position) === -1) continue;
        if (SERVER_PROMPT_KEYS.has(key) || SERVER_PROMPT_PREFIXES.some(prefix => key.startsWith(prefix))) continue;
        if (name === 'story.passage' && (key === STORY_RULES_KEY || key === STORY_DIRECTION_KEY)) continue;
        if (POLICY_PROMPT_PREFIXES.some(prefix => key.startsWith(prefix))) return refuse('policy-prefix');
        if (entry.scan) return refuse('scan');
        if (typeof entry.filter === 'function') {
            try {
                if (!await entry.filter()) continue;
            } catch {
                return refuse('filter-error');
            }
        }
        const content = pagePromptText(key);
        if (!content) continue;
        const position = Number(entry.position);
        const depth = Number(entry.depth ?? 0);
        const role = PAGE_ROLES[Number(entry.role ?? 0)];
        if (content.includes('{{')) return refuse('macro');
        if (!PAGE_KEY.test(key)) return refuse('key');
        if (![0, 1, 2].includes(position)) return refuse('position');
        if (!Number.isSafeInteger(depth) || depth < 0 || depth > 10000) return refuse('depth');
        if (!role) return refuse('role');
        bytes += new TextEncoder().encode(content).length;
        page.push({ key, content, position, depth, role });
        if (page.length > MAX_PAGE_PROMPTS || bytes > MAX_PAGE_BYTES) return refuse('size');
    }
    return page;
}

const SCRIPT_INJECT_PREFIX = 'script_inject_';

/**
 * A reopened chat can hold a saved /inject before the page has materialized it
 * as an extension prompt. Materialized injects are judged by
 * capturePagePrompts; this covers the entries it cannot see yet.
 */
export function hasUnmaterializedPageInjections() {
    const injects = chat_metadata?.script_injects;
    if (!injects || typeof injects !== 'object' || Array.isArray(injects)) return false;
    return Object.entries(injects).some(([id, inject]) => {
        if (!inject || typeof inject.value !== 'string' || !inject.value.trim()) return false;
        if (Number(inject.position) === -1) return false;
        return !extension_prompts[`${SCRIPT_INJECT_PREFIX}${id}`];
    });
}

/**
 * A group server turn has no page-prompt payload, so any page addition keeps the
 * browser in charge. Returns true when the page has an addition that would
 * otherwise be lost.
 */
export async function groupPagePromptsBlocked(collector = null) {
    const page = await capturePagePrompts('group.reply', collector);
    if (!Array.isArray(page)) return true;
    return page.length > 0 || hasUnmaterializedPageInjections();
}

const DIALOGUE_COLORS_EXTENSION = 'sillytavern-character-colors';

async function dialogueColorsReady() {
    const disabled = (extension_settings.disabledExtensions ?? [])
        .some(name => String(name).replace(/^third-party\//, '') === DIALOGUE_COLORS_EXTENSION);
    if (disabled) return false;
    // The bootstrap publishes this guard before loading the saved settings.
    const runtime = globalThis.__dialogueColorsRuntime_v1;
    if (!runtime && typeof globalThis.DialogueColorsInterceptor !== 'function') return false;
    await runtime?.ready;
    if (!runtime?.initialized) throw new Error('Dialogue Colors did not finish loading. Reload the page before trying again.');
    return true;
}

let dialogueColorsModule = null;

function loadDialogueColorsModule() {
    dialogueColorsModule ??= import('../extensions/third-party/sillytavern-character-colors/src/main.js').catch(error => {
        dialogueColorsModule = null;
        throw error;
    });
    return dialogueColorsModule;
}

/** Resolve the already-running extension's module early; a busy page can delay a fresh import by a few hundred milliseconds at send time. */
function prewarmDialogueColorsModule() {
    if (!globalThis.__dialogueColorsRuntime_v1?.initialized) return;
    void loadDialogueColorsModule().catch(() => {});
}

/** Capture the loaded extension's real macro, after its saved settings are ready. */
async function loadedDialogueColorsMacro() {
    if (!await dialogueColorsReady()) return '';
    const { resolveDialogueColorsMacro } = await loadDialogueColorsModule();
    const value = resolveDialogueColorsMacro();
    if (typeof value !== 'string') throw new Error('Dialogue Colors could not prepare its prompt instruction.');
    return value;
}

/** The optional page-captured bundled macros that travel with one submission. */
export async function captureBundledMacros() {
    return { dialoguecolors: await loadedDialogueColorsMacro() };
}

const BROWSER_MACRO_NAME = /^[a-zA-Z][\w-]*$/;
const MAX_BROWSER_MACRO_NAME_LENGTH = 512;
const MAX_BROWSER_MACROS = 512;

/**
 * The names of stored browser macros and custom macros currently registered.
 * The registry lists primaries and their `me-` aliases as separate entries, so a
 * name the prompt can use is a name the server must refuse. Only names travel:
 * a template or its output would be page-private text and never leaves here.
 * Reading the pure storage module also covers a disabled experimental parser,
 * without loading any extension UI or DOM code.
 */
export function captureBrowserMacros() {
    const names = [];
    const seen = new Set();
    const add = value => {
        if (typeof value !== 'string') return;
        const name = value.trim().toLowerCase();
        if (!name || name.length > MAX_BROWSER_MACRO_NAME_LENGTH || !BROWSER_MACRO_NAME.test(name) || seen.has(name) || names.length >= MAX_BROWSER_MACROS) return;
        seen.add(name);
        names.push(name);
    };
    for (const macro of readBrowserMacros({ account: getCurrentUserHandle() })) {
        if (macro.enabled === false) continue;
        add(macro.name);
        add(`me-${macro.name}`);
    }
    for (const macro of MacroRegistry.getAllMacros()) {
        if (macro?.category === 'enhanced-custom') add(macro.name);
    }
    return names;
}

/** The one place that turns a generation type into the named workflow the server owns. */
export function roleplayWorkflowNameFor(type, { quiet = false } = {}) {
    if (quiet) return null;
    if (type === 'normal') return 'roleplay.reply';
    if (type === 'swipe') return 'roleplay.swipe';
    if (type === 'regenerate') return 'roleplay.correct';
    if (type === 'continue') return storyPrompt() ? 'story.passage' : 'roleplay.continue';
    return null;
}

function workflowIntent(name) {
    return name === 'story.passage' ? { prompt: storyPrompt() } : {};
}

function createKey(name) {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `roleplay-workflow:${name}:${random}`;
}

async function postSubmission(payload, account, url = '/api/roleplay/workflow/submit') {
    const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json', 'X-Neconyan-Account': account },
        body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    if (account !== getCurrentUserHandle()) throw new Error('account_changed');
    // One notice for an image refusal, whichever route asked (see showImageChoiceNotice in prompt-media-ui.js); callers show no second toast.
    // Its origin is the chat this request was for (payload.source.locator), not the chat open when the refusal arrives.
    if (!response.ok && isImageInputIssue(body)) globalThis.dispatchEvent(new CustomEvent(IMAGE_REFUSED_EVENT, { detail: imageInputIssueDetail(body, roleplayImageOrigin(payload.source?.locator, account)) }));
    if (!response.ok) throw Object.assign(new Error(body?.error || `The ${payload.name} workflow was refused (${response.status}).`), { status: response.status, body });
    return body;
}

async function readReceipt(key, account, signal) {
    const response = await withAbortSignal(fetch(`/api/roleplay/workflow/receipt?key=${encodeURIComponent(key)}`, {
        credentials: 'same-origin',
        headers: { ...getRequestHeaders(), 'X-Neconyan-Account': account },
        signal,
    }), signal);
    const body = await withAbortSignal(
        response.json().catch(error => {
            if (signal?.aborted) throw signal.reason ?? error;
            return null;
        }),
        signal,
    );
    signal?.throwIfAborted();
    if (account !== getCurrentUserHandle()) throw new Error('account_changed');
    if (!response.ok) throw Object.assign(new Error(body?.error || 'The workflow receipt could not be read.'), { status: response.status, body });
    return body;
}

function announce(detail) {
    globalThis.dispatchEvent(new CustomEvent(WORKFLOW_EVENT, { detail }));
}

function reconnectReading(entry) {
    if (!entry || entry.settled || !entry.controller || entry.controller.signal.aborted) return;
    entry.controller.abort(RECONNECT_REASON);
}

/**
 * The readback of one accepted workflow: the receipt is the authority, the chat is
 * reloaded from the server that wrote it, and the named control adopts its facts.
 * A receipt that is not closed yet is retried, never resubmitted.
 */
function readback(key, name, options) {
    const id = JSON.stringify([options.account, key]);
    const existing = reading.get(id);
    if (existing) {
        if (!options.passive) existing.options.passive = false;
        if (options.reconnect) reconnectReading(existing);
        return existing.promise;
    }
    if (adopted.has(id)) {
        const receipt = adopted.get(id);
        settleFinished(key, receipt);
        return Promise.resolve(receipt);
    }
    const shared = { options: { ...options }, controller: null, settled: false };
    shared.promise = readbackReceipt(key, name, shared, id).finally(() => reading.delete(id));
    reading.set(id, shared);
    return shared.promise;
}

/**
 * Where the live reply sits on screen, so saving it does not move the page.
 * The saved reply's own text keeps its place, so a taller saved header cannot
 * shift it; the row above remains a fallback for a window that does not render
 * the reply yet. A group receipt names the final saved speaker, so its last
 * row is anchored only when the preview still shows that same child. An
 * incomplete group preview falls back to the preceding row instead of
 * applying unsaved preview text to the first saved speaker.
 * @param {{result?: {childJobId?: string, speakers?: Array<object>}|null}|null} [receipt] Saved workflow receipt, when one is available.
 * @returns {{messageId: string|number, offsetTop: number, part: string|null, fallback: {messageId: string|number, offsetTop: number}|null}|null}
 */
export function finishedReplyReadingAnchor(receipt = null) {
    const chatNode = globalThis.document?.querySelector?.('#chat');
    const preview = chatNode?.querySelector('#neconyan-roleplay-preview');
    if (!preview) return null;
    const chatTop = chatNode.getBoundingClientRect().top;
    const previewText = preview.querySelector?.('.mes_text');
    const previewTop = preview.getBoundingClientRect().top - chatTop;
    const offsetTop = previewText ? previewText.getBoundingClientRect().top - chatTop : previewTop;
    const part = previewText ? '.mes_text' : null;
    let above = preview.previousElementSibling;
    while (above && !above.matches('.mes[mesid]')) above = above.previousElementSibling;
    const fallback = above
        ? { messageId: above.getAttribute('mesid'), offsetTop: above.getBoundingClientRect().top - chatTop }
        : null;
    const replacement = chatNode.querySelector('[data-roleplay-replacement]');
    const speakers = receipt?.result?.speakers;
    if (!replacement && Array.isArray(speakers) && speakers.length > 0) {
        const savedChild = receipt?.result?.childJobId;
        const previewChild = preview.dataset?.roleplayChild;
        if (previewChild && savedChild !== null && savedChild !== undefined
            && String(previewChild) === String(savedChild)) {
            return { messageId: chat.length + speakers.length - 1, offsetTop, part, fallback };
        }
        return fallback ? { ...fallback, part: null, fallback: null } : null;
    }
    const messageId = replacement ? Number(replacement.dataset.roleplayReplacement) : chat.length;
    return { messageId, offsetTop, part, fallback };
}

async function readbackReceipt(key, name, shared, id) {
    const { options } = shared;
    const { locator, account } = options;
    for (let attempt = 0; attempt < 12; attempt += 1) {
        if (account !== getCurrentUserHandle()) {
            shared.settled = true;
            settleFinished(key, null);
            return null;
        }
        const controller = new AbortController();
        shared.controller = controller;
        const timeout = setTimeout(() => controller.abort(new DOMException('Reply readback timed out.', 'TimeoutError')), 10000);
        let receipt;
        try {
            receipt = await readReceipt(key, account, controller.signal);
            if (receipt.accepted && receipt.state !== 'closed') {
                await withAbortSignal(
                    new Promise(resolve => setTimeout(resolve, Math.min(2000, 250 * (attempt + 1)))),
                    controller.signal,
                );
                continue;
            }
            if (!receipt.accepted) {
                shared.settled = true;
                settleFinished(key, null);
                return null;
            }
            // Returning to a tab must not clear an editor that is saving or generating.
            // The active job's own observer still adopts its newly completed reply.
            if (account !== getCurrentUserHandle()) {
                settleFinished(key, null);
                return null;
            }
            if (options.passive && (busyName || isGenerating() || isChatSaving)) return null;
            if (matchesCurrentWorkflowLocator(locator) && !adopted.has(id)) {
                if (activeReload) {
                    // A different workflow owns that read. Recheck this receipt and
                    // locator afterwards rather than adopting its unrelated result.
                    await withAbortSignal(activeReload, controller.signal);
                    continue;
                }
                activeReload = Promise.resolve()
                    .then(() => {
                        keepChatReadingPositionOnNextLoad(finishedReplyReadingAnchor(receipt));
                        return refreshCurrentChatFromSaved({ signal: controller.signal });
                    })
                    .finally(() => {
                        keepChatReadingPositionOnNextLoad(null);
                        activeReload = null;
                    });
                await activeReload;
                controller.signal.throwIfAborted();
                if (account === getCurrentUserHandle() && matchesCurrentWorkflowLocator(locator)) adopted.set(id, receipt);
            }
            shared.settled = true;
            announce({ key, name, state: receipt.state, result: receipt.result ?? null, jobId: receipt.jobId });
            settleFinished(key, receipt);
            return receipt;
        } catch (error) {
            if (error === RECONNECT_REASON || controller.signal.reason === RECONNECT_REASON) {
                attempt = -1;
                continue;
            }
            if (account !== getCurrentUserHandle() || attempt === 11 || error.status >= 400 && error.status < 500) {
                shared.settled = true;
                settleFinished(key, null);
                throw error;
            }
            // Keep the current reply visible while a transient read or pending save
            // prevents adoption. Only displaying the saved result completes readback.
            await withAbortSignal(new Promise(resolve => setTimeout(resolve, Math.min(2000, 250 * (attempt + 1)))), controller.signal).catch(() => {});
        } finally {
            clearTimeout(timeout);
            if (shared.controller === controller) shared.controller = null;
        }
    }
    shared.settled = true;
    settleFinished(key, null);
    return null;
}

/** Watch an accepted root job and read its receipt back once it settles. */
export function observeRoleplayWorkflowJob(jobId, { key, name, locator, messageIndex = finalModelMessageIndex(), account = getCurrentUserHandle() }) {
    if (!jobId || observed.has(jobId)) return;
    const isCurrent = () => account === getCurrentUserHandle() && matchesCurrentWorkflowLocator(locator);
    const restore = beginRoleplayReplacement(name, messageIndex, isCurrent);
    let stopPreview = () => {};
    let ended = false;
    const onTerminal = value => {
        if (ended) return;
        if (value.state !== 'completed') {
            const message = typeof value.error === 'string' ? value.error : value.error?.message;
            // The origin is the workflow's own chat and account, as given when it was accepted or found in the job record.
            if (isImageInputIssue(value.error)) globalThis.dispatchEvent(new CustomEvent(IMAGE_REFUSED_EVENT, { detail: imageInputIssueDetail(value.error, roleplayImageOrigin(locator, account)) }));
            else if (value.error?.code === 'GENERATION_BLOCKED') globalThis.toastr?.warning?.(generationBlockedNotice(false));
            else if (message) globalThis.toastr?.error?.(message, 'Reply stopped');
            stop(value.state);
        } else {
            if (value.result?.result?.generationOutcome || value.result?.generationOutcome) globalThis.toastr?.warning?.(generationBlockedNotice(true, value.result?.result?.generationOutcome ?? value.result?.generationOutcome));
            stop('done');
        }
    };
    const stop = observeJob(jobId, {
        account,
        onSnapshot: async root => {
            // The ordinary poll can finish before the preview stream. A failed
            // job has no completed write to wait for, so release Send immediately.
            if (TERMINAL.has(root.state)) { onTerminal(root); return; }
            if (root.state !== 'waiting' || !root.children?.length) return;
            const jobs = new Map((await listJobs({ account })).map(job => [job.id, job]));
            const pending = [root];
            const seen = new Set();
            const { serviceVectorBrowserWork } = await import('../extensions/vectors/native.js');
            for (const job of pending) {
                if (seen.has(job.id)) continue;
                seen.add(job.id);
                if (job.type === 'operations.vectors') await serviceVectorBrowserWork(job);
                for (const id of job.children ?? []) {
                    const child = jobs.get(id);
                    if (child?.parentId === job.id && child.owner === account) pending.push(child);
                }
            }
        },
        onStop: async (reason) => {
            ended = true;
            if (reason !== 'done' && reason !== 'stopped') {
                stopPreview();
                restore();
                announce({ key, name, state: reason, result: null, jobId });
                // A refused or lost job must not leave a caller waiting for a write
                // that will never arrive.
                settleFinished(key, null);
                observed.delete(jobId);
                syncJobControls();
                return;
            }
            stopPreview.freeze?.();
            try {
                await readback(key, name, { locator, account });
            } catch {
                // The receipt is permanent; the next resume reads it back.
                settleFinished(key, null);
            } finally {
                stopPreview();
                restore();
                observed.delete(jobId);
                syncJobControls();
            }
        },
    });
    observed.set(jobId, { account, stop, onTerminal, isCurrent });
    syncJobControls();
    void import('./roleplay-preview.js').then(({ observeRoleplayPreview }) => {
        if (ended) return;
        stopPreview = observeRoleplayPreview(jobId, { account, name, messageIndex,
            isCurrent,
            onTerminal,
        });
    }).catch(() => {});
}

/**
 * Settings the page has changed but not yet saved (a delayed save is still waiting)
 * are saved now, so the server reads the settings the user sees and a delayed save
 * landing after acceptance cannot change what the accepted reply was bound to.
 * While the page is still loading its settings, or another save is in flight, the
 * proof is unreadable, so the save is tried again for a bounded time before refusing.
 */
async function acknowledgedSettingsRevision() {
    let failure = null;
    for (let attempt = 1; attempt <= SETTINGS_PROOF_ATTEMPTS; attempt++) {
        try {
            if (await saveSettings(0, { returnResult: true })) {
                return getActiveGenerationAcknowledgement().settingsRevision;
            }
        } catch (error) {
            failure = error;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(1500, 250 * attempt)));
    }
    throw failure ?? new Error('Save the active connection settings before generating a reply.');
}

/**
 * Submit one named workflow. The chat is saved first, so the message the user is
 * looking at is the message the server anchors its write to, and an uncertain
 * response keeps the whole payload so an identical retry cannot duplicate it.
 */
export async function submitRoleplayWorkflow({ name, intent: named = {}, page = [], messageIndex = null, maxTokens = 0, account = getCurrentUserHandle() }) {
    const intent = Array.isArray(page) && page.length ? { ...named, page } : named;
    const anchorKind = ROLEPLAY_WORKFLOW_ANCHORS[name];
    if (!anchorKind) throw new Error(`Unknown named Roleplay workflow: ${name}`);
    const locator = currentLocator();
    if (!locator) throw new Error('Open a saved Roleplay chat before generating.');
    const chosen = anchorKind === 'chosen';
    const anchorIndex = messageIndex !== null ? messageIndex
        : anchorKind === 'end' ? chat.length - 1
            : anchorKind === 'block' ? finalBlockMessageIndex() : finalModelMessageIndex();
    if (!Number.isSafeInteger(anchorIndex) || anchorIndex < 0) throw new Error('The saved Roleplay chat has no message to answer.');
    const restore = beginRoleplayReplacement(name, anchorIndex,
        () => account === getCurrentUserHandle() && matchesCurrentWorkflowLocator(locator));
    try {
        const accepted = await submitRoleplayWorkflowRequest({ name, intent, locator, anchorIndex, chosen, maxTokens, account });
        void accepted.finished.then(restore);
        return accepted;
    } catch (error) {
        restore();
        throw error;
    }
}

// The preview card waits for this module, so fetch it while the chat is still saving.
function preloadRoleplayPreview() {
    void import('./roleplay-preview.js').catch(() => {});
}

async function submitRoleplayWorkflowRequest({ name, intent, locator, anchorIndex, chosen, maxTokens, account }) {
    preloadRoleplayPreview();
    const stamp = roleplayAccountStamp().account;
    const signature = JSON.stringify([account, name, intent, anchorIndex, chosen, maxTokens, locator, stamp]);
    const known = pending.get(account);
    const browserMacros = captureBrowserMacros();
    let payload = known?.signature === signature ? known.payload : {
        key: createKey(name),
        name,
        intent,
        // An uncertain submission reuses its capture and key, even if the page changed.
        bundledMacros: await captureBundledMacros(),
        ...(browserMacros.length ? { browserMacros } : {}),
        source: { locator },
        anchor: { messageIndex: anchorIndex, chosen },
        messageRevision: messageRevisionAt(anchorIndex),
        account: stamp,
        acknowledgement: { account, settingsRevision: await acknowledgedSettingsRevision() },
        ...(Number(maxTokens) > 0 ? { maxTokens: Number(maxTokens) } : {}),
    };
    pending.set(account, { signature, payload });
    // Registered before the request, so a workflow that finishes before the
    // response is read still resolves the caller's wait.
    const finished = awaitFinished(payload.key);
    await saveChatConditional({ throwOnError: true, account, skipUnchanged: true });
    let accepted;
    try {
        accepted = await postSubmission(payload, account);
    } catch (error) {
        // A refusal is final. A lost response may already be accepted, so the exact
        // request and its key are kept for the next identical submit.
        if (error.status >= 400 && error.status < 500) {
            if (error.body?.code !== 'roleplay_settings_ack_required') pending.delete(account);
        }
        if (error.body?.code === 'roleplay_settings_ack_required') {
            const retry = { ...payload, acknowledgement: { account, settingsRevision: await acknowledgedSettingsRevision() } };
            pending.set(account, { signature, payload: retry });
            accepted = await postSubmission(retry, account);
        } else {
            throw error;
        }
    }
    pending.delete(account);
    logRoleplayAccepted(name);
    if (accepted?.jobId) observeRoleplayWorkflowJob(accepted.jobId, { key: payload.key, name, locator, account, messageIndex: anchorIndex });
    if (accepted?.result) void readback(payload.key, name, { locator, account });
    return { ...accepted, key: payload.key, finished };
}

/**
 * Submit one whole group turn. The page has already chosen the speakers exactly as
 * the group settings say and saved the user's message, so the server receives the
 * saved chat, the chosen speakers in order and the batch id. It then writes every
 * speaker's reply itself, so closing the page does not stop the turn. The call
 * resolves once the durable write has been read back; stopping cancels the job.
 */
export async function submitRoleplayGroupTurn({ groupId, forcedAvatars, generationId, signal = null, account = getCurrentUserHandle() }) {
    const chatName = String(getCurrentChatId() || '').replace(/\.jsonl$/, '');
    if (!chatName || !groupId) throw new Error('Open a saved group chat before generating.');
    preloadRoleplayPreview();
    const locator = { chat: chatName, group: true, groupId: String(groupId) };
    // Captured once, so the settings-proof retry replays the same instruction.
    const bundledMacros = await captureBundledMacros();
    const browserMacros = captureBrowserMacros();
    const stamp = roleplayAccountStamp().account;
    const payload = {
        key: createKey('group.reply'),
        source: { locator },
        messageCount: chat.length,
        forcedAvatars,
        generationId,
        bundledMacros,
        ...(browserMacros.length ? { browserMacros } : {}),
        account: stamp,
    };
    const finished = awaitFinished(payload.key);
    await saveChatConditional({ throwOnError: true, account, skipUnchanged: true });
    // Chat-save listeners may change settings, so confirm them after that write.
    payload.acknowledgement = { account, settingsRevision: await acknowledgedSettingsRevision() };
    let accepted;
    try {
        accepted = await postSubmission({ ...payload, name: 'group.reply' }, account, '/api/roleplay/group/submit');
    } catch (error) {
        // This refusal happens before admission. An uncertain outcome must not be repeated.
        if (error.status !== 409 || error.body?.code !== 'roleplay_settings_ack_required') throw error;
        signal?.throwIfAborted();
        payload.acknowledgement = { account, settingsRevision: await acknowledgedSettingsRevision() };
        signal?.throwIfAborted();
        accepted = await postSubmission({ ...payload, name: 'group.reply' }, account, '/api/roleplay/group/submit');
    }
    logRoleplayAccepted('group.reply');
    const onAbort = () => { if (accepted?.jobId) void cancelJob(accepted.jobId, { reason: 'user_cancelled' }).catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        if (accepted?.jobId) observeRoleplayWorkflowJob(accepted.jobId, { key: payload.key, name: 'group.reply', locator, account });
        else void readback(payload.key, 'group.reply', { locator, account });
        return await finished;
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * The generation funnel for a migrated Roleplay control. The host has already
 * decided that this call site can be served faithfully and has saved the user's own
 * message, so this submits the named workflow, marks the host busy exactly as a
 * browser generation would be, and stops the accepted job when the user stops. The
 * call resolves once the durable write has been read back, so a caller that records
 * facts from the saved result sees them already.
 *
 * A refusal is final: falling through to the browser path would be the duplicate
 * paid call this migration must never make, so a refused call still returns a
 * result and the host never generates a second time.
 */
export async function runNativeRoleplayGeneration(type, { committed = false, page = null, maxOutputTokens = 0, signal = null, skipNativeRoleplay = false } = {}) {
    const refuse = () => {
        globalThis.toastr?.error?.('A Roleplay workflow is already running.', 'Nothing was generated');
        return { native: true, name: null, key: null, jobId: null, state: 'refused', result: null, refused: true };
    };
    if (skipNativeRoleplay || !willRunNativeRoleplayWorkflow(type, { skipNativeRoleplay })) return null;
    if (busyName) {
        logRoleplayRefusal({ type, reason: 'busy' });
        return committed ? refuse() : null;
    }
    const name = roleplayWorkflowNameFor(type);
    if (!name) return null;
    if (!isNativeRoleplayWorkflowReady()) {
        logRoleplayRefusal({ type, reason: 'not-ready' });
        if (!committed) return null;
        globalThis.toastr?.error?.('Open a saved Roleplay chat before generating.', 'Nothing was generated');
        return { native: true, name, key: null, jobId: null, state: 'refused', result: null, refused: true };
    }
    // The host captured the page prompts before it committed to this path; a call
    // without them captures now and keeps the browser path when one cannot travel.
    const prompts = Array.isArray(page) ? page : await capturePagePrompts(name);
    if (!prompts) {
        if (!committed) return null;
        globalThis.toastr?.error?.('A page prompt addition cannot run on the server.', 'Nothing was generated');
        return { native: true, name, key: null, jobId: null, state: 'refused', result: null, refused: true };
    }
    busyName = name;
    deactivateSendButtons();
    const onStop = () => {
        const jobId = currentJobId;
        currentJobId = null;
        if (jobId) void cancelJob(jobId, { reason: 'user_cancelled' }).catch(() => {});
    };
    try {
        const accepted = await submitRoleplayWorkflow({ name, intent: workflowIntent(name), page: prompts,
            maxTokens: Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : 0 });
        currentJobId = accepted.jobId ?? null;
        if (signal && currentJobId) {
            if (signal.aborted) onStop();
            else signal.addEventListener('abort', onStop, { once: true });
        }
        const receipt = await accepted.finished;
        return { native: true, name, key: accepted.key ?? null, jobId: accepted.jobId ?? null,
            state: receipt?.state ?? null, result: receipt?.result ?? null, created: accepted.created !== false };
    } catch (error) {
        // An image refusal has already raised its own notice (postSubmission), so it gets no second, generic toast.
        if (!isImageInputIssue(error)) globalThis.toastr?.error?.(error?.message || 'The Roleplay workflow could not be started.', 'Nothing was generated');
        return { native: true, name, key: null, jobId: null, state: 'refused', result: null, refused: true };
    } finally {
        busyName = null;
        currentJobId = null;
        signal?.removeEventListener?.('abort', onStop);
        activateSendButtons();
    }
}

/** Reattach to accepted workflows and read finished ones back, without submitting again. */
export async function resumeNativeRoleplayWorkflowObservation({ reconnect = false, attachOnly = false } = {}) {
    const account = getCurrentUserHandle();
    for (const entry of [...observed.values()]) {
        if (entry.account !== account) entry.stop();
    }
    syncJobControls();
    const reconnected = new Set();
    if (reconnect) {
        for (const entry of reading.values()) {
            if (entry.options.account === account) {
                reconnected.add(entry.promise);
                if (!activeDiscovery || activeDiscovery.account !== account || !activeDiscovery.reconnected) {
                    reconnectReading(entry);
                }
            }
        }
        if (activeDiscovery && activeDiscovery.account === account) {
            if (!activeDiscovery.reconnected) activeDiscovery.controller?.abort(RECONNECT_REASON);
            activeDiscovery.reconnected = true;
            for (const promise of reconnected) activeDiscovery.reconnectedPromises.add(promise);
        }
    }
    if (activeDiscovery && activeDiscovery.account === account) {
        if (!attachOnly) activeDiscovery.attachOnly = false;
        return activeDiscovery.promise;
    }
    const cycle = { account, reconnected: Boolean(reconnect), attachOnly: Boolean(attachOnly), reconnectedPromises: reconnected, promise: null, controller: null };
    cycle.promise = (async () => {
        let jobs = [];
        try {
            for (;;) {
                const controller = new AbortController();
                cycle.controller = controller;
                const timeout = setTimeout(() => controller.abort(), 10000);
                try {
                    jobs = await withAbortSignal(listJobs({ includeDismissed: false, account, signal: controller.signal }), controller.signal);
                    break;
                } catch (error) {
                    if (controller.signal.reason !== RECONNECT_REASON) throw error;
                } finally {
                    clearTimeout(timeout);
                    cycle.controller = null;
                }
            }
        } catch {
            return;
        } finally {
            if (activeDiscovery === cycle) activeDiscovery = null;
        }
        if (account !== getCurrentUserHandle()) return;
        let finished = null;
        for (const job of jobs) {
            if (job?.type !== 'media.roleplay-workflow' || job.parentId) continue;
            const key = job.intent?.media?.operationKey;
            const source = job.intent?.source?.locator;
            if (!key || typeof source?.group !== 'boolean') continue;
            const locator = source.group
                ? { ...source, groupId: String(job.intent?.source?.groupId ?? source.groupId ?? '') }
                : source;
            if (!matchesCurrentWorkflowLocator(locator)) continue;
            const name = source.group ? 'group.reply' : (job.intent?.request?.named?.name ?? null);
            if (!TERMINAL.has(job.state)) {
                observeRoleplayWorkflowJob(job.id, { key, name, locator, account,
                    messageIndex: job.intent?.source?.message?.index ?? job.intent?.source?.range?.start });
            } else if (observed.has(job.id)) {
                observed.get(job.id)?.onTerminal?.(job);
            } else if (!cycle.attachOnly && !finished) {
                finished = { key, name, locator };
            }
        }
        if (!cycle.attachOnly && finished && !busyName && !isGenerating() && !isChatSaving && !activeReload) {
            await readback(finished.key, finished.name, { locator: finished.locator, account, passive: true }).catch(() => {});
        }
        if (cycle.reconnectedPromises.size) {
            await Promise.allSettled([...cycle.reconnectedPromises]);
        }
    })();
    activeDiscovery = cycle;
    return cycle.promise;
}

let initialised = false;

/**
 * Reopen without replay. The page that reopens a chat finds the accepted workflows
 * already in the job ledger, so it reattaches to the ones still running and reads
 * the finished receipt back exactly once. It never submits anything again, and a
 * receipt outlives the job that produced it.
 */
export function initNativeRoleplayWorkflows() {
    if (initialised) return;
    initialised = true;
    const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const resume = () => {
        if (isVisible()) void resumeNativeRoleplayWorkflowObservation();
    };
    const reconnect = () => {
        void resumeNativeRoleplayWorkflowObservation({ reconnect: true });
    };
    resume();
    document?.addEventListener?.('visibilitychange', () => {
        if (isVisible()) reconnect();
    });
    globalThis.addEventListener?.('pageshow', event => {
        if (event?.persisted) reconnect();
    });
    globalThis.addEventListener?.('online', reconnect);
    // The account binding arrives after the first paint, so discovery retries then.
    globalThis.addEventListener?.('sb:roleplay-account-bound', resume);
    prewarmDialogueColorsModule();
    eventSource.on(event_types.CHAT_CHANGED, () => {
        prewarmDialogueColorsModule();
        syncJobControls();
        if (isVisible() && getCurrentChatId() && !busyName && !isGenerating() && !activeReload) {
            void resumeNativeRoleplayWorkflowObservation({ attachOnly: true });
        }
    });
}
