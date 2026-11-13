import {
    changeMewmory, getMewmoryLocator, getMewmoryScope, hideOverflowMessages, initMewmory, isMewmoryOffRecord, jumpToChatMessage,
    MEWMORY_CONFIG_CHANGED_KEY, mewmory, notifyMewmory, processMewmory, putMessageBackOnRecord, refreshMewmory, requestMewmory,
    retryMewmoryVisibilityRestore, setMewmoryOffRecord, stopMewmoryBackfill,
} from './index.js';
import { chat, getRequestHeaders } from '../../script.js';
import { currentUser } from '../user.js';
import { getFriendlyTokenizerName } from '../tokenizers.js';
import { uuidv4 } from '../utils.js';
import { dismissJob, retryJob } from '../jobs.js';
import { mewmoryConfigAutosave } from './config-autosave.js';
import { defaultLorebookName, sendToLorebook } from './lorebook.js';
import { PREFIX_PRESETS, RAG_DEFAULTS } from './rag-settings.js';
import {
    DECISION_ROLES, EXTRACTION_FOCUS_OPTIONS, JEV_DECISION_PRESETS, MESSAGE_WINDOW_PRESETS,
    defaultDecisionThreshold, detectMessageWindowPreset, effectiveDecisionMode, findDecisionPreset, isDecisionModel,
} from './jev-presets.js';

function displayedSkipReason(reason) {
    if (reason === 'Entity ID is empty or too long.') return 'A character or object reference is missing or invalid.';
    if (reason === 'Pawspective and \'what a character knows\' memories must belong to a character played by the AI, not to you.') {
        return 'This entry could not be linked to a recognised AI-controlled character. Character knowledge and Pawspective entries require one.';
    }
    return reason;
}

const tabs = [['now', 'Now'], ['story', 'Story'], ['pawspective', 'Pawspective'], ['archive', 'Archive'], ['recall', 'Recall'], ['settings', 'Settings']];
const kinds = { entity: 'Character or entity reference', state: 'Current state', event: 'Event', relationship: 'Relationship fact',
    knowledge: 'Character knowledge', commitment: 'Promise or unresolved matter', interview: 'Pawspective interview', overview: 'Current subject view' };
const kindBadges = { entity: 'NPC', state: 'State', event: 'Event', relationship: 'Relationship', knowledge: 'Knowledge',
    commitment: 'Promise', interview: 'Interview', overview: 'Current view' };
const tabHints = {
    now: 'What Mewmory will add to your next reply, and who is in the scene.',
    story: 'A recap of the story so far, promises still open, and who is connected to whom.',
    pawspective: 'How each character sees people, places and promises, and how that changed.',
    archive: 'Search everything Mewmory has remembered, plus the original messages. A match here is not necessarily used in a reply.',
    recall: 'Why each memory was picked, or left out, for the latest reply.',
    settings: 'Which models Mewmory uses, how much it may add, and upkeep for this chat.',
};
const roles = { extractor: 'Facts and events', pawspective: 'Pawspective interviews', embedding: 'Embeddings', selector: 'Recall selector', fallback: 'Recall fallback' };
const roleDescriptions = {
    extractor: 'Records what happened, character details, current states, knowledge and promises. It also decides when a Pawspective interview is warranted.',
    pawspective: 'Uses what a character knows to explore a meaningful change in their perspective. Interviews are imaginary and did not happen in the story.',
    embedding: 'Builds numerical search representations of saved text. Optional; keyword search works without this role.',
    selector: 'Chooses from existing search matches for the current scene. It does not write or rewrite memories.',
    fallback: 'Tries to choose memories when the first selector fails or cannot finish its selection. It still chooses only existing material.',
};
const MAX_FALLBACK_PROFILES = 10;
const SHARED_PROFILE = 'mewmory:shared-profile';
const SWITCHES = ['enableNewChats', 'autoUpdate', 'localOnly', 'excludeHistory', 'autoHide'];
const tokenizers = ['auto', 'o200k_base', 'cl100k_base', 'gpt2', 'llama', 'llama3', 'mistral', 'gemma', 'claude', 'qwen2', 'deepseek', 'nemo', 'jamba', 'yi'];
const ui = { root: null, tab: 'now', owner: '', subject: '', significance: '', status: '', kind: 'objective', query: '', offset: 0,
    source: null, editor: null, draft: null, configError: '', accountChanged: false, role: 'extractor', restore: null, matches: null,
    searchMode: 'hybrid', searchType: '', searchReport: null, running: false, progress: '', scope: '',
    sort: 'story', flag: '', importance: '', state: '', from: '', to: '', moreFilters: false, selected: new Set(), history: null, duplicates: null,
    estimate: null, loreName: '', loreNote: '', transferNote: '',
    layout: 'list', message: null, person: '', question: '', answer: null, askError: '', conflicts: null, conflictError: '', shareNote: '' };

/** Where a memory's newest message sits in the open chat, or -1 when it is not on screen (inherited or a card). */
function chatIndex(asOf) {
    const index = Number(asOf) - (Number(mewmory.view?.health?.nativeOffset) || 0);
    return Number.isSafeInteger(index) && index >= 0 && index < chat.length ? index : -1;
}

function node(tag, className = '', content = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content) element.textContent = content;
    return element;
}

function button(label, handler, { primary = false, disabled = false } = {}) {
    const element = node('button', 'menu_button' + (primary ? ' menu_button_primary' : ''), label);
    element.type = 'button';
    element.disabled = disabled || ui.running;
    element.addEventListener('click', () => { void handler?.(); });
    return element;
}

function numberValue(text) {
    return String(text).trim() === '' ? '' : Number(text);
}

function field(label, value, onChange, { type = 'text', multiline = false, options = null, key = label, hint = '', disabled = false, autosave = false,
    placeholder = '', hideLabel = false } = {}) {
    const wrapper = node('div', 'mewmory-field');
    const control = node(options ? 'select' : multiline ? 'textarea' : 'input', 'text_pole');
    control.id = 'mewmory-field-' + key;
    if (options) {
        for (const option of options) {
            const [value, name] = Array.isArray(option) ? option : [option, option];
            const item = node('option', '', name);
            item.value = value;
            control.append(item);
        }
    } else if (!multiline) {
        control.type = type;
        if (type === 'number') control.step = 'any';
        if (type === 'password') control.autocomplete = 'new-password';
    }
    control.value = value ?? '';
    control.disabled = disabled || ui.running;
    if (placeholder) control.placeholder = placeholder;
    control.addEventListener(options ? 'change' : 'input', () => {
        onChange(type === 'number' ? numberValue(control.value) : control.value);
        if (autosave) scheduleConfigSave({ immediate: Boolean(options) });
    });
    const caption = node('label', hideLabel ? 'mewmory-sr-only' : '', label);
    caption.htmlFor = control.id;
    wrapper.append(caption, control);
    if (hint) wrapper.append(node('small', 'mewmory-caption', hint));
    return wrapper;
}

function check(label, checked, onChange, disabled = false, { autosave = false } = {}) {
    const wrapper = node('label', 'mewmory-check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    input.disabled = disabled || ui.running;
    input.addEventListener('change', () => {
        onChange(input.checked);
        if (autosave) scheduleConfigSave({ immediate: true });
    });
    wrapper.append(input, node('span', '', label));
    return wrapper;
}

function section(title, ...controls) {
    const element = node('section', 'mewmory-section');
    if (!controls.length) {
        element.append(node('h4', '', title));
        return element;
    }
    const heading = node('div', 'mewmory-section-heading');
    heading.append(node('h4', '', title), ...controls);
    element.append(heading);
    return element;
}

function badge(text, tone = '') {
    const element = node('span', 'mewmory-badge', text);
    if (tone) element.dataset.tone = tone;
    return element;
}

function stats(entries, label) {
    const list = node('dl', 'mewmory-stats');
    if (label) list.setAttribute('aria-label', label);
    for (const { name, value, detail, bar } of entries) {
        const item = node('div', 'mewmory-stat');
        item.append(node('dt', '', name), node('dd', '', value));
        if (bar) item.append(bar);
        if (detail) item.append(node('dd', 'mewmory-caption', detail));
        list.append(item);
    }
    return list;
}

function empty(root, title, description, action, handler) {
    const block = node('div', 'mewmory-empty');
    block.append(node('h4', '', title), node('p', 'mewmory-caption', description));
    if (action) block.append(button(action, handler, { primary: true }));
    root.append(block);
}

function nameOf(id) {
    return mewmory.view?.entities.find(entity => entity.entityId === id)?.name
        || [...(mewmory.view?.records || []), ...(mewmory.view?.overviews || [])].find(record => record.subjectNames?.[id])?.subjectNames[id]
        || String(id).replace(/^subject:/, '').replaceAll('-', ' ');
}

/** Only the Archive filters that differ from 'show everything', so an unfiltered list asks for exactly what it always did. */
function archiveFilters() {
    return Object.fromEntries(Object.entries({
        sort: ui.sort === 'story' ? '' : ui.sort, flag: ui.flag, significance: ui.importance, status: ui.state,
        fromMessage: Number(ui.from) || 0, toMessage: Number(ui.to) || 0,
    }).filter(([, value]) => value));
}

function clearArchiveFilters() {
    Object.assign(ui, { kind: 'objective', sort: 'story', flag: '', importance: '', state: '', from: '', to: '', offset: 0 });
}

function filters() {
    if (ui.tab === 'pawspective') return { kind: 'interview', ownerId: ui.owner, subjectId: ui.subject,
        significance: ui.significance, status: ui.status, offset: ui.offset };
    if (ui.tab === 'archive') return { kind: ui.kind, query: ui.query, offset: ui.offset, ...archiveFilters() };
    return {};
}

/** Runs one panel action, then refreshes from the server. Exported for focused lifecycle tests. */
export async function act(action, { refresh = true } = {}) {
    if (ui.running) return;
    const scope = getMewmoryScope();
    ui.running = scope;
    render();
    try {
        await action(scope);
        if (scope !== getMewmoryScope()) return;
        mewmory.error = '';
        // The action may have changed job or config state through another route, so
        // an inspection that started before it must never answer this refresh.
        if (refresh) await refreshMewmory(filters(), { force: true });
    } catch (error) {
        if (scope === getMewmoryScope()) mewmory.error = error.message;
    } finally {
        if (ui.running === scope) ui.running = false;
        render();
    }
}

async function switchTab(tab) {
    ui.tab = tab;
    ui.offset = 0;
    ui.source = null;
    ui.editor = null;
    render();
    await act(() => refreshMewmory(filters()), { refresh: false });
}

function openEditor(record = null, kind = 'event') {
    ui.editor = record ? structuredClone(record) : {
        id: 'author:' + uuidv4(), kind, text: '', refs: [], dependencies: [], subjectIds: [],
        status: 'active', significance: 'low', evidenceRefs: [], ownerId: '',
        ...(kind === 'entity' ? { entityId: 'npc:' + uuidv4(), name: '', aliases: [], isCharacter: true, appearance: '', speech: '' } : {}),
    };
    render();
    document.getElementById('mewmory-editor')?.scrollIntoView({ block: 'nearest' });
    document.getElementById('mewmory-editor')?.querySelector('textarea, input')?.focus({ preventScroll: true });
}

function sourceButtons(refs) {
    const row = node('div', 'mewmory-source-links');
    for (const ref of refs) {
        const summary = mewmory.view?.sources.find(source => source.id === ref.id && source.revision === ref.revision);
        const label = summary?.type === 'chat' ? 'Message ' + (summary.sequence + 1)
            : summary?.speaker || 'Earlier source';
        row.append(button(label + ' · revision ' + ref.revision, () => act(async () => {
            ui.source = await requestMewmory('source/get', { ref });
        }, { refresh: false }).then(() => {
            const panel = document.getElementById('mewmory-source-panel');
            panel?.focus({ preventScroll: true });
            panel?.scrollIntoView({ block: 'nearest' });
        })));
    }
    return row;
}

function renderSource(root) {
    if (!ui.source) return;
    const source = ui.source;
    const block = section('Original source');
    block.id = 'mewmory-source-panel';
    block.tabIndex = -1;
    block.classList.add('mewmory-source');
    block.append(node('p', 'mewmory-caption', source.speaker + ' · revision ' + source.revision
        + (source.eligible ? ' · current' : ' · historical or excluded')),
    node('pre', 'mewmory-source-text', source.text));
    const actions = node('div', 'mewmory-actions');
    const excluded = mewmory.view?.sources.find(item => item.id === source.id)?.excluded;
    actions.append(button('Close source', () => { ui.source = null; render(); }),
        button(excluded ? 'Allow this source in recall' : 'Exclude this source from recall', () => act(async () => {
            await changeMewmory('source/exclude', { id: source.id, exclude: !excluded });
            ui.source = null;
        })));
    block.append(actions);
    root.append(block);
}

/** Splits two wordings into the words they share and the words only one of them has. Long texts are left whole. */
export function wordChanges(before, after) {
    const a = String(before || '').split(/(\s+)/).filter(Boolean);
    const b = String(after || '').split(/(\s+)/).filter(Boolean);
    if (a.length > 600 || b.length > 600) return before === after ? [['same', after]] : [['removed', before], ['added', after]].filter(([, text]) => text);
    const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
    const parts = [];
    const push = (type, text) => {
        if (parts.at(-1)?.[0] === type) parts.at(-1)[1] += text;
        else parts.push([type, text]);
    };
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) push('same', a[i++] + (j++, ''));
        else if (j < b.length && (i === a.length || rows[i][j + 1] >= rows[i + 1][j])) push('added', b[j++]);
        else push('removed', a[i++]);
    }
    return parts;
}

const versionActions = { generated: 'Mewmory rewrote it', corrected: 'You changed it', undo: 'A change was undone' };
const versionFields = [['status', 'Status'], ['significance', 'Importance'], ['pinned', 'Pinned'], ['excluded', 'Left out of replies'],
    ['evidenceStatus', 'How certain'], ['method', 'Learned through']];

function shown(value) {
    return typeof value === 'boolean' ? value ? 'yes' : 'no' : String(value ?? 'not set') || 'not set';
}

function renderHistory(article) {
    const history = ui.history;
    const block = node('div', 'mewmory-history');
    block.id = 'mewmory-history-' + history.id;
    block.append(node('strong', '', 'Earlier versions'));
    if (!history.versions.length) block.append(node('p', 'mewmory-caption', 'This memory has not changed since it was first saved.'));
    let newer = history.current;
    for (const version of history.versions) {
        const older = version.record;
        const entry = node('div', 'mewmory-version');
        entry.append(node('p', 'mewmory-caption', new Date(version.at).toLocaleString() + ' · ' + (versionActions[version.action] || 'Changed')));
        const text = node('p', 'mewmory-prose');
        for (const [type, words] of wordChanges(older.text, newer.text)) {
            const part = node(type === 'added' ? 'ins' : type === 'removed' ? 'del' : 'span', '', words);
            text.append(part);
        }
        if (text.childElementCount) entry.append(text);
        const changed = versionFields.filter(([key]) => shown(older[key]) !== shown(newer[key]))
            .map(([key, label]) => label + ': ' + shown(older[key]) + ' → ' + shown(newer[key]));
        if (changed.length) entry.append(node('p', 'mewmory-caption', changed.join(' · ')));
        if (older.text === newer.text && !changed.length) entry.append(node('p', 'mewmory-caption', 'The wording stayed the same; only its sources or links changed.'));
        block.append(entry);
        newer = older;
    }
    if (history.versions.length) block.append(node('p', 'mewmory-caption', 'Struck-through words were removed by that change; underlined words were added.'));
    article.append(block);
}

function renderRecord(record, root, { editable = true, selectable = false, onTick = null, jump = true } = {}) {
    const article = node('article', 'mewmory-record');
    const unused = record.eligible === false || Boolean(record.excluded);
    article.dataset.ineligible = String(record.eligible === false);
    article.dataset.kind = record.kind;
    article.dataset.unused = String(unused);
    article.dataset.pinned = String(Boolean(record.pinned));
    const heading = node('div', 'mewmory-record-heading');
    const subjects = (record.subjectIds || []).map(nameOf).join(', ');
    const title = record.kind === 'entity' ? record.name
        : record.ownerId ? nameOf(record.ownerId) + (subjects ? ' / ' + subjects : '') : kinds[record.kind];
    const badges = node('div', 'mewmory-badges');
    if (title !== kinds[record.kind] && kindBadges[record.kind]) badges.append(badge(record.kind === 'entity' && record.entityId === 'player' ? 'Your character' : kindBadges[record.kind]));
    if (record.pinned) badges.append(badge('Pinned', 'accent'));
    if (unused) badges.append(badge('Not used in replies', 'muted'));
    if (record.status && record.status !== 'active') badges.append(badge(record.status[0].toUpperCase() + record.status.slice(1), 'muted'));
    if (['high', 'medium'].includes(record.significance)) badges.append(badge(record.significance === 'high' ? 'High importance' : 'Medium importance',
        record.significance === 'high' ? 'accent' : ''));
    if (record.authorOverride) badges.append(badge('Edited by you'));
    if (selectable) {
        const tick = check('Tick ' + title, ui.selected.has(record.id), ticked => {
            if (ticked) ui.selected.add(record.id);
            else ui.selected.delete(record.id);
            onTick?.();
        });
        tick.classList.add('mewmory-tick');
        tick.querySelector('input').id = 'mewmory-tick-' + record.id;
        tick.querySelector('span').className = 'mewmory-sr-only';
        heading.append(tick);
    }
    heading.append(node('h4', '', title));
    if (badges.childElementCount) heading.append(badges);
    article.append(heading);
    const meta = [record.asOf >= 0 ? 'From message ' + (record.asOf + 1) : '',
        record.provenance?.model && !record.authorOverride ? 'Generated by ' + record.provenance.model
            + (record.provenance.modelRevision ? ' · ' + record.provenance.modelRevision : '') + ' · version ' + record.version : ''].filter(Boolean);
    if (meta.length) article.append(node('p', 'mewmory-caption mewmory-record-meta', meta.join(' · ')));
    if (record.eligible === false) article.append(node('p', 'mewmory-caption', 'Not used in replies: a message or memory it is based on changed, or it was switched off.'));
    if (record.kind === 'interview') {
        const interview = node('div', 'mewmory-interview');
        for (const turn of record.interview) interview.append(node('strong', '', turn.question), node('p', 'mewmory-prose', turn.answer));
        article.append(interview, node('p', 'mewmory-caption', 'Imaginary interview. Its actions are not events in the story.'));
        if (record.changeExplanation) article.append(node('p', 'mewmory-prose', 'Their explanation of the change: ' + record.changeExplanation));
    } else {
        if (record.text && record.text !== record.name) article.append(node('p', 'mewmory-prose', record.text));
        if (record.appearance) article.append(node('p', 'mewmory-prose', 'Appearance: ' + record.appearance));
        if (record.speech) article.append(node('p', 'mewmory-prose', 'Speech: ' + record.speech));
        if (record.evidenceStatus) article.append(node('p', 'mewmory-caption', 'How certain: ' + record.evidenceStatus));
        if (record.method) article.append(node('p', 'mewmory-caption', 'Learned through: ' + record.method));
    }
    if (record.refs?.length) {
        const sources = node('div', 'mewmory-record-sources');
        sources.append(node('span', 'mewmory-caption', 'Based on'), sourceButtons(record.refs));
        article.append(sources);
    }
    if (editable) {
        const actions = node('div', 'mewmory-actions');
        const corrections = [
            ['', 'Correct this memory…'], ['suspicion', 'Only a suspicion'], ['unsupported', 'Not supported by the story'],
            ['resolved', 'Resolved'], ['background', 'Keep in the background'], ['active', 'Active again'],
            ['pin', record.pinned ? 'Unpin' : 'Pin for this scene'], ['exclude', record.excluded ? 'Use in replies again' : 'Stop using in replies'],
        ];
        if (['knowledge', 'interview', 'overview'].includes(record.kind)) corrections.splice(2, 0, ['never_learned', 'This character never learned this']);
        const correction = field('Correction', '', action => {
            if (action) void act(() => changeMewmory('record/action', { id: record.id, action }));
        }, { options: corrections, key: 'correction-' + record.id, hideLabel: true });
        actions.append(correction, button('Edit', () => openEditor(record)),
            button('Undo last change', () => act(() => changeMewmory('record/action', { id: record.id, action: 'undo' }))));
        const at = jump ? chatIndex(record.asOf) : -1;
        if (at >= 0) actions.append(button('Go to message', () => void jumpToChatMessage(at)));
        if (record.version > 1) {
            const open = ui.history?.id === record.id;
            const toggle = button(open ? 'Hide earlier versions' : 'Earlier versions', () => open
                ? (ui.history = null, render())
                : act(async () => { ui.history = await requestMewmory('record/history', { id: record.id }); }, { refresh: false }));
            toggle.id = 'mewmory-versions-' + record.id;
            toggle.setAttribute('aria-expanded', String(open));
            actions.append(toggle);
        }
        article.append(actions);
        if (ui.history?.id === record.id) renderHistory(article);
    }
    root.append(article);
}

function resolvedDraftRoleModel(draft, roleName) {
    const role = draft?.roles?.[roleName];
    if (!role) return { model: '', endpoint: '' };
    const allProfiles = mewmory.config?.profiles || [];
    const usesShared = roleName !== 'embedding' && role.useShared === true;
    const profileId = usesShared ? draft.sharedProfileId : role.profileId;
    const profile = allProfiles.find(item => item.id === profileId);
    const override = usesShared ? draft.sharedModelOverride : role.modelOverride;
    const model = profileId ? (override || profile?.model || '') : (role.model || '');
    const endpoint = profileId ? '' : (role.endpoint || '');
    return { model, endpoint };
}

function applyDecisionPresetToRole(draft, roleName, presetId) {
    const role = draft?.roles?.[roleName];
    if (!role) return;
    if (presetId === 'custom') {
        if (role.useShared) {
            role.useShared = false;
            role.profileId = draft.sharedProfileId || '';
        }
        if (!role.profileId && !role.endpoint) {
            role.endpoint = 'http://127.0.0.1:8000/v1/systemone';
            role.apiKey = '';
            role.hasKey = false;
        }
        role.decisionMode = 'decision';
        if (role.profileId || String(role.model || '').trim()) {
            role.enabled = true;
        }
        return;
    }
    const preset = findDecisionPreset(presetId);
    if (!preset) return;
    role.enabled = true;
    if (role.useShared) {
        role.useShared = false;
        role.profileId = draft.sharedProfileId || '';
    }
    if (role.profileId) {
        role.modelOverride = preset.model;
    } else {
        const previousDefaultEndpoint = JEV_DECISION_PRESETS.some(item => item.endpoint === role.endpoint);
        role.model = preset.model;
        if ((!role.endpoint || previousDefaultEndpoint) && preset.endpoint && preset.endpoint !== role.endpoint) {
            role.endpoint = preset.endpoint;
            role.apiKey = '';
            role.hasKey = false;
        }
    }
    role.decisionMode = 'decision';
    role.decisionThreshold = preset.threshold;
}

function applyWindowPresetToDraft(draft, presetId) {
    const preset = MESSAGE_WINDOW_PRESETS.find(item => item.id === presetId);
    if (!draft || !preset) return;
    draft.historyMode = preset.historyMode;
    if (preset.historyMode === 'messages') {
        draft.recentMessages = preset.recentMessages;
        draft.historyBatchMessages = preset.historyBatchMessages;
        draft.batchMessages = preset.batchMessages;
    } else if (typeof preset.historyWindow === 'number') {
        draft.historyWindow = preset.historyWindow;
        if (typeof preset.batchMessages === 'number') draft.batchMessages = preset.batchMessages;
    }
    if (preset.extractionFocus) draft.extractionFocus = preset.extractionFocus;
}

function renderQuickSetup(root) {
    syncSettingsDraft();
    const draft = ui.draft;
    if (!draft || !mewmory.config) return;
    const selectorRole = draft.roles?.selector;
    const allProfiles = mewmory.config.profiles || [];
    const sharedProfile = allProfiles.find(profile => profile.id === draft.sharedProfileId);
    const { model: selectorModel, endpoint: selectorEndpoint } = resolvedDraftRoleModel(draft, 'selector');
    const selectorDecision = Boolean(effectiveDecisionMode({
        ...selectorRole,
        model: selectorModel,
        endpoint: selectorEndpoint,
    }) === 'decision');
    const quick = section('Memory focus and window',
        ...(selectorRole?.enabled && selectorDecision ? [badge('Jev / System One', 'accent')] : []),
        button('All model settings', () => switchTab('settings')));
    quick.id = 'mewmory-now-quick-controls';
    quick.classList.add('mewmory-quick-controls');
    const matchedDecision = findDecisionPreset(selectorModel);
    const presetSelectValue = matchedDecision?.id || (selectorDecision ? 'custom' : '');
    const windowPresetId = detectMessageWindowPreset(draft);
    const focusOption = EXTRACTION_FOCUS_OPTIONS.find(item => item.value === (draft.extractionFocus || 'balanced')) || EXTRACTION_FOCUS_OPTIONS[1];
    const fields = node('div', 'mewmory-fields');
    fields.append(
        field('Recall decision model', presetSelectValue, value => {
            if (!value) return;
            applyDecisionPresetToRole(draft, 'selector', value);
            render();
        }, {
            key: 'now-jev-preset',
            autosave: true,
            options: [
                ['', selectorModel ? 'Current selector: ' + selectorModel : 'Choose a Jev or decision model…'],
                ...JEV_DECISION_PRESETS.map(item => [item.id, item.label]),
                ['custom', 'Custom Jev / System One model…'],
            ],
            hint: matchedDecision
                ? matchedDecision.family + ' · ' + matchedDecision.model + ' (threshold ' + (selectorRole?.decisionThreshold ?? matchedDecision.threshold) + ').'
                : 'Pick Jev, another System One model, or a custom decision endpoint to score recalled memories in one pass.',
        }),
    );
    if (selectorRole && (selectorRole.enabled || selectorDecision)) {
        const usesShared = selectorRole.useShared === true;
        const ownProfile = allProfiles.find(profile => profile.id === selectorRole.profileId);
        const selectedProfile = usesShared ? sharedProfile : ownProfile;
        fields.append(
            field('Selector connection', usesShared ? SHARED_PROFILE : selectorRole.profileId || '', value => {
                selectorRole.useShared = value === SHARED_PROFILE;
                if (!selectorRole.useShared) {
                    selectorRole.profileId = value;
                    if (value && selectorModel && !selectorRole.modelOverride) {
                        selectorRole.modelOverride = selectorModel;
                    }
                }
                render();
            }, {
                key: 'now-selector-profile',
                autosave: true,
                options: [
                    ...(draft.sharedProfileId ? [[SHARED_PROFILE, 'Use the profile for all roles (' + (sharedProfile?.name || 'Saved profile') + ')']] : []),
                    ['', 'Manual endpoint & API key'],
                    ...allProfiles.map(profile => [profile.id, profile.name]),
                ],
                hint: usesShared || selectorRole.profileId
                    ? 'Uses the saved Connection Manager profile’s server-side API key and endpoint.'
                    : 'Enter a decision or OpenAI-compatible endpoint URL, model ID and API key below.',
            }),
        );
        if (!usesShared && selectorRole.profileId) {
            fields.append(
                field(selectedProfile?.model ? 'Selector model override' : 'Selector model', selectorRole.modelOverride || '', value => {
                    selectorRole.modelOverride = value;
                    if (String(value || '').trim()) selectorRole.enabled = true;
                }, {
                    key: 'now-selector-model-override',
                    autosave: true,
                    hint: selectedProfile?.model
                        ? 'Overrides the profile’s model (' + selectedProfile.model + ') for Recall selector.'
                        : 'Enter the Jev or decision model ID supported by this connection profile.',
                }),
            );
        } else if (!usesShared && !selectorRole.profileId) {
            fields.append(
                field('Selector endpoint', selectorRole.endpoint || '', value => {
                    selectorRole.endpoint = value;
                    if (String(value || '').trim() && String(selectorRole.model || '').trim()) selectorRole.enabled = true;
                }, {
                    key: 'now-selector-endpoint',
                    autosave: true,
                    hint: 'For example: https://openrouter.ai/api/alpha/decisions, https://api.typesafe.ai/v1/systemone, or http://127.0.0.1:8000/v1/systemone',
                }),
                field('Selector model', selectorRole.model || '', value => {
                    selectorRole.model = value;
                    if (String(value || '').trim() && String(selectorRole.endpoint || '').trim()) selectorRole.enabled = true;
                }, {
                    key: 'now-selector-model',
                    autosave: true,
                    hint: 'Model ID sent to the endpoint (for example typesafe/jev-1.14, ZefanCai/Open-Jev-9B, or your custom Jev-like model).',
                }),
                field('Selector API key', selectorRole.apiKey || '', value => {
                    selectorRole.apiKey = value;
                }, {
                    type: 'password',
                    key: 'now-selector-api-key',
                    autosave: true,
                    hint: selectorRole.hasKey ? 'A key is saved. Leave blank to keep it.' : 'Stored in the server’s protected credentials (leave blank for local endpoints that need no key).',
                }),
            );
        }
    }
    fields.append(
        field('Memory window preset', windowPresetId, value => {
            if (value === 'custom') return;
            applyWindowPresetToDraft(draft, value);
            render();
        }, {
            key: 'now-window-preset',
            autosave: true,
            options: [
                ...MESSAGE_WINDOW_PRESETS.map(item => [item.id, item.label]),
                ...(windowPresetId === 'custom' ? [['custom', 'Custom window (' + (draft.historyMode === 'messages'
                    ? 'keep ' + draft.recentMessages + ', group by ' + draft.historyBatchMessages
                    : draft.historyWindow + ' tokens') + ')']] : []),
            ],
            hint: draft.historyMode === 'messages'
                ? 'Keep ' + draft.recentMessages + ' recent messages in full and leave out older chat in groups of ' + draft.historyBatchMessages + ' once remembered.'
                : 'Keep roughly ' + draft.historyWindow + ' tokens of recent chat in replies.',
        }),
        field('Memory detail focus', draft.extractionFocus || 'balanced', value => {
            draft.extractionFocus = value;
            render();
        }, {
            key: 'now-extraction-focus',
            autosave: true,
            options: EXTRACTION_FOCUS_OPTIONS.map(item => [item.value, item.label]),
            hint: focusOption.description,
        }),
    );
    quick.append(fields);
    root.append(quick);
}

function renderNow(root) {
    const view = mewmory.view;
    if (!view?.enabled) {
        empty(root, 'Keep the story, and how it felt.',
            'Mewmory remembers events, your character and NPC details. Pawspective tracks how AI-controlled characters’ views change, linked back to the messages behind them. Switch on Use Mewmory in this chat above, then pick the models it uses.',
            'Set up model roles', () => switchTab('settings'));
        renderQuickSetup(root);
        return;
    }
    const actions = node('div', 'mewmory-actions');
    actions.append(button('Preview next memory', () => act(() => requestMewmory('recall', { tokenizer: getFriendlyTokenizerName() })), { primary: true }),
        button(mewmory.busy ? 'Updating…' : 'Update now', () => processMewmory({ all: true }), { disabled: mewmory.busy }));
    renderPreview(root, { actions });
    renderQuickSetup(root);
    renderStorySnippet(root);
    const player = section('Your character');
    player.append(node('p', 'mewmory-caption', 'Your character’s established details and current state stay in memory. You keep control of their next words, actions and thoughts unless you ask the AI to write them. Pawspective only interviews AI-controlled characters.'));
    const playerRecords = view.playerReferences?.records || [];
    if (!playerRecords.length) player.append(node('p', 'mewmory-caption', 'Your character’s details appear after Mewmory reads your persona or chat messages.'));
    else for (const record of playerRecords) renderRecord(record, player);
    root.append(player);
    const cast = section('Active NPCs', button('Add NPC reference', () => openEditor(null, 'entity')));
    cast.append(node('p', 'mewmory-caption', 'Character references and current states sent with replies.'));
    cast.append(check('Choose active characters automatically', view.activeNpcIds === null,
        automatic => act(() => changeMewmory('scene', { activeNpcIds: automatic ? null : view.activeReferences.ids }))));
    if (view.activeNpcIds !== null) {
        const ids = view.activeNpcIds;
        for (const entity of view.entities.filter(item => item.isCharacter)) {
            cast.append(check(entity.name, ids.includes(entity.entityId), checked => act(() => changeMewmory('scene', {
                activeNpcIds: checked ? [...ids, entity.entityId] : ids.filter(id => id !== entity.entityId),
            }))));
        }
    }
    if (!view.activeReferences.records.length) cast.append(node('p', 'mewmory-caption', 'NPC details appear after the first update. You can also add one yourself.'));
    else for (const record of view.activeReferences.records) renderRecord(record, cast);
    root.append(cast);
    const overview = section('How characters see things now');
    const activeViews = view.overviews.filter(record => view.activeReferences.ids.includes(record.ownerId));
    if (!activeViews.length) overview.append(node('p', 'mewmory-caption', 'These appear once a Pawspective interview finds a real change in how a character sees something.'));
    for (const record of activeViews) renderRecord(record, overview);
    root.append(overview);
}

function renderPreview(root, { actions = null } = {}) {
    const preview = mewmory.view?.preview;
    if (!preview && !actions) return;
    const current = Boolean(preview && mewmory.view.previewCurrent);
    const block = section('Memories and passages selected for this reply', ...(preview ? [badge(current ? 'Up to date' : 'Out of date', current ? 'success' : 'warning')] : []));
    block.classList.add('mewmory-preview');
    if (actions) block.append(actions);
    if (!preview) {
        block.append(node('p', 'mewmory-caption', 'Press Preview next memory to see what Mewmory would add to your next reply. Update now reads any new messages first.'));
        root.append(block);
        return;
    }
    block.append(node('p', 'mewmory-caption', current
        ? 'This is the latest prepared snapshot. A later reply may use different memories. Why each memory was picked is shown in Recall.'
        : 'This preview is out of date. Preview again to refresh it.'));
    const counts = node('dl', 'mewmory-tokens');
    for (const [label, value] of [['Character details, tokens', preview.tokens?.npc], ['Picked memories, tokens', preview.tokens?.memory],
        ['Recent chat kept, tokens', preview.history?.retainedTokens], ['Recent chat in this prepared reply, messages', preview.history?.retainedMessages]]) {
        if (value === undefined) continue;
        const item = node('div', 'mewmory-token');
        item.append(node('dt', '', label), node('dd', '', Number(value).toLocaleString()));
        counts.append(item);
    }
    block.append(counts, node('pre', 'mewmory-prompt', [preview.npcText, preview.memoryText].filter(Boolean).join('\n\n') || 'No older memories were picked.'));
    if (preview.history?.waitingForPreservation) block.append(node('p', 'mewmory-caption', 'Waiting for an older group to finish recording; keeping its original messages for now.'));
    root.append(block);
}

function pagination(root) {
    const view = mewmory.view;
    if (!view || view.total <= 80) return;
    const actions = node('div', 'mewmory-actions');
    const move = delta => act(async () => { ui.offset += delta; await refreshMewmory(filters()); }, { refresh: false });
    actions.append(button('Previous', () => move(-80), { disabled: ui.offset === 0 }),
        node('span', 'mewmory-caption', (ui.offset + 1) + '–' + Math.min(ui.offset + 80, view.total) + ' of ' + view.total),
        button('Next', () => move(80), { disabled: ui.offset + 80 >= view.total }));
    root.append(actions);
}

function renderPawspective(root) {
    const view = mewmory.view;
    const controls = node('div', 'mewmory-fields');
    const change = () => { ui.offset = 0; void act(() => refreshMewmory(filters()), { refresh: false }); };
    const owners = [...new Map(view.entities.filter(record => record.isCharacter).map(record => [record.entityId, record.name])).entries()];
    const subjects = [...new Set([...view.overviews, ...view.records].filter(record => !ui.owner || record.ownerId === ui.owner).flatMap(record => record.subjectIds))];
    controls.append(
        field('Character', ui.owner, value => { ui.owner = value; ui.subject = ''; change(); }, { options: [['', 'All characters'], ...owners] }),
        field('Subject', ui.subject, value => { ui.subject = value; change(); }, { options: [['', 'All subjects'], ...subjects.map(id => [id, nameOf(id)])] }),
    );
    root.append(controls);
    if (ui.owner) {
        const everything = node('div', 'mewmory-actions');
        everything.append(button('Everything about ' + nameOf(ui.owner), () => { ui.person = ui.owner; void switchTab('story'); }));
        root.append(everything);
    }
    const extraFilters = node('details');
    extraFilters.append(node('summary', '', 'Filter interview history'));
    extraFilters.append(
        field('Importance', ui.significance, value => { ui.significance = value; change(); }, { options: [['', 'Any importance'], 'low', 'medium', 'high'] }),
        field('Status', ui.status, value => { ui.status = value; change(); }, { options: [['', 'Any status'], 'active', 'background', 'resolved', 'uncertain'] }),
    );
    extraFilters.open = Boolean(ui.significance || ui.status);
    root.append(extraFilters);
    const overviews = view.overviews.filter(record => (!ui.owner || record.ownerId === ui.owner) && (!ui.subject || record.subjectIds.includes(ui.subject)));
    const current = section('How they see it now');
    for (const record of overviews) renderRecord(record, current);
    if (!overviews.length) current.append(node('p', 'mewmory-caption', 'Nothing recorded yet for this character and subject.'));
    root.append(current);
    const timeline = section('Interview history');
    const records = view.records.filter(record => record.kind === 'interview' && (!ui.owner || record.ownerId === ui.owner)
        && (!ui.subject || record.subjectIds.includes(ui.subject)) && (!ui.significance || record.significance === ui.significance)
        && (!ui.status || record.status === ui.status))
        .sort((a, b) => a.asOf - b.asOf || a.createdAt - b.createdAt);
    for (const record of records) renderRecord(record, timeline);
    if (!records.length) empty(timeline, 'No interviews yet', 'Interviews only happen when something changes how a character sees things. A quiet scene may add none.');
    root.append(timeline);
    pagination(root);
}

const loads = {};

/** Read-only views that are not part of the inspection, cached until the archive changes. */
function loadView(key, route, body = {}) {
    const signature = JSON.stringify([getMewmoryScope(), mewmory.view?.revision, route, body]);
    const current = loads[key];
    if (current?.signature === signature) return current;
    const entry = { signature, data: null, error: '', loading: true };
    loads[key] = entry;
    requestMewmory(route, body).then(data => { entry.data = data; }, error => { entry.error = error.message; })
        .finally(() => {
            entry.loading = false;
            if (loads[key] === entry) queueRender();
        });
    return entry;
}

function messageCaption(item) {
    const parts = [item.message > 0 ? 'Message ' + item.message : 'From the character card'];
    if (item.owner) parts.push(item.owner + '’s view');
    if (item.subjects?.length) parts.push('About ' + item.subjects.join(', '));
    if (item.triggerTerms?.length) parts.push('Comes back when: ' + item.triggerTerms.join('; '));
    return parts.join(' · ');
}

function renderBrief(item, root, extra = []) {
    const article = node('article', 'mewmory-record mewmory-brief');
    const heading = node('div', 'mewmory-record-heading');
    heading.append(node('h4', '', kindBadges[item.kind] || item.kind));
    const badges = node('div', 'mewmory-badges');
    if (item.significance === 'high') badges.append(badge('Important', 'accent'));
    if (item.status === 'uncertain') badges.append(badge('Uncertain', 'muted'));
    if (item.pinned) badges.append(badge('Pinned', 'accent'));
    heading.append(badges);
    article.append(heading, node('p', 'mewmory-prose', item.text), node('p', 'mewmory-caption', messageCaption(item)));
    const actions = node('div', 'mewmory-actions');
    const at = chatIndex(item.asOf);
    if (item.message > 0 && at >= 0) actions.append(button('Go to message', () => void jumpToChatMessage(at)));
    actions.append(...extra);
    if (actions.childElementCount) article.append(actions);
    root.append(article);
}

function loading(root, entry, what) {
    if (entry.error) root.append(node('p', 'mewmory-error', entry.error));
    else if (entry.loading && !entry.data) root.append(node('p', 'mewmory-caption', 'Loading ' + what + '…'));
}

function renderStorySnippet(root) {
    const entry = loadView('story', 'story');
    const data = entry.data;
    if (!data || (!data.recap.events.length && !data.promises.total)) return;
    const block = section('Previously on', button('Open Story', () => void switchTab('story')));
    for (const item of data.recap.events.slice(-3)) renderBrief(item, block);
    if (data.promises.total) block.append(node('p', 'mewmory-caption', data.promises.total === 1
        ? '1 promise is still open.' : data.promises.total + ' promises are still open.'));
    root.append(block);
}

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag, attributes = {}) {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
}

function renderMap(root, map) {
    const block = section('Who is connected');
    block.id = 'mewmory-story-map';
    if (!map.nodes.length) {
        block.append(node('p', 'mewmory-caption', 'Connections appear once Mewmory records a relationship, or a character forms a view of someone.'));
        root.append(block);
        return;
    }
    block.append(node('p', 'mewmory-caption', 'Lines join people named together in a relationship memory or a character’s view. Choose a character to see everything about them.'));
    const size = 320;
    const centre = size / 2;
    const radius = map.nodes.length === 1 ? 0 : size / 2 - 48;
    const places = new Map(map.nodes.map((item, index) => {
        const angle = (index / map.nodes.length) * Math.PI * 2 - Math.PI / 2;
        return [item.id, { x: centre + Math.cos(angle) * radius, y: centre + Math.sin(angle) * radius }];
    }));
    const picture = svg('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'mewmory-map', role: 'img',
        'aria-label': 'Map of ' + map.nodes.length + ' characters and things, joined by ' + map.links.length + ' connections' });
    for (const link of map.links) {
        const a = places.get(link.a);
        const b = places.get(link.b);
        if (!a || !b) continue;
        picture.append(svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'mewmory-map-link', 'stroke-width': Math.min(1 + link.records.length, 5) }));
    }
    for (const item of map.nodes) {
        const place = places.get(item.id);
        const group = svg('g', { class: 'mewmory-map-node' + (item.isCharacter ? ' is-character' : '') });
        group.append(svg('circle', { cx: place.x, cy: place.y, r: 22, class: 'mewmory-map-dot' }));
        const label = svg('text', { x: place.x, y: place.y + 38, 'text-anchor': 'middle', class: 'mewmory-map-label' });
        label.textContent = item.name.length > 18 ? item.name.slice(0, 17) + '…' : item.name;
        group.append(label);
        if (item.isCharacter) {
            group.setAttribute('role', 'button');
            group.setAttribute('tabindex', '0');
            group.setAttribute('aria-label', 'Everything about ' + item.name);
            const open = () => { ui.person = item.id; render(); document.getElementById('mewmory-person')?.scrollIntoView({ block: 'nearest' }); };
            group.addEventListener('click', open);
            group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
        }
        picture.append(group);
    }
    block.append(picture);
    const names = new Map(map.nodes.map(item => [item.id, item.name]));
    const list = node('ul', 'mewmory-map-list');
    for (const link of map.links) {
        const row = node('li');
        row.append(node('strong', '', names.get(link.a) + ' and ' + names.get(link.b)));
        for (const record of link.records.slice(0, 3)) row.append(node('p', 'mewmory-caption', record.text));
        if (link.records.length > 3) row.append(node('p', 'mewmory-caption', 'And ' + (link.records.length - 3) + ' more.'));
        list.append(row);
    }
    const details = node('details', 'mewmory-more-filters');
    details.append(node('summary', '', 'List every connection'), list);
    block.append(details);
    if (map.hidden) block.append(node('p', 'mewmory-caption', map.hidden + ' more not shown, to keep the map readable.'));
    root.append(block);
}

const PERSON_GROUPS = [['now', 'How they are now'], ['knows', 'What they know'], ['views', 'How they see others'],
    ['seenBy', 'How others see them'], ['relationships', 'Relationships'], ['promises', 'Promises'], ['events', 'What happened to them']];

function renderPerson(root) {
    if (!ui.person) return;
    const entry = loadView('person', 'character', { entityId: ui.person });
    const page = entry.data;
    const block = section('Everything about ' + (page?.name || nameOf(ui.person)), button('Close', () => { ui.person = ''; render(); }));
    block.id = 'mewmory-person';
    block.classList.add('mewmory-person');
    loading(block, entry, 'this character');
    if (page) {
        if (page.sheet) {
            block.append(node('p', 'mewmory-prose', page.sheet.text));
            if (page.sheet.aliases?.length) block.append(node('p', 'mewmory-caption', 'Also called ' + page.sheet.aliases.join(', ')));
            if (page.sheet.appearance) block.append(node('p', 'mewmory-caption', 'Appearance: ' + page.sheet.appearance));
            if (page.sheet.speech) block.append(node('p', 'mewmory-caption', 'Speech: ' + page.sheet.speech));
        }
        for (const [key, title] of PERSON_GROUPS) {
            if (!page[key]?.length) continue;
            block.append(node('h5', 'mewmory-subheading', title));
            for (const item of page[key]) renderBrief(item, block);
        }
        if (!page.total && !page.sheet) block.append(node('p', 'mewmory-caption', 'Nothing remembered about them yet.'));
    }
    root.append(block);
}

function inlineError(root, message) {
    const note = node('p', 'mewmory-error', message);
    note.setAttribute('role', 'alert');
    root.append(note);
}

function renderAsk(root) {
    const block = section('Ask Mewmory');
    block.id = 'mewmory-ask';
    block.append(node('p', 'mewmory-caption', 'Ask about this story, such as who promised what or who knows a secret. The answer comes only from saved memories and uses one request to the Facts and events model.'));
    const form = node('form', 'mewmory-ask-form');
    const question = field('Your question', ui.question, value => { ui.question = value; }, { key: 'ask-question', placeholder: 'What happened with…' });
    const ask = button('Ask', null, { primary: true, disabled: mewmory.busy });
    ask.type = 'submit';
    form.append(question, ask);
    form.addEventListener('submit', event => {
        event.preventDefault();
        ui.question = form.querySelector('input')?.value ?? ui.question;
        if (!ui.question.trim()) return;
        void act(async () => {
            ui.askError = '';
            try {
                ui.answer = await requestMewmory('ask', { question: ui.question });
            } catch (error) {
                ui.answer = null;
                ui.askError = error.message;
            }
        }, { refresh: false });
    });
    block.append(form);
    if (ui.askError) inlineError(block, ui.askError);
    const answer = ui.answer;
    if (answer) {
        const result = node('div', 'mewmory-answer');
        result.setAttribute('role', 'status');
        result.append(node('p', 'mewmory-caption', 'You asked: ' + answer.question));
        result.append(node('p', 'mewmory-prose', answer.answer));
        if (answer.unsure) result.append(node('p', 'mewmory-caption', 'Mewmory is not sure: the saved memories do not settle this.'));
        if (answer.citations.length) {
            result.append(node('h5', 'mewmory-subheading', answer.citations.length === 1 ? 'Based on 1 memory' : 'Based on ' + answer.citations.length + ' memories'));
            for (const item of answer.citations) renderBrief(item, result);
        }
        const actions = node('div', 'mewmory-actions');
        actions.append(button('Clear answer', () => { ui.answer = null; render(); }));
        result.append(actions);
        block.append(result);
    }
    root.append(block);
}

function renderConflicts(root) {
    const block = section('Check for contradictions', button('Check now', () => act(async () => {
        ui.conflictError = '';
        try {
            ui.conflicts = await requestMewmory('conflicts');
        } catch (error) {
            ui.conflicts = null;
            ui.conflictError = error.message;
        }
    }, { refresh: false }), { disabled: mewmory.busy }));
    block.id = 'mewmory-conflicts';
    block.append(node('p', 'mewmory-caption', 'Mewmory compares up to 60 recent memories and lists pairs that cannot both be true. It uses one request to the Facts and events model and changes nothing until you choose.'));
    if (ui.conflictError) inlineError(block, ui.conflictError);
    const result = ui.conflicts;
    if (result) {
        if (!result.conflicts.length) block.append(node('p', 'mewmory-caption', result.checked < 2 ? 'There are not enough memories to compare yet.' : 'No contradictions found in ' + result.checked + ' memories.'));
        const settle = (pair, id, action) => act(async () => {
            await changeMewmory('record/action', { id, action, filters: filters() });
            result.conflicts = result.conflicts.filter(item => item !== pair);
        });
        for (const pair of result.conflicts) {
            const item = node('div', 'mewmory-conflict');
            item.append(node('p', 'mewmory-prose', pair.explanation || 'These two memories disagree.'));
            for (const side of [pair.a, pair.b]) {
                renderBrief(side, item, [button('Only a suspicion', () => settle(pair, side.id, 'suspicion')),
                    button('Not supported by the story', () => settle(pair, side.id, 'unsupported'))]);
            }
            const keep = node('div', 'mewmory-actions');
            keep.append(button('Both are fine', () => { result.conflicts = result.conflicts.filter(entry => entry !== pair); render(); }));
            item.append(keep);
            block.append(item);
        }
    }
    root.append(block);
}

function renderShared(root) {
    const entry = loadView('shared', 'shared');
    const block = section('From other chats');
    block.id = 'mewmory-shared';
    block.append(node('p', 'mewmory-caption', 'Memories you shared from other chats with the same character. Nothing comes across on its own: bring one in and it becomes your own note in this chat. Share memories from the Archive by ticking them.'));
    if (ui.shareNote) block.append(node('p', 'mewmory-caption', ui.shareNote));
    loading(block, entry, 'shared memories');
    const data = entry.data;
    if (data) {
        const refresh = () => { delete loads.shared; render(); };
        if (!data.characters) block.append(node('p', 'mewmory-caption', 'This chat has no character card, so there is nothing to share with.'));
        else if (!data.available.length) block.append(node('p', 'mewmory-caption', 'Nothing shared from other chats yet.'));
        for (const item of data.available) {
            const article = node('article', 'mewmory-record mewmory-brief');
            article.append(node('p', 'mewmory-prose', item.text),
                node('p', 'mewmory-caption', 'Shared from ' + (item.chat || 'another chat') + ' · ' + (item.characterNames || []).join(', ')));
            const actions = node('div', 'mewmory-actions');
            actions.append(button(item.brought ? 'Already in this chat' : 'Bring into this chat', () => act(async () => {
                await changeMewmory('shared/bring', { ids: [item.id], filters: filters() });
                delete loads.shared;
            }), { disabled: item.brought }));
            article.append(actions);
            block.append(article);
        }
        if (data.mine.length) {
            const mine = node('details', 'mewmory-more-filters');
            mine.append(node('summary', '', data.mine.length === 1 ? '1 memory shared from this chat' : data.mine.length + ' memories shared from this chat'));
            for (const item of data.mine) {
                const article = node('article', 'mewmory-record mewmory-brief');
                const actions = node('div', 'mewmory-actions');
                actions.append(button('Stop sharing', () => act(async () => {
                    await requestMewmory('shared/remove', { id: item.id });
                    refresh();
                }, { refresh: false })));
                article.append(node('p', 'mewmory-prose', item.text), actions);
                mine.append(article);
            }
            block.append(mine);
        }
    }
    root.append(block);
}

function renderStory(root) {
    const view = mewmory.view;
    if (!view?.enabled) {
        empty(root, 'No story yet', 'Switch on Use Mewmory in this chat above. The recap and promises fill in as Mewmory reads the chat.');
        return;
    }
    const entry = loadView('story', 'story');
    renderPerson(root);
    renderAsk(root);
    const recap = section('Previously on');
    recap.id = 'mewmory-story-recap';
    loading(recap, entry, 'the recap');
    const data = entry.data;
    if (data) {
        recap.append(node('p', 'mewmory-caption', 'The most important recent events, oldest first. Built from saved memories, so it needs no model call.'));
        for (const item of data.recap.events) renderBrief(item, recap);
        if (!data.recap.events.length) recap.append(node('p', 'mewmory-caption', 'No events remembered yet. They appear after the next update.'));
        if (data.recap.total > data.recap.events.length) {
            const more = node('div', 'mewmory-actions');
            more.append(button('See every event', () => { clearArchiveFilters(); ui.kind = 'event'; void switchTab('archive'); }));
            recap.append(more);
        }
    }
    root.append(recap);
    if (!data) return;
    const promises = section('Open promises');
    promises.id = 'mewmory-story-promises';
    promises.append(node('p', 'mewmory-caption', 'Promises and unfinished business. Mewmory reminds the AI of one whenever its cue words come up in the scene.'));
    const mark = (id, action) => act(() => changeMewmory('record/action', { id, action, filters: filters() }));
    for (const item of data.promises.promises) {
        renderBrief(item, promises, [button('Mark as kept', () => mark(item.id, 'resolved')), button('Set aside', () => mark(item.id, 'background'))]);
    }
    if (!data.promises.total) promises.append(node('p', 'mewmory-caption', 'No open promises.'));
    else if (data.promises.total > data.promises.promises.length) {
        promises.append(node('p', 'mewmory-caption', 'Showing ' + data.promises.promises.length + ' of ' + data.promises.total + '.'));
    }
    root.append(promises);
    renderMap(root, data.map);
    renderConflicts(root);
    renderShared(root);
}

function renderReview(root, reload) {
    const review = mewmory.view.review;
    if (!review || (!review.fresh && !review.uncertain)) return;
    const strip = node('div', 'mewmory-review');
    const parts = [review.fresh ? review.fresh + (review.fresh === 1 ? ' new memory' : ' new memories')
        + (review.reviewedAt ? ' since you last looked' : ' you have not looked at yet') : '',
    review.uncertain ? review.uncertain + ' marked uncertain' : ''].filter(Boolean);
    strip.append(node('p', '', parts.join(' · ')));
    const actions = node('div', 'mewmory-actions');
    const show = changes => { Object.assign(ui, { flag: '', state: '' }, changes); reload(); };
    if (review.fresh) actions.append(button('Show new', () => show({ flag: 'new' }), { disabled: ui.flag === 'new' }));
    if (review.uncertain) actions.append(button('Show uncertain', () => show({ state: 'uncertain' }), { disabled: ui.state === 'uncertain' }));
    if (review.fresh) actions.append(button('Mark all as looked at', () => act(async () => {
        if (ui.flag === 'new') ui.flag = '';
        await changeMewmory('review/seen', { filters: filters() });
    })));
    strip.append(actions);
    root.append(strip);
}

function renderDuplicates(root) {
    if (!ui.duplicates) return;
    const block = node('div', 'mewmory-duplicates');
    block.id = 'mewmory-duplicates';
    const heading = node('div', 'mewmory-actions');
    heading.append(node('strong', '', ui.duplicates.length ? ui.duplicates.length === 1 ? '1 set of near-duplicates' : ui.duplicates.length + ' sets of near-duplicates'
        : 'No near-duplicates found'), button('Close', () => { ui.duplicates = null; render(); }));
    block.append(heading, node('p', 'mewmory-caption', ui.duplicates.length
        ? 'These say almost the same thing about the same characters. Keeping one gives it the sources of the others and retires the rest; \'Undo last change\' on any of them reverses it.'
        : 'No two memories of the same type and about the same characters share most of their wording.'));
    for (const [index, group] of ui.duplicates.entries()) {
        const set = node('div', 'mewmory-duplicate-set');
        set.setAttribute('role', 'group');
        set.setAttribute('aria-label', 'Near-duplicate set ' + (index + 1));
        for (const record of group) {
            const row = node('div', 'mewmory-duplicate');
            const text = node('div', '');
            text.append(node('p', 'mewmory-prose', record.text), node('p', 'mewmory-caption mewmory-record-meta', [kindBadges[record.kind],
                record.asOf >= 0 ? 'From message ' + (record.asOf + 1) : '', record.pinned ? 'Pinned' : '', record.authorOverride ? 'Edited by you' : ''].filter(Boolean).join(' · ')));
            const keep = button('Keep this one', () => act(async () => {
                await changeMewmory('record/merge', { keep: record.id, ids: group.map(item => item.id), filters: filters() });
                ui.duplicates = (await requestMewmory('duplicates')).groups;
            }));
            keep.id = 'mewmory-keep-' + record.id;
            row.append(text, keep);
            set.append(row);
        }
        block.append(set);
    }
    root.append(block);
}

async function fetchMessage(target) {
    try {
        target.data = await requestMewmory('message', { messageId: target.messageId, index: target.index, used: target.used });
        target.error = '';
    } catch (error) {
        target.error = error.message;
    }
}

async function loadMessage({ scroll = false } = {}) {
    const target = ui.message;
    if (!target) return;
    await fetchMessage(target);
    if (ui.message !== target) return;
    render();
    if (scroll) document.getElementById('mewmory-message')?.scrollIntoView({ block: 'start' });
}

function excerpt(text, limit) {
    const plain = String(text || '').replace(/\s+/g, ' ').trim();
    return plain.length > limit ? plain.slice(0, limit - 1).trimEnd() + '…' : plain;
}

function renderMessage(root) {
    const target = ui.message;
    if (!target) return;
    const message = chat[target.index];
    const block = section('This message', button('Close', () => { ui.message = null; render(); }));
    block.id = 'mewmory-message';
    block.classList.add('mewmory-message');
    const speaker = target.data?.speaker || message?.name || '';
    block.append(node('p', 'mewmory-caption', 'Message ' + (target.index + 1) + (speaker ? ' · ' + speaker : '')));
    if (message?.mes) block.append(node('p', 'mewmory-prose mewmory-message-text', excerpt(message.mes, 280)));
    const actions = node('div', 'mewmory-actions');
    if (message) actions.append(button('Go to message', () => void jumpToChatMessage(target.index)));
    const offRecord = message?.extra?.mewmoryExclude === true;
    if (offRecord) {
        actions.append(button('Put back on the record', () => act(async () => {
            await putMessageBackOnRecord(target.index);
            await fetchMessage(target);
        })));
    } else if (target.data?.sourceId) {
        const forgotten = Boolean(target.data.excluded);
        actions.append(button(forgotten ? 'Remember this message again' : 'Forget this message', () => act(async () => {
            await changeMewmory('source/exclude', { id: target.data.sourceId, exclude: !forgotten, filters: filters() });
            await fetchMessage(target);
        })));
    }
    block.append(actions);
    if (offRecord) block.append(node('p', 'mewmory-caption', 'Off the record: Mewmory does not read this message or make memories from it.'));
    else if (target.data?.excluded) block.append(node('p', 'mewmory-caption', 'Forgotten: this message stays in the chat, but Mewmory no longer uses it or any memory based on it.'));
    if (target.error) block.append(node('p', 'mewmory-caption', target.error));
    else if (!target.data) block.append(node('p', 'mewmory-caption', 'Loading what Mewmory knows about this message…'));
    else {
        const recall = message?.extra?.mewmoryRecall;
        if (target.used.length || recall?.passages) {
            block.append(node('h5', 'mewmory-subheading', 'Memories given to this reply'));
            for (const record of target.data.used) renderRecord(record, block, { editable: false });
            const notes = [];
            if (target.data.missing) notes.push(target.data.missing === 1 ? '1 of them has since been removed.' : target.data.missing + ' of them have since been removed.');
            if (recall?.passages) notes.push(recall.passages === 1 ? 'Also 1 original passage from earlier messages.' : 'Also ' + recall.passages + ' original passages from earlier messages.');
            if (notes.length) block.append(node('p', 'mewmory-caption', notes.join(' ')));
        }
        block.append(node('h5', 'mewmory-subheading', 'Memories made from this message'));
        for (const record of target.data.made) renderRecord(record, block, { editable: false });
        if (!target.data.made.length) block.append(node('p', 'mewmory-caption', offRecord || target.data.enabled === false
            ? 'None: Mewmory does not read this message.' : 'None yet. New messages are remembered at the next update.'));
    }
    root.append(block);
}

function renderTimeline(records, visible, tick) {
    const timeline = node('ol', 'mewmory-timeline');
    let step = null;
    let current;
    for (const record of visible) {
        if (!step || record.asOf !== current) {
            current = record.asOf;
            step = node('li', 'mewmory-timeline-step');
            const heading = node('div', 'mewmory-timeline-heading');
            const at = chatIndex(record.asOf);
            const speaker = at >= 0 ? chat[at]?.name : '';
            heading.append(node('h5', '', record.asOf < 0 ? 'Before the story' : 'Message ' + (record.asOf + 1) + (speaker ? ' · ' + speaker : '')));
            if (at >= 0) heading.append(button('Go to message', () => void jumpToChatMessage(at)));
            step.append(heading);
            timeline.append(step);
        }
        renderRecord(record, step, { selectable: true, onTick: tick, jump: false });
    }
    records.append(timeline);
}

function renderArchive(root) {
    const view = mewmory.view;
    renderMessage(root);
    const search = async () => {
        ui.offset = 0;
        const result = ui.query.trim() ? await requestMewmory('search', { query: ui.query, mode: ui.searchMode, dataType: ui.searchType }) : null;
        ui.matches = result?.matches || null;
        ui.searchReport = result?.retrieval || null;
        await refreshMewmory(filters());
    };
    const form = node('form', 'mewmory-search');
    form.setAttribute('role', 'search');
    form.addEventListener('submit', event => { event.preventDefault(); void act(search, { refresh: false }); });
    const bar = node('div', 'mewmory-search-bar');
    bar.append(field('Search memories and original messages', ui.query, value => { ui.query = value; },
        { key: 'archive-search', type: 'search', placeholder: 'A name, place, promise or line of dialogue' }),
    button('Search archive', () => act(search, { refresh: false }), { primary: true }));
    const options = node('div', 'mewmory-fields mewmory-search-options');
    options.append(field('Search source', ui.searchType, value => { ui.searchType = value; }, { options: [['', 'All sources'], ['chat', 'Chat messages'],
        ['memory', 'Saved memories'], ['character', 'Character cards'], ['lore', 'Lorebooks'], ['file', 'Attached files and Data Bank']] }),
    field('Search method', ui.searchMode, value => { ui.searchMode = value; }, { options: [['hybrid', 'Keywords and meaning'], ['keyword', 'Keywords'], ['semantic', 'Meaning']] }));
    form.append(bar, options);
    root.append(form);
    if (ui.searchReport) root.append(node('p', 'mewmory-caption', 'Search used ' + ui.searchReport.usedMode + ' matching across '
        + ui.searchReport.documents + ' passages.' + (ui.searchReport.keywordFallback ? ' Meaning search is unavailable; keyword matches are shown.' : '')
        + (ui.searchReport.error ? ' ' + ui.searchReport.error : '')));
    const sources = ui.matches
        ? section('Ranked archive matches', button('Clear search', () => {
            ui.query = '';
            ui.matches = null;
            ui.searchReport = null;
            render();
            document.getElementById('mewmory-field-archive-search')?.focus({ preventScroll: true });
        }))
        : section('Recent messages, lore and files');
    if (ui.matches) {
        const passages = ui.matches;
        sources.append(node('p', 'mewmory-caption', passages.length === 1 ? '1 match, best first.' : passages.length + ' matches, best first.'));
        for (const passage of passages) {
            const row = node('article', 'mewmory-record mewmory-match');
            row.append(node('strong', '', passage.sourceName || kinds[passage.kind] || passage.dataType),
                node('p', 'mewmory-prose', passage.text), sourceButtons(passage.refs));
            if (passage.retrieval) row.append(node('p', 'mewmory-caption', 'Rank score: ' + passage.retrieval.score.toFixed(4)
                + (passage.retrieval.similarity === null ? '' : ' · Meaning similarity: ' + passage.retrieval.similarity.toFixed(3))));
            sources.append(row);
        }
        if (!passages.length) sources.append(node('p', 'mewmory-caption', 'No eligible memory or passage matches this search.'));
        root.append(sources);
    } else {
        for (const source of view.sources) {
            const row = node('article', 'mewmory-record mewmory-match');
            row.append(node('strong', '', source.speaker + (source.eligible ? '' : ' · not used')),
                node('p', 'mewmory-caption', source.text), sourceButtons([source]));
            sources.append(row);
        }
    }
    const reload = () => { ui.offset = 0; void act(() => refreshMewmory(filters()), { refresh: false }); };
    const findDuplicates = () => act(async () => { ui.duplicates = (await requestMewmory('duplicates')).groups; }, { refresh: false })
        .then(() => document.getElementById('mewmory-duplicates')?.scrollIntoView({ block: 'nearest' }));
    const records = section('Memories', button('Find near-duplicates', findDuplicates, { disabled: view.recordCount < 2 }),
        button('Add memory', () => openEditor()));
    renderReview(records, reload);
    renderDuplicates(records);
    const filter = node('div', 'mewmory-fields');
    filter.append(field('Memory type', ui.kind, value => { ui.kind = value; reload(); },
        { options: [['objective', 'All facts and events'], ...Object.entries(kinds).filter(([kind]) => !['interview', 'overview'].includes(kind))] }),
    field('Sort by', ui.sort, value => { ui.sort = value; reload(); }, { key: 'archive-sort', options: [['story', 'Newest in the story first'],
        ['oldest', 'Oldest in the story first'], ['changed', 'Most recently changed'], ['pinned', 'Pinned first']] }),
    field('Show as', ui.layout, value => { ui.layout = value; render(); }, { key: 'archive-layout',
        options: [['list', 'List'], ['timeline', 'Timeline by message']] }));
    records.append(filter);
    const more = node('details', 'mewmory-more-filters');
    more.id = 'mewmory-archive-filters';
    more.append(node('summary', '', 'More filters'));
    const moreFields = node('div', 'mewmory-fields');
    const range = (label, name, key) => field(label, ui[name], value => { ui[name] = value; }, { type: 'number', key, placeholder: 'Any' });
    moreFields.append(
        field('Show', ui.flag, value => { ui.flag = value; reload(); }, { key: 'archive-flag', options: [['', 'All memories'], ['new', 'New since you last looked'],
            ['pinned', 'Pinned'], ['edited', 'Edited by you'], ['excluded', 'Left out of replies by you'], ['unused', 'Not used in replies']] }),
        field('Importance', ui.importance, value => { ui.importance = value; reload(); }, { key: 'archive-importance',
            options: [['', 'Any importance'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']] }),
        field('Status', ui.state, value => { ui.state = value; reload(); }, { key: 'archive-status', options: [['', 'Any status'], ['active', 'Active'],
            ['background', 'Background'], ['resolved', 'Resolved'], ['uncertain', 'Uncertain'], ['invalidated', 'Retired']] }),
        range('From message', 'from', 'archive-from'), range('To message', 'to', 'archive-to'));
    for (const input of moreFields.querySelectorAll('input[type="number"]')) {
        input.min = '1';
        input.step = '1';
        input.inputMode = 'numeric';
        input.addEventListener('change', reload);
    }
    more.append(moreFields);
    const filtered = Object.keys(archiveFilters()).some(key => key !== 'sort') || ui.kind !== 'objective';
    more.open = Boolean(ui.moreFilters || ui.flag || ui.importance || ui.state || ui.from || ui.to);
    more.addEventListener('toggle', () => { if (more.isConnected) ui.moreFilters = more.open; });
    records.append(more);
    const visible = view.records.filter(record => !['interview', 'overview'].includes(record.kind));
    for (const id of [...ui.selected]) if (!visible.some(record => record.id === id)) ui.selected.delete(id);
    const bulk = node('div', 'mewmory-bulk');
    const count = node('span', 'mewmory-caption');
    count.setAttribute('role', 'status');
    const all = check('Tick all on this page', false, ticked => {
        ui.selected = new Set(ticked ? visible.map(record => record.id) : []);
        for (const record of visible) {
            const box = document.getElementById('mewmory-tick-' + record.id);
            if (box) box.checked = ticked;
        }
        syncBulk();
    });
    all.querySelector('input').id = 'mewmory-tick-all';
    const change = field('Change ticked memories', '', action => {
        if (action === 'share' && ui.selected.size) {
            void act(async () => {
                const result = await requestMewmory('share', { ids: [...ui.selected] });
                delete loads.shared;
                ui.shareNote = (result.shared === 1 ? 'Shared 1 memory' : 'Shared ' + result.shared + ' memories') + ' with this character’s other chats.'
                    + (result.skipped ? ' ' + result.skipped + ' could not be shared: only facts, events, relationships, knowledge and promises can.' : '');
            });
        } else if (action && ui.selected.size) void act(() => changeMewmory('record/action', { ids: [...ui.selected], action, filters: filters() }));
    }, { key: 'archive-bulk', hideLabel: true, options: [['', 'Change ticked memories…'], ['pin_on', 'Pin for this scene'], ['pin_off', 'Unpin'],
        ['exclude_on', 'Stop using in replies'], ['exclude_off', 'Use in replies again'], ['suspicion', 'Only a suspicion'],
        ['unsupported', 'Not supported by the story'], ['resolved', 'Resolved'], ['background', 'Keep in the background'], ['active', 'Active again'], ['share', 'Share with other chats']] });
    function syncBulk() {
        const ticked = ui.selected.size;
        count.textContent = ticked ? ticked + (ticked === 1 ? ' memory ticked' : ' memories ticked') : 'Tick memories to change several at once.';
        all.querySelector('input').checked = Boolean(visible.length) && ticked === visible.length;
        change.querySelector('select').disabled = !ticked || Boolean(ui.running);
    }
    bulk.append(all, count, change);
    if (visible.length) records.append(bulk);
    syncBulk();
    if (ui.layout === 'timeline' && visible.length) renderTimeline(records, visible, syncBulk);
    else for (const record of visible) renderRecord(record, records, { selectable: true, onTick: syncBulk });
    if (!view.records.length) {
        if (filtered) empty(records, 'No memories match these filters', 'Loosen a filter, or clear them all to see every memory in this chat.',
            'Clear filters', () => { clearArchiveFilters(); reload(); });
        else empty(records, 'No memories here yet', 'Run an update, or add a memory yourself.');
    }
    root.append(records);
    pagination(root);
    if (!ui.matches && view.sources.length) root.append(sources);
}

function recallPassage(candidate) {
    return node('p', typeof candidate?.text === 'string' ? 'mewmory-prose' : 'mewmory-caption',
        typeof candidate?.text === 'string' ? candidate.text
            : 'This older recall did not save the passage text. Preview memories again to see the current selection.');
}

function renderRecall(root) {
    root.append(button('Preview which memories would be picked', () => act(() => requestMewmory('recall', { tokenizer: getFriendlyTokenizerName() })),
        { primary: true, disabled: !mewmory.view?.enabled }));
    const run = mewmory.view.recalls.at(-1);
    if (!run) {
        empty(root, 'Nothing to show yet', 'Preview memories or write the next reply to see what was picked and why.');
        return;
    }
    root.append(node('p', 'mewmory-caption', [{ complete: 'Done', needs_evidence: 'Needed more detail', uncertain: 'Unsure' }[run.status] || run.status,
        run.retrieval && !run.retrieval.aiSelection ? 'Ranked retrieval' : run.fallbackUsed ? 'Picked by Recall fallback' : 'Picked by Recall selector',
        new Date(run.at).toLocaleString()].join(' · ')));
    root.append(stats([
        { name: 'Picked', value: String(run.selections?.length ?? 0) },
        { name: 'Left out', value: String(run.rejections?.length ?? 0) },
        ...(run.retrieval ? [{ name: 'Sent with the reply', value: String(run.retrieval.selected?.length ?? 0) },
            { name: 'Passages searched', value: Number(run.retrieval.documents ?? 0).toLocaleString() }] : []),
    ], 'Latest recall in numbers'));
    if (run.error || run.indexError) root.append(node('p', 'mewmory-caption', run.error || run.indexError));
    if (run.retrieval) {
        const report = run.retrieval;
        root.append(node('p', 'mewmory-caption', 'Search: ' + report.usedMode + ' · ' + report.documents + ' searchable passages · '
            + report.indexed + ' saved embeddings · ' + report.selected.length + ' included.'
            + (report.keywordFallback ? ' Keyword recovery was used while meaning search was unavailable for this recall.' : '')
            + (report.limited.length ? ' ' + report.limited.length + ' candidates were outside the result limit.' : '')));
    }
    for (const [title, entries] of [['Picked', run.selections], ['Considered but left out', run.rejections]]) {
        const block = section(title);
        if (!entries.length) block.append(node('p', 'mewmory-caption', title === 'Picked'
            ? 'No older memories were picked. That is fine; not every reply needs one.' : 'None reported.'));
        for (const entry of entries) {
            const item = node('article', 'mewmory-record');
            const candidate = run.candidates.find(candidate => candidate.id === entry.recordId);
            item.append(node('strong', '', candidate?.sourceName || kinds[candidate?.kind] || 'Memory or passage'),
                recallPassage(candidate),
                node('p', 'mewmory-caption', [(entry.relevanceType || '').replaceAll('_', ' '), entry.justification].filter(Boolean).join(' · ')));
            if (title === 'Picked' && run.retrieval) item.append(node('p', 'mewmory-caption', run.retrieval.selected.includes(entry.recordId)
                ? 'Included in the prompt.' : run.retrieval.limited.includes(entry.recordId) ? 'Outside the result limit.'
                    : run.omitted.includes(entry.recordId) ? 'Did not fit the memory budget.' : 'Already covered or no longer eligible.'));
            if (candidate) item.append(sourceButtons(candidate.refs));
            block.append(item);
        }
        root.append(block);
    }
    if (run.forcedIds?.length) root.append(node('p', 'mewmory-caption', run.forcedIds.length + ' pinned memories or promises that this scene brings up were included automatically.'));
    if (run.omitted?.length) root.append(node('p', 'mewmory-caption', run.omitted.length + ' memories did not fit in Space for recalled memories, tokens.'));
    if (Number.isInteger(run.retrieval?.alreadyPresentSkipped)) root.append(node('p', 'mewmory-caption', 'Original chat passages already present in this reply: ' + run.retrieval.alreadyPresentSkipped + ' skipped.'));
    else if (Number.isInteger(run.retrieval?.proposedPassagesSkipped)) root.append(node('p', 'mewmory-caption', 'This prepared selection proposes skipping ' + run.retrieval.proposedPassagesSkipped + ' original chat passages already present. The final reply can use a fallback if the text changes.'));
    if (run.retrieval?.selected.length) {
        const included = section('Included passages and memories');
        for (const id of run.retrieval.selected) {
            const candidate = run.candidates.find(item => item.id === id);
            const row = node('article', 'mewmory-record');
            row.append(node('strong', '', candidate?.sourceName || kinds[candidate?.kind] || 'Neighbouring passage'),
                recallPassage(candidate), node('p', 'mewmory-caption', id));
            if (candidate?.score !== undefined) row.append(node('p', 'mewmory-caption', 'Rank score: ' + candidate.score.toFixed(4)
                + (candidate.similarity === null ? '' : ' · Meaning similarity: ' + candidate.similarity.toFixed(3))));
            if (candidate) row.append(sourceButtons(candidate.refs));
            included.append(row);
        }
        root.append(included);
    }
    root.append(node('p', 'mewmory-caption', 'Before the reply is written, Mewmory checks again that the messages behind these memories have not changed. These explanations are only shown here and are never sent to the writer.'));
    renderPreview(root);
}

function subjectIds(value) {
    return String(value).split(',').map(part => part.trim()).filter(Boolean).map(part => {
        const entity = mewmory.view.entities.find(entity => entity.entityId === part || entity.name.toLocaleLowerCase() === part.toLocaleLowerCase());
        if (entity) return entity.entityId;
        if (/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(part)) return part;
        const slug = part.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLocaleLowerCase();
        return 'subject:' + (slug || Array.from(part).map(character => character.codePointAt(0).toString(16)).join('-'));
    });
}

function renderEditor(root) {
    const record = ui.editor;
    if (!record) return;
    const editor = node('form', 'mewmory-editor');
    editor.id = 'mewmory-editor';
    editor.append(node('h4', '', mewmory.view.records.some(item => item.id === record.id) ? 'Edit memory' : 'Add a memory'));
    const known = mewmory.view.records.some(item => item.id === record.id) || mewmory.view.entities.some(item => item.id === record.id);
    editor.append(field('Type', record.kind, value => openEditor(null, value), { options: Object.entries(kinds), disabled: known, key: 'record-kind' }));
    if (record.kind === 'entity') {
        editor.append(field('Name', record.name, value => { record.name = value; }, { key: 'entity-name' }),
            field('Aliases, separated by commas', (record.aliases || []).join(', '), value => { record.aliases = value.split(',').map(item => item.trim()).filter(Boolean); }),
            record.entityId === 'player' ? node('p', 'mewmory-caption', 'Your character is user-controlled. Remembered details do not give the AI permission to write for you.')
                : check('AI-controlled character', record.isCharacter, value => { record.isCharacter = value; }),
            field('Stable appearance', record.appearance, value => { record.appearance = value; }, { multiline: true }),
            field('Speech notes', record.speech, value => { record.speech = value; }, { multiline: true, hint: 'Keep specific patterns and examples. Temporary clothing belongs in a Current state record.' }));
    }
    if (record.kind === 'state') {
        editor.append(field('Whose state', record.entityId, value => { record.entityId = value; }, {
            options: [['', 'Choose an entity'], ...mewmory.view.entities.map(item => [item.entityId, item.name])],
        }));
    }
    if (['interview', 'overview', 'knowledge'].includes(record.kind)) {
        editor.append(field('Character whose view or knowledge this is', record.ownerId, value => { record.ownerId = value; }, {
            options: [['', 'Choose an AI-controlled character'], ...mewmory.view.entities.filter(item => item.isCharacter).map(item => [item.entityId, item.name])],
        }));
    }
    editor.append(field('Subjects, separated by commas', record._subjectsText ?? record.subjectIds.map(nameOf).join(', '), value => {
        record._subjectsText = value;
        record.subjectIds = subjectIds(value);
        record.subjectNames = Object.fromEntries(record.subjectIds.map((id, index) => [id, value.split(',').map(value => value.trim()).filter(Boolean)[index]]));
    }, { hint: 'People, places, objects, promises or concepts.' }));
    if (record.kind !== 'interview') editor.append(field('Memory text', record.text, value => { record.text = value; }, { multiline: true, key: 'record-text' }));
    if (['event', 'relationship'].includes(record.kind)) {
        editor.append(field('How certain', record.evidenceStatus || 'uncertain', value => { record.evidenceStatus = value; },
            { options: ['established', 'reported', 'disputed', 'uncertain'] }));
    }
    if (record.kind === 'knowledge') {
        editor.append(field('How they learned it', record.method || '', value => { record.method = value; },
            { options: [['', 'Choose a method'], 'witnessed', 'told', 'read', 'inferred', 'author'] }),
        field('Exact quote from a message showing how they learned it', record.evidenceText || '', value => { record.evidenceText = value; }, { multiline: true }));
    }
    if (record.kind === 'commitment') editor.append(field('Situation cues, separated by commas', (record.triggerTerms || []).join(', '),
        value => { record.triggerTerms = value.split(',').map(item => item.trim()).filter(Boolean); }, { hint: 'For example: harbour, return the book.' }));
    if (record.kind === 'interview') {
        record.interview ??= [{ question: '', answer: '' }];
        record.interview.forEach((turn, index) => {
            editor.append(field('Question ' + (index + 1), turn.question, value => { turn.question = value; }, { multiline: true, key: 'question-' + index }),
                field('Answer ' + (index + 1), turn.answer, value => { turn.answer = value; }, { multiline: true, key: 'answer-' + index }));
        });
        editor.append(button('Add question', () => { record.interview.push({ question: '', answer: '' }); render(); }, { disabled: record.interview.length >= 8 }),
            field('Cautious search description', record.searchDescription || '', value => { record.searchDescription = value; }, { multiline: true }),
            field('Character’s explanation of the change', record.changeExplanation || '', value => { record.changeExplanation = value; }, { multiline: true }));
    }
    const stateFields = node('div', 'mewmory-fields');
    stateFields.append(field('Current status', record.status, value => { record.status = value; }, { options: ['active', 'background', 'resolved', 'uncertain', 'invalidated'] }),
        field('Importance', record.significance, value => { record.significance = value; }, { options: ['low', 'medium', 'high'],
            hint: 'Medium or high needs a ticked chat message below that shows why it matters.' }));
    editor.append(stateFields);
    const evidence = node('details');
    evidence.open = !known;
    evidence.append(node('summary', '', 'Based on these messages (' + record.refs.length + ' ticked)'));
    const choices = node('div', 'mewmory-evidence');
    const allSources = [...new Map([...mewmory.view.sources, ...record.refs].map(source => [source.id + '@' + source.revision, source])).values()];
    for (const source of allSources) {
        const selected = record.refs.some(ref => ref.id === source.id && ref.revision === source.revision);
        const sourceName = source.type === 'chat' ? 'Message ' + (source.sequence + 1) : source.speaker || 'Earlier source';
        choices.append(check(sourceName + ' · revision ' + source.revision + (source.text ? ': ' + source.text.slice(0, 90) : ''), selected, checked => {
            record.refs = record.refs.filter(ref => ref.id !== source.id || ref.revision !== source.revision);
            if (checked) record.refs.push({ id: source.id, revision: source.revision });
            evidence.querySelector('summary').textContent = 'Based on these messages (' + record.refs.length + ' ticked)';
        }, source.eligible === false && !selected));
    }
    evidence.append(choices);
    editor.append(evidence, node('p', 'mewmory-caption', 'Your edit is saved as your own correction. Undo last change brings back the earlier version.'));
    const save = () => act(async () => {
        if (record.kind === 'entity' && !record.text.trim()) record.text = record.name;
        if (record.significance !== 'low') record.evidenceRefs = record.refs.filter(ref => ref.id.startsWith('chat:'));
        if (!record.subjectIds.length && record.entityId) record.subjectIds = [record.entityId];
        await changeMewmory('record/save', { record });
        ui.editor = null;
    });
    editor.addEventListener('submit', event => { event.preventDefault(); void save(); });
    const actions = node('div', 'mewmory-actions');
    actions.append(button('Save memory', save, { primary: true }), button('Cancel edit', () => { ui.editor = null; render(); }));
    editor.append(actions);
    root.append(editor);
}

function configErrorMessage(message) {
    const text = typeof message === 'string' && message ? message : 'Mewmory settings could not be saved. Check your connection and try again.';
    // Older servers still name this field the old way; map it to the label the panel shows.
    return text.replaceAll('Hide messages beyond, tokens', 'Hide older messages at this chat size, tokens');
}

function accountMismatchError(message) {
    return Object.assign(new Error(message || 'The signed-in account changed. Reload the page before saving Mewmory settings.'), {
        status: 403, code: 'MEWMORY_ACCOUNT_CHANGED',
    });
}

function accountHeaders(account) {
    return { ...getRequestHeaders(), ...(account ? { 'X-Neconyan-Account': account } : {}) };
}

function saveMewmoryConfig(config, { account = currentUser?.handle || null, signal } = {}) {
    return fetch('/api/mewmory/config/save', {
        method: 'POST',
        headers: accountHeaders(account),
        signal,
        body: JSON.stringify({ config }),
    }).then(async response => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw Object.assign(new Error(configErrorMessage(result.error)), { status: response.status, code: result.code });
        }
        if (!result.config) throw new Error('Mewmory did not return the saved configuration. Try again.');
        if (account && result.config.account && result.config.account !== account) throw accountMismatchError();
        confirmSavedSwitches(result.config, config);
        return result.config;
    });
}

function loadMewmoryConfig({ account = currentUser?.handle || null, signal } = {}) {
    return fetch('/api/mewmory/config/get', {
        method: 'POST',
        headers: accountHeaders(account),
        signal,
        body: '{}',
    }).then(async response => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw Object.assign(new Error(configErrorMessage(result.error)), { status: response.status, code: result.code });
        }
        if (!result.config) throw new Error('Mewmory did not return its configuration. Try again.');
        if (account && result.config.account && result.config.account !== account) throw accountMismatchError();
        return result.config;
    });
}

function incompleteConfigDraft(draft) {
    const missing = [];
    const add = (label, value) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) missing.push(label);
    };
    add('Recent chat allowance, tokens', draft.historyWindow);
    add('Hide older messages at this chat size, tokens', draft.autoHideTokens);
    add('Daily token limit for automatic updates', draft.dailyTokenLimit);
    add('Keep at least this many recent messages', draft.recentMessages);
    add('Remove older chat in groups of', draft.historyBatchMessages);
    add('Space for recalled memories, tokens', draft.memoryTokens);
    add('Maximum messages per memory request', draft.batchMessages);
    add('Search matches considered for recall', draft.candidateLimit);
    for (const [label, key] of [['Maximum passage length, characters', 'chunkSize'], ['Text repeated between passages, characters', 'chunkOverlap'],
        ['Recent messages used to find matches', 'queryMessages'], ['Preference for meaning matches', 'semanticWeight'],
        ['Minimum meaning match score', 'minSimilarity'], ['Maximum recalled results', 'resultLimit'],
        ['Maximum passages from one source', 'maxPerSource'], ['Nearby passages to include on each side', 'neighbourChunks'],
        ['Passages per meaning-index request', 'batchSize']]) add(label, draft.retrieval?.[key]);
    for (const [name, role] of Object.entries(draft.roles || {})) {
        const label = roles[name] || name;
        add(label + ': Model context size, tokens', role.contextTokens);
        add(label + ': Maximum response length, tokens', role.maxOutputTokens);
        add(label + ': Request timeout, seconds', role.timeoutMs);
        if (DECISION_ROLES.includes(name) && role.decisionThreshold !== undefined) {
            add(label + ': Minimum decision score', role.decisionThreshold);
        }
    }
    if (!missing.length) {
        if (!Number.isSafeInteger(draft.recentMessages) || draft.recentMessages < 1 || draft.recentMessages > 100000) return 'Keep at least this many recent messages must be between 1 and 100000.';
        if (!Number.isSafeInteger(draft.historyBatchMessages) || draft.historyBatchMessages < 1 || draft.historyBatchMessages > 10000) return 'Remove older chat in groups of must be between 1 and 10000.';
        for (const name of DECISION_ROLES) {
            const role = draft.roles?.[name];
            if (role && typeof role.decisionThreshold === 'number' && (role.decisionThreshold < 0 || role.decisionThreshold > 1)) {
                return (roles[name] || name) + ': Minimum decision score must be between 0 and 1.';
            }
        }
        return '';
    }
    const shown = missing.slice(0, 3).join('; ');
    const rest = missing.length - 3;
    return 'finish ' + shown + (rest > 0 ? ' and ' + rest + ' more number field' + (rest === 1 ? '' : 's') : '') + ' before this can save.';
}

function replaceDraftContents(target, source) {
    for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
    for (const [key, value] of Object.entries(source)) {
        if (value && typeof value === 'object' && !Array.isArray(value)
            && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
            replaceDraftContents(target[key], value);
        } else {
            target[key] = value;
        }
    }
}

function syncSettingsDraft() {
    if (!mewmory.config) return;
    if (!ui.draft) {
        ui.draft = structuredClone(mewmory.config);
        ui.draft.historyMode ??= 'tokens';
        ui.draft.historyCatchUp ??= 'reply';
        ui.draft.recentMessages ??= 10;
        ui.draft.historyBatchMessages ??= 5;
        ui.draft.extractionFocus ??= 'balanced';
        ui.draft.extractionInstructions ??= '';
        for (const roleName of DECISION_ROLES) {
            const role = ui.draft.roles?.[roleName];
            if (role) {
                role.decisionMode ??= 'auto';
                role.decisionThreshold ??= defaultDecisionThreshold(role.modelOverride || role.model);
            }
        }
        ui.draft.retrieval = { ...RAG_DEFAULTS, ...ui.draft.retrieval };
    }
    mewmoryConfigAutosave.sync(mewmory.config, mewmory.config.account || currentUser?.handle || null);
}

function updateSettingsStatus() {
    const status = document.getElementById('mewmory-settings-status');
    if (!status || !ui.draft) return;
    const state = mewmoryConfigAutosave.state();
    const message = state.error ? 'Not saved: ' + state.error
        : state.invalid ? 'Not saved: ' + state.invalid
            : state.saving ? 'Saving…'
                : state.pending ? 'Unsaved changes. Saving automatically…'
                    : state.revision ? 'Configuration saved.' : 'No model configuration saved yet.';
    status.textContent = message + (state.remoteChange ? ' Settings were saved elsewhere; your edits were kept.' : '');
    status.dataset.error = String(Boolean(state.error || state.invalid));
    const retry = document.getElementById('mewmory-settings-retry');
    if (retry) {
        retry.hidden = !state.error || Boolean(state.invalid) || state.accountChanged;
        retry.disabled = state.saving;
    }
    const discard = document.getElementById('mewmory-settings-discard');
    if (discard) {
        discard.hidden = state.accountChanged || (!state.pending && !state.error && !state.invalid);
        discard.disabled = state.accountChanged || (!state.pending && !state.error && !state.invalid);
    }
}

function handleConfigState() {
    const state = mewmoryConfigAutosave.state();
    const error = state.error || state.invalid || '';
    const previous = ui.configError;
    const accountChanged = Boolean(state.accountChanged);
    const accountChangedBefore = ui.accountChanged;
    ui.configError = error;
    ui.accountChanged = accountChanged;
    if (error) mewmory.error = error;
    else if (previous && mewmory.error === previous) mewmory.error = '';
    updateSettingsStatus();
    if (Boolean(previous) !== Boolean(error) || accountChanged !== accountChangedBefore) queueMicrotask(notifyMewmory);
    else if (error && error !== previous && mewmory.error === error) {
        const heading = document.querySelector('#mewmory-workspace .mewmory-heading .mewmory-status');
        if (heading) {
            heading.textContent = error;
            heading.dataset.error = 'true';
        }
    }
}

function handleConfigSaved(saved) {
    if (!mewmory.config || saved.revision >= mewmory.config.revision) mewmory.config = saved;
    window.dispatchEvent(new Event('mewmory:configured'));
    try {
        window.localStorage?.setItem(MEWMORY_CONFIG_CHANGED_KEY, String(saved.revision ?? Date.now()));
    } catch {
        // Other tabs still pick the saved config up on their next ordinary Mewmory refresh.
    }
}

function scheduleConfigSave(options) {
    mewmoryConfigAutosave.schedule(options);
}

function discardSettingsDraft() {
    mewmoryConfigAutosave.discard();
    updateSettingsStatus();
    render();
}

mewmoryConfigAutosave.configure({
    readDraft: () => ui.draft,
    writeDraft: draft => {
        if (!draft) ui.draft = null;
        else if (!ui.draft) ui.draft = draft;
        else replaceDraftContents(ui.draft, draft);
    },
    getAccount: () => currentUser?.handle || null,
    save: saveMewmoryConfig,
    load: loadMewmoryConfig,
    validate: incompleteConfigDraft,
    onState: handleConfigState,
    onSaved: handleConfigSaved,
    onAccountChange: () => { mewmory.config = null; },
    onAccountMismatch: () => { mewmory.config = null; },
});

window.addEventListener('neconyan:account-changing', () => {
    mewmoryConfigAutosave.abandonAccount();
    if (ui.root) render();
});

// A server still running older code drops switches it does not know and saves the rest.
function confirmSavedSwitches(saved, expected) {
    if (SWITCHES.some(key => typeof expected[key] === 'boolean' && saved?.[key] !== expected[key])
        || ['historyMode', 'recentMessages', 'historyBatchMessages', 'historyCatchUp', 'extractionFocus', 'extractionInstructions'].some(key => expected[key] !== undefined && saved?.[key] !== expected[key])
        || (Array.isArray(expected.fallbackProfileIds) && !Array.isArray(saved?.fallbackProfileIds))
        || (expected.sharedProfileId && saved?.sharedProfileId !== expected.sharedProfileId)) {
        throw new Error('Neconyan was updated but is still running the old version. Restart Neconyan, then try again.');
    }
}

function renderFallbackConnections(draft) {
    const list = node('div', 'mewmory-fallbacks');
    list.id = 'mewmory-fallbacks';
    const fallbacks = draft.fallbackProfileIds ||= [];
    const profiles = new Map((mewmory.config.profiles || []).map(profile => [profile.id, profile.name]));
    const heading = node('div', 'mewmory-fallback-heading');
    heading.append(node('span', '', 'Backup connections'), node('small', 'mewmory-fallback-count', fallbacks.length + ' of ' + MAX_FALLBACK_PROFILES));
    list.append(heading, node('p', 'mewmory-caption', 'When a role’s own connection fails, times out or sends back something unusable, Mewmory tries these saved profiles in order, each with its own model. Embeddings never fall back, because a different model would not match the saved search index. Each role’s remote and reading permissions still apply.'));
    const update = (change, focus) => {
        change(fallbacks);
        scheduleConfigSave({ immediate: true });
        const replacement = renderFallbackConnections(draft);
        list.replaceWith(replacement);
        replacement.querySelector(focus(replacement))?.focus();
    };
    const rows = node('ol', 'mewmory-fallback-rows');
    fallbacks.forEach((profileId, index) => {
        const row = node('li', 'mewmory-fallback-row');
        row.dataset.profileId = profileId;
        const name = node('span', 'mewmory-fallback-name', profiles.get(profileId) || 'Missing profile (' + profileId + ')');
        if (!profiles.has(profileId)) row.classList.add('is-missing');
        const actions = node('span', 'mewmory-fallback-actions');
        const action = (icon, label, kind, disabled, change) => {
            const control = button('', () => update(change, replacement => {
                const sameRow = '.mewmory-fallback-row[data-profile-id="' + CSS.escape(profileId) + '"]';
                if (replacement.querySelector(sameRow + ' [title="' + label + '"]:not(:disabled)')) return sameRow + ' [title="' + label + '"]';
                if (replacement.querySelector(sameRow)) return sameRow + ' button:not(:disabled)';
                const remaining = replacement.querySelectorAll('.mewmory-fallback-row');
                return remaining.length
                    ? '.mewmory-fallback-row:nth-child(' + Math.min(index + 1, remaining.length) + ') [title="Remove"]'
                    : '.mewmory-fallback-add';
            }), { disabled });
            control.classList.add('menu_button_icon', 'mewmory-fallback-action');
            control.id = 'mewmory-fallback-' + kind + '-' + profileId;
            control.title = label;
            control.setAttribute('aria-label', label + ': ' + name.textContent);
            control.append(node('i', 'fa-solid ' + icon));
            control.firstChild.setAttribute('aria-hidden', 'true');
            return control;
        };
        const move = offset => next => next.splice(index + offset, 0, ...next.splice(index, 1));
        actions.append(
            action('fa-arrow-up', 'Try earlier', 'earlier', index === 0, move(-1)),
            action('fa-arrow-down', 'Try later', 'later', index === fallbacks.length - 1, move(1)),
            action('fa-xmark', 'Remove', 'remove', false, next => next.splice(index, 1)),
        );
        row.append(name, actions);
        rows.append(row);
    });
    if (fallbacks.length) list.append(rows);
    const available = [...profiles].filter(([id]) => !fallbacks.includes(id));
    const full = fallbacks.length >= MAX_FALLBACK_PROFILES;
    const add = node('select', 'text_pole mewmory-fallback-add');
    add.id = 'mewmory-field-fallback-add';
    add.setAttribute('aria-label', 'Add a fallback connection');
    add.disabled = ui.running || full || !available.length;
    const placeholder = node('option', '', full ? 'All ' + MAX_FALLBACK_PROFILES + ' fallbacks are in use'
        : !profiles.size ? 'Save a connection profile first'
            : !available.length ? 'Every saved connection is already listed'
                : 'Add a fallback connection…');
    placeholder.value = '';
    add.append(placeholder);
    if (!full) for (const [id, label] of available) {
        const option = node('option', '', label);
        option.value = id;
        add.append(option);
    }
    add.addEventListener('change', () => {
        const id = add.value;
        if (id) update(next => next.push(id), () => '.mewmory-fallback-add');
    });
    list.append(add);
    return list;
}

function renderSettings(root) {
    syncSettingsDraft();
    const draft = ui.draft;
    if (!draft || !mewmory.config) return;
    const configField = (label, value, onChange, options = {}) => field(label, value, onChange, { ...options, autosave: true });
    const configCheck = (label, checked, onChange, disabled = false) => check(label, checked, onChange, disabled, { autosave: true });
    const jump = node('nav', 'mewmory-jump');
    jump.setAttribute('aria-label', 'Settings sections');
    jump.append(node('span', 'mewmory-caption', 'Jump to'));
    for (const [id, label] of [['automatic', 'Memory updates'], ['models', 'Models used by Mewmory'], ['search', 'Finding relevant memories'],
        ...(mewmory.view ? [['upkeep', 'Upkeep'], ['transfers', 'Export and restore'], ['lorebook', 'Lorebook']] : [])]) {
        const link = node('button', 'mewmory-jump-link', label);
        link.type = 'button';
        link.addEventListener('click', () => {
            const target = document.getElementById('mewmory-settings-' + id);
            target?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
            const title = target?.querySelector('h4');
            if (title) {
                title.tabIndex = -1;
                title.focus({ preventScroll: true });
            }
        });
        jump.append(link);
    }
    root.append(jump);
    const settings = section('Memory updates');
    settings.id = 'mewmory-settings-automatic';
    settings.dataset.mewmoryTour = 'automatic';
    settings.append(node('p', 'mewmory-caption', 'Mewmory records facts and character perspectives as you chat. Keeping recent messages in replies is a separate setting.'),
        configCheck('Use Mewmory in new chats', draft.enableNewChats, value => { draft.enableNewChats = value; }),
        node('p', 'mewmory-caption', 'Existing chats keep their own on/off choice.'),
        configCheck('Update memories as I chat', draft.autoUpdate, value => { draft.autoUpdate = value; }),
        node('p', 'mewmory-caption', 'Process new and edited messages, including those still included in replies. Updates run on the server.'),
        configCheck('Use models running on this computer only', draft.localOnly, value => { draft.localOnly = value; }),
        node('p', 'mewmory-caption', 'Prevents Mewmory model roles from sending story data to another computer.'),
        configCheck('Replace older chat with Mewmory context', draft.excludeHistory, value => { draft.excludeHistory = value; render(); }),
        node('p', 'mewmory-caption', 'Leave older messages out of replies only after Mewmory has recorded them. The original messages stay saved.'));
    const budgets = node('div', 'mewmory-fields');
    const windowPresetId = detectMessageWindowPreset(draft);
    const updateWindowPresetSelect = () => {
        const select = document.getElementById('mewmory-field-window-preset');
        if (select) select.value = detectMessageWindowPreset(draft);
    };
    budgets.append(configField('Memory window preset', windowPresetId, value => {
        if (value === 'custom') return;
        applyWindowPresetToDraft(draft, value);
        render();
    }, {
        key: 'window-preset',
        options: [
            ...MESSAGE_WINDOW_PRESETS.map(item => [item.id, item.label]),
            ['custom', 'Custom window'],
        ],
        hint: 'Recommended window keeps 10 recent messages in full and removes older chat in groups of 5 once remembered.',
    }), configField('Choose recent chat by', draft.historyMode, value => { draft.historyMode = value; render(); }, {
        key: 'history-mode', options: [['tokens', 'Token allowance'], ['messages', 'Number of messages']],
        hint: 'Tokens measure text length. Message counts are easier to predict, but long messages still need enough model context.',
    }), configField('When memory is behind', draft.historyCatchUp, value => { draft.historyCatchUp = value; render(); }, {
        key: 'history-catch-up', options: [['reply', 'Reply immediately'], ['wait', 'Wait for memory']], disabled: !draft.excludeHistory,
        hint: draft.historyCatchUp === 'wait'
            ? 'Record the older messages before sending the reply. This can run memory updates even when automatic updates are off. Catch-up may continue after the reply starts. You can stop waiting.'
            : 'Keep any older messages Mewmory has not recorded yet, so the reply can start. They leave context after memory catches up.',
    }));
    if (draft.historyMode === 'messages') {
        const example = node('p', 'mewmory-caption');
        example.id = 'mewmory-history-example';
        const updateExample = () => {
            const x = draft.recentMessages;
            const y = draft.historyBatchMessages;
            example.textContent = Number.isSafeInteger(x) && x > 0 && Number.isSafeInteger(y) && y > 0
                ? 'Keep ' + x + '–' + (x + y - 1) + ' messages. At ' + (x + y) + ', leave out the oldest ' + y + ' once remembered, leaving ' + x + '. More may remain while memory updates catch up.' : '';
            updateWindowPresetSelect();
        };
        budgets.append(configField('Keep at least this many recent messages', draft.recentMessages, value => { draft.recentMessages = value; updateExample(); }, {
            type: 'number', key: 'recent-messages', hint: 'Include these messages in full with each reply. User messages and character replies count separately.',
        }), configField('Remove older chat in groups of', draft.historyBatchMessages, value => { draft.historyBatchMessages = value; updateExample(); }, {
            type: 'number', key: 'history-batch-messages', hint: 'Let extra messages accumulate, then leave out this many older messages together after they are remembered. This does not delay memory updates.',
        }));
        updateExample();
        budgets.append(example);
    } else {
        budgets.append(configField('Recent chat allowance, tokens', draft.historyWindow, value => { draft.historyWindow = value; updateWindowPresetSelect(); }, {
            type: 'number', key: 'history-window', hint: 'Keep roughly this much original chat text. Character references, recalled memories and the rest of your prompt need additional room. Older chat stays until remembered.',
        }));
    }
    const focusOption = EXTRACTION_FOCUS_OPTIONS.find(item => item.value === (draft.extractionFocus || 'balanced')) || EXTRACTION_FOCUS_OPTIONS[1];
    budgets.append(configField('Memory detail focus', draft.extractionFocus || 'balanced', value => { draft.extractionFocus = value; render(); }, {
        key: 'extraction-focus',
        options: EXTRACTION_FOCUS_OPTIONS.map(item => [item.value, item.label]),
        hint: focusOption.description,
    }), configField('Extra memory instructions (optional)', draft.extractionInstructions || '', value => { draft.extractionInstructions = value; }, {
        key: 'extraction-instructions',
        multiline: true,
        placeholder: 'For example: Record every promised favour, inventory item, exact time reference and small emotional shift.',
        hint: 'Extra instructions for Facts and events when deciding what to record from each batch of messages.',
    }), configField('Space for recalled memories, tokens', draft.memoryTokens, value => { draft.memoryTokens = value; }, {
        type: 'number', key: 'memory-tokens', hint: 'Maximum space for selected memories and original passages. Active character references need additional room.',
    }), configField('Maximum messages per memory request', draft.batchMessages, value => { draft.batchMessages = value; updateWindowPresetSelect(); }, {
        type: 'number', key: 'batch-messages', hint: 'Read up to this many messages together when updating facts and character perspectives. A request can contain fewer. This does not set the recent-message window.',
    }), configField('Search matches considered for recall', draft.candidateLimit, value => { draft.candidateLimit = value; }, {
        type: 'number', key: 'candidate-limit', hint: 'How many possible matches to consider before choosing what helps the next reply.',
    }), configField('Token counter for replies', draft.writerTokenizer, value => { draft.writerTokenizer = value; }, {
        options: tokenizers, key: 'writer-tokenizer', hint: 'Match the model that writes replies. Auto follows the app setting. Counts can differ from your provider.',
    }), configField('Daily token limit for automatic updates', draft.dailyTokenLimit ?? 0, value => { draft.dailyTokenLimit = value; }, {
        type: 'number', key: 'daily-token-limit', hint: '0 means no limit. Counts every Mewmory model call today across all chats. When it is reached, automatic updates wait until tomorrow; buttons you press still work.',
    }));
    settings.append(budgets);
    if (draft.historyMode === 'messages') {
        settings.append(configCheck('Also hide omitted messages in the saved chat', draft.autoHide, value => { draft.autoHide = value; }, !draft.excludeHistory),
            node('p', 'mewmory-caption', draft.excludeHistory ? 'Use the same recent-message window. Hidden messages remain saved and searchable; you can show them again.'
                : 'Turn on replacing older chat above to hide omitted messages automatically.'));
    } else {
        settings.append(configCheck('Hide old messages automatically at a token threshold', draft.autoHide, value => { draft.autoHide = value; }),
            node('p', 'mewmory-caption', 'This is separate from the recent chat allowance. Hidden messages remain saved and searchable.'),
            configField('Hide older messages at this chat size, tokens', draft.autoHideTokens, value => { draft.autoHideTokens = value; }, {
                type: 'number', key: 'auto-hide-tokens', hint: 'At this size, hide older visible messages together. Keep the latest character reply, anything after it, and messages Mewmory has not read yet.',
            }));
    }
    root.append(settings);
    const retrieval = section('Finding relevant memories');
    retrieval.id = 'mewmory-settings-search';
    const rag = draft.retrieval;
    retrieval.append(node('p', 'mewmory-caption', 'Search recent scene cues against saved memories and original text. Complete passages already present in a reply are skipped when their presence can be confirmed. Replies use local search and completed AI selections while new AI searches run in the background.'));
    const ragFields = node('div', 'mewmory-fields');
    ragFields.append(configField('Search method', rag.mode, value => { rag.mode = value; }, { key: 'retrieval-mode', options: [['hybrid', 'Keywords and meaning'], ['keyword', 'Keywords'], ['semantic', 'Meaning, with keyword recovery']], hint: 'Meaning search needs Embeddings. Keyword search works without them.' }));
    for (const [key, label, hint] of [
        ['chunkSize', 'Maximum passage length, characters', 'Split original sources into passages for search. Splitting prefers paragraphs and words.'],
        ['chunkOverlap', 'Text repeated between passages, characters', 'Helps preserve context at passage boundaries. Must be less than half the passage length. Overlapping retrieved text is included once.'],
        ['queryMessages', 'Recent messages used to find matches', 'Use the last 1–12 accepted messages as search cues. This does not change how many messages stay in the reply.'],
        ['semanticWeight', 'Preference for meaning matches', '0 favours keywords; 1 favours meaning. Applies to combined search.'],
        ['minSimilarity', 'Minimum meaning match score', 'Raise this to require closer meaning matches. This is not a confidence percentage.'],
        ['resultLimit', 'Maximum recalled results', 'Maximum results before adding nearby passages. Results must also fit the memory allowance.'],
        ['maxPerSource', 'Maximum passages from one source', 'Stops one long source from filling the search results.'],
        ['neighbourChunks', 'Nearby passages to include on each side', 'Add 0–2 neighbouring passages where useful. Results share the memory allowance.'],
        ['batchSize', 'Passages per meaning-index request', 'How many passages to send to the Embeddings service together, from 1–10. Provider limits can reduce this.'],
    ]) ragFields.append(configField(label, rag[key], value => { rag[key] = value; }, { type: 'number', key: 'rag-' + key, hint }));
    retrieval.append(ragFields, configCheck('Search attached files and the Data Bank', rag.includeFiles, value => { rag.includeFiles = value; }),
        node('p', 'mewmory-caption', 'Only files attached to this account, character or chat are searched. File passages are references for the writer, not knowledge automatically given to characters. Allow file access separately for each model role.'));
    const model = section('Models used by Mewmory');
    model.id = 'mewmory-settings-models';
    model.dataset.mewmoryTour = 'models';
    model.append(node('p', 'mewmory-caption', 'Each role has a different job. These connections are separate from the model that writes replies and are shared across chats.'));
    const allProfiles = mewmory.config.profiles || [];
    const sharedProfile = allProfiles.find(profile => profile.id === draft.sharedProfileId);
    const shared = node('div', 'mewmory-fields mewmory-shared-profile');
    const textRoles = Object.entries(draft.roles).filter(([name]) => name !== 'embedding').map(([, role]) => role);
    shared.append(configField('Connection profile for all roles', draft.sharedProfileId || '', value => {
        draft.sharedProfileId = value;
        draft.sharedModelOverride = '';
        // Roles with no connection of their own start following the new profile straight away.
        if (value) for (const role of textRoles) if (!role.profileId && !role.endpoint) role.useShared = true;
        render();
    }, { options: [['', allProfiles.length ? 'None, choose for each role' : 'Save a connection profile first'], ...allProfiles.map(profile => [profile.id, profile.name]),
        ...(draft.sharedProfileId && !sharedProfile ? [[draft.sharedProfileId, 'Unavailable saved profile']] : [])], key: 'shared-profile',
    hint: 'Every role set to ‘Use the profile for all roles’ follows this one, so changing it here switches them together. Embeddings choose their own connection.' }));
    if (draft.sharedProfileId) shared.append(configField(sharedProfile?.model ? 'Model override for all roles, optional' : 'Model for all roles', draft.sharedModelOverride || '', value => {
        draft.sharedModelOverride = value;
        render();
    }, { key: 'shared-model-override', hint: sharedProfile?.model
        ? 'Leave blank to use the profile’s model: ' + sharedProfile.model
        : 'This profile has no saved model. Enter the model name provided by your service.' }));
    model.append(shared);
    const own = textRoles.filter(role => !role.useShared).length;
    if (draft.sharedProfileId && own) {
        const useEverywhere = button('Use for every role', () => {
            for (const role of textRoles) role.useShared = true;
            scheduleConfigSave({ immediate: true });
            render();
        });
        useEverywhere.id = 'mewmory-shared-profile-everywhere';
        const row = node('div', 'mewmory-actions');
        row.append(node('p', 'mewmory-caption', own + (own === 1 ? ' role still uses its own connection.' : ' roles still use their own connection.')), useEverywhere);
        model.append(row);
    }
    const picker = node('div', 'mewmory-role-picker');
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', 'Model role to set up');
    for (const [id, label] of Object.entries(roles)) {
        const choice = button(label, () => { ui.role = id; render(); });
        // Same reason as the tabs: .menu_button gets role=button styling from the host.
        choice.className = 'mewmory-role-button';
        choice.id = 'mewmory-role-' + id;
        choice.setAttribute('aria-pressed', String(ui.role === id));
        picker.append(choice);
    }
    model.append(picker);
    const role = draft.roles[ui.role];
    const roleForm = node('fieldset', 'mewmory-role');
    roleForm.append(node('legend', '', roles[ui.role]), node('p', 'mewmory-caption', roleDescriptions[ui.role]), configCheck('Enable this role', role.enabled, value => { role.enabled = value; }));
    const fields = node('div', 'mewmory-fields');
    const native = ui.role === 'embedding' && role.provider === 'native';
    if (ui.role === 'embedding') fields.append(configField('Embedding connection', role.provider || 'custom', value => {
        role.provider = value; render();
    }, { key: 'embedding-provider', options: [['custom', 'Mewmory connection'], ['native', 'Use native Vectorization']],
        hint: 'Native mode follows Vectorization’s saved provider, model, credentials and prefixes. Its server providers work even when Vectorization chat retrieval is off.' }));
    if (native) roleForm.append(node('p', 'mewmory-caption', role.native
        ? 'Saved Vectorization connection: ' + role.native.source + ' · ' + (role.native.model || 'server default')
        : 'Mewmory resolves the current Vectorization connection after these settings save. Configure its provider and prefixes in Extensions > Built-in > Vectorization.'));
    const profiles = allProfiles.filter(profile => ui.role !== 'embedding' || profile.embeddings);
    const usesShared = ui.role !== 'embedding' && role.useShared === true;
    const ownProfile = profiles.find(profile => profile.id === role.profileId);
    const selectedProfile = usesShared ? sharedProfile : ownProfile;
    if (!native) fields.append(configField('Connection profile', usesShared ? SHARED_PROFILE : role.profileId || '', value => {
        role.useShared = value === SHARED_PROFILE;
        if (!role.useShared) {
            role.profileId = value;
            role.model = profiles.find(profile => profile.id === value)?.model || '';
            role.modelOverride = '';
        }
        render();
    }, { options: [...(ui.role === 'embedding' ? [] : [[SHARED_PROFILE, 'Use the profile for all roles' + (sharedProfile ? ' (' + sharedProfile.name + ')' : '')]]),
        ['', 'Manual endpoint'], ...profiles.map(profile => [profile.id, profile.name]),
        ...(!usesShared && role.profileId && !ownProfile ? [[role.profileId, 'Unavailable saved profile']] : [])], key: 'profile-' + ui.role,
    hint: usesShared && draft.sharedProfileId
        ? 'Follows the profile for all roles: ' + (sharedProfile?.name || 'Unavailable saved profile') + ' · ' + (draft.sharedModelOverride || sharedProfile?.model || 'no model chosen')
        : 'Uses the saved profile’s model and server-side credentials. Embeddings need an OpenAI-compatible profile.' }));
    if (!native && usesShared && !draft.sharedProfileId) roleForm.append(node('p', 'mewmory-error', 'Choose a connection profile for all roles above, or pick a connection for this role.'));
    if (!native && !usesShared && role.profileId) fields.append(configField(selectedProfile?.model ? 'Model override, optional' : 'Model', role.modelOverride || '', value => {
        role.modelOverride = value;
        render();
    }, { key: 'model-override-' + ui.role, hint: selectedProfile?.model
        ? 'Leave blank to use the profile’s model: ' + selectedProfile.model
        : 'This profile has no saved model. Enter the model name provided by your service.' }));
    if (!native && !usesShared && !role.profileId) fields.append(
        configField('OpenAI-compatible endpoint', role.endpoint, value => {
            role.endpoint = value;
            if (role.decisionMode === 'decision' && String(value || '').trim() && String(role.model || '').trim()) role.enabled = true;
        }, {
            hint: DECISION_ROLES.includes(ui.role)
                ? 'For example: https://openrouter.ai/api/alpha/decisions, https://api.typesafe.ai/v1/systemone, or http://127.0.0.1:8000/v1/systemone'
                : 'For example: http://127.0.0.1:8000/v1',
            key: 'endpoint-' + ui.role,
        }),
        configField('Model', role.model, value => {
            role.model = value;
            if (role.decisionMode === 'decision' && String(value || '').trim() && String(role.endpoint || '').trim()) role.enabled = true;
            render();
        }, { key: 'model-' + ui.role }),
        configField('API key', role.apiKey || '', value => { role.apiKey = value; }, { type: 'password', hint: role.hasKey ? 'A key is saved. Leave blank to keep it.' : 'Stored in the server’s protected credentials.', key: 'api-key-' + ui.role }),
    );
    const usedProfileId = usesShared ? draft.sharedProfileId : role.profileId;
    const usedOverride = usesShared ? draft.sharedModelOverride : role.modelOverride;
    const modelName = usedProfileId ? usedOverride || selectedProfile?.model : role.model;
    if (DECISION_ROLES.includes(ui.role) && !native) {
        const matchedPreset = findDecisionPreset(modelName);
        const autoDecision = isDecisionModel(modelName, role.endpoint);
        const activeProtocol = effectiveDecisionMode({ ...role, model: modelName });
        const presetValue = matchedPreset?.id || (role.decisionMode === 'decision' ? 'custom' : '');
        fields.append(
            configField('Jev / decision model preset', presetValue, value => {
                if (!value) return;
                applyDecisionPresetToRole(draft, ui.role, value);
                render();
            }, {
                key: 'jev-preset-' + ui.role,
                options: [
                    ['', 'Choose a Jev or decision model…'],
                    ...JEV_DECISION_PRESETS.map(preset => [preset.id, preset.label]),
                    ['custom', 'Custom Jev / System One model…'],
                ],
                hint: matchedPreset
                    ? matchedPreset.family + ' · ' + matchedPreset.model + ' (threshold ' + matchedPreset.threshold + ').'
                    : 'Quick-fill Jev, another System One model, or a custom decision endpoint for fast memory selection.',
            }),
            configField('Decision protocol', role.decisionMode || 'auto', value => {
                role.decisionMode = value;
                render();
            }, {
                key: 'decision-mode-' + ui.role,
                options: [
                    ['auto', 'Auto (' + (autoDecision ? 'Jev / System One detected' : 'Standard JSON chat') + ')'],
                    ['decision', 'Jev / System One decision API'],
                    ['chat', 'Standard JSON chat completion'],
                ],
                hint: 'Jev and System One decision models score candidate memories in one pass (/systemone or /api/alpha/decisions) instead of writing JSON prose.',
            }),
            configField('Decision score threshold', role.decisionThreshold ?? defaultDecisionThreshold(modelName), value => {
                role.decisionThreshold = value;
            }, {
                type: 'number',
                key: 'decision-threshold-' + ui.role,
                disabled: activeProtocol !== 'decision',
                hint: 'Include candidate memories scored at or above this probability (0–1). Calibrated Jev and System One models use 0.5; Open-Jev uses 0.1.',
            }),
        );
    }
    const savedRole = mewmory.config.roles[ui.role];
    const savedShared = savedRole.useShared === true;
    if (savedRole.error && savedShared === usesShared && (usesShared ? draft.sharedProfileId === mewmory.config.sharedProfileId : role.profileId === savedRole.profileId)
        && (draft.sharedProfileId || !usesShared)) roleForm.append(node('p', 'mewmory-error', savedRole.error));
    const autoTokenizer = usedProfileId && !usedOverride ? selectedProfile?.autoTokenizer
        : modelName === savedRole.model ? savedRole.autoTokenizer : '';
    fields.append(
        configField('Model revision, optional', role.modelRevision, value => { role.modelRevision = value; }, { key: 'revision-' + ui.role }),
        configField('Model context size, tokens', role.contextTokens, value => { role.contextTokens = value; }, { type: 'number', key: 'context-' + ui.role,
            hint: 'Tokens are pieces of text counted by the model. Each role has its own limit. Set this to what your model service supports; changing it does not increase the model’s actual limit.' }),
        configField('Maximum response length, tokens', role.maxOutputTokens, value => { role.maxOutputTokens = value; }, { type: 'number', disabled: ui.role === 'embedding', key: 'output-' + ui.role,
            hint: ui.role === 'embedding' ? '' : 'Space reserved for the reply. A larger value leaves less room for the request.' }),
        configField('Request timeout, seconds', typeof role.timeoutMs === 'number' ? role.timeoutMs / 1000 : '', value => { role.timeoutMs = value === '' ? '' : value * 1000; }, { type: 'number', key: 'timeout-' + ui.role }),
        configField('Tokenizer for this role', role.tokenizer, value => { role.tokenizer = value; render(); }, {
            options: tokenizers.map(value => value === 'auto' ? ['auto', 'Auto (match this model)'] : value), key: 'tokenizer-' + ui.role,
            hint: role.tokenizer === 'auto' ? (autoTokenizer ? 'Auto uses ' + autoTokenizer + '.' : 'Auto’s local tokenizer match appears after these settings save.')
                + ' Counts are approximate. Choose a tokenizer manually if your provider uses a different one.' : '',
        }),
    );
    if (ui.role === 'embedding') {
        if (!native) fields.append(configField('Prefix preset', '', value => {
            const preset = PREFIX_PRESETS[Number(value)];
            if (!preset || value === '') return;
            role.queryPrefix = preset.query; role.documentPrefix = preset.document; render();
        }, { options: [['', 'Choose a preset'], ...PREFIX_PRESETS.map((preset, index) => [String(index), preset.label])],
            hint: 'Use the prefix recommended by your embedding model. Leading spaces, trailing spaces and line breaks are kept exactly.' }));
        fields.append(configField('Query prefix, optional', native ? role.native?.queryPrefix || '' : role.queryPrefix, value => { role.queryPrefix = value; }, { multiline: true, disabled: native }),
            configField('Document prefix, optional', native ? role.native?.documentPrefix || '' : role.documentPrefix, value => { role.documentPrefix = value; }, { multiline: true, disabled: native }));
    }
    roleForm.append(fields, configCheck('Allow sending story data to a service on another computer', role.allowRemote, value => { role.allowRemote = value; }));
    if (!native && !usesShared && !role.profileId) roleForm.append(configCheck('Remove the saved API key', role.clearKey, value => { role.clearKey = value; }));
    const scope = section('Sources this model may read');
    scope.dataset.mewmoryTour = 'permissions';
    for (const [type, label] of [['chat', 'Chat messages'], ['character', 'Character cards'], ['lore', 'Enabled lore'], ['memory', 'Saved memories'], ['file', 'Attached files and Data Bank']]) {
        scope.append(configCheck(label, role.allowedData.includes(type), checked => {
            role.allowedData = role.allowedData.filter(item => item !== type);
            if (checked) role.allowedData.push(type);
        }));
    }
    roleForm.append(scope);
    model.append(roleForm, renderFallbackConnections(draft), node('p', 'mewmory-caption', 'Recall selector and Recall fallback only pick from memories that already exist. Use models running on this computer only applies to every role. Embeddings are optional; keyword search always works.'));
    root.append(model, retrieval);
    const actions = node('div', 'mewmory-actions');
    const retry = button('Retry saving', () => { void mewmoryConfigAutosave.retry(); }, { primary: true });
    retry.id = 'mewmory-settings-retry';
    retry.hidden = true;
    const discard = button('Discard unsaved settings', discardSettingsDraft);
    discard.id = 'mewmory-settings-discard';
    actions.append(retry, discard);
    const status = node('p', 'mewmory-status');
    status.id = 'mewmory-settings-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    root.append(actions, status);
    root.addEventListener('input', updateSettingsStatus);
    root.addEventListener('change', updateSettingsStatus);
    updateSettingsStatus();
    renderHealth(root);
}

/**
 * Manual hiding only needs Mewmory on for this chat. A memory update can keep
 * running: hiding does not change source identity, and the server-side update
 * does not depend on this browser reload.
 */
export function manualHideDisabled(view) {
    return !view?.enabled;
}

function renderHealth(root) {
    const view = mewmory.view;
    if (!view) return;
    const health = section('Upkeep for this chat');
    health.id = 'mewmory-settings-upkeep';
    const progress = document.createElement('progress');
    progress.className = 'mewmory-progress';
    progress.max = Math.max(1, view.health.totalMessages);
    progress.value = view.health.totalMessages - view.health.pending;
    progress.setAttribute('aria-label', 'Messages processed');
    health.append(progress, node('p', 'mewmory-caption', 'Messages waiting for a memory update: ' + view.health.pending + '. '
        + (view.health.preservedThrough >= 0 ? 'Messages 1 to ' + (view.health.preservedThrough + 1) + ' are fully recorded and can be left out of replies.'
            : 'No messages are fully recorded yet.')
        + (!mewmory.config.roles.extractor.enabled && view.health.pending ? ' Enable Facts and events to record them.' : '')),
    node('p', 'mewmory-caption', 'Search: ' + (view.health.indexStatus === 'lexical' ? 'keyword search only'
        : view.health.indexStatus === 'ready' ? 'meaning search (embeddings) and keyword search ready' : 'building meaning search (embeddings); keyword search works meanwhile')
        + (view.health.indexVersion ? ' · index ' + view.health.indexVersion.slice(0, 12) : '')),
    node('p', 'mewmory-caption', 'Older messages stay saved and searchable. If the memories plus recent chat cannot fit the writing model, the reply stops with an error instead of dropping them.'),
    node('p', 'mewmory-caption', mewmory.config.historyMode === 'messages'
        ? 'The recent-message window controls which remembered messages can leave the reply. Optional hiding applies the same window to the saved chat.'
        : 'The hiding threshold is separate from the recent chat allowance. At the threshold, older visible messages are hidden together and the latest reply can stay visible.'));
    const actions = node('div', 'mewmory-actions');
    actions.append(button('Update memories for the whole chat', () => openEstimate(false), { disabled: mewmory.busy || !view.enabled }),
        button('Review for missed details', () => openEstimate(true), { disabled: mewmory.busy || !view.enabled }),
        button('Rebuild meaning search', () => act(scope => requestMewmory('index', { reset: true }, { scope })),
            { disabled: !mewmory.config.roles.embedding.enabled || mewmory.busy || !view.enabled }),
        button(mewmory.config.historyMode === 'messages' ? 'Hide messages outside the recent window' : 'Hide old messages at the token threshold',
            () => act(() => hideOverflowMessages()), { disabled: manualHideDisabled(view) }));
    health.append(node('p', 'mewmory-caption', 'Updating the whole chat includes recent messages and can make paid model requests. Reviewing missed details does not create a running story summary.'));
    if (mewmory.busy) actions.append(button('Stop updating', stopMewmoryBackfill));
    health.append(actions);
    renderEstimate(health);
    renderSpend(health);
    if (view.operationsError) health.append(node('p', 'mewmory-caption', view.operationsError));
    for (const job of view.operations || []) {
        const jobMessage = job.error?.message || job.warning || '';
        const jobLine = node('p', 'mewmory-caption', job.label + ' · ' + job.state);
        if (jobMessage) jobLine.append(': ', node('span', '', jobMessage));
        health.append(jobLine);
        if (['failed', 'interrupted'].includes(job.state)) health.append(button('Retry ' + job.label.toLocaleLowerCase(), () => act(() => retryJob(job.id))));
        if (['failed', 'interrupted', 'completed', 'cancelled'].includes(job.state)) health.append(button('Dismiss ' + job.label.toLocaleLowerCase(), () => act(() => dismissJob(job.id))));
    }
    if (view.health.jobs.length) health.append(node('h4', '', 'Recent updates'));
    for (const job of view.health.jobs.slice(-5).reverse()) {
        health.append(node('p', 'mewmory-caption', (job.checkpoint ? 'Review for missed details' : 'Memory update') + ', messages '
            + (job.from + 1) + ' to ' + (job.through + 1) + ': '
            + ({ processing: 'running', complete: 'done', failed: 'didn’t finish', superseded: 'restarted with the newer message text' }[job.status] || job.status)
            + (job.error ? '. ' + job.error : '')
            + (job.skipped ? '. ' + job.skipped + (job.skipped === 1
                ? ' proposed entry was skipped because Mewmory could not save it'
                : ' proposed entries were skipped because Mewmory could not save them')
                + (job.skippedReasons?.length ? ', for example: ' + displayedSkipReason(job.skippedReasons[0]) : '.') : '')));
    }
    const usage = node('dl', 'mewmory-usage');
    if (Object.keys(view.health.usage || {}).length) health.append(node('h4', '', 'Model calls for this chat'));
    for (const [role, total] of Object.entries(view.health.usage || {})) {
        usage.append(node('dt', '', roles[role]), node('dd', '', total.requests + ' calls · '
            + total.input.toLocaleString() + ' in / ' + total.output.toLocaleString() + ' out · '
            + (total.milliseconds / 1000).toFixed(1) + ' s'));
    }
    health.append(usage);
    root.append(health);
    renderTransfers(root);
    if (!view.parent && !view.recordCount) {
        const association = section('Continue a story from another chat');
        association.append(node('p', 'mewmory-caption', 'This explicitly copies the selected chat’s current memory and accepted history into this continuation. Later changes stay in their own branch.'));
        const choices = mewmory.stories.filter(story => JSON.stringify(story.locator) !== JSON.stringify(view.locator));
        association.append(field('Earlier chat', ui.parent || '', value => { ui.parent = value; }, {
            options: [['', 'Choose an earlier chat'], ...choices.map(story => [JSON.stringify(story.locator), story.locator.chat])],
        }), button('Link this continuation', () => act(async () => {
            if (!ui.parent) throw new Error('Choose an earlier chat first.');
            await changeMewmory('associate', { parent: JSON.parse(ui.parent) });
            ui.parent = '';
        })));
        root.append(association);
    }
}

function tokenCount(value) {
    return Number(value || 0).toLocaleString() + (value === 1 ? ' token' : ' tokens');
}

export function estimateText(estimate) {
    if (!estimate.messages) return ['Nothing is waiting. Every message in this chat already has its memories.'];
    const lines = [estimate.messages + (estimate.messages === 1 ? ' message' : ' messages') + ' to read in about '
        + estimate.batches + (estimate.batches === 1 ? ' model request.' : ' model requests.')];
    lines.push(estimate.tokens
        ? 'Expected use: about ' + tokenCount(estimate.tokens) + ', based on earlier updates in this chat.'
        : 'The messages add up to about ' + tokenCount(estimate.messageTokens) + '. Instructions and earlier memories add more on top, so the real figure is higher.');
    if (!estimate.enabled) lines.push('Facts and events is switched off, so nothing will be read until you switch it on.');
    if (estimate.overLimit) lines.push('This would go past your daily token limit. Updates you start yourself still run.');
    return lines;
}

function openEstimate(checkpoint) {
    const scope = getMewmoryScope();
    ui.estimate = { checkpoint, data: null, error: '', scope };
    render();
    requestMewmory('estimate', { checkpoint }, { scope }).then(data => {
        if (ui.estimate?.scope === scope && ui.estimate.checkpoint === checkpoint) ui.estimate.data = data;
    }, error => {
        if (ui.estimate?.scope === scope) ui.estimate.error = error?.message || String(error);
    }).finally(() => render());
}

function renderEstimate(root) {
    if (!ui.estimate) return;
    const { checkpoint, data, error } = ui.estimate;
    const box = node('div', 'mewmory-estimate');
    box.id = 'mewmory-estimate';
    box.setAttribute('role', 'status');
    box.append(node('h4', '', checkpoint ? 'Before reviewing for missed details' : 'Before updating the whole chat'));
    if (error) box.append(node('p', 'mewmory-caption', error));
    else if (!data) box.append(node('p', 'mewmory-caption', 'Working out how much this update reads…'));
    else for (const line of estimateText(data)) box.append(node('p', 'mewmory-caption', line));
    const actions = node('div', 'mewmory-actions');
    actions.append(button(checkpoint ? 'Start review' : 'Start update', () => {
        ui.estimate = null;
        return processMewmory({ all: true, checkpoint });
    }, { primary: true, disabled: !data || !data.messages || !data.enabled || mewmory.busy }),
    button('Cancel', () => { ui.estimate = null; render(); }));
    box.append(actions);
    root.append(box);
}

function renderSpend(root) {
    const spend = mewmory.spend;
    if (!spend) return;
    const line = 'Model use today across all chats: ' + tokenCount(spend.used) + ' in '
        + spend.requests + (spend.requests === 1 ? ' call' : ' calls')
        + (spend.limit ? ' of a ' + tokenCount(spend.limit) + ' daily limit.' : '. No daily limit is set.');
    root.append(node('p', 'mewmory-caption', line));
    if (spend.reached) root.append(node('p', 'mewmory-notice', 'Daily limit reached. Automatic updates are paused until tomorrow. Buttons you press still work.'));
}

function download(name, parts, type) {
    const url = URL.createObjectURL(new Blob(parts, { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileName(chat) {
    return String(chat || 'chat').replace(/[^\p{L}\p{N}_-]/gu, '-');
}

export function pickRestoreBackup(file, view) {
    if (file?.format !== 'mewmory-export-all-1') return file;
    const match = (file.chats || []).find(entry => entry?.state?.storyId === view?.storyId && entry?.state?.branchId === view?.branchId)
        || (file.chats || []).find(entry => JSON.stringify(entry?.locator) === JSON.stringify(view?.locator));
    if (!match) throw new Error('This file has no memories for this chat.');
    return { format: 'mewmory-export-1', exportedAt: match.exportedAt || file.exportedAt, state: match.state };
}

async function exportEveryChat() {
    const stories = mewmory.stories || [];
    if (!stories.length) throw new Error('No chat has any memories to export yet.');
    const parts = ['{"format":"mewmory-export-all-1","exportedAt":' + Date.now() + ',"chats":['];
    let first = true;
    for (const [index, story] of stories.entries()) {
        ui.progress = 'Exporting chat ' + (index + 1) + ' of ' + stories.length + '…';
        render();
        const data = await requestMewmory('export', { locator: story.locator });
        parts.push((first ? '' : ',') + JSON.stringify({ locator: story.locator, exportedAt: data.exportedAt, state: data.state }));
        first = false;
    }
    parts.push(']}');
    ui.progress = '';
    download('Mewmory-every-chat.json', parts, 'application/json');
    ui.transferNote = 'Exported ' + stories.length + (stories.length === 1 ? ' chat.' : ' chats.');
}

function renderLorebook(root) {
    const locator = getMewmoryLocator();
    if (!locator) return;
    const lore = section('Send memories to a lorebook');
    lore.id = 'mewmory-settings-lorebook';
    lore.append(node('p', 'mewmory-caption', 'Copies this chat’s current facts, events and promises into a lorebook you can edit or share. '
        + 'Mewmory never reads these entries back, and sending again updates the same entries instead of adding copies.'));
    const name = ui.loreName || defaultLorebookName(locator.chat);
    lore.append(field('Lorebook name', name, value => { ui.loreName = value; }, { key: 'lorebook-name' }));
    const actions = node('div', 'mewmory-actions');
    actions.append(button('Send memories to this lorebook', () => act(async () => {
        const { entries } = await requestMewmory('lore');
        const result = await sendToLorebook(ui.loreName || name, entries);
        ui.loreNote = (result.added || result.updated)
            ? 'Added ' + result.added + ' and updated ' + result.updated + ' entries in ' + result.name + '.'
            : 'Nothing new to send: ' + result.name + ' already matches.';
    }, { refresh: false })));
    lore.append(actions);
    if (ui.loreNote) lore.append(node('p', 'mewmory-caption', ui.loreNote));
    root.append(lore);
}

function renderTransfers(root, recover = false) {
    const archive = section('Export and restore');
    if (!recover) archive.id = 'mewmory-settings-transfers';
    archive.append(node('p', 'mewmory-caption', 'Exports contain the story text and memories, but no API keys or passwords. Restoring checks every memory against the chat as it is now.'));
    const transfers = node('div', 'mewmory-actions');
    if (!recover) transfers.append(button('Export Mewmory', () => act(async () => {
        const data = await requestMewmory('export');
        download('Mewmory-' + fileName(getMewmoryLocator().chat) + '.json', [JSON.stringify(data, null, 2)], 'application/json');
    }, { refresh: false })), button('Export as Markdown', () => act(async () => {
        const { markdown } = await requestMewmory('export/markdown');
        download('Mewmory-' + fileName(getMewmoryLocator().chat) + '.md', [markdown], 'text/markdown');
    }, { refresh: false })), button('Export every chat', () => act(exportEveryChat, { refresh: false }), {
        disabled: !mewmory.stories?.length,
    }));
    const upload = node('label', 'mewmory-field');
    upload.append(node('span', '', 'Choose a Mewmory export'));
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.addEventListener('change', () => {
        const selected = file.files?.[0];
        if (!selected) return;
        void act(async scope => {
            if (selected.size > 256 * 1024 * 1024) throw new Error('This export is larger than the 256 MiB restore limit.');
            const locator = getMewmoryLocator();
            const revision = mewmory.view?.revision;
            const backup = pickRestoreBackup(JSON.parse(await selected.text()), mewmory.view);
            const review = await requestMewmory('restore', { locator, backup, revision, recover }, { scope });
            ui.restore = { backup, review, recover };
        }, { refresh: false });
    });
    upload.append(file);
    transfers.append(upload);
    archive.append(transfers);
    if (ui.transferNote && !recover) archive.append(node('p', 'mewmory-caption', ui.transferNote));
    if (ui.restore) {
        const { backup, review, recover } = ui.restore;
        archive.append(node('p', '', review.restored.length + ' memories can be restored as your own corrections. '
            + review.skipped.length + ' cannot, because the messages they rely on have changed.'));
        for (const skipped of review.skipped.slice(0, 5)) archive.append(node('p', 'mewmory-caption', skipped.reason));
        archive.append(button('Restore ' + review.restored.length + ' memories', () => act(async () => {
            await requestMewmory('restore', { backup, revision: review.revision, recover, recoveryToken: review.recoveryToken, apply: true });
            ui.restore = null;
        }), { disabled: !recover && !review.restored.length }), button('Cancel restore', () => { ui.restore = null; render(); }));
    }
    archive.append(node('p', 'mewmory-caption', 'Deleting a message also removes the memories based on it. Chat backups and downloaded exports are not affected. '
        + 'Markdown is for reading; only the JSON exports can be restored. A file with every chat restores the memories that belong to this chat.'));
    root.append(archive);
    if (!recover) renderLorebook(root);
}

/** Groups a switch with the sentence that explains it, and links the two for screen readers. */
function switchRow(control, id, description) {
    const row = node('div', 'mewmory-toggle');
    control.classList.add('mewmory-switch');
    const caption = node('p', 'mewmory-caption', description);
    caption.id = 'mewmory-switch-hint-' + id;
    control.querySelector('input').setAttribute('aria-describedby', caption.id);
    row.append(control, caption);
    return row;
}

function renderOverview(root) {
    const view = mewmory.view;
    const overview = node('section', 'mewmory-overview');
    overview.setAttribute('aria-label', 'Memory status for this chat');
    const restoration = view.visibilityRestore;
    const toggle = check('Use Mewmory in this chat', view.enabled, enabled => act(async () => {
        await changeMewmory('enabled', { enabled });
        window.dispatchEvent(new Event('mewmory:configured'));
    }), ['pending', 'failed'].includes(restoration?.status));
    const toggles = node('div', 'mewmory-toggles');
    overview.append(toggles);
    if (!view.enabled) {
        toggles.append(switchRow(toggle, 'enabled', 'Off for this chat. Replies are written without Mewmory’s memories until you switch it on.'));
        if (restoration?.status === 'failed') overview.append(button('Retry restoration', () => act(() => retryMewmoryVisibilityRestore())));
        root.append(overview);
        return;
    }
    toggles.append(switchRow(toggle, 'enabled', 'Turning this off shows messages hidden by Mewmory. Messages you hid yourself stay hidden. Saved memories are kept.'));
    if (restoration?.status === 'failed') overview.append(button('Retry restoration', () => act(() => retryMewmoryVisibilityRestore())));
    const offRecord = isMewmoryOffRecord();
    const privacy = check('Keep new messages off the record', offRecord, on => act(() => setMewmoryOffRecord(on), { refresh: false }));
    privacy.querySelector('input').id = 'mewmory-off-record';
    toggles.append(switchRow(privacy, 'off-record', offRecord
        ? 'On: Mewmory skips every new message in this chat until you switch this off. Earlier messages are unaffected.'
        : 'Switch on for a stretch you want Mewmory to skip. Messages sent while it is on are never remembered.'));
    const health = view.health || {};
    const total = Number(health.totalMessages) || 0;
    const pending = Math.max(0, Number(health.pending) || 0);
    const entries = [];
    if (total) {
        const done = Math.max(0, total - pending);
        const bar = document.createElement('progress');
        bar.className = 'mewmory-progress';
        bar.max = total;
        bar.value = done;
        bar.setAttribute('aria-label', 'Messages remembered');
        entries.push({ name: 'Remembered', value: done.toLocaleString() + ' of ' + total.toLocaleString() + ' messages', bar });
    }
    entries.push({ name: 'Waiting', value: pending === 1 ? '1 message' : pending.toLocaleString() + ' messages',
        detail: mewmory.busy ? 'Updating now' : pending && !mewmory.config?.autoUpdate ? 'Press Update now on the Now tab' : '' });
    entries.push({ name: 'Memories', value: Number(view.recordCount ?? view.records?.length ?? 0).toLocaleString() });
    if (health.indexStatus) entries.push({ name: 'Search', value: health.indexStatus === 'lexical' ? 'Keywords only'
        : health.indexStatus === 'ready' ? 'Keywords and meaning' : 'Building meaning search',
    detail: health.indexStatus === 'ready' || health.indexStatus === 'lexical' ? '' : 'Keyword search works meanwhile' });
    overview.append(stats(entries));
    root.append(overview);
}

/** On narrow screens the tabs scroll sideways; keep the selected one in view without moving the page. */
function revealSelectedTab(navigation) {
    if (navigation.scrollWidth <= navigation.clientWidth) return;
    const selected = navigation.querySelector('[aria-selected="true"]');
    if (!selected) return;
    const start = selected.offsetLeft - navigation.clientLeft;
    const end = start + selected.offsetWidth;
    if (start < navigation.scrollLeft) navigation.scrollLeft = start - 8;
    else if (end > navigation.scrollLeft + navigation.clientWidth) navigation.scrollLeft = end - navigation.clientWidth + 8;
}

let renderFrame = null;

function queueRender() {
    if (renderFrame !== null) return;
    renderFrame = window.requestAnimationFrame(() => {
        renderFrame = null;
        render();
    });
}

function render() {
    if (renderFrame !== null) {
        window.cancelAnimationFrame(renderFrame);
        renderFrame = null;
    }
    const root = ui.root;
    // Activating the shell tab mounts it again with the latest state.
    if (!root || !root.isConnected || root.closest('[hidden], [aria-hidden="true"], .closedDrawer')) return;
    const active = root.contains(document.activeElement) ? document.activeElement : null;
    const focusId = active?.id;
    const selection = active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && ['text', 'password'].includes(active.type))
        ? [active.selectionStart, active.selectionEnd] : null;
    const scope = getMewmoryScope();
    if (ui.scope !== scope) {
        ui.scope = scope;
        ui.editor = null;
        ui.source = null;
        ui.restore = null;
        ui.owner = '';
        ui.subject = '';
        ui.offset = 0;
        ui.matches = null;
        ui.searchReport = null;
        ui.query = '';
        ui.significance = '';
        ui.status = '';
        ui.parent = '';
        clearArchiveFilters();
        ui.moreFilters = false;
        ui.selected = new Set();
        ui.history = null;
        ui.duplicates = null;
        ui.layout = 'list';
        ui.message = null;
        ui.person = '';
        ui.question = '';
        ui.answer = null;
        ui.askError = '';
        ui.conflicts = null;
        ui.conflictError = '';
        ui.shareNote = '';
        ui.estimate = null;
        ui.loreName = '';
        ui.loreNote = '';
        ui.transferNote = '';
        ui.progress = '';
        ui.running = false;
    }
    if (mewmory.focusMessage) {
        const focus = mewmory.focusMessage;
        mewmory.focusMessage = null;
        ui.tab = 'archive';
        ui.editor = null;
        ui.source = null;
        ui.message = { ...focus, data: null, error: '' };
        void loadMessage({ scroll: true });
    }
    const tabsScrollLeft = root.querySelector('.mewmory-tabs')?.scrollLeft || 0;
    root.replaceChildren();
    const heading = node('header', 'mewmory-heading');
    const locator = getMewmoryLocator();
    const where = node('div', 'mewmory-where');
    where.append(node('span', 'mewmory-eyebrow', 'Memory for'),
        node('p', 'mewmory-scope', locator?.chat || mewmory.view?.locator?.chat || 'No Roleplay chat selected'));
    const extractorOn = mewmory.config?.roles.extractor.enabled;
    const waiting = Boolean(mewmory.view?.health?.pending);
    const restoration = mewmory.view?.visibilityRestore;
    const restoreMessage = restoration?.status === 'pending' ? 'Turning off Mewmory and showing its hidden messages…'
        : restoration?.status === 'failed' ? 'Mewmory is off, but some messages could not be shown. Retry restoration.'
            : restoration?.status === 'complete' && !mewmory.view?.enabled ? restoration.restored
                ? 'Mewmory is off. Restored ' + restoration.restored + ' hidden messages.' : 'Mewmory is off. No messages needed restoring.' : '';
    const status = node('p', 'mewmory-status', mewmory.error || restoreMessage || (mewmory.loading ? 'Loading this chat’s memory…' : mewmory.busy || mewmory.preparing ? 'Updating memories…'
        : mewmory.view?.enabled ? extractorOn
            ? waiting ? 'Messages are waiting for a memory update.' : 'Up to date'
            : 'Facts and events is switched off. Original passages remain searchable.' : 'Off'));
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.dataset.error = String(Boolean(mewmory.error));
    status.dataset.state = mewmory.error || restoration?.status === 'failed' ? 'error'
        : mewmory.loading || mewmory.busy || mewmory.preparing || restoration?.status === 'pending' ? 'busy'
            : mewmory.view?.enabled ? extractorOn && !waiting ? 'ready' : 'warning' : 'off';
    heading.append(where, status, button('Refresh', () => act(() => refreshMewmory(filters()), { refresh: false })));
    root.append(heading);
    if (mewmory.view) renderOverview(root);
    const navigation = node('nav', 'mewmory-tabs');
    navigation.setAttribute('role', 'tablist');
    navigation.setAttribute('aria-label', 'Mewmory views');
    for (const [id, label] of tabs) {
        const tab = button(label, () => switchTab(id));
        // The host assigns role=button to .menu_button, so tabs use their own native-button class.
        tab.className = 'mewmory-tab';
        tab.id = 'mewmory-tab-' + id;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(ui.tab === id));
        tab.setAttribute('aria-controls', 'mewmory-pane-' + id);
        tab.tabIndex = ui.tab === id ? 0 : -1;
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const current = tabs.findIndex(([key]) => key === id);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            void switchTab(tabs[next][0]).then(() => document.getElementById('mewmory-tab-' + tabs[next][0])?.focus());
        });
        navigation.append(tab);
    }
    root.append(navigation, node('p', 'mewmory-caption mewmory-tab-hint', tabHints[ui.tab] || ''));
    for (const [id] of tabs) {
        const page = node('div', 'mewmory-page');
        page.id = 'mewmory-pane-' + id;
        page.setAttribute('role', 'tabpanel');
        page.setAttribute('aria-labelledby', 'mewmory-tab-' + id);
        page.hidden = ui.tab !== id;
        root.append(page);
        if (page.hidden) continue;
        if (id !== 'settings' && !mewmory.view) {
            if (locator) empty(page, mewmory.loading ? 'Loading memory' : 'Memory could not load',
                mewmory.loading ? 'Your selected chat will appear here when it is ready.' : 'Press Refresh to try loading this chat again.');
            else {
                empty(page, 'Open a saved Roleplay chat', 'Choose a character or group chat to inspect its memory. Model roles can be configured in Settings.');
                page.dataset.mewmoryNoChat = 'true';
            }
            if (id === 'now') renderQuickSetup(page);
            if (locator && mewmory.error && !mewmory.loading) renderTransfers(page, true);
        } else {
            ({ now: renderNow, story: renderStory, pawspective: renderPawspective, archive: renderArchive, recall: renderRecall, settings: renderSettings })[id](page);
            renderEditor(page);
            renderSource(page);
        }
    }
    // Measure only once the whole panel is back, or the half-built page clamps the reader's scroll position.
    navigation.scrollLeft = tabsScrollLeft;
    revealSelectedTab(navigation);
    if (focusId && !(active instanceof HTMLSelectElement)) {
        const target = document.getElementById(focusId);
        target?.focus({ preventScroll: true });
        if (selection && target?.setSelectionRange) target.setSelectionRange(...selection);
    }
}

/** Resolves once the Mewmory stylesheet applies, so the panel never paints unstyled. */
function loadMewmoryStyles() {
    let style = document.getElementById('mewmory-css');
    if (!style) {
        style = document.createElement('link');
        style.id = 'mewmory-css';
        style.href = 'css/mewmory.css?v=20261113-mewmory-readable';
        document.head.append(style);
    }
    if (style.rel !== 'stylesheet') {
        style.dataset.sbStyleActivated = 'true';
        style.media = 'all';
        style.rel = 'stylesheet';
    }
    if (style.sheet) return Promise.resolve();
    return new Promise(resolve => {
        const done = () => {
            window.clearTimeout(timeout);
            resolve();
        };
        const timeout = window.setTimeout(done, 8000);
        style.addEventListener('load', done, { once: true });
        style.addEventListener('error', done, { once: true });
    });
}

export async function mountMewmory(root) {
    initMewmory();
    await loadMewmoryStyles();
    if (ui.root !== root) {
        ui.root = root;
        window.addEventListener('mewmory:updated', queueRender);
    }
    render();
    await act(() => refreshMewmory(filters()), { refresh: false });
    notifyMewmory();
}
