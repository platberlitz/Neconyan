/**
 * Scratchpad: a private discussion with your chosen assistants, with or without
 * a story chat. Nothing written here goes into the chat unless the user presses
 * Save change on a reviewed suggestion.
 */
import { getActiveGenerationAcknowledgement, messageFormatting, saveSettings } from '../../script.js';
import { escapeHtml } from './escape-html.js';
import { stripForeignPortraitUrls, strictReplySanitizerOverrides } from '../neconyan-conversation/reply-sanitizer.js';
import { loadStylesheetAsync } from '../dynamic-styles.js';
import { event_types, eventSource } from '../events.js';
import { extension_settings } from '../extensions.js';
import { t, translate } from '../i18n.js';
import { updateMessageTokenCounts } from '../message-token-counts.js';
import { getAssistantGender, getAssistantIconSrc } from '../neconyan-assistant-art.js';
import { append, clear, h, formatBytes } from '../notebooks/dom.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';
import { buildTextDiffMarkup, textDiffParts } from '../text-diff.js';
import { accountStorage } from '../util/AccountStorage.js';
import { getCurrentUserHandle } from '../user.js';
import { foldSearchText } from '../util/fuzzy-search.js';
import * as api from './api.js';
import { addReplyVersion, prepareChange, replyVersionTarget } from './changes.js';
import { canUndoEntry, findHistoryEntry, historyHeading, renderChangeHistory } from './change-history-ui.js';
import { needsSavedPersonaSelection, saveSelectedPersona } from './persona-changes.js';
import {
    buildContext,
    buildHelp,
    collectLore,
    currentSource,
    estimateTokens,
    generalLorebooks,
    isCurrentSource,
    sameChat,
    picksMatchSource,
    loreOverrideKey,
    loreScanText,
    sourceConnectionProfile,
    sourceCharacters,
    sourceLorebookNames,
    sourcePersona,
    sourceMessages,
    sourceUserName,
    setNotebookSource,
    wireSource,
} from './context.js';
import { world_names } from '../world-info.js';
import { describeChange, splitReply } from './proposals.js';
import { chooseNote, sessionNoteText } from './notebooks.js';
import { currentPresetName } from './preset.js';
import { openAssistantLibrary } from './assistants.js';
import { sameSourceBucket, sameSourceContext } from './source.js';
import { observeJob, TERMINAL } from '../jobs.js';
import * as images from './images.js';
import { integerSettingValue, reflectSavedValue, reflectedSettingValue } from './setting-input.js';
import { renderWebPages, renderWebSearchSettings, renderWebSearchSources, setWebSearchToggle } from './web-search.js';
import { splitBugReports } from './bug-report.js';
import { renderBugReportCard, renderSourceLookup } from './source-findings.js';
import { shareFollowUp, shareSettingsPatch, splitShareRequests } from './share-request.js';
import { renderShareRequestCard, shareItemLabels } from './share-request-ui.js';
import { prepareAttachment } from './attachments.js';
import { MAX_ATTACHMENTS, normaliseAttachments } from './attachment-data.js';
import { previewForBlock, previewFromText, previewLanguage } from './preview-source.js';
import { showHtmlPreview } from './html-preview.js';
import { MAX_REPLY_SWIPES, replySwipes } from './swipes.js';
import { buildSessionExport, chooseSessionExport, exportFileName, MAX_IMPORT_BYTES, sessionMarkdown, withoutAttachments } from './export.js';
import { roundToDiscuss } from './discuss.js';
import { CURRENT_CONNECTION_CHOICE, activeCompareConnection, compareChoiceValue, compareConnectionFromChoice, comparedSiblings, comparingPending, sameCompareTarget } from './compare.js';
import { canDictate, DICTATION_SERVICES, DictationError, dictationService, MAX_DICTATION_SECONDS, recordingToWav, startRecording, transcribeWav } from './dictation.js';
import { expandTypedTools, MAX_ROLL_DICE, MAX_ROLL_SIDES, TypedToolError } from './typed-tools.js';
import { canReadAloud, isReadingAloud, speakReplies, spokenText, stopReadAloud, toggleReadAloud } from './read-aloud.js';
import { createAudioContext, createTalkMode, monitorStream, TALK_PAUSES, talkPause } from './talk-mode.js';
import { editQuickPrompts } from './quick-prompts.js';
import { createQuickBarState, quickBarExpanded, toggleQuickBar, wheelScrollDelta } from './quick-bar.js';
import { findShortcuts, parseShortcut, replaceShortcut } from './check-shortcuts.js';
import { MAX_PINNED_NOTE_BYTES, pinnedNoteContext } from './pinned-note.js';
import { canRehearse, normaliseRehearsalLabel } from './rehearsal.js';
import { buildTryRehearsalRequest, canTryProposalInRehearsal } from './rehearsal-preview.js';
import { assistantFeedbackTone, DEFAULT_FEEDBACK_TONE, FEEDBACK_TONES, isFeedbackTone, normaliseFeedbackTone } from './feedback-tone.js';
import { feedbackToneLabel, feedbackToneSlider } from './tone-slider.js';
import {
    clearFollowUps, clearHold, createFollowUp, createFollowUpQueues, dequeueFollowUp, enqueueFollowUp, followUpKey, followUpState,
    holdFollowUps, MAX_QUEUED_FOLLOW_UPS, reconcilePendingTransition, removeFollowUp, restoreFollowUp, takeFollowUpForEdit,
} from './follow-up-queue.js';

const STYLESHEET = 'css/neconyan-scratchpad.css?v=20261214-recent-chats-ear';
const PHONE_QUERY = '(max-width: 768px)';
const PREFS_KEY = 'neconyanScratchpad';
const DEFAULT_WIDTH = 420;
const SOURCE_POLL_MS = 1500;
const PICK_PAGE = 30;
const CONTEXT_SUB_TABS = ['sharing', 'replies', 'setup'];
const SESSION_TEXT_MESSAGES = 6;
const ACK_ATTEMPTS = 4;

const ASSISTANTS = Object.freeze([
    { id: 'miso', name: 'Miso' },
    { id: 'taro', name: 'Taro' },
    { id: 'nori', name: 'Nori' },
]);

function assistantRole(id) {
    if (!ASSISTANTS.some(item => item.id === id)) return assistantInfo(id).sourceCard ? t`From a character card` : t`Your assistant`;
    if (id === 'taro') return t`Careful troubleshooter`;
    if (id === 'nori') return t`Playful writing partner`;
    return t`Cheerful guide`;
}

function quickPrompts() {
    const image = app.imageAvailability?.image ? [{ label: t`Image idea`, text: t`Suggest an image based on my idea, using my Quick Image Gen settings. Ask what I want to depict first.` }] : [];
    const checks = checkPrompts();
    if (app.source?.kind === 'general') return [
        { label: t`Brainstorm`, text: t`Help me brainstorm some ideas. Ask what I am working on first.` },
        { label: t`Help me decide`, text: t`Help me think through a decision. Ask me about the options and what matters to me.` },
        { label: t`Create a character`, text: t`Help me create a character. Ask about the idea, then propose a new character card for me to review.` },
        ...checks,
        ...image,
    ];
    if (app.source?.kind === 'notebook') return [
        { label: t`Summarise note`, text: t`Summarise the shared note, keeping its important details.` },
        { label: t`Develop ideas`, text: t`Suggest three ways to develop the ideas in the shared note.` },
        { label: t`Check consistency`, text: t`Check the shared note for contradictions, missing details and unclear passages.` },
        { label: t`Suggest edits`, text: t`Suggest focused improvements to the shared note. Propose changes only where the shared permissions allow them.` },
        ...checks,
        ...image,
    ];
    return [
        { label: t`Read the scene`, text: t`Read the current scene and tell me what each character wants and what is driving them right now.` },
        { label: t`Plot ideas`, text: t`Give me three ideas for where the story could go next, each with a different tone.` },
        { label: t`Catch me up`, text: t`Summarise what has happened so far in a few short paragraphs.` },
        { label: t`Continuity check`, text: t`Check the recent messages for contradictions, slipped details or anything that does not match the characters or lore.` },
        { label: t`Lore gaps`, text: t`Which people, places or things in this chat deserve a lorebook entry that they do not have yet? Suggest the entries.` },
        ...checks,
        ...image,
    ];
}

/**
 * Every check this session knows about, in the order of the quick prompts. `problem` says what is missing when a check cannot run
 * now and is empty when it can. The quick prompts offer the checks without a problem; the /check and /why shortcuts read the same list.
 */
function checkAvailability() {
    const source = app.source;
    if (!source) return [];
    const notebook = source.kind === 'notebook';
    const settings = currentSettings();
    const include = settings.include || {};
    const general = source.kind === 'general';
    const noNotes = t`Checks aren't offered in a note discussion. Open General Scratchpad or a chat to run one.`;
    const books = notebook ? [] : general ? generalLorebooks(source, settings) : sourceLorebookNames(source);
    const presetName = notebook ? '' : currentPresetName();
    const presetShared = source.kind === 'roleplay' || source.kind === 'conversation' || (general && Boolean(include.preset));
    let presetProblem = '';
    if (notebook) presetProblem = noNotes;
    else if (!presetShared && !presetName) presetProblem = t`No preset is shared and none is equipped. Equip a preset, then turn on Current preset under Story and lore in Context → Sharing.`;
    else if (!presetShared) presetProblem = t`No preset is shared. Turn on Current preset under Story and lore in Context → Sharing, then try again.`;
    else if (!presetName) presetProblem = t`No preset is equipped, so there is nothing to check. Equip a preset, then try again.`;
    let bookProblem = '';
    if (notebook) bookProblem = noNotes;
    else if (!books.length) {
        if (general) bookProblem = t`No lorebook is picked. Pick one under Share a lorebook in the Context tab, then try again.`;
        else if (source.kind === 'conversation') bookProblem = t`No lorebook is linked to this Conversation. Link one to its character or to your persona, then try again.`;
        else bookProblem = t`No lorebook is linked to this chat. Link one to the character, your persona or the chat, or turn one on for every chat, then try again.`;
    }
    const cardProblem = notebook ? noNotes : sourceCharacters(source).length ? '' : general
        ? t`General Scratchpad has no character card to share here. Open Scratchpad from a chat, or from a character you have selected, then try again.`
        : t`This chat has no character card to check.`;
    const whyText = t`Check the activation trace and explain why a lorebook entry did not trigger, and offer a fix if needed.`;
    return [
        { key: 'card', command: '/check card', label: t`Check my card`, problem: cardProblem,
            text: t`Check the shared card for problems and explain how to fix them.`, include: { card: true } },
        { key: 'preset', command: '/check preset', label: t`Check my preset`, problem: presetProblem,
            text: t`Check the shared preset for problems and explain how to fix them.`, include: { preset: true } },
        { key: 'lorebook', command: '/check lorebook', label: t`Check my lorebook`, problem: bookProblem,
            text: t`Check the shared lorebook for problems and explain how to fix them.`, include: { lore: true } },
        { key: 'why', command: '/why <entry>', label: t`Why didn't an entry trigger?`, problem: bookProblem, text: whyText, include: { lore: true } },
        { key: 'app', command: '/check app', label: t`What went wrong in Neconyan?`, problem: notebook ? noNotes : '',
            text: t`Use the app diagnostics to tell me what went wrong in Neconyan, and what I should try or share next.`, include: { appEvidence: true } },
        { key: 'source', command: '/check source', label: t`Check Neconyan's code for this bug`, problem: notebook ? noNotes : '',
            text: t`Use the app diagnostics and Neconyan's source code to find what causes this bug. Cite the files and lines you used, say what I can do about it for now, and draft a bug report if it is a bug in Neconyan.`, include: { appEvidence: true, appSource: true } },
        { key: 'prompt', command: '/check prompt', label: t`Inspect the last prompt sent`, problem: lastPromptProblem(source),
            text: t`Look at the last prompt sent to the model for this chat. Tell me what reached it, in what order, and anything that looks wrong or missing.`, include: { lastPrompt: true } },
    ];
}

/** Why the last prompt sent cannot be shared from this source, or '' when it can: only an open Roleplay or Conversation chat has one. */
function lastPromptProblem(source) {
    if (source?.kind === 'roleplay' || source?.kind === 'conversation') return '';
    if (source?.kind === 'notebook') return t`Checks aren't offered in a note discussion. Open General Scratchpad or a chat to run one.`;
    return t`General Scratchpad has no story chat, so there is no prompt to share. Open Scratchpad from a Roleplay or Conversation chat, then try again.`;
}

/** The check prompts for items this session can actually inspect. Tapping one also turns on its sharing switches. */
function checkPrompts() {
    return checkAvailability().filter(item => !item.problem).map(({ label, text, include }) => ({ label, text, include }));
}

const MAX_GENERAL_LOREBOOKS = 8;
const DEFAULT_SETTINGS = Object.freeze({
    depth: 15,
    picked: [],
    notes: [],
    include: { card: true, persona: true, authorsNote: true, lore: true, preset: false, hidden: false, agents: false, regex: false, cssSnippets: false, dialogueColors: false, mewmory: false, problems: false, appEvidence: false, appSource: false, lastPrompt: false, companionNotes: false },
    loreOverrides: {},
    lorebook: '',
    lorebooks: [],
    connection: { kind: 'current' },
    assistantConnections: {},
    compareConnection: null,
    roundTable: false,
    randomReply: false,
    feedbackTone: DEFAULT_FEEDBACK_TONE,
    assistantTones: {},
    participants: ['miso', 'taro', 'nori'],
    maxTokens: 32000,
    stream: true,
    prefill: '',
    partialPrefill: '',
    webSearch: false,
    readLinks: false,
    autoSummary: false,
});

const app = {
    built: false,
    open: false,
    opening: 0,
    layout: 'beside',
    width: DEFAULT_WIDTH,
    assistant: 'miso',
    connections: {},
    library: { assistants: [], revision: 0 },
    libraryOpen: false,
    tab: 'chat',
    overviewCollapsed: false,
    quickBar: createQuickBarState(),
    quickWheel: null,
    source: null,
    personaWarning: false,
    bucket: null,
    ticket: 0,
    sending: false,
    swiping: false,
    editing: '',
    drafts: new Map(),
    draftKey: '',
    draftOwner: '',
    attachments: [],
    attachmentDrafts: new Map(),
    readingFiles: new Set(),
    // Follow-ups typed while a reply is pending, per session. They live in this tab only and reset on reload.
    followUps: createFollowUpQueues(),
    followUpSeen: new Map(),
    followUpAway: new Set(),
    followUpStops: new Set(),
    previews: new Map(),
    foldedThinking: new Set(),
    // Share cards this client dismissed or partly unticked, keyed by session, reply and card. They reset on reload.
    shareDismissed: new Set(),
    shareUnticked: new Map(),
    sharing: false,
    openLorebooks: new Set(),
    openSwipes: new Set(),
    openMenus: new Set(),
    openMenusSessionId: '',
    watchers: new Map(),
    imageWatchers: new Map(),
    imageJobSignatures: new Map(),
    imageJobs: new Map(),
    // Image jobs whose prompt review this client asked for and has not shown yet.
    imageAutoReviews: new Set(),
    imageErrors: new Map(),
    imageAvailability: { image: false, reason: '' },
    imageCheck: 0,
    webSearch: null,
    webSearchCheck: 0,
    webSearchSaving: false,
    webSearchDraft: null,
    webSearchLoad: null,
    webSearchOwner: '',
    quickPrompts: { prompts: [], revision: 0 },
    contextSetups: { setups: [], revision: 0 },
    contextSetup: '',
    dictation: 'local',
    dictating: null,
    talkPause: 'normal',
    talk: null,
    pickLimit: PICK_PAGE,
    sessionQuery: '',
    everyList: { query: '', loading: false, results: [], more: false, error: '' },
    contextKey: '',
    contextSubTab: 'sharing',
    contextDrawers: new Map(),
    contextPatch: {},
    contextLive: [],
    timer: 0,
    recoveryTimer: null,
    recoveryAttempt: 0,
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
        if (allAssistants().some(item => item.id === saved.assistant)) app.assistant = saved.assistant;
        if (typeof saved.collapsed === 'boolean') app.overviewCollapsed = saved.collapsed;
        if (typeof saved.contextSetup === 'string') app.contextSetup = saved.contextSetup;
        if (DICTATION_SERVICES.some(service => service.id === saved.dictation)) app.dictation = saved.dictation;
        if (TALK_PAUSES.some(pause => pause.id === saved.talkPause)) app.talkPause = saved.talkPause;
        if (CONTEXT_SUB_TABS.includes(saved.contextSubTab)) app.contextSubTab = saved.contextSubTab;
        for (const { id } of allAssistants()) {
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
        dictation: app.dictation,
        talkPause: app.talkPause,
        contextSetup: app.contextSetup,
        contextSubTab: app.contextSubTab,
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
    const setup = findContextSetup(app.contextSetup) ?? app.contextSetups.setups[0];
    if (setup) input.settings = structuredClone(setup.settings);
    if (!activeSession()) input.settings = { ...input.settings, assistantConnections: rememberedConnections() };
    return input;
}

function allAssistants(session = activeSession()) {
    const profiles = new Map(Object.values(session?.settings.assistants ?? {}).map(item => [item.id, item]));
    for (const item of app.library.assistants) profiles.set(item.id, item);
    return [...ASSISTANTS, ...profiles.values()];
}

function assistantInfo(id, session = activeSession()) {
    return allAssistants(session).find(item => item.id === id) ?? { id, name: t`Unavailable assistant` };
}

function assistantPortrait(id, session = activeSession()) {
    return assistantInfo(id, session).avatar || getAssistantIconSrc(id);
}

function canChooseAssistant(id) {
    const session = activeSession();
    const participants = sessionAssistants();
    if (app.sending || pendingReply()) return false;
    return !session?.settings.roundTable || (participants.includes(id) ? participants.length > 1 : participants.length < 3);
}

async function manageAssistants() {
    if (app.libraryOpen) return;
    app.libraryOpen = true;
    try {
        await openAssistantLibrary({ assistants: allAssistants, portrait: assistantPortrait, selected: sessionAssistants,
            canChoose: canChooseAssistant, choose: chooseAssistant, onSave: library => {
                app.library = library;
                if (!allAssistants().some(item => item.id === app.assistant)) {
                    app.assistant = 'miso';
                    writePrefs();
                }
                app.contextKey = '';
                render();
            } });
    } catch (error) {
        reportError(error, t`Your assistants could not be loaded.`);
    } finally { app.libraryOpen = false; }
}

function activeSession() {
    const bucket = app.bucket;
    if (!bucket) return null;
    return bucket.sessions.find(item => item.id === bucket.activeSessionId) ?? null;
}

function currentSettings() {
    return activeSession()?.settings ?? { ...structuredClone(DEFAULT_SETTINGS), ...sessionInput().settings };
}

function assistantConnection(settings, assistant) {
    return settings.assistantConnections?.[assistant] ?? settings.connection ?? { kind: 'current' };
}

function sessionAssistants(session = activeSession()) {
    return session?.settings.roundTable ? session.settings.participants : [session?.assistant ?? app.assistant];
}

function sharedFeedbackTone() {
    return normaliseFeedbackTone(currentSettings().feedbackTone);
}

/* Assistants in this session whose own tone differs from the shared one. */
function feedbackToneOverrides(session = activeSession()) {
    const settings = currentSettings();
    const shared = sharedFeedbackTone();
    return sessionAssistants(session).map(id => ({ id, tone: assistantFeedbackTone(settings, id) })).filter(item => item.tone !== shared);
}

function renderFeedbackTone(session) {
    const el = app.el;
    el.feedbackTone.setTone(sharedFeedbackTone());
    el.feedbackTone.setDisabled(!app.source || app.sending || Boolean(pendingReply()));
    const overrides = feedbackToneOverrides(session);
    el.toneOverrides.hidden = !overrides.length;
    el.toneOverrides.textContent = overrides.map(item => t`${assistantInfo(item.id).name} uses ${feedbackToneLabel(item.tone)}`).join(', ');
}

async function changeFeedbackTone(tone) {
    if (!isFeedbackTone(tone)) return;
    await updateSettings({ feedbackTone: tone });
    renderHeader();
}

function randomReplyEnabled() {
    const settings = currentSettings();
    return settings.roundTable && settings.randomReply;
}

function pendingReply(session = activeSession()) {
    return session?.messages.find(item => item.role === 'assistant' && item.state === 'pending') ?? null;
}

/* Follow-ups queued while a reply is still being written */

function activeFollowUpKey(session = activeSession()) {
    return app.source && session ? followUpKey(app.source, session.id) : '';
}

function activeFollowUps() {
    const key = activeFollowUpKey();
    return key ? followUpState(app.followUps, key) : followUpState(app.followUps, '');
}

function resetFollowUps() {
    clearFollowUps(app.followUps);
    app.followUpSeen.clear();
    app.followUpAway.clear();
    app.followUpStops.clear();
}

// A queue whose session is out of sight never fires; it comes back paused instead.
function markFollowUpsAway() {
    const visible = app.open ? activeFollowUpKey() : '';
    for (const key of app.followUps.keys()) if (key !== visible) app.followUpAway.add(key);
}

// The replies to the latest user message, with a stopped reply told apart from one that failed.
function settledReplyStates(session) {
    const messages = session?.messages ?? [];
    const stopped = app.followUpStops.has(session?.id);
    return messages.slice(messages.findLastIndex(item => item.role === 'user') + 1)
        .filter(item => item.role === 'assistant')
        .map(item => {
            if (item.state === 'pending') return 'pending';
            if (item.state !== 'failed') return 'done';
            return stopped || /^Stopped\b/.test(String(item.error || '')) ? 'cancelled' : 'failed';
        });
}

function followUpNotice(held) {
    if (held === 'stopped') return t`Paused because the previous reply stopped.`;
    if (held === 'failed') return t`Paused because the previous reply failed.`;
    if (held === 'context') return t`Paused because the chat changed. Return to send, or press Send now.`;
    if (held === 'reopened') return t`Paused while you were away. Press Send now to send it.`;
    return '';
}

function reconcileFollowUps() {
    const session = activeSession();
    const key = activeFollowUpKey(session);
    if (!key) return;
    const isPending = Boolean(pendingReply(session));
    const wasPending = app.followUpSeen.get(key) ?? false;
    const settledStates = settledReplyStates(session);
    app.followUpSeen.set(key, isPending);
    if (!isPending) app.followUpStops.delete(session.id);
    const state = followUpState(app.followUps, key);
    if (!state.items.length) {
        app.followUpAway.delete(key);
        return;
    }
    if (isPending && app.open) app.followUpAway.delete(key);
    const visible = app.open && !app.followUpAway.has(key);
    const sameSource = isCurrentSource(state.items[0].source);
    if (!isPending && state.held === 'context' && visible && sameSource && !app.sending && !app.swiping) {
        clearHold(app.followUps, key);
        void sendNextFollowUp();
        return;
    }
    const outcome = reconcilePendingTransition({ wasPending, isPending, settledStates, visible, sameSource });
    if (outcome === 'send' && !state.held) {
        // Another send or swipe still owns the composer; try again on the next bucket update.
        if (app.sending || app.swiping) app.followUpSeen.set(key, true);
        else void sendNextFollowUp();
    } else if (outcome.startsWith('hold-')) {
        const held = holdFollowUps(app.followUps, key, outcome.slice('hold-'.length)).held;
        app.followUpAway.delete(key);
        renderFollowUps();
        announceReply(followUpNotice(held));
    }
}

async function sendNextFollowUp() {
    const key = activeFollowUpKey();
    if (!key || app.sending || app.swiping || pendingReply()) return false;
    const { item } = dequeueFollowUp(app.followUps, key);
    if (!item) return false;
    renderFollowUps();
    return send({ queuedItem: item, queuedKey: key });
}

async function sendFollowUpNow() {
    const key = activeFollowUpKey();
    if (!key) return;
    const state = followUpState(app.followUps, key);
    // Send now after a context change means sending into the context on screen.
    if (state.held === 'context') for (const item of state.items) item.source = app.source;
    clearHold(app.followUps, key);
    app.followUpAway.delete(key);
    // With a reply still running, Send now just lifts the pause so the queue goes out after it.
    if (pendingReply()) {
        app.followUpSeen.set(key, true);
        renderComposer();
        return;
    }
    await sendNextFollowUp();
}

function typedToolLabels() {
    return { picked: t`Picked`, from: t`from`, now: t`Now` };
}

// Returns false when there is nothing to queue, so the primary button can stop the reply instead.
function queueFollowUp() {
    const session = activeSession();
    const key = activeFollowUpKey(session);
    if (!key || !pendingReply(session)) return false;
    const text = app.el.composer.value.trim();
    const attachments = app.attachments;
    if (!text && !attachments.length) return false;
    if (app.readingFiles.has(attachments)) return true;
    if (followUpState(app.followUps, key).items.length >= MAX_QUEUED_FOLLOW_UPS) {
        toastr.warning(t`Up to five follow-ups can wait at once.`);
        return true;
    }
    if (text) {
        try {
            if (expandTypedTools(text, { labels: typedToolLabels() }).help) {
                showToolsHelp();
                return true;
            }
        } catch (error) {
            if (!(error instanceof TypedToolError)) throw error;
            toastr.warning(typedToolProblem(error), t`Nothing was queued`);
            app.el.composer.focus();
            return true;
        }
    }
    const item = createFollowUp({ text, attachments, source: app.source, sourceKey: key });
    if (!enqueueFollowUp(app.followUps, key, item).added) {
        toastr.warning(t`Up to five follow-ups can wait at once.`);
        return true;
    }
    app.followUpSeen.set(key, true);
    attachments.splice(0, attachments.length);
    app.el.composer.value = '';
    renderComposer();
    app.el.composer.focus();
    return true;
}

function editFollowUp(id) {
    const key = activeFollowUpKey();
    const queued = followUpState(app.followUps, key).items.find(item => item.id === id);
    if (!queued) return;
    if (app.attachments.length + queued.attachments.length > MAX_ATTACHMENTS) {
        toastr.warning(t`Attach up to eight files per message.`);
        return;
    }
    const { item } = takeFollowUpForEdit(app.followUps, key, id);
    const composer = app.el.composer;
    composer.value = [item.text, composer.value.trim()].filter(Boolean).join('\n\n');
    app.attachments.splice(0, 0, ...item.attachments);
    renderComposer();
    composer.focus();
    composer.setSelectionRange(composer.value.length, composer.value.length);
}

function removeQueuedFollowUp(id) {
    removeFollowUp(app.followUps, activeFollowUpKey(), id);
    renderComposer();
}

function renderFollowUpItem(item) {
    const count = item.attachments.length;
    const files = count === 1 ? t`1 file` : t`${count} files`;
    const preview = item.text.replace(/\s+/g, ' ').trim();
    return h('li', { class: 'scratchpad-queue-item' },
        h('span', { class: 'scratchpad-queue-text', 'data-i18n-ignore': '', title: item.text || null, text: preview || files }),
        count && preview ? h('span', { class: 'scratchpad-queue-files', title: files },
            h('i', { class: 'fa-solid fa-paperclip', 'aria-hidden': 'true' }),
            h('span', { class: 'sr-only', text: files }),
            h('span', { 'aria-hidden': 'true', text: String(count) })) : null,
        iconButton('', () => editFollowUp(item.id), { icon: 'fa-pen', className: 'scratchpad-queue-edit', title: t`Edit queued follow-up` }),
        iconButton('', () => removeQueuedFollowUp(item.id), { icon: 'fa-xmark', className: 'scratchpad-queue-remove', title: t`Remove queued follow-up` }));
}

function renderFollowUps() {
    const strip = app.el.queue;
    if (!strip) return;
    const state = activeFollowUps();
    clear(strip);
    strip.hidden = !state.items.length;
    if (!state.items.length) return;
    const notice = followUpNotice(state.held);
    append(strip, [
        h('div', { class: 'scratchpad-queue-head' },
            h('span', { class: 'scratchpad-queue-title', text: t`Queued next` }),
            state.held ? iconButton(t`Send now`, () => void sendFollowUpNow(), { icon: 'fa-paper-plane', className: 'scratchpad-queue-send', disabled: app.sending || app.swiping, primary: true }) : null),
        notice ? h('p', { class: 'scratchpad-queue-notice', text: notice }) : null,
        h('ol', { class: 'scratchpad-queue-list' }, state.items.map(renderFollowUpItem)),
    ]);
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
    const reserved = dockedWidth();
    const width = clampWidth(app.width, reserved);
    document.body.style.setProperty('--neco-scratchpad-width', `${width}px`);
    app.el.resizer.setAttribute('aria-valuemin', '320');
    app.el.resizer.setAttribute('aria-valuemax', String(clampWidth(Infinity, reserved)));
    app.el.resizer.setAttribute('aria-valuenow', String(width));
    document.dispatchEvent(new Event('neconyan:scratchpad-visibility'));
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
    document.addEventListener('visibilitychange', wakePendingJobs);
    // A hidden tab cannot be listened to or answered, so talk mode lets go of the microphone.
    document.addEventListener('visibilitychange', () => { if (document.hidden) endTalk(); });
    globalThis.addEventListener('online', wakePendingJobs);

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
    const tabList = h('div', { class: 'scratchpad-tabs', role: 'tablist', 'aria-label': t`Scratchpad sections`, onkeydown: onTabKey });
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

    el.heading = h('h2', { class: 'scratchpad-heading', tabindex: '-1', text: t`Scratchpad` });
    el.resizer = h('div', {
        class: 'scratchpad-resizer',
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': t`Resize Scratchpad`,
        tabindex: '0',
        onpointerdown: startResize,
        onkeydown: resizeWithKeys,
    });
    el.root = h('section', { id: 'neconyan-scratchpad', class: 'scratchpad-app', 'aria-label': t`Scratchpad`, hidden: true },
        el.resizer,
        h('header', { class: 'scratchpad-header' },
            el.portrait,
            h('div', { class: 'scratchpad-title' },
                el.heading,
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
    for (const event of [event_types.PRESET_CHANGED, event_types.MAIN_API_CHANGED, event_types.OAI_PRESET_CHANGED_AFTER]) {
        eventSource.on(event, () => app.open && render());
    }
    for (const event of [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED, event_types.SECRET_EDITED]) {
        eventSource.on(event, () => app.open && void refreshWebSearchConfig({ quiet: true }));
    }
    globalThis.addEventListener('sb:conversation-workspace-state-changed', () => app.open && checkSource());
    wireHomeSourceEvents();
    globalThis.addEventListener('neconyan:assistant-gender-changed', () => app.open && render());
}

function wireHomeSourceEvents() {
    for (const event of ['neconyan:navigate-home', 'neconyan:home-hidden']) {
        globalThis.addEventListener(event, () => queueMicrotask(() => app.open && checkSource()));
    }
}

function buildChatPanel() {
    const el = app.el;
    el.roundTable = iconButton(t`Round table`, () => void updateSettings(settings => {
        const current = activeSession()?.assistant ?? app.assistant;
        return {
            roundTable: !settings.roundTable,
            ...(!settings.roundTable && !settings.participants.includes(current) ? { participants: [current, ...settings.participants.slice(0, 2)] } : {}),
        };
    }),
    { icon: 'fa-users', pressed: false, className: 'scratchpad-round-table', title: t`Ask up to three assistants together` });
    el.randomReply = iconButton(t`Random`, () => void updateSettings(settings => ({ randomReply: !settings.randomReply })),
        { icon: 'fa-shuffle', pressed: false, className: 'scratchpad-random', title: t`One random assistant replies per message` });
    el.assistantPicker = h('div', { class: 'scratchpad-assistants', role: 'group', 'aria-label': t`Talking with` });
    el.manageAssistants = iconButton(t`Assistants`, () => void manageAssistants(), { icon: 'fa-user-plus', title: t`Choose or add an assistant` });
    el.pinnedNote = iconButton(t`Pinned note`, () => void editPinnedNote(), { icon: 'fa-thumbtack', className: 'scratchpad-pinned-note', title: t`Edit the session's pinned note or story tracker` });
    el.feedbackTone = feedbackToneSlider({ id: 'scratchpad-feedback-tone', tone: DEFAULT_FEEDBACK_TONE, compact: true,
        onChange: tone => void changeFeedbackTone(tone) });
    el.toneOverrides = h('span', { class: 'scratchpad-tone-overrides' });
    el.summary = h('div', { class: 'scratchpad-summary' });
    el.messages = h('div', { class: 'scratchpad-messages' });
    el.replyStatus = h('div', { class: 'sr-only', role: 'status' });
    el.quick = h('div', { class: 'scratchpad-quick', role: 'group', 'aria-label': t`Quick prompts` },
        quickPromptChips());
    el.quick.addEventListener('scrollend', () => { app.quickWheel = null; });
    el.quickToggle = h('button', {
        type: 'button',
        class: 'scratchpad-quick-toggle',
        'aria-controls': 'scratchpad-quick-rail',
        'aria-expanded': 'true',
        'aria-label': t`Quick prompts`,
        title: t`Hide quick prompts`,
        onclick: onQuickToggle,
    }, h('i', { class: 'fa-solid fa-chevron-down', 'aria-hidden': 'true' }), h('span', { text: t`Quick prompts` }));
    el.quickEdit = iconButton('', () => void openQuickPromptEditor(), { icon: 'fa-pen', title: t`Edit quick prompts`, className: 'scratchpad-chip scratchpad-chip-edit' });
    const quickRail = h('div', { id: 'scratchpad-quick-rail', class: 'scratchpad-quick-rail' }, el.quick);
    quickRail.addEventListener('wheel', onQuickWheel, { passive: false });
    el.quickBar = h('div', { class: 'scratchpad-quick-bar', 'data-expanded': 'true' },
        el.quickToggle,
        quickRail,
        el.quickEdit);
    el.composer = h('textarea', {
        class: 'text_pole scratchpad-composer',
        rows: '1',
        placeholder: t`Ask anything...`,
        'aria-label': t`Message for Scratchpad`,
        onkeydown: onComposerKey,
        oninput: onComposerInput,
    });
    el.queue = h('section', { class: 'scratchpad-queue', 'aria-label': t`Queued next`, hidden: true });
    el.send = iconButton('', () => onSendButton(), { icon: 'fa-paper-plane', className: 'scratchpad-send', title: t`Send`, primary: true });
    el.webSearch = iconButton(t`Web search`, () => { closeComposeMenu(); void toggleWebSearch(); },
        { icon: 'fa-globe', className: 'scratchpad-web-toggle', title: t`Search the web for this message`, pressed: false });
    el.readLinks = iconButton(t`Read links`, () => { closeComposeMenu(); void toggleReadLinks(); },
        { icon: 'fa-link', className: 'scratchpad-read-links', title: t`Read the web pages linked in this message`, pressed: false });
    el.fileInput = h('input', { type: 'file', multiple: true, hidden: true, 'aria-label': t`Attach files`, onchange: () => {
        const files = [...el.fileInput.files];
        el.fileInput.value = '';
        void addAttachments(files);
    } });
    el.attach = iconButton(t`Attach files`, () => { closeComposeMenu(); el.fileInput.click(); }, { icon: 'fa-paperclip' });
    el.rehearse = iconButton(t`Rehearse next reply`, () => { closeComposeMenu(); void send({ rehearsal: true }); },
        { icon: 'fa-masks-theater', className: 'scratchpad-rehearse' });
    el.rehearse.setAttribute('aria-describedby', 'scratchpad-rehearse-help');
    el.rehearseHelp = h('span', { id: 'scratchpad-rehearse-help', hidden: true, text: t`Draft the next story reply here using the shared context. Anything in the message box becomes directions. The draft stays in Scratchpad.` });
    el.composeMenu = h('div', { id: 'scratchpad-compose-menu', class: 'scratchpad-compose-menu', hidden: true, role: 'group', 'aria-label': t`Message options` }, el.webSearch, el.readLinks, el.attach, el.rehearse, el.rehearseHelp);
    el.plus = iconButton('', () => {
        const open = el.composeMenu.hidden;
        el.composeMenu.hidden = !open;
        el.plus.setAttribute('aria-expanded', String(open));
        if (open) el.webSearch.focus();
    }, { icon: 'fa-plus', className: 'scratchpad-plus', title: t`Message options` });
    el.plus.setAttribute('aria-controls', 'scratchpad-compose-menu');
    el.plus.setAttribute('aria-expanded', 'false');
    el.dictate = canDictate() ? iconButton('', () => void toggleDictation(), { icon: 'fa-microphone-lines', className: 'scratchpad-dictate', title: t`Dictate`, pressed: false }) : null;
    el.talk = canDictate() ? iconButton('', toggleTalk, { icon: 'fa-comments', className: 'scratchpad-talk-toggle', title: t`Talk mode`, pressed: false }) : null;
    el.talkBar = el.talk ? buildTalkBar() : null;
    el.composeActions = h('div', { class: 'scratchpad-compose-actions', onkeydown: event => {
        if (event.key === 'Escape') { event.stopPropagation(); closeComposeMenu(); el.plus.focus(); }
    }, onfocusout: event => {
        if (event.relatedTarget && !el.composeActions.contains(event.relatedTarget)) closeComposeMenu();
    } }, el.plus, el.composeMenu, el.fileInput);
    document.addEventListener('pointerdown', event => {
        if (!el.composeActions.contains(event.target)) closeComposeMenu();
        for (const menu of el.messages.querySelectorAll('.scratchpad-message-menu[open]')) {
            if (!menu.contains(event.target)) closeMessageMenu(menu, menu.contains(document.activeElement));
        }
    });
    el.attachments = h('div', { class: 'scratchpad-draft-attachments', role: 'list', 'aria-label': t`Attached files` });
    el.fileStatus = h('p', { class: 'scratchpad-muted scratchpad-file-status', role: 'status', hidden: true });
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
        // Library and reply controls wrap after the current assistant choices.
        h('div', { class: 'scratchpad-chat-top' }, el.overviewToggle, el.assistantPicker, el.manageAssistants, el.roundTable, el.randomReply, el.pinnedNote),
        h('div', { class: 'scratchpad-tone-row' }, el.feedbackTone, el.toneOverrides),
        el.summary);
    append(el.panels.chat, [
        el.overviewBar,
        el.overview,
        el.replyStatus,
        el.messages,
        h('div', { class: 'scratchpad-compose' }, el.quickBar, el.attachments, el.fileStatus, el.talkBar, el.queue, h('div', { class: 'scratchpad-compose-row' }, el.composeActions, el.composer, el.dictate, el.talk, el.send)),
    ]);
}

function onTabKey(event) {
    const keys = Object.keys(app.el.tabs);
    const index = keys.indexOf(app.tab);
    const next = { ArrowLeft: (index + keys.length - 1) % keys.length, ArrowRight: (index + 1) % keys.length, Home: 0, End: keys.length - 1 }[event.key];
    if (!Number.isInteger(next)) return;
    event.preventDefault();
    event.stopPropagation();
    selectTab(keys[next]);
    app.el.tabs[keys[next]].focus();
}

function selectTab(key) {
    closeComposeMenu();
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
    if (!app.open) return;
    if (ticket !== null && ticket !== app.ticket) return;
    if (!sameSourceBucket(bucket?.source, app.source)) return;
    const firstSession = app.bucket?.sessions.length === 0 && bucket.sessions.length > 0;
    const before = activeSession();
    app.bucket = bucket;
    syncDraft({ carry: firstSession });
    const session = activeSession();
    if (session) app.assistant = session.assistant;
    announceReplyChange(before, session);
    markFollowUpsAway();
    checkTalkSession();
    render();
    renderHistoryView();
    syncWatchers();
    reconcileFollowUps();
}

function syncDraft({ carry = false } = {}) {
    const owner = getCurrentUserHandle();
    if (app.draftOwner !== owner) {
        app.draftOwner = owner;
        resetFollowUps();
        app.attachments = [];
        app.attachmentDrafts.clear();
        app.drafts.clear();
        app.draftKey = '';
        app.el.composer.value = '';
    }
    const key = JSON.stringify([app.source?.kind, app.source?.key, activeSession()?.id]);
    if (key === app.draftKey) return;
    const draft = app.el.composer.value;
    const emptyKey = JSON.stringify([app.source?.kind, app.source?.key, null]);
    const firstSession = key !== emptyKey && app.draftKey === emptyKey;
    closeComposeMenu();
    const attachments = app.attachments;
    if (firstSession) app.attachmentDrafts.delete(emptyKey);
    else if (app.draftKey) app.attachmentDrafts.set(app.draftKey, attachments);
    app.attachments = app.attachmentDrafts.get(key) ?? (carry || firstSession ? attachments : []);
    if (firstSession) app.drafts.delete(emptyKey);
    else if (app.draftKey) app.drafts.set(app.draftKey, draft);
    app.draftKey = key;
    app.el.composer.value = app.drafts.get(key) ?? (carry || firstSession ? draft : '');
}

function requireScope(source, sessionId) {
    if (!sameSourceContext(source, app.source) || !isCurrentSource(source)
        || (sessionId !== undefined && activeSession()?.id !== sessionId)) {
        throw new Error(t`The context or Scratchpad session changed. Return to it and try again.`);
    }
}

async function reload() {
    const source = app.source;
    const owner = getCurrentUserHandle();
    const ticket = ++app.ticket;
    const current = () => app.open && owner === getCurrentUserHandle() && ticket === app.ticket && sameSourceBucket(source, app.source);
    if (!source) {
        app.bucket = null;
        render();
        return;
    }
    try {
        const result = await api.readBucket(wireSource(source));
        if (current()) {
            clearJobRecovery();
            applyBucket(result.bucket, { ticket });
        }
    } catch (error) {
        if (!current()) return;
        if (hasPendingJobs() && (error.network || (error.status >= 500 && error.code !== 'SCRATCHPAD_DAMAGED'))) scheduleJobRecovery();
        else reportError(error, t`Scratchpad could not load.`);
    }
}

function warnMissingPersona(source) {
    if (!app.open) return;
    const missing = source?.kind === 'general' && !sourcePersona(source);
    if (missing && !app.personaWarning) toastr.warning(t`No persona is selected. Pick one in Personas if you want General Scratchpad to use it.`);
    app.personaWarning = missing;
}

function checkSource() {
    if (app.open && Date.now() - app.imageCheck > 10000) void refreshImageAvailability();
    const next = currentSource();
    warnMissingPersona(next);
    if (sameSourceBucket(next, app.source)) {
        if (next) {
            const changed = next.label !== app.source?.label || !sameSourceContext(next, app.source);
            app.source = next;
            if (changed) {
                endTalk('context');
                app.contextKey = '';
                render();
                reconcileFollowUps();
            }
        }
        return;
    }
    endTalk('context');
    stopWatchers();
    app.source = next;
    app.bucket = null;
    markFollowUpsAway();
    app.editing = '';
    app.pickLimit = PICK_PAGE;
    app.openSwipes.clear();
    app.openMenus.clear();
    app.openMenusSessionId = '';
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
            if (result?.bucket && sameSourceBucket(source, app.source)) {
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
    if (rerenderContext && sameSourceBucket(source, app.source)) renderContext();
    return result;
}

/* Replies */

function hasPendingJobs() {
    return app.open && (app.bucket?.sessions ?? []).some(session => session.messages.some(message => message.state === 'pending'
        || Object.values(message.images ?? {}).some(image => image.state === 'pending')));
}

function clearJobRecovery() {
    clearTimeout(app.recoveryTimer);
    app.recoveryTimer = null;
    app.recoveryAttempt = 0;
}

function scheduleJobRecovery(immediate = false) {
    if (!hasPendingJobs() || (app.recoveryTimer !== null && !immediate)) return;
    clearTimeout(app.recoveryTimer);
    const delays = [2000, 5000, 10000];
    const delay = immediate ? 0 : delays[Math.min(app.recoveryAttempt++, delays.length - 1)];
    app.recoveryTimer = setTimeout(() => {
        app.recoveryTimer = null;
        if (hasPendingJobs()) void reload();
    }, delay);
}

function wakePendingJobs() {
    if (document.visibilityState !== 'hidden') scheduleJobRecovery(true);
}

function syncWatchers() {
    const wanted = new Set();
    const pending = new Set();
    for (const session of app.bucket?.sessions ?? []) {
        for (const message of session.messages) {
            if (message.role === 'assistant' && message.state === 'pending' && message.jobId) {
                wanted.add(message.jobId);
                pending.add(message.id);
            }
        }
    }
    for (const id of app.foldedThinking) if (!pending.has(id)) app.foldedThinking.delete(id);
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
                scheduleJobRecovery(result?.state !== 'unknown');
            },
        });
        app.watchers.set(jobId, stop);
    }
    const imageJobs = new Set((app.bucket?.sessions ?? []).flatMap(session => session.messages.flatMap(message => Object.values(message.images ?? {})
        .filter(image => image.state === 'pending' && image.jobId).map(image => image.jobId))));
    for (const [id, stop] of app.imageWatchers) if (!imageJobs.has(id)) { stop(); app.imageWatchers.delete(id); app.imageJobSignatures.delete(id); }
    for (const id of imageJobs) {
        if (app.imageWatchers.has(id)) continue;
        // onUpdate fires only when the job record changes. onSnapshot also fires on every poll (1.5 s),
        // which reloaded the bucket and redrew the thread while an image generated.
        const track = async job => {
            app.imageJobs.set(id, job);
            const signature = `${job.state}|${job.stage ?? ''}|${job.result?.approval?.id ?? ''}`;
            if (app.imageJobSignatures.get(id) === signature) return;
            app.imageJobSignatures.set(id, signature);
            if (app.open) await reload();
            if (TERMINAL.has(job.state)) app.imageAutoReviews.delete(id);
            if (app.open && job.result?.approval && app.imageAutoReviews.has(id)) {
                const card = imageReviewCard(id);
                // The reviewer decides in the popup, so the watcher must not wait for it.
                if (card) {
                    app.imageAutoReviews.delete(id);
                    void approveImagePrompt(card.session, card.message, card.part);
                }
            }
        };
        const stop = observeJob(id, { onUpdate: track, onStop: reason => {
            if (!['done', 'missing'].includes(reason) || app.imageWatchers.get(id) !== stop) return;
            app.imageWatchers.delete(id);
            scheduleJobRecovery();
        } });
        app.imageWatchers.set(id, stop);
    }
}

function stopWatchers() {
    clearJobRecovery();
    for (const stop of app.watchers.values()) stop();
    app.watchers.clear();
    app.previews.clear();
    for (const stop of app.imageWatchers.values()) stop();
    app.imageWatchers.clear();
    app.imageJobSignatures.clear();
    app.imageJobs.clear();
}

async function refreshImageAvailability() {
    app.imageCheck = Date.now();
    const owner = getCurrentUserHandle();
    try {
        const result = await images.imageAvailability();
        if (owner !== getCurrentUserHandle()) return;
        app.imageAvailability = result;
        if (app.open) renderHeader();
    } catch { app.imageAvailability = { image: false, reason: t`Quick Image Gen availability could not be checked.` }; }
}

/** Account-wide provider choice and whether the selected key or address is ready. */
async function loadWebSearchConfig({ quiet = true, rerenderContext = true } = {}) {
    const owner = getCurrentUserHandle();
    if (app.webSearchOwner && app.webSearchOwner !== owner) {
        app.webSearchDraft = null;
        app.webSearch = null;
    }
    app.webSearchOwner = owner;
    const ticket = ++app.webSearchCheck;
    try {
        const result = await api.readWebSearch();
        if (owner !== getCurrentUserHandle() || ticket !== app.webSearchCheck) return null;
        app.webSearch = { config: result.webSearch, readiness: result.readiness };
        if (app.open) {
            renderComposer();
            if (rerenderContext && app.tab === 'context') renderContext({ force: true });
        }
        return result;
    } catch (error) {
        if (owner !== getCurrentUserHandle() || ticket !== app.webSearchCheck) return null;
        app.webSearch = { config: null, readiness: null, error: error?.message || t`Web search settings could not be loaded.` };
        if (!quiet) reportError(error, t`Web search settings could not be loaded.`);
        if (app.open) {
            renderComposer();
            if (rerenderContext && app.tab === 'context') renderContext({ force: true });
        }
        return null;
    }
}

/** Share one read across rapid callers, and never let a stale read overwrite a save. */
async function refreshWebSearchConfig(options = {}) {
    if (app.webSearchSaving) return null;
    if (app.webSearchLoad) return app.webSearchLoad;
    const load = loadWebSearchConfig(options);
    app.webSearchLoad = load;
    try {
        return await load;
    } finally {
        if (app.webSearchLoad === load) app.webSearchLoad = null;
    }
}

function openWebSearchSettings(message = '') {
    app.contextSubTab = 'setup';
    app.contextDrawers.set('web-search', true);
    writePrefs();
    selectTab('context');
    renderContext({ force: true });
    const section = document.getElementById('scratchpad-web-search-settings');
    section?.scrollIntoView?.({ block: 'nearest' });
    document.getElementById('scratchpad-web-search-provider')?.focus?.({ preventScroll: true });
    if (message) toastr.info(message);
}

async function toggleReadLinks() {
    if (!app.source || app.sending || pendingReply()) return;
    const enabled = currentSettings().readLinks === true;
    await updateSettings({ readLinks: !enabled });
    if (!enabled) toastr.info(t`Scratchpad will read up to 3 web pages linked in each message of this session.`);
    if (app.open) renderComposer();
}

async function toggleWebSearch() {
    if (!app.source || app.sending || pendingReply() || app.webSearchSaving) return;
    if (app.webSearchLoad) await app.webSearchLoad;
    else if (!app.webSearch?.config) await refreshWebSearchConfig({ quiet: true });
    const enabled = currentSettings().webSearch === true;
    if (!enabled && !app.webSearch?.readiness?.configured) {
        openWebSearchSettings(app.webSearch?.error
            ? t`Web search settings could not be loaded. Check them in Context.`
            : app.webSearch?.readiness?.missing === 'off' ? t`Choose a web search provider in Context first.` : t`Finish setting up web search in Context first.`);
        return;
    }
    await updateSettings({ webSearch: !enabled });
    if (app.open) renderComposer();
}

async function saveWebSearchSettings(values) {
    if (!app.webSearch) await refreshWebSearchConfig({ quiet: false });
    const draft = values ?? app.webSearchDraft ?? app.webSearch?.config;
    if (!app.webSearch?.config || !draft) {
        reportError(new Error(app.webSearch?.error || t`Web search settings could not be loaded.`), t`Web search settings could not be saved.`);
        return;
    }
    const expectedRevision = app.webSearch.config.revision ?? 0;
    app.webSearchCheck += 1;
    app.webSearchSaving = true;
    app.webSearchDraft = {
        provider: draft.provider,
        searxngUrl: draft.searxngUrl ?? '',
        customUrl: draft.customUrl ?? '',
        customHeader: draft.customHeader ?? '',
        results: draft.results,
    };
    const submittedDraft = { ...app.webSearchDraft };
    const owner = getCurrentUserHandle();
    if (app.tab === 'context') renderContext({ force: true });
    try {
        const result = await api.updateWebSearch(submittedDraft, expectedRevision);
        if (owner !== getCurrentUserHandle()) throw new Error(t`The signed-in account changed. Reload the page before saving web search settings.`);
        app.webSearch = { config: result.webSearch, readiness: result.readiness };
        if (JSON.stringify(app.webSearchDraft) === JSON.stringify(submittedDraft)) app.webSearchDraft = null;
        app.webSearchSaving = false;
        if (app.tab === 'context') renderContext({ force: true });
        renderComposer();
        toastr.success(t`Web search settings saved.`);
    } catch (error) {
        app.webSearchSaving = false;
        if (owner !== getCurrentUserHandle()) return;
        if (error?.code === 'SCRATCHPAD_WEB_SEARCH_CHANGED') await refreshWebSearchConfig({ quiet: true });
        if (app.webSearch) app.webSearch = { ...app.webSearch, error: error?.message || t`Web search settings could not be saved.` };
        reportError(error, t`Web search settings could not be saved.`);
        if (app.tab === 'context') renderContext({ force: true });
    }
}

/** Blank or non-finite fields keep their saved value; the server's clamp is shown after saving. */
async function saveNumberSetting(input, key) {
    const settings = currentSettings();
    const limits = app.bucket?.limits ?? { depth: 200, maxTokens: 32000 };
    const previous = settings[key];
    const value = integerSettingValue(input.value, key === 'depth'
        ? { min: 0, max: Number(limits.depth) || 200 }
        : { min: 64, max: Number(limits.maxTokens) || 32000 });
    if (value === null) {
        reflectSavedValue(input, previous);
        return;
    }
    const submitted = input.value;
    const sessionId = activeSession()?.id;
    const result = await updateSettings({ [key]: value });
    const saved = reflectedSettingValue(currentSettings()[key], previous, {
        sessionId, activeSessionId: activeSession()?.id, succeeded: Boolean(result),
    });
    if (input.value === submitted) reflectSavedValue(input, saved);
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

function typedToolProblem(error) {
    const line = error.line.trim();
    switch (error.code) {
        case 'roll': return t`'${line}' is not a dice roll. Try /roll 2d6+1.`;
        case 'roll-limit': return t`'${line}' asks for too much. Roll up to ${MAX_ROLL_DICE} dice with 2 to ${MAX_ROLL_SIDES} sides.`;
        case 'calc-result': return t`'${line}' has no usable answer, such as a division by zero.`;
        case 'pick': return t`'${line}' needs at least two choices. Try /pick tea | coffee | cocoa.`;
        default: return t`'${line}' is not a sum Scratchpad can work out. Use numbers with + - * / % ^ and brackets.`;
    }
}

/** A notice section: a heading, then one line each for the commands it covers. */
function noticeSection(title, lines) {
    return h('div', { class: 'scratchpad-notice' }, h('strong', { text: title }), h('ul', {}, lines.map(line => h('li', {}, ...line))));
}

/** The /tools notice: the tools that work out a value, then the shortcuts that run a check, each under its own heading. */
function showToolsHelp() {
    const body = h('div', {},
        h('strong', { text: t`Tools that work out a value` }),
        h('p', { text: t`Start a line with /roll 2d6+1, /calc 12*(3+4), /pick tea | coffee | cocoa or /now. Scratchpad swaps the line for its result before sending.` }),
        h('strong', { text: t`Shortcuts that run a check` }),
        h('p', { text: t`Start a line with /check card, /check preset, /check lorebook, /check app, /check source, /check prompt, or /why and the name or key of an entry. Scratchpad turns on the sharing that check needs and sends it. Send /check on its own to see which are ready now.` }));
    toastr.info(body, t`Typed tools`, { timeOut: 12000, escapeHtml: false });
    app.el.composer.focus();
}

/** The notice for a bare /check: what can be checked right now, then what cannot and why. */
function showCheckList() {
    const checks = checkAvailability();
    const ready = checks.filter(item => !item.problem);
    const sections = [];
    if (ready.length) sections.push(noticeSection(t`Ready to check`, ready.map(item => [h('code', { text: item.command }), ` - ${item.label}`])));
    const blocked = new Map();
    for (const item of checks.filter(check => check.problem)) blocked.set(item.problem, [...blocked.get(item.problem) ?? [], item.command]);
    if (blocked.size) sections.push(noticeSection(t`Not available right now`, [...blocked].map(([problem, commands]) => [h('code', { text: commands.join(', ') }), ` - ${problem}`])));
    toastr.info(h('div', {}, ...sections), t`Checks`, { timeOut: 15000, escapeHtml: false });
    app.el.composer.focus();
}

/**
 * Turns a /check or /why line into the request its quick prompt would have filled in, after switching on the same sharing.
 * Resolves to the message to send, or to null when nothing should be sent (the notice has been shown). `scan` is the text
 * the lorebook reading should use when it must not include an entry name typed after /why.
 */
async function resolveShortcut(typed, source, sessionId) {
    const { lines, shortcuts } = findShortcuts(typed);
    const stop = message => {
        toastr.warning(message, t`Nothing was sent`);
        app.el.composer.focus();
        return null;
    };
    if (shortcuts.length > 1) return stop(t`Use one /check or /why shortcut per message, because each one turns on its own sharing. Keep one and send again.`);
    const [{ index }] = shortcuts;
    const shortcut = parseShortcut(shortcuts[0]);
    const word = shortcut.word;
    if (shortcut.kind === 'check' && !word) {
        if (lines.some((line, position) => position !== index && line.trim())) return stop(t`Say what to check after /check: card, preset, lorebook, app, source or prompt. Send /check on its own to see which are ready now.`);
        showCheckList();
        return null;
    }
    if (shortcut.kind === 'check' && !shortcut.target) return stop(t`Scratchpad can't check '${word}'. Use /check card, /check preset, /check lorebook, /check app, /check source or /check prompt, or send /check on its own to see which are ready now.`);
    const prompt = checkAvailability().find(item => item.key === (shortcut.kind === 'why' ? 'why' : shortcut.target));
    if (!prompt) return stop(t`Scratchpad can't run that check here.`);
    if (prompt.problem) return stop(prompt.problem);
    const name = shortcut.kind === 'why' ? shortcut.name : '';
    const request = name ? t`Check the activation trace and explain why the lorebook entry '${name}' (its title or one of its keys) did not trigger, and offer a fix if needed.` : prompt.text;
    app.sending = true;
    renderComposer();
    try {
        const saved = await applyCheckSwitches(prompt);
        requireScope(source, sessionId);
        if (!saved) return stop(t`Scratchpad could not turn on the sharing this check needs, so nothing was sent.`);
    } catch (error) {
        reportError(error, t`Scratchpad could not send that.`);
        return null;
    } finally {
        app.sending = false;
        renderComposer();
    }
    return {
        text: replaceShortcut(lines, index, request, shortcut.rest),
        scan: name && source.kind === 'general' ? replaceShortcut(lines, index, prompt.text) : undefined,
    };
}

// A queued follow-up that cannot go out goes back to the front of its queue, paused, so its words are never lost.
async function send(options = {}) {
    const { queuedItem = null, queuedKey = '' } = options;
    if (!queuedItem) return sendMessage(options);
    const owner = getCurrentUserHandle();
    let sent = false;
    try {
        sent = await sendMessage(options);
    } finally {
        if (!sent && owner === getCurrentUserHandle()) {
            restoreFollowUp(app.followUps, queuedKey, queuedItem);
            holdFollowUps(app.followUps, queuedKey, isCurrentSource(queuedItem.source) ? 'failed' : 'context');
            renderFollowUps();
        }
    }
    return sent;
}

async function sendMessage({ regenerate = '', discuss = false, rehearsal = false, followUp = '', rehearsalChange = null, queuedItem = null } = {}) {
    if (app.sending || app.swiping || (!queuedItem && app.readingFiles.has(app.attachments))) return false;
    const source = app.source;
    if (!source) return false;
    if (rehearsal && !canRehearse(source)) return false;
    if (rehearsalChange && (!rehearsal || !canTryProposalInRehearsal(rehearsalChange.change, source))) return false;
    if (!isCurrentSource(source) || (queuedItem && !isCurrentSource(queuedItem.source))) {
        toastr.warning(t`The Scratchpad context changed. Return to it before sending.`);
        return false;
    }
    const draft = app.el.composer.value;
    const initialSessionId = activeSession()?.id;
    // A discussion round sends its own request; anything typed in the box rides along as the point to focus on.
    const request = t`Read each other's answers to my last message. Say where you agree, where you disagree and why, and what you would now change in your own answer.`;
    // A share card sends its own fixed message and leaves the draft and attachments where they are.
    let typed = followUp || (queuedItem ? queuedItem.text : draft.trim());
    let scan;
    if (!regenerate && !discuss && !followUp) {
        try {
            const expanded = expandTypedTools(typed, { labels: typedToolLabels() });
            if (expanded.help) {
                showToolsHelp();
                return false;
            }
            typed = expanded.text;
        } catch (error) {
            if (!(error instanceof TypedToolError)) throw error;
            toastr.warning(typedToolProblem(error), t`Nothing was sent`);
            app.el.composer.focus();
            return false;
        }
        if (findShortcuts(typed).shortcuts.length) {
            const resolved = await resolveShortcut(typed, source, initialSessionId);
            if (!resolved) return false;
            typed = resolved.text;
            scan = resolved.scan;
        }
    }
    const text = regenerate ? '' : discuss ? [request, typed].filter(Boolean).join('\n\n') : typed;
    const attachedDraft = app.attachments;
    const attachments = regenerate || discuss || followUp ? [] : [...(queuedItem ? queuedItem.attachments : attachedDraft)];
    const empty = !regenerate && !rehearsal && !text && !attachments.length;
    const replyTo = empty ? activeSession()?.messages.at(-1) : null;
    if (empty && replyTo?.role !== 'user') {
        app.el.composer.focus();
        return false;
    }
    app.sending = true;
    renderComposer();
    try {
        await app.queue;
        requireScope(source, initialSessionId);
        const session = await ensureSession(source);
        if (!session) return false;
        if (replyTo && session.messages.at(-1)?.id !== replyTo.id) throw new Error(t`The Scratchpad settings or messages changed. Try sending again.`);
        const draftKey = app.draftKey;
        const snapshot = JSON.stringify(session);
        const settings = session.settings;
        const chatProfileId = sourceConnectionProfile(source);
        const retried = regenerate ? session.messages.find(message => message.id === regenerate) : null;
        // Trying again, or answering, a rehearsal of an unsaved change needs that change again; it lives only in this tab.
        const earlier = retried || replyTo;
        const trialFrom = earlier?.rehearsalLabel ? (earlier.role === 'user' ? earlier : session.messages.slice(0, session.messages.indexOf(earlier)).findLast(item => item.role === 'user')) : null;
        const trial = rehearsalChange || (trialFrom ? trialChanges.get(`${session.id}:${trialFrom.id}`) : null) || null;
        if (earlier?.rehearsalLabel && !trial) throw new Error(t`That unsaved change is no longer here. Press Try first on its change card again.`);
        if (replyTo && (source.scope || source.kind === 'general') && !sameChat(replyTo.contextSource, source)) {
            throw new Error(source.kind === 'general' ? t`Return to the original Scratchpad context before answering this message.` : t`Open the original chat before answering this message.`);
        }
        if (retried && (source.scope || source.kind === 'general') && !sameChat(retried.contextSource, source)) {
            throw new Error(source.kind === 'general' ? t`Return to the original Scratchpad context before trying this reply again.` : t`Open the original chat before trying this reply again.`);
        }
        const assistants = retried ? [retried.assistant || session.assistant] : sessionAssistants(session);
        const genders = Object.fromEntries(ASSISTANTS.map(item => [item.id, getAssistantGender(item.id)]));
        const query = regenerate ? (session.messages.slice(0, session.messages.indexOf(retried)).findLast(item => item.role === 'user')?.text ?? '') : replyTo?.text ?? scan ?? text;
        const context = await buildContext({ source, settings, pendingText: query, sessionText: sessionText(session), ...(trial ? { rehearsalChange: trial } : {}) });
        await refreshImageAvailability();
        const help = [...new Set(await Promise.all(assistants.map(assistant => buildHelp({ assistant, gender: genders[assistant], text: query }))))].filter(Boolean).join('\n\n');
        requireScope(source, session.id);
        const compareConnection = activeCompareConnection(settings, { regenerate: Boolean(regenerate), discuss: Boolean(discuss), rehearsal: Boolean(rehearsal || replyTo?.rehearsal) });
        if (compareConnection && sameCompareTarget(assistantConnection(settings, session.assistant), compareConnection, chatProfileId)) {
            throw new Error(t`Choose two different connections to compare.`);
        }
        const connections = retried
            ? [retried.connection ?? assistantConnection(settings, retried.assistant || session.assistant)]
            : [...assistants.map(assistant => assistantConnection(settings, assistant)), ...(compareConnection ? [compareConnection] : [])];
        const connectionsSaved = !(chatProfileId || connections.every(connection => connection.kind === 'profile'));
        const acknowledgement = connectionsSaved ? await acknowledge() : undefined;
        const personaSaved = rehearsal || retried?.rehearsal || replyTo?.rehearsal || !context.capabilities.persona || !needsSavedPersonaSelection(source, connectionsSaved) || await saveSelectedPersona();
        if (!personaSaved) toastr.warning(t`Scratchpad could not save your persona, so Scenario Note suggestions for it are left out of this reply.`);
        const capabilities = personaSaved ? context.capabilities : Object.fromEntries(Object.entries(context.capabilities).filter(([key]) => key !== 'persona'));
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
            replyTo: replyTo?.id,
            discuss: discuss || undefined,
            rehearsal: rehearsal || undefined,
            rehearsalLabel: rehearsal && rehearsalChange ? normaliseRehearsalLabel(rehearsalChange.label) || undefined : undefined,
            text,
            attachments,
            context: context.text,
            help,
            capabilities: { ...capabilities, image: app.imageAvailability.image },
            targets: context.targets,
            names: context.names,
            chatProfileId,
            genders,
            acknowledgement,
        });
        if (!regenerate && !followUp && !queuedItem) {
            attachedDraft.splice(0, attachments.length);
            if ((app.draftKey === draftKey || (sameSourceBucket(source, app.source) && activeSession()?.id === session.id)) && app.el.composer.value === draft) app.el.composer.value = '';
            else if (app.drafts.get(draftKey) === draft) app.drafts.set(draftKey, '');
        }
        if (rehearsalChange && !regenerate) {
            const sent = result.bucket?.sessions?.find(item => item.id === session.id)?.messages.findLast(item => item.role === 'user' && item.rehearsalLabel);
            if (sent) trialChanges.set(`${session.id}:${sent.id}`, rehearsalChange);
        }
        if (sameSourceBucket(source, app.source) && activeSession()?.id === session.id) {
            app.ticket += 1;
            applyBucket(result.bucket);
            scrollMessages(true);
        }
        return true;
    } catch (error) {
        reportError(error, t`Scratchpad could not send that.`);
        return false;
    } finally {
        app.sending = false;
        renderComposer();
    }
}

async function stopReply() {
    const pending = pendingReply();
    if (!pending?.jobId) return;
    const sessionId = activeSession()?.id;
    if (sessionId) app.followUpStops.add(sessionId);
    try {
        if (!await api.cancelReply(pending.jobId)) throw new Error(t`Scratchpad could not stop the reply. Try again.`);
    } catch (error) {
        reportError(error, t`Scratchpad could not stop the reply.`);
    }
    setTimeout(() => app.open && reload(), 600);
}

function onSendButton() {
    if (!pendingReply()) void send();
    else if (!queueFollowUp()) void stopReply();
}

function closeComposeMenu() {
    if (!app.el.composeMenu) return;
    app.el.composeMenu.hidden = true;
    app.el.plus.setAttribute('aria-expanded', 'false');
}

async function addAttachments(files) {
    if (!files.length || app.sending || app.readingFiles.has(app.attachments)) return;
    const draft = app.attachments;
    const account = getCurrentUserHandle();
    if (draft.length + files.length > MAX_ATTACHMENTS) {
        toastr.warning(t`Attach up to eight files per message.`);
        return;
    }
    app.readingFiles.add(draft);
    renderComposer();
    try {
        for (const file of files) {
            try {
                const attachment = await prepareAttachment(file);
                if (getCurrentUserHandle() !== account) return;
                normaliseAttachments([...draft, attachment]);
                draft.push(attachment);
            } catch (error) {
                reportError(error, t`Scratchpad could not attach that file.`);
            }
        }
    } finally {
        app.readingFiles.delete(draft);
        renderComposer();
    }
}

function renderAttachments(files, { draft = false } = {}) {
    return files.map((file, index) => {
        const image = file.kind === 'image';
        const label = h('span', { class: 'scratchpad-file-label' },
            h('span', { text: file.name, 'data-i18n-ignore': '' }),
            h('small', { text: `${formatBytes(file.size)} · ${image ? t`Image` : file.mimeType === 'application/pdf' ? t`PDF text` : t`Text`}` }));
        const icon = image ? h('img', { class: 'scratchpad-file-thumb', src: file.dataUrl, alt: '' }) : h('i', { class: 'fa-solid fa-file-lines', 'aria-hidden': 'true' });
        if (draft) return h('div', { class: 'scratchpad-file', role: 'listitem' }, icon, label,
            iconButton('', () => { files.splice(index, 1); renderComposer(); }, {
                icon: 'fa-xmark', title: t`Remove ${file.name}`, disabled: app.sending || app.readingFiles.has(files), className: 'scratchpad-file-remove',
            }));
        return h('details', { class: 'scratchpad-file-preview' },
            h('summary', { class: 'scratchpad-file' }, icon, label),
            image ? h('img', { class: 'scratchpad-attached-image', src: file.dataUrl, alt: file.name, loading: 'lazy' })
                : h('pre', { class: 'scratchpad-attached-text', text: file.text, 'data-i18n-ignore': '' }));
    });
}

function onComposerKey(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || isPhone()) return;
    event.preventDefault();
    if (pendingReply()) queueFollowUp();
    else void send();
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
    renderSendButton();
    app.el.composer.focus();
}

/** The user's own prompts come first, then the built-in ones for this kind of Scratchpad. The editor button stays pinned beside the row. */
function quickPromptChips() {
    const chip = prompt => iconButton(prompt.label, () => void takePrompt(prompt), { className: 'scratchpad-chip' });
    const saved = app.quickPrompts.prompts.map(prompt => {
        const element = chip(prompt);
        element.classList.add('scratchpad-chip-saved');
        element.setAttribute('data-i18n-ignore', '');
        return element;
    });
    return [...saved, ...quickPrompts().map(chip)];
}

function quickBarKey(session = activeSession()) {
    return session ? followUpKey(app.source, session.id) : '';
}

/** Shows the quick prompts row in an empty session and folds it to one toggle once the session has messages. */
function renderQuickBar(session = activeSession()) {
    const el = app.el;
    const expanded = quickBarExpanded(app.quickBar, quickBarKey(session), session?.messages.length ?? 0);
    if (el.quickBar.dataset.expanded === String(expanded)) return;
    el.quickBar.dataset.expanded = String(expanded);
    el.quickToggle.setAttribute('aria-expanded', String(expanded));
    el.quickToggle.title = expanded ? t`Hide quick prompts` : t`Show quick prompts`;
    el.quick.parentElement.hidden = !expanded;
}

function onQuickToggle() {
    const stick = nearBottom(app.el.messages);
    const session = activeSession();
    toggleQuickBar(app.quickBar, quickBarKey(session), session?.messages.length ?? 0);
    renderQuickBar(session);
    if (stick) scrollMessages(true);
}

/** Lets a vertical mouse wheel glide the quick prompts row sideways on desktop. */
function onQuickWheel(event) {
    const rail = app.el.quick;
    const delta = wheelScrollDelta(event, rail);
    if (!delta) return;
    event.preventDefault();
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('reduced-motion');
    // Trackpads send many small steps that already feel smooth; a mouse wheel's large notches glide.
    const smooth = !still && (event.deltaMode !== 0 || Math.abs(delta) >= 40);
    const now = Date.now();
    const current = rail.scrollLeft;
    const prev = app.quickWheel;
    const gliding = smooth && prev !== null
        && now - prev.at < 500
        && Math.abs(prev.target - current) > 1
        && Math.sign(delta) === Math.sign(prev.target - prev.from)
        && current >= Math.min(prev.from, prev.target) - 2
        && current <= Math.max(prev.from, prev.target) + 2;
    const room = rail.scrollWidth - rail.clientWidth;
    const target = Math.max(0, Math.min(room, (gliding ? prev.target : current) + delta));
    app.quickWheel = smooth ? { from: current, target, at: now } : null;
    rail.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'instant' });
}

/** Switches on the sharing a check prompt needs for this session and says what changed. Resolves to null when that could not be saved. */
async function applyCheckSwitches(prompt) {
    const before = currentSettings().include || {};
    const changed = [];
    const evidence = prompt.include.appEvidence === true;
    const lastPrompt = prompt.include.lastPrompt === true;
    if (evidence) {
        if (!before.appEvidence) changed.push(t`App diagnostics`);
        if (prompt.include.appSource === true && !before.appSource) changed.push(t`Neconyan source code`);
    } else if (lastPrompt) {
        if (!before.lastPrompt) changed.push(t`Last prompt sent`);
    } else if (!before.problems) {
        changed.push(t`Problem checks`);
    }
    const labels = { card: t`Character cards`, preset: t`Current preset`, lore: t`Lorebook entries` };
    for (const [key, label] of Object.entries(labels)) {
        if (prompt.include[key] && !before[key]) changed.push(label);
    }
    const saved = await updateSettings(settings => ({ include: { ...settings.include, ...(evidence || lastPrompt ? {} : { problems: true }), ...prompt.include } }), { rerenderContext: app.tab === 'context' });
    if (saved && changed.length) toastr.info(t`Turned on ${changed.join(' and ')} for this session.`, t`Scratchpad`);
    return saved;
}

/** Fills the composer, after switching on the sharing a check prompt needs for this session. */
async function takePrompt(prompt) {
    if (prompt.include) await applyCheckSwitches(prompt);
    usePrompt(prompt.text);
}

async function openQuickPromptEditor() {
    const owner = getCurrentUserHandle();
    try {
        const saved = await editQuickPrompts();
        if (!saved || owner !== getCurrentUserHandle()) return;
        app.quickPrompts = saved;
        render();
    } catch (error) {
        reportError(error, t`Your quick prompts could not be loaded.`);
    }
}

/* Rendering */

function render() {
    if (!app.built) return;
    renderHeader();
    renderChat();
    if (app.tab === 'context' && contextKey() !== app.contextKey) renderContext({ force: true });
    else if (app.tab === 'context') refreshContextLive();
    if (app.tab === 'sessions') renderSessions();
}

function renderHeader() {
    const sourceKind = app.source?.kind || '';
    const savedPrompts = `${getCurrentUserHandle()}:${app.quickPrompts.revision}`;
    const settings = currentSettings();
    const include = settings.include || {};
    const quickState = JSON.stringify([include.problems, include.card, include.preset, include.lore, generalLorebooks(app.source, settings), app.source?.avatar]);
    if (app.el.quick.dataset.sourceKind !== sourceKind || app.el.quick.dataset.imagesAvailable !== String(app.imageAvailability.image)
        || app.el.quick.dataset.savedPrompts !== savedPrompts || app.el.quick.dataset.quickState !== quickState) {
        app.el.quick.dataset.sourceKind = sourceKind;
        app.el.quick.dataset.imagesAvailable = String(app.imageAvailability.image);
        app.el.quick.dataset.savedPrompts = savedPrompts;
        app.el.quick.dataset.quickState = quickState;
        // A chip that switches sharing on redraws the row; keep it where the user scrolled it.
        const scrolled = app.el.quick.scrollLeft;
        app.el.quick.replaceChildren(...quickPromptChips());
        app.el.quick.scrollLeft = scrolled;
    }
    const session = activeSession();
    const assistant = session?.assistant ?? app.assistant;
    app.el.portrait.src = assistantPortrait(assistant);
    app.el.sourceLabel.textContent = app.source ? app.source.label : t`No chat open`;
    app.el.newSession.disabled = !app.source;
    app.el.close.querySelector('span').textContent = app.source?.kind === 'notebook' ? t`Back to note` : app.source?.kind === 'general' ? t`Close` : t`Back to chat`;
    const participants = sessionAssistants(session);
    const roundTable = session?.settings.roundTable === true;
    app.el.roundTable.setAttribute('aria-pressed', String(roundTable));
    app.el.roundTable.classList.toggle('menu_button_primary', roundTable);
    app.el.roundTable.disabled = !app.source || app.sending || Boolean(pendingReply());
    app.el.randomReply.hidden = !roundTable;
    app.el.randomReply.setAttribute('aria-pressed', String(Boolean(randomReplyEnabled())));
    app.el.randomReply.classList.toggle('menu_button_primary', Boolean(randomReplyEnabled()));
    app.el.randomReply.disabled = app.el.roundTable.disabled;
    renderFeedbackTone(session);
    clear(app.el.assistantPicker);
    const choices = allAssistants().filter(item => ASSISTANTS.includes(item) || participants.includes(item.id));
    app.el.assistantPicker.classList.toggle('has-custom', choices.some(item => !ASSISTANTS.includes(item)));
    for (const item of choices) {
        const selected = participants.includes(item.id);
        const choice = h('button', {
            type: 'button',
            class: `scratchpad-assistant${selected ? ' is-selected' : ''}${ASSISTANTS.includes(item) ? ' is-included' : ''}`,
            'aria-label': item.name,
            'aria-pressed': String(selected),
            title: assistantRole(item.id),
            disabled: !canChooseAssistant(item.id),
            onclick: () => chooseAssistant(item.id),
        }, h('img', { src: assistantPortrait(item.id), alt: '', width: 32, height: 32 }), h('span', { text: item.name, 'data-i18n-ignore': '' }));
        app.el.assistantPicker.append(choice);
    }
    renderOverview();
}

async function chooseAssistant(id) {
    if (!canChooseAssistant(id)) return;
    if (activeSession()?.settings.roundTable) {
        await updateSettings(settings => ({ participants: settings.participants.includes(id)
            ? settings.participants.filter(item => item !== id) : [...settings.participants, id] }));
        return;
    }
    app.assistant = id;
    writePrefs();
    const session = activeSession();
    if (!session) {
        render();
        return;
    }
    await change(source => api.updateSession(source, session.id, { assistant: id, gender: getAssistantGender(id) }), t`Scratchpad could not switch assistants.`);
}

function contextSummary(settings) {
    const notes = settings.notes?.length || 0;
    if (app.source?.kind === 'general') return notes ? t`No chat messages shared; ${notes} saved notes or sections shared` : t`No chat messages shared`;
    if (notes) return t`${notes} saved notes or sections shared`;
    if (settings.picked?.length) return picksMatchSource(settings, app.source)
        ? t`Reading ${settings.picked.length} picked messages` : t`Not reading any chat messages`;
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
        ...sessionAssistants(session).map(id => h('img', { src: assistantPortrait(id), alt: assistantInfo(id).name, width: 24, height: 24 })),
        h('span', { class: 'scratchpad-overview-name', text: name, ...(app.source && session?.name ? { 'data-i18n-ignore': '' } : {}) }),
        randomReplyEnabled() ? h('span', { class: 'scratchpad-badge', text: t`Random` }) : null,
        app.source ? compareBadge(session) : null,
        sharedFeedbackTone() === DEFAULT_FEEDBACK_TONE ? null : h('span', { class: 'scratchpad-badge scratchpad-tone-badge', text: feedbackToneLabel(sharedFeedbackTone()) }),
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
    if (el.pinnedNote) {
        el.pinnedNote.disabled = !app.source;
        el.pinnedNote.querySelector('span').textContent = session?.pinnedNote?.trim() ? t`Pinned note (saved)` : t`Pinned note`;
    }
    clear(el.summary);
    if (app.source) {
        const settings = currentSettings();
        const assistant = assistantInfo(session?.assistant ?? app.assistant);
        append(el.summary, [
            h('span', { text: session ? session.name : t`New session with ${assistant.name}`, ...(session?.name ? { 'data-i18n-ignore': '' } : {}) }),
            settings.roundTable ? h('span', { class: 'scratchpad-badge', text: t`Round table: ${sessionAssistants(session).length}` }) : null,
            compareBadge(session, settings),
            randomReplyEnabled() ? h('span', { class: 'scratchpad-summary-context', text: t`One random assistant replies per message` }) : null,
            session?.temporary ? h('span', { class: 'scratchpad-badge', text: t`Temporary` }) : null,
            h('span', { class: 'scratchpad-summary-context', text: contextSummary(settings) }),
            iconButton(translate('Change', 'scoped.action.change'), () => {
                app.contextSubTab = 'sharing';
                writePrefs();
                selectTab('context');
            }, { className: 'scratchpad-link' }),
            historyCount() ? iconButton(t`History`, () => void openChangeHistory(), { icon: 'fa-clock-rotate-left', className: 'scratchpad-link scratchpad-history-button', title: t`Change history (${historyCount()})` }) : null,
        ]);
    }
    renderOverview();
    renderQuickBar(session);
    renderMessages();
    renderComposer();
}

let pinnedNoteEditorOpen = false;

async function editPinnedNote() {
    if (pinnedNoteEditorOpen || !app.source) return;
    pinnedNoteEditorOpen = true;
    const source = app.source;
    const owner = getCurrentUserHandle();
    try {
        await app.queue;
        requireScope(source);
        const session = await ensureSession(source);
        if (!session) return;
        const expectedPinnedNote = session.pinnedNote || '';
        const editor = h('textarea', { class: 'text_pole scratchpad-review-editor', rows: '10', value: expectedPinnedNote, 'aria-label': t`Pinned note text` });
        const errorText = h('p', { class: 'scratchpad-error', role: 'alert', hidden: true });
        const content = h('div', { class: 'scratchpad-review scratchpad-section' },
            h('h3', { text: t`Pinned note or story tracker` }),
            h('p', { text: t`Keep goals, scene details and loose ends here. Every reply in this session reads the saved note. Edit it yourself when something changes; an empty note removes it.` }),
            editor, h('small', { text: t`Up to ${formatBytes(MAX_PINNED_NOTE_BYTES)}. This session only; branches and exports keep a copy.` }), errorText);
        let saving = false;
        await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
            wide: true, okButton: t`Save note`, cancelButton: t`Cancel`,
            onClosing: async popup => {
                if (saving) return false;
                if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
                saving = true;
                errorText.hidden = true;
                try {
                    const note = editor.value;
                    const write = app.queue.then(async () => {
                        requireScope(source, session.id);
                        const result = await api.updateSession(wireSource(source), session.id, { pinnedNote: note, expectedPinnedNote });
                        if (app.open && owner === getCurrentUserHandle() && sameSourceContext(source, app.source) && isCurrentSource(source) && activeSession()?.id === session.id) {
                            app.ticket += 1;
                            applyBucket(result.bucket);
                        }
                    });
                    app.queue = write.catch(() => null);
                    await write;
                    return true;
                } catch (error) {
                    errorText.textContent = error?.message || t`The pinned note could not be saved. Your draft is still here.`;
                    errorText.hidden = false;
                    return false;
                } finally {
                    saving = false;
                }
            },
        });
    } catch (error) {
        reportError(error, t`The pinned note could not be opened.`);
    } finally {
        pinnedNoteEditorOpen = false;
        if (app.open) app.el.pinnedNote?.focus();
    }
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
    const scrollTop = list.scrollTop;
    const stick = nearBottom(list);
    const session = app.source ? activeSession() : null;
    if (session?.id && app.openMenusSessionId === session.id) {
        for (const menu of list.querySelectorAll?.('.scratchpad-message-menu') ?? []) {
            const id = menu.closest('[data-message-id]')?.dataset?.messageId;
            if (id) app.openMenus[menu.open ? 'add' : 'delete'](id);
        }
    } else {
        app.openMenus.clear();
        app.openMenusSessionId = session?.id ?? '';
    }
    clear(list);
    if (!app.source) {
        list.append(h('div', { class: 'scratchpad-empty' },
            h('p', { text: t`Open a Roleplay or Conversation chat, then come back here to talk with your chosen assistant.` })));
        return;
    }
    if (!session?.messages.length) {
        app.openMenus.clear();
        const participants = sessionAssistants(session).map(id => assistantInfo(id));
        const names = participants.map(assistant => assistant.name).join(', ');
        list.append(h('div', { class: 'scratchpad-empty' },
            h('div', { class: 'scratchpad-empty-portraits' }, participants.map(assistant =>
                h('img', { src: assistantPortrait(assistant.id), alt: assistant.name, width: 72, height: 72 }))),
            h('p', { text: t`Ask ${names} anything. Nothing you write here goes into the story.` }),
            h('p', { text: app.source?.kind === 'notebook'
                ? t`Suggested note changes appear as cards you can review before anything is saved.`
                : app.source?.kind === 'general' ? t`Discuss ideas or create a character. Suggested note and character changes need your review before saving.`
                    : t`Suggested changes to notes, lorebooks, characters or messages appear as cards you can review before anything is saved.` })));
        return;
    }
    const ids = new Set(session.messages.map(item => item.id));
    for (const id of app.openMenus) if (!ids.has(id)) app.openMenus.delete(id);
    const lastUserIndex = session.messages.findLastIndex(item => item.role === 'user');
    let answered = false;
    for (const [index, message] of session.messages.entries()) {
        answered ||= message.role === 'user';
        list.append(renderMessage(session, message, {
            latest: lastUserIndex >= 0 && index > lastUserIndex && message.role === 'assistant',
            retry: answered && message.role === 'assistant',
        }));
    }
    if (roundToDiscuss(session).length) {
        list.append(h('div', { class: 'scratchpad-round-actions' },
            iconButton(t`Discuss these answers`, () => void send({ discuss: true }), {
                icon: 'fa-comments', className: 'scratchpad-discuss', title: t`Each assistant reads the others' answers and replies again`,
                disabled: app.sending || app.swiping || Boolean(app.editing),
            })));
    }
    if (stick) scrollMessages(true);
    // Rebuilding the list can reset its scroll offset while it is empty.
    // Reviews and saved changes must also keep readers who are above the bottom in place.
    else list.scrollTop = scrollTop;
}

function stageLabel(preview) {
    if (preview?.stage === 'done') return t`Reply saved`;
    if (preview?.stage === 'failed') return preview.error || t`This reply did not finish.`;
    if (preview?.stage === 'searching') return t`Searching the web…`;
    if (preview?.stage === 'reading') return t`Reading the linked pages…`;
    if (preview?.stage === 'inspecting-source') return t`Checking Neconyan source code…`;
    if (preview?.stage === 'summarising') return t`Summarising earlier discussion…`;
    if (!preview || preview.stage === 'queued') return t`Waiting for the model...`;
    if (!preview.text && preview.reasoning) return t`Thinking...`;
    return t`Writing...`;
}

function announceReply(text) {
    const status = app.el.replyStatus;
    if (status && status.textContent !== text) status.textContent = text;
}

function announceReplyChange(before, session) {
    if (!session || session.id !== before?.id) {
        announceReply(pendingReply(session) ? stageLabel(null) : '');
        return;
    }
    const pending = new Set(before.messages.filter(message => message.state === 'pending').map(message => message.id));
    const finished = session.messages.filter(message => pending.has(message.id) && message.state !== 'pending');
    if (finished.length) {
        announceReply(finished.map(message => {
            const name = message.assistantName || assistantInfo(message.assistant ?? session.assistant).name;
            return message.state === 'failed' ? t`${name} could not finish the reply.` : t`${name} replied.`;
        }).join(' '));
    } else if (!pending.size && pendingReply(session)) announceReply(stageLabel(null));
}

function updateStream(jobId) {
    const nodes = app.el.messages?.querySelectorAll(`.scratchpad-message.is-pending[data-job-id="${CSS.escape(jobId)}"]`);
    if (!nodes?.length) return;
    const stick = nearBottom(app.el.messages);
    const stages = new Set();
    for (const node of nodes) {
        const preview = replyPreview({ jobId, id: node.dataset.messageId });
        updateMessageTokenCounts(node.querySelector('.scratchpad-author'), preview, { pending: true });
        const label = stageLabel(preview);
        node.querySelector('.scratchpad-stage').textContent = label;
        if (preview?.stage !== 'done' && preview?.stage !== 'failed') stages.add(label);
        node.querySelector('.scratchpad-stream').textContent = preview?.text ?? '';
        const reasoning = node.querySelector('.scratchpad-reasoning');
        reasoning.hidden = !preview?.reasoning;
        reasoning.querySelector('.scratchpad-plain').textContent = preview?.reasoning ?? '';
    }
    if (stages.size) announceReply([...stages].join(' '));
    if (stick) scrollMessages(true);
}

function replyPreview(message) {
    const preview = app.previews.get(message.jobId);
    return preview?.replies ? preview.replies[message.id] : preview;
}

function renderMessage(session, message, { latest, retry }) {
    const assistant = message.role === 'assistant' ? assistantInfo(message.assistant ?? session.assistant) : null;
    const article = h('article', {
        class: `scratchpad-message is-${message.role}${message.state ? ` is-${message.state}` : ''}`,
        dataset: { messageId: message.id, ...(message.jobId ? { jobId: message.jobId } : {}) },
    });
    const userName = assistant ? '' : sourceUserName(app.source);
    const author = assistant
        ? h('div', { class: 'scratchpad-author' }, h('img', { src: assistantPortrait(assistant.id), alt: '', width: 24, height: 24 }), h('span', { text: message.assistantName || assistant.name, 'data-i18n-ignore': '' }))
        : h('div', { class: 'scratchpad-author' }, h('span', userName ? { text: userName, 'data-i18n-ignore': '' } : { text: t`You` }));
    article.append(author);
    if (assistant && message.compareGroup && message.connectionLabel) {
        author.append(h('span', { class: 'scratchpad-badge scratchpad-connection-badge', text: message.connectionLabel, title: message.connectionLabel, 'data-i18n-ignore': '' }));
    }
    if (message.rehearsal) {
        const trial = message.rehearsalLabel ? String(message.rehearsalLabel) : '';
        author.append(h('span', { class: `scratchpad-badge${trial ? ' scratchpad-trial-badge' : ''}`, text: trial ? t`Rehearsal · Unsaved change` : t`Rehearsal` }));
        if (trial && assistant) {
            article.append(h('p', { class: 'scratchpad-trial-note' },
                h('i', { class: 'fa-solid fa-flask', 'aria-hidden': 'true' }),
                h('span', { text: t`Tried without saving:` }),
                ' ',
                h('span', { class: 'scratchpad-trial-label', text: trial, 'data-i18n-ignore': '' })));
        }
    }
    if (assistant) updateMessageTokenCounts(author, message.state === 'pending' ? replyPreview(message) : message, { pending: message.state === 'pending' });

    if (app.editing === message.id) {
        article.append(renderEditor(session, message));
        return article;
    }

    if (message.role === 'user') {
        article.append(h('p', { class: 'scratchpad-plain', text: message.text, 'data-i18n-ignore': '' }));
        append(article, renderAttachments(message.attachments ?? []));
    } else if (message.state === 'pending') {
        const preview = replyPreview(message);
        const thinking = {
            class: 'scratchpad-reasoning', hidden: !preview?.reasoning, open: !app.foldedThinking.has(message.id),
            ontoggle: event => app.foldedThinking[event.currentTarget.open ? 'delete' : 'add'](message.id),
        };
        article.append(
            h('p', { class: 'scratchpad-stage', text: stageLabel(preview) }),
            h('details', thinking,
                h('summary', { text: t`Thinking` }),
                h('p', { class: 'scratchpad-plain', text: preview?.reasoning ?? '', 'data-i18n-ignore': '' })),
            h('p', { class: 'scratchpad-plain scratchpad-stream', text: preview?.text ?? '', 'data-i18n-ignore': '' }),
            iconButton((session.settings.roundTable && !randomReplyEnabled()) || comparingPending(session.messages) ? t`Stop all` : t`Stop`, () => void stopReply(), { icon: 'fa-stop', className: 'scratchpad-stop' }));
        append(article, [renderReplySwipes(session, message, { latest })]);
        return article;
    } else {
        if (message.reasoning) {
            article.append(h('details', { class: 'scratchpad-reasoning' },
                h('summary', { text: t`Thinking` }),
                h('p', { class: 'scratchpad-plain', text: message.reasoning, 'data-i18n-ignore': '' })));
        }
        if (message.text) article.append(renderReply(session, message));
        const sources = message.role === 'assistant' ? renderWebSearchSources(message) : null;
        if (sources) article.append(sources);
        const pages = message.role === 'assistant' ? renderWebPages(message) : null;
        if (pages) article.append(pages);
        const sourceFiles = message.role === 'assistant' ? renderSourceLookup(message) : null;
        if (sourceFiles) article.append(sourceFiles);
        if (message.state === 'failed') {
            article.append(h('p', { class: 'scratchpad-error', text: message.error || t`This reply did not finish.` }));
        }
    }
    const actions = renderMessageActions(session, message, { retry });
    const menu = h('details', {
        class: 'scratchpad-message-menu',
        open: app.openMenus.has(message.id),
        ontoggle: event => {
            if (!event.currentTarget.isConnected || activeSession()?.id !== session.id) return;
            app.openMenus[event.currentTarget.open ? 'add' : 'delete'](message.id);
        },
    },
    h('summary', { 'aria-label': t`Message actions`, title: t`Message actions` },
        h('i', { class: 'fa-solid fa-ellipsis', 'aria-hidden': 'true' })), actions);
    menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            closeMessageMenu(menu, true);
            event.stopPropagation();
        }
    });
    actions.addEventListener('click', event => {
        if (event.target.closest('button:not(:disabled)')) {
            closeMessageMenu(menu, menu.contains(document.activeElement));
        }
    });
    author.append(menu);
    if (assistant) {
        append(article, [renderReplySwipes(session, message, { latest })]);
        installReplySwipeGesture(article, direction => void moveReplySwipe(session, message, direction, { latest }));
    }
    return article;
}

function closeMessageMenu(menu, restoreFocus) {
    app.openMenus.delete(menu.closest('[data-message-id]')?.dataset.messageId);
    menu.open = false;
    if (restoreFocus) menu.querySelector('summary').focus({ preventScroll: true });
}

function canGenerateSwipe(message, count, latest) {
    return latest && count < MAX_REPLY_SWIPES
        && (!(app.source?.scope || app.source?.kind === 'general') || sameSourceContext(app.source, message.contextSource));
}

function renderReplySwipes(session, message, { latest }) {
    const count = replySwipes(message).length;
    if (count === 1 && !latest) return null;
    const index = message.swipeIndex ?? 0;
    const canGenerate = canGenerateSwipe(message, count, latest);
    const controls = h('div', { class: 'scratchpad-reply-swipes', role: 'group', 'aria-label': t`Reply versions` });
    for (const direction of [-1, 1]) {
        if (direction === 1) controls.append(h('span', { class: 'scratchpad-swipe-count', text: t`${index + 1} of ${count}` }));
        const unavailable = Object.values(message.images ?? {}).some(image => image.state === 'pending')
            || (direction < 0 ? index === 0 : index === count - 1 && !canGenerate);
        const button = iconButton('', () => void moveReplySwipe(session, message, direction, { latest }), {
            icon: direction < 0 ? 'fa-chevron-left' : 'fa-chevron-right',
            title: direction < 0 ? t`Previous reply` : index < count - 1 ? t`Next reply` : t`Generate another reply`,
            disabled: unavailable || Boolean(pendingReply(session)) || app.sending || app.swiping || Boolean(app.editing),
        });
        button.dataset.unavailable = String(unavailable);
        controls.append(button);
    }
    return controls;
}

async function moveReplySwipe(session, message, direction, { latest }) {
    if (app.sending || app.swiping || app.editing || pendingReply() || Object.values(message.images ?? {}).some(image => image.state === 'pending')
        || activeSession()?.id !== session.id || !activeSession().messages.some(item => item.id === message.id)) return;
    const index = (message.swipeIndex ?? 0) + direction;
    const count = replySwipes(message).length;
    if (index < 0) return;
    if (index >= count) {
        if (canGenerateSwipe(message, count, latest)) await send({ regenerate: message.id });
        return;
    }
    const focus = document.activeElement?.closest('.scratchpad-reply-swipes');
    app.swiping = true;
    renderComposer();
    try {
        await change(source => api.swipeMessage(source, session.id, message.id, index), t`Scratchpad could not switch reply versions.`);
    } finally {
        app.swiping = false;
        renderComposer();
        if (focus) app.el.messages.querySelector(`[data-message-id="${replySwipes(message)[index].id}"] .scratchpad-reply-swipes button:not(:disabled)`)?.focus();
    }
}

function installReplySwipeGesture(article, move) {
    let start = null;
    article.addEventListener('touchstart', event => {
        const excluded = event.target.closest('button, a, input, textarea, select, summary, pre, code, .scratchpad-change, .scratchpad-html-preview');
        const touch = event.touches.length === 1 && !excluded ? event.touches[0] : null;
        start = touch ? { x: touch.clientX, y: touch.clientY, time: Date.now() } : null;
    }, { passive: true });
    article.addEventListener('touchcancel', () => { start = null; }, { passive: true });
    article.addEventListener('touchend', event => {
        const origin = start;
        start = null;
        const touch = event.changedTouches[0];
        if (!origin || !touch || event.touches.length || Date.now() - origin.time > 700 || !window.getSelection()?.isCollapsed) return;
        const x = touch.clientX - origin.x;
        const y = touch.clientY - origin.y;
        if (Math.abs(x) >= 60 && Math.abs(x) > Math.abs(y) * 1.5) move(x < 0 ? 1 : -1);
    }, { passive: true });
}

function shareCardKey(session, message, index) {
    return `${session.id}:${message.id}:${index}`;
}

function shareBusy(session = activeSession()) {
    return app.sharing || app.sending || app.swiping || Boolean(pendingReply(session));
}

function renderShareRequest(session, message, part) {
    const key = shareCardKey(session, message, part.index);
    if (!app.shareUnticked.has(key)) app.shareUnticked.set(key, new Set());
    return renderShareRequestCard(part, {
        source: app.source,
        settings: session.settings,
        busy: shareBusy(session),
        dismissed: app.shareDismissed.has(key),
        unticked: app.shareUnticked.get(key),
        onShare: choice => void acceptShareRequest(session, choice, { continueReply: true }),
        onTurnOn: choice => void acceptShareRequest(session, choice, { continueReply: false }),
        onDismiss: () => {
            app.shareDismissed.add(key);
            renderMessages();
        },
    });
}

/**
 * Turns on only the switches the user ticked. The message sent afterwards is
 * built from Scratchpad's own labels, never from the assistant's text.
 */
async function acceptShareRequest(session, { keys, depth }, { continueReply }) {
    if (shareBusy(session) || activeSession()?.id !== session.id) return;
    const patch = shareSettingsPatch(keys, depth);
    if (!Object.keys(patch).length) return;
    app.sharing = true;
    renderMessages();
    let saved;
    try {
        saved = await updateSettings(patch, { rerenderContext: true });
    } finally {
        app.sharing = false;
        renderMessages();
    }
    if (!saved) return;
    if (continueReply) await send({ followUp: shareFollowUp(keys, depth) });
    else toastr.success(t`Shared ${shareItemLabels(keys, depth)}. Open Preview to check before sending.`);
}

function renderReply(session, message) {
    const body = h('div', { class: 'scratchpad-reply' });
    // A share request becomes a card only once the reply is complete, so nothing can be pressed while it streams.
    const shareCards = message.role === 'assistant' && (message.state ?? 'done') === 'done';
    for (const part of message.rehearsal ? [{ type: 'text', text: message.text }] : splitReply(message.text)) {
        if (part.type === 'text') {
            for (const piece of message.rehearsal ? [part] : splitBugReports(part.text).flatMap(item => item.type === 'text' && shareCards ? splitShareRequests(item.text) : [item])) {
                if (piece.type === 'bug-report') {
                    body.append(renderBugReportCard(piece));
                    continue;
                }
                if (piece.type === 'share-request') {
                    body.append(renderShareRequest(session, message, piece));
                    continue;
                }
                if (!piece.text.trim()) continue;
                const block = h('div', { class: 'scratchpad-text mes_text' });
                block.innerHTML = messageFormatting(piece.text, '', false, false, -1, strictReplySanitizerOverrides(), false);
                stripForeignPortraitUrls(block);
                body.append(block);
            }
        } else {
            body.append(renderChangeCard(session, message, part));
        }
    }
    const open = batchParts(message);
    if (open.length > 1) {
        body.append(h('div', { class: 'scratchpad-change-batch' },
            iconButton(t`Review all ${open.length} changes`, () => void reviewAllChanges(session, message), {
                icon: 'fa-list-check', primary: true, className: 'scratchpad-review-all',
            })));
    }
    const codes = [...body.querySelectorAll('.scratchpad-text pre > code')];
    const sources = codes.map(code => ({ language: previewLanguage(code.className), text: code.textContent }));
    for (const [index, code] of codes.entries()) {
        const pre = code.parentElement;
        const wrapper = h('div', { class: 'scratchpad-code-block' });
        const text = code.textContent;
        pre.replaceWith(wrapper);
        wrapper.append(pre, iconButton('', () => void copyText(text), {
            icon: 'fa-copy', title: t`Copy code`, className: 'scratchpad-copy',
        }));
        const preview = previewForBlock(sources, index);
        if (preview) wrapper.append(iconButton(t`Preview HTML/CSS`, () => void showHtmlPreview(preview), {
            icon: 'fa-eye', className: 'scratchpad-code-preview',
            title: t`Preview this HTML with the CSS blocks in this reply`,
        }));
    }
    return body;
}

function renderChangeCard(session, message, part) {
    if (!part.change) {
        return h('div', { class: 'scratchpad-change is-invalid' },
            h('p', { class: 'scratchpad-change-title', text: t`A suggested change could not be read` }),
            h('p', { class: 'scratchpad-change-reason', text: part.error }));
    }
    if (part.change.type === 'image') return images.renderImageCard({ session, message, part, button: iconButton,
        availability: app.imageAvailability, job: app.imageJobs.get(message.images?.[part.index]?.jobId), error: app.imageErrors.get(changeKey(session, message, part)),
        onGenerate: () => void generateImageProposal(session, message, part), onReview: picture => void reviewChange(session, message, part, picture),
        onPromptReview: () => void approveImagePrompt(session, message, part), onDismiss: () => void dismissChange(session, message, part),
        onError: error => { app.imageErrors.set(changeKey(session, message, part), error.message); renderMessages(); },
        onRetried: () => { const jobId = message.images?.[part.index]?.jobId; if (jobId) app.imageAutoReviews.add(jobId); if (app.open) void reload(); },
        onRestore: () => void markChange(session, message, part.index, null) });
    const state = message.proposals?.[String(part.index)] ?? '';
    const card = h('div', { class: `scratchpad-change${state ? ` is-${state}` : ''}` },
        h('p', { class: 'scratchpad-change-title' }, h('i', { class: 'fa-solid fa-wand-magic-sparkles', 'aria-hidden': 'true' }), h('span', { text: describeChange(part.change) })),
        part.change.reason ? h('p', { class: 'scratchpad-change-reason', text: part.change.reason, 'data-i18n-ignore': '' }) : null);
    if (state === 'applied') return renderSavedChange(card, session, message, part);
    if (state === 'undone') {
        card.append(h('div', { class: 'scratchpad-change-actions' },
            h('span', { class: 'scratchpad-change-state', text: t`Undone` }),
            iconButton(t`Review again`, () => void markChange(session, message, part.index, null), { className: 'scratchpad-link' })));
        return card;
    }
    if (state === 'rejected') {
        card.append(h('div', { class: 'scratchpad-change-actions' },
            h('span', { class: 'scratchpad-change-state', text: t`Dismissed` }),
            part.change.type === 'notebook' && message.notebookProposals?.[part.index] ? null : iconButton(t`Undo`, () => void markChange(session, message, part.index, null), { className: 'scratchpad-link' })));
        return card;
    }
    const key = changeKey(session, message, part);
    const busy = busyChanges.has(key);
    card.dataset.changeKey = key;
    const tryable = message.role === 'assistant' && !message.rehearsal && canTryProposalInRehearsal(part.change, app.source);
    card.append(h('div', { class: 'scratchpad-change-actions' },
        iconButton(busy ? t`Saving…` : t`Review`, () => void reviewChange(session, message, part), { icon: 'fa-eye', primary: true, disabled: busy }),
        tryable ? iconButton(t`Try first`, () => void tryChange(session, message, part), {
            icon: 'fa-flask', className: 'scratchpad-change-try', title: t`Rehearse the next story reply with this change, without saving it`,
            disabled: busy || tryBlocked(),
        }) : null,
        iconButton(t`Dismiss`, () => void dismissChange(session, message, part), { icon: 'fa-xmark', disabled: busy })));
    return card;
}

// Saved changes being undone, the latest refusal for each, and reversals whose history mark failed, keyed by history entry id.
const undoingChanges = new Set();
const undoConflicts = new Map();
const revertedChanges = new Set();

function savedHistoryEntry(session, message, part) {
    return findHistoryEntry(app.bucket?.changeHistory, { sessionId: session.id, messageId: message.id, proposalIndex: part.index });
}

function renderSavedChange(card, session, message, part) {
    const entry = savedHistoryEntry(session, message, part);
    const undoable = canUndoEntry(entry);
    const busy = undoable && undoingChanges.has(entry.id);
    const conflict = entry ? undoConflicts.get(entry.id) : '';
    let action = null;
    if (undoable) {
        action = iconButton(busy ? t`Undoing…` : t`Undo`, () => void undoSavedChange(entry.id), {
            icon: 'fa-rotate-left', className: 'scratchpad-change-undo', disabled: busy,
            title: t`Put back what was there before this change`,
        });
        if (busy) action.setAttribute('aria-busy', 'true');
    } else if (entry) {
        action = iconButton(t`History`, () => void openChangeHistory(), { className: 'scratchpad-link', title: historyHeading() });
    }
    card.append(h('div', { class: 'scratchpad-change-actions' },
        h('span', { class: 'scratchpad-change-state', text: t`Saved` }), action));
    if (conflict) {
        card.append(h('div', { class: 'scratchpad-change-conflict', role: 'status' },
            h('p', { text: conflict }),
            h('div', { class: 'scratchpad-change-actions' },
                entry.before ? iconButton(t`Copy previous text`, () => void copyText(entry.before), { icon: 'fa-copy', className: 'scratchpad-link' }) : null,
                iconButton(historyHeading(), () => void openChangeHistory(), { icon: 'fa-clock-rotate-left', className: 'scratchpad-link' }))));
    }
    return card;
}

// The open Change history dialog, redrawn whenever the bucket or an undo changes.
let historyView = null;

function historyCount() {
    return Array.isArray(app.bucket?.changeHistory) ? app.bucket.changeHistory.length : 0;
}

function renderHistoryView({ force = false } = {}) {
    if (!historyView || (!force && !historyView.isConnected)) return;
    const open = new Set([...historyView.querySelectorAll('.scratchpad-history-entry')]
        .filter(item => item.querySelector('details')?.open).map(item => item.dataset.historyId));
    clear(historyView).append(renderChangeHistory(app.bucket?.changeHistory, {
        button: iconButton, busy: undoingChanges, conflicts: undoConflicts, open, diffParts: textDiffParts,
        onUndo: entry => void undoSavedChange(entry.id), onCopy: text => void copyText(text),
    }));
}

async function openChangeHistory() {
    if (historyView?.isConnected) return;
    const view = h('div', { class: 'scratchpad-review scratchpad-history-dialog' });
    historyView = view;
    renderHistoryView({ force: true });
    try {
        await callGenericPopup(view, POPUP_TYPE.TEXT, '', { okButton: t`Close`, allowVerticalScrolling: true });
    } finally {
        if (historyView === view) historyView = null;
    }
}

function refreshUndoViews() {
    renderMessages();
    renderHeader();
    renderHistoryView();
}

// Puts back what a saved change replaced, then marks its history entry undone. A conflict leaves the entry saved.
async function undoSavedChange(entryId) {
    const source = app.source;
    const entry = app.bucket?.changeHistory?.find(item => item?.id === entryId);
    if (!canUndoEntry(entry) || undoingChanges.has(entryId)) return;
    undoingChanges.add(entryId);
    undoConflicts.delete(entryId);
    refreshUndoViews();
    try {
        await app.queue;
        try {
            requireScope(source);
            if (!revertedChanges.has(entryId)) {
                const { undoChange } = await import('./change-undo.js');
                await undoChange(entry, source);
                revertedChanges.add(entryId);
            }
        } catch (error) {
            if (error?.conflict) {
                undoConflicts.set(entryId, error.message);
                toastr.warning(error.message);
            } else {
                reportError(error, t`That change could not be undone.`);
            }
            return;
        }
        const marked = await change(wire => api.markChangeUndone(wire, entryId),
            t`The change was undone, but Change history could not be updated. Press Undo again to finish.`, source);
        if (marked) {
            revertedChanges.delete(entryId);
            const label = entry.description || t`Saved change`;
            toastr.success(t`Undid: ${label}`);
            app.contextKey = '';
            render();
        }
    } finally {
        undoingChanges.delete(entryId);
        refreshUndoViews();
    }
}

// A trial waits for any running reply, so it never queues behind one or races a save.
function tryBlocked() {
    return app.sending || Boolean(pendingReply());
}

function syncReviewTryButtons() {
    const blocked = tryBlocked();
    for (const button of document.querySelectorAll('.scratchpad-review-try')) {
        button.classList.toggle('disabled', blocked);
        button.setAttribute('aria-disabled', String(blocked));
    }
}

// Rehearses the next story reply with a change card's proposal, or the draft edited in Review, kept in memory only.
async function tryChange(session, message, part, value) {
    const source = app.source;
    if (tryBlocked() || !canTryProposalInRehearsal(part.change, source)) return;
    const key = changeKey(session, message, part);
    if (busyChanges.has(key)) return;
    try {
        await prepareReviewPlan(source, session, message, part);
    } catch (error) {
        reportError(error, t`That change cannot be tried right now.`);
        return;
    }
    const label = describeChange(part.change);
    await send({
        rehearsal: true,
        followUp: buildTryRehearsalRequest(label),
        rehearsalChange: { change: part.change, ...(typeof value === 'string' ? { value } : {}), label },
    });
}

function imageGuard(source, session, message, part) {
    requireScope(source, session.id);
    if (part.change.persona) personaGuard(source, session, message, part);
    if (part.change.character) {
        const target = message.targets?.filter(target => target.name.toLowerCase() === part.change.character.toLowerCase());
        if (target?.length !== 1 || !currentSettings().include.card || !sourceCharacters(source).some(card => card.avatar === target[0].avatar)
            || source.kind === 'general' && (!sameChat(message.contextSource, source) || message.sharedAvatar !== source.avatar)) {
            throw new Error(t`Keep the original character selected and shared before using this image suggestion.`);
        }
    }
}

function personaGuard(source, session, message, part) {
    requireScope(source, session.id);
    const target = sourcePersona(source);
    if (!currentSettings().include.persona || !message.sharedPersona || target?.avatar !== message.sharedPersona.avatar
        || target.name !== message.sharedPersona.name || part.change.persona.toLowerCase() !== target.name.toLowerCase()) {
        throw new Error(t`Keep the original persona selected and shared before using this suggestion.`);
    }
}

async function generateImageProposal(session, message, part) {
    const source = app.source;
    const key = changeKey(session, message, part);
    if (busyChanges.has(key)) return;
    busyChanges.add(key);
    try {
        await app.queue;
        const result = await images.generateProposal({ source: wireSource(source), session, message, part,
            guard: () => imageGuard(source, session, message, part), acknowledge });
        app.imageErrors.delete(key);
        if (sameSourceBucket(source, app.source)) {
            if (result.job?.id) {
                app.imageJobs.set(result.job.id, result.job);
                app.imageAutoReviews.add(result.job.id);
            }
            app.ticket++;
            applyBucket(result.bucket);
        }
    } catch (error) { app.imageErrors.set(key, error.message); renderMessages(); } finally { busyChanges.delete(key); }
}

/** The visible image card of a job in the active session, so a prompt review can open on it. */
function imageReviewCard(jobId) {
    const session = activeSession();
    if (!session) return null;
    for (const message of session.messages) {
        for (const [index, image] of Object.entries(message.images ?? {})) {
            if (image?.jobId !== jobId) continue;
            const part = splitReply(message.text).find(item => item.type === 'change' && String(item.index) === String(index));
            if (part) return { session, message, part };
        }
    }
    return null;
}

async function approveImagePrompt(session, message, part) {
    const source = app.source;
    const key = changeKey(session, message, part);
    if (busyChanges.has(key)) return;
    busyChanges.add(key);
    try {
        const job = app.imageJobs.get(message.images?.[part.index]?.jobId);
        if (!job?.result?.approval) return;
        const decided = await images.reviewImagePrompt(job, { guard: () => imageGuard(source, session, message, part), popup: callGenericPopup,
            type: POPUP_TYPE.CONFIRM, affirmative: POPUP_RESULT.AFFIRMATIVE });
        app.imageErrors.delete(key);
        if (sameSourceBucket(source, app.source)) {
            if (decided?.job) app.imageJobs.set(job.id, decided.job);
            if (app.open) void reload();
        }
    } catch (error) { app.imageErrors.set(key, error.message); renderMessages(); } finally { busyChanges.delete(key); }
}

// A suggestion stays busy from Review until it is marked saved, so repeated clicks cannot save it twice.
const busyChanges = new Set();
// Unsaved changes behind each change-trial rehearsal, keyed by session and user message, so Try again reuses them.
const trialChanges = new Map();
// Saved changes whose Change history entry failed, with their receipts; the next Review only retries the entry.
const committedChanges = new Map();

function changeKey(session, message, part) {
    return `${session.id}:${message.id}:${part.index}`;
}

function setChangeBusy(key, busy) {
    if (busy) busyChanges.add(key);
    else busyChanges.delete(key);
    for (const card of app.el.messages?.querySelectorAll('.scratchpad-change') ?? []) {
        if (card.dataset.changeKey !== key) continue;
        const [review, dismiss] = card.querySelectorAll('.scratchpad-change-actions button:not(.scratchpad-change-try)');
        const trial = card.querySelector('.scratchpad-change-try');
        if (trial) trial.disabled = busy || tryBlocked();
        if (review) {
            review.disabled = busy;
            const label = review.querySelector('span');
            if (label) label.textContent = busy ? t`Saving…` : t`Review`;
        }
        if (dismiss) dismiss.disabled = busy;
    }
}

function markChange(session, message, index, state, source = app.source) {
    return change(wire => api.markProposal(wire, session.id, message.id, index, state), t`Scratchpad could not update that suggestion.`, source);
}

const NO_UNDO_REASONS = {
    image: () => t`Picture changes are not undone automatically. The previous picture stays in your images if you want it back.`,
    notebook: () => t`Note changes are not undone from Scratchpad. Open the note in Notes to change it back.`,
};

// A history record for saves that carry no receipt of their own, such as pictures and notes.
function fallbackReceipt(part, plan = null, after = '') {
    const type = part.change.type;
    return {
        type, action: String(part.change.action ?? ''), description: describeChange(part.change),
        target: { kind: type, label: String(plan?.target ?? '') }, field: String(plan?.field ?? ''),
        before: String(plan?.before ?? ''), after: String(after ?? plan?.after ?? ''),
        undo: null, undoable: false, undoUnavailableReason: NO_UNDO_REASONS[type]?.() ?? t`Automatic undo is not available for this change.`,
    };
}

// Marks the suggestion saved and adds it to Change history in one request.
function recordSaved(session, message, part, receipt, source = app.source, { markApplied = true } = {}) {
    const entry = { ...(receipt ?? fallbackReceipt(part)), sessionId: session.id, messageId: message.id, proposalIndex: part.index };
    return change(wire => api.recordSavedChange(wire, entry, { markApplied }),
        t`The change was saved, but Scratchpad could not mark it saved. Press Review to finish.`, source);
}

async function reviewChange(session, message, part, picture) {
    if (part.change.type === 'notebook') return reviewNotebookChange(session, message, part);
    const key = changeKey(session, message, part);
    if (busyChanges.has(key)) return;
    setChangeBusy(key, true);
    let trial;
    try {
        if (committedChanges.has(key)) {
            if (await recordSaved(session, message, part, committedChanges.get(key), app.source)) committedChanges.delete(key);
            return;
        }
        trial = await reviewAndSaveChange(session, message, part, key, picture);
    } finally {
        setChangeBusy(key, false);
    }
    if (trial) await tryChange(session, message, part, trial.tryValue);
}

function settingDiff(settings, heading = true) {
    const list = h('div', { class: 'scratchpad-preview-text scratchpad-setting-diff', role: 'group', 'data-i18n-ignore': '', tabindex: '0', 'aria-label': t`Activation settings` },
        settings.map(row => h('div', { class: 'scratchpad-setting-row' },
            h('strong', { text: `${row.label}: ` }),
            h('span', { class: 'ica-transform-diff-part--del', text: row.before }),
            h('span', { text: ' -> ' }),
            h('span', { class: 'ica-transform-diff-part--ins', text: row.after }))));
    return heading
        ? h('div', { class: 'ica-transform-history' }, h('strong', { text: t`Activation settings` }), list)
        : list;
}

function changeDiff(plan, editor = null) {
    const blocks = [];
    if (Array.isArray(plan.settings) && plan.settings.length) {
        blocks.push(settingDiff(plan.settings, !plan.hideTextDiff));
    }
    if (!plan.hideTextDiff) {
        const diff = h('div', { class: 'ica-transform-diff', role: 'group', 'data-i18n-ignore': '', tabindex: '0', 'aria-label': t`Changes` });
        const update = () => {
            const edited = editor ? editor.value : plan.after;
            // The shared renderer escapes every text segment before adding its fixed markup.
            diff.innerHTML = buildTextDiffMarkup(plan.before, plan.getAfterText ? plan.getAfterText(edited) : edited);
        };
        update();
        editor?.addEventListener('input', update);
        blocks.push(h('div', { class: 'ica-transform-history' },
            h('strong', { text: t`Changes` }), diff));
    }
    return blocks.length === 1 ? blocks[0] : h('div', { class: 'scratchpad-review-diffs' }, blocks);
}

/** Reads the live target of one suggestion and builds its review. Throws when it cannot be reviewed now. */
async function prepareReviewPlan(source, session, message, part, picture) {
    await app.queue;
    requireScope(source, session.id);
    if (part.change.type === 'chat' && source.scope && !sameChat(message.contextSource, source)) {
        throw new Error(t`Open the original chat before reviewing this message change.`);
    }
    if (source.kind === 'general' && part.change.type === 'character' && part.change.action !== 'create'
        && (!sameChat(message.contextSource, source) || !currentSettings().include.card)) {
        throw new Error(t`Return to the original context and share the selected card before reviewing this change.`);
    }
    const plan = part.change.type === 'image' ? await images.prepareAvatarChange({ source: wireSource(source), personaSource: source, session, message, part, picture,
        guard: () => imageGuard(source, session, message, part) }) : await prepareChange(part.change, source, { sharedAvatar: message.sharedAvatar,
        sharedPersona: message.sharedPersona, personaGuard: () => personaGuard(source, session, message, part),
        sharedPreset: message.sharedPreset, presetGuard: () => {
            requireScope(source, session.id);
            if ((source.kind !== 'roleplay' && source.kind !== 'conversation') || !currentSettings().include.preset || !sameChat(message.contextSource, source)) {
                throw new Error(t`Share the original preset in this chat before saving its changes.`);
            }
        },
        agentsShared: currentSettings().include.agents === true, authorsNoteShared: currentSettings().include.authorsNote === true, regexShared: currentSettings().include.regex === true, cssSnippetsShared: currentSettings().include.cssSnippets === true, dialogueColorsShared: currentSettings().include.dialogueColors === true, sharedLorebooks: generalLorebooks(source, currentSettings()),
        disabledEntriesListed: currentSettings().include.problems === true && (source.kind === 'general' ? generalLorebooks(source, currentSettings()).length > 0 : currentSettings().include.lore !== false),
        lorebookGuard: () => {
            requireScope(source, session.id);
            if (source.kind === 'general' && !generalLorebooks(source, currentSettings()).includes(part.change.book)) {
                throw new Error(t`Share that lorebook in Scratchpad before saving changes to it.`);
            }
        },
        mewmoryShared: currentSettings().include.mewmory === true, sessionId: session.id,
        creationGuard: () => requireScope(source, session.id), creatorKey: JSON.stringify([source.key, session.id, message.id, part.index]) });
    requireScope(source, session.id);
    if (plan.bucket) applyBucket(plan.bucket);
    return plan;
}

async function commitReviewPlan(source, session, part, plan, text) {
    await app.queue;
    requireScope(source, session.id);
    if (source.kind === 'general' && part.change.type === 'character' && part.change.action !== 'create' && !currentSettings().include.card) {
        throw new Error(t`Share the selected character card before saving this change.`);
    }
    return plan.commit(text);
}

async function reviewAndSaveChange(session, message, part, key, picture) {
    const source = app.source;
    let plan;
    try {
        plan = await prepareReviewPlan(source, session, message, part, picture);
    } catch (error) {
        reportError(error, t`That change cannot be reviewed right now.`);
        return;
    }
    const editor = plan.editable
        ? h('textarea', { class: 'text_pole scratchpad-review-editor', rows: '12', value: plan.after, 'aria-label': plan.afterLabel || t`Proposed text` })
        : null;
    const content = h('div', { class: `neconyan-assistant-review scratchpad-review${plan.visual ? ' scratchpad-picture-review' : ''}` },
        h('p', { text: plan.editable ? t`Check this change before it is saved. You can edit the proposed text first.` : t`Check this change before it is saved.` }),
        h('p', {}, h('strong', { text: t`Where: ` }), plan.target),
        h('p', {}, h('strong', { text: t`What: ` }), plan.field),
        plan.visual || changeDiff(plan, editor),
        editor ? h('strong', { text: plan.afterLabel || t`Proposed` }) : null,
        editor,
        plan.hint ? h('p', { class: 'scratchpad-review-hint', text: plan.hint }) : null);
    if (editor) {
        const readPreview = () => previewFromText(plan.getAfterText ? plan.getAfterText(editor.value) : editor.value);
        const previewButton = iconButton(t`Preview HTML/CSS`, () => {
            const preview = readPreview();
            if (preview) void showHtmlPreview(preview);
        }, { icon: 'fa-eye', className: 'scratchpad-code-preview' });
        const update = () => { previewButton.hidden = !readPreview(); };
        editor.addEventListener('input', update);
        update();
        editor.after(previewButton);
    }
    const tryable = !picture && message.role === 'assistant' && !message.rehearsal && canTryProposalInRehearsal(part.change, source);
    let dialog = null;
    let draft;
    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: !plan.visual,
        okButton: t`Save change`,
        cancelButton: t`Not now`,
        ...(tryable ? {
            customButtons: [{
                text: t`Try before saving`,
                icon: 'fa-flask',
                classes: ['scratchpad-review-try'],
                tooltip: t`Rehearse the next story reply with this draft, without saving it`,
                // No result of its own, so a click while a reply runs leaves the dialog open.
                action: () => {
                    if (tryBlocked() || !dialog) return;
                    draft = editor ? editor.value : undefined;
                    void dialog.complete(POPUP_RESULT.CUSTOM1);
                },
            }],
            onOpen: popup => {
                dialog = popup;
                syncReviewTryButtons();
            },
        } : {}),
    });
    if (result === POPUP_RESULT.CUSTOM1) return { tryValue: draft };
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    let creatorDraftId = null;
    let receipt = null;
    try {
        const text = editor ? editor.value : plan.after;
        const saved = await commitReviewPlan(source, session, part, plan, text);
        creatorDraftId = saved?.creatorDraftId;
        receipt = saved?.receipt ?? fallbackReceipt(part, plan, text);
        if (saved?.refreshFailed) toastr.info(t`The change was saved. Refresh this view to see it.`);
    } catch (error) {
        reportError(error, t`That change could not be saved.`);
        return;
    }
    committedChanges.set(key, receipt);
    toastr.success(t`Change saved.`);
    if (await recordSaved(session, message, part, receipt, source)) committedChanges.delete(key);
    if (creatorDraftId) {
        hideScratchpad();
        globalThis.NeconyanShell?.openCreator?.({ draftId: creatorDraftId });
    }
}

/** Open suggestions of one reply that can be reviewed together: edits to things that already exist. */
function batchParts(message) {
    if (message.rehearsal) return [];
    return splitReply(message.text).filter(part => part.type === 'change' && part.change
        && !['image', 'notebook', 'creator'].includes(part.change.type) && part.change.action !== 'create'
        && !message.proposals?.[String(part.index)]);
}

async function reviewAllChanges(session, message) {
    const source = app.source;
    const parts = batchParts(message).filter(part => !busyChanges.has(changeKey(session, message, part)));
    if (parts.length < 2) return;
    const keys = parts.map(part => changeKey(session, message, part));
    for (const key of keys) setChangeBusy(key, true);
    try {
        const items = [];
        for (const [index, part] of parts.entries()) {
            const item = { part, key: keys[index], title: describeChange(part.change) };
            if (committedChanges.has(item.key)) item.committed = true;
            else {
                try {
                    item.plan = await prepareReviewPlan(source, session, message, part);
                } catch (error) {
                    item.error = error?.message || t`That change cannot be reviewed right now.`;
                }
            }
            items.push(item);
        }
        const ready = items.filter(item => item.plan || item.committed);
        const content = h('div', { class: 'neconyan-assistant-review scratchpad-review scratchpad-batch' },
            h('h3', { text: t`Review ${parts.length} changes` }),
            h('p', { text: t`Untick anything you do not want. Each ticked change is checked against what is saved now before it is written, so one that no longer fits is left alone.` }),
            items.map((item, index) => {
                const heading = h('span', { text: item.title });
                if (item.error) {
                    return h('section', { class: 'scratchpad-batch-item is-unavailable', 'aria-label': t`Change ${index + 1}` },
                        h('p', { class: 'scratchpad-batch-title' }, heading),
                        h('p', { class: 'scratchpad-change-reason', role: 'note', text: item.error }));
                }
                item.box = h('input', { type: 'checkbox', checked: true });
                if (item.committed) {
                    return h('section', { class: 'scratchpad-batch-item', 'aria-label': t`Change ${index + 1}` },
                        h('label', { class: 'scratchpad-check scratchpad-batch-title' }, item.box, heading),
                        h('p', { class: 'scratchpad-muted', text: t`Already saved. Ticking it only records that on the card.` }));
                }
                const { plan } = item;
                item.editor = plan.editable
                    ? h('textarea', { class: 'text_pole scratchpad-review-editor', rows: '6', value: plan.after, 'aria-label': plan.afterLabel || t`Proposed text` })
                    : null;
                return h('section', { class: 'scratchpad-batch-item', 'aria-label': t`Change ${index + 1}` },
                    h('label', { class: 'scratchpad-check scratchpad-batch-title' }, item.box, heading),
                    h('p', {}, h('strong', { text: t`Where: ` }), plan.target),
                    h('p', {}, h('strong', { text: t`What: ` }), plan.field),
                    plan.visual || changeDiff(plan, item.editor),
                    item.editor ? h('details', { class: 'scratchpad-batch-edit' }, h('summary', { text: t`Edit the proposed text` }), item.editor) : null,
                    plan.hint ? h('p', { class: 'scratchpad-review-hint', text: plan.hint }) : null);
            }));
        const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
            wide: true, large: true, okButton: ready.length ? t`Save ticked changes` : t`Close`, cancelButton: t`Not now`,
        });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        let saved = 0;
        const failed = [];
        for (const item of ready) {
            if (!item.box.checked) continue;
            try {
                if (!item.committed) {
                    // Earlier saves in this batch may have moved the target, so each change is read again first.
                    const fresh = await prepareReviewPlan(source, session, message, item.part);
                    if (fresh.before !== item.plan.before || fresh.after !== item.plan.after || fresh.snapshot !== item.plan.snapshot) {
                        throw new Error(t`This changed after you reviewed it, so it was not saved. Review it again on its own.`);
                    }
                    const text = item.editor ? item.editor.value : fresh.after;
                    const outcome = await commitReviewPlan(source, session, item.part, fresh, text);
                    if (outcome?.refreshFailed) toastr.info(t`The change was saved. Refresh this view to see it.`);
                    committedChanges.set(item.key, outcome?.receipt ?? fallbackReceipt(item.part, fresh, text));
                }
                saved++;
                if (await recordSaved(session, message, item.part, committedChanges.get(item.key), source)) committedChanges.delete(item.key);
            } catch (error) {
                failed.push({ title: item.title, reason: error?.message || t`That change could not be saved.` });
            }
        }
        if (saved) toastr.success(saved === 1 ? t`1 change saved.` : t`${saved} changes saved.`);
        if (failed.length) {
            for (const key of keys) setChangeBusy(key, false);
            await callGenericPopup(h('div', { class: 'scratchpad-review scratchpad-batch' },
                h('h3', { text: failed.length === 1 ? t`1 change was not saved` : t`${failed.length} changes were not saved` }),
                h('p', { text: t`Their cards are still open, so you can review each one again.` }),
                h('ul', {}, failed.map(item => h('li', {}, h('strong', { text: item.title }), h('br'), h('span', { text: item.reason }))))),
            POPUP_TYPE.TEXT, '', { okButton: t`Close` });
        }
    } finally {
        for (const key of keys) setChangeBusy(key, false);
    }
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
                changeDiff(proposal));
            const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: t`Save change`, cancelButton: t`Not now` });
            if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        }
        requireScope(source, session.id);
        const result = await api.decideNotebookProposal(wireSource(source), session.id, message.id, part.index, proposal.proposalHash, dismiss ? 'deny' : 'allow');
        requireScope(source, session.id);
        applyBucket(result.bucket);
        if (result.result.committed) {
            toastr.success(t`Change saved.`);
            const plan = { target: proposal.summary?.label || '', field: '', before: proposal.before, after: proposal.after };
            await recordSaved(session, message, part, fallbackReceipt(part, plan, proposal.after), source, { markApplied: false });
        }
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
            sessionId: session.id, scratchpadMessageId: message?.id, speaker: message?.assistant ? message.assistantName || assistantInfo(message.assistant, session).name : message ? sourceUserName(source) : t`Scratchpad session`, messageSendDate: message?.created } });
    } catch (error) { reportError(error, t`That text could not be saved to Notes.`); }
}

function replyDraft(text) {
    return splitReply(text).filter(part => part.type === 'text').map(part => part.text).join('').trim();
}

function useAsDraft(message) {
    if (!['roleplay', 'conversation'].includes(app.source?.kind) || !isCurrentSource(app.source)) return;
    const draft = replyDraft(message.text);
    if (!draft) return;
    const target = document.querySelector(app.source.kind === 'conversation' ? '#sb_conversation_input' : '#send_textarea');
    if (!target) return;
    target.value = draft;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    toastr.info(t`Copied into the chat box. Nothing has been sent.`);
    if (isPhone()) hideScratchpad();
    target.focus();
}

async function addAsReplyVersion(session, message) {
    const source = app.source;
    if (source?.kind !== 'roleplay') return;
    const text = replyDraft(message.text);
    if (!text) return;
    try {
        requireScope(source, session.id);
        const target = replyVersionTarget(source);
        const ok = await callGenericPopup(t`Add this as another version of the last story reply, from ${escapeHtml(target.name)}? The story shows it straight away. The earlier versions stay, so you can swipe back to them.`,
            POPUP_TYPE.CONFIRM, '', { okButton: t`Add version`, cancelButton: t`Not now` });
        if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
        requireScope(source, session.id);
        await addReplyVersion(source, target, text);
        toastr.success(t`Added as a new version of the last story reply.`);
        if (isPhone()) hideScratchpad();
    } catch (error) { reportError(error, t`That reply could not be added to the story.`); }
}

async function readAloud(session, message) {
    const refresh = () => {
        if (!app.open) return;
        renderMessages();
        app.el.messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"] .scratchpad-read-aloud`)?.focus({ preventScroll: true });
    };
    try {
        const speaker = message.assistantName || assistantInfo(message.assistant, session).name;
        const result = await toggleReadAloud(message, speaker, refresh);
        if (result === 'empty') toastr.info(t`This reply has no text to read aloud.`);
    } catch (error) {
        console.warn('[Scratchpad]', error);
        toastr.warning(t`That reply could not be read aloud. Check the text to speech settings.`);
    }
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        toastr.success(t`Copied.`);
    } catch {
        toastr.warning(t`Copying is not available here.`);
    }
}

async function copyMessage(message) {
    await copyText(message.text);
}

async function removeMessage(session, message) {
    const scope = app.source;
    const ok = await callGenericPopup(t`Delete this Scratchpad message? The story is not affected.`, POPUP_TYPE.CONFIRM, '', { okButton: t`Delete`, cancelButton: t`Keep` });
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
    await change(source => api.deleteMessage(source, session.id, message.id), t`Scratchpad could not delete that message.`, scope);
}

async function keepOnlyReply(session, message) {
    await change(source => api.keepComparedReply(source, session.id, message.id), t`Scratchpad could not keep that reply.`, app.source);
}

/** The original session stays as it is; the copy ends at this message, or just before it when it is the user's own. */
async function branchFrom(session, message) {
    const own = message.role === 'user';
    const saved = await change(source => api.branchSession(source, session.id, message.id), t`Scratchpad could not branch from that message.`);
    if (!saved) return;
    if (own) {
        usePrompt(message.text);
        toastr.success(t`Branched into a new session. Your message is in the box to reword and send; the original session is unchanged.`);
    } else {
        toastr.success(t`Branched into a new session. The original session is unchanged.`);
        app.el.composer.focus();
    }
}

function renderMessageActions(session, message, { retry }) {
    const busy = Boolean(pendingReply(session));
    const actions = h('div', { class: 'scratchpad-message-actions' });
    if (message.text) actions.append(iconButton('', () => void copyMessage(message), { icon: 'fa-copy', title: t`Copy` }));
    if (message.text) actions.append(iconButton('', () => void saveToNote(session, message), { icon: 'fa-book-bookmark', title: t`Save selection or message to note` }));
    actions.append(iconButton('', () => {
        app.editing = message.id;
        renderMessages();
    }, { icon: 'fa-pen', title: t`Edit`, disabled: busy }));
    if (message.role === 'assistant' && message.text && ['roleplay', 'conversation'].includes(app.source?.kind)) {
        actions.append(iconButton('', () => useAsDraft(message), { icon: 'fa-reply', title: t`Use as draft in the chat box` }));
        if (app.source.kind === 'roleplay') {
            actions.append(iconButton('', () => void addAsReplyVersion(session, message), { icon: 'fa-layer-group', title: t`Add as another version of the last story reply`, disabled: busy }));
        }
    }
    if (message.role === 'assistant' && message.text && canReadAloud()) {
        const reading = isReadingAloud(message.id);
        actions.append(iconButton('', () => void readAloud(session, message), { icon: reading ? 'fa-stop' : 'fa-volume-high', title: reading ? t`Stop reading` : t`Read aloud`, pressed: reading, className: 'scratchpad-read-aloud' }));
    }
    if (retry) {
        actions.append(iconButton('', () => void send({ regenerate: message.id }), { icon: 'fa-rotate-right', title: t`Try again`, disabled: busy || app.sending }));
    }
    if (message.role === 'assistant' && message.state !== 'pending' && comparedSiblings(session.messages, message).length) {
        actions.append(iconButton('', () => void keepOnlyReply(session, message), { icon: 'fa-check-double', className: 'scratchpad-keep-reply', title: t`Keep only this reply`, disabled: busy || app.sending }));
    }
    actions.append(iconButton('', () => void branchFrom(session, message), { icon: 'fa-code-branch', className: 'scratchpad-branch',
        title: message.role === 'user' ? t`Reword in a new session` : t`Branch into a new session from here`, disabled: busy || app.sending }));
    actions.append(iconButton('', () => void removeMessage(session, message), { icon: 'fa-trash', title: t`Delete`, disabled: busy }));
    return actions;
}

function renderEditor(session, message) {
    const editor = h('textarea', { class: 'text_pole scratchpad-edit', rows: '6', value: message.text, 'aria-label': t`Edit message` });
    const refocus = () => {
        if (app.open && activeSession()?.id === session.id) {
            app.el.messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"] .scratchpad-message-menu > summary`)?.focus({ preventScroll: true });
        }
    };
    const done = () => {
        app.editing = '';
        renderMessages();
        refocus();
    };
    requestAnimationFrame(() => { if (editor.isConnected) editor.focus(); });
    return h('div', { class: 'scratchpad-editor', onkeydown: event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        done();
    } },
    editor,
    h('div', { class: 'scratchpad-editor-actions' },
        iconButton(t`Save`, async () => {
            const text = editor.value.trim();
            if (!text && !message.attachments?.length) return;
            app.editing = '';
            await change(source => api.updateMessage(source, session.id, message.id, text), t`Scratchpad could not save that edit.`);
            renderMessages();
            refocus();
        }, { icon: 'fa-check', primary: true }),
        iconButton(t`Cancel`, done, { icon: 'fa-xmark' })));
}

/* Dictation */

function dictationServiceLabel(id) {
    return {
        local: t`This server (Whisper, no key needed)`,
        openai: t`OpenAI`,
        groq: t`Groq`,
        mistral: t`Mistral`,
    }[id];
}

function dictationProblem(error) {
    const service = dictationServiceLabel(dictationService(app.dictation).id);
    switch (error instanceof DictationError ? error.code : '') {
        case 'unsupported': return t`This browser cannot record from the microphone here.`;
        case 'microphone': return t`The microphone could not be used. Allow microphone access for this site, then try again.`;
        case 'audio': return t`That recording could not be read. Try again.`;
        case 'key': return t`No API key is saved for ${service}. Add one in API Connections, or pick another service under Context → Setup → Dictation and voice.`;
        case 'empty': return t`No speech was heard. Try again, a little closer to the microphone.`;
        default: return t`${service} could not transcribe that recording. Try again, or pick another service under Context → Setup → Dictation and voice.`;
    }
}

function renderDictate(disabled) {
    const button = app.el.dictate;
    if (!button) return;
    const state = app.dictating?.state ?? 'idle';
    const label = state === 'recording' ? t`Stop and transcribe` : state === 'transcribing' ? t`Transcribing…` : t`Dictate`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-pressed', String(state === 'recording'));
    button.classList.toggle('is-busy', state === 'transcribing');
    button.querySelector('i').className = `fa-solid ${state === 'recording' ? 'fa-stop' : state === 'transcribing' ? 'fa-spinner' : 'fa-microphone-lines'}`;
    button.disabled = state === 'transcribing' || state === 'starting' || (state === 'idle' && disabled);
}

function cancelDictation() {
    const dictating = app.dictating;
    if (!dictating) return;
    app.dictating = null;
    dictating.recorder?.cancel();
    dictating.abort.abort();
    if (app.el.dictate) renderDictate(app.el.composer.disabled);
}

async function finishDictation(dictating) {
    if (app.dictating !== dictating || dictating.state !== 'recording') return;
    dictating.state = 'transcribing';
    renderDictate(false);
    try {
        const text = await transcribeWav(await recordingToWav(await dictating.recorder.stop()), app.dictation, { signal: dictating.abort.signal });
        if (app.dictating !== dictating) return;
        const composer = app.el.composer;
        const before = composer.value;
        composer.value = before && !/\s$/.test(before) ? `${before} ${text}` : `${before}${text}`;
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.focus();
        composer.setSelectionRange(composer.value.length, composer.value.length);
    } catch (error) {
        if (app.dictating !== dictating) return;
        console.warn('[Scratchpad] Dictation failed', error);
        toastr.warning(dictationProblem(error), t`Dictation`);
    } finally {
        if (app.dictating === dictating) {
            app.dictating = null;
            renderDictate(app.el.composer.disabled);
            if (document.activeElement === document.body) app.el.dictate.focus();
        }
    }
}

async function toggleDictation() {
    if (app.dictating) return finishDictation(app.dictating);
    endTalk();
    const dictating = { state: 'starting', recorder: null, abort: new AbortController() };
    app.dictating = dictating;
    app.el.dictate.disabled = true;
    try {
        const recorder = await startRecording({ onLimit: () => {
            toastr.info(t`Dictation stops after ${MAX_DICTATION_SECONDS / 60} minutes, so this recording is being transcribed now.`, t`Dictation`);
            void finishDictation(dictating);
        } });
        if (app.dictating !== dictating) return recorder.cancel();
        dictating.recorder = recorder;
        dictating.state = 'recording';
    } catch (error) {
        if (app.dictating !== dictating) return;
        app.dictating = null;
        console.warn('[Scratchpad] Dictation could not start', error);
        toastr.warning(dictationProblem(error), t`Dictation`);
    }
    renderDictate(app.el.composer.disabled);
    app.el.dictate.focus();
}

function renderDictationSettings() {
    if (!app.el.dictate) return null;
    const select = h('select', { id: 'scratchpad-dictation-service', class: 'text_pole', onchange: () => {
        app.dictation = dictationService(select.value).id;
        refreshContextLive();
        writePrefs();
    } }, DICTATION_SERVICES.map(service => h('option', { value: service.id, text: dictationServiceLabel(service.id) })));
    select.value = app.dictation;
    return h('section', { class: 'scratchpad-section scratchpad-dictation' },
        h('h3', { class: 'scratchpad-section-title', text: t`Dictation` }),
        h('p', { class: 'scratchpad-muted', text: t`The microphone button beside Send records you, and the service below turns the recording into text in the message box. Nothing is sent until you press Send.` }),
        h('div', { class: 'scratchpad-field' },
            h('label', { for: 'scratchpad-dictation-service', text: t`Transcription service` }), select),
        h('p', { class: 'scratchpad-muted', text: t`This server needs no key, but it is slow the first time while it fetches its speech model. The others use the API key saved for that service, and your recording is sent to them.` }),
        renderTalkSettings());
}

/* Talk mode */

function talkPauseLabel(id) {
    return {
        short: t`Short (1.0 s)`,
        normal: t`Normal (1.6 s)`,
        patient: t`Patient (2.5 s)`,
    }[id];
}

function renderTalkSettings() {
    if (!app.el.talk) return null;
    const select = h('select', { id: 'scratchpad-talk-pause', class: 'text_pole', onchange: () => {
        app.talkPause = talkPause(select.value).id;
        writePrefs();
    } }, TALK_PAUSES.map(pause => h('option', { value: pause.id, text: talkPauseLabel(pause.id) })));
    select.value = app.talkPause;
    return [
        h('div', { class: 'scratchpad-field' },
            h('label', { for: 'scratchpad-talk-pause', text: t`Talk mode pause` }), select),
        h('p', { class: 'scratchpad-muted', text: t`Talk mode sends your turn after this much quiet. It uses the same transcription service, and reads replies aloud with Text to Speech.` }),
    ];
}

function buildTalkBar() {
    const el = app.el;
    el.talkStatus = h('span', { class: 'scratchpad-talk-status', role: 'status', 'aria-live': 'polite' });
    el.talkLevel = h('span', { class: 'scratchpad-talk-level-fill' });
    el.talkMeter = h('span', { class: 'scratchpad-talk-level', role: 'meter', 'aria-label': t`Microphone level`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, el.talkLevel);
    el.talkSendNow = iconButton(t`Send now`, () => app.talk?.controller.sendNow(), { icon: 'fa-paper-plane', className: 'scratchpad-talk-send', primary: true });
    el.talkInterrupt = iconButton(t`Interrupt`, () => app.talk?.controller.interrupt(), { icon: 'fa-hand', className: 'scratchpad-talk-interrupt', primary: true });
    el.talkEnd = iconButton(t`End talk`, () => endTalk(), { icon: 'fa-stop', className: 'scratchpad-talk-end' });
    return h('div', { class: 'scratchpad-talk', role: 'group', 'aria-label': t`Talk mode`, hidden: true },
        h('div', { class: 'scratchpad-talk-info' }, el.talkStatus, el.talkMeter),
        h('div', { class: 'scratchpad-talk-actions' }, el.talkSendNow, el.talkInterrupt, el.talkEnd));
}

function talkStateLabel({ state, hearing }) {
    if (state === 'listening') return hearing ? t`Hearing you…` : t`Listening…`;
    if (state === 'transcribing') return t`Transcribing…`;
    if (state === 'speaking') return t`Speaking…`;
    return t`Waiting for reply…`;
}

function renderTalk() {
    const el = app.el;
    if (!el.talk) return;
    const snapshot = app.talk?.controller.snapshot() ?? { state: 'idle', hearing: false, active: false };
    el.talk.setAttribute('aria-pressed', String(snapshot.active));
    el.talk.disabled = !snapshot.active && el.composer.disabled;
    el.talkBar.hidden = !snapshot.active;
    el.talkBar.dataset.state = snapshot.state;
    el.talkBar.dataset.hearing = String(snapshot.state === 'listening' && snapshot.hearing);
    if (!snapshot.active) {
        el.talkStatus.textContent = '';
        setTalkLevel(0);
        return;
    }
    const label = talkStateLabel(snapshot);
    if (el.talkStatus.textContent !== label) el.talkStatus.textContent = label;
    el.talkSendNow.hidden = snapshot.state !== 'listening';
    el.talkInterrupt.hidden = snapshot.state !== 'speaking';
    el.talkMeter.hidden = snapshot.state !== 'listening';
}

function setTalkLevel(level) {
    const el = app.el;
    if (!el.talkLevel) return;
    // Speech sits well below full scale, so a quarter of it already fills the bar.
    const value = Math.round(Math.min(1, Math.max(0, Number(level) || 0) / 0.25) * 100);
    if (el.talkMeter.getAttribute('aria-valuenow') === String(value)) return;
    el.talkMeter.setAttribute('aria-valuenow', String(value));
    el.talkLevel.style.setProperty('--scratchpad-talk-level', String(value / 100));
}

/** Whether the chat is free for the next spoken turn: no reply running, nothing being sent and no queued follow-up waiting to go. */
function talkReady() {
    const followUps = activeFollowUps();
    return Boolean(app.source && app.bucket) && !app.sending && !app.swiping && !pendingReply() && (!followUps.items.length || Boolean(followUps.held));
}

function waitForTalk(check, signal) {
    return new Promise(resolve => {
        if (signal.aborted || check()) return resolve();
        const timer = setInterval(() => {
            if (!signal.aborted && !check()) return;
            clearInterval(timer);
            resolve();
        }, 250);
        signal.addEventListener('abort', () => {
            clearInterval(timer);
            resolve();
        }, { once: true });
    });
}

function talkProblem(message) {
    return Object.assign(new Error(message), { talkMessage: message });
}

// The replies to one spoken turn, once every one of them has finished.
function talkReplies(session, userId) {
    const messages = session?.messages ?? [];
    const start = messages.findIndex(item => item.id === userId);
    if (start < 0) return null;
    const after = messages.slice(start + 1);
    const next = after.findIndex(item => item.role === 'user');
    const replies = (next < 0 ? after : after.slice(0, next)).filter(item => item.role === 'assistant');
    return !replies.length || replies.some(item => item.state === 'pending') ? null : replies;
}

async function sendTalkTurn(text, { signal }) {
    await waitForTalk(talkReady, signal);
    if (signal.aborted) return [];
    const seen = new Set((activeSession()?.messages ?? []).map(item => item.id));
    if (!await send({ followUp: text })) throw Object.assign(new Error('Talk mode could not send its turn'), { reported: true });
    const userId = activeSession()?.messages.find(item => item.role === 'user' && !seen.has(item.id))?.id;
    if (!userId) return [];
    let replies = null;
    await waitForTalk(() => Boolean(replies = talkReplies(activeSession(), userId)), signal);
    if (signal.aborted || !replies) return [];
    const finished = replies.filter(item => item.state !== 'failed');
    if (!finished.length && replies.some(item => !/^Stopped\b/.test(String(item.error || '')))) throw talkProblem(t`Talk mode stopped because the reply failed.`);
    const session = activeSession();
    // Only the words are read: change cards stay on screen for you to save or skip yourself.
    return finished.filter(item => spokenText(item.text)).map(message => ({ message, speaker: message.assistantName || assistantInfo(message.assistant, session).name }));
}

async function speakTalkReplies(replies, { signal }) {
    try {
        return await speakReplies(replies, { signal, onChange: () => { if (app.open) renderMessages(); } });
    } catch (error) {
        console.warn('[Scratchpad] Talk mode could not read a reply aloud', error);
        throw talkProblem(t`That reply could not be read aloud. Check the text to speech settings.`);
    }
}

function onTalkEnd(talk, reason, error) {
    if (app.talk === talk) app.talk = null;
    document.removeEventListener('keydown', talk.onKey, true);
    renderTalk();
    if (reason === 'no-speech') toastr.info(t`Stopped talk mode because no speech was heard.`, t`Talk mode`);
    else if (reason === 'context') toastr.info(t`Talk mode ended because the chat changed.`, t`Talk mode`);
    else if (reason === 'error' && !error?.reported) {
        console.warn('[Scratchpad] Talk mode stopped', error);
        toastr.warning(error instanceof DictationError ? dictationProblem(error) : error?.talkMessage || t`Talk mode stopped because something went wrong.`, t`Talk mode`);
    }
}

function startTalk() {
    if (app.talk || !app.el.talk || app.el.composer.disabled) return;
    cancelDictation();
    stopReadAloud();
    const talk = { controller: null, sessionId: activeSession()?.id ?? null, onKey: null };
    talk.onKey = event => {
        if (event.key !== 'Escape' || app.talk !== talk || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        endTalk();
    };
    talk.controller = createTalkMode({
        record: options => startRecording(options),
        toWav: recordingToWav,
        transcribe: (wav, { signal }) => transcribeWav(wav, app.dictation, { signal }),
        waitUntilReady: ({ signal }) => waitForTalk(talkReady, signal),
        sendTurn: sendTalkTurn,
        canSpeak: canReadAloud,
        speak: speakTalkReplies,
        stopSpeaking: stopReadAloud,
        createAudioContext,
        monitor: monitorStream,
        pauseMs: () => talkPause(app.talkPause).ms,
        onChange: () => { if (app.talk === talk) renderTalk(); },
        onLevel: level => { if (app.talk === talk) setTalkLevel(level); },
        onNotice: code => { if (code === 'tts-off') toastr.info(t`Text to speech is off, so replies will appear as text.`, t`Talk mode`); },
        onEnd: (reason, error) => onTalkEnd(talk, reason, error),
    });
    app.talk = talk;
    document.addEventListener('keydown', talk.onKey, true);
    // Started inside the click, so the browser lets the audio context run.
    talk.controller.start();
    renderTalk();
}

/** Ends talk mode, if it is on: the microphone and any voice stop at once. */
function endTalk(reason = 'ended') {
    return app.talk?.controller.end(reason) ?? false;
}

function toggleTalk() {
    if (app.talk) endTalk();
    else startTalk();
}

// Talk mode belongs to the session it started in; another session or context ends it.
function checkTalkSession() {
    const talk = app.talk;
    if (!talk) return;
    const id = activeSession()?.id ?? null;
    if (talk.sessionId === null) talk.sessionId = id;
    else if (id !== talk.sessionId) endTalk('context');
}

function renderComposer() {
    syncDraft();
    fitComposer();
    const el = app.el;
    const pending = pendingReply();
    for (const button of app.el.messages.querySelectorAll('.scratchpad-reply-swipes button')) {
        button.disabled = button.dataset.unavailable === 'true' || app.sending || app.swiping || Boolean(pending) || Boolean(app.editing);
    }
    const readingFiles = app.readingFiles.has(app.attachments);
    const disabled = !app.source || !app.bucket || app.sending || app.swiping || readingFiles;
    el.composer.disabled = !app.source || !app.bucket;
    el.send.disabled = disabled && !pending;
    renderSendButton(pending);
    setWebSearchToggle(el.webSearch, { enabled: currentSettings().webSearch === true, configured: app.webSearch?.readiness?.configured === true });
    el.webSearch.disabled = !app.source || !app.bucket || app.sending || Boolean(pending);
    el.plus.disabled = disabled;
    for (const button of el.messages.querySelectorAll('.scratchpad-discuss')) button.disabled = disabled || Boolean(pending) || Boolean(app.editing);
    for (const button of el.messages.querySelectorAll('.scratchpad-change-try')) {
        button.disabled = app.sending || Boolean(pending) || busyChanges.has(button.closest('.scratchpad-change')?.dataset.changeKey);
    }
    syncReviewTryButtons();
    const readLinks = currentSettings().readLinks === true;
    el.readLinks.setAttribute('aria-pressed', String(readLinks));
    el.readLinks.classList.toggle('menu_button_primary', readLinks);
    el.readLinks.title = readLinks ? t`Reading linked pages is on for this session` : t`Read the web pages linked in this message`;
    el.readLinks.disabled = !app.source || !app.bucket || app.sending || Boolean(pending);
    el.plus.classList.toggle('menu_button_primary', currentSettings().webSearch === true || readLinks);
    el.attach.disabled = disabled;
    el.rehearse.hidden = !canRehearse(app.source);
    el.rehearse.disabled = disabled || Boolean(pending) || Boolean(app.editing);
    renderDictate(el.composer.disabled);
    renderTalk();
    clear(el.attachments);
    append(el.attachments, renderAttachments(app.attachments, { draft: true }));
    el.attachments.hidden = !app.attachments.length;
    el.fileStatus.hidden = !readingFiles && !app.attachments.length;
    el.fileStatus.textContent = readingFiles ? t`Reading files...` : t`PDFs share extracted text. Images are resized and need an image-capable model.`;
    for (const chip of el.quick.querySelectorAll('button:not(.scratchpad-chip-edit)')) chip.disabled = !app.source;
    renderFollowUps();
}

// While a reply is still being written, a typed draft turns Stop into Queue follow-up.
function canQueueFollowUp(pending = pendingReply()) {
    if (!pending || app.el.composer.disabled || app.readingFiles.has(app.attachments)) return false;
    return Boolean(app.el.composer.value.trim() || app.attachments.length);
}

function renderSendButton(pending = pendingReply()) {
    const el = app.el;
    const count = randomReplyEnabled() ? 1 : sessionAssistants().length;
    const queue = canQueueFollowUp(pending);
    const sendLabel = queue ? t`Queue follow-up`
        : pending ? ((activeSession()?.settings.roundTable && !randomReplyEnabled()) || comparingPending(activeSession()?.messages) ? t`Stop all` : t`Stop`)
            : (app.sending ? t`Sending...` : count > 1 || randomReplyEnabled() ? t`Ask ${count}` : t`Send`);
    el.send.setAttribute('aria-label', sendLabel);
    el.send.title = sendLabel;
    el.send.querySelector('i').className = `fa-solid ${queue ? 'fa-clock' : pending ? 'fa-stop' : 'fa-paper-plane'}`;
}

function onComposerInput() {
    fitComposer();
    renderSendButton();
}

/* Context tab */

function connectionProfiles() {
    const profiles = extension_settings.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles.filter(item => item?.id) : [];
}

function connectionChoiceLabel(connection) {
    if (connection?.kind === 'profile') {
        const profile = connectionProfiles().find(item => item.id === connection.profileId);
        return profile ? (profile.name || profile.id) : t`Unavailable profile: ${connection.profileId}`;
    }
    return app.source?.kind === 'general' ? t`Current connection` : t`Same connection as the chat`;
}

/** The second connection this session compares on, or null when comparing is off or Round Table is on. */
function sessionCompareConnection(settings = currentSettings()) {
    return activeCompareConnection(settings);
}

function compareBadge(session, settings = currentSettings()) {
    const compare = sessionCompareConnection(settings);
    if (!compare) return null;
    const main = connectionChoiceLabel(assistantConnection(settings, session?.assistant ?? app.assistant));
    return h('span', { class: 'scratchpad-badge scratchpad-compare-badge', text: t`Compare: 2 connections`,
        title: [main, connectionChoiceLabel(compare)].join(' vs ') });
}

function renderCompareConnectionField(settings, profiles, general) {
    const id = 'scratchpad-compare-connection';
    const value = compareChoiceValue(settings.compareConnection ?? null);
    const assistant = assistantInfo(activeSession()?.assistant ?? app.assistant);
    const select = h('select', {
        class: 'text_pole', id, disabled: settings.roundTable === true,
        onchange: event => void updateSettings({ compareConnection: compareConnectionFromChoice(event.currentTarget.value) }, { rerenderContext: true }),
    }, h('option', { value: '', text: t`Off` }),
    h('option', { value: CURRENT_CONNECTION_CHOICE, text: general ? t`Current connection` : t`Same connection as the chat` }),
    profiles.map(profile => h('option', { value: profile.id, text: [profile.name || profile.id, profile.model].filter(Boolean).join(' · ') })));
    if (value && value !== CURRENT_CONNECTION_CHOICE && !profiles.some(profile => profile.id === value)) {
        select.append(h('option', { value, text: t`Unavailable profile: ${value}` }));
    }
    select.value = value;
    const same = !settings.roundTable && sameCompareTarget(assistantConnection(settings, assistant.id), settings.compareConnection, sourceConnectionProfile(app.source));
    return h('div', { class: 'scratchpad-field scratchpad-compare-field' },
        h('label', { for: id, text: t`Compare with a second connection` }),
        select,
        h('small', { text: t`Each message gets two replies from ${assistant.name}, one from each connection, so you can keep the better one.` }),
        settings.roundTable ? h('p', { class: 'scratchpad-muted scratchpad-compare-note', text: t`Turn off Round Table to compare one assistant on two connections.` }) : null,
        same ? h('p', { class: 'scratchpad-compare-warning', role: 'status', text: t`Choose a different connection from ${assistant.name}'s main connection.` }) : null);
}

function checkbox(label, checked, onChange, hint = '') {
    const input = h('input', { type: 'checkbox', checked, 'data-context-control': label, onchange: event => onChange(event.currentTarget.checked) });
    return h('label', { class: 'scratchpad-check' }, input, h('span', { text: label }), hint ? h('small', { text: hint }) : null);
}

let instructionsEditorOpen = false;

async function editUserInstructions() {
    if (instructionsEditorOpen) return;
    instructionsEditorOpen = true;
    const owner = getCurrentUserHandle();
    const checkAccount = () => {
        if (getCurrentUserHandle() !== owner) throw new Error(t`The account changed. Reopen the editor.`);
    };
    try {
        const { instructions } = await api.readInstructions();
        checkAccount();
        const selected = new Set(instructions.assistants);
        const editor = h('textarea', { id: 'scratchpad-user-instructions', class: 'text_pole scratchpad-review-editor', rows: '8', value: instructions.text });
        const initialText = editor.value;
        const choices = h('div', { role: 'group', 'aria-label': t`Selected assistants` }, allAssistants().map(assistant =>
            checkbox(assistant.name, selected.has(assistant.id), checked => checked ? selected.add(assistant.id) : selected.delete(assistant.id))));
        choices.hidden = instructions.scope === 'all';
        const scope = h('select', { id: 'scratchpad-instructions-scope', class: 'text_pole', onchange: () => { choices.hidden = scope.value === 'all'; } },
            h('option', { value: 'all', text: t`All assistants` }), h('option', { value: 'selected', text: t`Selected assistants` }));
        scope.value = instructions.scope;
        const errorText = h('p', { role: 'alert', hidden: true });
        const content = h('div', { class: 'scratchpad-review scratchpad-section' },
            h('h3', { text: t`Global user instructions` }),
            h('p', { class: 'scratchpad-review-hint', text: t`Saved for your account. Applies to future replies in every Scratchpad, including existing sessions and round tables. Added alongside each assistant's prompt.` }),
            h('div', { class: 'scratchpad-field' }, h('label', { for: scope.id, text: t`Apply to` }), scope, choices),
            h('div', { class: 'scratchpad-field' }, h('label', { for: editor.id, text: t`User instructions` }), editor,
                h('small', { text: t`Leave blank to turn off. Replies already in progress keep their original instructions.` })), errorText);
        let saving = false;
        await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
            wide: true, okButton: t`Save instructions`, cancelButton: t`Cancel`,
            onClosing: async popup => {
                if (saving) return false;
                if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
                saving = true;
                errorText.hidden = true;
                try {
                    checkAccount();
                    if (scope.value === 'selected' && !selected.size) throw new Error(t`Choose at least one assistant.`);
                    const text = editor.value === initialText ? instructions.text : editor.value;
                    await api.updateInstructions({ text, scope: scope.value, assistants: [...selected] }, instructions.revision);
                    return true;
                } catch (error) {
                    errorText.textContent = error.message || t`User instructions could not be saved.`;
                    errorText.hidden = false;
                    return false;
                } finally {
                    saving = false;
                }
            },
        });
    } catch (error) {
        reportError(error, t`User instructions could not be loaded.`);
    } finally {
        instructionsEditorOpen = false;
    }
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
        const defaults = await api.readPrompt({ source, sessionId: session.id, assistant: assistant.id, gender: getAssistantGender(assistant.id),
            names: context.names, targets: context.targets, capabilities: { ...context.capabilities, image: app.imageAvailability.image, notebook: true }, participants: sessionAssistants(session), randomReply: randomReplyEnabled() });
        requireScope(source, session.id);
        const editor = h('textarea', { class: 'text_pole scratchpad-review-editor', rows: '16', value: previous ?? defaults.text, 'aria-label': t`Assistant prompt` });
        const initialPrompt = editor.value;
        let reset = false;
        editor.addEventListener('input', () => { reset = false; });
        const content = h('div', { class: 'scratchpad-review' },
            h('h3', { text: t`${assistant.name}'s prompt` }),
            h('p', { text: t`These instructions are saved for this session and inherited by new sessions in this list. App reference is added automatically. The default reflects the current context and round-table selection.` }),
            editor,
            iconButton(t`Reset to default`, () => { editor.value = defaults.text; reset = true; }, { icon: 'fa-rotate-left' }),
            defaults.tone?.text ? h('details', { class: 'scratchpad-tone-prompt' },
                h('summary', { text: t`Added after this prompt for the ${feedbackToneLabel(defaults.tone.id)} feedback tone` }),
                h('p', { text: defaults.tone.text })) : null);
        const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { wide: true, large: true, okButton: t`Save prompt`, cancelButton: t`Cancel` });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;
        requireScope(source, session.id);
        if (activeSession().settings.assistantPrompts?.[assistant.id] !== previous) throw new Error(t`The prompt changed while the editor was open. Open it again.`);
        const useDefault = reset || (previous === undefined && editor.value === initialPrompt);
        const prompt = previous !== undefined && editor.value === initialPrompt ? previous : editor.value;
        await updateSettings({ assistantPrompts: { [assistant.id]: useDefault ? null : prompt } });
    } catch (error) {
        reportError(error, t`The assistant prompt could not be saved.`);
    }
}

function contextKey() {
    const kind = app.source?.kind;
    return JSON.stringify([wireSource(app.source), activeSession()?.id ?? '', currentSettings().notes, kind && kind !== 'notebook' ? currentPresetName() : '']);
}

function liveContextSettings() {
    const settings = currentSettings();
    const patch = app.contextPatch;
    return { ...settings, ...patch, include: { ...settings.include, ...patch.include } };
}

function refreshContextLive() {
    if (!app.contextLive.length) return;
    const settings = liveContextSettings();
    for (const update of app.contextLive) update(settings);
}

/* Shows a change in the summary and badges at once; the saved bucket takes over when the save settles. */
function patchContext(patch, save) {
    app.contextPatch = { ...app.contextPatch, ...patch, include: { ...app.contextPatch.include, ...patch.include } };
    refreshContextLive();
    if (!save) return;
    const settle = () => {
        const current = app.contextPatch;
        const include = { ...current.include };
        for (const name of Object.keys(patch.include ?? {})) if (include[name] === patch.include[name]) delete include[name];
        const next = { ...current, include };
        for (const name of Object.keys(patch)) if (name !== 'include' && next[name] === patch[name]) delete next[name];
        app.contextPatch = next;
        refreshContextLive();
    };
    void Promise.resolve(save()).then(settle, settle);
}

function contextToolNames(kind) {
    return [kind === 'roleplay' ? 'companionNotes' : '', 'agents', 'regex', 'cssSnippets', 'dialogueColors'].filter(Boolean);
}

function countLabel(count, one, many) {
    return count === 1 ? one : many;
}

function contextPillLabels(settings, source = app.source) {
    if (!source) return [];
    const kind = source.kind;
    const include = settings.include ?? {};
    const pills = [];
    if (kind === 'notebook') {
        pills.push(t`Note discussion`);
    } else if (kind === 'general') {
        const books = generalLorebooks(source, settings).length;
        if (books) pills.push(countLabel(books, t`1 lorebook`, t`${books} lorebooks`));
    } else if (settings.picked?.length) {
        pills.push(picksMatchSource(settings, source) ? t`${settings.picked.length} picked` : t`No messages`);
    } else {
        const depth = Number(settings.depth) || 0;
        pills.push(depth ? countLabel(depth, t`1 msg`, t`${depth} msgs`) : t`No messages`);
    }
    if (kind !== 'notebook') {
        if (include.card && (kind !== 'general' || source.avatar)) pills.push(t`Card`);
        if (include.persona) pills.push(t`Persona`);
        if (kind === 'roleplay' && include.authorsNote) pills.push(t`Author's Note`);
        if (kind === 'roleplay' && include.mewmory === true) pills.push(t`Mewmory`);
        if (kind !== 'general' && include.lore) pills.push(t`Lorebooks`);
        if (include.preset) pills.push(t`Preset`);
        if (include.problems === true) pills.push(t`Checks`);
        if ((kind === 'roleplay' || kind === 'conversation') && include.lastPrompt === true) pills.push(t`Last prompt`);
        if (include.appEvidence === true) pills.push(t`Diagnostics`);
        if (include.appSource === true) pills.push(t`Source code`);
        const tools = contextToolNames(kind).filter(name => include[name] === true).length;
        if (tools) pills.push(countLabel(tools, t`1 tool`, t`${tools} tools`));
    }
    const notes = settings.notes?.length ?? 0;
    if (notes) pills.push(countLabel(notes, t`1 note`, t`${notes} notes`));
    if (sessionCompareConnection(settings)) pills.push(t`Compare: 2 connections`);
    return pills;
}

function renderContextPills() {
    const list = h('ul', { class: 'scratchpad-context-pills', 'aria-label': t`Shared with the assistants` });
    const update = settings => {
        list.replaceChildren(...contextPillLabels(settings).map(text => h('li', { class: 'scratchpad-context-pill', text })));
    };
    update(liveContextSettings());
    app.contextLive.push(update);
    return list;
}

/* Remembers a drawer the user opened or closed, so a redraw after a save keeps it as they left it. */
function contextDrawer(id, title, { badge, open = false, className = '' } = {}, ...children) {
    const badgeText = badge ? h('span', { class: 'scratchpad-badge scratchpad-drawer-badge' }) : null;
    const details = h('details', {
        class: ['scratchpad-drawer', className].filter(Boolean).join(' '),
        'data-context-drawer': id,
        open: app.contextDrawers.get(id) ?? open,
    });
    details.append(h('summary', {
        class: 'scratchpad-drawer-summary',
        'data-context-control': `drawer:${id}`,
        onclick: () => { app.contextDrawers.set(id, !details.open); },
    }, h('span', { class: 'scratchpad-drawer-title', text: title }), badgeText));
    append(details, [h('div', { class: 'scratchpad-drawer-body' }, ...children.flat().filter(Boolean))]);
    if (badge) {
        const update = settings => {
            badgeText.textContent = badge(settings);
            badgeText.title = badgeText.textContent;
        };
        update(liveContextSettings());
        app.contextLive.push(update);
    }
    return details;
}

/* Drawers carry the title, so the section inside drops its own heading. */
function untitled(section) {
    section?.querySelector?.(':scope > .scratchpad-section-title')?.remove();
    return section;
}

function chipToggle(label, checked, onChange, hintId = '') {
    return h('label', { class: 'scratchpad-chip-toggle' },
        h('input', {
            type: 'checkbox', checked, 'data-context-control': label, 'aria-describedby': hintId || undefined,
            onchange: event => onChange(event.currentTarget.checked),
        }),
        h('span', { text: label }));
}

function presetChoice({ general, conversation } = {}) {
    const name = currentPresetName();
    return {
        label: name ? t`Current preset: ${name}` : t`Current preset`,
        hint: general ? t`Shares the equipped preset for reference only. This doesn't change your preset or the assistant's instructions.`
            : conversation ? t`Shares the active preset with your account's prompt order, not a character's own order. Off by default.`
                : t`Shared as its own section, apart from the cards, persona and lorebooks. Every module is listed in order and marked on or off.`,
    };
}

function contextSubTabLabel(key) {
    return key === 'replies' ? t`Replies` : key === 'setup' ? t`Setup` : t`Sharing`;
}

function selectContextSubTab(key, { focus = false } = {}) {
    if (!CONTEXT_SUB_TABS.includes(key)) return;
    if (app.contextSubTab !== key) {
        app.contextSubTab = key;
        writePrefs();
    }
    const panel = app.el.panels.context;
    for (const name of CONTEXT_SUB_TABS) {
        const tab = panel.querySelector(`#scratchpad-context-tab-${name}`);
        const pane = panel.querySelector(`#scratchpad-context-pane-${name}`);
        if (tab) {
            tab.setAttribute('aria-selected', String(name === key));
            tab.tabIndex = name === key ? 0 : -1;
        }
        if (pane) pane.hidden = name !== key;
    }
    if (focus) panel.querySelector(`#scratchpad-context-tab-${key}`)?.focus({ preventScroll: true });
    const bar = panel.querySelector('.scratchpad-context-tabs');
    const offset = bar ? bar.getBoundingClientRect().top - panel.getBoundingClientRect().top : 0;
    if (offset < 0) panel.scrollTop += offset;
}

function onContextTabKey(event) {
    const index = CONTEXT_SUB_TABS.indexOf(app.contextSubTab);
    const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: CONTEXT_SUB_TABS.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    selectContextSubTab(CONTEXT_SUB_TABS[(next + CONTEXT_SUB_TABS.length) % CONTEXT_SUB_TABS.length], { focus: true });
}

function renderContextTabs() {
    return h('div', { class: 'scratchpad-context-tabs', role: 'tablist', 'aria-label': t`Context sections`, onkeydown: onContextTabKey },
        CONTEXT_SUB_TABS.map(key => h('button', {
            type: 'button', role: 'tab', class: 'scratchpad-context-tab',
            id: `scratchpad-context-tab-${key}`, 'aria-controls': `scratchpad-context-pane-${key}`,
            'aria-selected': String(key === app.contextSubTab), tabindex: key === app.contextSubTab ? '0' : '-1',
            text: contextSubTabLabel(key),
            onclick: () => selectContextSubTab(key),
        })));
}

function contextPane(key, ...children) {
    const pane = h('div', {
        class: `scratchpad-context-pane scratchpad-context-pane-${key}`, role: 'tabpanel',
        id: `scratchpad-context-pane-${key}`, 'aria-labelledby': `scratchpad-context-tab-${key}`,
    }, ...children.flat().filter(Boolean));
    pane.hidden = key !== app.contextSubTab;
    return pane;
}

function webSearchBadge() {
    const config = app.webSearch?.config;
    const readiness = app.webSearch?.readiness;
    return config && config.provider !== 'off' && readiness?.configured && readiness.provider === config.provider ? t`Ready` : t`Off`;
}

function renderContextSetupPane() {
    const dictation = renderDictationSettings();
    return [
        h('section', { class: 'scratchpad-section' },
            h('h3', { class: 'scratchpad-section-title', text: t`Global user instructions` }),
            h('p', { class: 'scratchpad-muted', text: t`Your preferences across all Scratchpads, for all assistants or just the ones you choose.` }),
            iconButton(t`Edit user instructions`, () => void editUserInstructions(), { icon: 'fa-pen' })),
        contextDrawer('web-search', t`Web search`, { badge: webSearchBadge, open: Boolean(app.webSearch?.error) },
            untitled(renderWebSearchSettings({
                config: app.webSearch?.config ?? null,
                draft: app.webSearchDraft,
                readiness: app.webSearch?.readiness ?? null,
                error: app.webSearch?.error || '',
                saving: app.webSearchSaving,
                onSave: values => void saveWebSearchSettings(values),
                onRefresh: () => void refreshWebSearchConfig({ quiet: false }),
                onDraft: draft => { app.webSearchDraft = draft; },
            }))),
        dictation ? contextDrawer('dictation', t`Dictation and voice`, { badge: () => dictationServiceLabel(app.dictation) }, untitled(dictation)) : null,
    ];
}

function renderContext({ force = true } = {}) {
    const panel = app.el.panels.context;
    const key = contextKey();
    if (!force && key === app.contextKey && panel.childElementCount) return;
    app.contextKey = key;
    const scrollTop = panel.scrollTop;
    const active = document.activeElement;
    const selector = !panel.contains(active) ? '' : active.id ? `#${CSS.escape(active.id)}` : active.dataset.contextControl
        ? `[data-context-control="${CSS.escape(active.dataset.contextControl)}"]` : '';
    let renderedScrollTop = 0;
    const restore = (afterLore = false) => {
        if (afterLore && panel.scrollTop !== renderedScrollTop) return;
        if (selector && document.activeElement === document.body && !panel.hidden) {
            panel.querySelector(selector)?.focus({ preventScroll: true });
        }
        panel.scrollTop = scrollTop;
        renderedScrollTop = panel.scrollTop;
    };
    clear(panel);
    app.contextLive = [];
    app.contextPatch = {};
    if (!app.source) {
        const empty = () => h('p', { class: 'scratchpad-empty', text: t`Open a chat to choose what Scratchpad reads.` });
        panel.append(renderContextTabs(), contextPane('sharing', empty()), contextPane('replies', empty()), contextPane('setup', renderContextSetupPane()));
        restore();
        return;
    }
    const settings = currentSettings();
    const session = activeSession();
    const limits = app.bucket?.limits ?? { depth: 200, maxTokens: 32000 };
    const kind = app.source.kind;
    const roleplay = kind === 'roleplay';
    const notebook = kind === 'notebook';
    const general = kind === 'general';

    const depth = h('input', {
        type: 'number', class: 'text_pole', min: '0', max: String(limits.depth), step: '1', value: String(settings.depth),
        id: 'scratchpad-depth',
        oninput: event => {
            const value = Number(event.currentTarget.value);
            if (event.currentTarget.value !== '' && Number.isInteger(value) && value >= 0) patchContext({ depth: value });
        },
        onchange: event => {
            void saveNumberSetting(event.currentTarget, 'depth').finally(() => {
                delete app.contextPatch.depth;
                refreshContextLive();
            });
        },
    });
    const maxTokens = h('input', {
        type: 'number', class: 'text_pole', min: '64', max: String(limits.maxTokens), step: '64', value: String(settings.maxTokens),
        id: 'scratchpad-max-tokens',
        onchange: event => void saveNumberSetting(event.currentTarget, 'maxTokens'),
    });
    const profiles = connectionProfiles();
    const connectionField = assistant => {
        const id = `scratchpad-connection-${assistant.id}`;
        const selected = assistantConnection(settings, assistant.id);
        const value = selected.kind === 'profile' ? selected.profileId : '';
        const connection = h('select', {
            class: 'text_pole', id,
            onchange: event => {
                const profileId = event.currentTarget.value;
                app.connections[assistant.id] = profileId ? { kind: 'profile', profileId } : { kind: 'current' };
                writePrefs();
                void updateSettings({ assistantConnections: { [assistant.id]: profileId ? { kind: 'profile', profileId } : { kind: 'current' } } },
                    { rerenderContext: Boolean(settings.compareConnection) });
            },
        }, h('option', { value: '', text: general ? t`Current connection` : t`Same connection as the chat` }),
        profiles.map(profile => h('option', { value: profile.id, text: [profile.name || profile.id, profile.model].filter(Boolean).join(' · ') })));
        if (value && !profiles.some(profile => profile.id === value)) {
            connection.append(h('option', { value, text: t`Unavailable profile: ${value}` }));
        }
        connection.value = value;
        return h('div', { class: 'scratchpad-assistant-setup' },
            h('div', { class: 'scratchpad-field' }, h('label', { for: id, text: t`${assistant.name}'s connection` }), connection),
            iconButton(t`View or edit ${assistant.name}'s prompt`, () => void editAssistantPrompt(assistant), { icon: 'fa-pen' }));
    };
    const compareField = renderCompareConnectionField(settings, profiles, general);

    const include = settings.include;
    const setInclude = (name, value) => patchContext({ include: { [name]: value } }, () => updateSettings({ include: { [name]: value } }));
    const rows = (...items) => items.filter(Boolean);

    const summaryNotice = notebook
        ? h('p', { class: 'scratchpad-muted scratchpad-context-notice', text: t`This Scratchpad belongs to the note, not the open chat. Story messages, characters, your persona and lorebooks are not included.` })
        : null;
    panel.append(renderPreview({ notice: summaryNotice, pills: renderContextPills() }));

    const picksMatch = picksMatchSource(settings, app.source);
    const messages = general ? renderGeneralLorebooks(settings) : notebook ? null : h('section', { class: 'scratchpad-section scratchpad-context-messages' },
        h('h3', { class: 'scratchpad-section-title', text: t`Chat messages` }),
        h('div', { class: 'scratchpad-field scratchpad-depth-field' },
            h('label', { for: 'scratchpad-depth', text: t`Recent messages to read` }),
            depth,
            h('small', { text: settings.picked.length ? t`Ignored while you have picked messages below.` : t`Use 0 to share no messages.` })),
        h('div', { class: 'scratchpad-chip-row' }, chipToggle(t`Include hidden messages`, include.hidden, value => setInclude('hidden', value))),
        !picksMatch && settings.picked.length
            ? h('p', { class: 'scratchpad-muted scratchpad-picks-warning', role: 'status', text: t`These picks belong to another chat. Clear them or pick messages here.` }) : null,
        contextDrawer('picks', t`Pick specific messages and swipes`, {
            badge: live => !live.picked?.length ? t`Using recent` : picksMatchSource(live, app.source) ? t`${live.picked.length} picked` : t`Another chat`,
            open: settings.picked.length > 0,
        }, untitled(renderPicks(settings))));

    const preset = presetChoice({ general, conversation: kind === 'conversation' });
    const storyHints = rows(
        roleplay ? { id: 'scratchpad-chip-hint-mewmory', label: t`Mewmory`, hint: t`Reads saved memories from this Roleplay chat on the server. Pinned memories come first, followed by recent ones; unavailable or excluded memories are left out.` } : null,
        general ? null : { id: 'scratchpad-chip-hint-lore', label: t`Lorebook entries`, hint: t`Entries are shared when their keywords appear, or when you set them to Always below.` },
        { id: 'scratchpad-chip-hint-preset', label: preset.label, hint: preset.hint });
    const showLore = !notebook && !(general && !generalLorebooks(app.source, settings).length);
    const story = notebook ? null : h('section', { class: 'scratchpad-section scratchpad-context-story' },
        h('h3', { class: 'scratchpad-section-title', text: t`Story and lore` }),
        h('div', { class: 'scratchpad-chip-row', role: 'group', 'aria-label': t`Story and lore` }, rows(
            !general || app.source.avatar ? chipToggle(t`Character cards`, include.card, value => setInclude('card', value)) : null,
            chipToggle(t`Your persona and Scenario Notes`, include.persona, value => setInclude('persona', value)),
            roleplay ? chipToggle(t`Author's Note`, include.authorsNote, value => setInclude('authorsNote', value)) : null,
            roleplay ? chipToggle(t`Mewmory`, include.mewmory === true, value => setInclude('mewmory', value), 'scratchpad-chip-hint-mewmory') : null,
            general ? null : chipToggle(t`Lorebook entries`, include.lore, value => setInclude('lore', value), 'scratchpad-chip-hint-lore'),
            chipToggle(preset.label, include.preset, value => setInclude('preset', value), 'scratchpad-chip-hint-preset'))),
        h('ul', { class: 'scratchpad-chip-hints' }, storyHints.map(({ id, label, hint }) => h('li', { id }, h('strong', { text: label }), ' ', h('span', { text: hint })))),
        showLore ? contextDrawer('lore', t`Lorebook entries`, {
            badge: live => {
                const count = Object.keys(live.loreOverrides ?? {}).length;
                return count ? countLabel(count, t`1 override`, t`${count} overrides`) : t`Auto`;
            },
            open: Object.keys(settings.loreOverrides ?? {}).length > 0,
        }, untitled(renderLore(settings, () => restore(true)))) : null);

    const notes = contextDrawer('notes', t`Saved notes`, {
        badge: live => {
            const count = live.notes?.length ?? 0;
            return count ? countLabel(count, t`1 note`, t`${count} notes`) : t`None`;
        },
        open: (settings.notes?.length ?? 0) > 0,
    }, untitled(renderNotes(settings)));

    const diagnostics = notebook ? null : h('section', { class: 'scratchpad-section scratchpad-context-diagnostics' },
        h('h3', { class: 'scratchpad-section-title', text: t`Diagnostics` }),
        checkbox(t`Problem checks`, include.problems === true, value => setInclude('problems', value),
            t`Checks shared cards, presets and lorebooks for likely problems, and shares fuller activation and sampler details.`),
        roleplay || kind === 'conversation' ? checkbox(t`Last prompt sent`, include.lastPrompt === true, value => setInclude('lastPrompt', value),
            t`Shares the exact prompt last sent to the model for this chat, with keys, passwords and hidden lorebook entries removed.`) : null,
        checkbox(t`App diagnostics`, include.appEvidence === true, value => setInclude('appEvidence', value),
            t`Shares Neconyan's recent errors, failed model requests and your failed requests and jobs, so the assistant can explain what went wrong. Admins also share server crash reports and error log lines.`),
        checkbox(t`Neconyan source code`, include.appSource === true, value => setInclude('appSource', value),
            t`Before replying, the server looks up the parts of Neconyan's own code (public/scripts, public/script.js and src) that match your question and the app diagnostics, read-only. Your config, secrets and data folder are never read, and the assistant can't change Neconyan's code.`));

    const toolNames = contextToolNames(kind);
    const tools = notebook ? null : contextDrawer('tools', t`Tools and styling`, {
        badge: live => {
            const count = toolNames.filter(name => live.include?.[name] === true).length;
            return t`${count} shared`;
        },
        open: toolNames.some(name => include[name] === true),
    }, rows(
        roleplay ? checkbox(t`Companion notes`, include.companionNotes === true, value => setInclude('companionNotes', value), t`Shares the finished notes Companion agents wrote on the shared messages, such as trackers, Plot Compass and Memory Shards. Notes on hidden messages are shared only when their Companion keeps them in chat history.`) : null,
        checkbox(t`Agents`, include.agents === true, value => setInclude('agents', value), t`Shares the name, description and prompt of every saved Agent, so an assistant can suggest edits to them.`),
        checkbox(t`Regexes`, include.regex === true, value => setInclude('regex', value), t`Shares the name, Find pattern and replacement of every global regex script, so an assistant can suggest edits to them.`),
        checkbox(t`CSS Snippets`, include.cssSnippets === true, value => setInclude('cssSnippets', value), t`Shares the name and CSS of every saved snippet, so an assistant can suggest edits to them.`),
        checkbox(t`Dialogue Colors`, include.dialogueColors === true, value => setInclude('dialogueColors', value), t`Shares the name and colour of every character in the colour table in use, so an assistant can suggest new colours.`)));

    const activeIds = new Set(settings.roundTable ? settings.participants : [session?.assistant ?? app.assistant]);
    const assistants = allAssistants();
    const replying = assistants.filter(assistant => activeIds.has(assistant.id));
    const others = assistants.filter(assistant => !activeIds.has(assistant.id));
    const customisedIn = live => others.filter(assistant =>
        assistantConnection(live, assistant.id).kind === 'profile' || Boolean(live.assistantPrompts?.[assistant.id])).length;
    const customised = customisedIn(settings);
    const connections = h('section', { class: 'scratchpad-section scratchpad-context-assistants' },
        h('h3', { class: 'scratchpad-section-title', text: t`Assistant connections` }),
        h('p', { class: 'scratchpad-muted', text: t`Choose a saved profile for each assistant. Profiles include the model and connection settings.` }),
        replying.map(connectionField),
        compareField,
        others.length ? contextDrawer('other-assistants', t`Other assistants (${others.length})`, {
            badge: live => {
                const count = customisedIn(live);
                return count ? t`${count} custom` : t`Default`;
            },
            open: customised > 0,
        }, others.map(connectionField)) : null);

    const prefillText = live => (live.prefill || live.partialPrefill) ? t`Active` : t`Empty`;
    const replies = [
        connections,
        renderFeedbackToneSettings(settings),
        h('section', { class: 'scratchpad-section scratchpad-context-length' },
            h('h3', { class: 'scratchpad-section-title', text: t`Length and streaming` }),
            checkbox(t`Stream replies`, settings.stream !== false, value => void updateSettings({ stream: value }),
                t`Show the reply and any thinking as they arrive. Turn off to wait for the finished reply.`),
            h('div', { class: 'scratchpad-field' }, h('label', { for: 'scratchpad-max-tokens', text: t`Longest reply (tokens)` }), maxTokens)),
        contextDrawer('summary', t`Automatic summary`, {
            className: 'scratchpad-summary-settings',
            badge: live => live.autoSummary === true ? t`On` : t`Off`,
            open: settings.autoSummary === true || Boolean(session?.summary),
        },
        checkbox(t`Summarise older discussion`, settings.autoSummary === true,
            value => void updateSettings({ autoSummary: value }, { rerenderContext: true }),
            t`Summarise older discussion when it exceeds 50 messages or the history size limit. Uses the first replying assistant's connection and may make extra model calls. All saved messages and the 400-message limit stay.`),
        session?.summary ? h('details', {},
            h('summary', { text: t`Last saved summary` }),
            h('p', { class: 'scratchpad-muted', text: t`Covers ${session.summary.count} earlier messages. Checked against the conversation before each use; rebuilt if those messages change.` }),
            h('pre', { class: 'scratchpad-preview-text', text: session.summary.text, 'data-i18n-ignore': '' }))
            : h('p', { class: 'scratchpad-muted', text: t`No summary saved yet. Recent messages are kept in full alongside the summary.` })),
        contextDrawer('prefills', t`Reply prefills`, { badge: prefillText, open: Boolean(settings.prefill || settings.partialPrefill) },
            h('p', { class: 'scratchpad-muted', text: t`A prefill starts the assistant's reply for it. The model continues from that text. These settings apply to every assistant in this session, including new reply versions. Leave them empty for normal replies; your connection must support prefills.` }),
            h('div', { class: 'scratchpad-field' },
                h('label', { for: 'scratchpad-prefill', text: t`Reply prefill` }),
                h('textarea', { id: 'scratchpad-prefill', class: 'text_pole', rows: 3, value: settings.prefill || '', placeholder: t`Here are three ideas:`,
                    oninput: event => patchContext({ prefill: event.currentTarget.value }),
                    onchange: event => {
                        const value = event.currentTarget.value;
                        patchContext({ prefill: value }, () => updateSettings({ prefill: value }));
                    } })),
            h('div', { class: 'scratchpad-field' },
                h('label', { for: 'scratchpad-partial-prefill', text: t`Kimi K3 / K3.1 partial prefill` }),
                h('textarea', { id: 'scratchpad-partial-prefill', class: 'text_pole', rows: 4, value: settings.partialPrefill || '', placeholder: '<think>Let me consider the scene carefully.',
                    oninput: event => patchContext({ partialPrefill: event.currentTarget.value }),
                    onchange: event => {
                        const value = event.currentTarget.value;
                        patchContext({ partialPrefill: value }, () => updateSettings({ partialPrefill: value }));
                    } }),
                h('small', { text: t`Used instead of the reply prefill for Kimi K3 and K3.1. Start with <think> to seed thinking; close it with </think> before any visible reply text. An unclosed <think> seeds only thinking and is not added to the saved reply.` }))),
    ];

    panel.append(renderContextTabs(),
        contextPane('sharing', messages, story, notes, diagnostics, tools, renderContextSetups()),
        contextPane('replies', replies),
        contextPane('setup', renderContextSetupPane()));
    restore();
}


function shareGeneralLorebooks(change) {
    return updateSettings(latest => {
        const lorebooks = change(generalLorebooks({ kind: 'general' }, latest)).slice(0, MAX_GENERAL_LOREBOOKS);
        return { lorebooks, lorebook: lorebooks[0] || '' };
    }, { rerenderContext: true });
}

function renderGeneralLorebooks(settings) {
    const shared = generalLorebooks(app.source, settings);
    const known = new Set(world_names || []);
    const available = [...known].filter(name => name && !shared.includes(name));
    const full = shared.length >= MAX_GENERAL_LOREBOOKS;
    const hint = full ? t`${MAX_GENERAL_LOREBOOKS} lorebooks is the most one session can share. Remove one to add another.`
        : available.length ? '' : known.size ? t`Every lorebook is shared.` : t`No lorebooks to share yet.`;
    const picker = h('select', {
        id: 'scratchpad-lorebook',
        class: 'text_pole',
        disabled: full || !available.length,
        'aria-describedby': hint ? 'scratchpad-lorebook-hint' : null,
        onchange: event => {
            const name = event.currentTarget.value;
            event.currentTarget.value = '';
            if (name) void shareGeneralLorebooks(books => books.includes(name) ? books : [...books, name]);
        },
    },
    h('option', { value: '', text: t`Add a lorebook`, selected: true }),
    ...available.map(name => h('option', { value: name, text: name, 'data-i18n-ignore': '' })));
    const remove = async name => {
        await shareGeneralLorebooks(books => books.filter(book => book !== name));
        const panel = app.el.panels.context;
        if (document.activeElement !== document.body || panel.hidden) return;
        const next = panel.querySelector('.scratchpad-shared-lorebook-remove') || panel.querySelector('#scratchpad-lorebook:not(:disabled)');
        next?.focus({ preventScroll: true });
    };
    return h('section', { class: 'scratchpad-section scratchpad-general-lorebooks' },
        h('h3', { class: 'scratchpad-section-title', text: t`General Scratchpad` }),
        h('p', { class: 'scratchpad-muted', text: t`No story chat is open. You can share up to ${MAX_GENERAL_LOREBOOKS} lorebooks here, or tick what else to share below.` }),
        shared.length ? h('ul', { class: 'scratchpad-shared-lorebooks', 'aria-label': t`Shared lorebooks` },
            ...shared.map(name => h('li', { class: 'scratchpad-shared-lorebook' },
                h('span', { class: 'scratchpad-shared-lorebook-text' },
                    h('span', { class: 'scratchpad-shared-lorebook-name', text: name, title: name, 'data-i18n-ignore': '' }),
                    known.has(name) ? null : h('small', { class: 'scratchpad-shared-lorebook-missing', text: t`Not found. It may have been renamed or deleted.` })),
                h('button', {
                    type: 'button',
                    class: 'menu_button scratchpad-button scratchpad-shared-lorebook-remove',
                    'aria-label': t`Remove ${name}`,
                    'data-context-control': `lorebook-remove:${name}`,
                    onclick: () => void remove(name),
                },
                h('i', { class: 'fa-solid fa-xmark', 'aria-hidden': 'true' }),
                h('span', { text: t`Remove` }))))) : null,
        h('div', { class: 'scratchpad-field' },
            h('label', { for: 'scratchpad-lorebook', text: t`Share a lorebook` }),
            picker,
            hint ? h('small', { id: 'scratchpad-lorebook-hint', class: 'scratchpad-shared-lorebooks-limit', text: hint }) : null,
            h('small', { text: t`Shared in this session only. Entries hidden from assistants stay hidden.` })));
}

function renderFeedbackToneSettings(settings) {
    const sharedOption = tone => t`Same as shared (${feedbackToneLabel(tone)})`;
    const overrides = allAssistants().map(assistant => {
        const id = `scratchpad-tone-${assistant.id}`;
        const own = settings.assistantTones?.[assistant.id];
        const select = h('select', {
            id, class: 'text_pole',
            onchange: event => void updateSettings({ assistantTones: { [assistant.id]: event.currentTarget.value || null } }),
        },
        h('option', { value: '', class: 'scratchpad-tone-shared', text: sharedOption(settings.feedbackTone) }),
        FEEDBACK_TONES.map(tone => h('option', { value: tone, text: feedbackToneLabel(tone) })));
        select.value = isFeedbackTone(own) ? own : '';
        return h('div', { class: 'scratchpad-field' }, h('label', { for: id, text: t`${assistant.name}'s tone` }), select);
    });
    const section = h('section', { class: 'scratchpad-section scratchpad-tone-settings' },
        h('h3', { class: 'scratchpad-section-title', text: t`Feedback tone` }),
        h('p', { class: 'scratchpad-muted', text: t`Sets how hard the assistants judge your writing and ideas. Rehearsals and character prose are left alone.` }));
    const shared = feedbackToneSlider({
        id: 'scratchpad-context-tone',
        tone: settings.feedbackTone,
        describe: true,
        onChange: async tone => {
            await updateSettings({ feedbackTone: tone });
            const saved = sharedFeedbackTone();
            shared.setTone(saved);
            for (const option of section.querySelectorAll('.scratchpad-tone-shared')) option.textContent = sharedOption(saved);
        },
    });
    shared.setDisabled(app.sending || Boolean(pendingReply()));
    append(section, [shared,
        h('details', { class: 'scratchpad-tone-overrides-list' },
            h('summary', { text: t`Give one assistant its own tone` }),
            h('p', { class: 'scratchpad-muted', text: t`In a round table, each assistant can judge differently, such as a kind Miso beside an unreasonably critical Taro.` }),
            overrides)]);
    if (allAssistants().some(assistant => isFeedbackTone(settings.assistantTones?.[assistant.id]))) section.querySelector('details').open = true;
    return section;
}

/* Mirrors CONTEXT_SETUP_KEYS on the server: only choices that mean the same in every chat are saved. */
const CONTEXT_SETUP_KEYS = ['depth', 'include', 'maxTokens', 'stream', 'webSearch', 'readLinks', 'prefill', 'partialPrefill', 'feedbackTone', 'compareConnection'];

function findContextSetup(name) {
    const key = String(name ?? '').trim().toLowerCase();
    return app.contextSetups.setups.find(setup => setup.name.toLowerCase() === key);
}

function showContextSetups(focus) {
    if (!app.open) return;
    renderContext();
    app.el.panels.context.querySelector(focus)?.focus({ preventScroll: true });
}

async function writeContextSetups(setups, fallback) {
    try {
        app.contextSetups = (await api.updateContextSetups(setups, app.contextSetups.revision)).contextSetups;
        return true;
    } catch (error) {
        reportError(error, fallback);
        return false;
    }
}

async function saveContextSetup() {
    const settings = structuredClone(currentSettings());
    const typed = await callGenericPopup(`<h3>${t`Name this setup:`}</h3><p>${t`A setup with the same name is replaced.`}</p>`, POPUP_TYPE.INPUT, app.contextSetup || '');
    const name = String(typed ?? '').replace(/\s+/g, ' ').trim();
    if (!typed || !name) return;
    const setup = { name, settings: Object.fromEntries(CONTEXT_SETUP_KEYS.map(key => [key, settings[key]])) };
    const existing = findContextSetup(name);
    const setups = existing
        ? app.contextSetups.setups.map(item => item === existing ? setup : item)
        : [...app.contextSetups.setups, setup];
    if (!await writeContextSetups(setups, t`Scratchpad could not save that setup.`)) return;
    app.contextSetup = findContextSetup(name)?.name ?? '';
    writePrefs();
    toastr.success(t`Setup saved. You can apply it in any Scratchpad session.`);
    showContextSetups('.scratchpad-setup-save');
}

async function applyContextSetup() {
    const setup = findContextSetup(app.contextSetup);
    if (!setup) return;
    try {
        if (!await updateSettings(structuredClone(setup.settings), { rerenderContext: true })) return;
        toastr.success(t`Setup applied to this session.`);
        app.el.panels.context.querySelector('.scratchpad-setup-apply')?.focus({ preventScroll: true });
    } catch { /* updateSettings already reported the failure. */ }
}

async function deleteContextSetup() {
    const setup = findContextSetup(app.contextSetup);
    if (!setup) return;
    const confirmed = await callGenericPopup(t`Delete the saved setup '${escapeHtml(setup.name)}'? Sessions that already use its choices keep them.`, POPUP_TYPE.CONFIRM, '', { okButton: t`Delete setup`, cancelButton: t`Cancel` });
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;
    if (!await writeContextSetups(app.contextSetups.setups.filter(item => item !== setup), t`Scratchpad could not delete that setup.`)) return;
    app.contextSetup = app.contextSetups.setups[0]?.name ?? '';
    writePrefs();
    showContextSetups('.scratchpad-setup-save');
}

function renderContextSetups() {
    const setups = app.contextSetups.setups;
    if (!findContextSetup(app.contextSetup)) app.contextSetup = setups[0]?.name ?? '';
    const select = h('select', {
        class: 'text_pole', id: 'scratchpad-setup', 'data-i18n-ignore': '',
        onchange: event => {
            app.contextSetup = event.currentTarget.value;
            writePrefs();
            if (!activeSession()) showContextSetups('#scratchpad-setup');
        },
    }, setups.map(setup => h('option', { value: setup.name, text: setup.name })));
    select.value = app.contextSetup;
    return h('section', { class: 'scratchpad-section scratchpad-setups' },
        h('h3', { class: 'scratchpad-section-title', text: t`Saved setups` }),
        h('p', { class: 'scratchpad-muted', text: t`The selected setup applies to every new session. Apply setup changes this session. Save current choices keeps how many messages to read, what else to share, reply length, streaming, web search, reading links and prefills. Picked messages, lorebook entry choices, saved notes and connections are not saved.` }),
        setups.length ? h('div', { class: 'scratchpad-field' }, h('label', { for: 'scratchpad-setup', text: t`Saved setup` }), select)
            : h('p', { class: 'scratchpad-muted', text: t`You have no saved setups yet.` }),
        h('div', { class: 'scratchpad-note-actions' },
            setups.length ? iconButton(t`Apply setup`, () => void applyContextSetup(), { icon: 'fa-check', className: 'scratchpad-setup-apply', title: t`Use the chosen setup's choices in this session` }) : null,
            iconButton(t`Save current choices`, () => void saveContextSetup(), { icon: 'fa-floppy-disk', className: 'scratchpad-setup-save', title: t`Save this session's Context choices as a setup` }),
            setups.length ? iconButton(t`Delete setup`, () => void deleteContextSetup(), { icon: 'fa-trash', className: 'scratchpad-setup-delete' }) : null));
}

function renderNotes(settings) {
    const source = app.source;
    const sessionId = activeSession()?.id;
    const isCurrent = () => app.open && isCurrentSource(source) && sameSourceContext(app.source, source) && activeSession()?.id === sessionId;
    const list = h('div', { class: 'scratchpad-notes-list', 'aria-live': 'polite' });
    const section = h('section', { class: 'scratchpad-section scratchpad-notes' },
        h('h3', { class: 'scratchpad-section-title', text: t`Saved notes` }),
        h('p', { class: 'scratchpad-muted', text: t`Add notes or sections for this session. Notebook's AI access still applies. Share private notes or selected text from Notes.` }),
        h('div', { class: 'scratchpad-note-actions' },
            iconButton(t`Add saved note`, async () => {
                app.contextDrawers.set('notes', true);
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
    const removeButton = ref => {
        const same = item => JSON.stringify(item) === JSON.stringify(ref);
        return iconButton(ref.grantId ? t`Stop sharing` : t`Remove`, async () => {
            if (ref.grantId) {
                const { notesRequest } = await import('../notebooks/api.js');
                if (!isCurrent()) return;
                const result = await notesRequest('/assistant/grants/revoke', { grantId: ref.grantId });
                if (result.status !== 'success') { reportError(new Error(result.message), t`Sharing could not be stopped.`); return; }
            }
            if (isCurrent()) await updateSettings(latest => ({ notes: latest.notes.filter(item => ref.grantId ? item.grantId !== ref.grantId : !same(item)) }), { rerenderContext: true });
        }, { icon: 'fa-xmark' });
    };
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
                removeButton(ref));
            if (ref.offset) actions.append(iconButton(t`Previous page`, () => changePage(Math.max(0, ref.offset - 24000)), { icon: 'fa-chevron-left' }));
            if (note.nextOffset !== null && note.nextOffset !== undefined) actions.append(iconButton(t`Next page`, () => changePage(note.nextOffset), { icon: 'fa-chevron-right' }));
            list.append(h('div', { class: `scratchpad-note${note.unavailable ? ' is-unavailable' : ''}` },
                h('div', { class: 'scratchpad-note-heading' }, h('strong', { text: note.title || t`Unavailable note`, 'data-i18n-ignore': '' }), h('span', { class: 'scratchpad-badge', text: access })),
                note.heading ? h('small', { text: note.heading, 'data-i18n-ignore': '' }) : null,
                note.partial ? h('small', { text: t`Page begins at character ${(note.offset || 0) + 1}. This is part of a longer note.` }) : null,
                ref.grantId && !note.unavailable ? h('small', { text: t`Temporary sharing: up to 30 minutes. Stop sharing to prevent future reads; text already sent cannot be withdrawn.` }) : null,
                note.unavailable ? h('p', { class: 'scratchpad-muted', text: t`Access expired, the shared text changed, or the note is unavailable. Share it again from Notes if needed.` }) : null, actions));
        }
    }).catch(error => {
        if (!list.isConnected || !isCurrent()) return;
        // Keep every reference removable even when the notes cannot be read together.
        list.replaceChildren(h('p', { class: 'scratchpad-error', text: error.message }), ...settings.notes.map((ref, index) =>
            h('div', { class: 'scratchpad-note' },
                h('div', { class: 'scratchpad-note-heading' }, h('strong', { text: `${t`Note`} ${index + 1}` })),
                ref.sectionId ? h('small', { text: ref.sectionId, 'data-i18n-ignore': '' }) : null,
                h('div', { class: 'scratchpad-note-actions' },
                    iconButton(t`Open note`, () => void openNotebook(ref).catch(e => reportError(e, t`That note could not open.`)), { icon: 'fa-arrow-up-right-from-square' }),
                    removeButton(ref)))));
    });
    return section;
}

function renderPicks(settings) {
    const section = h('section', { class: 'scratchpad-section' }, h('h3', { class: 'scratchpad-section-title', text: t`Pick specific messages and swipes` }));
    const messages = sourceMessages(app.source);
    const matches = picksMatchSource(settings, app.source);
    const picked = new Set(matches ? settings.picked : []);
    section.append(h('p', { class: 'scratchpad-muted', text: t`Picked messages and swipes replace the recent messages above. Expand Swipes to compare versions without changing the story.` }));
    if (settings.picked.length) {
        section.append(iconButton(t`Clear picks (${settings.picked.length})`, () => void updateSettings({ picked: [] }, { rerenderContext: true }), { icon: 'fa-eraser' }));
    }
    if (!messages.length) {
        section.append(h('p', { class: 'scratchpad-muted', text: t`This chat has no messages yet.` }));
        return section;
    }
    const list = h('ul', { class: 'scratchpad-picks' });
    const latestFirst = [...messages].reverse();
    const choices = messages.flatMap(item => [item, ...(item.swipes ?? [])]);
    const pick = item => {
        const input = h('input', {
            type: 'checkbox',
            'data-context-control': `pick:${item.ref}`,
            'aria-label': item.swipe ? t`Pick message #${item.number}, swipe ${item.swipe}` : t`Pick message #${item.number}`,
            checked: picked.has(item.ref),
            onchange: event => {
                const checked = event.currentTarget.checked;
                void updateSettings(latest => {
                    const next = new Set(picksMatchSource(latest, app.source) ? latest.picked : []);
                    if (checked) {
                        next.add(item.ref);
                        if (item.swipe && item.current) next.delete(item.messageRef);
                        else if (!item.swipe) for (const swipe of item.swipes ?? []) if (swipe.current) next.delete(swipe.ref);
                    } else next.delete(item.ref);
                    return { picked: choices.map(entry => entry.ref).filter(ref => next.has(ref)), pickedSource: wireSource(app.source) };
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
            row.append(h('details', {
                class: 'scratchpad-swipes',
                open: app.openSwipes.has(item.ref) || item.swipes.some(swipe => picked.has(swipe.ref)),
                ontoggle: event => app.openSwipes[event.currentTarget.open ? 'add' : 'delete'](item.ref),
            },
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

function renderLore(settings, onRendered) {
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
        const byBook = new Map(lore.books.map(book => [book, []]));
        for (const entry of lore.entries) {
            if (!byBook.has(entry.world)) byBook.set(entry.world, []);
            byBook.get(entry.world).push(entry);
        }
        for (const book of byBook.keys()) {
            const entries = byBook.get(book);
            const shared = entries.filter(entry => entry.included).length;
            list.append(h('details', {
                class: 'scratchpad-lore-book',
                open: app.openLorebooks.has(book),
                ontoggle: event => app.openLorebooks[event.currentTarget.open ? 'add' : 'delete'](book),
            },
            h('summary', {},
                h('span', { class: 'scratchpad-lore-book-name', text: book, 'data-i18n-ignore': '' }),
                h('span', { class: 'scratchpad-lore-book-count', text: t`${shared} of ${entries.length} shared` })),
            entries.length
                ? h('div', { class: 'scratchpad-lore-book-entries' }, entries.map(renderLoreEntry))
                : h('p', { class: 'scratchpad-muted', text: t`This lorebook has no entries Scratchpad can read.` })));
        }
    }).catch(error => {
        if (!list.isConnected) return;
        clear(list);
        list.append(h('p', { class: 'scratchpad-error', text: error?.message || t`Lorebook entries could not be read.` }));
    }).finally(() => { if (key === app.contextKey && list.isConnected) onRendered(); });
    return section;
}

function renderLoreEntry(entry) {
    const overrides = currentSettings().loreOverrides ?? {};
    const current = overrides[loreOverrideKey(entry)] ?? 'auto';
    const status = entry.included
        ? (entry.reason === 'constant' ? t`Shared: always active` : entry.reason === 'always' ? t`Shared: set to Always` : t`Shared: keyword found`)
        : t`Not shared right now`;
    const title = entry.title || t`Untitled entry`;
    const choices = h('div', { class: 'scratchpad-segment', role: 'group', 'aria-label': t`Share ${title}` });
    for (const [value, label] of [['auto', t`Auto`], ['always', t`Always`], ['never', t`Never`]]) {
        choices.append(h('button', {
            type: 'button',
            class: `scratchpad-segment-choice${value === current ? ' is-selected' : ''}`,
            'data-context-control': `lore:${loreOverrideKey(entry)}:${value}`,
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
            h('strong', { text: title }),
            h('small', { text: status })),
        choices);
}

function renderPreview({ notice = null, pills = null } = {}) {
    const run = async () => {
        const source = app.source;
        const sessionAtClick = activeSession()?.id;
        await app.queue;
        if (!app.open || app.tab !== 'context' || !sameSourceContext(source, app.source)
            || (sessionAtClick && sessionAtClick !== activeSession()?.id)) return;
        // Saving the first setting creates a session and rebuilds the panel.
        const output = app.el.panels.context.querySelector('.scratchpad-preview');
        if (!output) return;
        const loading = h('p', { class: 'scratchpad-muted', text: t`Building the preview...` });
        output.replaceChildren(loading);
        try {
            requireScope(source);
            const sessionId = activeSession()?.id;
            const context = await buildContext({ source, settings: currentSettings(), pendingText: app.el.composer.value, sessionText: sessionText(activeSession()) });
            const notes = await api.readNotebookContext(wireSource(source), sessionId);
            const mewmory = source.kind === 'roleplay' && currentSettings().include.mewmory === true
                ? await api.readMewmoryContext(wireSource(source), sessionId) : null;
            requireScope(source, sessionId);
            const preview = [context.text, notes.text ? `<notebook_context>\n${notes.text}\n</notebook_context>` : '',
                mewmory?.text ? `<mewmory_context>\n${mewmory.text}\n</mewmory_context>` : '', pinnedNoteContext(activeSession()?.pinnedNote)].filter(Boolean).join('\n\n');
            const tokens = await estimateTokens(preview);
            requireScope(source, sessionId);
            if (!output.isConnected || !loading.isConnected) return;
            clear(output);
            append(output, [
                h('p', { class: 'scratchpad-muted', text: t`This is the reference material for your next message. Saved notes and shared Mewmory records are read on the server and checked again when you send.` }),
                h('p', { text: t`About ${tokens} tokens. Chat messages: ${context.messageCount} of ${context.totalMessages}. Lorebook entries: ${context.lore.entries.filter(entry => entry.included).length}.` }),
                context.leftOut ? h('p', { text: t`Older messages left out to fit: ${context.leftOut}. They are not sent at all.` }) : null,
                context.swipeCount ? h('p', { text: t`Swipes shared for comparison: ${context.swipeCount}.` }) : null,
                context.preset ? h('p', { text: t`Preset modules on: ${context.preset.on}. Off: ${context.preset.off}.` }) : null,
                h('p', { text: t`Saved notes or sections: ${notes.notes.filter(note => !note.unavailable).length}.` }),
                mewmory?.enabled ? h('p', { text: t`Mewmory records shared: ${mewmory.count}. Left out to fit: ${mewmory.omitted}.` }) : null,
                context.capabilities?.appSource ? h('p', { class: 'scratchpad-source-preview-note', text: t`Neconyan source code: when you send, the server looks up matching read-only code in public/scripts, public/script.js and src. Config, secrets and user data are never readable.` }) : null,
                h('pre', { class: 'scratchpad-preview-text', text: preview }),
            ]);
        } catch (error) {
            if (!output.isConnected || !loading.isConnected) return;
            clear(output);
            output.append(h('p', { class: 'scratchpad-error', text: error?.message || t`The preview could not be built.` }));
        }
    };
    return h('section', { class: 'scratchpad-section scratchpad-context-summary' },
        h('div', { class: 'scratchpad-context-summary-head' },
            h('h3', { class: 'scratchpad-section-title', text: t`What Scratchpad will read` }),
            iconButton(t`Show preview`, () => void run(), { icon: 'fa-magnifying-glass', className: 'scratchpad-preview-button' })),
        notice,
        pills,
        h('div', { class: 'scratchpad-preview', 'aria-live': 'polite' }));
}

/* Sessions tab */

function sessionMatches(session, query) {
    if (!query) return true;
    const needle = foldSearchText(query);
    return foldSearchText(session.name).includes(needle) || session.messages.some(item => foldSearchText(item.text).includes(needle));
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
    focusSessionAction(scope, session, 'rename');
}

function focusSessionAction(scope, session, action) {
    if (app.open && app.tab === 'sessions' && sameSourceBucket(scope, app.source)) {
        app.el.panels.sessions.querySelector(`[data-session="${CSS.escape(session.id)}"] .scratchpad-session-${action}`)?.focus({ preventScroll: true });
    }
}

async function pinSession(session, pinned) {
    const scope = app.source;
    await change(source => api.updateSession(source, session.id, { pinned }),
        pinned ? t`Scratchpad could not pin that session.` : t`Scratchpad could not unpin that session.`, scope);
    focusSessionAction(scope, session, 'pin');
}

async function clearSessionMessages(session) {
    const scope = app.source;
    const ok = await callGenericPopup(t`Clear every message in '${escapeHtml(session.name)}'? Its context settings stay.`, POPUP_TYPE.CONFIRM, '', { okButton: t`Clear`, cancelButton: t`Keep` });
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
    await change(source => api.clearSession(source, session.id), t`Scratchpad could not clear that session.`, scope);
    focusSessionAction(scope, session, 'clear');
}

async function removeSession(session) {
    const scope = app.source;
    const ok = await callGenericPopup(t`Delete '${escapeHtml(session.name)}'? This cannot be undone. The story is not affected.`, POPUP_TYPE.CONFIRM, '', { okButton: t`Delete`, cancelButton: t`Keep` });
    if (ok !== POPUP_RESULT.AFFIRMATIVE) return;
    await change(source => api.deleteSession(source, session.id), t`Scratchpad could not delete that session.`, scope);
}

async function updateCleanup(patch) {
    const scope = app.source;
    if ('keep' in patch) {
        if (!Number.isFinite(patch.keep) || patch.keep < 1) {
            renderSessions();
            return;
        }
        patch = { ...patch, keep: Math.min(app.bucket?.limits?.sessions ?? 40, Math.round(patch.keep)) };
    }
    const previous = app.bucket?.cleanup ?? { enabled: false, keep: 10 };
    const next = { ...previous, ...patch };
    if (next.enabled && (!previous.enabled || next.keep < previous.keep)) {
        const ok = await callGenericPopup(t`This sets automatic cleanup for your account. Older sessions are deleted from this list now, and from other lists when their Scratchpad is next saved. Open sessions, pinned sessions and replies in progress stay. Deletions cannot be undone.`,
            POPUP_TYPE.CONFIRM, '', { okButton: t`Apply to all session lists`, cancelButton: t`Cancel` });
        if (ok !== POPUP_RESULT.AFFIRMATIVE) {
            renderSessions();
            return;
        }
    }
    await change(source => api.updateCleanup(source, patch), t`Scratchpad could not save that setting.`, scope);
    renderSessions();
}

function renderCleanup() {
    const cleanup = app.bucket?.cleanup ?? { enabled: false, keep: 10 };
    const keep = h('input', {
        type: 'number', class: 'text_pole', id: 'scratchpad-cleanup-keep', min: '1', max: String(app.bucket?.limits?.sessions ?? 40), step: '1',
        value: String(cleanup.keep), disabled: !cleanup.enabled,
        onchange: event => void updateCleanup({ keep: event.currentTarget.value.trim() ? Number(event.currentTarget.value) : NaN }),
    });
    return h('section', { class: 'scratchpad-section scratchpad-cleanup' },
        checkbox(t`Delete old sessions automatically`, cleanup.enabled, value => void updateCleanup({ enabled: value }),
            t`Shared across your account. Keeps the newest sessions per list, including General, and deletes older ones for good when its Scratchpad is saved. The open session, pinned sessions and replies in progress are never deleted.`),
        h('div', { class: 'scratchpad-field' }, h('label', { for: 'scratchpad-cleanup-keep', text: t`Sessions to keep per list` }), keep));
}

let exportOpen = false;

async function exportSession(session) {
    if (exportOpen) return;
    exportOpen = true;
    try {
        const { openSessionPrint } = await import('./pdf-export.js');
        const options = await chooseSessionExport({ onPdf: options => openSessionPrint(session, {
            ...options, nameOf: message => message.assistantName || assistantInfo(message.assistant, session).name,
        }) });
        if (!options) return;
        if (options.format === 'pdf') return;
        const markdown = options.format === 'markdown';
        const text = markdown
            ? sessionMarkdown(session, { ...options, nameOf: message => message.assistantName || assistantInfo(message.assistant, session).name })
            : JSON.stringify(buildSessionExport(session, allAssistants(session), options), null, 2);
        const url = URL.createObjectURL(new Blob([text], { type: markdown ? 'text/markdown' : 'application/json' }));
        const link = h('a', { href: url, download: exportFileName(session.name, markdown ? 'md' : 'json') });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        reportError(error, t`Scratchpad could not export that session.`);
    } finally {
        exportOpen = false;
    }
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
            // The request has a size limit, so a file carrying large attachments is imported without them.
            const tooLarge = new Blob([JSON.stringify(parsed.session)]).size > MAX_IMPORT_BYTES;
            const session = tooLarge ? withoutAttachments(parsed.session) : parsed.session;
            await change(source => api.importSession(source, session), t`Scratchpad could not import that session.`, scope);
            selectTab('chat');
            if (tooLarge) toastr.info(t`That file was too large to import whole, so its attached files and images were left out.`);
        } catch (error) {
            reportError(error, t`That file could not be imported.`);
        }
    });
    document.body.append(input);
    input.click();
}

function listKindLabel(kind) {
    if (kind === 'general') return t`General Scratchpad`;
    if (kind === 'notebook') return t`Note`;
    return kind === 'conversation' ? t`Conversation` : t`Roleplay`;
}

async function searchEveryList() {
    const query = app.sessionQuery.trim();
    if (query.length < 2 || app.everyList.loading) return;
    app.everyList = { query, loading: true, results: [], more: false, error: '' };
    renderSessions();
    try {
        const found = await api.searchSessions(query);
        if (app.everyList.query !== query) return;
        app.everyList = { query, loading: false, results: Array.isArray(found?.results) ? found.results : [], more: found?.more === true, error: '' };
    } catch (error) {
        if (app.everyList.query !== query) return;
        app.everyList = { query, loading: false, results: [], more: false, error: error?.message || t`Scratchpad could not search your other lists.` };
    }
    if (app.open && app.tab === 'sessions') {
        renderSessions();
        app.el.panels.sessions.querySelector('.scratchpad-every-list-button')?.focus();
    }
}

async function copyFoundSession(result) {
    const saved = await change(source => api.copySession(source, result.list, result.sessionId), t`Scratchpad could not copy that session.`);
    if (!saved) return;
    toastr.success(t`Copied here. The original stays where it was.`);
    selectTab('chat');
}

/** Sessions found in the account's other lists. They belong elsewhere, so they can be copied here, never opened in place. */
function renderEveryList() {
    const query = app.sessionQuery.trim();
    if (query.length < 2) return null;
    const state = app.everyList.query === query ? app.everyList : null;
    const section = h('section', { class: 'scratchpad-every-list', 'aria-label': t`Other lists` },
        h('div', { class: 'scratchpad-every-list-head' },
            iconButton(state?.loading ? t`Searching…` : t`Search every list`, () => void searchEveryList(), {
                icon: 'fa-magnifying-glass', className: 'scratchpad-every-list-button', disabled: state?.loading === true,
            }),
            h('p', { class: 'scratchpad-muted', text: t`Looks through the sessions of your other chats, notes and General Scratchpad.` })));
    if (!state || state.loading) return section;
    if (state.error) {
        section.append(h('p', { class: 'scratchpad-muted', role: 'alert', text: state.error }));
        return section;
    }
    const here = new Set((app.bucket?.sessions ?? []).map(session => session.id));
    const results = state.results.filter(result => !here.has(result.sessionId));
    section.append(h('p', { class: 'scratchpad-muted', role: 'status', text: results.length
        ? (state.more ? t`Showing the ${results.length} most recent matches in your other lists. Narrow the search to see the rest.` : results.length === 1 ? t`1 match in your other lists.` : t`${results.length} matches in your other lists.`)
        : t`Nothing in your other lists matches that search.` }));
    if (!results.length) return section;
    const list = h('ul', { class: 'scratchpad-sessions scratchpad-found' });
    for (const result of results) {
        const kind = listKindLabel(result.kind);
        const where = [kind, result.where === kind ? '' : result.where].filter(Boolean).join(': ');
        list.append(h('li', { class: 'scratchpad-session' },
            h('div', { class: 'scratchpad-session-info' },
                h('strong', { text: result.name, 'data-i18n-ignore': '' }),
                h('small', { text: [where, t`${result.messages} messages`, formatDate(result.updated)].filter(Boolean).join(' · '), 'data-i18n-ignore': '' }),
                result.snippet ? h('p', { class: 'scratchpad-found-snippet', text: result.snippet, 'data-i18n-ignore': '' }) : null),
            h('div', { class: 'scratchpad-session-actions' },
                iconButton(t`Copy here`, () => void copyFoundSession(result), { icon: 'fa-copy', title: t`Copy this session into the list you have open` }))));
    }
    section.append(list);
    return section;
}

let sessionSearch = null;
let sessionSearchTimer = 0;
const SESSION_SEARCH_DELAY_MS = 150;

// One search box that stays in the panel: rebuilding it per key blurred it and dropped
// keys typed during the redraw. The list redraws once typing pauses.
function sessionSearchInput() {
    sessionSearch ??= h('input', {
        type: 'search',
        class: 'text_pole scratchpad-session-search',
        placeholder: t`Search sessions`,
        'aria-label': t`Search sessions`,
        oninput: event => {
            app.sessionQuery = event.currentTarget.value;
            clearTimeout(sessionSearchTimer);
            sessionSearchTimer = setTimeout(renderSessions, SESSION_SEARCH_DELAY_MS);
        },
        onkeydown: event => {
            if (event.key === 'Enter' && !event.isComposing) void searchEveryList();
        },
    });
    if (sessionSearch.value !== app.sessionQuery) sessionSearch.value = app.sessionQuery;
    return sessionSearch;
}

function renderSessions() {
    const panel = app.el.panels.sessions;
    clearTimeout(sessionSearchTimer);
    sessionSearchTimer = 0;
    if (!app.source) {
        clear(panel);
        panel.append(h('p', { class: 'scratchpad-empty', text: t`Open a chat to see its Scratchpad sessions.` }));
        return;
    }
    const sessions = app.bucket?.sessions ?? [];
    const current = activeSession();
    const search = sessionSearchInput();
    for (const node of [...panel.childNodes]) {
        if (node !== search) node.remove();
    }
    if (search.parentNode !== panel) panel.append(search);
    search.before(...[
        h('p', { class: 'scratchpad-muted', text: app.source.kind === 'general' ? t`General sessions belong to your account, separately from chats and notes. Temporary sessions disappear when you open another one.` : app.source.kind === 'notebook' ? t`Sessions belong to this note. Temporary sessions disappear when you open another one.`
            : app.source.scope?.kind === 'group' ? t`Sessions are shared across this group's chats. Temporary sessions disappear when you open another one.`
                : t`Sessions are shared across this character's chats. Temporary sessions disappear when you open another one.` }),
        h('div', { class: 'scratchpad-session-tools' },
            iconButton(t`New session`, () => void newSession(false), { icon: 'fa-plus', primary: true }),
            iconButton(t`Temporary session`, () => void newSession(true), { icon: 'fa-hourglass-half' }),
            iconButton(t`Import`, importSessionFile, { icon: 'fa-file-import' }),
            current ? iconButton(t`Export current`, () => void exportSession(current), { icon: 'fa-file-export' }) : null,
            iconButton(historyCount() ? t`Change history (${historyCount()})` : historyHeading(), () => void openChangeHistory(), { icon: 'fa-clock-rotate-left', className: 'scratchpad-history-open' }),
            current ? iconButton(t`Save session to note`, () => void saveToNote(current), { icon: 'fa-book-bookmark', disabled: !current.messages.length }) : null),
        h('p', { class: 'scratchpad-muted', text: t`Exports keep the conversation but leave out message picks and saved-note sharing. Add these again after importing. Thinking, web search sources and attached files are included only when you tick them.` }),
        renderCleanup(),
    ].filter(Boolean));
    const list = h('ul', { class: 'scratchpad-sessions' });
    const visible = sessions.filter(session => sessionMatches(session, app.sessionQuery.trim()))
        .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true));
    if (!visible.length) {
        list.append(h('li', { class: 'scratchpad-muted', text: sessions.length ? t`No sessions match that search.` : t`No sessions yet. Send a message to start one.` }));
    }
    for (const session of visible) {
        const active = session.id === current?.id;
        const assistant = assistantInfo(session.assistant, session);
        const labelAction = (button, label) => { button.setAttribute('aria-label', label); return button; };
        list.append(h('li', { class: `scratchpad-session${active ? ' is-active' : ''}`, 'data-session': session.id },
            h('img', { src: assistantPortrait(assistant.id, session), alt: '', width: 32, height: 32 }),
            h('div', { class: 'scratchpad-session-info' },
                h('strong', { text: session.name, ...(session.name ? { 'data-i18n-ignore': '' } : {}) }),
                h('small', { text: [assistant.name, t`${session.messages.length} messages`, formatDate(session.updated), session.temporary ? t`Temporary` : '', session.pinned ? t`Pinned` : ''].filter(Boolean).join(' · ') })),
            h('div', { class: 'scratchpad-session-actions' },
                active
                    ? h('span', { class: 'scratchpad-badge', text: t`Open` })
                    : labelAction(iconButton(t`Open`, async () => {
                        await change(source => api.activateSession(source, session.id), t`Scratchpad could not open that session.`);
                        selectTab('chat');
                    }, { icon: 'fa-folder-open' }), t`Open ${session.name}`),
                session.temporary ? null : labelAction(iconButton('', () => void pinSession(session, !session.pinned), {
                    icon: 'fa-thumbtack', title: session.pinned ? t`Unpin session` : t`Pin session`, pressed: session.pinned === true, className: 'scratchpad-session-pin',
                }), session.pinned ? t`Unpin ${session.name}` : t`Pin ${session.name}`),
                labelAction(iconButton('', () => void renameSession(session), { icon: 'fa-i-cursor', title: t`Rename`, className: 'scratchpad-session-rename' }), t`Rename ${session.name}`),
                labelAction(iconButton('', () => void clearSessionMessages(session), { icon: 'fa-broom', title: t`Clear messages`, className: 'scratchpad-session-clear' }), t`Clear messages in ${session.name}`),
                labelAction(iconButton('', () => void removeSession(session), { icon: 'fa-trash', title: t`Delete session` }), t`Delete ${session.name}`))));
    }
    panel.append(...[list, renderEveryList()].filter(Boolean));
}

/* Opening and closing */

export async function openScratchpad({ tab = '', note = null, canOpen = () => true } = {}) {
    const opening = ++app.opening;
    const owner = getCurrentUserHandle();
    const opener = document.activeElement;
    const isLatest = () => opening === app.opening && owner === getCurrentUserHandle();
    // Only a different account discards the form draft; a same-account reopen
    // keeps it until a successful save.
    if (app.webSearchOwner !== owner) {
        app.webSearch = null;
        app.webSearchDraft = null;
        app.webSearchSaving = false;
        app.webSearchLoad = null;
        app.webSearchCheck += 1;
    }
    app.webSearchOwner = owner;
    // A library that cannot be read only hides saved assistants; Scratchpad still opens with the included ones.
    // Saved quick prompts that cannot be read only hide those chips; the built-in ones stay.
    // Saved setups that cannot be read only empty that list; the session's own choices still work.
    const [library, quickPrompts, contextSetups] = await Promise.all([
        api.readAssistants().then(result => result.library, error => {
            if (isLatest() && canOpen()) reportError(error, t`Your assistants could not be loaded.`);
            return null;
        }),
        api.readQuickPrompts().then(result => result.quickPrompts, error => {
            console.warn('[Scratchpad]', error);
            return null;
        }),
        api.readContextSetups().then(result => result.contextSetups, error => {
            console.warn('[Scratchpad]', error);
            return null;
        }),
        loadStylesheetAsync(STYLESHEET, { id: 'neconyan-scratchpad-css' }).catch(() => null),
    ]);
    if (!isLatest() || !canOpen()) return false;
    app.library = library ?? { assistants: [], revision: 0 };
    app.quickPrompts = quickPrompts ?? { prompts: [], revision: 0 };
    app.contextSetups = contextSetups ?? { setups: [], revision: 0 };
    build();
    readPrefs();
    if (!app.open) app.opener = opener;
    globalThis.NeconyanNotes?.hide?.();
    setNotebookSource(note);
    app.open = true;
    app.el.root.hidden = false;
    if (isPhone()) globalThis.NeconyanShell?.closeWorkspace?.();
    applyLayout();
    selectTab(tab || app.tab);
    app.el.heading.focus({ preventScroll: true });
    const next = currentSource();
    warnMissingPersona(next);
    if (!sameSourceBucket(next, app.source) || !app.bucket) {
        stopWatchers();
        app.bucket = null;
    }
    app.source = next;
    app.contextKey = '';
    render();
    await reload();
    if (!isLatest()) return false;
    clearInterval(app.timer);
    app.timer = setInterval(checkSource, SOURCE_POLL_MS);
    if (note) {
        if (!sameSourceBucket(app.source, next)) return false;
        const ref = { notebookId: note.notebookId, noteId: note.noteId, ...(note.grantId ? { grantId: note.grantId } : {}) };
        const saved = await updateSettings(latest => ({ notes: [...(latest.notes ?? []).filter(item => item.notebookId !== ref.notebookId || item.noteId !== ref.noteId), ref] }), { rerenderContext: true });
        // A saved reference keeps its grant even if the panel closed during the write.
        if (!isLatest()) return Boolean(saved);
        if (!saved) throw new Error(t`The note could not be added to Scratchpad. Return to Notes and try sharing it again.`);
        app.contextSubTab = 'sharing';
        app.contextDrawers.set('notes', true);
        writePrefs();
        selectTab('context');
    }
    if (!isPhone() && app.tab === 'chat' && document.activeElement === app.el.heading && !app.el.composer.disabled) {
        app.el.composer.focus({ preventScroll: true });
    }
    void refreshImageAvailability();
    void refreshWebSearchConfig({ quiet: true });
    return true;
}

export function hideScratchpad() {
    app.opening += 1;
    closeComposeMenu();
    if (!app.open) return;
    const restoreFocus = app.el.root.contains(document.activeElement);
    app.open = false;
    markFollowUpsAway();
    app.ticket += 1;
    app.personaWarning = false;
    endTalk();
    stopReadAloud();
    cancelDictation();
    app.openMenus.clear();
    app.openMenusSessionId = '';
    clearInterval(app.timer);
    app.timer = 0;
    stopWatchers();
    setNotebookSource(null);
    app.el.root.hidden = true;
    applyLayout();
    if (restoreFocus) {
        const opener = app.opener;
        if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
        if (document.activeElement === document.body) {
            const fallback = isPhone() ? document.getElementById('sb-hamburger')
                : document.querySelector('#neconyan-workspace-rail [data-neconyan-route="scratchpad"]');
            fallback?.focus({ preventScroll: true });
        }
    }
    app.opener = null;
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
    if (route === 'scratchpad') return;
    if (!app.open || route === 'notes' || isPhone() || app.layout === 'full') hideScratchpad();
}

globalThis.NeconyanScratchpad = Object.freeze({
    open: openScratchpad,
    hide: hideScratchpad,
    toggle: toggleScratchpad,
    isOpen: isScratchpadOpen,
    onRoute: onWorkspaceRoute,
});

export const testExports = { replyDraft, contextSummary, clampWidth, sessionMatches };
