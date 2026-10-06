/**
 * Scratchpad: a private planning chat with Miso, Taro or Nori that sits beside
 * the story. Nothing written here goes into the chat unless the user presses
 * Save change on a reviewed suggestion.
 */
import { getActiveGenerationAcknowledgement, messageFormatting, saveSettings } from '../../script.js';
import { loadStylesheetAsync } from '../dynamic-styles.js';
import { event_types, eventSource } from '../events.js';
import { extension_settings } from '../extensions.js';
import { t } from '../i18n.js';
import { getAssistantGender, getAssistantIconSrc } from '../neconyan-assistant-art.js';
import { append, clear, h } from '../notebooks/dom.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';
import { accountStorage } from '../util/AccountStorage.js';
import * as api from './api.js';
import { prepareChange } from './changes.js';
import {
    buildContext,
    buildHelp,
    collectLore,
    currentSource,
    estimateTokens,
    isCurrentSource,
    loreOverrideKey,
    loreScanText,
    sourceConnectionProfile,
    sourceMessages,
    sourceUserName,
    setNotebookSource,
    wireSource,
} from './context.js';
import { describeChange, splitReply } from './proposals.js';
import { chooseNote, sessionNoteText } from './notebooks.js';

const STYLESHEET = 'css/neconyan-scratchpad.css?v=20261006-scratchpad-notes2';
const PHONE_QUERY = '(max-width: 768px)';
const PREFS_KEY = 'neconyanScratchpad';
const DEFAULT_WIDTH = 420;
const SOURCE_POLL_MS = 1500;
const PICK_PAGE = 30;
const SESSION_TEXT_MESSAGES = 6;
const ACK_ATTEMPTS = 4;

const ASSISTANTS = Object.freeze([
    { id: 'miso', name: 'Miso' },
    { id: 'taro', name: 'Taro' },
    { id: 'nori', name: 'Nori' },
]);

function assistantRole(id) {
    if (id === 'taro') return t`Careful troubleshooter`;
    if (id === 'nori') return t`Playful writing partner`;
    return t`Cheerful guide`;
}

function quickPrompts() {
    if (app.source?.kind === 'notebook') return [
        { label: t`Summarise note`, text: t`Summarise the shared note, keeping its important details.` },
        { label: t`Develop ideas`, text: t`Suggest three ways to develop the ideas in the shared note.` },
        { label: t`Check consistency`, text: t`Check the shared note for contradictions, missing details and unclear passages.` },
        { label: t`Suggest edits`, text: t`Suggest focused improvements to the shared note. Propose changes only where the shared permissions allow them.` },
    ];
    return [
        { label: t`Read the scene`, text: t`Read the current scene and tell me what each character wants and what is driving them right now.` },
        { label: t`Plot ideas`, text: t`Give me three ideas for where the story could go next, each with a different tone.` },
        { label: t`Catch me up`, text: t`Summarise what has happened so far in a few short paragraphs.` },
        { label: t`Continuity check`, text: t`Check the recent messages for contradictions, slipped details or anything that does not match the characters or lore.` },
        { label: t`Lore gaps`, text: t`Which people, places or things in this chat deserve a lorebook entry that they do not have yet? Suggest the entries.` },
    ];
}

const DEFAULT_SETTINGS = Object.freeze({
    depth: 15,
    picked: [],
    notes: [],
    include: { card: true, persona: true, authorsNote: true, lore: true, hidden: false },
    loreOverrides: {},
    connection: { kind: 'current' },
    assistantConnections: {},
    roundTable: false,
    participants: ['miso', 'taro', 'nori'],
    maxTokens: 16000,
});

const app = {
    built: false,
    open: false,
    layout: 'beside',
    width: DEFAULT_WIDTH,
    assistant: 'miso',
    connections: {},
    tab: 'chat',
    overviewCollapsed: false,
    source: null,
    bucket: null,
    ticket: 0,
    sending: false,
    editing: '',
    drafts: new Map(),
    draftKey: '',
    previews: new Map(),
    watchers: new Map(),
    pickLimit: PICK_PAGE,
    sessionQuery: '',
    contextKey: '',
    timer: 0,
    queue: Promise.resolve(),
    el: {},
};

function isPhone() {
    return globalThis.matchMedia?.(PHONE_QUERY).matches === true;
}

function readPrefs() {
    try {
        const saved = JSON.parse(accountStorage.getItem(PREFS_KEY) || '{}');
        if (saved.layout === 'full' || saved.layout === 'beside') app.layout = saved.layout;
        if (Number.isFinite(saved.width)) app.width = saved.width;
        if (ASSISTANTS.some(item => item.id === saved.assistant)) app.assistant = saved.assistant;
        if (typeof saved.collapsed === 'boolean') app.overviewCollapsed = saved.collapsed;
        for (const { id } of ASSISTANTS) {
            const connection = saved.connections?.[id];
            if (connection?.kind === 'current') app.connections[id] = { kind: 'current' };
            if (connection?.kind === 'profile' && typeof connection.profileId === 'string' && connection.profileId) {
                app.connections[id] = { kind: 'profile', profileId: connection.profileId };
            }
        }
    } catch {
        /* Defaults are fine when the saved preferences cannot be read. */
    }
}

function writePrefs() {
    accountStorage.setItem(PREFS_KEY, JSON.stringify({
        layout: app.layout,
        width: app.width,
        assistant: app.assistant,
        collapsed: app.overviewCollapsed,
        connections: app.connections,
    }));
}

/** Each assistant's last connection choice, so chats without a Scratchpad session start with it. */
function rememberedConnections() {
    const profiles = new Set(connectionProfiles().map(item => item.id));
    return Object.fromEntries(Object.entries(app.connections)
        .filter(([, connection]) => connection.kind === 'current' || profiles.has(connection.profileId)));
}

function sessionInput(extra = {}) {
    const input = { assistant: app.assistant, gender: getAssistantGender(app.assistant), ...extra };
    if (!activeSession()) input.settings = { assistantConnections: rememberedConnections() };
    return input;
}

function assistantInfo(id) {
    return ASSISTANTS.find(item => item.id === id) ?? ASSISTANTS[0];
}

function activeSession() {
    const bucket = app.bucket;
    if (!bucket) return null;
    return bucket.sessions.find(item => item.id === bucket.activeSessionId) ?? null;
}

function currentSettings() {
    return activeSession()?.settings ?? { ...structuredClone(DEFAULT_SETTINGS), assistantConnections: rememberedConnections() };
}

function assistantConnection(settings, assistant) {
    return settings.assistantConnections?.[assistant] ?? settings.connection ?? { kind: 'current' };
}

function sessionAssistants(session = activeSession()) {
    return session?.settings.roundTable ? session.settings.participants : [session?.assistant ?? app.assistant];
}

function pendingReply(session = activeSession()) {
    return session?.messages.find(item => item.role === 'assistant' && item.state === 'pending') ?? null;
}

function dockedWidth() {
    const sidebar = Number.parseFloat(getComputedStyle(document.body).getPropertyValue('--neco-sidebar-offset')) || 0;
    const pinned = document.querySelector('#right-nav-panel.openDrawer.pinnedOpen');
    return sidebar + (pinned instanceof HTMLElement ? pinned.getBoundingClientRect().width : 0);
}

function clampWidth(width, reserved = 0) {
    return Math.round(Math.max(320, Math.min(Number(width) || DEFAULT_WIDTH, globalThis.innerWidth - reserved - 360)));
}

function iconButton(label, onClick, { icon = '', className = '', title = '', pressed = null, disabled = false, primary = false } = {}) {
    const element = h('button', {
        type: 'button',
        class: `menu_button scratchpad-button ${className}${primary || pressed ? ' menu_button_primary' : ''}`.trim(),
        title: title || null,
        'aria-pressed': pressed === null ? null : String(Boolean(pressed)),
        disabled,
        onclick: onClick,
    });
    if (icon) element.append(h('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }));
    if (label) element.append(h('span', { text: label }));
    if (!label && title) element.setAttribute('aria-label', title);
    return element;
}

function reportError(error, fallback) {
    const message = error?.message || fallback;
    console.warn('[Scratchpad]', error);
    toastr.error(message);
}

/* Layout */

function applyLayout() {
    const root = app.el.root;
    if (!root) return;
    const phone = isPhone();
    const layout = phone ? 'phone' : app.layout;
    root.dataset.layout = layout;
    app.el.layoutButton.hidden = phone;
    const toggleLabel = app.layout === 'full' ? t`Beside chat` : t`Full width`;
    app.el.layoutButton.querySelector('span').textContent = toggleLabel;
    app.el.layoutButton.title = toggleLabel;
    app.el.layoutButton.querySelector('i').className = `fa-solid ${app.layout === 'full' ? 'fa-table-columns' : 'fa-expand'}`;
    document.body.classList.toggle('neconyan-scratchpad-open', app.open);
    document.body.classList.toggle('neconyan-scratchpad-beside', app.open && layout === 'beside');
    document.body.style.setProperty('--neco-scratchpad-width', `${clampWidth(app.width, dockedWidth())}px`);
}

function startResize(event) {
    if (isPhone() || app.layout !== 'beside') return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const rightEdge = app.el.root.getBoundingClientRect().right;
    const move = moveEvent => {
        app.width = clampWidth(rightEdge - moveEvent.clientX);
        applyLayout();
    };
    const stop = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
        writePrefs();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
}

function resizeWithKeys(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    app.width = clampWidth(clampWidth(app.width, dockedWidth()) + (event.key === 'ArrowLeft' ? 32 : -32));
    applyLayout();
    writePrefs();
}

/* Building */

function build() {
    if (app.built) return;
    app.built = true;
    const el = app.el;

    el.portrait = h('img', { class: 'scratchpad-portrait', alt: '', width: 36, height: 36 });
    el.sourceLabel = h('p', { class: 'scratchpad-source' });
    el.layoutButton = iconButton(t`Full width`, () => {
        app.layout = app.layout === 'full' ? 'beside' : 'full';
        writePrefs();
        applyLayout();
    }, { icon: 'fa-expand', className: 'scratchpad-layout-toggle' });
    el.newSession = iconButton(t`New session`, () => void newSession(false), { icon: 'fa-plus', className: 'scratchpad-new-session', title: t`Start a new Scratchpad session` });
    el.close = iconButton(t`Back to chat`, () => {
        if (app.source?.kind === 'notebook') void openNotebook(app.source);
        else hideScratchpad();
    }, { icon: 'fa-comments', className: 'scratchpad-close' });

    el.tabs = {};
    el.panels = {};
    const tabList = h('div', { class: 'scratchpad-tabs', role: 'tablist', 'aria-label': t`Scratchpad sections` });
    for (const [key, label, icon] of [['chat', t`Chat`, 'fa-comments'], ['context', t`Context`, 'fa-book-open'], ['sessions', t`Sessions`, 'fa-folder-open']]) {
        const tab = h('button', {
            type: 'button',
            role: 'tab',
            id: `scratchpad-tab-${key}`,
            class: 'scratchpad-tab',
            'aria-controls': `scratchpad-panel-${key}`,
            onclick: () => selectTab(key),
        }, h('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }), h('span', { text: label }));
        el.tabs[key] = tab;
        tabList.append(tab);
        el.panels[key] = h('div', { class: `scratchpad-panel scratchpad-panel-${key}`, role: 'tabpanel', id: `scratchpad-panel-${key}`, 'aria-labelledby': `scratchpad-tab-${key}` });
    }

    buildChatPanel();

    el.root = h('section', { id: 'neconyan-scratchpad', class: 'scratchpad-app', 'aria-label': t`Scratchpad`, hidden: true },
        h('div', {
            class: 'scratchpad-resizer',
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': t`Resize Scratchpad`,
            tabindex: '0',
            onpointerdown: startResize,
            onkeydown: resizeWithKeys,
        }),
        h('header', { class: 'scratchpad-header' },
            el.portrait,
            h('div', { class: 'scratchpad-title' },
                h('h2', { class: 'scratchpad-heading', text: t`Scratchpad` }),
                el.sourceLabel),
            h('div', { class: 'scratchpad-header-actions' }, el.newSession, el.layoutButton, el.close)),
        tabList,
        h('div', { class: 'scratchpad-body' }, el.panels.chat, el.panels.context, el.panels.sessions));
    document.body.append(el.root);

    globalThis.matchMedia?.(PHONE_QUERY).addEventListener?.('change', () => app.open && applyLayout());
    globalThis.addEventListener('resize', () => app.open && applyLayout());
    const characterPanel = document.getElementById('right-nav-panel');
    if (characterPanel) new MutationObserver(() => app.open && applyLayout()).observe(characterPanel, { attributes: true, attributeFilter: ['class'] });
    eventSource.on(event_types.CHAT_CHANGED, () => app.open && checkSource());
    globalThis.addEventListener('sb:conversation-workspace-state-changed', () => app.open && checkSource());
    globalThis.addEventListener('neconyan:assistant-gender-changed', () => app.open && renderHeader());
}

function buildChatPanel() {
    const el = app.el;
    el.roundTable = iconButton(t`Round table`, () => void updateSettings(settings => ({ roundTable: !settings.roundTable })),
        { icon: 'fa-users', pressed: false, className: 'scratchpad-round-table', title: t`Ask up to three assistants together` });
    el.assistantPicker = h('div', { class: 'scratchpad-assistants', role: 'group', 'aria-label': t`Talking with` });
    el.summary = h('div', { class: 'scratchpad-summary' });
    el.messages = h('div', { class: 'scratchpad-messages', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    el.quick = h('div', { class: 'scratchpad-quick', role: 'group', 'aria-label': t`Quick prompts` },
        quickPrompts().map(prompt => iconButton(prompt.label, () => usePrompt(prompt.text), { className: 'scratchpad-chip' })));
    el.composer = h('textarea', {
        class: 'text_pole scratchpad-composer',
        rows: '1',
        placeholder: t`Ask anything...`,
        'aria-label': t`Message for Scratchpad`,
        onkeydown: onComposerKey,
        oninput: fitComposer,
    });
    el.send = iconButton(t`Send`, () => onSendButton(), { icon: 'fa-paper-plane', className: 'scratchpad-send', primary: true });
    el.overviewToggle = h('button', {
        type: 'button',
        class: 'scratchpad-overview-toggle',
        'aria-controls': 'scratchpad-overview',
        'aria-expanded': 'true',
        title: t`Hide details`,
        onclick: toggleOverview,
    }, h('i', { class: 'fa-solid fa-chevron-down', 'aria-hidden': 'true' }), h('span', { text: t`Talking with` }));
    el.overviewBar = h('button', {
        type: 'button',
        class: 'scratchpad-overview-bar',
        'aria-controls': 'scratchpad-overview',
        'aria-expanded': 'false',
        title: t`Show details`,
        onclick: toggleOverview,
    });
    el.overview = h('div', { id: 'scratchpad-overview', class: 'scratchpad-overview' },
        h('div', { class: 'scratchpad-chat-top' }, el.overviewToggle, el.roundTable, el.assistantPicker),
        el.summary);
    append(el.panels.chat, [
        el.overviewBar,
        el.overview,
        el.messages,
        h('div', { class: 'scratchpad-compose' }, el.quick, h('div', { class: 'scratchpad-compose-row' }, el.composer, el.send)),
    ]);
}

function selectTab(key) {
    app.tab = key;
    for (const [name, tab] of Object.entries(app.el.tabs)) {
        const selected = name === key;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        app.el.panels[name].hidden = !selected;
    }
    if (key === 'context') renderContext();
    if (key === 'sessions') renderSessions();
    if (key === 'chat') {
        fitComposer();
        scrollMessages(true);
    }
}

/* Data */

function applyBucket(bucket, { ticket = null } = {}) {
    if (ticket !== null && ticket !== app.ticket) return;
    if (!bucket || bucket.source?.key !== app.source?.key) return;
    const firstSession = app.bucket?.sessions.length === 0 && bucket.sessions.length > 0;
    app.bucket = bucket;
    syncDraft({ carry: firstSession });
    const session = activeSession();
    if (session) app.assistant = session.assistant;
    render();
    syncWatchers();
}

function syncDraft({ carry = false } = {}) {
    const key = JSON.stringify([app.source?.kind, app.source?.key, activeSession()?.id]);
    if (key === app.draftKey) return;
    const draft = app.el.composer.value;
    const emptyKey = JSON.stringify([app.source?.kind, app.source?.key, null]);
    const firstSession = key !== emptyKey && app.draftKey === emptyKey;
    if (firstSession) app.drafts.delete(emptyKey);
    else if (app.draftKey) app.drafts.set(app.draftKey, draft);
    app.draftKey = key;
    app.el.composer.value = app.drafts.get(key) ?? (carry || firstSession ? draft : '');
}

function requireScope(source, sessionId) {
    if (!source || source.key !== app.source?.key || !isCurrentSource(source)
        || (sessionId !== undefined && activeSession()?.id !== sessionId)) {
        throw new Error(t`The chat or Scratchpad session changed. Return to it and try again.`);
    }
}

async function reload() {
    const source = app.source;
    const ticket = ++app.ticket;
    if (!source) {
        app.bucket = null;
        render();
        return;
    }
    try {
        const result = await api.readBucket(wireSource(source));
        if (source.key === app.source?.key) applyBucket(result.bucket, { ticket });
    } catch (error) {
        if (ticket === app.ticket) reportError(error, t`Scratchpad could not load.`);
    }
}

function checkSource() {
    const next = currentSource();
    if ((next?.key ?? '') === (app.source?.key ?? '')) {
        if (next) {
            const renamed = next.label !== app.source?.label;
            app.source = next;
            if (renamed) {
                renderHeader();
                app.contextKey = '';
                if (app.tab === 'context') renderContext();
            }
        }
        return;
    }
    stopWatchers();
    app.source = next;
    app.bucket = null;
    app.editing = '';
    app.pickLimit = PICK_PAGE;
    app.contextKey = '';
    render();
    void reload();
}

/** Runs bucket changes one after another so a slow request cannot overwrite a newer one. */
function change(operation, fallback, source = app.source) {
    const run = async () => {
        try {
            requireScope(source);
            const result = await operation(wireSource(source));
            if (result?.bucket && source.key === app.source?.key) {
                app.ticket += 1;
                applyBucket(result.bucket);
            }
            return result;
        } catch (error) {
            reportError(error, fallback);
            return null;
        }
    };
    const next = app.queue.then(run, run);
    app.queue = next.catch(() => null);
    return next;
}

async function ensureSession(source) {
    const result = await change(wire => activeSession() ? { bucket: app.bucket } : api.createSession(wire, sessionInput()),
        t`Scratchpad could not start a session.`, source);
    if (!result) return null;
    requireScope(source);
    return activeSession();
}

/**
 * Saves part of the session settings. A function patch is read inside the
 * queue, so quick clicks build on each other instead of on a stale copy.
 */
async function updateSettings(patch, { rerenderContext = false } = {}) {
    const source = app.source;
    const sessionId = activeSession()?.id;
    const result = await change(async wire => {
        /* A new session is shown only once the setting is saved, so the panel never redraws from its defaults. */
        let bucket = app.bucket;
        if (!activeSession()) {
            bucket = (await api.createSession(wire, sessionInput())).bucket;
            requireScope(source);
        }
        const session = bucket.sessions.find(item => item.id === (sessionId || bucket.activeSessionId));
        if (!session) throw new Error(t`This Scratchpad session is no longer available.`);
        const latest = session.settings;
        const settings = typeof patch === 'function' ? patch(latest) : patch;
        try {
            return await api.updateSession(wire, session.id, { settings });
        } catch (error) {
            if (bucket !== app.bucket) applyBucket(bucket);
            throw error;
        }
    }, t`Scratchpad could not save that setting.`, source);
    if (rerenderContext && source?.key === app.source?.key) renderContext();
    return result;
}

/* Replies */

function syncWatchers() {
    const wanted = new Set();
    for (const session of app.bucket?.sessions ?? []) {
        for (const message of session.messages) {
            if (message.role === 'assistant' && message.state === 'pending' && message.jobId) wanted.add(message.jobId);
        }
    }
    for (const [jobId, stop] of app.watchers) {
        if (!wanted.has(jobId)) {
            stop();
            app.watchers.delete(jobId);
            app.previews.delete(jobId);
        }
    }
    for (const jobId of wanted) {
        if (app.watchers.has(jobId)) continue;
        const stop = api.watchReply(jobId, {
            onPreview: preview => {
                const previous = app.previews.get(jobId);
                app.previews.set(jobId, preview);
                updateStream(jobId);
                if (Object.entries(preview.replies ?? {}).some(([id, reply]) => ['done', 'failed'].includes(reply.stage) && previous?.replies?.[id]?.stage !== reply.stage)) void reload();
            },
            onDone: result => {
                app.watchers.get(jobId)?.();
                app.watchers.delete(jobId);
                const delay = result?.state === 'unknown' ? 2000 : 0;
                setTimeout(() => app.open && reload(), delay);
            },
        });
        app.watchers.set(jobId, stop);
    }
}

function stopWatchers() {
    for (const stop of app.watchers.values()) stop();
    app.watchers.clear();
    app.previews.clear();
}

async function acknowledge() {
    let failure = null;
    for (let attempt = 1; attempt <= ACK_ATTEMPTS; attempt += 1) {
        try {
            if (await saveSettings(0, { returnResult: true })) return getActiveGenerationAcknowledgement();
        } catch (error) {
            failure = error;
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(1500, 250 * attempt)));
    }
    throw failure ?? new Error(t`Save the active connection settings before generating a reply.`);
}

function sessionText(session) {
    return (session?.messages ?? []).slice(-SESSION_TEXT_MESSAGES).map(item => item.text).join('\n');
}

async function send({ regenerate = '' } = {}) {
    if (app.sending) return;
    const source = app.source;
    if (!source) return;
    if (!isCurrentSource(source)) {
        toastr.warning(t`Open the chat this Scratchpad belongs to before sending.`);
        return;
    }
    const draft = app.el.composer.value;
    const initialSessionId = activeSession()?.id;
    const text = regenerate ? '' : draft.trim();
    if (!regenerate && !text) {
        app.el.composer.focus();
        return;
    }
    app.sending = true;
    renderComposer();
    try {
        await app.queue;
        requireScope(source, initialSessionId);
        const session = await ensureSession(source);
        if (!session) return;
        const draftKey = app.draftKey;
        const snapshot = JSON.stringify(session);
        const settings = session.settings;
        const chatProfileId = sourceConnectionProfile(source);
        const lastUser = [...session.messages].reverse().find(item => item.role === 'user');
        const retried = regenerate ? session.messages.find(message => message.id === regenerate) : null;
        const assistants = retried ? [retried.assistant || session.assistant] : sessionAssistants(session);
        const genders = Object.fromEntries(ASSISTANTS.map(item => [item.id, getAssistantGender(item.id)]));
        const query = regenerate ? (lastUser?.text ?? '') : text;
        const context = await buildContext({ source, settings, pendingText: query, sessionText: sessionText(session) });
        const help = [...new Set(await Promise.all(assistants.map(assistant => buildHelp({ assistant, gender: genders[assistant], text: query }))))].filter(Boolean).join('\n\n');
        requireScope(source, session.id);
        const acknowledgement = chatProfileId || assistants.every(assistant => assistantConnection(settings, assistant).kind === 'profile') ? undefined : await acknowledge();
        await app.queue;
        requireScope(source, session.id);
        if (JSON.stringify(activeSession()) !== snapshot || sourceConnectionProfile(source) !== chatProfileId) {
            throw new Error(t`The Scratchpad settings or messages changed. Try sending again.`);
        }
        const result = await api.sendReply({
            submissionKey: api.newSubmissionKey(),
            source: wireSource(source),
            sessionId: session.id,
            regenerate: regenerate || undefined,
            text,
            context: context.text,
            help,
            capabilities: context.capabilities,
            names: context.names,
            chatProfileId,
            genders,
            acknowledgement,
        });
        if (!regenerate) {
            if ((app.draftKey === draftKey || (source.key === app.source?.key && activeSession()?.id === session.id)) && app.el.composer.value === draft) app.el.composer.value = '';
            else if (app.drafts.get(draftKey) === draft) app.drafts.set(draftKey, '');
        }
        if (source.key === app.source?.key && activeSession()?.id === session.id) {
            app.ticket += 1;
            applyBucket(result.bucket);
            scrollMessages(true);
        }
    } catch (error) {
        reportError(error, t`Scratchpad could not send that.`);
    } finally {
        app.sending = false;
        renderComposer();
    }
}

async function stopReply() {
    const pending = pendingReply();
    if (!pending?.jobId) return;
    try {
        if (!await api.cancelReply(pending.jobId)) throw new Error(t`Scratchpad could not stop the reply. Try again.`);
    } catch (error) {
        reportError(error, t`Scratchpad could not stop the reply.`);
    }
    setTimeout(() => app.open && reload(), 600);
}

function onSendButton() {
    if (pendingReply()) void stopReply();
    else void send();
}

function onComposerKey(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || isPhone()) return;
    event.preventDefault();
    if (!pendingReply()) void send();
}

function fitComposer() {
    const composer = app.el.composer;
    if (!composer?.isConnected) return;
    composer.style.height = '';
    if (!composer.value || !composer.scrollHeight) return;
    composer.style.height = `${composer.scrollHeight + composer.offsetHeight - composer.clientHeight}px`;
}

function usePrompt(text) {
    app.el.composer.value = text;
    fitComposer();
    app.el.composer.focus();
}

/* Rendering */

function render() {
    if (!app.built) return;
    renderHeader();
    renderChat();
    const key = `${app.source?.key ?? ''}|${activeSession()?.id ?? ''}`;
    if (app.tab === 'context' && key !== app.contextKey) renderContext({ force: true });
    if (app.tab === 'sessions') renderSessions();
}

function renderHeader() {
    const sourceKind = app.source?.kind || '';
    if (app.el.quick.dataset.sourceKind !== sourceKind) {
        app.el.quick.dataset.sourceKind = sourceKind;
        app.el.quick.replaceChildren(...quickPrompts().map(prompt => iconButton(prompt.label, () => usePrompt(prompt.text), { className: 'scratchpad-chip' })));
    }
    const session = activeSession();
    const assistant = session?.assistant ?? app.assistant;
    app.el.portrait.src = getAssistantIconSrc(assistant);
    app.el.sourceLabel.textContent = app.source ? app.source.label : t`No chat open`;
    app.el.newSession.disabled = !app.source;
    app.el.close.querySelector('span').textContent = app.source?.kind === 'notebook' ? t`Back to Notes` : t`Back to chat`;
    const participants = sessionAssistants(session);
    const roundTable = session?.settings.roundTable === true;
    app.el.roundTable.setAttribute('aria-pressed', String(roundTable));
    app.el.roundTable.classList.toggle('menu_button_primary', roundTable);
    app.el.roundTable.disabled = !app.source || app.sending || Boolean(pendingReply());
    clear(app.el.assistantPicker);
    for (const item of ASSISTANTS) {
        const selected = participants.includes(item.id);
        const choice = h('button', {
            type: 'button',
            class: `scratchpad-assistant${selected ? ' is-selected' : ''}`,
            'aria-pressed': String(selected),
            title: assistantRole(item.id),
            disabled: !app.source || app.sending || Boolean(pendingReply()) || (roundTable && selected && participants.length === 1),
            onclick: () => chooseAssistant(item.id),
        }, h('img', { src: getAssistantIconSrc(item.id), alt: '', width: 32, height: 32 }), h('span', { text: item.name }));
        app.el.assistantPicker.append(choice);
    }
    renderOverview();
}

async function chooseAssistant(id) {
    if (activeSession()?.settings.roundTable) {
        await updateSettings(settings => ({ participants: settings.participants.includes(id)
            ? settings.participants.filter(item => item !== id) : [...settings.participants, id] }));
        return;
    }
    app.assistant = id;
    writePrefs();
    const session = activeSession();
    if (!session) {
        renderHeader();
        return;
    }
    await change(source => api.updateSession(source, session.id, { assistant: id, gender: getAssistantGender(id) }), t`Scratchpad could not switch assistants.`);
}

function contextSummary(settings) {
    const notes = settings.notes?.length || 0;
    if (notes) return t`${notes} saved notes or sections shared`;
    if (settings.picked?.length) return t`Reading ${settings.picked.length} picked messages`;
    if (!settings.depth) return t`Not reading any chat messages`;
    return t`Reading the latest ${settings.depth} messages`;
}

function renderOverview() {
    const el = app.el;
    const collapsed = app.overviewCollapsed;
    el.overview.hidden = collapsed;
    el.overviewBar.hidden = !collapsed;
    if (!collapsed) return;
    const session = activeSession();
    const assistant = assistantInfo(session?.assistant ?? app.assistant);
    let name = t`No chat open`;
    if (app.source) name = session ? session.name : t`New session with ${assistant.name}`;
    clear(el.overviewBar);
    append(el.overviewBar, [
        h('i', { class: 'fa-solid fa-chevron-right', 'aria-hidden': 'true' }),
        ...sessionAssistants(session).map(id => h('img', { src: getAssistantIconSrc(id), alt: assistantInfo(id).name, width: 24, height: 24 })),
        h('span', { class: 'scratchpad-overview-name', text: name }),
        session?.temporary ? h('span', { class: 'scratchpad-badge', text: t`Temporary` }) : null,
        app.source ? h('span', { class: 'scratchpad-overview-context', text: contextSummary(currentSettings()) }) : null,
    ]);
}

function toggleOverview() {
    const stick = nearBottom(app.el.messages);
    app.overviewCollapsed = !app.overviewCollapsed;
    writePrefs();
    renderOverview();
    const target = app.overviewCollapsed ? app.el.overviewBar : app.el.overviewToggle;
    target.focus({ preventScroll: true });
    if (stick) scrollMessages(true);
}

function renderChat() {
    const el = app.el;
    const session = activeSession();
    clear(el.summary);
    if (app.source) {
        const settings = currentSettings();
        const assistant = assistantInfo(session?.assistant ?? app.assistant);
        append(el.summary, [
            h('span', { text: session ? session.name : t`New session with ${assistant.name}` }),
            settings.roundTable ? h('span', { class: 'scratchpad-badge', text: t`Round table: ${sessionAssistants(session).length}` }) : null,
            session?.temporary ? h('span', { class: 'scratchpad-badge', text: t`Temporary` }) : null,
            h('span', { class: 'scratchpad-summary-context', text: contextSummary(settings) }),
            iconButton(t`Change`, () => selectTab('context'), { className: 'scratchpad-link' }),
        ]);
    }
    renderOverview();
    renderMessages();
    renderComposer();
}

function nearBottom(element) {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}

function scrollMessages(force = false) {
    const list = app.el.messages;
    if (!list || (!force && !nearBottom(list))) return;
    requestAnimationFrame(() => {
        list.scrollTop = list.scrollHeight;
    });
}

function renderMessages() {
    const list = app.el.messages;
    const stick = nearBottom(list);
    clear(list);
    if (!app.source) {
        list.append(h('div', { class: 'scratchpad-empty' },
            h('p', { text: t`Open a Roleplay or Conversation chat, then come back here to talk with Miso, Taro or Nori.` })));
        return;
    }
    const session = activeSession();
    if (!session?.messages.length) {
        const assistant = assistantInfo(session?.assistant ?? app.assistant);
        const names = sessionAssistants(session).map(id => assistantInfo(id).name).join(', ');
        list.append(h('div', { class: 'scratchpad-empty' },
            h('img', { src: getAssistantIconSrc(assistant.id), alt: '', width: 72, height: 72 }),
            h('p', { text: t`Ask ${names} anything. Nothing you write here goes into the story.` }),
            h('p', { text: app.source?.kind === 'notebook'
                ? t`Suggested note changes appear as cards you can review before anything is saved.`
                : t`Suggested changes to notes, lorebooks, characters or messages appear as cards you can review before anything is saved.` })));
        return;
    }
    const lastUserIndex = session.messages.findLastIndex(item => item.role === 'user');
    for (const [index, message] of session.messages.entries()) {
        list.append(renderMessage(session, message, {
            latest: lastUserIndex >= 0 && index > lastUserIndex && message.role === 'assistant',
        }));
    }
    if (stick) scrollMessages(true);
}

function stageLabel(preview) {
    if (preview?.stage === 'done') return t`Reply saved`;
    if (preview?.stage === 'failed') return preview.error || t`This reply did not finish.`;
    if (!preview || preview.stage === 'queued') return t`Waiting for the model...`;
    if (!preview.text && preview.reasoning) return t`Thinking...`;
    return t`Writing...`;
}

function updateStream(jobId) {
    const nodes = app.el.messages?.querySelectorAll(`.scratchpad-message.is-pending[data-job-id="${CSS.escape(jobId)}"]`);
    if (!nodes?.length) return;
    const stick = nearBottom(app.el.messages);
    for (const node of nodes) {
        const preview = replyPreview({ jobId, id: node.dataset.messageId });
        node.querySelector('.scratchpad-stage').textContent = stageLabel(preview);
        node.querySelector('.scratchpad-stream').textContent = preview?.text ?? '';
    }
    if (stick) scrollMessages(true);
}

function replyPreview(message) {
    const preview = app.previews.get(message.jobId);
    return preview?.replies ? preview.replies[message.id] : preview;
}

function renderMessage(session, message, { latest }) {
    const assistant = message.role === 'assistant' ? assistantInfo(message.assistant ?? session.assistant) : null;
    const article = h('article', {
        class: `scratchpad-message is-${message.role}${message.state ? ` is-${message.state}` : ''}`,
        dataset: { messageId: message.id, ...(message.jobId ? { jobId: message.jobId } : {}) },
    });
    const author = assistant
        ? h('div', { class: 'scratchpad-author' }, h('img', { src: getAssistantIconSrc(assistant.id), alt: '', width: 24, height: 24 }), h('span', { text: assistant.name }))
        : h('div', { class: 'scratchpad-author' }, h('span', { text: sourceUserName(app.source) || t`You` }));
    article.append(author);

    if (app.editing === message.id) {
        article.append(renderEditor(session, message));
        return article;
    }

    if (message.role === 'user') {
        article.append(h('p', { class: 'scratchpad-plain', text: message.text }));
    } else if (message.state === 'pending') {
        const preview = replyPreview(message);
        article.append(
            h('p', { class: 'scratchpad-stage', text: stageLabel(preview) }),
            h('p', { class: 'scratchpad-plain scratchpad-stream', text: preview?.text ?? '' }),
            iconButton(session.settings.roundTable ? t`Stop all` : t`Stop`, () => void stopReply(), { icon: 'fa-stop', className: 'scratchpad-stop' }));
        return article;
    } else {
        if (message.reasoning) {
            article.append(h('details', { class: 'scratchpad-reasoning' },
                h('summary', { text: t`Thinking` }),
                h('p', { class: 'scratchpad-plain', text: message.reasoning })));
        }
        if (message.text) article.append(renderReply(session, message));
        if (message.state === 'failed') {
            article.append(h('p', { class: 'scratchpad-error', role: 'status', text: message.error || t`This reply did not finish.` }));
        }
    }
    const actions = renderMessageActions(session, message, { latest });
    const menu = h('details', { class: 'scratchpad-message-menu' },
        h('summary', { 'aria-label': t`Message actions`, title: t`Message actions` },
            h('i', { class: 'fa-solid fa-ellipsis', 'aria-hidden': 'true' })), actions);
    menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            menu.open = false;
            menu.querySelector('summary').focus();
            event.stopPropagation();
        }
    });
    actions.addEventListener('click', event => {
        if (event.target.closest('button:not(:disabled)')) menu.open = false;
    });
    author.append(menu);
    return article;
}

function renderReply(session, message) {
    const body = h('div', { class: 'scratchpad-reply' });
    for (const part of splitReply(message.text)) {
        if (part.type === 'text') {
            if (!part.text.trim()) continue;
            const block = h('div', { class: 'scratchpad-text mes_text' });
            block.innerHTML = messageFormatting(part.text, '', false, false, -1, {}, false);
            body.append(block);
        } else {
            body.append(renderChangeCard(session, message, part));
        }
    }
    return body;
}

function renderChangeCard(session, message, part) {
    if (!part.change) {
        return h('div', { class: 'scratchpad-change is-invalid' },
            h('p', { class: 'scratchpad-change-title', text: t`A suggested change could not be read` }),
            h('p', { class: 'scratchpad-change-reason', text: part.error }));
    }
    const state = message.proposals?.[String(part.index)] ?? '';
    const card = h('div', { class: `scratchpad-change${state ? ` is-${state}` : ''}` },
        h('p', { class: 'scratchpad-change-title' }, h('i', { class: 'fa-solid fa-wand-magic-sparkles', 'aria-hidden': 'true' }), h('span', { text: describeChange(part.change) })),
        part.change.reason ? h('p', { class: 'scratchpad-change-reason', text: part.change.reason }) : null);
    if (state === 'applied') {
        card.append(h('p', { class: 'scratchpad-change-state', text: t`Saved` }));
        return card;
    }
    if (state === 'rejected') {
        card.append(h('div', { class: 'scratchpad-change-actions' },
            h('span', { class: 'scratchpad-change-state', text: t`Dismissed` }),
            part.change.type === 'notebook' && message.notebookProposals?.[part.index] ? null : iconButton(t`Undo`, () => void markChange(session, message, part.index, null), { className: 'scratchpad-link' })));
        return card;
    }
    card.append(h('div', { class: 'scratchpad-change-actions' },
        iconButton(t`Review`, () => void reviewChange(session, message, part), { icon: 'fa-eye', primary: true }),
        iconButton(t`Dismiss`, () => void dismissChange(session, message, part), { icon: 'fa-xmark' })));
    return card;
}

function markChange(session, message, index, state, source = app.source) {
    return change(wire => api.markProposal(wire, session.id, message.id, index, state), t`Scratchpad could not update that suggestion.`, source);
}

async function reviewChange(session, message, part) {
    if (part.change.type === 'notebook') return reviewNotebookChange(session, message, part);
    const source = app.source;
    let plan;
    try {
        plan = await prepareChange(part.change, source);
        requireScope(source, session.id);
    } catch (error) {
        reportError(error, t`That change cannot be reviewed right now.`);
        return;
    }
    const editor = plan.editable
        ? h('textarea', { class: 'text_pole scratchpad-review-editor', rows: '12', value: plan.after, 'aria-label': plan.afterLabel || t`Proposed text` })
        : null;
    const content = h('div', { class: 'neconyan-assistant-review scratchpad-review' },
        h('p', { text: t`Check this change before it is saved. You can edit the proposed text first.` }),
        h('p', {}, h('strong', { text: t`Where: ` }), plan.target),
        h('p', {}, h('strong', { text: t`What: ` }), plan.field),
        h('strong', { text: plan.beforeLabel || t`Now` }),
        h('pre', { class: 'scratchpad-review-before', text: plan.before || t`(empty)` }),
        h('strong', { text: plan.afterLabel || t`Proposed` }),
        editor ?? h('pre', { class: 'scratchpad-review-after', text: plan.after }),
        plan.hint ? h('p', { class: 'scratchpad-review-hint', text: plan.hint }) : null);
    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: true,
        okButton: t`Save change`,
        cancelButton: t`Not now`,
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    try {
        requireScope(source, session.id);
        await plan.commit(editor ? editor.value : plan.after);
    } catch (error) {
        reportError(error, t`That change could not be saved.`);
        return;
    }
    toastr.success(t`Change saved.`);
    await markChange(session, message, part.index, 'applied', source);
}

async function reviewNotebookChange(session, message, part, { dismiss = false } = {}) {
    const source = app.source;
    try {
        requireScope(source, session.id);
        const proposal = await api.readNotebookProposal(wireSource(source), session.id, message.id, part.index);
        requireScope(source, session.id);
        applyBucket(proposal.bucket);
        if (proposal.state === 'applied' || proposal.state === 'denied') { await reload(); return; }
        if (!proposal.proposalHash) { toastr.info(proposal.message || t`Nothing would change.`); return; }
        if (!dismiss) {
            const content = h('div', { class: 'scratchpad-review' },
                h('h3', { text: proposal.summary.label || t`Review note change` }),
                h('p', { text: t`This exact change is also available in Notes under Assistant changes. Note revisions and AI access are checked again when you save.` }),
                h('strong', { text: t`Now` }), h('pre', { class: 'scratchpad-review-before', text: proposal.before || t`(empty)` }),
                h('strong', { text: t`Proposed` }), h('pre', { class: 'scratchpad-review-after', text: proposal.after || t`(empty)` }));
            const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: t`Save change`, cancelButton: t`Not now` });
            if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        }
        requireScope(source, session.id);
        const result = await api.decideNotebookProposal(wireSource(source), session.id, message.id, part.index, proposal.proposalHash, dismiss ? 'deny' : 'allow');
        requireScope(source, session.id);
        applyBucket(result.bucket);
        if (result.result.committed) toastr.success(t`Change saved.`);
    } catch (error) { reportError(error, t`That note change could not be saved.`); }
}

function dismissChange(session, message, part) {
    return part.change.type === 'notebook' && message.notebookProposals?.[part.index]
        ? reviewNotebookChange(session, message, part, { dismiss: true }) : markChange(session, message, part.index, 'rejected');
}

async function openNotebook(ref = {}) {
    const { openNotes } = await import('../notebooks/notes-app.js');
    await openNotes({ notebookId: ref.notebookId, noteId: ref.noteId });
}

async function saveToNote(session, message = null) {
    const source = app.source;
    const selection = globalThis.getSelection?.();
    const article = message ? app.el.messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`) : null;
    const blocks = article ? [...article.querySelectorAll('.scratchpad-text, .scratchpad-plain')].filter(block => !block.closest('.scratchpad-reasoning')) : [];
    const selected = selection && !selection.isCollapsed && blocks.some(block => block.contains(selection.anchorNode) && block.contains(selection.focusNode)) ? selection.toString() : '';
    const text = selected || (message ? (message.role === 'assistant' ? replyDraft(message.text) : message.text) : sessionNoteText(session, replyDraft));
    if (!text.trim()) { toastr.info(t`There is no text to save.`); return; }
    try {
        requireScope(source, session.id);
        const { captureFromChat } = await import('../notebooks/notes-app.js');
        requireScope(source, session.id);
        await captureFromChat({ title: session.name, text, source: { kind: 'scratchpad', sourceKind: source.kind, chat: source.key,
            sessionId: session.id, scratchpadMessageId: message?.id, speaker: message?.assistant ? assistantInfo(message.assistant).name : message ? sourceUserName(source) : t`Scratchpad session`, messageSendDate: message?.created } });
    } catch (error) { reportError(error, t`That text could not be saved to Notes.`); }
}

function replyDraft(text) {
    return splitReply(text).filter(part => part.type === 'text').map(part => part.text).join('').trim();
}

function useAsDraft(message) {
    const draft = replyDraft(message.text);
    if (!draft) return;
    const conversation = document.body.classList.contains('neconyan-conversation-active');
    const target = document.querySelector(conversation ? '#sb_conversation_input' : '#send_textarea') ?? document.querySelector('#send_textarea');
    if (!target) return;
    target.value = draft;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    toastr.info(t`Copied into the chat box. Nothing has been sent.`);
    if (isPhone()) hideScratchpad();
    target.focus();
}

async function copyMessage(message) {
    try {
        await navigator.clipboard.writeText(message.text);
        toastr.success(t`Copied.`);
    } catch {
        toastr.warning(t`Copying is not available here.`);
    }
}

async function removeMessage(session, message) {
    const scope = app.source;
    const ok = await callGenericPopup(t`Delete this Scratchpad message? The story is not affected.`, POPUP_TYPE.CONFIRM, '', { okButton: t`Delete`, cancelButton: t`Keep` });
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
    await change(source => api.deleteMessage(source, session.id, message.id), t`Scratchpad could not delete that message.`, scope);
}

function renderMessageActions(session, message, { latest }) {
    const busy = Boolean(pendingReply(session));
    const actions = h('div', { class: 'scratchpad-message-actions' });
    if (message.text) actions.append(iconButton('', () => void copyMessage(message), { icon: 'fa-copy', title: t`Copy` }));
    if (message.text) actions.append(iconButton('', () => void saveToNote(session, message), { icon: 'fa-book-bookmark', title: t`Save selection or message to note` }));
    actions.append(iconButton('', () => {
        app.editing = message.id;
        renderMessages();
    }, { icon: 'fa-pen', title: t`Edit`, disabled: busy }));
    if (message.role === 'assistant' && message.text && app.source?.kind !== 'notebook') {
        actions.append(iconButton('', () => useAsDraft(message), { icon: 'fa-reply', title: t`Use as draft in the chat box` }));
    }
    if (latest && message.role === 'assistant') {
        actions.append(iconButton('', () => void send({ regenerate: message.id }), { icon: 'fa-rotate-right', title: t`Try again`, disabled: busy || app.sending }));
    }
    actions.append(iconButton('', () => void removeMessage(session, message), { icon: 'fa-trash', title: t`Delete`, disabled: busy }));
    return actions;
}

function renderEditor(session, message) {
    const editor = h('textarea', { class: 'text_pole scratchpad-edit', rows: '6', value: message.text, 'aria-label': t`Edit message` });
    const done = () => {
        app.editing = '';
        renderMessages();
    };
    requestAnimationFrame(() => editor.focus());
    return h('div', { class: 'scratchpad-editor' },
        editor,
        h('div', { class: 'scratchpad-editor-actions' },
            iconButton(t`Save`, async () => {
                const text = editor.value.trim();
                if (!text) return;
                app.editing = '';
                await change(source => api.updateMessage(source, session.id, message.id, text), t`Scratchpad could not save that edit.`);
                renderMessages();
            }, { icon: 'fa-check', primary: true }),
            iconButton(t`Cancel`, done, { icon: 'fa-xmark' })));
}

function renderComposer() {
    syncDraft();
    fitComposer();
    const el = app.el;
    const pending = pendingReply();
    const disabled = !app.source || !app.bucket || app.sending;
    el.composer.disabled = !app.source || !app.bucket;
    el.send.disabled = disabled && !pending;
    const count = sessionAssistants().length;
    el.send.querySelector('span').textContent = pending ? (activeSession()?.settings.roundTable ? t`Stop all` : t`Stop`)
        : (app.sending ? t`Sending...` : count > 1 ? t`Ask ${count}` : t`Send`);
    el.send.querySelector('i').className = `fa-solid ${pending ? 'fa-stop' : 'fa-paper-plane'}`;
    for (const chip of el.quick.querySelectorAll('button')) chip.disabled = !app.source;
}

/* Context tab */

function connectionProfiles() {
    const profiles = extension_settings.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles.filter(item => item?.id) : [];
}

function checkbox(label, checked, onChange, hint = '') {
    const input = h('input', { type: 'checkbox', checked, onchange: event => onChange(event.currentTarget.checked) });
    return h('label', { class: 'scratchpad-check' }, input, h('span', { text: label }), hint ? h('small', { text: hint }) : null);
}

async function editAssistantPrompt(assistant) {
    const source = app.source;
    try {
        await app.queue;
        requireScope(source);
        const session = await ensureSession(source);
        requireScope(source, session.id);
        const previous = session.settings.assistantPrompts?.[assistant.id];
        const context = await buildContext({ source, settings: session.settings });
        const defaults = await api.readPrompt({ assistant: assistant.id, gender: getAssistantGender(assistant.id),
            names: context.names, capabilities: { ...context.capabilities, notebook: true }, participants: sessionAssistants(session) });
        requireScope(source, session.id);
        const editor = h('textarea', { class: 'text_pole scratchpad-review-editor', rows: '16', value: previous ?? defaults.text, 'aria-label': t`Assistant prompt` });
        let reset = false;
        editor.addEventListener('input', () => { reset = false; });
        const content = h('div', { class: 'scratchpad-review' },
            h('h3', { text: t`${assistant.name}'s prompt` }),
            h('p', { text: t`These instructions are saved for this session and inherited by new sessions in this chat. App reference is added automatically. The default reflects the current chat and round-table selection.` }),
            editor,
            iconButton(t`Reset to default`, () => { editor.value = defaults.text; reset = true; }, { icon: 'fa-rotate-left' }));
        const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: t`Save prompt`, cancelButton: t`Cancel` });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        requireScope(source, session.id);
        if (activeSession().settings.assistantPrompts?.[assistant.id] !== previous) throw new Error(t`The prompt changed while the editor was open. Open it again.`);
        await updateSettings({ assistantPrompts: { [assistant.id]: reset ? null : editor.value } });
    } catch (error) {
        reportError(error, t`The assistant prompt could not be saved.`);
    }
}

function renderContext({ force = true } = {}) {
    const panel = app.el.panels.context;
    const key = `${app.source?.key ?? ''}|${activeSession()?.id ?? ''}`;
    if (!force && key === app.contextKey && panel.childElementCount) return;
    app.contextKey = key;
    clear(panel);
    if (!app.source) {
        panel.append(h('p', { class: 'scratchpad-empty', text: t`Open a chat to choose what Scratchpad reads.` }));
        return;
    }
    const settings = currentSettings();
    const limits = app.bucket?.limits ?? { depth: 200, maxTokens: 32000 };
    const roleplay = app.source.kind === 'roleplay';
    const notebook = app.source.kind === 'notebook';

    const depth = h('input', {
        type: 'number', class: 'text_pole', min: '0', max: String(limits.depth), step: '1', value: String(settings.depth),
        id: 'scratchpad-depth',
        onchange: event => void updateSettings({ depth: Number(event.currentTarget.value) }),
    });
    const maxTokens = h('input', {
        type: 'number', class: 'text_pole', min: '64', max: String(limits.maxTokens), step: '64', value: String(settings.maxTokens),
        id: 'scratchpad-max-tokens',
        onchange: event => void updateSettings({ maxTokens: Number(event.currentTarget.value) }),
    });
    const profiles = connectionProfiles();
    const connections = ASSISTANTS.map(assistant => {
        const id = `scratchpad-connection-${assistant.id}`;
        const selected = assistantConnection(settings, assistant.id);
        const value = selected.kind === 'profile' ? selected.profileId : '';
        const connection = h('select', {
            class: 'text_pole', id,
            onchange: event => {
                const profileId = event.currentTarget.value;
                app.connections[assistant.id] = profileId ? { kind: 'profile', profileId } : { kind: 'current' };
                writePrefs();
                void updateSettings({ assistantConnections: { [assistant.id]: profileId ? { kind: 'profile', profileId } : { kind: 'current' } } });
            },
        }, h('option', { value: '', text: t`Same connection as the chat` }),
        profiles.map(profile => h('option', { value: profile.id, text: [profile.name || profile.id, profile.model].filter(Boolean).join(' · ') })));
        if (value && !profiles.some(profile => profile.id === value)) {
            connection.append(h('option', { value, text: t`Unavailable profile: ${value}` }));
        }
        connection.value = value;
        return h('div', { class: 'scratchpad-field' }, h('label', { for: id, text: t`${assistant.name}'s connection` }), connection);
    });

    const include = settings.include;
    const setInclude = (name, value) => void updateSettings({ include: { [name]: value } });

    append(panel, [
        renderNotes(settings),
        notebook ? h('section', { class: 'scratchpad-section' },
            h('h3', { class: 'scratchpad-section-title', text: t`Note discussion` }),
            h('p', { class: 'scratchpad-muted', text: t`This Scratchpad belongs to the note, not the open chat. Story messages, characters, your persona and lorebooks are not included.` })) : h('section', { class: 'scratchpad-section' },
            h('h3', { class: 'scratchpad-section-title', text: t`Chat messages` }),
            h('div', { class: 'scratchpad-field' },
                h('label', { for: 'scratchpad-depth', text: t`Recent messages to read` }),
                depth,
                h('small', { text: settings.picked.length ? t`Ignored while you have picked messages below.` : t`Use 0 to share no messages.` })),
            checkbox(t`Include hidden messages`, include.hidden, value => setInclude('hidden', value))),
        notebook ? null : h('section', { class: 'scratchpad-section' },
            h('h3', { class: 'scratchpad-section-title', text: t`Also share` }),
            checkbox(t`Character cards`, include.card, value => setInclude('card', value)),
            checkbox(t`Your persona`, include.persona, value => setInclude('persona', value)),
            roleplay ? checkbox(t`Author's Note`, include.authorsNote, value => setInclude('authorsNote', value)) : null,
            checkbox(t`Lorebook entries`, include.lore, value => setInclude('lore', value), t`Entries are shared when their keywords appear, or when you set them to Always below.`)),
        h('section', { class: 'scratchpad-section' },
            h('h3', { class: 'scratchpad-section-title', text: t`Assistant connections` }),
            h('p', { class: 'scratchpad-muted', text: t`Choose a saved profile for each assistant. Profiles include the model and connection settings.` }),
            ...connections,
            h('h3', { class: 'scratchpad-section-title', text: t`Assistant prompts` }),
            ...ASSISTANTS.map(assistant => iconButton(t`View or edit ${assistant.name}'s prompt`, () => void editAssistantPrompt(assistant), { icon: 'fa-pen' })),
            h('div', { class: 'scratchpad-field' }, h('label', { for: 'scratchpad-max-tokens', text: t`Longest reply (tokens)` }), maxTokens)),
        notebook ? null : renderPicks(settings),
        notebook ? null : renderLore(settings),
        renderPreview(),
    ]);
}

function renderNotes(settings) {
    const source = app.source;
    const sessionId = activeSession()?.id;
    const isCurrent = () => app.open && isCurrentSource(source) && app.source?.key === source.key && activeSession()?.id === sessionId;
    const list = h('div', { class: 'scratchpad-notes-list', 'aria-live': 'polite' });
    const section = h('section', { class: 'scratchpad-section scratchpad-notes' },
        h('h3', { class: 'scratchpad-section-title', text: t`Saved notes` }),
        h('p', { class: 'scratchpad-muted', text: t`Add notes or sections for this session. Notebook's AI access still applies. Share private notes or selected text from Notes.` }),
        h('div', { class: 'scratchpad-note-actions' },
            iconButton(t`Add saved note`, async () => {
                try {
                    const ref = await chooseNote({ isCurrent });
                    if (ref && isCurrent()) await updateSettings(latest => ({ notes: [...(latest.notes ?? []), ref] }), { rerenderContext: true });
                } catch (error) { reportError(error, t`That note could not be shared.`); }
            }, { icon: 'fa-plus', disabled: (settings.notes?.length ?? 0) >= (app.bucket?.limits.notes ?? 12) }),
            iconButton(t`Open Notes`, () => void openNotebook().catch(error => reportError(error, t`Notes could not open.`)), { icon: 'fa-book-open' })), list);
    if (!settings.notes?.length) {
        list.append(h('p', { class: 'scratchpad-muted', text: t`No saved notes are shared with this session.` }));
        return section;
    }
    const refs = JSON.stringify(settings.notes);
    list.append(h('p', { class: 'scratchpad-muted', text: t`Checking shared notes...` }));
    api.readNotebookContext(wireSource(source), sessionId).then(context => {
        if (!list.isConnected || !isCurrent() || JSON.stringify(currentSettings().notes) !== refs) return;
        clear(list);
        for (const note of context.notes) {
            const ref = note.reference;
            const same = item => JSON.stringify(item) === JSON.stringify(ref);
            const changePage = offset => void updateSettings(latest => ({ notes: latest.notes.map(item => same(item) ? { ...item, offset } : item) }), { rerenderContext: true });
            const access = note.unavailable ? t`Not shared` : note.scope === 'selection' ? t`Selected text only` : note.canEdit ? t`Edits need review` : t`Read only`;
            const actions = h('div', { class: 'scratchpad-note-actions' },
                iconButton(t`Open note`, () => void openNotebook(ref).catch(error => reportError(error, t`That note could not open.`)), { icon: 'fa-arrow-up-right-from-square' }),
                iconButton(ref.grantId ? t`Stop sharing` : t`Remove`, async () => {
                    if (ref.grantId) {
                        const { notesRequest } = await import('../notebooks/api.js');
                        if (!isCurrent()) return;
                        const result = await notesRequest('/assistant/grants/revoke', { grantId: ref.grantId });
                        if (result.status !== 'success') { reportError(new Error(result.message), t`Sharing could not be stopped.`); return; }
                    }
                    if (isCurrent()) await updateSettings(latest => ({ notes: latest.notes.filter(item => ref.grantId ? item.grantId !== ref.grantId : !same(item)) }), { rerenderContext: true });
                }, { icon: 'fa-xmark' }));
            if (ref.offset) actions.append(iconButton(t`Previous page`, () => changePage(Math.max(0, ref.offset - 24000)), { icon: 'fa-chevron-left' }));
            if (note.nextOffset !== null && note.nextOffset !== undefined) actions.append(iconButton(t`Next page`, () => changePage(note.nextOffset), { icon: 'fa-chevron-right' }));
            list.append(h('div', { class: `scratchpad-note${note.unavailable ? ' is-unavailable' : ''}` },
                h('div', { class: 'scratchpad-note-heading' }, h('strong', { text: note.title || t`Unavailable note` }), h('span', { class: 'scratchpad-badge', text: access })),
                note.heading ? h('small', { text: note.heading }) : null,
                note.partial ? h('small', { text: t`Page begins at character ${(note.offset || 0) + 1}. This is part of a longer note.` }) : null,
                ref.grantId && !note.unavailable ? h('small', { text: t`Temporary sharing: up to 30 minutes. Stop sharing to prevent future reads; text already sent cannot be withdrawn.` }) : null,
                note.unavailable ? h('p', { class: 'scratchpad-muted', text: t`Access expired, the shared text changed, or the note is unavailable. Share it again from Notes if needed.` }) : null, actions));
        }
    }).catch(error => { if (list.isConnected && isCurrent()) list.replaceChildren(h('p', { class: 'scratchpad-error', text: error.message })); });
    return section;
}

function renderPicks(settings) {
    const section = h('section', { class: 'scratchpad-section' }, h('h3', { class: 'scratchpad-section-title', text: t`Pick specific messages and swipes` }));
    const messages = sourceMessages(app.source);
    if (!messages.length) {
        section.append(h('p', { class: 'scratchpad-muted', text: t`This chat has no messages yet.` }));
        return section;
    }
    const picked = new Set(settings.picked);
    section.append(h('p', { class: 'scratchpad-muted', text: t`Picked messages and swipes replace the recent messages above. Expand Swipes to compare versions without changing the story.` }));
    if (picked.size) {
        section.append(iconButton(t`Clear picks (${picked.size})`, () => void updateSettings({ picked: [] }, { rerenderContext: true }), { icon: 'fa-eraser' }));
    }
    const list = h('ul', { class: 'scratchpad-picks' });
    const latestFirst = [...messages].reverse();
    const choices = messages.flatMap(item => [item, ...(item.swipes ?? [])]);
    const pick = item => {
        const input = h('input', {
            type: 'checkbox',
            'aria-label': item.swipe ? t`Pick message #${item.number}, swipe ${item.swipe}` : t`Pick message #${item.number}`,
            checked: picked.has(item.ref),
            onchange: event => {
                const checked = event.currentTarget.checked;
                void updateSettings(latest => {
                    const next = new Set(latest.picked);
                    if (checked) {
                        next.add(item.ref);
                        if (item.swipe && item.current) next.delete(item.messageRef);
                        else if (!item.swipe) for (const swipe of item.swipes ?? []) if (swipe.current) next.delete(swipe.ref);
                    } else next.delete(item.ref);
                    return { picked: choices.map(entry => entry.ref).filter(ref => next.has(ref)) };
                }, { rerenderContext: true });
            },
        });
        const preview = item.text.length > 140 ? `${item.text.slice(0, 140)}...` : item.text;
        const label = item.swipe ? t`Swipe ${item.swipe} of ${item.swipeCount}` : `#${item.number} ${item.name}`;
        return h('label', { class: 'scratchpad-pick' },
            input,
            h('span', { class: 'scratchpad-pick-meta', text: `${label}${item.current ? ` (${t`current`})` : ''}${item.hidden ? ` (${t`hidden`})` : ''}` }),
            h('span', { class: 'scratchpad-pick-text', text: preview }));
    };
    for (const item of latestFirst.slice(0, app.pickLimit)) {
        const row = h('li', {}, pick(item));
        if (item.swipes?.length > 1) {
            row.append(h('details', { class: 'scratchpad-swipes', open: item.swipes.some(swipe => picked.has(swipe.ref)) },
                h('summary', { text: t`Swipes (${item.swipes.length})` }),
                h('ul', { class: 'scratchpad-picks' }, item.swipes.map(swipe => h('li', {}, pick(swipe))))));
        }
        list.append(row);
    }
    section.append(list);
    if (latestFirst.length > app.pickLimit) {
        section.append(iconButton(t`Show earlier messages`, () => {
            app.pickLimit += PICK_PAGE;
            renderContext({ force: true });
        }, { icon: 'fa-angles-down' }));
    }
    return section;
}

function renderLore(settings) {
    const section = h('section', { class: 'scratchpad-section' }, h('h3', { class: 'scratchpad-section-title', text: t`Lorebook entries` }));
    const list = h('div', { class: 'scratchpad-lore' }, h('p', { class: 'scratchpad-muted', text: t`Loading lorebook entries...` }));
    section.append(list);
    const key = app.contextKey;
    const source = app.source;
    const scanText = loreScanText({ source, settings, pendingText: app.el.composer.value, sessionText: sessionText(activeSession()) });
    collectLore({ source, settings, scanText }).then(lore => {
        if (key !== app.contextKey || !list.isConnected) return;
        clear(list);
        if (!lore.entries.length) {
            list.append(h('p', { class: 'scratchpad-muted', text: lore.books.length ? t`The active lorebooks have no entries Scratchpad can read.` : t`No lorebooks are active in this chat.` }));
            return;
        }
        list.append(h('p', { class: 'scratchpad-muted', text: t`Active lorebooks: ${lore.books.join(', ')}` }));
        for (const entry of lore.entries) list.append(renderLoreEntry(entry));
    }).catch(error => {
        if (!list.isConnected) return;
        clear(list);
        list.append(h('p', { class: 'scratchpad-error', text: error?.message || t`Lorebook entries could not be read.` }));
    });
    return section;
}

function renderLoreEntry(entry) {
    const overrides = currentSettings().loreOverrides ?? {};
    const current = overrides[loreOverrideKey(entry)] ?? 'auto';
    const status = entry.included
        ? (entry.reason === 'constant' ? t`Shared: always active` : entry.reason === 'always' ? t`Shared: set to Always` : t`Shared: keyword found`)
        : t`Not shared right now`;
    const choices = h('div', { class: 'scratchpad-segment', role: 'group', 'aria-label': t`Share ${entry.title}` });
    for (const [value, label] of [['auto', t`Auto`], ['always', t`Always`], ['never', t`Never`]]) {
        choices.append(h('button', {
            type: 'button',
            class: `scratchpad-segment-choice${value === current ? ' is-selected' : ''}`,
            'aria-pressed': String(value === current),
            onclick: () => {
                void updateSettings(latest => {
                    const next = { ...(latest.loreOverrides ?? {}) };
                    if (value === 'auto') delete next[loreOverrideKey(entry)];
                    else next[loreOverrideKey(entry)] = value;
                    return { loreOverrides: next };
                }, { rerenderContext: true });
            },
        }, label));
    }
    return h('div', { class: `scratchpad-lore-entry${entry.included ? ' is-included' : ''}` },
        h('div', { class: 'scratchpad-lore-head' },
            h('strong', { text: entry.title || t`Untitled entry` }),
            h('small', { text: `${entry.world} · ${status}` })),
        choices);
}

function renderPreview() {
    const output = h('div', { class: 'scratchpad-preview' });
    const run = async () => {
        clear(output);
        output.append(h('p', { class: 'scratchpad-muted', text: t`Building the preview...` }));
        try {
            const source = app.source;
            await app.queue;
            requireScope(source);
            const sessionId = activeSession()?.id;
            const context = await buildContext({ source, settings: currentSettings(), pendingText: app.el.composer.value, sessionText: sessionText(activeSession()) });
            const notes = await api.readNotebookContext(wireSource(source), sessionId);
            requireScope(source, sessionId);
            const preview = [context.text, notes.text ? `<notebook_context>\n${notes.text}\n</notebook_context>` : ''].filter(Boolean).join('\n\n');
            const tokens = await estimateTokens(preview);
            requireScope(source, sessionId);
            if (!output.isConnected) return;
            clear(output);
            append(output, [
                h('p', { text: t`About ${tokens} tokens. Chat messages: ${context.messageCount} of ${context.totalMessages}. Lorebook entries: ${context.lore.entries.filter(entry => entry.included).length}.` }),
                context.swipeCount ? h('p', { text: t`Swipes shared for comparison: ${context.swipeCount}.` }) : null,
                h('p', { text: t`Saved notes or sections: ${notes.notes.filter(note => !note.unavailable).length}.` }),
                h('pre', { class: 'scratchpad-preview-text', text: preview }),
            ]);
        } catch (error) {
            clear(output);
            output.append(h('p', { class: 'scratchpad-error', text: error?.message || t`The preview could not be built.` }));
        }
    };
    return h('section', { class: 'scratchpad-section' },
        h('h3', { class: 'scratchpad-section-title', text: t`What Scratchpad will read` }),
        h('p', { class: 'scratchpad-muted', text: t`This is the story and saved-note context for your next message. Notes are read on the server, and their contents and permissions are checked again when you send.` }),
        iconButton(t`Show preview`, () => void run(), { icon: 'fa-magnifying-glass' }),
        output);
}

/* Sessions tab */

function sessionMatches(session, query) {
    if (!query) return true;
    const needle = query.toLowerCase();
    return session.name.toLowerCase().includes(needle) || session.messages.some(item => item.text.toLowerCase().includes(needle));
}

function formatDate(value) {
    try {
        return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
        return '';
    }
}

async function newSession(temporary) {
    await change(source => api.createSession(source, sessionInput({ temporary })), t`Scratchpad could not start a session.`);
    selectTab('chat');
}

async function renameSession(session) {
    const scope = app.source;
    const name = await callGenericPopup(`<h3>${t`New name:`}</h3>`, POPUP_TYPE.INPUT, session.name);
    if (!name || !String(name).trim()) return;
    await change(source => api.updateSession(source, session.id, { name: String(name).trim() }), t`Scratchpad could not rename that session.`, scope);
}

async function clearSessionMessages(session) {
    const scope = app.source;
    const ok = await callGenericPopup(t`Clear every message in '${session.name}'? Its context settings stay.`, POPUP_TYPE.CONFIRM, '', { okButton: t`Clear`, cancelButton: t`Keep` });
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
    await change(source => api.clearSession(source, session.id), t`Scratchpad could not clear that session.`, scope);
}

async function removeSession(session) {
    const scope = app.source;
    const ok = await callGenericPopup(t`Delete '${session.name}'? This cannot be undone. The story is not affected.`, POPUP_TYPE.CONFIRM, '', { okButton: t`Delete`, cancelButton: t`Keep` });
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
    await change(source => api.deleteSession(source, session.id), t`Scratchpad could not delete that session.`, scope);
}

function exportSession(session) {
    const payload = {
        format: 'neconyan-scratchpad',
        version: 1,
        exported: new Date().toISOString(),
        session: {
            name: session.name,
            assistant: session.assistant,
            gender: session.gender,
            settings: { ...session.settings, notes: [] },
            messages: session.messages.filter(item => item.state !== 'pending').map(item => ({ role: item.role, text: item.text, created: item.created, assistant: item.assistant, gender: item.gender })),
        },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: `${session.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'scratchpad'}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importSessionFile() {
    const scope = app.source;
    const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;
        try {
            const parsed = JSON.parse(await file.text());
            if (parsed?.format !== 'neconyan-scratchpad' || !parsed.session) throw new Error(t`That file is not a Scratchpad export.`);
            await change(source => api.importSession(source, parsed.session), t`Scratchpad could not import that session.`, scope);
            selectTab('chat');
        } catch (error) {
            reportError(error, t`That file could not be imported.`);
        }
    });
    document.body.append(input);
    input.click();
}

function renderSessions() {
    const panel = app.el.panels.sessions;
    const focused = document.activeElement?.classList?.contains('scratchpad-session-search');
    clear(panel);
    if (!app.source) {
        panel.append(h('p', { class: 'scratchpad-empty', text: t`Open a chat to see its Scratchpad sessions.` }));
        return;
    }
    const sessions = app.bucket?.sessions ?? [];
    const current = activeSession();
    const search = h('input', {
        type: 'search',
        class: 'text_pole scratchpad-session-search',
        placeholder: t`Search sessions`,
        'aria-label': t`Search sessions`,
        value: app.sessionQuery,
        oninput: event => {
            app.sessionQuery = event.currentTarget.value;
            renderSessions();
        },
    });
    append(panel, [
        h('p', { class: 'scratchpad-muted', text: app.source.kind === 'notebook' ? t`Sessions belong to this note. Temporary sessions disappear when you open another one.` : t`Sessions belong to this chat. Temporary sessions disappear when you open another one.` }),
        h('div', { class: 'scratchpad-session-tools' },
            iconButton(t`New session`, () => void newSession(false), { icon: 'fa-plus', primary: true }),
            iconButton(t`Temporary session`, () => void newSession(true), { icon: 'fa-hourglass-half' }),
            iconButton(t`Import`, importSessionFile, { icon: 'fa-file-import' }),
            current ? iconButton(t`Export current`, () => exportSession(current), { icon: 'fa-file-export' }) : null,
            current ? iconButton(t`Save session to note`, () => void saveToNote(current), { icon: 'fa-book-bookmark', disabled: !current.messages.length }) : null),
        h('p', { class: 'scratchpad-muted', text: t`Exports keep the conversation but leave out saved-note sharing. Imported sessions need notes to be added again.` }),
        search,
    ]);
    const list = h('ul', { class: 'scratchpad-sessions' });
    const visible = sessions.filter(session => sessionMatches(session, app.sessionQuery.trim()));
    if (!visible.length) {
        list.append(h('li', { class: 'scratchpad-muted', text: sessions.length ? t`No sessions match that search.` : t`No sessions yet. Send a message to start one.` }));
    }
    for (const session of visible) {
        const active = session.id === current?.id;
        const assistant = assistantInfo(session.assistant);
        list.append(h('li', { class: `scratchpad-session${active ? ' is-active' : ''}` },
            h('img', { src: getAssistantIconSrc(assistant.id), alt: '', width: 32, height: 32 }),
            h('div', { class: 'scratchpad-session-info' },
                h('strong', { text: session.name }),
                h('small', { text: [assistant.name, t`${session.messages.length} messages`, formatDate(session.updated), session.temporary ? t`Temporary` : ''].filter(Boolean).join(' · ') })),
            h('div', { class: 'scratchpad-session-actions' },
                active
                    ? h('span', { class: 'scratchpad-badge', text: t`Open` })
                    : iconButton(t`Open`, async () => {
                        await change(source => api.activateSession(source, session.id), t`Scratchpad could not open that session.`);
                        selectTab('chat');
                    }, { icon: 'fa-folder-open' }),
                iconButton('', () => void renameSession(session), { icon: 'fa-i-cursor', title: t`Rename` }),
                iconButton('', () => void clearSessionMessages(session), { icon: 'fa-broom', title: t`Clear messages` }),
                iconButton('', () => void removeSession(session), { icon: 'fa-trash', title: t`Delete session` }))));
    }
    panel.append(list);
    if (focused) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
    }
}

/* Opening and closing */

export async function openScratchpad({ tab = '', note = null } = {}) {
    await loadStylesheetAsync(STYLESHEET, { id: 'neconyan-scratchpad-css' }).catch(() => null);
    build();
    readPrefs();
    globalThis.NeconyanNotes?.hide?.();
    setNotebookSource(note);
    app.open = true;
    app.el.root.hidden = false;
    if (isPhone()) globalThis.NeconyanShell?.closeWorkspace?.();
    applyLayout();
    selectTab(tab || app.tab);
    const next = currentSource();
    if ((next?.key ?? '') !== (app.source?.key ?? '') || !app.bucket) {
        stopWatchers();
        app.source = next;
        app.bucket = null;
        app.contextKey = '';
        render();
        await reload();
    } else {
        app.source = next;
        app.contextKey = '';
        render();
        await reload();
    }
    clearInterval(app.timer);
    app.timer = setInterval(checkSource, SOURCE_POLL_MS);
    if (note) {
        const ref = { notebookId: note.notebookId, noteId: note.noteId, ...(note.grantId ? { grantId: note.grantId } : {}) };
        const saved = await updateSettings(latest => ({ notes: [...(latest.notes ?? []).filter(item => item.notebookId !== ref.notebookId || item.noteId !== ref.noteId), ref] }), { rerenderContext: true });
        if (!saved) throw new Error(t`The note could not be added to Scratchpad. Return to Notes and try sharing it again.`);
        selectTab('context');
    }
    if (!isPhone()) app.el.composer.focus({ preventScroll: true });
}

export function hideScratchpad() {
    if (!app.open) return;
    app.open = false;
    clearInterval(app.timer);
    app.timer = 0;
    stopWatchers();
    setNotebookSource(null);
    app.el.root.hidden = true;
    applyLayout();
}

export async function toggleScratchpad(options) {
    if (app.open) hideScratchpad();
    else await openScratchpad(options);
}

export function isScratchpadOpen() {
    return app.open;
}

/** Workspace rail navigation hides a full-width or phone Scratchpad, and Notes always replaces it. */
export function onWorkspaceRoute(route) {
    if (!app.open || route === 'scratchpad') return;
    if (route === 'notes' || isPhone() || app.layout === 'full') hideScratchpad();
}

globalThis.NeconyanScratchpad = Object.freeze({
    open: openScratchpad,
    hide: hideScratchpad,
    toggle: toggleScratchpad,
    isOpen: isScratchpadOpen,
    onRoute: onWorkspaceRoute,
});

export const testExports = { replyDraft, contextSummary, clampWidth, sessionMatches };
