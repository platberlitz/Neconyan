// Every DOM touch lives here. Post bodies are model output and are rendered as text nodes,
// never as markup - which is also why nothing in this file assigns innerHTML.

import {
    BODY_CLASS,
    KIND_AMBIENT,
    KIND_CHARACTER,
    KIND_PERSONA,
    POST_MAX_CHARS,
    REPLY_MAX_CHARS,
    handleIndex,
    matchesTimelineQuery,
    needsCatchUp,
    snapshotOf,
    insertMention,
    matchMentionAccounts,
    mentionQueryAt,
    RECENT_WINDOW_HOURS,
    engagementScore,
    formatCount,
    buildNotifications,
    countUnseen,
    rankScore,
    discountRepeatAuthors,
    mentionsHandle,
    summarizeRefresh,
    isAnswerable,
    removeReply,
    restoreReply,
    reconcileInteractions,
} from './core.js';
import * as api from './api.js';

const LAUNCH_ID = 'sbtw-launch-button';
const WAND_ID = 'sbtw-wand-button';
const DRAWER_ID = 'sbtw-drawer';
const EXTENSION_NAME = 'Neconyan-Hopper';
const FEED_LIMIT = 160;
const REPLY_LIMIT = 12;
const PROFILE_LIMIT = 20;
const NOTIFICATION_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 150;

const state = {
    body: null,
    session: null,
    feed: null,
    accounts: [],
    view: 'timeline',
    tab: 'main',
    /** Which notifications tab is open, and the seen-mark from before the view was opened (rows newer than it show as new). */
    notifTab: 'likes',
    notifSeenBefore: 0,
    /** The timeline's seen-mark from before this visit: posts and replies newer than it wear a dot. */
    timelineSeenBefore: 0,
    /** `${postId}:like` or `${postId}:repost` while a who-did-this list is open. */
    engagementFor: null,
    profileKey: null,
    replyingTo: null,
    status: '',
    busy: false,
    opening: false,
    loadFailure: null,
    draft: { text: '', image: '', poll: null, imageDescription: '' },
    draftOwner: null,
    draftReady: false,
    draftError: '',
    syncError: '',
    imagePending: false,
    revealTarget: null,
    characterSearch: '',
    timelineSearch: '',
    /** Bumped whenever a refresh lands (or the timeline is reset); Main's ranking is frozen in between. */
    feedEpoch: 0,
};

const owned = new Set();

// One workspace at a time; async work belongs to a session and dies with it.
let openTask = null;
let sessionTask = null;
let closingTask = Promise.resolve();
let transitionEpoch = 0;
let pendingPersonaSwitch = '';
let accountRequest = 0;
let sessionEpoch = 0;
let workController = null;
let mutationTask = null;
let saveStatusSubscription = null;
let syncingFeed = null;
let syncTimer = null;
let personaProfileRevision = 0;
let undoRevision = 0;
let opener = null;
const scrollPositions = new Map();
const listLimits = new Map();
const openSections = new Map();
const undoToasts = new Set();
// Keep failed local writes in this tab too, so a storage error does not eat a draft on a switch.
const unsavedDrafts = new Map();

function freshSignal() {
    // Aborting also invalidates every run holding the previous signal.
    workController?.abort();
    workController = new AbortController();
    return { epoch: ++sessionEpoch, signal: workController.signal };
}

function invalidateWork() {
    sessionEpoch += 1;
    workController?.abort();
    workController = null;
}

/** The user's Stop button: aborts the running model work but keeps the run live, so its own catch reports the outcome. */
function stopWork() {
    if (state.opening) {
        void closeFeed().catch(error => toast(error.message, 'error'));
        return;
    }
    workController?.abort();
    state.status = 'Stopping...';
    patchStatus();
}

function isLive(epoch) {
    return epoch === sessionEpoch && state.body !== null;
}

// Monotonic counter of refresh runs; only the newest may touch shared busy/status state.
let refreshRuns = 0;

const dateFormat = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

// --- tiny DOM helpers -----------------------------------------------------

function el(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    if (options.className) {
        node.className = options.className;
    }
    if (options.text !== undefined) {
        node.textContent = String(options.text);
    }
    for (const [key, value] of Object.entries(options.attrs ?? {})) {
        if (value !== null && value !== undefined && value !== false) {
            node.setAttribute(key, String(value));
        }
    }
    for (const [event, handler] of Object.entries(options.on ?? {})) {
        node.addEventListener(event, handler);
    }
    for (const child of [].concat(children)) {
        if (child) {
            node.append(child);
        }
    }
    return node;
}

function icon(name) {
    return el('i', { className: `fa-solid ${name}`, attrs: { 'aria-hidden': 'true' } });
}

/** Generated Neconyan artwork; retain the legacy class for saved custom CSS. */
function catIcon(className = '') {
    const node = el('i', { className: `sbtw-bunny${className ? ' ' + className : ''}`, attrs: { 'aria-hidden': 'true' } });
    node.append(el('img', { attrs: { src: '/img/neconyan/cat-head.webp', alt: '', draggable: 'false' } }));
    return node;
}

function button(label, className, onClick, { iconName = '', title = '', ariaLabel = '', pressed = null, disabled = false, focusKey = label } = {}) {
    const node = el('button', {
        className,
        attrs: {
            type: 'button',
            title: title || label,
            'aria-label': ariaLabel || null,
            'aria-pressed': pressed === null ? null : String(pressed),
            'data-focus-key': focusKey,
            disabled: disabled ? 'disabled' : null,
        },
        on: { click: onClick },
    }, iconName ? [icon(iconName), el('span', { text: label })] : [el('span', { text: label })]);
    return node;
}

function toast(message, type = 'info') {
    globalThis.toastr?.[type]?.(String(message), 'Meower', { escapeHtml: true });
}

function report(message, type = 'info') {
    state.status = String(message);
    patchStatus();
    toast(message, type);
}

function saveDraft() {
    const owner = state.draftOwner;
    if (!owner) {
        return true;
    }
    if (!state.draftReady) {
        return false;
    }
    const value = { draft: { ...state.draft, poll: state.draft.poll?.slice() ?? null }, replies: [...replyDrafts] };
    const key = JSON.stringify(owner);
    try {
        if (!value.draft.text && !value.draft.image && !value.draft.poll && !value.draft.imageDescription && !value.replies.length) {
            api.clearDraft(owner.sessionId, owner.personaId);
        } else {
            api.saveDraft(owner.sessionId, owner.personaId, value);
        }
        unsavedDrafts.delete(key);
        state.draftError = '';
        patchStatus();
        return true;
    } catch (error) {
        unsavedDrafts.set(key, value);
        state.draftError = `Your draft could not be saved on this device. Keep this tab open. ${error.message ?? ''}`;
        patchStatus();
        return false;
    }
}

function loadDraft(session) {
    state.draftOwner = session.personaId ? { sessionId: session.id, personaId: session.personaId } : null;
    state.draft = { text: '', image: '', poll: null, imageDescription: '' };
    state.draftReady = false;
    state.draftError = '';
    replyDrafts.clear();
    if (!state.draftOwner) {
        return;
    }
    try {
        const local = unsavedDrafts.get(JSON.stringify(state.draftOwner));
        const stored = api.readDraft(session.id, session.personaId);
        const saved = local ?? stored;
        if (saved) {
            state.draft = { ...state.draft, ...saved.draft };
            for (const [key, text] of saved.replies) {
                replyDrafts.set(key, text);
            }
        }
        state.draftReady = true;
        if (local) {
            state.draftError = 'Your draft is still only in this tab. Retry saving before closing the browser.';
        }
    } catch (error) {
        state.draftError = `Your saved draft could not be read. ${error.message ?? ''}`;
    }
}

function patchStatus() {
    if (!state.body) {
        return;
    }
    const saved = api.getSaveStatus(state.session?.id);
    const saveState = state.draftError || state.syncError ? 'error' : saved.state;
    if (state.body.dataset) {
        state.body.dataset.saveState = saveState;
    }
    const message = state.draftError || state.syncError || saved.message || ({ saved: 'Saved', saving: 'Saving...', error: 'Changes could not be saved.' })[saved.state];
    for (const status of state.body.querySelectorAll('.sbtw-status')) {
        if (status.textContent !== state.status) {
            status.textContent = state.status;
        }
    }
    for (const save of state.body.querySelectorAll('.sbtw-save-status')) {
        if (save.textContent !== message) {
            save.textContent = message;
        }
        save.dataset.state = saveState;
    }
    for (const retry of state.body.querySelectorAll('[data-focus-key="retry-save"]')) {
        retry.hidden = !state.draftError && saved.state !== 'error';
        retry.disabled = Boolean(mutationTask);
        if (retry.hidden && document.activeElement === retry) {
            (state.body.querySelector('[data-focus-key="refresh"]:not(:disabled)') ?? state.body.querySelector('.sbtw-main') ?? state.body).focus({ preventScroll: true });
        }
    }
}

async function downloadRecovery() {
    try {
        let text = await api.exportRecovery();
        if (unsavedDrafts.size) {
            text = JSON.stringify({ ...JSON.parse(text), tabDrafts: [...unsavedDrafts] }, null, 2);
        }
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = el('a', { attrs: { href: url, download: 'meower-recovery.json' } });
        try {
            document.body.append(link);
            link.click();
        } finally {
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    } catch (error) {
        toast(error.message || 'Recovery could not be exported. Keep this tab open.', 'error');
    }
}

async function discardDraft() {
    const owner = state.draftOwner;
    const body = state.body;
    if (!owner || mutationTask || state.busy || state.imagePending) {
        return false;
    }
    const confirmed = await globalThis.SillyTavern.getContext().Popup.show.confirm(
        'Discard every version of this draft?',
        'Export recovery first if you want to keep any text. All saved post and reply draft versions for this timeline and persona in this browser will be discarded, including text kept only in this tab. This cannot be undone. Other open tabs can still save their own drafts.',
    );
    if (!confirmed || state.body !== body || state.draftOwner !== owner || mutationTask || state.busy || state.imagePending) {
        return false;
    }
    try {
        // Only this explicitly confirmed action may supersede conflicting draft versions.
        api.resolveDraft(owner.sessionId, owner.personaId, null);
        unsavedDrafts.delete(JSON.stringify(owner));
        loadDraft(state.session);
        render();
        focusControl('post-composer');
        return state.draftReady;
    } catch (error) {
        report(error.message || 'The draft could not be discarded. Keep this tab open.', 'error');
        return false;
    }
}

async function discardRecovery() {
    const body = state.body;
    if (!body || state.opening || state.busy || mutationTask || sessionTask) {
        return false;
    }
    const confirmed = await globalThis.SillyTavern.getContext().Popup.show.confirm(
        'Discard pending changes and reload?',
        'Export recovery first if you want to keep your changes. This discards this browser\'s pending timeline and settings changes for the signed-in account, across all timelines and tabs, then reloads the saved version. Drafts stay. This cannot be undone. Other open tabs can still save their own changes.',
    );
    if (!confirmed || state.body !== body || state.opening || state.busy || mutationTask || sessionTask) {
        return false;
    }
    clearUndo();
    const task = (async () => {
        await syncingFeed;
        await api.discardRecoveryAndReload();
    })();
    mutationTask = task;
    render();
    try {
        await task;
    } catch (error) {
        if (state.body === body) {
            report(error.message || 'Pending changes could not be discarded. Keep this tab open.', 'error');
        }
        return false;
    } finally {
        if (mutationTask === task) {
            mutationTask = null;
            render();
        }
    }
    // Release the mutation before closing: close waits for pending mutations.
    return state.body === body ? reopenFeed() : true;
}

function recoveryControls() {
    const details = el('details', { className: 'sbtw-recovery', attrs: {
        'data-section-key': 'recovery', open: openSections.get('recovery') || (state.draftOwner && !state.draftReady) ? 'open' : null,
    } }, [
        el('summary', { text: 'Recovery', attrs: { 'data-focus-key': 'recovery' } }),
        el('p', { className: 'sbtw-hint', text: 'Export before discarding anything. The download includes private timeline data and retained draft versions; keep it somewhere safe.' }),
        el('div', { className: 'sbtw-button-row' }, [
            button('Export recovery', 'sbtw-btn', () => void downloadRecovery(), { disabled: state.opening }),
            button('Discard pending changes and reload', 'sbtw-btn sbtw-btn-danger', () => void discardRecovery(), {
                disabled: state.opening || state.busy || Boolean(mutationTask) || Boolean(sessionTask),
            }),
            state.draftOwner ? button('Discard draft versions', 'sbtw-btn sbtw-btn-danger', () => void discardDraft(), {
                disabled: state.opening || state.busy || state.imagePending || Boolean(mutationTask),
            }) : null,
        ]),
    ]);

    const statusLines = el('div', { className: 'sbtw-status-lines' }, [
        el('span', { className: 'sbtw-status', text: state.status, attrs: { role: 'status', 'aria-live': 'polite' } }),
        el('span', { className: 'sbtw-save-status', attrs: { role: 'status', 'aria-live': 'polite' } }),
        retrySaveButton(),
    ]);

    const modeNotice = api.getStorageMode() === 'extension' ? el('p', {
        className: 'sbtw-storage-mode sbtw-hint',
        text: 'Local storage is available in one tab/device at a time. Neconyan’s native storage service enables safe concurrent editing.',
    }) : null;

    const section = el('div', { className: 'sbtw-recovery-section' }, [
        statusLines,
        modeNotice,
        details,
    ]);
    if (details.attributes?.open) {
        section.attributes.open = details.attributes.open;
    }
    return section;
}

function retrySaveButton() {
    const saved = api.getSaveStatus(state.session?.id);
    const hidden = !state.draftError && saved.state !== 'error';
    return button('Retry save', 'sbtw-btn sbtw-btn-quiet', async () => {
        if (mutationTask) {
            return;
        }
        const sessionId = state.session?.id;
        const body = state.body;
        if (!state.draftReady && state.draftOwner) {
            loadDraft(state.session);
            render();
            if (!state.draftReady) {
                return;
            }
        }
        if (state.draftReady && !saveDraft()) {
            return;
        }
        try {
            await api.flushFeed(sessionId);
            if (state.body === body && state.loadFailure?.kind === 'save') {
                await reopenFeed();
            }
        } catch (error) {
            if (state.session?.id === sessionId) {
                report(error.message || 'Changes could not be saved.', 'error');
            }
        }
        patchStatus();
    }, { focusKey: 'retry-save', hidden: hidden ? 'hidden' : null });
}

function statusBar() {
    return composerBar(false);
}

const UNDO_WINDOW = 8000;

/**
 * A toast with a real Undo button. Focus moves onto the button so keyboard users can reach it; toastr
 * keeps a focused toast alive, so the timer is re-armed when focus leaves. Returns false without toastr.
 */
function undoToast(message, undo) {
    const toastr = globalThis.toastr;
    if (!toastr) {
        return false;
    }
    const revision = undoRevision;
    const feed = state.feed;
    const sessionId = state.session?.id;
    let $toast = null;
    const undoButton = button('Undo', 'sbtw-undo-button', () => {
        toastr.clear($toast, { force: true });
        undoToasts.delete($toast);
        if (!mutationTask && revision === undoRevision && state.feed === feed && state.session?.id === sessionId) {
            undo();
        }
    });
    undoButton.addEventListener('blur', () => setTimeout(() => toastr.clear($toast), UNDO_WINDOW));
    const node = el('span', { className: 'sbtw-undo' }, [el('span', { text: message }), undoButton]);
    $toast = toastr.info(node, 'Meower', {
        escapeHtml: false,
        tapToDismiss: false,
        timeOut: UNDO_WINDOW,
        extendedTimeOut: UNDO_WINDOW,
        onHidden: () => undoToasts.delete($toast),
    });
    undoToasts.add($toast);
    undoButton.focus({ preventScroll: true });
    return true;
}

function clearUndo() {
    undoRevision += 1;
    for (const node of undoToasts) {
        globalThis.toastr?.clear(node, { force: true });
    }
    undoToasts.clear();
}

function focusControl(key) {
    state.body?.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

// Bumped on every image pick; a finished upload with a stale token is discarded.
let uploadToken = 0;

// --- feed helpers ---------------------------------------------------------

let accountsByKey = new Map();
let accountsByHandle = new Map();
let currentPersona = null;
let postsById = new Map();
let interactionsById = new Map();
let cachedNotifications = null;

function setAccounts(accounts) {
    state.accounts = accounts;
    accountsByKey = new Map(accounts.map(account => [account.key, account]));
    accountsByHandle = handleIndex(accounts);
    currentPersona = accounts.find(account => account.kind === KIND_PERSONA) ?? null;
}

function accountFor(key) {
    return accountsByKey.get(key) ?? null;
}

function personaAccount() {
    return currentPersona;
}

function nameFor(key, snapshot) {
    return accountFor(key)?.name ?? snapshot?.name ?? 'Unknown';
}

function handleFor(key, snapshot) {
    return accountFor(key)?.handle ?? snapshot?.handle ?? 'unknown';
}

// One pass over the interactions per render, instead of a full scan inside every
// comparator and every post node. Rebuilt at the top of render().
const EMPTY_STATS = { all: [], items: [], like: 0, repost: 0, reply: 0, vote: 0, mine: new Map(), latestReplyAt: 0, onReply: new Map() };
const EMPTY_REPLY_STATS = { items: [], like: 0, repost: 0, reply: 0, mine: new Map() };
let byPost = new Map();

/** A like or repost whose parent is a comment sits on that comment, not on the post. */
function onComment(item) {
    return (item.type === 'like' || item.type === 'repost') && Boolean(item.parentInteractionId);
}

/** The nearest quote above a reply owns it, however deep the reply/repost-comment chain. */
function quoteOwner(item, interactionsById) {
    const seen = new Set();
    let parent = interactionsById.get(item.parentInteractionId);
    while (parent && !seen.has(parent.id)) {
        if (parent.type === 'repost' && parent.content) {
            return parent.id;
        }
        seen.add(parent.id);
        parent = interactionsById.get(parent.parentInteractionId);
    }
    return null;
}

function buildInteractionMap() {
    const map = new Map();
    const me = personaAccount();
    for (const item of state.feed.interactions) {
        let entry = map.get(item.postId);
        if (!entry) {
            entry = { all: [], items: [], like: 0, repost: 0, reply: 0, vote: 0, mine: new Map(), latestReplyAt: 0, onReply: new Map() };
            map.set(item.postId, entry);
        }
        entry.all.push(item);
        const bucketId = onComment(item)
            ? item.parentInteractionId
            : item.type === 'reply' ? quoteOwner(item, interactionsById) : null;
        if (bucketId) {
            let bucket = entry.onReply.get(bucketId);
            if (!bucket) {
                bucket = { items: [], like: 0, repost: 0, reply: 0, mine: new Map() };
                entry.onReply.set(bucketId, bucket);
            }
            bucket.items.push(item);
            bucket[item.type] += 1;
            if (me && item.actorKey === me.key) {
                bucket.mine.set(item.type, item);
            }
            continue;
        }
        entry.items.push(item);
        entry[item.type] += 1;
        if (me && item.actorKey === me.key) {
            entry.mine.set(item.type, item);
        }
        // Only other people's replies bump a conversation in Main: your own answer must not
        // fling the post you are reading to the top of the list.
        if (item.type === 'reply' && item.actorKey !== me?.key && item.createdAt > entry.latestReplyAt) {
            entry.latestReplyAt = item.createdAt;
        }
    }
    return map;
}

function statsFor(postId) {
    return byPost.get(postId) ?? EMPTY_STATS;
}

function interactionsFor(postId) {
    return statsFor(postId).items;
}

function allInteractionsFor(postId) {
    return statsFor(postId).all;
}

function countOf(postId, type) {
    return statsFor(postId)[type] ?? 0;
}

function myInteraction(postId, type) {
    return statsFor(postId).mine.get(type) ?? null;
}

function replyStatsFor(postId, replyId) {
    return statsFor(postId).onReply.get(replyId) ?? EMPTY_REPLY_STATS;
}

/** The comment with this id on this post: a reply, or a quote of it. Quote replies live in the quote's own bucket. */
function answerableOn(postId, id) {
    const item = interactionsById.get(id);
    return item?.postId === postId && isAnswerable(item) ? item : null;
}

/** Only replies bump a conversation; likes and votes must not reorder the timeline. */
function activityAt(post) {
    return Math.max(post.createdAt, statsFor(post.id).latestReplyAt);
}

function followingKeys() {
    const me = personaAccount();
    return new Set(me ? (state.session?.follows[me.key] ?? []) : []);
}

// Main's order is frozen between refreshes: likes and replies change the scores, and a
// feed that reorders under your finger is exactly the jump we avoid. Entries that appear
// in between (your own posts) sit on top, newest first.
let mainRank = { key: '', order: new Map() };

function entryKey(entry) {
    return entry.repost ? `repost:${entry.repost.id}` : `post:${entry.post.id}`;
}

/** Keep the initial page bounded, but always include the exact entry the reader opened. */
export function pageItems(items, limit, target = null) {
    const page = items.slice(0, limit);
    if (target && items.includes(target) && !page.includes(target)) {
        page.unshift(target);
    }
    return page;
}

function moreButton(key, total, shown, step, label = 'Show more') {
    return total > shown ? button(`${label} (${total - shown} more)`, 'sbtw-btn sbtw-btn-quiet sbtw-more', (event) => {
        const neighbour = event.currentTarget.previousElementSibling ?? event.currentTarget.nextElementSibling;
        const anchor = neighbour?.matches('[data-post-id], [data-reply-id], [data-repost-id]') ? anchorSelector(neighbour) : '';
        listLimits.set(key, (listLimits.get(key) ?? step) + step);
        render();
        if (anchor && !state.body?.querySelector(`[data-focus-key="${CSS.escape(`more:${key}`)}"]`)) {
            state.body?.querySelector(anchor)?.focus({ preventScroll: true });
        }
    }, { focusKey: `more:${key}` }) : null;
}

function targetEntryKey(target) {
    const item = target?.interactionId ? answerableOn(target.postId, target.interactionId) : null;
    const quoteId = item?.type === 'repost' ? item.id : item ? quoteOwner(item, interactionsById) : null;
    return quoteId ? `repost:${quoteId}` : `post:${target?.postId}`;
}

/** How often the persona has liked, replied to or reposted each author: a cheap stand-in for "accounts you interact with". */
function authorAffinity(me) {
    const map = new Map();
    if (!me) {
        return map;
    }
    const authorOf = new Map(state.feed.posts.map(post => [post.id, post.authorKey]));
    for (const item of state.feed.interactions) {
        const author = item.actorKey === me.key && item.type !== 'vote' ? authorOf.get(item.postId) : null;
        if (author && author !== me.key) {
            map.set(author, (map.get(author) ?? 0) + 1);
        }
    }
    return map;
}

function mainComparator(entries, me, following) {
    const key = `${state.session?.id ?? ''}|${state.feedEpoch}`;
    if (mainRank.key !== key) {
        const affinity = authorAffinity(me);
        const handle = me ? handleFor(me.key) : '';
        const now = Date.now();
        for (const entry of entries) {
            const stats = statsFor(entry.post.id);
            const actorKey = entry.repost ? entry.repost.actorKey : entry.post.authorKey;
            entry.score = rankScore({
                createdAt: entry.repost ? entry.repost.createdAt : entry.post.createdAt,
                latestActivityAt: entry.repost ? 0 : stats.latestReplyAt,
                like: entry.repost ? 0 : stats.like,
                reply: entry.repost ? 0 : stats.reply,
                repost: entry.repost ? 0 : stats.repost,
                vote: entry.repost ? 0 : stats.vote,
                followed: following.has(actorKey),
                mine: Boolean(me) && actorKey === me.key,
                mentionsMe: mentionsHandle(entry.repost?.content ?? entry.post.body, handle),
                affinity: affinity.get(actorKey) ?? 0,
            }, now);
        }
        discountRepeatAuthors(entries, entry => entry.repost ? entry.repost.actorKey : entry.post.authorKey);
        const ranked = [...entries].sort((a, b) => (b.score - a.score) || (b.sortAt - a.sortAt));
        mainRank = { key, order: new Map(ranked.map((entry, index) => [entryKey(entry), index])) };
    }
    const order = mainRank.order;
    return (a, b) => {
        const ra = order.get(entryKey(a));
        const rb = order.get(entryKey(b));
        if (ra === undefined || rb === undefined) {
            return ra === undefined && rb === undefined ? b.sortAt - a.sortAt : (ra === undefined ? -1 : 1);
        }
        return ra - rb;
    };
}

function visibleTimelineEntries(query = state.timelineSearch) {
    query = String(query ?? '').trim();
    const me = personaAccount();
    const following = followingKeys();
    const relevantReposters = new Set([...following, ...(me ? [me.key] : [])]);
    const entries = state.feed.posts.map((post) => {
        const repost = state.tab === 'following'
            ? interactionsFor(post.id)
                .filter(item => item.type === 'repost' && relevantReposters.has(item.actorKey))
                .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
            : null;
        return {
            post,
            repost,
            // Latest is strictly newest first; everywhere else a reply bumps the conversation.
            sortAt: state.tab === 'latest' ? post.createdAt : Math.max(activityAt(post), repost?.createdAt ?? 0),
        };
    }).filter(({ post, repost }) => state.tab !== 'following'
        || post.authorKey === me?.key
        || following.has(post.authorKey)
        || repost);

    // A reposted comment is its own entry, carrying the comment: in Following when the
    // reposter is you or someone you follow, like a plain repost of a post.
    if (state.tab === 'following') {
        for (const post of state.feed.posts) {
            for (const [replyId, bucket] of statsFor(post.id).onReply) {
                const repost = bucket.items
                    .filter(item => item.type === 'repost' && relevantReposters.has(item.actorKey))
                    .sort((a, b) => b.createdAt - a.createdAt)[0];
                const reply = repost ? answerableOn(post.id, replyId) : null;
                if (reply) {
                    entries.push({ post, reply, repost, sortAt: repost.createdAt });
                }
            }
        }
    }

    // A repost with a comment is a quote: it gets its own entry in Main and Latest, as on the real thing.
    if (state.tab === 'main' || state.tab === 'latest') {
        for (const item of state.feed.interactions) {
            if (item.type === 'repost' && item.content && postsById.has(item.postId)) {
                const reply = item.parentInteractionId ? answerableOn(item.postId, item.parentInteractionId) : null;
                if (item.parentInteractionId && !reply) {
                    continue;
                }
                entries.push({ post: postsById.get(item.postId), reply, repost: item, sortAt: item.createdAt });
            }
        }
    }

    // Trending: the most talked-about posts of the last two days, most engaged first.
    if (state.tab === 'trending') {
        const since = Date.now() - RECENT_WINDOW_HOURS * 3600 * 1000;
        for (const entry of entries) {
            entry.score = engagementScore(statsFor(entry.post.id));
        }
        const trending = entries
            .filter(entry => entry.score > 0 && entry.sortAt >= since)
            .filter(({ post }) => matchesTimelineSearch(post, query))
            .sort((a, b) => (b.score - a.score) || (b.sortAt - a.sortAt));
        return { entries: pageItems(trending, listLimits.get(`timeline:${state.tab}:${query}`) ?? FEED_LIMIT), total: trending.length };
    }

    const order = state.tab === 'main' ? mainComparator(entries, me, following) : (a, b) => b.sortAt - a.sortAt;
    const matches = entries
        .filter(({ post }) => matchesTimelineSearch(post, query))
        .sort(order);
    const target = state.revealTarget ?? (state.replyingTo
        ? { postId: state.replyingTo.postId, interactionId: state.replyingTo.parentInteractionId } : null);
    const wanted = targetEntryKey(target);
    const pinned = !query && target ? matches.find(entry => entryKey(entry) === wanted)
        ?? (state.tab === 'following' ? matches.find(entry => entry.post.id === target.postId && !entry.repost?.content
            && (entry.reply ? entry.reply.id === target.interactionId : wanted === `post:${target.postId}`)) : null) : null;
    const visible = pageItems(matches, listLimits.get(`timeline:${state.tab}:${query}`) ?? FEED_LIMIT, pinned);
    return { entries: visible, total: matches.length };
}

/** Search every rendered comment, using live account names instead of stale snapshots. */
function matchesTimelineSearch(post, query) {
    if (!String(query ?? '').trim()) {
        return true;
    }
    const comments = allInteractionsFor(post.id)
        .filter(item => item.type === 'reply' || (item.type === 'repost' && item.content))
        .map(item => ({
            ...item,
            actorSnapshot: accountFor(item.actorKey) ?? item.actorSnapshot,
        }));
    return matchesTimelineQuery({
        ...post,
        authorSnapshot: accountFor(post.authorKey) ?? post.authorSnapshot,
    }, comments, query);
}

function persist() {
    try {
        state.feed.interactions = reconcileInteractions(state.feed.posts, state.feed.interactions);
        api.saveFeedDebounced(state.feed, 1200, state.session.id);
        return true;
    } catch (error) {
        report(error.message || 'Changes could not be saved.', 'error');
        return false;
    }
}

// --- rendering ------------------------------------------------------------

function avatarNode(account, size = 'md') {
    const url = account ? api.avatarUrl(account) : '';
    if (url) {
        return el('img', {
            className: `sbtw-avatar sbtw-avatar-${size}`,
            attrs: { src: url, alt: '', loading: 'lazy', decoding: 'async' },
        });
    }
    const name = account?.name ?? '?';
    const initials = name.split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase() || '?';
    return el('span', { className: `sbtw-avatar sbtw-avatar-${size} sbtw-avatar-initials`, text: initials });
}

/** An avatar you can tap to open that account's profile, where the name is not the only way there. */
function avatarButton(account, size, key) {
    const name = account?.name ?? 'Unknown';
    return el('button', {
        className: 'sbtw-avatar-button',
        attrs: { type: 'button', title: `${name}'s profile`, 'aria-label': `${name}'s profile`, 'data-focus-key': `avatar:${key}` },
        on: { click: () => showProfile(key) },
    }, [avatarNode(account, size)]);
}

/** Entering the timeline freezes its seen-mark, so what arrived since the last visit stays marked while it is read. */
function markTimelineVisit() {
    state.timelineSeenBefore = state.session?.timelineSeenAt ?? 0;
}

/** Arrived since the last visit, and not written by you. */
function isNewToMe(item, authorKey) {
    const me = personaAccount();
    return item.createdAt > state.timelineSeenBefore && authorKey !== me?.key;
}

function newDot() {
    return el('span', { className: 'sbtw-new-dot', attrs: { role: 'img', title: 'New since your last visit', 'aria-label': 'New since your last visit' } });
}

/** Renders body text as text nodes, turning @handles that match a real account into links. */
function bodyNode(text) {
    const fragment = document.createDocumentFragment();
    const pattern = /(^|[^a-z0-9_])@([a-z0-9_]{1,20})(?![a-z0-9_])/gi;
    let cursor = 0;
    for (const match of String(text ?? '').matchAll(pattern)) {
        const account = accountsByHandle.get(match[2].toLowerCase());
        if (!account) {
            continue;
        }
        const mentionAt = match.index + match[1].length;
        if (mentionAt > cursor) {
            fragment.append(document.createTextNode(text.slice(cursor, mentionAt)));
        }
        fragment.append(el('button', {
            className: 'sbtw-mention',
            text: `@${account.handle}`,
            attrs: { type: 'button', 'data-focus-key': `mention:${account.key}:${mentionAt}` },
            on: { click: () => showProfile(account.key) },
        }));
        cursor = match.index + match[0].length;
    }
    if (cursor < String(text ?? '').length) {
        fragment.append(document.createTextNode(text.slice(cursor)));
    }
    return fragment;
}

/** Who picked this option: a pile of small avatars, named by the tooltip and for screen readers. */
function pollVotersNode(voters) {
    if (!voters.length) {
        return null;
    }
    const names = voters.map(vote => `${nameFor(vote.actorKey, vote.actorSnapshot)} (@${handleFor(vote.actorKey, vote.actorSnapshot)})`);
    const label = `Voted by ${names.join(', ')}`;
    return el('span', {
        className: 'sbtw-poll-voters',
        attrs: { role: 'img', 'aria-label': label, title: label },
    }, voters.map(vote => avatarNode(accountFor(vote.actorKey) ?? vote.actorSnapshot ?? null, 'xs')));
}

function pollNode(post) {
    if (!post.poll) {
        return null;
    }
    const votes = interactionsFor(post.id).filter(item => item.type === 'vote');
    const mine = myInteraction(post.id, 'vote');
    const total = votes.length;
    const rows = post.poll.options.map((option, index) => {
        const voters = votes.filter(vote => vote.pollOptionIndex === index);
        const count = voters.length;
        const share = total ? Math.round((count / total) * 100) : 0;
        const selected = mine?.pollOptionIndex === index;
        const bar = el('span', { className: 'sbtw-poll-bar' });
        bar.style.setProperty('--sbtw-poll-share', String(share / 100));
        const row = el('button', {
            className: `sbtw-poll-option${selected ? ' sbtw-poll-mine' : ''}`,
            attrs: {
                type: 'button',
                'aria-pressed': String(selected),
                'aria-label': `${option.text}, ${plural(count, 'vote')}${total ? `, ${share}%` : ''}${selected ? ', your vote; activate to withdraw' : ', activate to vote'}`,
                title: selected ? 'Withdraw your vote' : null,
                'data-focus-key': `poll:${post.id}:${index}`,
                disabled: personaAccount() && !mutationTask ? null : 'disabled',
            },
            on: { click: () => vote(post, index) },
        }, [
            bar,
            el('span', { className: 'sbtw-poll-text', text: option.text }),
            pollVotersNode(voters),
            el('span', { className: 'sbtw-poll-share', text: total ? `${share}%` : '' }),
        ]);
        return row;
    });
    return el('div', { className: 'sbtw-poll' }, [
        post.poll.question ? el('div', { className: 'sbtw-poll-question', text: post.poll.question }) : null,
        ...rows,
        el('div', { className: 'sbtw-poll-total', text: total === 1 ? '1 vote' : `${total} votes` }),
    ]);
}

function imageNode(post) {
    if (!post.image?.url) {
        return null;
    }
    // Known dimensions reserve the box before the image arrives, so a re-render cannot shift
    // everything below it once it loads. Measured on first sight and saved with the post.
    const feed = state.feed;
    const sessionId = state.session?.id;
    const img = el('img', { attrs: { src: post.image.url, alt: post.image.prompt ?? '', loading: 'lazy', width: post.image.width || null, height: post.image.height || null } });
    if (!post.image.width) {
        img.addEventListener('load', () => {
            if (img.naturalWidth && img.naturalHeight && !post.image.width
                && !mutationTask && img.isConnected && state.body?.isConnected && state.feed === feed
                && state.session?.id === sessionId) {
                post.image.width = img.naturalWidth;
                post.image.height = img.naturalHeight;
                api.saveFeedDebounced(feed, 1200, sessionId);
            }
        }, { once: true });
    }
    return el('button', {
        className: 'sbtw-image',
        attrs: { type: 'button', title: 'Open image', 'aria-label': post.image.prompt ? `Open image: ${post.image.prompt}` : 'Open image', 'data-focus-key': `image:${post.id}` },
        on: { click: () => openImage(post.image.url, post.image.prompt) },
    }, [img]);
}

const replyDrafts = new Map();
let pendingReplyFocus = null;
let replyFocusScope = '';

/**
 * iOS: the host's Safari patch (browser-fixes.js → mobile-shell-lifecycle) cancels every
 * horizontal touch pan inside the chat chrome unless the scroller is on its hard-coded list
 * of rails, and an extension cannot get on that list. Its handler sits on document in the
 * capture phase; window capture runs first, so a sideways swipe that starts in the trend
 * row is kept from reaching it. Nothing is prevented: the row still scrolls natively.
 */
let trendPanGuard = null;
function installTrendPanGuard() {
    if (trendPanGuard || typeof window === 'undefined') {
        return;
    }
    let start = null;
    const touchstart = (event) => {
        const touch = event.touches?.[0];
        const inRow = touch && event.target instanceof Element && event.target.closest('.sbtw-trends');
        start = inRow && event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const touchmove = (event) => {
        if (!start || event.touches?.length !== 1) {
            return;
        }
        const touch = event.touches[0];
        if (Math.abs(touch.clientX - start.x) > Math.abs(touch.clientY - start.y)) {
            event.stopPropagation();
        }
    };
    const clear = () => { start = null; };
    trendPanGuard = { touchstart, touchmove, clear };
    window.addEventListener('touchstart', touchstart, { capture: true, passive: true });
    window.addEventListener('touchmove', touchmove, { capture: true, passive: true });
    window.addEventListener('touchend', clear, { capture: true, passive: true });
    window.addEventListener('touchcancel', clear, { capture: true, passive: true });
}

function removeTrendPanGuard() {
    if (!trendPanGuard || typeof window === 'undefined') {
        return;
    }
    window.removeEventListener('touchstart', trendPanGuard.touchstart, true);
    window.removeEventListener('touchmove', trendPanGuard.touchmove, true);
    window.removeEventListener('touchend', trendPanGuard.clear, true);
    window.removeEventListener('touchcancel', trendPanGuard.clear, true);
    trendPanGuard = null;
}

function replyTargetKey(target) {
    return JSON.stringify([target.postId, target.parentInteractionId ?? null]);
}

function isReplyTarget(postId, parentInteractionId = null) {
    return state.replyingTo?.postId === postId
        && state.replyingTo?.parentInteractionId === parentInteractionId;
}

function setReplyTarget(postId, parentInteractionId = null, { toggle = true } = {}) {
    const target = { postId, parentInteractionId };
    const same = isReplyTarget(postId, parentInteractionId);
    if (toggle && same) {
        state.replyingTo = null;
        pendingReplyFocus = null;
    } else {
        state.replyingTo = target;
        state.revealTarget = { postId, interactionId: parentInteractionId };
        pendingReplyFocus = replyTargetKey(target);
        const card = document.activeElement?.closest('[data-post-id], [data-repost-id], [data-reply-id]');
        replyFocusScope = card ? anchorSelector(card) : '';
    }
    render();
}

/** One action on a post or a comment. With `who`, the count is its own button that opens the list of who did it. */
function actionButton(ownerId, me, iconName, count, active, onClick, label, who = null) {
    const button = el('button', {
        className: `sbtw-action${active ? ' sbtw-action-on' : ''}`,
        attrs: {
            type: 'button',
            title: label,
            'aria-label': label,
            'aria-pressed': String(active),
            'data-focus-key': `action:${ownerId}:${iconName}`,
            disabled: me && !mutationTask ? null : 'disabled',
        },
        on: { click: onClick },
    }, [icon(iconName)]);
    if (!(count > 0)) {
        return button;
    }
    if (!who) {
        button.append(el('span', { className: 'sbtw-action-count', text: String(count) }));
        return button;
    }
    // The count is its own button: tap it to see who did this, without toggling your own like.
    const key = `${ownerId}:${who}`;
    const open = state.engagementFor === key;
    const countButton = el('button', {
        className: `sbtw-action-count sbtw-action-who${open ? ' sbtw-action-who-on' : ''}`,
        text: String(count),
        attrs: { type: 'button', title: who === 'like' ? 'See who liked this' : 'See who reposted this', 'aria-label': `${count} ${who === 'like' ? 'likes' : 'reposts'}, see who`, 'aria-expanded': String(open), 'data-focus-key': `engagement:${ownerId}:${who}` },
        on: { click: () => { state.engagementFor = open ? null : key; render(); } },
    });
    return el('span', { className: 'sbtw-action-group' }, [button, countButton]);
}

function actionsNode(post) {
    const me = personaAccount();
    const liked = Boolean(myInteraction(post.id, 'like'));
    const reposted = Boolean(myInteraction(post.id, 'repost'));
    const replies = countOf(post.id, 'reply');
    const action = (...args) => actionButton(post.id, me, ...args);

    return el('div', { className: 'sbtw-actions' }, [
        action('fa-heart', countOf(post.id, 'like'), liked, () => toggle(post.id, 'like'), liked ? 'Unlike' : 'Like', 'like'),
        action('fa-retweet', countOf(post.id, 'repost'), reposted, () => toggle(post.id, 'repost'), reposted ? 'Undo repost' : 'Repost', 'repost'),
        action('fa-comment', replies, isReplyTarget(post.id), () => setReplyTarget(post.id), 'Reply'),
    ]);
}

/** Who liked or reposted a post, shown under its actions while the count is open. */
function engagementNode(ownerId, interactions) {
    const key = String(state.engagementFor ?? '');
    if (!key.startsWith(`${ownerId}:`)) {
        return null;
    }
    const type = key.slice(ownerId.length + 1);
    const items = interactions
        .filter(item => item.type === type)
        .sort((a, b) => b.createdAt - a.createdAt);
    const title = type === 'like' ? 'Liked by' : 'Reposted by';
    return el('div', { className: 'sbtw-engagement', attrs: { role: 'region', 'aria-label': title } }, [
        el('div', { className: 'sbtw-engagement-title', text: title }),
        ...(items.length ? items.map((item) => {
            const account = accountFor(item.actorKey) ?? item.actorSnapshot ?? null;
            return el('div', { className: 'sbtw-engagement-row' }, [
                avatarButton(account, 'sm', item.actorKey),
                el('button', {
                    className: 'sbtw-name',
                    text: nameFor(item.actorKey, item.actorSnapshot),
                    attrs: { type: 'button', 'data-focus-key': `name:${item.actorKey}` },
                    on: { click: () => showProfile(item.actorKey) },
                }),
                el('span', { className: 'sbtw-handle', text: `@${handleFor(item.actorKey, item.actorSnapshot)}` }),
            ]);
        }) : [el('div', { className: 'sbtw-hint', text: 'Nobody yet.' })]),
    ]);
}

function replyNode(reply) {
    const parent = reply.parentInteractionId
        ? interactionsById.get(reply.parentInteractionId)
        : null;
    const account = accountFor(reply.actorKey);
    const me = personaAccount();
    const handle = handleFor(reply.actorKey, reply.actorSnapshot);
    const targeted = isReplyTarget(reply.postId, reply.id);
    const stats = replyStatsFor(reply.postId, reply.id);
    const liked = Boolean(stats.mine.get('like'));
    const reposted = Boolean(stats.mine.get('repost'));
    const fresh = isNewToMe(reply, reply.actorKey);
    return el('div', { className: `sbtw-reply${fresh ? ' sbtw-reply-new' : ''}`, attrs: { 'data-kind': reply.actorSnapshot?.kind ?? '', 'data-reply-id': reply.id, 'data-focus-key': `comment:${reply.id}`, tabindex: '-1' } }, [
        // The avatar shares a row with the name block so it stays centred on it even when the time wraps.
        el('div', { className: 'sbtw-reply-head' }, [
            avatarButton(account ?? reply.actorSnapshot ?? null, 'sm', reply.actorKey),
            el('div', { className: 'sbtw-meta' }, [
                fresh ? newDot() : null,
                el('button', {
                    className: 'sbtw-name',
                    text: nameFor(reply.actorKey, reply.actorSnapshot),
                    attrs: { type: 'button', 'data-focus-key': `name:${reply.actorKey}` },
                    on: { click: () => showProfile(reply.actorKey) },
                }),
                el('span', { className: 'sbtw-handle', text: `@${handle}` }),
                el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(reply.createdAt)) }),
            ]),
        ]),
        el('div', { className: 'sbtw-reply-main' }, [
            parent
                ? el('div', {
                    className: 'sbtw-replying',
                    text: `${reply.type === 'repost' ? 'Quoting' : 'Replying to'} @${handleFor(parent.actorKey, parent.actorSnapshot)}`,
                })
                : null,
            el('div', { className: 'sbtw-body' }, [bodyNode(reply.content)]),
            el('div', { className: 'sbtw-reply-actions' }, [
                actionButton(reply.id, me, 'fa-heart', stats.like, liked, () => toggle(reply.postId, 'like', reply), liked ? 'Unlike' : 'Like', 'like'),
                actionButton(reply.id, me, 'fa-retweet', stats.repost, reposted, () => toggle(reply.postId, 'repost', reply), reposted ? 'Undo repost' : 'Repost', 'repost'),
                me ? button('Reply', `sbtw-action${targeted ? ' sbtw-action-on' : ''}`,
                    () => setReplyTarget(reply.postId, reply.id), {
                        iconName: 'fa-comment',
                        ariaLabel: `Reply to @${handle}`,
                        pressed: targeted,
                        focusKey: `reply:${reply.id}`,
                    }) : null,
                me?.key === reply.actorKey
                    ? button('Delete', 'sbtw-action sbtw-action-danger', () => deleteReply(reply), {
                        iconName: 'fa-trash',
                        ariaLabel: 'Delete your reply',
                        focusKey: `delete-reply:${reply.id}`,
                        disabled: Boolean(mutationTask),
                    })
                    : null,
            ]),
            engagementNode(reply.id, stats.items),
            targeted ? replyComposer(postsById.get(reply.postId)) : null,
        ]),
    ]);
}

function repliesNode(postId, ownerId, interactions) {
    const replies = interactions.filter(item => item.type === 'reply').sort((a, b) => b.createdAt - a.createdAt);
    if (!replies.length) {
        return null;
    }
    const key = `replies:${postId}:${ownerId}`;
    const targetId = state.replyingTo?.postId === postId ? state.replyingTo.parentInteractionId
        : state.revealTarget?.postId === postId ? state.revealTarget.interactionId : null;
    const shown = pageItems(replies, listLimits.get(key) ?? REPLY_LIMIT, replies.find(item => item.id === targetId));
    return el('div', { className: 'sbtw-replies' }, [
        moreButton(key, replies.length, shown.length, REPLY_LIMIT, 'Show earlier replies'),
        ...shown.sort((a, b) => a.createdAt - b.createdAt).map(replyNode),
    ]);
}

/** Someone reposted a comment: the reposter speaks first if they added a comment, then the comment, then the post it was on. */
function repostedReplyNode({ post, reply, repost }) {
    const actor = accountFor(repost.actorKey);
    const me = personaAccount();
    const stats = replyStatsFor(post.id, repost.id);
    const liked = Boolean(stats.mine.get('like'));
    const reposted = Boolean(stats.mine.get('repost'));
    const targeted = isReplyTarget(post.id, repost.id);
    return el('article', { className: 'sbtw-post sbtw-reply-repost', attrs: { 'data-repost-id': repost.id, 'data-focus-key': `quote:${repost.id}`, tabindex: '-1' } }, [
        el('div', { className: 'sbtw-repost-context' }, [
            icon('fa-retweet'),
            el('span', { text: `${nameFor(repost.actorKey, repost.actorSnapshot)} reposted a reply${repost.content ? ' with a comment' : ''}` }),
        ]),
        repost.content ? el('div', { className: 'sbtw-post-row' }, [
            avatarButton(actor ?? repost.actorSnapshot ?? null, 'md', repost.actorKey),
            el('div', { className: 'sbtw-post-main' }, [
                el('div', { className: 'sbtw-meta' }, [
                    el('button', {
                        className: 'sbtw-name',
                        text: nameFor(repost.actorKey, repost.actorSnapshot),
                        attrs: { type: 'button', 'data-focus-key': `name:${repost.actorKey}` },
                        on: { click: () => showProfile(repost.actorKey) },
                    }),
                    el('span', { className: 'sbtw-handle', text: `@${handleFor(repost.actorKey, repost.actorSnapshot)}` }),
                    el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(repost.createdAt)) }),
                ]),
                el('div', { className: 'sbtw-body' }, [bodyNode(repost.content)]),
            ]),
        ]) : null,
        replyNode(reply),
        el('div', { className: 'sbtw-quote-card' }, [postNode(post, null, { compact: true })]),
        repost.content ? el('div', { className: 'sbtw-actions' }, [
            actionButton(repost.id, me, 'fa-heart', stats.like, liked, () => toggle(post.id, 'like', repost), liked ? 'Unlike' : 'Like', 'like'),
            actionButton(repost.id, me, 'fa-retweet', stats.repost, reposted, () => toggle(post.id, 'repost', repost), reposted ? 'Undo repost' : 'Repost', 'repost'),
            actionButton(repost.id, me, 'fa-comment', stats.reply, targeted, () => setReplyTarget(post.id, repost.id), 'Reply'),
        ]) : null,
        repost.content ? engagementNode(repost.id, stats.items) : null,
        repost.content && targeted ? replyComposer(post) : null,
        repost.content ? repliesNode(post.id, repost.id, stats.items) : null,
    ]);
}

/** A post card. `compact` is the embedded form inside a quote: no actions, replies or delete, and no scroll anchor. */
function postNode(post, repost = null, { compact = false } = {}) {
    if (repost?.content && !compact) {
        return quoteNode(post, repost);
    }
    const account = accountFor(post.authorKey);
    const me = personaAccount();
    const mine = me && post.authorKey === me.key && !compact;
    const fresh = !compact && isNewToMe(post, post.authorKey);
    return el('article', { className: `sbtw-post${compact ? ' sbtw-post-compact' : ''}${fresh ? ' sbtw-post-new' : ''}`, attrs: compact ? {} : { 'data-post-id': post.id, 'data-focus-key': `post:${post.id}`, tabindex: '-1' } }, [
        repost ? el('div', { className: 'sbtw-repost-context' }, [
            icon('fa-retweet'),
            el('span', { text: `${nameFor(repost.actorKey, repost.actorSnapshot)} reposted` }),
        ]) : null,
        el('div', { className: 'sbtw-post-row' }, [
            avatarButton(account ?? post.authorSnapshot ?? null, compact ? 'sm' : 'md', post.authorKey),
            el('div', { className: 'sbtw-post-main' }, [
                el('div', { className: 'sbtw-meta' }, [
                    // The dot leads the row: the name block wraps on a phone, and a trailing dot ends up stranded on a line of its own.
                    fresh ? newDot() : null,
                    el('button', {
                        className: 'sbtw-name',
                        text: nameFor(post.authorKey, post.authorSnapshot),
                        attrs: { type: 'button', 'data-focus-key': `name:${post.authorKey}` },
                        on: { click: () => showProfile(post.authorKey) },
                    }),
                    el('span', { className: 'sbtw-handle', text: `@${handleFor(post.authorKey, post.authorSnapshot)}` }),
                    el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(post.createdAt)) }),
                    mine
                        ? el('button', {
                            className: 'sbtw-delete',
                            attrs: { type: 'button', title: 'Delete post', 'aria-label': 'Delete post', 'data-focus-key': `delete-post:${post.id}`, disabled: mutationTask ? 'disabled' : null },
                            on: { click: () => deletePost(post) },
                        }, [icon('fa-trash-can')])
                        : null,
                ]),
                el('div', { className: 'sbtw-body' }, [bodyNode(post.body)]),
                pollNode(post),
                imageNode(post),
                compact ? null : actionsNode(post),
                compact ? null : engagementNode(post.id, interactionsFor(post.id)),
                !compact && isReplyTarget(post.id) ? replyComposer(post) : null,
                compact ? null : repliesNode(post.id, post.id, interactionsFor(post.id)),
            ]),
        ]),
    ]);
}

/** A repost with a comment: the reposter speaks, and the original sits in a card underneath. */
function quoteNode(post, repost) {
    const actor = accountFor(repost.actorKey);
    const me = personaAccount();
    const stats = replyStatsFor(post.id, repost.id);
    const liked = Boolean(stats.mine.get('like'));
    const reposted = Boolean(stats.mine.get('repost'));
    const targeted = isReplyTarget(post.id, repost.id);
    return el('article', { className: 'sbtw-post sbtw-quote', attrs: { 'data-repost-id': repost.id, 'data-focus-key': `quote:${repost.id}`, tabindex: '-1' } }, [
        el('div', { className: 'sbtw-repost-context' }, [
            icon('fa-retweet'),
            el('span', { text: `${nameFor(repost.actorKey, repost.actorSnapshot)} reposted with a comment` }),
        ]),
        el('div', { className: 'sbtw-post-row' }, [
            avatarButton(actor ?? repost.actorSnapshot ?? null, 'md', repost.actorKey),
            el('div', { className: 'sbtw-post-main' }, [
                el('div', { className: 'sbtw-meta' }, [
                    el('button', {
                        className: 'sbtw-name',
                        text: nameFor(repost.actorKey, repost.actorSnapshot),
                        attrs: { type: 'button', 'data-focus-key': `name:${repost.actorKey}` },
                        on: { click: () => showProfile(repost.actorKey) },
                    }),
                    el('span', { className: 'sbtw-handle', text: `@${handleFor(repost.actorKey, repost.actorSnapshot)}` }),
                    el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(repost.createdAt)) }),
                ]),
                el('div', { className: 'sbtw-body' }, [bodyNode(repost.content)]),
                el('div', { className: 'sbtw-quote-card' }, [postNode(post, null, { compact: true })]),
                // A quote is its own little post: it can be liked, reposted and answered like one.
                el('div', { className: 'sbtw-actions' }, [
                    actionButton(repost.id, me, 'fa-heart', stats.like, liked, () => toggle(post.id, 'like', repost), liked ? 'Unlike' : 'Like', 'like'),
                    actionButton(repost.id, me, 'fa-retweet', stats.repost, reposted, () => toggle(post.id, 'repost', repost), reposted ? 'Undo repost' : 'Repost', 'repost'),
                    actionButton(repost.id, me, 'fa-comment', stats.reply, targeted, () => setReplyTarget(post.id, repost.id), 'Reply'),
                ]),
                engagementNode(repost.id, stats.items),
                targeted ? replyComposer(post) : null,
                repliesNode(post.id, repost.id, stats.items),
            ]),
        ]),
    ]);
}

function replyComposer(post) {
    if (!state.draftReady) {
        return el('p', { className: 'sbtw-hint', text: 'Your saved draft needs attention. Use Recovery in Settings to export it before discarding any versions.' });
    }
    const me = personaAccount();
    const target = state.replyingTo ?? { postId: post.id, parentInteractionId: null };
    const parent = target.parentInteractionId ? answerableOn(post.id, target.parentInteractionId) : null;
    const key = replyTargetKey(target);
    const parentHandle = parent ? handleFor(parent.actorKey, parent.actorSnapshot) : '';
    const field = el('textarea', {
        className: 'sbtw-input',
        attrs: {
            rows: '2',
            maxlength: String(REPLY_MAX_CHARS),
            placeholder: parentHandle ? `Reply to @${parentHandle}...` : `Reply as ${me?.name ?? 'you'}...`,
            'data-focus-key': `reply-composer:${key}`,
            'aria-label': parentHandle
                ? `Reply to @${parentHandle} as ${me?.name ?? 'you'}`
                : `Reply as ${me?.name ?? 'you'}`,
        },
    });
    // The draft survives re-renders; focus is only claimed when the composer opens.
    field.value = replyDrafts.get(key) ?? '';
    field.addEventListener('input', () => {
        if (field.value) {
            replyDrafts.set(key, field.value);
        } else {
            replyDrafts.delete(key);
        }
        saveDraft();
    });
    field.addEventListener('keydown', (event) => {
        if (!event.isComposing && event.keyCode !== 229 && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            event.stopPropagation();
            send.click();
        }
    });
    attachMentionPicker(field);
    const send = button('Reply', 'sbtw-btn sbtw-btn-primary', () => {
        const text = field.value.trim();
        if (!text) {
            return;
        }
        addReply(post, text, target.parentInteractionId);
    }, { focusKey: `send-reply:${key}`, disabled: Boolean(mutationTask) });
    return el('div', { className: 'sbtw-reply-composer' }, [
        parent ? el('div', { className: 'sbtw-replying', text: `Replying to @${parentHandle}` }) : null,
        field,
        el('div', { className: 'sbtw-composer-bar' }, [send]),
    ]);
}

/**
 * Typing @ in a composer lists the accounts this session knows (persona, invited
 * characters, ambient strangers); arrows move, Enter or Tab inserts `@handle `, Escape closes.
 */
let mentionPickerId = 0;
function attachMentionPicker(field) {
    let list = null;
    let items = [];
    let active = 0;
    let composing = false;
    const listId = `sbtw-mentions-${++mentionPickerId}`;
    field.setAttribute('role', 'combobox');
    field.setAttribute('aria-autocomplete', 'list');
    field.setAttribute('aria-haspopup', 'listbox');
    field.setAttribute('aria-expanded', 'false');
    const close = () => {
        list?.remove();
        list = null;
        items = [];
        field.setAttribute('aria-expanded', 'false');
        field.removeAttribute('aria-controls');
        field.removeAttribute('aria-activedescendant');
    };
    const apply = (account) => {
        const query = mentionQueryAt(field.value, field.selectionStart ?? field.value.length);
        if (!query || !account) {
            close();
            return;
        }
        const next = insertMention(field.value, query.start, field.selectionStart ?? field.value.length, account.handle);
        if (field.maxLength >= 0 && next.text.length > field.maxLength) {
            report(`That mention would exceed the ${field.maxLength}-character limit. Shorten the text first.`, 'warning');
            close();
            return;
        }
        field.value = next.text;
        field.setSelectionRange(next.caret, next.caret);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        close();
        field.focus();
    };
    const update = () => {
        if (composing) {
            return;
        }
        const query = mentionQueryAt(field.value, field.selectionStart ?? field.value.length);
        if (!query) {
            close();
            return;
        }
        items = matchMentionAccounts(state.accounts, query.query);
        if (!items.length) {
            close();
            return;
        }
        active = Math.min(active, items.length - 1);
        if (!list) {
            list = el('div', { className: 'sbtw-mentions', attrs: { id: listId, role: 'listbox', 'aria-label': 'Accounts to mention' } });
            field.insertAdjacentElement('afterend', list);
        }
        field.setAttribute('aria-controls', listId);
        field.setAttribute('aria-expanded', 'true');
        field.setAttribute('aria-activedescendant', `${listId}-${active}`);
        list.replaceChildren(...items.map((account, index) => el('button', {
            className: `sbtw-mention-item${index === active ? ' sbtw-mention-on' : ''}`,
            attrs: { id: `${listId}-${index}`, type: 'button', tabindex: '-1', role: 'option', 'aria-selected': index === active ? 'true' : 'false', 'data-focus-key': `mention-option:${account.key}` },
            on: {
                // Keep the caret in the field, or blur closes the list before the click lands.
                mousedown: event => event.preventDefault(),
                click: () => apply(account),
            },
        }, [
            avatarNode(account, 'sm'),
            el('span', { className: 'sbtw-name', text: account.name }),
            el('span', { className: 'sbtw-handle', text: `@${account.handle}` }),
        ])));
    };
    field.addEventListener('compositionstart', () => { composing = true; close(); });
    field.addEventListener('compositionend', () => { composing = false; update(); });
    field.addEventListener('input', () => { active = 0; update(); });
    field.addEventListener('click', update);
    field.addEventListener('keyup', (event) => {
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            update();
        }
    });
    field.addEventListener('keydown', (event) => {
        if (!list || composing || event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey) {
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            active = (active + 1) % items.length;
            update();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            active = (active - 1 + items.length) % items.length;
            update();
        } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            apply(items[active]);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    });
    field.addEventListener('blur', () => setTimeout(close, 150));
}

function composerBar(canPost, postField = null) {
    if (typeof canPost !== 'boolean') {
        postField = canPost;
        canPost = Boolean(postField);
    }
    const picker = el('input', { attrs: { type: 'file', accept: 'image/*', hidden: 'hidden' } });
    picker.addEventListener('change', async () => {
        const file = picker.files?.[0];
        picker.value = ''; // cleared immediately so the same file can be picked again
        if (!file) {
            return;
        }
        // Late uploads must not attach to a newer pick or to a post published since.
        const mine = ++uploadToken;
        const targetDraft = state.draft;
        state.imagePending = true;
        render();
        try {
            const url = await api.uploadImage(file);
            if (mine !== uploadToken || state.draft !== targetDraft) {
                return;
            }
            targetDraft.image = url;
            saveDraft();
        } catch (error) {
            if (mine !== uploadToken || state.draft !== targetDraft) {
                return;
            }
            console.error('[Meower] image upload failed', error);
            report(error.message || 'The image could not be uploaded.', 'error');
        } finally {
            if (mine === uploadToken && state.draft === targetDraft) {
                state.imagePending = false;
                render();
            }
        }
    });

    return el('div', { className: 'sbtw-composer-bar' }, [
        picker,
        canPost ? button('Image', 'sbtw-btn sbtw-btn-quiet', () => picker.click(), { iconName: 'fa-image' }) : null,
        canPost && api.getSettings().polls && !state.draft.poll
            ? button('Poll', 'sbtw-btn sbtw-btn-quiet', () => { state.draft.poll = ['', '']; saveDraft(); render(); }, { iconName: 'fa-square-poll-vertical' })
            : null,
        // While the model works the same slot becomes Stop: a refresh is a request, not a commitment.
        state.busy || state.opening
            ? button('Stop', 'sbtw-btn', stopWork, {
                iconName: 'fa-stop',
                title: 'Stop the model; whatever has landed stays',
                ariaLabel: 'Stop',
                focusKey: 'refresh',
                disabled: !state.opening && workController?.signal.aborted,
            })
            : button('Refresh', 'sbtw-btn', () => void refresh(), {
                iconName: 'fa-rotate',
                title: 'Ask the model for new activity',
                ariaLabel: 'Refresh timeline',
                focusKey: 'refresh',
                disabled: !state.feed || Boolean(state.loadFailure) || Boolean(mutationTask),
            }),
        el('span', { className: 'sbtw-spacer' }),
        // Live region: progress updates are announced without stealing focus.
        el('span', {
            className: 'sbtw-status',
            text: state.status,
            attrs: { role: 'status', 'aria-live': 'polite' },
        }),
        el('span', { className: 'sbtw-save-status', attrs: { role: 'status', 'aria-live': 'polite' } }),
        retrySaveButton(),
        canPost && postField ? button('Post', 'sbtw-btn sbtw-btn-primary', () => publish(postField.value), { focusKey: 'publish', disabled: state.imagePending || Boolean(mutationTask) }) : null,
    ]);
}

function composer() {
    const me = personaAccount();
    if (!me) {
        return el('div', { className: 'sbtw-composer' }, [
            el('div', { className: 'sbtw-empty', text: 'Set a persona to post. Everything else still works.' }),
            composerBar(false),
        ]);
    }
    if (!state.draftReady) {
        return el('div', { className: 'sbtw-composer' }, [
            el('p', { className: 'sbtw-hint', text: 'Your saved draft needs attention. Use Recovery in Settings to export it before discarding any versions.' }),
            composerBar(false),
        ]);
    }

    const field = el('textarea', {
        className: 'sbtw-input sbtw-composer-input',
        attrs: { rows: state.draft.text ? '3' : '1', maxlength: String(POST_MAX_CHARS), placeholder: "What's happening?", 'aria-label': "What's happening?", 'data-focus-key': 'post-composer' },
    });
    field.value = state.draft.text;
    field.addEventListener('input', () => { state.draft.text = field.value; saveDraft(); });
    // Empty and idle it is a single line, so the feed starts sooner on a phone; it opens up to write in.
    field.addEventListener('focus', () => { field.rows = 3; });
    // The collapse waits out a click: shrinking on mousedown would pull the button you aimed at away before mouseup.
    field.addEventListener('blur', () => {
        setTimeout(() => { if (document.activeElement !== field && !field.value.trim()) { field.rows = 1; } }, 250);
    });
    // Ctrl/Cmd+Enter posts; plain Enter still makes a new line. Propagation stops here
    // because the host binds Ctrl+Enter on the document to Regenerate.
    field.addEventListener('keydown', (event) => {
        if (!event.isComposing && event.keyCode !== 229 && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            event.stopPropagation();
            publish(field.value);
        }
    });
    attachMentionPicker(field);

    const extras = el('div', { className: 'sbtw-composer-extras' });
    if (state.draft.image || state.imagePending) {
        const description = el('textarea', {
            className: 'sbtw-input',
            attrs: { rows: '2', maxlength: '2000', 'data-focus-key': 'image-description' },
            on: { input: event => { state.draft.imageDescription = event.target.value; saveDraft(); } },
        }, [document.createTextNode(state.draft.imageDescription ?? '')]);
        extras.append(el('div', { className: 'sbtw-attachment' }, [
            state.draft.image ? el('img', { attrs: { src: state.draft.image, alt: state.draft.imageDescription ?? '' } }) : null,
            state.imagePending ? el('p', { className: 'sbtw-hint', text: 'Uploading image. Wait or cancel before posting.', attrs: { role: 'status' } }) : null,
            button(state.imagePending ? 'Cancel image' : 'Remove image', 'sbtw-btn sbtw-btn-quiet', () => {
                uploadToken += 1;
                state.imagePending = false;
                state.draft.image = '';
                state.draft.imageDescription = '';
                saveDraft();
                render();
            }, { focusKey: 'remove-image' }),
            el('label', { className: 'sbtw-field' }, [
                el('span', { className: 'sbtw-field-label', text: 'Image description (optional)' }),
                description,
                el('span', { className: 'sbtw-hint', text: 'Describe what matters in the picture for people using a screen reader.' }),
            ]),
        ]));
    }
    if (state.draft.poll) {
        const rows = state.draft.poll.map((text, index) => el('input', {
            className: 'sbtw-input',
            attrs: { type: 'text', maxlength: '120', placeholder: `Option ${index + 1}`, 'aria-label': `Poll option ${index + 1}`, value: text, 'data-focus-key': `poll-option:${index}` },
            on: {
                input: (event) => { state.draft.poll[index] = event.target.value; saveDraft(); },
            },
        }));
        extras.append(el('div', { className: 'sbtw-poll-editor' }, [
            ...rows,
            el('div', { className: 'sbtw-composer-bar' }, [
                state.draft.poll.length < 4
                    ? button('Add option', 'sbtw-btn sbtw-btn-quiet', () => { state.draft.poll.push(''); saveDraft(); render(); })
                    : null,
                button('Remove poll', 'sbtw-btn sbtw-btn-quiet', () => { state.draft.poll = null; saveDraft(); render(); }),
            ]),
        ]));
    }

    return el('div', { className: 'sbtw-composer' }, [
        el('div', { className: 'sbtw-post-row' }, [
            avatarNode(me, 'md'),
            el('div', { className: 'sbtw-post-main' }, [field, extras]),
        ]),
        composerBar(true, field),
    ]);
}

// Search folds behind a magnifier in the tab row. A live query keeps the row open, so a filter is never invisible.
let searchOpen = false;

function toggleSearch(open) {
    searchOpen = open;
    if (!open) {
        state.timelineSearch = '';
    }
    render();
    focusControl(open ? 'timeline-search' : 'timeline-search-toggle');
}

function timelineView() {
    // Looking at the timeline clears the dots for next time; this visit keeps the ones it opened with.
    const latestReply = state.feed.interactions.reduce((latest, item) => item.type === 'reply' ? Math.max(latest, item.createdAt) : latest, 0);
    const latest = state.feed.posts.reduce((value, post) => Math.max(value, post.createdAt), latestReply);
    if (state.session && latest > (state.session.timelineSeenAt ?? 0)) {
        state.session = api.updateSession(state.session.id, { timelineSeenAt: latest });
    }
    // Plain toggle buttons: a real tab pattern needs arrow-key roving focus and
    // tabpanels we do not have, and mislabelled tabs are worse than honest buttons.
    const showSearch = searchOpen || Boolean(state.timelineSearch);
    const tabs = el('div', { className: 'sbtw-tabs' }, [
        tabButton('Main', 'main'),
        tabButton('Latest', 'latest'),
        tabButton('Following', 'following'),
        tabButton('Trending', 'trending'),
        el('button', {
            className: `sbtw-tab sbtw-tab-search${showSearch ? ' sbtw-tab-on' : ''}`,
            attrs: { type: 'button', title: 'Search this timeline', 'aria-label': 'Search this timeline', 'aria-expanded': String(showSearch), 'data-focus-key': 'timeline-search-toggle' },
            on: { click: () => toggleSearch(!showSearch) },
        }, [icon('fa-magnifying-glass'), el('span', { text: 'Search' })]),
    ]);
    const results = el('div', { className: 'sbtw-timeline-results' });
    const resultStatus = el('span', {
        className: 'sbtw-search-status',
        attrs: { role: 'status', 'aria-live': 'polite' },
    });
    const search = el('input', {
        className: 'sbtw-input sbtw-timeline-search',
        attrs: {
            type: 'search',
            placeholder: 'Search this timeline',
            'aria-label': 'Search this timeline',
            autocomplete: 'off',
            value: state.timelineSearch,
            'data-focus-key': 'timeline-search',
        },
    });
    search.value = state.timelineSearch;
    const drawResults = () => {
        state.timelineSearch = search.value;
        const query = search.value.trim();
        const { entries, total } = visibleTimelineEntries(query);
        resultStatus.textContent = query ? `${total} ${total === 1 ? 'result' : 'results'}` : '';
        if (entries.length) {
            const list = el('div', { className: 'sbtw-list' }, entries.map(entry => entry.reply ? repostedReplyNode(entry) : postNode(entry.post, entry.repost)));
            const more = moreButton(`timeline:${state.tab}:${query}`, total, entries.length, FEED_LIMIT);
            if (more) {
                list.append(more);
            }
            results.replaceChildren(list);
            return;
        }
        results.replaceChildren(el('div', { className: 'sbtw-empty' }, [
            el('img', { className: 'sbtw-empty-art', attrs: { src: '/img/neconyan/sleepy-chat.webp', alt: '', draggable: 'false' } }),
            el('p', {
                text: query
                    ? 'No posts or replies match that search.'
                    : state.tab === 'following' ? 'Nothing from anyone you follow yet.'
                        : state.tab === 'trending' ? 'Nothing is trending yet.' : 'Your timeline is taking a catnap.',
            }),
            el('p', {
                className: 'sbtw-hint',
                text: query
                    ? 'Try a name, handle, post, reply or poll option.'
                    : state.tab === 'following'
                        ? 'Follow someone from their profile, or from Who to follow.'
                        : state.tab === 'trending'
                            ? 'Posts with the most likes, replies and reposts from the last two days show up here.'
                            : 'Invite a character in Settings, then choose Refresh.',
            }),
        ]));
    };
    let timer = null;
    search.addEventListener('input', () => {
        state.timelineSearch = search.value;
        state.revealTarget = null;
        clearTimeout(timer);
        timer = setTimeout(() => {
            if (search.isConnected) {
                drawResults();
            }
        }, SEARCH_DEBOUNCE_MS);
    });
    search.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            toggleSearch(false);
        }
    });
    drawResults();

    // Made-up trending topics, under the Trending tab: tapping one searches the timeline for it.
    let trendsBar = null;
    if (state.tab === 'trending') {
        const trends = state.session?.trends ?? [];
        installTrendPanGuard();
        trendsBar = el('div', { className: 'sbtw-trends', attrs: { 'aria-label': 'Trending topics' } }, trends.length
            ? trends.map(trend => el('button', {
                className: 'sbtw-trend',
                attrs: { type: 'button', title: `Write a round of posts about ${trend.topic}`, disabled: state.busy || mutationTask ? 'disabled' : null, 'data-focus-key': `trend:${trend.topic}` },
                // A tap runs a refresh about the topic (same post cap as Refresh) and shows the matches in Main as they land.
                on: { click: () => { if (state.busy || mutationTask) { return; } state.tab = 'main'; state.timelineSearch = trend.topic; state.revealTarget = null; void refresh({ topic: trend.topic }); } },
            }, [
                el('span', { className: 'sbtw-trend-topic', text: trend.topic }),
                el('span', { className: 'sbtw-trend-count', text: `${formatCount(trend.posts)} posts` }),
            ]))
            : [el('span', { className: 'sbtw-hint', text: 'Trending topics appear after the next Refresh.' })]);
    }

    return el('div', {}, [
        tabs,
        trendsBar,
        showSearch ? el('div', { className: 'sbtw-timeline-search-row' }, [search, resultStatus]) : null,
        composer(),
        results,
    ]);
}

function tabButton(label, value) {
    return el('button', {
        className: `sbtw-tab${state.tab === value ? ' sbtw-tab-on' : ''}`,
        text: label,
        attrs: { type: 'button', 'aria-pressed': String(state.tab === value), 'data-focus-key': `timeline-tab:${value}` },
        on: { click: () => { state.tab = value; state.revealTarget = null; render(); } },
    });
}

function profileView() {
    const account = accountFor(state.profileKey);
    if (!account) {
        return el('div', { className: 'sbtw-empty', text: 'That account is not around any more.' });
    }
    const me = personaAccount();
    const following = followingKeys();
    const posts = state.feed.posts.filter(post => post.authorKey === account.key).sort((a, b) => b.createdAt - a.createdAt);
    const liked = state.feed.interactions
        .filter(item => item.type === 'like' && item.actorKey === account.key)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(item => ({ post: postsById.get(item.postId), reply: item.parentInteractionId ? answerableOn(item.postId, item.parentInteractionId) : null, item }))
        .filter(entry => entry.post && (!entry.item.parentInteractionId || entry.reply));
    const reposts = state.feed.interactions
        .filter(item => item.type === 'repost' && item.actorKey === account.key)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(item => ({ repost: item, post: postsById.get(item.postId), reply: item.parentInteractionId ? answerableOn(item.postId, item.parentInteractionId) : null }))
        .filter(entry => entry.post && (!entry.repost.parentInteractionId || entry.reply));
    const media = posts.filter(post => post.image?.url);

    const follows = state.session?.follows ?? {};
    const followerCount = Object.values(follows).filter(list => list.includes(account.key)).length;
    // Strangers are people the model invented with profiles of their own, so they can be followed too.
    const canFollow = me && account.key !== me.key;

    return el('div', { className: 'sbtw-profile' }, [
        el('div', { className: 'sbtw-profile-head' }, [
            avatarNode(account, 'lg'),
            el('div', { className: 'sbtw-profile-meta' }, [
                el('div', { className: 'sbtw-name sbtw-name-big', text: account.name }),
                el('div', { className: 'sbtw-handle', text: `@${account.handle}` }),
                account.bio ? el('div', { className: 'sbtw-bio', text: account.bio }) : null,
                account.location ? el('div', { className: 'sbtw-location' }, [icon('fa-location-dot'), el('span', { text: account.location })]) : null,
                el('div', { className: 'sbtw-counts', text: `${(follows[account.key] ?? []).length} following  ·  ${plural(followerCount, 'follower')}` }),
            ]),
            el('div', { className: 'sbtw-profile-actions' }, [
                canFollow
                    ? button(following.has(account.key) ? 'Following' : 'Follow',
                        `sbtw-btn ${following.has(account.key) ? 'sbtw-btn-quiet' : 'sbtw-btn-primary'}`,
                        () => toggleFollow(account.key), { focusKey: `follow:${account.key}`, disabled: Boolean(mutationTask) })
                    : null,
                account.kind === KIND_CHARACTER
                    ? button('New profile', 'sbtw-btn sbtw-btn-quiet', () => void rewriteProfile(account.key), {
                        iconName: 'fa-wand-magic-sparkles',
                        title: 'Ask the posts connection for a fresh handle, name and bio for this character',
                        disabled: state.busy || Boolean(mutationTask),
                        focusKey: `rewrite-profile:${account.key}`,
                    })
                    : null,
            ]),
        ]),
        section('Posts', posts, 'Nothing posted yet.', post => postNode(post)),
        section('Reposts', reposts, 'Nothing reposted yet.', entry => entry.reply ? repostedReplyNode(entry) : postNode(entry.post, entry.repost)),
        section('Likes', liked, 'Nothing liked yet.', entry => entry.reply ? replyNode(entry.reply) : postNode(entry.post)),
        section('Media', media, 'No pictures yet.', post => postNode(post)),
    ]);
}

/** Drops the passers-by this timeline keeps bringing back, so the next refresh invents new ones. */
function forgetStrangers() {
    if (state.busy || mutationTask || !state.session) {
        return;
    }
    const sessionId = state.session.id;
    try {
        const cleared = api.clearStrangers(sessionId);
        state.session = api.getSession(sessionId);
        void refreshAccounts(sessionId).then(current => { if (current) { render(); } }).catch((error) => {
            console.error('[Meower] the account list could not be refreshed', error);
            if (state.session?.id === sessionId) {
                report('The strangers were cleared, but the account list could not be refreshed.', 'error');
            }
        });
        render();
        toast(cleared
            ? `${cleared === 1 ? 'One stranger' : `${cleared} strangers`} forgotten. The next refresh brings new ones.`
            : 'No strangers to forget yet.', cleared ? 'success' : 'info');
    } catch (error) {
        console.error('[Meower] strangers could not be cleared', error);
        toast(error?.message || 'The strangers could not be cleared.', 'error');
    }
}

/** Writes the persona profile under the same cancellable session-wide busy state as a refresh. */
async function writePersonaProfile() {
    if (state.busy || mutationTask || !state.session) {
        return;
    }
    const sessionId = state.session.id;
    const revision = personaProfileRevision;
    const { epoch, signal } = freshSignal();
    state.busy = true;
    state.status = 'Writing your profile...';
    render();
    try {
        const profile = await api.generatePersonaProfile(sessionId, { signal });
        if (!isLive(epoch) || state.session?.id !== sessionId) {
            return;
        }
        if (signal.aborted) {
            report('Profile writing stopped.');
            return;
        }
        if (revision !== personaProfileRevision) {
            report('Kept your edits. The generated profile was not applied.');
            return;
        }
        if (!profile) {
            report('The model did not return a usable profile. Try again.', 'warning');
            return;
        }
        const current = api.getSession(sessionId);
        state.session = api.updateSession(sessionId, {
            personaProfile: { ...(current?.personaProfile ?? {}), ...profile },
        });
        try {
            await refreshAccounts(sessionId);
        } catch (error) {
            console.error('[Meower] the saved persona profile could not be refreshed in the account list', error);
            if (isLive(epoch)) {
                report('Your profile was saved, but the account list could not be refreshed. Try reopening Meower.', 'warning');
            }
            return;
        }
        if (!isLive(epoch) || state.session?.id !== sessionId) {
            return;
        }
        report(`Profile written: ${profile.name} @${profile.handle}`, 'success');
    } catch (error) {
        if (!isLive(epoch) || state.session?.id !== sessionId) {
            return;
        }
        if (signal.aborted || error?.name === 'AbortError') {
            report('Profile writing stopped.');
            return;
        }
        console.error('[Meower] persona profile generation failed', error);
        report(error?.message || 'The profile could not be written.', 'error');
    } finally {
        if (isLive(epoch) && state.session?.id === sessionId) {
            state.busy = false;
            render();
        }
    }
}

/** Fresh handles, names and bios for every invited character in one request. */
async function rewriteAllProfiles() {
    if (state.busy || mutationTask || !state.session) {
        return;
    }
    const sessionId = state.session.id;
    const { epoch, signal } = freshSignal();
    state.busy = true;
    state.status = 'Writing new profiles...';
    let saved = false;
    render();
    try {
        const written = await api.regenerateAllProfiles(sessionId, { signal });
        if (!isLive(epoch)) {
            return;
        }
        if (!written) {
            report('The model did not return usable profiles. Try again.', 'warning');
            return;
        }
        saved = true;
        await refreshAccounts(sessionId);
        if (!isLive(epoch)) {
            return;
        }
        report(written === 1 ? 'New profile written.' : `${written} new profiles written.`, 'success');
    } catch (error) {
        if (!isLive(epoch)) {
            return;
        }
        if (signal.aborted) {
            report('Profile writing stopped.');
            return;
        }
        console.error('[Meower] profile rewrite failed', error);
        report(saved ? 'The profiles were saved, but the account list could not be refreshed. Try reopening Meower.' : error?.message || 'The profiles could not be written.', 'error');
    } finally {
        if (isLive(epoch)) {
            state.busy = false;
            render();
        }
    }
}

/** A fresh handle, name and bio for a character, written by the posts connection; the old handle is ruled out. */
async function rewriteProfile(accountKey) {
    if (state.busy || mutationTask || !state.session) {
        return;
    }
    const sessionId = state.session.id;
    const { epoch, signal } = freshSignal();
    state.busy = true;
    state.status = 'Writing a new profile...';
    let saved = false;
    render();
    try {
        const profile = await api.regenerateProfile(accountKey, sessionId, { signal });
        if (!isLive(epoch)) {
            return;
        }
        if (!profile) {
            report('The model did not return a usable profile. Try again.', 'warning');
            return;
        }
        saved = true;
        await refreshAccounts(sessionId);
        if (!isLive(epoch)) {
            return;
        }
        report(`New profile: ${profile.name} @${profile.handle}`, 'success');
    } catch (error) {
        if (!isLive(epoch)) {
            return;
        }
        if (signal.aborted) {
            report('Profile writing stopped.');
            return;
        }
        console.error('[Meower] profile rewrite failed', error);
        report(saved ? 'The profile was saved, but the account list could not be refreshed. Try reopening Meower.' : error?.message || 'The profile could not be written.', 'error');
    } finally {
        if (isLive(epoch)) {
            state.busy = false;
            render();
        }
    }
}

function section(title, items, emptyText, draw) {
    const key = `profile:${state.profileKey}:${title}`;
    const content = el('div', { className: 'sbtw-list' });
    const fill = () => {
        const target = state.replyingTo;
        const pinned = target ? items.find(item => {
            if ((item.post?.id ?? item.id) !== target.postId) {
                return false;
            }
            if (item.repost?.content) {
                return entryKey(item) === targetEntryKey({ postId: target.postId, interactionId: target.parentInteractionId });
            }
            return !item.reply || item.reply.id === target.parentInteractionId;
        }) : null;
        const shown = pageItems(items, listLimits.get(key) ?? PROFILE_LIMIT, pinned);
        content.replaceChildren(...(items.length ? shown.map(draw) : [el('div', { className: 'sbtw-empty', text: emptyText })]));
        const more = moreButton(key, items.length, shown.length, PROFILE_LIMIT);
        if (more) {
            content.append(more);
        }
    };
    const open = openSections.get(key) ?? title === 'Posts';
    const details = el('details', {
        className: 'sbtw-section',
        attrs: { open: open ? 'open' : null, 'data-section-key': key },
        on: { toggle: () => {
            if (!details.isConnected) {
                return;
            }
            openSections.set(key, details.open);
            if (details.open && !content.childNodes.length) {
                fill();
            }
        } },
    }, [
        el('summary', { text: `${title} (${items.length})`, attrs: { 'data-focus-key': `section:${key}` } }),
        content,
    ]);
    if (open) {
        fill();
    }
    return details;
}

function notificationGroups() {
    const me = personaAccount();
    if (!me || !state.feed) {
        return null;
    }
    return cachedNotifications ??= buildNotifications({
        posts: state.feed.posts,
        interactions: state.feed.interactions,
        personaKey: me.key,
        personaHandle: me.handle,
        following: state.session?.follows?.[me.key] ?? [],
    });
}

/** Posts and replies wearing a new-dot right now: the same mark, counted for the Home badge. */
/** "1 follower", not "1 followers". */
function plural(count, one, many = `${one}s`) {
    return `${count} ${count === 1 ? one : many}`;
}

function unseenTimeline() {
    if (!state.feed) {
        return 0;
    }
    const posts = state.feed.posts.filter(post => isNewToMe(post, post.authorKey)).length;
    const replies = state.feed.interactions.filter(item => item.type === 'reply' && isNewToMe(item, item.actorKey)).length;
    return posts + replies;
}

function unseenNotifications() {
    const groups = notificationGroups();
    return groups ? countUnseen(groups, state.session?.notificationsSeenAt ?? 0) : 0;
}

function badgeNode(count) {
    return el('span', { className: 'sbtw-badge', text: count > 99 ? '99+' : String(count), attrs: { 'aria-hidden': 'true' } });
}

const NOTIFICATION_TABS = [['likes', 'Likes'], ['replies', 'Replies'], ['posts', 'Posts']];
const NOTIFICATION_VERB = {
    like: 'liked your post',
    repost: 'reposted you',
    vote: 'voted in your poll',
    reply: 'replied to you',
    'comment-reply': 'replied to your comment',
    'comment-like': 'liked your comment',
    'comment-repost': 'reposted your comment',
    mention: 'mentioned you',
    post: 'posted',
};
const NOTIFICATION_EMPTY = {
    likes: 'No likes, reposts or poll votes on your posts or replies yet.',
    replies: 'No replies yet. Post something and run a refresh.',
    posts: 'No mentions yet, and nothing new from the accounts you follow.',
};

function notificationTarget(item) {
    const interaction = interactionsById.get(item.interactionId);
    const comment = isAnswerable(interaction) ? interaction : interactionsById.get(interaction?.parentInteractionId);
    return { postId: item.postId, interactionId: isAnswerable(comment) && comment.postId === item.postId ? comment.id : null };
}

function notificationsView() {
    const groups = notificationGroups();
    if (!groups) {
        return el('div', { className: 'sbtw-empty', text: 'Set a persona to get notifications.' });
    }
    // Looking at the view clears the badge; rows newer than the previous visit stay marked until you leave.
    const latest = Object.values(groups).reduce(
        (value, list) => list.reduce((inner, item) => Math.max(inner, item.createdAt), value),
        0,
    );
    if (latest > (state.session.notificationsSeenAt ?? 0)) {
        state.session = api.updateSession(state.session.id, { notificationsSeenAt: latest });
    }
    const isNew = item => item.createdAt > state.notifSeenBefore;

    const tabs = el('div', { className: 'sbtw-tabs' }, NOTIFICATION_TABS.map(([value, label]) => {
        const fresh = groups[value].filter(isNew).length;
        return el('button', {
            className: `sbtw-tab${state.notifTab === value ? ' sbtw-tab-on' : ''}`,
            attrs: {
                type: 'button',
                'aria-pressed': String(state.notifTab === value),
                'aria-label': `${label}, ${groups[value].length} total${fresh ? `, ${fresh} new` : ''}`,
                'data-focus-key': `notification-tab:${value}`,
            },
            on: { click: () => { state.notifTab = value; render(); } },
        }, [el('span', { text: `${label} ${groups[value].length}` }), fresh ? badgeNode(fresh) : null]);
    }));

    const all = groups[state.notifTab] ?? groups.likes;
    const rows = all.slice(0, NOTIFICATION_LIMIT);
    const list = rows.map(item => {
        const target = notificationTarget(item);
        const post = postsById.get(item.postId);
        const text = item.content || interactionsById.get(target.interactionId)?.content || post?.body || post?.poll?.question || (post?.image ? 'Image post' : 'Post');
        const preview = text.replace(/\s+/g, ' ').trim();
        return el('button', {
            className: `sbtw-notification${isNew(item) ? ' sbtw-notification-new' : ''}`,
            attrs: { type: 'button', 'data-focus-key': `notification:${state.notifTab}:${item.id}` },
            on: {
                click: () => {
                    state.view = 'timeline';
                    state.tab = 'main';
                    markTimelineVisit();
                    state.timelineSearch = '';
                    state.revealTarget = target;
                    // Only a reply gives you something to answer; everything else just takes you to the post.
                    if (item.kind === 'reply' || item.kind === 'comment-reply') {
                        setReplyTarget(item.postId, item.interactionId, { toggle: false });
                    } else {
                        state.replyingTo = null;
                        pendingReplyFocus = null;
                        render();
                    }
                    scrollToNotification(item);
                },
            },
        }, [
            avatarNode(accountFor(item.actorKey) ?? item.actorSnapshot ?? null, 'sm'),
            el('div', { className: 'sbtw-notification-main' }, [
                el('div', { className: 'sbtw-meta' }, [
                    el('span', { className: 'sbtw-name', text: nameFor(item.actorKey, item.actorSnapshot) }),
                    isNew(item) ? el('span', { className: 'sbtw-unread', text: 'Unread' }) : null,
                    el('span', { className: 'sbtw-time', text: dateFormat.format(new Date(item.createdAt)) }),
                ]),
                el('div', { text: NOTIFICATION_VERB[item.kind] ?? 'reacted' }),
                el('div', { className: 'sbtw-notification-preview', text: preview.length > 240 ? `${preview.slice(0, 240)}...` : preview }),
            ]),
        ]);
    });

    return el('div', {}, [
        tabs,
        list.length
            ? el('div', { className: 'sbtw-list' }, list)
            : el('div', { className: 'sbtw-empty', text: NOTIFICATION_EMPTY[state.notifTab] ?? NOTIFICATION_EMPTY.likes }),
        all.length > rows.length
            ? el('p', { className: 'sbtw-hint sbtw-list-note', text: `Showing the newest ${rows.length} of ${all.length}. Older ones are still on the timeline.` })
            : null,
    ]);
}

// --- settings view --------------------------------------------------------

function field(label, control, hint = '') {
    if (control instanceof Element && control.matches('input, textarea, select, button') && !control.dataset.focusKey) {
        control.dataset.focusKey = `field:${label}`;
    }
    return el('label', { className: 'sbtw-field' }, [
        el('span', { className: 'sbtw-field-label', text: label }),
        control,
        hint ? el('span', { className: 'sbtw-hint', text: hint }) : null,
    ]);
}

function numberInput(value, min, max, onChange) {
    const input = el('input', {
        className: 'sbtw-input sbtw-number',
        attrs: { type: 'number', min: String(min), max: String(max), value: String(value) },
    });
    const commit = () => {
        const number = Number(input.value);
        // A cleared or junk field keeps what was there; Number('') is 0 and would slide under min.
        if (input.value.trim() === '' || !Number.isFinite(number)) {
            input.value = String(value);
            return;
        }
        const next = Math.min(max, Math.max(min, Math.trunc(number)));
        input.value = String(next);
        if (next !== value) {
            value = next;
            onChange(next);
        }
    };
    input.addEventListener('input', () => {
        const number = Number(input.value);
        if (input.value.trim() && Number.isInteger(number) && number >= min && number <= max && number !== value) {
            value = number;
            onChange(number);
        }
    });
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    return input;
}

function checkbox(label, checked, onChange, visual = null) {
    const box = el('input', { attrs: { type: 'checkbox', checked: checked ? 'checked' : null, 'data-focus-key': `check:${label}` } });
    box.checked = checked;
    box.addEventListener('change', () => onChange(box.checked));
    return el('label', { className: 'sbtw-check' }, [box, visual, el('span', { text: label })]);
}

// Settings re-render after every save, so a group the reader opened has to stay open.
const openSettingsGroups = new Set();

function settingsGroup(title, hint, nodes) {
    const content = el('div', { className: 'sbtw-settings-group-body' });
    const details = el('details', {
        className: 'sbtw-settings-group',
        attrs: { open: openSettingsGroups.has(title) ? 'open' : null },
        on: { toggle: () => {
            if (!details.isConnected) {
                return;
            }
            openSettingsGroups[details.open ? 'add' : 'delete'](title);
            if (details.open && !content.childNodes.length) {
                content.append(...nodes());
            }
        } },
    }, [
        el('summary', { attrs: { 'data-focus-key': `group:${title}` } }, [
            el('span', { className: 'sbtw-settings-group-title', text: title }),
            el('span', { className: 'sbtw-hint', text: hint }),
        ]),
        content,
    ]);
    if (openSettingsGroups.has(title)) {
        content.append(...nodes());
    }
    return details;
}

function settingsView() {
    const settings = api.getSettings();
    const context = globalThis.SillyTavern.getContext();
    const session = state.session;
    const characters = context.characters ?? [];
    const profiles = api.listConnectionProfiles();
    const profileAvailable = !settings.profileId || profiles.some(profile => profile.id === settings.profileId);
    const personas = api.listPersonas();
    const notes = api.getScenarioNotes(session.personaId);
    const groups = (context.groups ?? []).filter(group => Array.isArray(group.members) && group.members.length);

    const refreshSettings = () => {
        const epoch = sessionEpoch;
        void refreshAccounts(session.id)
            .then(current => { if (current) { render(); } })
            .catch(error => {
                console.error('[Meower] settings could not refresh the account list', error);
                if (isLive(epoch) && state.session?.id === session.id) {
                    report('Settings were changed, but the account list could not be refreshed.', 'error');
                }
            });
    };
    const save = (patch) => { api.updateSettings(patch); refreshSettings(); };
    const savePart = (name, patch) => save({ [name]: { ...api.getSettings()[name], ...patch } });
    const saveSession = (patch) => {
        const updated = api.updateSession(session.id, patch);
        if (state.session?.id === session.id) {
            state.session = updated;
        }
        refreshSettings();
    };
    const saveProfile = (patch) => {
        personaProfileRevision += 1;
        const updated = api.updateSession(session.id, {
            personaProfile: { ...(api.getSession(session.id)?.personaProfile ?? {}), ...patch },
        });
        if (state.session?.id === session.id) {
            state.session = updated;
        }
    };

    const personaSelect = el('select', {
        className: 'sbtw-input',
        on: {
            change: event => void switchSession(session.id, { personaId: event.target.value }),
        },
    }, personas.map(persona => el('option', {
        text: persona.name,
        attrs: { value: persona.entityId, selected: persona.entityId === session.personaId ? 'selected' : null },
    })));

    const groupSelect = el('select', {
        className: 'sbtw-input',
        on: {
            change: (event) => {
                const group = groups.find(item => String(item.id) === event.target.value);
                if (group) {
                    setInvited(group.members);
                }
            },
        },
    }, [
        el('option', { text: 'Choose a group...', attrs: { value: '' } }),
        ...groups.map(group => el('option', { text: group.name || 'Unnamed group', attrs: { value: String(group.id) } })),
    ]);

    const profileSelect = el('select', {
        className: 'sbtw-input',
        on: { change: (event) => save({ profileId: event.target.value }) },
    }, [
        el('option', { text: profiles.length ? 'Use the current connection' : 'Connection Manager is off', attrs: { value: '', selected: !settings.profileId ? 'selected' : null } }),
        !profileAvailable
            ? el('option', { text: 'Selected connection profile is unavailable', attrs: { value: settings.profileId, selected: 'selected', disabled: 'disabled' } })
            : null,
        ...profiles.map(profile => el('option', {
            text: profile.name,
            attrs: { value: profile.id, selected: profile.id === settings.profileId ? 'selected' : null },
        })),
    ]);

    // Invites change in place. A full re-render would rebuild the scroller under the
    // finger, dropping the reader's place and the focused checkbox; nothing else on this
    // view depends on the invite list, and the account roster refreshes quietly behind it.
    const setInvited = (next) => {
        const epoch = sessionEpoch;
        const updated = api.updateSession(session.id, { invited: [...new Set(next)] });
        if (state.session?.id === session.id) {
            state.session = updated;
        }
        for (const row of inviteRows) {
            row.querySelector('input').checked = updated.invited.includes(row.dataset.avatar);
        }
        filterInvites();
        void refreshAccounts(session.id).catch((error) => {
            console.error('[Meower] settings could not refresh the account list', error);
            if (isLive(epoch) && state.session?.id === session.id) {
                report('The cast was changed, but the account list could not be refreshed.', 'error');
            }
        });
    };
    const tagNames = new Map((context.tags ?? []).map(tag => [tag.id, tag.name]));
    const tagsOf = avatar => (context.tagMap?.[avatar] ?? []).map(id => tagNames.get(id)).filter(Boolean);
    const inviteRows = characters.filter(character => character?.avatar).map((character) => {
        const name = character.name || character.data?.name || character.avatar;
        const row = checkbox(
            name,
            session.invited.includes(character.avatar),
            (checked) => {
                const invited = api.getSession(session.id).invited;
                setInvited(checked ? [...invited, character.avatar] : invited.filter(item => item !== character.avatar));
            },
            avatarNode({ kind: KIND_CHARACTER, entityId: character.avatar, name }, 'sm'),
        );
        row.classList.add('sbtw-invite');
        row.querySelector('input').dataset.focusKey = `invite:${character.avatar}`;
        row.dataset.avatar = character.avatar;
        row.dataset.search = [name, character.avatar, ...tagsOf(character.avatar)].join(' ').toLocaleLowerCase();
        return row;
    });
    const inviteCount = el('span', { className: 'sbtw-invite-count' });
    const clearInvites = button('Clear invites', 'sbtw-btn sbtw-btn-quiet', () => setInvited([]), { title: 'Uninvite everyone' });
    const inviteEmpty = el('p', { className: 'sbtw-invite-empty' });
    const invites = el('div', { className: 'sbtw-invites' }, [...inviteRows, inviteEmpty]);
    const inviteSearch = el('input', {
        className: 'sbtw-input sbtw-character-search',
        attrs: {
            type: 'search',
            value: state.characterSearch,
            placeholder: 'Search characters or tags',
            autocomplete: 'off',
            'aria-label': 'Search characters or tags',
            'data-focus-key': 'character-search',
        },
    });
    const filterInvites = () => {
        const query = inviteSearch.value.trim().toLocaleLowerCase();
        let visible = 0;
        for (const row of inviteRows) {
            const hidden = Boolean(query) && !row.dataset.search.includes(query);
            if (row.hidden !== hidden) {
                row.hidden = hidden;
            }
            visible += hidden ? 0 : 1;
        }
        inviteEmpty.hidden = visible > 0;
        inviteEmpty.textContent = query ? 'No characters match this search.' : 'No characters are available.';
        const invitedCount = (api.getSession(session.id) ?? session).invited.length;
        inviteCount.textContent = query ? `${visible} of ${inviteRows.length}` : `${invitedCount} invited`;
        clearInvites.disabled = !invitedCount;
    };
    let searchTimer = null;
    inviteSearch.addEventListener('input', () => {
        state.characterSearch = inviteSearch.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(filterInvites, SEARCH_DEBOUNCE_MS);
    });
    filterInvites();

    const activeMode = el('select', {
        className: 'sbtw-input',
        on: { change: (event) => savePart('active', { mode: event.target.value }) },
    }, ['range', 'exact', 'all'].map(mode => el('option', {
        text: { range: 'A random number each time', exact: 'Always the same number', all: 'Everyone invited' }[mode],
        attrs: { value: mode, selected: mode === settings.active.mode ? 'selected' : null },
    })));

    return el('div', { className: 'sbtw-settings' }, [
        el('h3', { text: 'Timeline identity' }),
        el('div', { className: 'sbtw-row' }, [
            field('Timeline name', el('input', {
                className: 'sbtw-input',
                attrs: { type: 'text', value: session.name, maxlength: '80' },
                on: { change: event => saveSession({ name: event.target.value }) },
            })),
            field('Timeline type', el('input', {
                className: 'sbtw-input',
                attrs: { type: 'text', value: session.type, maxlength: '120', placeholder: 'Open timeline' },
                on: { change: event => saveSession({ type: event.target.value }) },
            }), 'Examples: close friends, newsroom, fandom, public figures.'),
        ]),
        field('Persona', personaSelect, 'The selected persona owns this timeline and all activity you make in it.'),
        notes.length ? el('div', {
            className: 'sbtw-field',
            attrs: { role: 'group', 'aria-labelledby': 'sbtw-scenario-notes-label' },
        }, [
            el('span', { className: 'sbtw-field-label', text: 'Scenario Notes', attrs: { id: 'sbtw-scenario-notes-label' } }),
            ...notes.map(note => checkbox(note.name, session.scenarioNoteIds.includes(note.id), checked => {
                const selected = new Set(api.getSession(session.id).scenarioNoteIds);
                if (checked) {
                    selected.add(note.id);
                } else {
                    selected.delete(note.id);
                }
                saveSession({ scenarioNoteIds: [...selected] });
            })),
            el('span', { className: 'sbtw-hint', text: 'Equipped only for this timeline; your host persona settings are not changed.' }),
        ]) : null,

        el('h3', { text: 'Who posts' }),
        groups.length ? field('Use a host group as this timeline\'s cast', groupSelect, 'This copies the group members; you can then adjust the character list below.') : null,
        // A group of checkboxes cannot live inside a single <label>; each has its own.
        el('div', { className: 'sbtw-field' }, [
            el('div', { className: 'sbtw-field-heading' }, [
                el('span', { className: 'sbtw-field-label', text: 'Characters' }),
                el('span', { className: 'sbtw-field-tools' }, [inviteCount, clearInvites]),
            ]),
            inviteSearch,
            invites,
            el('span', { className: 'sbtw-hint', text: 'Only invited characters take part in a refresh.' }),
        ]),
        checkbox('Let strangers join in', session.ambient, value => saveSession({ ambient: value })),
        el('p', { className: 'sbtw-hint', text: `Random passers-by the model invents, not part of the cast. They mostly reply and like, get a profile, and come back later.${session.strangers.length ? ` ${session.strangers.length} so far.` : ''}` }),

        settingsGroup('Your profile', 'Name, handle, bio and location on this timeline.', () => [
        el('div', { className: 'sbtw-composer-bar' }, [
            button(state.status === 'Writing your profile...' ? 'Writing...' : 'Write it with the model', 'sbtw-btn sbtw-btn-quiet', () => void writePersonaProfile(), {
                iconName: 'fa-wand-magic-sparkles',
                title: 'Ask the posts connection to write this profile from your persona description',
                disabled: state.busy || Boolean(mutationTask),
                focusKey: 'write-persona-profile',
            }),
            el('span', { className: 'sbtw-hint', text: 'Uses your persona description; you can edit the result.' }),
        ]),
        el('div', { className: 'sbtw-row' }, [
            field('Display name', el('input', {
                className: 'sbtw-input',
                attrs: { type: 'text', value: session.personaProfile.name, maxlength: '120' },
                on: { input: event => saveProfile({ name: event.target.value }), change: refreshSettings },
            })),
            field('Handle', el('input', {
                className: 'sbtw-input',
                attrs: { type: 'text', value: session.personaProfile.handle, maxlength: '20', placeholder: 'Generated from your name' },
                on: { input: event => saveProfile({ handle: event.target.value }), change: refreshSettings },
            })),
        ]),
        field('Bio', el('textarea', {
            className: 'sbtw-input',
            attrs: { rows: '3', maxlength: '1000' },
            on: { input: event => saveProfile({ bio: event.target.value }), change: refreshSettings },
        }, [document.createTextNode(session.personaProfile.bio)])),
        field('Location', el('input', {
            className: 'sbtw-input',
            attrs: { type: 'text', value: session.personaProfile.location, maxlength: '160' },
            on: { input: event => saveProfile({ location: event.target.value }), change: refreshSettings },
        })),
        ]),

        settingsGroup('Cast upkeep', 'Fresh profiles for the cast, and the strangers this timeline keeps.', () => [
        el('div', { className: 'sbtw-field' }, [
            el('span', { className: 'sbtw-field-label', text: 'Profiles' }),
            el('div', { className: 'sbtw-button-row' }, [
                button('New profiles for everyone', 'sbtw-btn sbtw-btn-quiet', () => void rewriteAllProfiles(), {
                    iconName: 'fa-wand-magic-sparkles',
                    title: 'Ask the posts connection for a fresh handle, name and bio for every invited character',
                    disabled: state.busy || Boolean(mutationTask),
                }),
            ]),
            el('span', { className: 'sbtw-hint', text: 'One request rewrites the handle, name and bio of every invited character; the current handles are ruled out. One character at a time: New profile on their page.' }),
        ]),
        el('div', { className: 'sbtw-field' }, [
            el('span', { className: 'sbtw-field-label', text: 'Strangers' }),
            el('div', { className: 'sbtw-button-row' }, [
                button('Forget these strangers', 'sbtw-btn sbtw-btn-quiet', () => forgetStrangers(), {
                    iconName: 'fa-arrows-rotate',
                    title: 'Drop the passers-by this timeline keeps bringing back; the next refresh invents new ones',
                    disabled: state.busy || Boolean(mutationTask),
                }),
            ]),
            el('span', { className: 'sbtw-hint', text: 'Their old posts stay as they are. The next refresh introduces a fresh set.' }),
        ]),
        ]),

        el('h3', { text: 'Global settings' }),
        el('p', { className: 'sbtw-hint', text: 'Generation and chat settings below apply to every timeline.' }),
        settingsGroup('Generation', 'Which connection writes, how much each refresh makes, pictures, tone and memory.', () => [
        el('h4', { text: 'Connection' }),
        field('Write posts with', profileSelect, 'A cheap model is fine here. One refresh writes the whole batch, or one activity per request with the option below.'),
        field('Reply budget (tokens)', numberInput(settings.maxTokens, 256, 1000000, value => save({ maxTokens: value })),
            'The most one reply may run to. Thinking models (Kimi, GLM, DeepSeek, Qwen...) spend part of it on their reasoning, and a budget that runs out mid-JSON is a malformed reply - so it is generous. Lower it only if your provider refuses the request.'),

        el('h4', { text: 'How much each refresh makes' }),
        field('Accounts per refresh', activeMode),
        settings.active.mode === 'range'
            ? el('div', { className: 'sbtw-row' }, [
                field('Fewest', numberInput(settings.active.min, 1, 100, value => savePart('active', { min: value }))),
                field('Most', numberInput(settings.active.max, 1, 100, value => savePart('active', { max: value }))),
            ])
            : null,
        settings.active.mode === 'exact'
            ? field('How many', numberInput(settings.active.count, 1, 100, value => savePart('active', { count: value })))
            : null,
        el('div', { className: 'sbtw-row' }, [
            field('Posts', numberInput(settings.quotas.posts, 0, 100, value => savePart('quotas', { posts: value }))),
            field('Replies', numberInput(settings.quotas.replies, 0, 200, value => savePart('quotas', { replies: value }))),
            field('Reposts', numberInput(settings.quotas.reposts, 0, 100, value => savePart('quotas', { reposts: value }))),
            field('Likes', numberInput(settings.quotas.likes, 0, 500, value => savePart('quotas', { likes: value }))),
        ]),
        checkbox('Let accounts make polls', settings.polls, value => save({ polls: value })),
        checkbox('One activity per request', settings.incremental, value => save({ incremental: value })),
        settings.incremental
            ? field('Requests at once', numberInput(settings.concurrency, 1, 6, value => save({ concurrency: value })),
                'Several tiny requests in flight together. Posts land first, then individual replies, reposts, likes and votes. More at once is faster but pricier because every request carries the timeline context.')
            : null,
        el('p', { className: 'sbtw-hint', text: 'Each request returns one post or one reaction in a small JSON object, and the timeline fills in as they land. Posts above is how many.' }),

        el('h4', { text: 'Pictures' }),
        checkbox('Generate images for some posts', settings.images.enabled, value => savePart('images', { enabled: value })),
        settings.images.enabled
            ? field('Images per refresh', numberInput(settings.images.perRefresh, 0, 50, value => savePart('images', { perRefresh: value })),
                'Uses your existing image setup. A failed image just posts the text.')
            : null,
        settings.images.enabled
            ? field('Image directions', el('textarea', {
                className: 'sbtw-input',
                attrs: { rows: '3', maxlength: '4000', placeholder: 'Leave blank for the default.' },
                on: { change: (event) => savePart('images', { instructions: event.target.value }) },
            }, [document.createTextNode(settings.images.instructions)]))
            : null,

        el('h4', { text: 'Voice' }),
        field('Tone instructions', el('textarea', {
            className: 'sbtw-input',
            attrs: { rows: '6', placeholder: 'Leave blank for the default.' },
            on: { change: (event) => save({ tone: event.target.value }) },
        }, [document.createTextNode(settings.tone)]),
        'Only the tone. The rules that keep a refresh parseable are not editable, so you cannot break it from here.'),

        el('h4', { text: 'How much history it reads' }),
        el('div', { className: 'sbtw-row' }, [
            field('Hours back', numberInput(settings.history.hours, 1, 720, value => savePart('history', { hours: value }))),
            field('Posts to read', numberInput(settings.history.posts, 1, 100, value => savePart('history', { posts: value }))),
            field('Replies per post', numberInput(settings.history.replies, 0, 12, value => savePart('history', { replies: value }))),
        ]),
        el('p', { className: 'sbtw-hint', text: 'What the model is shown of the timeline so far. This is most of every request, and it does not depend on how much a refresh writes - so a long window makes a small refresh just as slow and just as expensive. Raise it for longer memory, lower it for quicker, cheaper refreshes.' }),
        ]),

        settingsGroup('Chats', 'What the timeline reads from your open chat, feeds back into chats, and does when you return.', () => [
        el('h4', { text: 'The chat you have open' }),
        checkbox('Let characters react to the roleplay', settings.scene.enabled, value => savePart('scene', { enabled: value })),
        el('p', { className: 'sbtw-hint', text: 'Sends the last few messages of the chat you have open to this timeline\'s model, so the characters in that scene can post about their own day. Only they may mention it. Off by default: with it on, chat text leaves the chat and goes wherever the connection above points.' }),

        el('h4', { text: 'Feeding it back into chats' }),
        checkbox('Mention recent activity in chats', settings.carry.enabled, value => savePart('carry', { enabled: value })),
        settings.carry.enabled
            ? el('div', { className: 'sbtw-row' }, [
                field('Look back (hours)', numberInput(settings.carry.hours, 1, 720, value => savePart('carry', { hours: value }))),
                field('At most', numberInput(settings.carry.items, 1, 50, value => savePart('carry', { items: value }))),
                field('Depth', numberInput(settings.carry.depth, 0, 100, value => savePart('carry', { depth: value }))),
            ])
            : null,

        el('h4', { text: 'Catching up' }),
        field('Refresh on opening, if this many hours have passed',
            numberInput(settings.catchUpHours, 0, 720, value => save({ catchUpHours: value })),
            'Zero turns it off. Nothing happens while Neconyan is closed.'),
        ]),

        recoveryControls(),
        // Fenced and last, never inside a composer bar: that container drops button labels when narrow.
        el('div', { className: 'sbtw-danger-zone', attrs: { role: 'group', 'aria-labelledby': 'sbtw-danger-title' } }, [
            el('h3', { text: 'Reset or delete', attrs: { id: 'sbtw-danger-title' } }),
            el('p', { className: 'sbtw-hint', text: 'Reset clears posts, replies, likes, reposts and votes; profiles, follows and settings stay. Delete removes this whole timeline; other timelines and character profiles stay.' }),
            el('div', { className: 'sbtw-button-row' }, [
                button('Reset the timeline', 'sbtw-btn sbtw-btn-danger', () => resetTimeline(), { iconName: 'fa-broom', disabled: state.busy || Boolean(mutationTask) }),
                button('Delete this timeline', 'sbtw-btn sbtw-btn-danger', () => void deleteTimeline(), { iconName: 'fa-trash', disabled: state.busy || Boolean(mutationTask) }),
            ]),
        ]),
    ]);
}

// --- shell ----------------------------------------------------------------

function navButton(label, iconName, view, { badge = 0 } = {}) {
    return el('button', {
        className: `sbtw-nav-item${state.view === view ? ' sbtw-nav-on' : ''}`,
        // Mobile hides the label span, so the name must live on the button too.
        attrs: { type: 'button', 'aria-label': badge ? `${label}, ${badge} new` : label, 'aria-current': state.view === view ? 'page' : null, 'data-focus-key': `nav:${view}` },
        on: {
            click: () => {
                state.view = view;
                if (view !== 'profile') {
                    state.profileKey = null;
                }
                if (view === 'notifications') {
                    state.notifSeenBefore = state.session?.notificationsSeenAt ?? 0;
                }
                if (view === 'timeline') {
                    markTimelineVisit();
                }
                render();
            },
        },
    }, [
        el('span', { className: 'sbtw-nav-icon' }, [icon(iconName), badge ? badgeNode(badge) : null]),
        el('span', { className: 'sbtw-nav-label', text: label }),
    ]);
}

function whoToFollow() {
    const me = personaAccount();
    if (!me) {
        return null;
    }
    const following = followingKeys();
    const suggestions = state.accounts
        .filter(account => account.kind === KIND_CHARACTER && account.key !== me.key && !following.has(account.key))
        .slice(0, 5);
    if (!suggestions.length) {
        return null;
    }
    return el('aside', { className: 'sbtw-rail' }, [
        el('h4', { text: 'Who to follow' }),
        ...suggestions.map(account => el('div', { className: 'sbtw-suggestion' }, [
            avatarButton(account, 'sm', account.key),
            el('div', { className: 'sbtw-suggestion-meta' }, [
                el('button', { className: 'sbtw-name', text: account.name, attrs: { type: 'button', 'data-focus-key': `name:${account.key}` }, on: { click: () => showProfile(account.key) } }),
                el('span', { className: 'sbtw-handle', text: `@${account.handle}` }),
            ]),
            button('Follow', 'sbtw-btn sbtw-btn-quiet', () => toggleFollow(account.key), { focusKey: `follow:${account.key}`, disabled: Boolean(mutationTask) }),
        ])),
    ]);
}

function switchSession(sessionId, options = {}) {
    const targetPersonaId = options.personaId || api.getSession(sessionId)?.personaId || '';
    const changingPersona = targetPersonaId
        && targetPersonaId !== globalThis.SillyTavern.getContext().userAvatar;
    if (!sessionId || (!changingPersona && sessionId === state.session?.id) || sessionTask) {
        return sessionTask ?? Promise.resolve(false);
    }
    const transition = ++transitionEpoch;
    const task = (async () => {
        try {
            invalidateWork();
            await closeFeedInternal(false);
            if (transition !== transitionEpoch) {
                return false;
            }
            pendingPersonaSwitch = changingPersona ? targetPersonaId : '';
            await api.selectSession(sessionId, options);
            if (transition !== transitionEpoch) {
                return false;
            }
            const opened = await openFeedNow();
            return transition === transitionEpoch && opened;
        } catch (error) {
            if (transition !== transitionEpoch) {
                return false;
            }
            console.error('[Meower] timeline switch failed', error);
            toast(String(error?.message ?? 'That timeline could not be opened.'), 'error');
            return false;
        } finally {
            pendingPersonaSwitch = '';
            if (sessionTask === task) {
                sessionTask = null;
            }
        }
    })();
    sessionTask = task;
    return task;
}

function createTimeline() {
    if (sessionTask) {
        return sessionTask;
    }
    const source = state.session;
    const transition = ++transitionEpoch;
    const task = (async () => {
        try {
            invalidateWork();
            await closeFeedInternal(false);
            if (transition !== transitionEpoch) {
                return false;
            }
            api.createSession({
                personaId: source?.personaId,
                invited: source?.invited,
                ambient: source?.ambient,
            });
            const opened = await openFeedNow();
            if (transition !== transitionEpoch || !opened) {
                return false;
            }
            state.view = 'settings';
            render();
            toast(`New timeline "${state.session?.name ?? 'Timeline'}" - invite characters, then refresh.`, 'info');
            return true;
        } catch (error) {
            if (transition !== transitionEpoch) {
                return false;
            }
            console.error('[Meower] timeline creation failed', error);
            toast(String(error?.message ?? 'A new timeline could not be created.'), 'error');
            return false;
        } finally {
            if (sessionTask === task) {
                sessionTask = null;
            }
        }
    })();
    sessionTask = task;
    return task;
}

/** Deletes the open timeline (feed file included) and opens the next one for this persona, or a fresh one. */
async function deleteTimeline() {
    if (state.busy || mutationTask || sessionTask || !state.session) {
        return false;
    }
    const session = state.session;
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm(
        `Delete "${session.name}"?`,
        'Its posts, replies, reactions, follows and persona profile go for good. Other timelines and character profiles stay.',
    );
    if (!confirmed || state.session?.id !== session.id || state.session?.personaId !== session.personaId || state.busy || mutationTask || sessionTask) {
        return false;
    }
    const transition = ++transitionEpoch;
    const task = (async () => {
        try {
            invalidateWork();
            await closeFeedInternal(false);
            if (transition !== transitionEpoch) {
                return false;
            }
            await api.deleteSession(session.id);
            const opened = await openFeedNow();
            if (transition !== transitionEpoch || !opened) {
                return false;
            }
            toast(`Deleted "${session.name}".`, 'success');
            return true;
        } catch (error) {
            if (transition !== transitionEpoch) {
                return false;
            }
            console.error('[Meower] timeline delete failed', error);
            toast(String(error?.message ?? 'The timeline could not be deleted.'), 'error');
            await openFeedNow();
            return false;
        } finally {
            if (sessionTask === task) {
                sessionTask = null;
            }
        }
    })();
    sessionTask = task;
    return task;
}

function sessionBar() {
    const personas = new Map(api.listPersonas().map(persona => [persona.entityId, persona.name]));
    const sessions = api.listSessions();
    const select = el('select', {
        className: 'sbtw-input sbtw-session-select',
        attrs: { 'aria-label': 'Timeline session', 'data-focus-key': 'session' },
        on: { change: event => void switchSession(event.target.value) },
    }, sessions.map(session => el('option', {
        text: `${session.name} · ${personas.get(session.personaId) ?? 'Unassigned'}`,
        attrs: { value: session.id, selected: session.id === state.session?.id ? 'selected' : null },
    })));
    return el('div', { className: 'sbtw-session-bar' }, [
        select,
        button('New timeline', 'sbtw-btn sbtw-btn-quiet', () => { void createTimeline(); }, { iconName: 'fa-plus' }),
    ]);
}

function focusedControl(root) {
    const active = document.activeElement;
    const key = active instanceof HTMLElement && root.contains(active) ? active.dataset.focusKey : '';
    if (!key) {
        return null;
    }
    const card = active.closest('[data-post-id], [data-reply-id], [data-repost-id], [data-section-key]');
    const scopeSelector = card ? anchorSelector(card) : '';
    const scopeIndex = card ? [...root.querySelectorAll(scopeSelector)].indexOf(card) : 0;
    const scope = card ?? root;
    const matches = [scope, ...scope.querySelectorAll(`[data-focus-key="${CSS.escape(key)}"]`)].filter(node => node.dataset.focusKey === key);
    return {
        key,
        index: matches.indexOf(active),
        scope: scopeSelector,
        scopeIndex,
        start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
        end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
        direction: active.selectionDirection,
        value: active.matches('textarea, select, input:not([type="checkbox"]):not([type="radio"]):not([type="file"])') ? active.value : null,
    };
}

function restoreFocusedControl(root, saved) {
    if (!saved) {
        return;
    }
    const scope = saved?.scope ? root.querySelectorAll(saved.scope)[saved.scopeIndex] : root;
    const matches = scope ? [scope, ...scope.querySelectorAll(`[data-focus-key="${CSS.escape(saved.key)}"]`)].filter(node => node.dataset.focusKey === saved.key) : [];
    const node = matches[saved.index];
    if (!(node instanceof HTMLElement) || node.matches(':disabled') || !node.getClientRects().length) {
        const fallback = scope?.matches('details') ? scope.querySelector('summary') : saved.scope ? scope : null;
        (fallback ?? root.querySelector('.sbtw-main') ?? root).focus({ preventScroll: true });
        return;
    }
    if (saved.value !== null) {
        node.value = saved.value;
    }
    node.focus({ preventScroll: true });
    if (saved.start !== null && typeof node.setSelectionRange === 'function') {
        node.setSelectionRange(saved.start, saved.end, saved.direction ?? 'none');
    }
}

function render() {
    if (!state.body) {
        return;
    }
    const focus = focusedControl(state.body);
    const oldMain = state.body.querySelector('.sbtw-main');
    const anchor = oldMain?.dataset.scrollKey ? scrollAnchorOf(oldMain) : null;
    if (oldMain?.dataset.scrollKey) {
        scrollPositions.set(oldMain.dataset.scrollKey, oldMain.scrollTop);
        for (const selector of ['.sbtw-invites', '.sbtw-rail', '.sbtw-trends']) {
            const node = state.body.querySelector(selector);
            if (node) {
                scrollPositions.set(`${oldMain.dataset.scrollKey}:${selector}`, { top: node.scrollTop, left: node.scrollLeft });
            }
        }
    }
    for (const details of state.body.querySelectorAll('[data-section-key]')) {
        openSections.set(details.dataset.sectionKey, details.open);
    }
    for (const details of state.body.querySelectorAll('.sbtw-settings-group')) {
        const title = details.querySelector('summary').dataset.focusKey.slice('group:'.length);
        openSettingsGroups[details.open ? 'add' : 'delete'](title);
    }
    if (state.opening || state.loadFailure || !state.feed) {
        state.body.classList.add('sbtw-shell-error');
        const failure = state.loadFailure;
        state.body.replaceChildren(
            ...(state.session && !state.opening ? [sessionBar()] : []),
            el('h3', { text: state.opening ? 'Opening Meower...' : failure?.kind === 'feed' ? 'The saved timeline could not be read' : failure?.kind === 'save' ? 'Latest changes could not be saved' : 'The timeline could not be opened' }),
            ...(failure ? [
                el('p', { className: 'sbtw-hint', text: String(failure.error?.message ?? 'Try again.') }),
                el('div', { className: 'sbtw-button-row' }, [
                    button('Try again', 'sbtw-btn sbtw-btn-primary', () => reopenFeed(), { disabled: Boolean(mutationTask) }),
                    state.session && ['feed', 'save'].includes(failure.kind)
                        ? button('Reset the timeline', 'sbtw-btn sbtw-btn-danger', () => resetTimeline(), { disabled: Boolean(mutationTask) }) : null,
                ]),
            ] : []),
        );
        patchStatus();
        restoreFocusedControl(state.body, focus);
        return;
    }
    state.body.classList.remove('sbtw-shell-error');
    postsById = new Map(state.feed.posts.map(post => [post.id, post]));
    interactionsById = new Map(state.feed.interactions.map(item => [item.id, item]));
    byPost = buildInteractionMap();
    cachedNotifications = null;
    const views = {
        timeline: timelineView,
        profile: profileView,
        notifications: notificationsView,
        settings: settingsView,
    };
    const sessionKey = state.session?.id ?? '';
    const scrollKey = state.view === 'timeline'
        ? `${sessionKey}:timeline:${state.tab}`
        : state.view === 'profile' ? `${sessionKey}:profile:${state.profileKey ?? ''}` : `${sessionKey}:${state.view}`;
    const main = el('main', {
        className: 'sbtw-main',
        attrs: { 'data-scroll-key': scrollKey, 'data-focus-key': `view:${state.view}`, tabindex: '-1', 'aria-label': state.view === 'profile' ? `${nameFor(state.profileKey)}'s profile` : ({ timeline: 'Home timeline', notifications: 'Notifications', settings: 'Meower settings' })[state.view] },
    }, [sessionBar(), (views[state.view] ?? timelineView)()]);
    const me = personaAccount();
    const nav = el('nav', { className: 'sbtw-nav', attrs: { 'aria-label': 'Timeline sections' } }, [
        // The generated cat at the head of the nav, a tap back to the top of the timeline.
        el('button', {
            className: 'sbtw-logo',
            attrs: { type: 'button', 'aria-label': 'Meower', title: 'Meower - back to the top of the timeline', 'data-focus-key': 'logo' },
            on: { click: () => { state.view = 'timeline'; state.profileKey = null; markTimelineVisit(); render(); const main = state.body?.querySelector('.sbtw-main'); if (main) { main.scrollTop = 0; } } },
        }, [catIcon()]),
        navButton('Home', 'fa-house', 'timeline', { badge: unseenTimeline() }),
        navButton('Activity', 'fa-bell', 'notifications', { badge: unseenNotifications() }),
        el('button', {
            className: `sbtw-nav-item${state.view === 'profile' ? ' sbtw-nav-on' : ''}`,
            attrs: {
                type: 'button',
                'aria-label': 'Profile',
                'aria-current': state.view === 'profile' ? 'page' : null,
                disabled: me ? null : 'disabled',
                title: me ? 'Profile' : 'Set a persona first',
                'data-focus-key': 'nav:profile',
            },
            on: { click: () => showProfile(me?.key ?? null) },
        }, [el('span', { className: 'sbtw-nav-icon' }, [icon('fa-user')]), el('span', { className: 'sbtw-nav-label', text: 'Profile' })]),
        navButton('Settings', 'fa-gear', 'settings'),
    ]);
    // A rail that does not exist must not be appended - DOM APIs would stringify the null.
    const rail = state.view === 'timeline' ? whoToFollow() : null;
    const viewKey = `${sessionKey}:${state.view}:${state.profileKey ?? ''}`;
    const changedView = state.body.dataset.viewKey !== viewKey;
    state.body.dataset.viewKey = viewKey;
    state.body.replaceChildren(...(rail ? [nav, main, rail] : [nav, main]));
    patchStatus();
    main.scrollTop = scrollPositions.get(scrollKey) ?? 0;
    for (const selector of ['.sbtw-invites', '.sbtw-rail', '.sbtw-trends']) {
        const saved = scrollPositions.get(`${scrollKey}:${selector}`);
        const node = state.body.querySelector(selector);
        if (saved && node) {
            node.scrollTop = saved.top;
            node.scrollLeft = saved.left;
        }
    }
    if (anchor && oldMain.dataset.scrollKey === scrollKey) {
        pinScrollAnchor(main, anchor);
    }
    if (changedView && (focus || !oldMain)) {
        main.focus({ preventScroll: true });
    } else {
        restoreFocusedControl(state.body, focus);
    }
    if (pendingReplyFocus) {
        const selector = `[data-focus-key="${CSS.escape(`reply-composer:${pendingReplyFocus}`)}"]`;
        const scope = replyFocusScope ? state.body.querySelector(replyFocusScope) : null;
        const field = scope?.querySelector(selector) ?? state.body.querySelector(selector);
        if (field) {
            pendingReplyFocus = null;
            field.focus({ preventScroll: true });
            field.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        }
    }
}

/**
 * Re-rendering replaces the whole scroller, and a raw scrollTop only survives that when
 * nothing above the reader changed height: a reply box opening or closing, a count
 * widening or an image arriving all move the page under the finger. So remember the
 * innermost post, reply or repost under the top edge and how far down it sat, and put
 * that same item back at that same place after the rebuild.
 */
function scrollAnchorOf(main) {
    const top = main.getBoundingClientRect().top;
    // Probe a little below the edge: a sub-pixel sliver of the item above is not what the
    // reader is looking at, and pinning it would let its own growth push everything down.
    const probe = top + 24;
    let spanning = null;
    let next = null;
    for (const node of main.querySelectorAll('[data-post-id], [data-reply-id], [data-repost-id]')) {
        const rect = node.getBoundingClientRect();
        if (rect.top <= probe && rect.bottom > probe) {
            spanning = node; // descendants come later in document order, so the innermost wins
        } else if (!next && rect.top > probe) {
            next = node;
        }
    }
    const node = spanning ?? next;
    return node ? { selector: anchorSelector(node), offset: node.getBoundingClientRect().top - top } : null;
}

function anchorSelector(node) {
    if (node.dataset.sectionKey) {
        return `[data-section-key="${CSS.escape(node.dataset.sectionKey)}"]`;
    }
    const own = node.dataset.postId ? `[data-post-id="${CSS.escape(node.dataset.postId)}"]`
        : node.dataset.replyId ? `[data-reply-id="${CSS.escape(node.dataset.replyId)}"]`
            : `[data-repost-id="${CSS.escape(node.dataset.repostId)}"]`;
    // A reply can be on screen twice (under its post and inside a repost of it): scope it to its card.
    const card = node.parentElement?.closest('[data-post-id], [data-repost-id], [data-section-key]');
    return card ? `${anchorSelector(card)} ${own}` : own;
}

function pinScrollAnchor(main, anchor) {
    const node = main.querySelector(anchor.selector);
    if (!node) {
        return;
    }
    const delta = node.getBoundingClientRect().top - main.getBoundingClientRect().top - anchor.offset;
    if (delta) {
        main.scrollTop += delta;
    }
}

function scrollToNotification(item) {
    const body = state.body;
    queueMicrotask(() => {
        if (state.body !== body || state.view !== 'timeline') {
            return;
        }
        const composerKey = (item.kind === 'reply' || item.kind === 'comment-reply')
            ? `reply-composer:${replyTargetKey({ postId: item.postId, parentInteractionId: item.interactionId })}`
            : '';
        const composer = composerKey
            ? state.body?.querySelector(`[data-focus-key="${CSS.escape(composerKey)}"]`)
            : null;
        const targetId = notificationTarget(item).interactionId;
        const target = targetId
            ? state.body?.querySelector(`[data-reply-id="${CSS.escape(targetId)}"], [data-repost-id="${CSS.escape(targetId)}"]`)
            : null;
        const node = composer ?? target ?? state.body?.querySelector(`[data-post-id="${CSS.escape(item.postId)}"]`);
        node?.focus({ preventScroll: true });
        node?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
}

// --- actions --------------------------------------------------------------

async function refreshAccounts(sessionId = state.session?.id) {
    if (!sessionId) {
        return false;
    }
    const request = ++accountRequest;
    const body = state.body;
    const personaId = state.session?.personaId;
    const epoch = sessionEpoch;
    const accounts = await api.currentAccounts(sessionId);
    if (request !== accountRequest
        || state.body !== body
        || state.session?.id !== sessionId
        || state.session?.personaId !== personaId
        || epoch !== sessionEpoch) {
        return false;
    }
    setAccounts(accounts);
    state.session = api.getSession(sessionId) ?? state.session;
    return true;
}

function publish(text) {
    const me = personaAccount();
    const body = String(text ?? '').trim();
    if (!me || !state.draftReady || mutationTask || !state.feed || !state.session || (!body && !state.draft.image && !state.draft.poll)) {
        return;
    }
    if (state.imagePending) {
        report('Wait for the image upload, or cancel it before posting.', 'warning');
        return;
    }
    if (String(text ?? '').length > POST_MAX_CHARS) {
        report(`A post can have at most ${POST_MAX_CHARS} characters.`, 'warning');
        return;
    }
    if (state.draftOwner?.sessionId !== state.session.id || state.draftOwner?.personaId !== state.session.personaId) {
        report('This draft belongs to another persona. Switch back to post it.', 'warning');
        return;
    }
    const options = (state.draft.poll ?? []).map(option => option.trim()).filter(Boolean);
    const unique = [...new Set(options)];
    if (state.draft.poll && (unique.length < 2 || options.length > 4 || options.some(option => option.length > 120))) {
        report('A poll needs two to four different options, each at most 120 characters.', 'warning');
        return;
    }
    const context = globalThis.SillyTavern.getContext();
    const post = {
        id: context.uuidv4(),
        authorKey: me.key,
        body,
        createdAt: Date.now(),
        image: state.draft.image ? { url: state.draft.image, prompt: (state.draft.imageDescription ?? '').slice(0, 2000) } : null,
        poll: unique.length >= 2
            ? { question: '', options: unique.slice(0, 4).map((option, index) => ({ id: `option-${index}`, text: option })) }
            : null,
        authorSnapshot: snapshotOf(me),
    };
    state.feed.posts.push(post);
    if (!persist()) {
        state.feed.posts = state.feed.posts.filter(item => item !== post);
        return;
    }
    state.draft = { text: '', image: '', poll: null, imageDescription: '' };
    saveDraft();
    state.view = 'timeline';
    state.tab = 'main';
    state.timelineSearch = '';
    state.revealTarget = { postId: post.id, interactionId: null };
    // render() hands the focused field its old text back (so a background re-render never
    // eats what you are typing); when posting from the keyboard the field is still focused.
    if (document.activeElement instanceof HTMLTextAreaElement && document.activeElement.dataset.focusKey === 'post-composer') {
        document.activeElement.value = '';
    }
    render();
}

function addReply(post, text, parentInteractionId = null) {
    const me = personaAccount();
    if (!me || !state.draftReady || mutationTask || !state.feed || !post || !state.feed.posts.some(item => item.id === post.id)) {
        return;
    }
    if (state.draftOwner?.sessionId !== state.session?.id || state.draftOwner?.personaId !== state.session?.personaId) {
        report('This draft belongs to another persona. Switch back to post it.', 'warning');
        return;
    }
    if (!String(text ?? '').trim() || String(text).length > REPLY_MAX_CHARS) {
        report(`A reply needs text and can have at most ${REPLY_MAX_CHARS} characters.`, 'warning');
        return;
    }
    const parent = parentInteractionId ? answerableOn(post.id, parentInteractionId) : null;
    if (parentInteractionId && !parent) {
        report('That comment is no longer available. Your draft has been kept.', 'warning');
        state.replyingTo = null;
        pendingReplyFocus = null;
        render();
        return;
    }
    const context = globalThis.SillyTavern.getContext();
    const reply = {
        id: context.uuidv4(),
        postId: post.id,
        type: 'reply',
        actorKey: me.key,
        content: text,
        parentInteractionId: parent?.id ?? null,
        pollOptionIndex: null,
        createdAt: Date.now(),
        actorSnapshot: snapshotOf(me),
    };
    state.feed.interactions.push(reply);
    if (!persist()) {
        state.feed.interactions = state.feed.interactions.filter(item => item.id !== reply.id);
        return;
    }
    const target = { postId: post.id, parentInteractionId: parent?.id ?? null };
    state.replyingTo = null;
    replyDrafts.delete(replyTargetKey(target));
    saveDraft();
    pendingReplyFocus = null;
    state.revealTarget = { postId: post.id, interactionId: reply.id };
    render();
}

async function deleteReply(reply) {
    const me = personaAccount();
    if (!me || mutationTask || reply.actorKey !== me.key) {
        return;
    }
    const body = state.body;
    const sessionId = state.session?.id;
    const feed = state.feed;
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm(
        'Delete this reply?',
        'Replies to it will stay in the conversation.',
    );
    if (!confirmed || mutationTask || state.body !== body || state.session?.id !== sessionId || state.feed !== feed) {
        return;
    }
    const { interactions, ...taken } = removeReply(feed.interactions, reply.id);
    const removedIds = new Set(taken.removed.map(item => item.id));
    feed.interactions = interactions;
    if (removedIds.has(state.replyingTo?.parentInteractionId)) {
        state.replyingTo = null;
        pendingReplyFocus = null;
    }
    if (removedIds.has(state.revealTarget?.interactionId)) {
        state.revealTarget = null;
    }
    if ([...removedIds].some(id => state.engagementFor?.startsWith(`${id}:`))) {
        state.engagementFor = null;
    }
    persist();
    render();
    undoToast('Reply deleted.', () => {
        if (state.body !== body || state.feed !== feed) {
            return;
        }
        if (!feed.posts.some(post => post.id === reply.postId)) {
            report('The post was deleted, so its reply cannot be restored.', 'warning');
            return;
        }
        feed.interactions = restoreReply(feed.interactions, reply.id, taken);
        persist();
        render();
        focusControl(`delete-reply:${reply.id}`);
    });
}

/** Like or repost a post, or with `reply` that comment itself; a second tap takes it back. */
function toggle(postId, type, reply = null) {
    const me = personaAccount();
    if (!me || mutationTask || !state.feed?.posts.some(post => post.id === postId)
        || (reply && !state.feed.interactions.some(item => item.id === reply.id && isAnswerable(item)))) {
        return;
    }
    const existing = reply ? (replyStatsFor(postId, reply.id).mine.get(type) ?? null) : myInteraction(postId, type);
    if (existing) {
        state.feed.interactions = state.feed.interactions.filter(item => item !== existing);
    } else {
        const context = globalThis.SillyTavern.getContext();
        state.feed.interactions.push({
            id: context.uuidv4(),
            postId,
            type,
            actorKey: me.key,
            content: null,
            parentInteractionId: reply?.id ?? null,
            pollOptionIndex: null,
            createdAt: Date.now(),
            actorSnapshot: snapshotOf(me),
        });
    }
    persist();
    render();
}

function vote(post, index) {
    const me = personaAccount();
    if (!me || mutationTask || !state.feed?.posts.some(item => item.id === post.id)
        || !Number.isInteger(index) || !post.poll?.options[index]) {
        return;
    }
    const existing = myInteraction(post.id, 'vote');
    if (existing && existing.pollOptionIndex === index) {
        // Tapping your own choice again withdraws the vote, like unlike and unrepost.
        state.feed.interactions = state.feed.interactions.filter(item => item !== existing);
    } else if (existing) {
        // Changing your mind is allowed; voting twice is not.
        existing.pollOptionIndex = index;
        existing.createdAt = Date.now();
    } else {
        const context = globalThis.SillyTavern.getContext();
        state.feed.interactions.push({
            id: context.uuidv4(),
            postId: post.id,
            type: 'vote',
            actorKey: me.key,
            content: null,
            parentInteractionId: null,
            pollOptionIndex: index,
            createdAt: Date.now(),
            actorSnapshot: snapshotOf(me),
        });
    }
    persist();
    render();
}

async function deletePost(post) {
    if (mutationTask || !state.feed || post.authorKey !== personaAccount()?.key) {
        return;
    }
    const body = state.body;
    const sessionId = state.session?.id;
    const feed = state.feed;
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm('Delete this post?', 'Its replies, likes and reposts go too.');
    if (!confirmed || mutationTask || state.body !== body || state.session?.id !== sessionId || state.feed !== feed) {
        return;
    }
    const removed = feed.interactions.filter(item => item.postId === post.id);
    feed.posts = feed.posts.filter(item => item.id !== post.id);
    feed.interactions = feed.interactions.filter(item => item.postId !== post.id);
    if (state.replyingTo?.postId === post.id) {
        state.replyingTo = null;
        pendingReplyFocus = null;
    }
    if (state.revealTarget?.postId === post.id) {
        state.revealTarget = null;
    }
    if ([post, ...removed].some(item => state.engagementFor?.startsWith(`${item.id}:`))) {
        state.engagementFor = null;
    }
    persist();
    render();
    undoToast('Post deleted.', () => {
        if (state.body !== body || state.feed !== feed) {
            return;
        }
        if (!feed.posts.some(item => item.id === post.id)) {
            feed.posts.push(post);
        }
        const existingIds = new Set(feed.interactions.map(item => item.id));
        feed.interactions.push(...removed.filter(item => !existingIds.has(item.id)));
        persist();
        render();
        focusControl(`delete-post:${post.id}`);
    });
}

function toggleFollow(targetKey) {
    const me = personaAccount();
    if (!me || mutationTask) {
        return;
    }
    // A refresh in flight may have committed follows for other actors since state.session
    // was loaded; merge into the stored session so this tap does not undo them.
    const session = api.getSession(state.session.id) ?? state.session;
    const current = session.follows[me.key] ?? [];
    const next = current.includes(targetKey)
        ? current.filter(key => key !== targetKey)
        : [...current, targetKey];
    state.session = api.updateSession(state.session.id, {
        follows: { ...session.follows, [me.key]: next },
    });
    render();
}

async function showProfile(key) {
    if (!key) {
        return;
    }
    if (!accountFor(key)) {
        const epoch = sessionEpoch;
        try {
            if (!await refreshAccounts() || !isLive(epoch)) {
                return;
            }
        } catch (error) {
            if (isLive(epoch)) {
                report(error.message || 'The profile could not be opened.', 'error');
            }
            return;
        }
    }
    state.profileKey = key;
    state.view = 'profile';
    render();
}

async function openImage(url, description = '') {
    const context = globalThis.SillyTavern.getContext();
    const image = el('img', { className: 'sbtw-viewer', attrs: { src: url, alt: description } });
    await new context.Popup(image, context.POPUP_TYPE.DISPLAY, '', { wide: true, large: true }).show();
}

/**
 * A refresh belongs to its session: closing the workspace, resetting the timeline or a newer
 * run aborts it through its signal, and every await is followed by a staleness check so
 * stale work can never render, toast, or clear a live run's state.
 */
async function refresh({ topic = '' } = {}) {
    if (state.busy || state.opening || mutationTask || !state.feed || !state.session) {
        return;
    }
    state.busy = true;
    // Whatever is on screen has been seen by the time you ask for more: the badge counts what this refresh brings.
    markTimelineVisit();
    state.status = topic ? `Writing posts about ${topic}...` : 'Thinking...';
    const sessionId = state.session.id;
    const { epoch, signal } = freshSignal();
    const runs = ++refreshRuns;
    // Tallied per committed wave rather than diffed from the feed length: the user keeps
    // posting and deleting while the model writes, and a Stop should count only its work.
    const landed = { posts: 0, reactions: 0 };
    render();
    try {
        const result = await api.runRefresh({
            sessionId,
            feed: state.feed,
            signal,
            topic,
            onProgress: (message) => {
                if (!isLive(epoch) || signal.aborted) {
                    return;
                }
                // Progress patches only the status line: a full rerender here would
                // destroy scroll position, focus, and drafts on every image drawn.
                state.status = message;
                patchStatus();
            },
            // One-post-at-a-time mode: each committed post is shown as it lands.
            onPartial: (batch) => {
                landed.posts += batch.posts.length;
                landed.reactions += batch.interactions.length;
                if (isLive(epoch)) {
                    state.feedEpoch += 1;
                    state.session = api.getSession(sessionId);
                    // Refresh the roster before exposing new profile links, on every view.
                    void refreshAccounts(sessionId).then(current => {
                        if (current && isLive(epoch)) {
                            render();
                        }
                    }).catch(error => {
                        if (isLive(epoch)) {
                            report('New activity was saved, but its account list could not be refreshed. Try reopening Meower.', 'warning');
                            console.error('[Meower] partial account refresh failed', error);
                        }
                    });
                }
            },
        });
        if (!isLive(epoch)) {
            return;
        }
        state.feedEpoch += 1;
        state.session = api.getSession(sessionId);
        try {
            await refreshAccounts(sessionId);
        } catch (error) {
            if (isLive(epoch)) {
                report('The refresh was saved, but the account list could not be refreshed. Try reopening Meower.', 'warning');
                console.error('[Meower] completed refresh account list failed', error);
            }
            return;
        }
        if (!isLive(epoch)) {
            return;
        }
        if (result.warnings.length) {
            console.warn('[Meower] refresh warnings', result.warnings);
        }
        if (!result.posts.length && !result.interactions.length) {
            report(`The model returned nothing usable this time.${result.warnings.length ? ` ${result.warnings.length} note(s) in the console.` : ''}`, 'warning');
        } else {
            report(summarizeRefresh(result, { accounts: state.accounts, topic }), 'success');
        }
    } catch (error) {
        if (!isLive(epoch)) {
            console.warn('[Meower] refresh cancelled', error);
            return;
        }
        if (signal.aborted) {
            // Stopped by the user. Everything committed before the stop is already durable and stays.
            state.feedEpoch += 1;
            state.session = api.getSession(sessionId);
            await refreshAccounts(sessionId).catch(cause => console.warn('[Meower] accounts did not refresh after the stop', cause));
            if (!isLive(epoch)) {
                return;
            }
            report(landed.posts || landed.reactions
                ? `Refresh stopped. ${plural(landed.posts, 'post')} and ${plural(landed.reactions, 'reaction')} that had landed stay.`
                : 'Refresh stopped.', 'info');
            return;
        }
        console.error('[Meower] refresh failed', error);
        report(error.message || 'The refresh failed. Try again.', 'error');
    } finally {
        if (runs === refreshRuns && isLive(epoch)) {
            state.busy = false;
            render();
        }
    }
}

async function resetTimeline() {
    if (state.busy || state.opening || mutationTask || !state.session) {
        return false;
    }
    const body = state.body;
    const session = state.session;
    const sessionId = session.id;
    const feed = state.feed;
    const context = globalThis.SillyTavern.getContext();
    const confirmed = await context.Popup.show.confirm(
        'Reset the timeline?',
        'Posts, replies, likes, reposts, votes and any unsaved timeline changes go. This replaces failed saves too. Drafts, profiles, follows and settings stay. This cannot be undone.',
    );
    if (!confirmed || state.body !== body || state.session?.id !== sessionId || state.feed !== feed || state.busy || mutationTask) {
        return false;
    }
    invalidateWork();
    clearUndo();
    state.status = 'Resetting the timeline...';
    const task = (async () => {
        try {
            await syncingFeed;
            const cleared = { posts: feed?.posts.length ?? 0, reactions: feed?.interactions.length ?? 0 };
            const empty = await api.replaceFeed({ version: 1, posts: [], interactions: [] }, sessionId);
            // The replacement commits even if the reader has closed or left this view.
            if (feed) {
                Object.assign(feed, empty);
            }
            const message = feed
                ? `Timeline reset: ${plural(cleared.posts, 'post')} and ${plural(cleared.reactions, 'reaction')} cleared. Drafts, profiles, follows and settings kept.`
                : 'Timeline reset. Drafts, profiles, follows and settings kept.';
            if (state.body === body && state.session?.id === sessionId && state.feed === feed) {
                state.feed = empty;
                state.feedEpoch += 1;
                state.loadFailure = null;
                state.session = api.getSession(sessionId);
                state.timelineSearch = '';
                state.replyingTo = null;
                state.revealTarget = null;
                pendingReplyFocus = null;
                try {
                    await refreshAccounts(sessionId);
                } catch (error) {
                    if (state.body === body) {
                        state.loadFailure = { kind: 'accounts', error };
                    }
                }
                if (state.body === body && state.session?.id === sessionId) {
                    report(message, 'success');
                }
            } else {
                toast(`Reset '${session.name}'. Drafts, profiles, follows and settings kept.`, 'success');
            }
            return true;
        } catch (error) {
            console.error('[Meower] resetting the saved feed failed', error);
            if (state.body === body && state.session?.id === sessionId) {
                report(error.message || 'The saved timeline could not be reset.', 'error');
            } else {
                toast(`Could not reset '${session.name}': ${error.message ?? 'save failed'}`, 'error');
            }
            return false;
        }
    })();
    mutationTask = task;
    render();
    try {
        return await task;
    } finally {
        if (mutationTask === task) {
            mutationTask = null;
            render();
        }
    }
}

// --- opening --------------------------------------------------------------

function syncLaunchState(open) {
    const launch = document.getElementById(LAUNCH_ID);
    launch?.classList.toggle('is-active', open);
    launch?.setAttribute('aria-pressed', String(open));
    window.dispatchEvent(new CustomEvent('neconyan:hopper-state-changed', { detail: { open } }));
}

function closeFeedInternal(cancelTransition, allowExpectedPersonaSwitch = false) {
    document.removeEventListener('visibilitychange', syncVisibleFeed);
    window.removeEventListener('focus', syncVisibleFeed);
    clearInterval(syncTimer);
    syncTimer = null;
    saveStatusSubscription?.();
    saveStatusSubscription = null;
    const expectedPersonaChange = allowExpectedPersonaSwitch && pendingPersonaSwitch
        && globalThis.SillyTavern.getContext().userAvatar === pendingPersonaSwitch;
    if (cancelTransition && !expectedPersonaChange) {
        transitionEpoch += 1;
    }
    accountRequest += 1;
    const host = document.getElementById('sheld');
    if (!state.body && !openTask && !host?.hasAttribute('data-sbtw-mode')) {
        return closingTask;
    }
    if (state.draftReady && !saveDraft()) {
        toast(state.draftError, 'error');
    }
    const restoreFocus = state.body?.contains(document.activeElement);
    const pendingMutation = mutationTask;
    const pendingSync = syncingFeed;
    clearUndo();
    invalidateWork();
    openTask = null;
    refreshRuns += 1;
    uploadToken += 1;
    state.body?.remove();
    state.body = null;
    state.session = null;
    state.feed = null;
    setAccounts([]);
    state.replyingTo = null;
    state.status = '';
    state.busy = false;
    state.opening = false;
    state.loadFailure = null;
    state.imagePending = false;
    state.draft = { text: '', image: '', poll: null, imageDescription: '' };
    state.draftOwner = null;
    state.draftReady = false;
    state.draftError = '';
    state.syncError = '';
    state.timelineSearch = '';
    state.revealTarget = null;
    replyDrafts.clear();
    pendingReplyFocus = null;
    byPost = new Map();
    postsById = new Map();
    interactionsById = new Map();
    cachedNotifications = null;
    scrollPositions.clear();
    listLimits.clear();
    host?.removeAttribute('data-sbtw-mode');
    syncLaunchState(false);
    if (restoreFocus) {
        const target = opener?.isConnected && opener.getClientRects().length ? opener : document.getElementById(LAUNCH_ID);
        if (target?.getClientRects().length) {
            target.focus({ preventScroll: true });
        }
    }
    const previous = closingTask;
    closingTask = (async () => {
        try {
            await previous;
        } catch {
            // flushFeed below retries any snapshot retained by the failed close.
        }
        await pendingMutation;
        await pendingSync;
        await api.flushFeed();
    })();
    void closingTask.catch(error => {
        console.error('[Meower] final save failed', error);
        toast(error.message || 'The latest timeline changes could not be saved. Reopen Meower to retry.', 'error');
    });
    return closingTask;
}

export function closeFeed({ cancelTransition = true, allowExpectedPersonaSwitch = false } = {}) {
    return closeFeedInternal(cancelTransition, allowExpectedPersonaSwitch);
}

export function isFeedBusy() {
    return Boolean(state.busy || state.opening || mutationTask || sessionTask || syncingFeed || openTask);
}

function leaveForStory() {
    void closeFeed();
}

function handleHostNavigation(event) {
    if (event.target instanceof Element
        && event.target.closest('#sb-home-toggle, [data-neconyan-route="home"], #sb_character_mode_toggle [data-sb-character-mode]')) {
        // Restore the host workspace before its own click handler decides what Home means.
        void closeFeed();
    }
}

async function reopenFeed() {
    try {
        await closeFeed();
    } catch (error) {
        // Opening shows the save failure with Retry and an explicitly confirmed reset.
        console.warn('[Meower] reopening with unsaved changes', error);
    }
    return openFeed();
}

async function waitForClosing() {
    let retried = false;
    while (true) {
        const pending = closingTask;
        try {
            await pending;
        } catch (error) {
            if (pending !== closingTask) {
                continue;
            }
            if (retried) {
                throw error;
            }
            retried = true;
            closingTask = api.flushFeed();
            void closingTask.catch(saveError => console.error('[Meower] final save retry failed', saveError));
            continue;
        }
        if (pending === closingTask) {
            return;
        }
    }
}

async function openFeedNow() {
    if (openTask) {
        return openTask;
    }
    if (state.body?.isConnected) {
        document.getElementById('sb_character_shell_close')?.click();
        return true;
    }
    const task = startFeed();
    openTask = task;
    return task.finally(() => {
        if (openTask === task) {
            openTask = null;
        }
    });
}

/** Rapid double-clicks share one load instead of building two workspaces over one state. */
export function openFeed() {
    if (sessionTask) {
        return sessionTask;
    }
    return openFeedNow().catch(error => {
        console.error('[Meower] opening the timeline failed', error);
        toast(error.message || 'Meower could not be opened.', 'error');
        return false;
    });
}

async function startFeed() {
    const host = document.getElementById('sheld');
    if (!host) {
        toast('The chat workspace is not available yet.', 'warning');
        return false;
    }
    invalidateWork();
    const openingEpoch = sessionEpoch;
    uploadToken += 1;
    state.imagePending = false;
    opener = document.activeElement;
    state.opening = true;
    state.loadFailure = null;
    state.status = 'Reading the saved timeline...';
    const body = el('div', {
        className: 'sbtw-shell sbtw-shell-error',
        attrs: { role: 'region', 'aria-label': 'Meower', tabindex: '-1' },
    });
    state.body = body;
    saveStatusSubscription ??= api.subscribeSaveStatus(patchStatus);
    document.addEventListener('visibilitychange', syncVisibleFeed);
    window.addEventListener('focus', syncVisibleFeed);
    syncTimer ??= setInterval(syncVisibleFeed, 15000);
    window.dispatchEvent(new CustomEvent('sb:close-conversation-workspace'));
    document.querySelector('#ica--tracker-panel [data-action="panel-close"]')?.click();
    host.dataset.sbtwMode = 'on';
    host.append(body);
    syncLaunchState(true);
    document.getElementById('sb_character_shell_close')?.click();
    let session = null;
    let feed = null;
    let accounts = [];
    let failure = null;
    render();
    body.focus({ preventScroll: true });
    try {
        await api.initializeStorage();
        if (!isLive(openingEpoch)) {
            return false;
        }
        session = api.ensureActiveSession();
        state.session = session;
        loadDraft(session);
    } catch (error) {
        failure = { kind: 'session', error };
    }
    if (!failure) {
        try {
            await waitForClosing();
        } catch (error) {
            failure = { kind: 'save', error };
        }
    }
    if (!isLive(openingEpoch)) {
        return false;
    }
    if (!failure) {
        try {
            feed = await api.loadFeed(session.id);
        } catch (error) {
            failure = { kind: 'feed', error };
        }
    }
    if (!isLive(openingEpoch)) {
        return false;
    }
    if (!failure) {
        try {
            accounts = await api.currentAccounts(session.id);
        } catch (error) {
            failure = { kind: 'accounts', error };
        }
    }
    if (!isLive(openingEpoch)) {
        return false;
    }
    state.session = session ? api.getSession(session.id) ?? session : null;
    state.feed = feed;
    setAccounts(accounts);
    state.feedEpoch += 1;
    state.opening = false;
    state.status = '';
    state.loadFailure = failure;
    state.view = 'timeline';
    state.tab = 'main';
    markTimelineVisit();
    state.profileKey = null;
    state.replyingTo = null;
    state.timelineSearch = '';
    state.revealTarget = null;
    pendingReplyFocus = null;
    scrollPositions.clear();
    render();
    if (failure) {
        console.error(`[Meower] the timeline ${failure.kind} could not be loaded`, failure.error);
        return false;
    } else {
        if (needsCatchUp(api.getSettings(), Date.now(), state.session)) {
            const last = state.session?.lastRefreshAt ?? 0;
            const hours = Math.round((Date.now() - last) / 3600000);
            toast(last ? `Catching up: it has been ${hours} hours since the last refresh.` : 'Catching up with a first refresh.', 'info');
            void refresh();
        }
        return true;
    }
}

function syncVisibleFeed() {
    if (document.hidden || !state.body || !state.feed || !state.session || state.loadFailure || state.opening || state.busy || mutationTask || syncingFeed) {
        return;
    }
    const feed = state.feed;
    const sessionId = state.session.id;
    const epoch = sessionEpoch;
    const task = (async () => {
        try {
            // ponytail: no revision is exposed by syncFeed; compare the data, not its object identity.
            const previous = { ...feed };
            const beforeFeed = JSON.stringify(feed);
            const beforeSettings = JSON.stringify(api.getSettings());
            await api.syncFeed(feed, sessionId);
            if (!isLive(epoch) || state.feed !== feed || state.busy || mutationTask) {
                return;
            }
            state.syncError = '';
            patchStatus();
            const feedChanged = beforeFeed !== JSON.stringify(feed);
            if (!feedChanged) {
                // Cached action handlers still refer to these exact rows until the next render.
                Object.assign(feed, previous);
            }
            if (!feedChanged && beforeSettings === JSON.stringify(api.getSettings())) {
                return;
            }
            if (feedChanged) {
                clearUndo();
                state.feedEpoch += 1;
            }
            if (await refreshAccounts(sessionId) && isLive(epoch) && state.feed === feed) {
                render();
            }
        } catch (error) {
            if (isLive(epoch) && state.feed === feed) {
                state.syncError = error.message || 'The timeline could not be checked for changes from another device.';
                patchStatus();
            }
        } finally {
            if (syncingFeed === task) {
                syncingFeed = null;
            }
        }
    })();
    syncingFeed = task;
    return task;
}

// --- mounting -------------------------------------------------------------

function mountCharacterButton() {
    if (document.getElementById(LAUNCH_ID)) {
        return;
    }
    const toggle = document.getElementById('sb_character_mode_toggle');
    if (!toggle?.parentElement) {
        return;
    }
    const node = el('button', {
        className: 'sb-character-shell-mode-button sbtw-launch',
        attrs: {
            id: LAUNCH_ID,
            type: 'button',
            title: 'Open Meower',
            'aria-label': 'Open Meower',
            'aria-pressed': 'false',
        },
        on: { click: () => openFeed() },
    }, [catIcon(), el('span', { text: 'Meower' })]);

    // Keep this outside the radiogroup, then visually place it in the pill with CSS.
    toggle.insertAdjacentElement('afterend', node);
    owned.add(node);
}

function mountWandItem() {
    if (document.getElementById(WAND_ID)) {
        return;
    }
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        return;
    }
    // Wand entries must be divs: the host styles #extensionsMenu > div.
    const node = el('div', {
        className: 'list-group-item flex-container flexGap5 interactable',
        attrs: { id: WAND_ID, tabindex: '0', role: 'button', 'aria-label': 'Open Meower' },
        on: {
            click: () => openFeed(),
            keydown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openFeed();
                }
            },
        },
    }, [
        catIcon('extensionsMenuExtensionButton'),
        el('span', { text: 'Meower' }),
    ]);
    menu.append(node);
    owned.add(node);
}

function mountDrawer() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) {
        return;
    }
    let drawer = document.getElementById(DRAWER_ID);
    if (!drawer) {
        const content = el('div', { className: 'inline-drawer-content', attrs: { id: `${DRAWER_ID}-content` } }, [
            el('p', { className: 'sbtw-hint', text: 'A pretend social timeline for your own cast. Everything lives in the Meower workspace - open it and use Settings there.' }),
            (() => { const open = button('Open Meower', 'sbtw-btn sbtw-btn-primary', () => openFeed()); open.prepend(catIcon()); return open; })(),
        ]);
        const toggle = el('div', {
            className: 'inline-drawer-toggle inline-drawer-header',
            attrs: { tabindex: '0', role: 'button', 'aria-expanded': 'false', 'aria-controls': `${DRAWER_ID}-content` },
        }, [
            el('b', { text: 'Meower' }),
            el('div', { className: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
        ]);
        const onToggle = () => {
            const open = toggle.getAttribute('aria-expanded') === 'true';
            toggle.setAttribute('aria-expanded', String(!open));
        };
        toggle.addEventListener('click', onToggle);
        toggle.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle.click();
            }
        });
        drawer = el('div', {
            className: 'inline-drawer sbtw-drawer',
            attrs: { id: DRAWER_ID, 'data-extension-name': EXTENSION_NAME },
        }, [toggle, content]);
        owned.add(drawer);
    }
    if (drawer.parentElement !== host) {
        host.append(drawer);
    }
}

export function mountAll() {
    document.body.classList.add(BODY_CLASS);
    document.addEventListener('click', handleHostNavigation, true);
    window.addEventListener('neconyan:open-story', leaveForStory);
    mountCharacterButton();
    mountWandItem();
    mountDrawer();
}

export function unmountAll() {
    document.removeEventListener('click', handleHostNavigation, true);
    window.removeEventListener('neconyan:open-story', leaveForStory);
    removeTrendPanGuard();
    void closeFeed();
    document.body.classList.remove(BODY_CLASS);
    for (const node of owned) {
        node.remove();
    }
    owned.clear();
}
