/**
 * Submit, observe and read back the server's named Roleplay workflows.
 *
 * The browser's Roleplay controls no longer assemble a prompt or call a provider.
 * Each control names one server workflow, hands over only what the user typed or
 * what a saved extension had already written down, and then observes the accepted
 * job. The durable write is the server's; the browser reloads the chat it wrote
 * and adopts the result facts it needs for its own bookkeeping.
 *
 * A submission that loses its response keeps its key, so the same request replays
 * instead of paying twice, and a reopened page reattaches to the accepted job and
 * reads its permanent receipt back rather than submitting anything again.
 */
import { activateSendButtons, chat, deactivateSendButtons, extension_prompts, getActiveGenerationAcknowledgement, getCurrentChatId, getRequestHeaders, isChatSaving, isGenerating, reloadCurrentChat, saveChatConditional, saveSettings, substituteParams, willRunNativeRoleplayWorkflow } from '../../script.js';
import { activeGenerationInterceptors } from '../extensions.js';
import { selected_group } from '../group-chats.js';
import { cancelJob, listJobs, observeJob, TERMINAL } from '../jobs.js';
import { roleplayAccountStamp } from '../roleplay-save-chain.js';
import { getCurrentUserHandle } from '../user.js';
import { getCurrentCharAvatar } from './context.js';
import { getRoleplaySourceMessageRevision } from './roleplay-source.js';

const WORKFLOW_EVENT = 'neconyan:roleplay-workflow-finished';
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
    'story.passage', 'guided.response', 'guided.swipe', 'guided.correction',
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
    'guided.response': 'end', 'guided.swipe': 'assistant', 'guided.correction': 'assistant',
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
const SERVER_PROMPT_PREFIXES = ['DEPTH_PROMPT', 'customDepthWI', 'customWIOutlet_'];
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
            await globalThis[interceptor.key]([], 0, () => {}, 'normal');
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
    if (!response.ok) throw Object.assign(new Error(body?.error || `The ${payload.name} workflow was refused (${response.status}).`), { status: response.status, body });
    return body;
}

async function readReceipt(key, account) {
    const response = await fetch(`/api/roleplay/workflow/receipt?key=${encodeURIComponent(key)}`, {
        credentials: 'same-origin',
        headers: { ...getRequestHeaders(), 'X-Neconyan-Account': account },
    });
    const body = await response.json().catch(() => null);
    if (account !== getCurrentUserHandle()) throw new Error('account_changed');
    if (!response.ok) throw Object.assign(new Error(body?.error || 'The workflow receipt could not be read.'), { status: response.status, body });
    return body;
}

function announce(detail) {
    globalThis.dispatchEvent(new CustomEvent(WORKFLOW_EVENT, { detail }));
}

/**
 * The readback of one accepted workflow: the receipt is the authority, the chat is
 * reloaded from the server that wrote it, and the named control adopts its facts.
 * A receipt that is not closed yet is retried, never resubmitted.
 */
function readback(key, name, options) {
    const id = JSON.stringify([options.account, key]);
    if (adopted.has(id)) {
        const receipt = adopted.get(id);
        settleFinished(key, receipt);
        return Promise.resolve(receipt);
    }
    const existing = reading.get(id);
    if (existing) {
        if (!options.passive) existing.options.passive = false;
        return existing.promise;
    }
    const shared = { options: { ...options } };
    shared.promise = readbackReceipt(key, name, shared.options, id).finally(() => reading.delete(id));
    reading.set(id, shared);
    return shared.promise;
}

async function readbackReceipt(key, name, options, id) {
    const { locator, account } = options;
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const receipt = await readReceipt(key, account);
        if (receipt.accepted && receipt.state !== 'closed') {
            await new Promise(resolve => setTimeout(resolve, Math.min(2000, 250 * (attempt + 1))));
            continue;
        }
        if (!receipt.accepted) {
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
        if (matchesCurrentWorkflowLocator(locator)) {
            await reloadCurrentChat();
            adopted.set(id, receipt);
        }
        announce({ key, name, state: receipt.state, result: receipt.result ?? null, jobId: receipt.jobId });
        settleFinished(key, receipt);
        return receipt;
    }
    settleFinished(key, null);
    return null;
}

/** Watch an accepted root job and read its receipt back once it settles. */
export function observeRoleplayWorkflowJob(jobId, { key, name, locator, account = getCurrentUserHandle() }) {
    if (!jobId || observed.has(jobId)) return;
    let stopPreview = () => {};
    let ended = false;
    const onTerminal = value => {
        if (ended) return;
        if (value.state !== 'completed') {
            const message = typeof value.error === 'string' ? value.error : value.error?.message;
            if (message) globalThis.toastr?.error?.(message, 'Reply stopped');
            stop(value.state);
        } else stop('done');
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
            observed.delete(jobId);
            if (reason !== 'done' && reason !== 'stopped') {
                stopPreview();
                announce({ key, name, state: reason, result: null, jobId });
                // A refused or lost job must not leave a caller waiting for a write
                // that will never arrive.
                settleFinished(key, null);
                return;
            }
            try {
                await readback(key, name, { locator, account });
            } catch {
                // The receipt is permanent; the next resume reads it back.
                settleFinished(key, null);
            } finally {
                stopPreview();
            }
        },
    });
    observed.set(jobId, { account, stop });
    void import('./roleplay-preview.js').then(({ observeRoleplayPreview }) => {
        if (ended) return;
        stopPreview = observeRoleplayPreview(jobId, { account,
            isCurrent: () => account === getCurrentUserHandle()
                && matchesCurrentWorkflowLocator(locator),
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
    const stamp = roleplayAccountStamp().account;
    const signature = JSON.stringify([account, name, intent, anchorIndex, chosen, maxTokens, locator, stamp]);
    const known = pending.get(account);
    let payload = known?.signature === signature ? known.payload : {
        key: createKey(name),
        name,
        intent,
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
    await saveChatConditional({ throwOnError: true, account });
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
    if (accepted?.jobId) observeRoleplayWorkflowJob(accepted.jobId, { key: payload.key, name, locator, account });
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
    const locator = { chat: chatName, group: true, groupId: String(groupId) };
    const stamp = roleplayAccountStamp().account;
    const payload = {
        key: createKey('group.reply'),
        source: { locator },
        messageCount: chat.length,
        forcedAvatars,
        generationId,
        account: stamp,
    };
    const finished = awaitFinished(payload.key);
    await saveChatConditional({ throwOnError: true, account });
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
        globalThis.toastr?.error?.(error?.message || 'The Roleplay workflow could not be started.', 'Nothing was generated');
        return { native: true, name, key: null, jobId: null, state: 'refused', result: null, refused: true };
    } finally {
        busyName = null;
        currentJobId = null;
        signal?.removeEventListener?.('abort', onStop);
        activateSendButtons();
    }
}

/** Reattach to accepted workflows and read finished ones back, without submitting again. */
export async function resumeNativeRoleplayWorkflowObservation() {
    const account = getCurrentUserHandle();
    for (const entry of [...observed.values()]) {
        if (entry.account !== account) entry.stop();
    }
    let jobs = [];
    try {
        jobs = await listJobs({ includeDismissed: false, account });
    } catch {
        return;
    }
    const locator = currentLocator();
    let finished = null;
    for (const job of jobs) {
        if (job?.type !== 'media.roleplay-workflow' || job.parentId) continue;
        const key = job.intent?.media?.operationKey;
        const source = job.intent?.source?.locator;
        if (!key || source?.group !== false) continue;
        if (source.chat !== locator?.chat || source.avatar !== locator?.avatar) continue;
        const name = job.intent?.request?.named?.name ?? null;
        if (!TERMINAL.has(job.state)) {
            observeRoleplayWorkflowJob(job.id, { key, name, locator, account });
        } else if (!finished) {
            finished = { key, name, locator };
        }
    }
    if (finished && !busyName && !isGenerating() && !isChatSaving) {
        await readback(finished.key, finished.name, { locator, account, passive: true }).catch(() => {});
    }
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
    const resume = () => {
        if (document.visibilityState === 'visible') void resumeNativeRoleplayWorkflowObservation();
    };
    resume();
    document.addEventListener('visibilitychange', resume);
    // The account binding arrives after the first paint, so discovery retries then.
    globalThis.addEventListener?.('sb:roleplay-account-bound', resume);
}
