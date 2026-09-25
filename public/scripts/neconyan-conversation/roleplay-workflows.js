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
import { activateSendButtons, chat, deactivateSendButtons, getActiveGenerationAcknowledgement, getCurrentChatId, getRequestHeaders, reloadCurrentChat, saveChatConditional, saveSettings } from '../../script.js';
import { hasPendingFileAttachment } from '../chats.js';
import { selected_group } from '../group-chats.js';
import { listJobs, observeJob, TERMINAL } from '../jobs.js';
import { roleplayAccountStamp } from '../roleplay-save-chain.js';
import { getCurrentUserHandle } from '../user.js';
import { getCurrentCharAvatar } from './context.js';
import { getRoleplaySourceMessageRevision } from './roleplay-source.js';

const WORKFLOW_EVENT = 'neconyan:roleplay-workflow-finished';
const NATIVE_TYPES = new Set(['normal', 'continue', 'swipe', 'regenerate']);
const STORY_RULES_KEY = 'sbstory_rules';
const STORY_DIRECTION_KEY = 'sbstory_direction';
const STORY_RULES_DEPTH = 1;
const STORY_DIRECTION_DEPTH = 0;

const observed = new Map();
const pending = new Map();
let busyName = null;

/** The named vocabulary a control may ask for. The server owns the mapping. */
export const ROLEPLAY_WORKFLOW_NAMES = Object.freeze([
    'roleplay.reply', 'roleplay.continue', 'roleplay.swipe', 'roleplay.correct',
    'story.passage', 'guided.response', 'guided.swipe', 'guided.correction',
    'deep-swipe.reply', 'deep-swipe.user',
]);

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

/** The saved chat's own final model message, which is what a swipe or continuation answers. */
export function finalModelMessageIndex() {
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];
        if (message?.is_user !== true && message?.role !== 'user' && message?.is_system !== true) return index;
    }
    return null;
}

/** Unsent composer text, which a server reply cannot answer. */
function composerText() {
    return String(document.querySelector('#send_textarea')?.value ?? '').trim();
}

function messageRevisionAt(index) {
    const message = chat[index];
    if (!message) throw new Error('The message this workflow answers is no longer in the chat.');
    return getRoleplaySourceMessageRevision(message);
}

/** The Story Mode prompt this chat already carries, if Story Mode is shaping it. */
function storyPrompt() {
    const injects = globalThis.chat_metadata?.script_injects ?? {};
    const rules = injects[STORY_RULES_KEY]?.content;
    if (typeof rules !== 'string' || !rules.trim()) return null;
    const direction = injects[STORY_DIRECTION_KEY]?.content;
    return { rules, rulesDepth: STORY_RULES_DEPTH,
        direction: typeof direction === 'string' && direction.trim() ? direction : '',
        directionDepth: STORY_DIRECTION_DEPTH };
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

async function postSubmission(payload, account) {
    const response = await fetch('/api/roleplay/workflow/submit', {
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
async function readback(key, name, { locator, account }) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
        const receipt = await readReceipt(key, account);
        if (receipt.accepted && receipt.state !== 'closed') {
            await new Promise(resolve => setTimeout(resolve, Math.min(2000, 250 * (attempt + 1))));
            continue;
        }
        if (!receipt.accepted) return null;
        const current = currentLocator();
        if (current && locator && current.chat === locator.chat && current.avatar === locator.avatar) {
            await reloadCurrentChat();
        }
        announce({ key, name, state: receipt.state, result: receipt.result ?? null, jobId: receipt.jobId });
        return receipt;
    }
    return null;
}

/** Watch an accepted root job and read its receipt back once it settles. */
export function observeRoleplayWorkflowJob(jobId, { key, name, locator, account = getCurrentUserHandle() }) {
    if (!jobId || observed.has(jobId)) return;
    const stop = observeJob(jobId, {
        account,
        onSnapshot: () => {},
        onStop: async (reason) => {
            observed.delete(jobId);
            if (reason !== 'done' && reason !== 'stopped') {
                announce({ key, name, state: reason, result: null, jobId });
                return;
            }
            try {
                await readback(key, name, { locator, account });
            } catch {
                // The receipt is permanent; the next resume reads it back.
            }
        },
    });
    observed.set(jobId, { account, stop });
}

/**
 * Submit one named workflow. The chat is saved first, so the message the user is
 * looking at is the message the server anchors its write to, and an uncertain
 * response keeps the whole payload so an identical retry cannot duplicate it.
 */
export async function submitRoleplayWorkflow({ name, intent = {}, messageIndex = null, chosen = false, maxTokens = 0, account = getCurrentUserHandle() }) {
    if (!ROLEPLAY_WORKFLOW_NAMES.includes(name)) throw new Error(`Unknown named Roleplay workflow: ${name}`);
    const locator = currentLocator();
    if (!locator) throw new Error('Open a saved Roleplay chat before generating.');
    const anchorIndex = messageIndex === null ? finalModelMessageIndex() : messageIndex;
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
        acknowledgement: { account, settingsRevision: getActiveGenerationAcknowledgement().settingsRevision },
        ...(maxTokens > 0 ? { maxTokens } : {}),
    };
    pending.set(account, { signature, payload });
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
        if (error.body?.code === 'roleplay_settings_ack_required' && await saveSettings(0, { returnResult: true })) {
            const retry = { ...payload, acknowledgement: { account, settingsRevision: getActiveGenerationAcknowledgement().settingsRevision } };
            pending.set(account, { signature, payload: retry });
            accepted = await postSubmission(retry, account);
        } else {
            throw error;
        }
    }
    pending.delete(account);
    if (accepted?.jobId) observeRoleplayWorkflowJob(accepted.jobId, { key: payload.key, name, locator, account });
    if (accepted?.result) void readback(payload.key, name, { locator, account });
    return accepted;
}

/**
 * The generation funnel for a migrated Roleplay control. It refuses the call sites
 * the server cannot serve faithfully (a group turn, structured output, an explicit
 * character override, unsent composer text or attachments, a caller that reads the
 * provider response) and submits the named workflow for the ones it owns. The host
 * is marked busy exactly as a browser generation would be, and the result arrives
 * through the finished event rather than as a streamed response.
 */
export async function runNativeRoleplayGeneration(type, { maxOutputTokens = 0, jsonSchema = null, force_chid = null,
    force_name2 = false, quiet_prompt = null, depth = 0, cacheScope = null, suppressUserMessage = false,
    preserveLastMessage = false, signal = null, skipNativeRoleplay = false } = {}) {
    if (skipNativeRoleplay || !NATIVE_TYPES.has(type) || busyName) return null;
    if (jsonSchema || force_chid || force_name2 || quiet_prompt || depth > 0 || cacheScope || signal?.aborted) return null;
    if (selected_group || !isNativeRoleplayWorkflowReady()) return null;
    // A reply must answer what the user actually sent, so unsent composer text or
    // a pending attachment keeps the browser path that saves them first.
    if (type === 'normal' && !suppressUserMessage && (composerText() || hasPendingFileAttachment())) return null;
    const name = roleplayWorkflowNameFor(type);
    if (!name) return null;
    busyName = name;
    deactivateSendButtons();
    try {
        const accepted = await submitRoleplayWorkflow({ name, intent: workflowIntent(name),
            maxTokens: Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : 0 });
        return { native: true, name, key: accepted?.key ?? null, jobId: accepted?.jobId ?? null, created: accepted?.created !== false };
    } catch (error) {
        globalThis.toastr?.error?.(error?.message || 'The Roleplay workflow could not be started.', 'Nothing was generated');
        return null;
    } finally {
        busyName = null;
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
    if (finished) await readback(finished.key, finished.name, { locator, account }).catch(() => {});
}
