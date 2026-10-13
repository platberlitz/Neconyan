import { CARD_SCRIPT_MARKER_TAG, getCardScriptSnapshot, forgetAllCardScripts, getStoredCardScriptCount } from './card-script-detection.js';
import { POLICY_MODES, createDefaultPolicy, parseSlashCommandRequest } from './card-script-sandbox/allowlist.js';
import { MESSAGE_VERSION, RESIZE_MESSAGE_TYPE, READY_MESSAGE_TYPE, BOOTSTRAP_MESSAGE_TYPE, INIT_MESSAGE_TYPE, validateBootstrapMessage, validateSlashRequestMessage, validateResizeMessage, validateReadyMessage, validateInitMessage } from './card-script-sandbox/messages.js';
import { createRateLimiter } from './card-script-sandbox/rate-limiter.js';
import { buildCardDocument } from './card-script-sandbox/wrapper.js';
import { CARD_SCRIPT_PERMISSIONS, CARD_SCRIPT_PROTOCOL_VERSION, CARD_SCRIPT_SANDBOX_PATH } from './card-script-sandbox/policy.js';
import { eventSource, event_types } from './events.js';
import { t } from './i18n.js';

export const CARD_SCRIPT_CONFIRMATION_STORAGE_KEY = 'card_scripts_auto_confirmed';
export const CARD_SCRIPT_RUN_BUTTON_SELECTOR = '.mes_run_card_scripts';
export const MAX_ACTIVE_CARD_SCRIPT_SANDBOXES = 5;
export const CARD_SCRIPT_PARSER_FLAGS = Object.freeze({ 1: true, 2: false });

const activeSandboxes = new Map();
const pendingStarts = new Map();
const stoppedMessages = new Map();
const streamingMessages = new Set();
const observedMessages = new Set();
const unprotectedAcknowledgements = new Map();
const isolationNotices = new Map();
let pageProtection = null;
let epoch = 0;
let chatScope = 0;
let initialized = false;
let observer = null;
let intersectionObserver = null;
let reconcileTimer = null;
let consentPromise = null;
let consentAccepted = false;
let consentDeclined = false;

const defaults = {
    getDocument: () => globalThis.document,
    getWindow: () => globalThis.window,
    getMutationObserver: () => globalThis.MutationObserver,
    getIntersectionObserver: () => globalThis.IntersectionObserver,
    getComputedStyle: element => globalThis.getComputedStyle(element),
    getLocalStorage: () => globalThis.localStorage,
    getPowerUser: async () => (await import('./power-user.js')).power_user,
    getSlashExecutor: async () => (await import('./slash-commands.js')).executeSlashCommandsWithOptions,
    getChatScope: () => chatScope,
    getMessage: () => null,
    isMessageStreaming: () => false,
    isMessageEditing: () => false,
    refreshRenderedCardScriptMessages: null,
    hasCardScriptSnapshots: () => getStoredCardScriptCount() > 0,
    getCardScriptSnapshot,
    buildCardDocument,
    createRateLimiter,
    createNonce: createSecureNonce,
    now: () => Date.now(),
    showConfirmation: null,
    toastr: () => globalThis.toastr,
};
let dependencies = { ...defaults };

export function configureCardScriptRuntime(options = {}) {
    dependencies = { ...dependencies, ...options };
}

const handlers = {
    message: event => void handleSandboxMessage(event),
    click: event => void handleRunButtonClick(event),
    keydown: event => {
        if (['Enter', ' '].includes(event.key) && event.target?.matches?.(CARD_SCRIPT_RUN_BUTTON_SELECTOR)) void handleRunButtonClick(event);
    },
    setting: event => {
        if (!event.currentTarget.checked) resetCardScriptSession();
        consentDeclined = false;
        scheduleCardScriptReconcile();
    },
    reconcile: () => scheduleCardScriptReconcile(),
    scroll: () => { if (activeSandboxes.size || dependencies.hasCardScriptSnapshots()) scheduleCardScriptReconcile(); },
    edited: id => { destroySandbox(id, { reason: 'edit' }); scheduleCardScriptReconcile(); },
    deleted: () => {
        const stopped = [...stoppedMessages.values()];
        const hadSnapshots = dependencies.hasCardScriptSnapshots();
        resetCardScriptSession({ clearSnapshots: true });
        if (hadSnapshots) dependencies.refreshRenderedCardScriptMessages?.();
        for (const element of dependencies.getDocument()?.querySelectorAll('#chat .mes[mesid]') ?? []) {
            const id = normalizeMessageId(element.getAttribute('mesid'));
            const revision = getRevision(id);
            if (stopped.some(previous => sameContent(previous, revision))) stoppedMessages.set(id, revision);
        }
        scheduleCardScriptReconcile();
    },
};
const lifecycleEvents = ['CHAT_CHANGED', 'MORE_MESSAGES_LOADED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'SETTINGS_LOADED_AFTER', 'APP_READY'];

export function initCardScriptRuntime() {
    if (initialized) return;
    initialized = true;
    const doc = dependencies.getDocument();
    dependencies.getWindow()?.addEventListener('message', handlers.message);
    doc?.addEventListener('click', handlers.click);
    doc?.addEventListener('keydown', handlers.keydown);
    doc?.addEventListener('visibilitychange', handlers.reconcile);
    doc?.getElementById('allow_card_scripts')?.addEventListener('input', handlers.setting);
    lifecycleEvents.forEach(name => event_types[name] && eventSource.on(event_types[name], handlers.reconcile));
    eventSource.on(event_types.MESSAGE_EDITED, handlers.edited);
    eventSource.on(event_types.MESSAGE_DELETED, handlers.deleted);
    const chat = doc?.querySelector('#chat');
    const Observer = dependencies.getMutationObserver();
    if (Observer && chat) {
        observer = new Observer(handlers.reconcile);
        observer.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['mesid'] });
    }
    const Intersection = dependencies.getIntersectionObserver();
    if (Intersection && chat) {
        intersectionObserver = new Intersection(handlers.reconcile, { root: chat, rootMargin: '600px 0px' });
    }
    chat?.addEventListener('scroll', handlers.scroll, { passive: true });
    scheduleCardScriptReconcile();
}

export function teardownCardScriptRuntime() {
    resetCardScriptSession();
    if (!initialized) return;
    const doc = dependencies.getDocument();
    dependencies.getWindow()?.removeEventListener('message', handlers.message);
    doc?.removeEventListener('click', handlers.click);
    doc?.removeEventListener('keydown', handlers.keydown);
    doc?.removeEventListener('visibilitychange', handlers.reconcile);
    doc?.getElementById('allow_card_scripts')?.removeEventListener('input', handlers.setting);
    doc?.querySelector('#chat')?.removeEventListener('scroll', handlers.scroll);
    lifecycleEvents.forEach(name => event_types[name] && eventSource.removeListener(event_types[name], handlers.reconcile));
    eventSource.removeListener(event_types.MESSAGE_EDITED, handlers.edited);
    eventSource.removeListener(event_types.MESSAGE_DELETED, handlers.deleted);
    observer?.disconnect();
    intersectionObserver?.disconnect();
    observer = intersectionObserver = null;
    observedMessages.clear();
    initialized = false;
}

export function resetCardScriptRuntimeForTests() {
    teardownCardScriptRuntime();
    dependencies = { ...defaults };
    consentPromise = null;
    consentAccepted = consentDeclined = false;
    pageProtection = null;
}

export function resetCardScriptSession({ clearSnapshots = false } = {}) {
    epoch++;
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
    pendingStarts.clear();
    for (const sandbox of [...activeSandboxes.values()]) destroyRecord(sandbox);
    stoppedMessages.clear();
    streamingMessages.clear();
    unprotectedAcknowledgements.clear();
    for (const notice of isolationNotices.values()) notice.element.remove();
    isolationNotices.clear();
    if (clearSnapshots) {
        chatScope++;
        forgetAllCardScripts();
    }
}

/** Changes only when snapshots are discarded, so a swipe (which bumps the chat generation) keeps other messages runnable. */
export function getCardScriptChatScope() { return chatScope; }

export function setCardScriptMessageStreaming(messageId, streaming) {
    const id = normalizeMessageId(messageId);
    if (id === null) return;
    if (streaming) {
        streamingMessages.add(id);
        destroySandbox(id, { reason: 'stream' });
    } else streamingMessages.delete(id);
}

export function scheduleCardScriptReconcile() {
    if (reconcileTimer !== null) return;
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void reconcileAllMessages();
    }, 0);
}

async function reconcileAllMessages() {
    const generation = epoch;
    const enabled = await isCardScriptRuntimeEnabled();
    if (generation !== epoch) return;
    if (!enabled) {
        for (const record of [...activeSandboxes.values()]) destroyRecord(record);
        for (const notice of isolationNotices.values()) notice.element.remove();
        isolationNotices.clear();
    }
    for (const [id, notice] of isolationNotices) {
        if (!revisionMatches(notice.revision) || !notice.element.isConnected) { notice.element.remove(); isolationNotices.delete(id); }
    }
    for (const record of [...activeSandboxes.values()]) {
        if (!isCurrent(record) || !visibility(record.messageElement).near) destroyRecord(record);
    }
    // Only messages that carry a card script, a mount or a shown control need work; plain chats stay cheap on every scroll and stream write.
    const messages = Array.from(dependencies.getDocument()?.querySelectorAll('#chat .mes[mesid]') ?? []).filter(element => {
        const button = element.querySelector(CARD_SCRIPT_RUN_BUTTON_SELECTOR);
        return element.querySelector(CARD_SCRIPT_MARKER_TAG) || element.querySelector('.card-script-sandbox-slot') || (button && button.style.display !== 'none');
    });
    for (const element of observedMessages) {
        if (!element.isConnected) { intersectionObserver?.unobserve(element); observedMessages.delete(element); }
    }
    const ranked = messages.map(element => ({ element, visible: visibility(element).visible })).sort((a, b) => Number(b.visible) - Number(a.visible));
    for (const { element } of ranked) {
        if (!observedMessages.has(element)) { observedMessages.add(element); intersectionObserver?.observe(element); }
        const id = normalizeMessageId(element.getAttribute('mesid'));
        await syncCardScriptButtonForMessage(id, { messageElement: element, enabled });
        if (generation !== epoch) return;
        if (enabled && visibility(element).near && !dependencies.getDocument()?.hidden) void reconcileCardScriptMessage(id);
    }
}

export async function reconcileCardScriptMessage(messageId) {
    try { return await createSandbox(messageId); } catch (error) {
        const revision = getRevision(normalizeMessageId(messageId));
        if (revision) stoppedMessages.set(revision.messageId, revision);
        console.warn('Could not start card script sandbox.', error);
        if (error.reason !== 'policy_disabled') startFailure();
        return null;
    }
}

export function createSandbox(messageId, { manual = false, allowUnprotected = false } = {}) {
    const id = normalizeMessageId(messageId);
    if (id === null) return Promise.reject(runtimeError('bad_message_id'));
    if (pendingStarts.has(id)) return pendingStarts.get(id);
    const revision = getRevision(id);
    const promise = startMessage(id, manual, allowUnprotected).finally(() => {
        if (pendingStarts.get(id) !== promise) return;
        pendingStarts.delete(id);
        const current = getRevision(id);
        if (revision && current && (revision.snapshot.hash !== current.snapshot.hash || revision.messageElement !== current.messageElement || revision.textElement !== current.textElement)) scheduleCardScriptReconcile();
    });
    pendingStarts.set(id, promise);
    return promise;
}

async function startMessage(id, manual, allowUnprotected) {
    for (const record of getRecords(id)) if (!isCurrent(record)) destroyRecord(record);
    const revision = getRevision(id);
    if (!revision) return null;
    if (!await isCardScriptRuntimeEnabled()) throw runtimeError('policy_disabled');
    if (!revisionMatches(revision) || !eligible(revision) || !visibility(revision.messageElement).near || dependencies.getDocument()?.hidden) return null;
    if (manual) { stoppedMessages.delete(id); consentDeclined = false; }
    const window = dependencies.getWindow();
    if (hasUngatedAndroidBridge(window) || pageProtection === 'android-bridge') {
        showIsolationNotice(revision, 'android-bridge');
        return null;
    }
    if (manual && allowUnprotected) unprotectedAcknowledgements.set(id, revision);
    const acknowledged = sameContent(unprotectedAcknowledgements.get(id), revision);
    if (pageProtection === 'unsupported' && !acknowledged) {
        showIsolationNotice(revision, 'unsupported');
        return null;
    }
    if (sameContent(stoppedMessages.get(id), revision) || (!manual && consentDeclined)) return null;
    const existing = getActiveSandbox(id);
    const count = revision.snapshot.blocks.length || 1;
    if (existing && isCurrent(existing) && getRecords(id).length === count) return existing;
    const targets = revision.snapshot.blocks.length
        ? revision.snapshot.blocks.map((block, index) => ({ html: block.html, target: revision.textElement.querySelector(`pre[data-card-script-block="${index}"]`), index }))
        : [{ html: revision.snapshot.html, target: revision.textElement, index: 0 }];
    for (const item of targets) {
        const key = `${id}:${item.index}`;
        if (activeSandboxes.has(key) || !item.target?.isConnected) continue;
        if (activeSandboxes.size >= MAX_ACTIVE_CARD_SCRIPT_SANDBOXES) {
            const evict = [...activeSandboxes.values()].find(record => !visibility(record.messageElement).visible && !record.slot.contains(dependencies.getDocument().activeElement));
            if (!visibility(revision.messageElement).visible || !evict) break;
            destroyRecord(evict);
        }
        const doc = dependencies.getDocument();
        const nonce = dependencies.createNonce();
        const cardNonce = dependencies.createNonce();
        if (!nonce || !cardNonce) throw runtimeError('missing_crypto');
        const frame = doc.createElement('iframe');
        frame.className = 'card-script-sandbox-frame';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.setAttribute('allow', CARD_SCRIPT_PERMISSIONS);
        frame.title = t`Interactive card content`;
        Object.assign(frame.style, { display: 'block', width: '100%', height: '160px', border: '0' });
        frame.setAttribute('src', `${CARD_SCRIPT_SANDBOX_PATH}?v=${CARD_SCRIPT_PROTOCOL_VERSION}#${new URLSearchParams({ protocol: String(CARD_SCRIPT_PROTOCOL_VERSION), messageId: String(id), nonce })}`);
        const slot = doc.createElement('div');
        slot.className = 'card-script-sandbox-slot';
        slot.hidden = true;
        slot.style.display = 'none';
        const blockMount = item.target !== revision.textElement;
        if (blockMount) item.target.after(slot);
        else revision.textElement.appendChild(slot);
        slot.appendChild(frame);
        const record = { ...revision, key, nonce, cardNonce, html: item.html, slot, fallback: null, blockMount, target: item.target, iframeElement: frame, iframeWindow: frame.contentWindow, createdAt: dependencies.now(), rateLimiter: dependencies.createRateLimiter(), resizeLimiter: dependencies.createRateLimiter({ windowMs: 1000, perWindow: 10, lifetimeMax: Infinity }), height: 160, resizeFrame: null, ready: false, state: 'loading', initialized: false, loaded: false };
        activeSandboxes.set(key, record);
        frame.addEventListener('load', () => {
            if (record.loaded && activeSandboxes.get(key) === record) failRecord(record);
            record.loaded = true;
        });
        record.timeout = setTimeout(() => failRecord(record), 15000);
    }
    void syncCardScriptButtonForMessage(id);
    return getActiveSandbox(id);
}

function hasUngatedAndroidBridge(window) {
    try {
        return ['NeconyanExport', 'NeconyanAndroid'].some(name => window?.[name] && window[name].bridgeRequiresToken?.() !== true);
    } catch { return true; }
}

function getRevision(id) {
    const messageElement = dependencies.getDocument()?.querySelector(`#chat .mes[mesid="${id}"]`);
    const textElement = messageElement?.querySelector('.mes_text');
    const snapshot = dependencies.getCardScriptSnapshot(id);
    if (!messageElement?.isConnected || !textElement || !snapshot) return null;
    const message = dependencies.getMessage(id);
    return { messageId: id, messageElement, textElement, snapshot, scope: String(dependencies.getChatScope()), message, raw: message?.mes, displayText: message?.extra?.display_text, swipe: message?.swipe_id, epoch };
}

function sameContent(a, b) {
    return a && b && a.message === b.message && a.raw === b.raw && a.displayText === b.displayText && a.scope === b.scope && a.swipe === b.swipe && a.snapshot.hash === b.snapshot.hash;
}

function revisionMatches(revision) {
    const current = getRevision(revision.messageId);
    return revision.epoch === epoch && sameContent(revision, current) && revision.messageElement === current.messageElement && revision.textElement === current.textElement && revision.snapshot.scopeKey === current.scope;
}

function eligible(revision) {
    return !streamingMessages.has(revision.messageId) && !dependencies.isMessageStreaming(revision.messageId) && !dependencies.isMessageEditing(revision.messageId) && (getRecords(revision.messageId).some(isCurrent) || messageHasCardScriptMarker(revision.messageElement, revision.messageId));
}

function isCurrent(record) {
    const owned = record.initialized
        ? record.textElement.contains(record.slot) && (record.blockMount || (record.textElement.childNodes.length === 1 && record.textElement.firstChild === record.slot))
        : record.textElement.contains(record.slot);
    return activeSandboxes.get(record.key) === record && revisionMatches(record) && record.slot.isConnected && owned && !streamingMessages.has(record.messageId) && !dependencies.isMessageStreaming(record.messageId) && !dependencies.isMessageEditing(record.messageId);
}

function visibility(element) {
    const chat = dependencies.getDocument()?.querySelector('#chat');
    if (!element?.isConnected || !element.getClientRects().length || !chat?.getClientRects().length) return { near: false, visible: false };
    const bounds = element.getBoundingClientRect();
    const container = chat.getBoundingClientRect();
    return { near: bounds.bottom >= container.top - 600 && bounds.top <= container.bottom + 600, visible: bounds.bottom >= container.top && bounds.top <= container.bottom };
}

function readTheme(element) {
    const style = dependencies.getComputedStyle(element);
    const bodyStyle = dependencies.getComputedStyle(dependencies.getDocument().body);
    const link = element.querySelector('a');
    return { color: style.color, backgroundColor: bodyStyle.getPropertyValue('--neco-surface').trim() || bodyStyle.backgroundColor, fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight, linkColor: link ? dependencies.getComputedStyle(link).color : bodyStyle.getPropertyValue('--neco-ginger').trim(), colorScheme: bodyStyle.colorScheme };
}

async function handleBootstrapStatus(record, data) {
    if (record.state !== 'loading') return { ok: false, reason: 'duplicate_bootstrap' };
    record.state = data.protection;
    clearTimeout(record.timeout);
    if (data.protection !== 'protected') {
        pageProtection = data.protection;
        if (data.protection === 'android-bridge' || !sameContent(unprotectedAcknowledgements.get(record.messageId), record)) {
            showIsolationNotice(record, data.protection);
            destroyRecord(record);
            return { ok: true, protection: data.protection };
        }
    } else {
        // A native proof from a trusted outer means a slower earlier check timed out; let other cards auto-run again.
        if (pageProtection === 'unsupported') pageProtection = null;
        record.state = 'waiting-consent';
        if (!await confirmCardScriptExecution()) {
            if (activeSandboxes.get(record.key) === record) destroyRecord(record);
            return { ok: false, reason: 'consent_declined' };
        }
    }
    if (!await isCardScriptRuntimeEnabled() || !isCurrent(record) || !visibility(record.messageElement).near || dependencies.getDocument()?.hidden) {
        if (activeSandboxes.get(record.key) === record) destroyRecord(record);
        return { ok: false, reason: 'stale_sandbox' };
    }
    if (data.protection === 'unsupported' && !sameContent(unprotectedAcknowledgements.get(record.messageId), record)) return { ok: false, reason: 'missing_acknowledgement' };
    initialiseRecord(record, data.protection);
    return { ok: true, protection: data.protection };
}

function initialiseRecord(record, protection) {
    if (!isCurrent(record) || record.initialized) return;
    const doc = dependencies.getDocument();
    const data = {
        type: INIT_MESSAGE_TYPE, version: MESSAGE_VERSION, protocol: CARD_SCRIPT_PROTOCOL_VERSION,
        messageId: record.messageId, nonce: record.nonce, cardNonce: record.cardNonce,
        document: dependencies.buildCardDocument({ html: record.html, messageId: record.messageId, nonce: record.cardNonce, theme: readTheme(record.textElement) }),
        title: t`Interactive card content`, allowUnprotected: protection === 'unsupported',
    };
    if (!validateInitMessage(data).ok) { failRecord(record); return; }
    const notice = isolationNotices.get(record.messageId);
    notice?.element.remove();
    isolationNotices.delete(record.messageId);
    record.fallback = doc.createDocumentFragment();
    if (record.blockMount) record.target.remove();
    else { for (const node of [...record.textElement.childNodes]) if (node !== record.slot) record.fallback.appendChild(node); }
    record.slot.hidden = false;
    record.slot.style.display = '';
    record.initialized = true;
    record.state = 'initialising';
    record.protection = protection;
    record.textElement.dataset.cardScriptActive = 'true';
    record.iframeWindow.postMessage(data, '*');
    record.timeout = setTimeout(() => failRecord(record), 15000);
    void syncCardScriptButtonForMessage(record.messageId);
}

function failRecord(record) {
    if (activeSandboxes.get(record.key) !== record) return;
    stoppedMessages.set(record.messageId, record);
    destroySandbox(record.messageId, { reason: 'failed' });
    startFailure();
}

function showIsolationNotice(revision, reason) {
    const existing = isolationNotices.get(revision.messageId);
    if (existing?.element.isConnected && sameContent(existing.revision, revision) && existing.reason === reason) return;
    existing?.element.remove();
    const doc = dependencies.getDocument();
    const element = doc.createElement('div');
    element.className = 'card-script-isolation-notice';
    const text = doc.createElement('p');
    text.textContent = reason === 'android-bridge'
        ? t`Update the Android app before running card scripts. This older app doesn't restrict embedded pages from its export and update controls.`
        : t`This browser can't block direct connections. This card could send its own content and anything you type into it to outside servers. Run it only if you trust it.`;
    element.appendChild(text);
    if (reason === 'unsupported') {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'menu_button menu_button_primary card-script-run-anyway';
        button.textContent = t`Run anyway`;
        button.dataset.msgId = String(revision.messageId);
        element.appendChild(button);
    }
    revision.textElement.appendChild(element);
    isolationNotices.set(revision.messageId, { revision, element, reason });
}

export async function handleSandboxMessage(event) {
    const record = [...activeSandboxes.values()].find(item => item.iframeWindow === event?.source);
    if (!record) return { ok: false, reason: 'unknown_source' };
    const validator = event.data?.type === BOOTSTRAP_MESSAGE_TYPE ? validateBootstrapMessage : event.data?.type === RESIZE_MESSAGE_TYPE ? validateResizeMessage : event.data?.type === READY_MESSAGE_TYPE ? validateReadyMessage : validateSlashRequestMessage;
    const result = validator(event.data);
    if (!result.ok) return result;
    const data = result.value;
    if (data.nonce !== record.nonce) return { ok: false, reason: 'bad_nonce' };
    if (data.messageId !== record.messageId) return { ok: false, reason: 'bad_message_id' };
    if (!await isCardScriptRuntimeEnabled() || !isCurrent(record)) return { ok: false, reason: 'stale_sandbox' };
    if (data.type === BOOTSTRAP_MESSAGE_TYPE) return handleBootstrapStatus(record, data);
    if (!record.initialized) return { ok: false, reason: 'not_initialized' };
    if (data.type === READY_MESSAGE_TYPE) { record.ready = true; record.state = 'running'; clearTimeout(record.timeout); return { ok: true }; }
    const limit = (data.type === RESIZE_MESSAGE_TYPE ? record.resizeLimiter : record.rateLimiter).tryAcquire();
    if (!limit.ok) return limit;
    if (data.type === RESIZE_MESSAGE_TYPE) {
        const height = Math.max(48, Math.min(4096, Math.ceil(data.height)));
        if (height !== record.height) {
            record.height = height;
            if (record.resizeFrame === null) record.resizeFrame = dependencies.getWindow().requestAnimationFrame(() => {
                record.resizeFrame = null;
                if (isCurrent(record)) record.iframeElement.style.height = `${record.height}px`;
            });
        }
        return { ok: true };
    }
    return executeSandboxCommand(data.command, record.messageId, { record });
}

export async function executeSandboxCommand(command, messageId, { record = getActiveSandbox(messageId) } = {}) {
    if (!record) return { ok: false, reason: 'sandbox_not_found' };
    if (!record.initialized) return { ok: false, reason: 'not_initialized' };
    const policy = await getCardScriptRuntimePolicy();
    if (!isCurrent(record)) return { ok: false, reason: 'stale_sandbox' };
    const parsed = parseSlashCommandRequest(command, policy);
    if (!parsed.ok) return parsed;
    const executor = dependencies.executeSlashCommandsWithOptions ?? await dependencies.getSlashExecutor();
    if (!await isCardScriptRuntimeEnabled() || !isCurrent(record)) return { ok: false, reason: 'stale_sandbox' };
    if (typeof executor !== 'function') return { ok: false, reason: 'missing_slash_executor' };
    try {
        const safeCommand = parsed.commands.map(command => command.replace(/^\/echo(?: |$)/, '/echo escapeHtml=true ')).join('|');
        await executor(safeCommand, { handleParserErrors: false, handleExecutionErrors: true, parserFlags: { ...CARD_SCRIPT_PARSER_FLAGS }, source: `card-script-sandbox:${record.messageId}` });
        return { ok: true };
    } catch (error) {
        console.warn('Card script command failed.', error);
        return { ok: false, reason: 'execution_failed' };
    }
}

export function destroySandbox(messageId, { reason = 'stop', restore = true } = {}) {
    const id = normalizeMessageId(messageId);
    if (reason === 'stop') {
        const revision = getRevision(id);
        if (revision) stoppedMessages.set(id, revision);
    }
    const records = getRecords(id);
    records.forEach(record => destroyRecord(record, restore));
    return records.length > 0;
}

function destroyRecord(record, restore = true) {
    activeSandboxes.delete(record.key);
    clearTimeout(record.timeout);
    if (record.resizeFrame !== null) dependencies.getWindow()?.cancelAnimationFrame(record.resizeFrame);
    record.rateLimiter.dispose();
    record.resizeLimiter.dispose();
    if (record.initialized && restore && record.slot.parentNode && record.textElement.contains(record.slot)) {
        if (record.blockMount) record.slot.replaceWith(record.target);
        else if (record.textElement.childNodes.length === 1 && record.textElement.firstChild === record.slot) record.slot.replaceWith(record.fallback);
    }
    record.iframeElement.remove();
    record.slot.remove();
    if (!getRecords(record.messageId).length) delete record.textElement.dataset.cardScriptActive;
    void syncCardScriptButtonForMessage(record.messageId);
}

export function destroyAllSandboxes() { resetCardScriptSession(); }
export function getActiveSandboxCount() { return activeSandboxes.size; }
export function getActiveSandbox(id) { return getRecords(normalizeMessageId(id))[0] ?? null; }
export function isSandboxActive(id) { return getRecords(normalizeMessageId(id)).some(record => record.initialized && isCurrent(record)); }
function getRecords(id) { return [...activeSandboxes.values()].filter(record => record.messageId === id); }

export async function syncAllCardScriptButtons() {
    for (const element of dependencies.getDocument()?.querySelectorAll('#chat .mes[mesid]') ?? []) await syncCardScriptButtonForMessage(element.getAttribute('mesid'));
}

export async function syncCardScriptButtonForMessage(messageId, { messageElement = null, enabled = null } = {}) {
    const id = normalizeMessageId(messageId);
    const element = messageElement ?? dependencies.getDocument()?.querySelector(`#chat .mes[mesid="${id}"]`);
    const button = element?.querySelector(CARD_SCRIPT_RUN_BUTTON_SELECTOR);
    if (!button) return false;
    enabled ??= await isCardScriptRuntimeEnabled();
    const active = isSandboxActive(id);
    const visible = enabled && (active || messageHasCardScriptMarker(element, id));
    button.style.display = visible ? '' : 'none';
    button.classList.toggle('script-running', active);
    button.classList.toggle('fa-play', !active);
    button.classList.toggle('fa-stop', active);
    const label = active ? t`Stop card scripts` : stoppedMessages.has(id) ? t`Restart card scripts` : t`Run card scripts`;
    button.setAttribute('title', label);
    button.removeAttribute?.('data-i18n');
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(active));
    return visible;
}

export function messageHasCardScriptMarker(element, messageId) {
    const snapshot = dependencies.getCardScriptSnapshot(messageId);
    return Boolean(snapshot && Array.from(element?.querySelectorAll(CARD_SCRIPT_MARKER_TAG) ?? []).some(marker => marker.dataset.msgId === String(messageId) && marker.dataset.cardScriptHash === snapshot.hash && marker.dataset.cardScriptScope === snapshot.scopeKey));
}

export async function isCardScriptRuntimeEnabled() { return Boolean((await dependencies.getPowerUser())?.allow_card_scripts); }
export async function getCardScriptRuntimePolicy() { return createDefaultPolicy({ mode: await isCardScriptRuntimeEnabled() ? POLICY_MODES.ALLOWLIST : POLICY_MODES.DISABLED }); }
export function normalizeMessageId(id) { return id !== null && id !== undefined && id !== '' && Number.isSafeInteger(Number(id)) && Number(id) >= 0 ? Number(id) : null; }

async function handleRunButtonClick(event) {
    const override = event.target?.closest?.('.card-script-run-anyway');
    if (override) {
        event.preventDefault();
        event.stopPropagation();
        const id = normalizeMessageId(override.dataset.msgId);
        const notice = isolationNotices.get(id);
        if (!notice || notice.reason !== 'unsupported' || !notice.element.contains(override) || !revisionMatches(notice.revision)) return;
        try { await createSandbox(id, { manual: true, allowUnprotected: true }); } catch (error) { console.warn('Card scripts could not start.', error); startFailure(); }
        return;
    }
    const button = event.target?.closest?.(CARD_SCRIPT_RUN_BUTTON_SELECTOR);
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const id = normalizeMessageId(button.closest('.mes')?.getAttribute('mesid'));
    if (isSandboxActive(id)) { destroySandbox(id); return; }
    try { await createSandbox(id, { manual: true }); } catch (error) { console.warn('Card scripts could not start.', error); startFailure(); }
}

function startFailure() {
    dependencies.toastr()?.warning?.(t`Could not start card scripts for this message. Try Restart.`, t`Card scripts could not start`, { timeOut: 6000, preventDuplicates: true });
}

async function confirmCardScriptExecution() {
    if (consentAccepted) return true;
    let storage;
    try {
        storage = dependencies.getLocalStorage();
        if (storage?.getItem(CARD_SCRIPT_CONFIRMATION_STORAGE_KEY) === 'true') { consentAccepted = true; return true; }
    } catch { /* Device storage may be unavailable. */ }
    if (consentPromise) return consentPromise;
    consentPromise = (async () => {
        const accepted = dependencies.showConfirmation ? Boolean(await dependencies.showConfirmation()) : await showConfirmation();
        consentAccepted = accepted;
        consentDeclined = !accepted;
        if (accepted) { try { storage?.setItem(CARD_SCRIPT_CONFIRMATION_STORAGE_KEY, 'true'); } catch { /* Acceptance remains valid for this page. */ } }
        return accepted;
    })().finally(() => { consentPromise = null; });
    return consentPromise;
}

async function showConfirmation() {
    const { callGenericPopup, POPUP_RESULT, POPUP_TYPE } = await import('./popup.js');
    const result = await callGenericPopup(`<h3>${t`Allow automatic card scripts?`}</h3><p>${t`Script content will run automatically in chats on this device while 'Allow card scripts' is on, when your browser can block direct connections. Scripts run in a sandbox with restricted access to Neconyan.`}</p><p>${t`Only keep this on for cards you trust. Other browsers need a separate 'Run anyway' choice for each card. You can turn scripts off in Settings or stop an individual message.`}</p>`, POPUP_TYPE.CONFIRM, null, { okButton: t`Allow automatic scripts`, cancelButton: t`Cancel` });
    return result === POPUP_RESULT.AFFIRMATIVE;
}

function createSecureNonce() {
    const crypto = globalThis.crypto;
    if (crypto?.randomUUID) return crypto.randomUUID();
    if (!crypto?.getRandomValues) throw runtimeError('missing_crypto');
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function runtimeError(reason) { return Object.assign(new Error(`Card scripts could not start: ${reason}`), { reason }); }
