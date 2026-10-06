import { active_character, active_group, characters, eventSource, event_types, flushPendingChatSavesForNavigation, getCurrentChatId, getRequestHeaders, openSavedCharacterChat, this_chid } from '../script.js';
import { groups, selected_group, openSavedGroupChat } from './group-chats.js';
import { power_user } from './power-user.js';
import { getCurrentUserHandle } from './user.js';
import { getTagKeyForEntity } from './tags.js';
import { getRoleplaySourceId } from './roleplay-save-chain.js';
import { chatNavigationLaunchUrl, hasChatNavigationDraft, isChatNavigationBlocked, setChatNavigationBlocked } from './chat-navigation-flight.js';
import { chatHistoryAction, chatNavigationUrl, parseChatNavigation, sameChatDestination } from './chat-navigation-policy.js';
import { consumeNeconyanRoute, getActualNeconyanMode, isNeconyanModeBusy, prepareSavedChatMode, presentSavedRoleplay, presentSavedStory } from './neconyan-tabs.js';
import { hideWelcomeHome, openWelcomeScreen } from './welcome-screen.js';
import { conversationState } from './neconyan-conversation/state.js';
import { getActiveConversationBranch, getConversationPersonaId, getRawConversationThreadKey, isConversationThreadKeyForPersona } from './neconyan-conversation/context.js';
import { getConversationSavedSnapshot, refreshConversationStore, waitForConversationEdits } from './neconyan-conversation/store-sync.js';
import { selectConversationThread } from './neconyan-conversation/chrome.js';

let initialized = false;
let accountStamp = null;
let owner = '';
let accountActive = true;
const accountAbort = new AbortController();
let serial = Promise.resolve();
let remembering = Promise.resolve();
let navigationTicket = 0;
let observationTicket = 0;
let preparingForeground = 0;
let routing = false;
let visible = { kind: 'home' };
let visibleUrl = '';
let preparedLink = '';
let pendingIntent = null;
let pendingOptions = {};
let retryStartup = false;
const clientId = globalThis.crypto.randomUUID?.() || [...globalThis.crypto.getRandomValues(new Uint8Array(16))]
    .map(value => value.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
let sequence = 0;
const cancelled = () => Object.assign(new Error('Navigation changed.'), { name: 'AbortError' });
const currentAccount = () => accountActive && owner === getCurrentUserHandle();

async function post(action, body = {}) {
    if (!currentAccount()) throw cancelled();
    const url = new URL(`api/chat-navigation/${action}`, new URL('./', chatNavigationLaunchUrl));
    const response = await fetch(url, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { ...getRequestHeaders(), 'X-Neconyan-Account': owner },
        body: JSON.stringify({ ...body, ...(accountStamp ? { account: accountStamp } : {}) }),
        signal: AbortSignal.any([accountAbort.signal, AbortSignal.timeout(30000)]),
    });
    if (!currentAccount()) throw cancelled();
    if (!response.ok) throw Object.assign(new Error('The chat could not be opened.'), { status: response.status });
    const value = await response.json();
    if (!currentAccount()) throw cancelled();
    return value;
}

function dialog() {
    let element = document.getElementById('neconyan-chat-route');
    if (!element) {
        element = document.createElement('dialog');
        element.id = 'neconyan-chat-route';
        element.setAttribute('aria-labelledby', 'neconyan-chat-route-title');
        element.innerHTML = '<h2 id="neconyan-chat-route-title" tabindex="-1"></h2><p data-route-description role="status"></p><input data-route-link aria-label="Chat link" readonly hidden><div class="neconyan-route-actions"><button type="button" class="menu_button" data-route-retry>Retry</button><button type="button" class="menu_button" data-route-home>Go to Home</button><button type="button" class="menu_button" data-route-close hidden>Close</button></div>';
        element.addEventListener('cancel', event => event.preventDefault());
        element.querySelector('[data-route-retry]').addEventListener('click', () => {
            if (retryStartup) void startLaunch();
            else void requestNavigation(pendingIntent, { ...pendingOptions, reason: 'retry' });
        });
        element.querySelector('[data-route-home]').addEventListener('click', () => void requestNavigation({ kind: 'home' }, { reason: 'foreground' }));
        element.querySelector('[data-route-close]').addEventListener('click', () => element.close());
        document.body.append(element);
    }
    return element;
}

function showRouteState(kind, { transient = false, link = '' } = {}) {
    const element = dialog();
    const copying = kind === 'copy';
    const loading = kind === 'loading';
    element.querySelector('h2').textContent = copying ? 'Copy chat link' : loading ? 'Opening chat' : 'Chat could not be opened';
    element.querySelector('[data-route-description]').textContent = copying
        ? 'Select and copy this link. It opens this saved chat for the same account on this installation; it does not share the chat.'
        : loading ? 'Loading the saved conversation. No message will be sent.'
            : transient ? 'The connection or session could not be checked. Retry, or go to Home.'
                : 'This link is invalid, unavailable, or its mode is disabled. Go to Home to choose another chat.';
    element.querySelector('[data-route-retry]').hidden = copying || loading || !transient;
    element.querySelector('[data-route-home]').hidden = copying || loading;
    element.querySelector('[data-route-close]').hidden = !copying;
    const input = element.querySelector('[data-route-link]');
    input.hidden = !copying;
    input.value = link;
    if (!element.open) element.showModal();
    if (copying) { input.focus({ preventScroll: true }); input.select(); } else {
        element.querySelector('h2').focus({ preventScroll: true });
    }
}

const linkSwitches = [
    { source: 'chat-links-checkbox', setting: 'chat_links', label: 'Chat links in the address bar', hint: 'The address follows your saved chat, so Back, Forward and bookmarks open exact chats.' },
    { source: 'auto-load-chat-checkbox', setting: 'auto_load_chat', label: 'Resume last chat on launch', hint: 'Opening Neconyan returns to the last saved chat you opened on this account.' },
];

function syncLinkSwitches() {
    for (const input of document.querySelectorAll('[data-link-setting]')) input.checked = Boolean(power_user[input.dataset.linkSetting]);
}

// Shortcuts to the two User Settings checkboxes, so their saving and side effects stay in one place.
function fillLinkSwitches() {
    for (const container of document.querySelectorAll('[data-chat-link-switches]:empty')) {
        for (const { source, setting, label, hint } of linkSwitches) {
            const id = `${container.dataset.chatLinkSwitches}-${setting}`;
            const row = document.createElement('label');
            row.className = 'checkbox_label neconyan-link-switch';
            row.htmlFor = id;
            const input = document.createElement('input');
            Object.assign(input, { type: 'checkbox', id });
            input.dataset.linkSetting = setting;
            input.setAttribute('aria-describedby', `${id}-hint`);
            const name = document.createElement('span');
            name.textContent = label;
            const note = document.createElement('small');
            note.id = `${id}-hint`;
            note.textContent = hint;
            const text = document.createElement('span');
            text.append(name, note);
            row.append(input, text);
            input.addEventListener('change', () => {
                const target = document.getElementById(source);
                if (!target) return;
                target.checked = input.checked;
                target.dispatchEvent(new Event('input', { bubbles: true }));
            });
            container.append(row);
        }
    }
    syncLinkSwitches();
}

function linkSettingsDialog() {
    let element = document.getElementById('neconyan-chat-link-settings');
    if (!element) {
        element = document.createElement('dialog');
        element.id = 'neconyan-chat-link-settings';
        element.setAttribute('aria-labelledby', 'neconyan-chat-link-settings-title');
        element.innerHTML = '<h2 id="neconyan-chat-link-settings-title" tabindex="-1">Chat links</h2><p>A chat link reopens this saved chat in your account on this installation. It does not share the chat with anyone.</p><button type="button" class="menu_button" data-chat-link-copy aria-disabled="true" disabled><i class="fa-solid fa-link" aria-hidden="true"></i> Copy chat link</button><div data-chat-link-switches="neconyan-chat-link-settings"></div><div class="neconyan-route-actions"><button type="button" class="menu_button" data-link-settings-close>Close</button></div>';
        element.querySelector('[data-chat-link-copy]').addEventListener('click', () => void copyChatLink());
        element.querySelector('[data-link-settings-close]').addEventListener('click', () => element.close());
        element.addEventListener('click', event => {
            const box = element.getBoundingClientRect();
            const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
            if (event.target === element && outside) element.close();
        });
        document.body.append(element);
        fillLinkSwitches();
    }
    return element;
}

function openLinkSettings() {
    const element = linkSettingsDialog();
    copyAvailability();
    syncLinkSwitches();
    if (!element.open) element.showModal();
    element.querySelector('h2').focus({ preventScroll: true });
}

function writeHistory(destination, reason) {
    // Without chat links Home keeps a clean address, so a refresh can still resume the last chat.
    if (destination?.kind === 'home' && !power_user.chat_links) destination = null;
    const next = chatNavigationUrl(location.href, destination);
    const action = chatHistoryAction({ current: parseChatNavigation(location.href), next: destination || { kind: 'root' }, linksEnabled: Boolean(power_user.chat_links), reason });
    if (action !== 'none' && next.href !== location.href) history[`${action}State`](history.state, '', next);
    visibleUrl = location.href;
}

function copyAvailability() {
    const allowed = Boolean(preparedLink) && !routing;
    for (const item of document.querySelectorAll('#option_copy_chat_link, [data-chat-link-copy]')) {
        item.setAttribute('aria-disabled', String(!allowed));
        if (item.tagName === 'BUTTON') item.disabled = !allowed;
        item.title = allowed ? 'Open this saved chat for the same account on this installation; this is not public sharing.'
            : 'Only a saved conversation has a chat link. Temporary or unsaved chats are not saved just to make a link.';
    }
}

function captureVisibleTarget() {
    if (document.body.classList.contains('neconyan-home-visible')) return { kind: 'home' };
    const mode = getActualNeconyanMode();
    if (mode === 'meower') return { kind: 'other' };
    if (mode === 'conversation') {
        const avatar = conversationState.conversationSelectedAvatar;
        const groupId = conversationState.conversationSelectedGroupId || '';
        const personaId = getConversationPersonaId();
        const branch = avatar && getActiveConversationBranch(avatar, { create: false, groupId, personaId });
        if (!branch) return { kind: 'other' };
        // A locally created, unsaved branch does not become saved to make a link.
        const saved = getConversationSavedSnapshot();
        const indexed = branch.navigationId && saved?.navigationTargets?.[branch.navigationId];
        const enrolled = indexed?.branchId === branch.id && isConversationThreadKeyForPersona(indexed.threadKey, personaId)
            && (indexed.threadKey === getRawConversationThreadKey(avatar, groupId, personaId)
                || (groupId && saved.characters?.[indexed.threadKey]?.groupId === groupId)) ? indexed : null;
        const thread = saved?.characters?.[getRawConversationThreadKey(avatar, groupId, personaId)];
        const exists = enrolled || (thread?.branches?.[branch.id]?.lifetimeSeed === branch.lifetimeSeed
            && thread.branches?.[branch.id]?.createdAt === branch.createdAt && thread.threadAvatar === avatar && String(thread.groupId || '') === groupId);
        if (!exists) return { kind: 'other' };
        return { mode, target: { avatar: (enrolled && saved.characters?.[enrolled.threadKey]?.threadAvatar) || avatar, groupId, personaId, branchId: branch.id },
            expectedBranch: { navigationId: branch.navigationId || null, lifetimeSeed: branch.lifetimeSeed || '', createdAt: String(branch.createdAt || '') } };
    }
    const chatName = getCurrentChatId();
    if (!chatName) return { kind: 'other' };
    if (selected_group) {
        const locator = { group: true, chat: String(chatName) };
        return { mode, locator, groupId: String(selected_group), sourceId: getRoleplaySourceId(locator) || undefined };
    }
    const avatar = characters[this_chid]?.avatar;
    if (!avatar) return { kind: 'other' };
    const locator = { group: false, chat: String(chatName), avatar };
    return { mode, locator, sourceId: getRoleplaySourceId(locator) || undefined };
}

function remember(destination) {
    if (!power_user.auto_load_chat || destination.kind !== 'chat') return;
    const update = { destination: { id: destination.id, mode: destination.mode }, clientId, sequence: ++sequence };
    const save = async () => {
        if (!power_user.auto_load_chat || !currentAccount()) return;
        await post('remember', update);
    };
    remembering = remembering.then(save, save).catch(() => {});
}

async function observeForeground({ reason = 'foreground', track = true, homeRequested = false } = {}) {
    if (!initialized || routing || !currentAccount()) return;
    // A late background receipt cannot dismiss an explicit failed destination.
    if (isChatNavigationBlocked() && !preparingForeground && document.getElementById('neconyan-chat-route')?.open) return;
    const ticket = ++observationTicket;
    const captured = captureVisibleTarget();
    const knownId = captured.sourceId || captured.expectedBranch?.navigationId;
    if (knownId && visible.kind === 'chat' && visible.id === knownId && visible.mode === captured.mode) {
        preparedLink = chatNavigationUrl(location.href, visible, { minimal: true }).href;
        copyAvailability();
        if (preparingForeground) {
            preparingForeground = 0;
            dialog().close();
            setChatNavigationBlocked(false);
        }
        return;
    }
    if (!captured.kind) {
        preparedLink = '';
        copyAvailability();
        if (!power_user.chat_links && ['chat', 'invalid'].includes(parseChatNavigation(location.href).kind)) writeHistory(null, 'replace');
        if (power_user.chat_links && reason === 'foreground') {
            preparingForeground = ticket;
            setChatNavigationBlocked(true);
            if (['send_textarea', 'sb_conversation_input'].includes(document.activeElement?.id)) document.activeElement.blur();
            showRouteState('loading');
        }
    }
    let destination;
    try {
        if (captured.kind) destination = captured;
        else {
            const established = await post('establish', captured);
            if (captured.mode === 'conversation' && (await refreshConversationStore(owner)).conflict) throw new Error('Conversation changed.');
            destination = { kind: 'chat', id: established.id, mode: established.mode };
        }
    } catch {
        destination = { kind: 'other' };
        if (preparingForeground === ticket && ticket === observationTicket && !routing && currentAccount()) toastr.warning('The chat opened, but its link could not be prepared. Open it again to retry.');
    }
    // Enrolment may add a server ID to the same visible branch. That is not a
    // different selection; persona, group, branch and lifetime still must match.
    const selectionKey = value => JSON.stringify({ ...value, ...(value.expectedBranch ? { expectedBranch: { ...value.expectedBranch, navigationId: null } } : {}) });
    if (ticket !== observationTicket || routing || !currentAccount()
        || selectionKey(captured) !== selectionKey(captureVisibleTarget())) return;
    const changed = !sameChatDestination(visible, destination);
    visible = destination;
    preparedLink = destination.kind === 'chat' ? chatNavigationUrl(location.href, destination, { minimal: true }).href : '';
    copyAvailability();
    if (destination.kind === 'home') {
        if ((changed || homeRequested) && reason === 'foreground') writeHistory(destination, reason);
        else if (reason === 'startup' && ['chat', 'invalid'].includes(parseChatNavigation(location.href).kind)) writeHistory(null, 'replace');
    } else if (power_user.chat_links && destination.kind === 'chat') {
        writeHistory(destination, reason);
    } else if (changed && ['chat', 'invalid'].includes(parseChatNavigation(location.href).kind)) {
        writeHistory(null, preparingForeground === ticket ? 'foreground' : 'replace');
    }
    if (track && changed && destination.kind === 'chat') remember(destination);
    if (preparingForeground && ticket === observationTicket) {
        preparingForeground = 0;
        dialog().close();
        setChatNavigationBlocked(false);
    }
}

async function navigate(intent, options, ticket) {
    const guard = () => ticket === navigationTicket && currentAccount();
    if (!guard()) return;
    const draft = !sameChatDestination(visible, intent) && hasChatNavigationDraft(getActualNeconyanMode());
    const busy = isNeconyanModeBusy() || draft;
    if (busy) {
        if (options.reason === 'popstate' && visibleUrl) history.replaceState(history.state, '', visibleUrl);
        toastr.warning(draft ? 'Send or clear the current draft before switching chats.' : 'Finish the current reply or save before switching chats.');
        if (options.reason !== 'popstate' && options.reason !== 'foreground') {
            pendingIntent = intent;
            pendingOptions = options;
            setChatNavigationBlocked(true);
            showRouteState('error', { transient: true });
        }
        return;
    }
    routing = true;
    preparingForeground = 0;
    observationTicket += 1;
    preparedLink = '';
    pendingIntent = intent;
    pendingOptions = options;
    retryStartup = false;
    setChatNavigationBlocked(true);
    copyAvailability();
    if (['send_textarea', 'sb_conversation_input'].includes(document.activeElement?.id)) document.activeElement.blur();
    showRouteState('loading');
    try {
        if (intent.kind === 'invalid') throw Object.assign(new Error('Invalid link.'), { status: 400 });
        if (intent.kind === 'home' || intent.kind === 'root') {
            if (!await waitForConversationEdits(owner) || !guard()) throw cancelled();
            if (!await flushPendingChatSavesForNavigation() || !guard()) throw new Error('The current edits could not be saved.');
            if (!await prepareSavedChatMode('roleplay', guard)) throw new Error('The current mode could not close.');
            if (!guard()) throw cancelled();
            await openWelcomeScreen({ force: true });
            if (!guard()) throw cancelled();
            visible = { kind: 'home' };
            preparedLink = '';
            if (intent.kind === 'home') writeHistory(visible, options.reason);
        } else {
            const resolved = await post('resolve', { destination: { id: intent.id, mode: intent.mode } });
            if (!guard()) throw cancelled();
            if (!await waitForConversationEdits(owner) || !guard()) throw cancelled();
            if (!await flushPendingChatSavesForNavigation() || !guard()) throw new Error('The current edits could not be saved.');
            if (!await prepareSavedChatMode(intent.mode, guard)) throw Object.assign(new Error('This mode is unavailable or busy.'), { status: 404 });
            if (!guard()) throw cancelled();
            hideWelcomeHome();
            const verifyTarget = async () => {
                const latest = await post('resolve', { destination: { id: intent.id, mode: intent.mode } });
                if (!guard()) return false;
                const before = resolved.target || resolved.locator;
                const after = latest.target || latest.locator;
                const keys = resolved.target ? ['avatar', 'groupId', 'personaId', 'branchId'] : ['group', 'avatar', 'chat'];
                if (keys.some(key => before[key] !== after?.[key]) || latest.groupId !== resolved.groupId) {
                    throw Object.assign(new Error('The saved destination changed while opening.'), { status: 409 });
                }
                return true;
            };
            let opened;
            if (intent.mode === 'conversation') {
                const result = await refreshConversationStore(owner);
                if (result.conflict) throw new Error('Conversation edits could not be reconciled.');
                if (!guard()) throw cancelled();
                if (!await verifyTarget() || !guard()) throw cancelled();
                opened = await selectConversationThread(resolved.target.avatar, { ...resolved.target, savedOnly: true, expectedNavigationId: resolved.id, showToast: false, navigationGuard: guard });
            } else {
                const evidence = { expectedSourceId: resolved.id, verifyTarget };
                opened = resolved.locator.group
                    ? await openSavedGroupChat(resolved.groupId, resolved.locator.chat, guard, evidence)
                    : await openSavedCharacterChat(resolved.locator.avatar, resolved.locator.chat, guard, evidence);
                if (opened && intent.mode === 'story') opened = await presentSavedStory(guard);
                else if (opened) opened = await presentSavedRoleplay(guard);
            }
            if (!guard()) throw cancelled();
            if (!opened) throw new Error('The chat could not finish opening.');
            visible = { kind: 'chat', id: resolved.id, mode: resolved.mode };
            preparedLink = chatNavigationUrl(location.href, visible, { minimal: true }).href;
            if (power_user.chat_links || options.reason === 'foreground') writeHistory(power_user.chat_links ? visible : null, options.reason);
            if (options.track) remember(visible);
        }
        visibleUrl = location.href;
        dialog().close();
        setChatNavigationBlocked(false);
    } catch (error) {
        if (!guard()) return;
        const permanent = [400, 404].includes(error.status);
        if (options.automatic && permanent) {
            await post('clear-stale', { revision: options.revision }).catch(() => {});
            if (guard()) {
                routing = false;
                void requestNavigation({ kind: 'home' }, { reason: 'replace' });
            }
            return;
        }
        // Explicit failures retain their own address and never fall through to resume.
        showRouteState('error', { transient: !permanent });
    } finally {
        if (guard()) { routing = false; copyAvailability(); }
    }
}

export function requestNavigation(intent, options = {}) {
    const ticket = ++navigationTicket;
    const run = () => navigate(intent || parseChatNavigation(location.href), { reason: 'replace', track: false, ...options }, ticket);
    serial = serial.then(run, run);
    return serial;
}

async function copyChatLink() {
    if (!preparedLink || routing) { toastr.info('Only a saved conversation has a chat link.'); return; }
    const link = preparedLink;
    try {
        if (!globalThis.isSecureContext || typeof navigator.clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable.');
        await navigator.clipboard.writeText(link);
        if (currentAccount()) toastr.success('Chat link copied.');
    } catch {
        if (!currentAccount()) return;
        document.getElementById('neconyan-chat-link-settings')?.close();
        showRouteState('copy', { link });
    }
}

function legacyTarget() {
    if (active_character && active_group) return null;
    if (active_character) {
        const matches = characters.filter(character => getTagKeyForEntity(character) === active_character);
        if (matches.length === 1 && matches[0].chat) return { mode: 'roleplay', locator: { group: false, avatar: matches[0].avatar, chat: matches[0].chat } };
    } else if (active_group) {
        const group = groups.find(item => String(item.id) === String(active_group));
        if (group?.chat_id && group.chats?.map(String).includes(String(group.chat_id))) return { mode: 'roleplay', locator: { group: true, chat: String(group.chat_id) }, groupId: String(group.id) };
    }
    return null;
}

export async function initChatNavigation() {
    if (initialized) return;
    owner = getCurrentUserHandle();
    const launch = new URL(chatNavigationLaunchUrl);
    initialized = true;
    const foreground = () => { void observeForeground(); };
    eventSource.on(event_types.CHAT_CHANGED, foreground);
    for (const event of ['sb:conversation-workspace-state-changed', 'neconyan:story-state-changed', 'neconyan:hopper-state-changed']) window.addEventListener(event, foreground);
    window.addEventListener('neconyan:conversation-store-saved', () => {
        // Only finish establishing the already-visible foreground destination.
        // A background receipt or list refresh must never refresh the pointer.
        if (getActualNeconyanMode() === 'conversation' && visible.kind !== 'chat') void observeForeground();
    });
    window.addEventListener('neconyan:navigate-home', () => void observeForeground({ homeRequested: true }));
    window.addEventListener('neconyan:chat-tools-ready', () => { copyAvailability(); fillLinkSwitches(); });
    document.addEventListener('input', event => { if (linkSwitches.some(item => item.source === event.target?.id)) syncLinkSwitches(); });
    const settingsItem = document.getElementById('option_chat_link_settings');
    settingsItem?.addEventListener('click', openLinkSettings);
    settingsItem?.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); settingsItem.click(); } });
    window.addEventListener('popstate', () => void requestNavigation(parseChatNavigation(location.href), { reason: 'popstate' }));
    window.addEventListener('pageshow', event => {
        if (!event.persisted) return;
        const intent = parseChatNavigation(location.href);
        if (intent.kind === 'root' && visible.kind === 'other') return;
        void requestNavigation(intent.kind === 'root' ? visible : intent, { reason: 'restore' });
    });
    window.addEventListener('neconyan:account-changing', () => { accountActive = false; accountAbort.abort(); navigationTicket += 1; observationTicket += 1; preparingForeground = 0; preparedLink = ''; accountStamp = null; copyAvailability(); setChatNavigationBlocked(true); });
    document.getElementById('option_copy_chat_link')?.addEventListener('click', () => void copyChatLink());
    document.getElementById('option_copy_chat_link')?.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); void copyChatLink(); } });
    window.addEventListener('neconyan:chat-links-preference', () => {
        if (!power_user.chat_links) writeHistory(null, 'toggle');
        else if (visible.kind === 'chat') writeHistory(visible, 'toggle');
        else if (visible.kind === 'home') writeHistory(visible, 'toggle');
    });
    window.addEventListener('neconyan:resume-preference', () => { if (power_user.auto_load_chat && visible.kind === 'chat') remember(visible); });
    copyAvailability();
    fillLinkSwitches();
    // Explicit existing actions retain priority; there is no second late autoload.
    if (launch.searchParams.has('neconyanView') || (launch.searchParams.has('source') && launch.searchParams.has('query'))) {
        routing = true;
        try { await consumeNeconyanRoute(); } finally { routing = false; }
        try {
            const state = await post('state'); accountStamp = state.account;
            await observeForeground({ reason: 'startup', track: false });
            setChatNavigationBlocked(false);
        } catch {
            // The existing action has already run. Its failure must not resume a chat.
            setChatNavigationBlocked(false);
            copyAvailability();
        }
        return;
    }
    await startLaunch();
}

async function startLaunch() {
    let intent = parseChatNavigation(chatNavigationLaunchUrl);
    // Earlier builds wrote ?view=home even with chat links off; treat it as a plain launch.
    if (intent.kind === 'home' && !power_user.chat_links) {
        writeHistory(null, 'replace');
        intent = { kind: 'root' };
    }
    retryStartup = false;
    try {
        const state = await post('state');
        accountStamp = state.account;
        if (intent.kind !== 'root') { await requestNavigation(intent, { reason: 'startup' }); return; }
        if (!power_user.auto_load_chat) { visibleUrl = location.href; dialog().close(); setChatNavigationBlocked(false); return; }
        let pointer = state.pointer;
        if (!pointer && !state.migration) {
            const target = legacyTarget();
            let destination = null;
            if (target) {
                try { destination = await post('establish', target); } catch (error) { if (![400, 404].includes(error.status)) throw error; }
            }
            const result = await post('migrate', { ...(destination ? { destination: { id: destination.id, mode: destination.mode }, clientId, sequence: ++sequence } : {}) });
            pointer = result.pointer;
        }
        if (pointer) await requestNavigation({ kind: 'chat', id: pointer.id, mode: pointer.mode }, { reason: 'startup', automatic: true, revision: pointer.revision });
        else { visibleUrl = location.href; dialog().close(); setChatNavigationBlocked(false); }
    } catch {
        pendingIntent = intent;
        retryStartup = true;
        setChatNavigationBlocked(true);
        showRouteState('error', { transient: true });
    }
}
