import {
    changeMewmory, getMewmoryLocator, getMewmoryScope, hideOverflowMessages, initMewmory, mewmory, notifyMewmory,
    processMewmory, refreshMewmory, requestMewmory, retryMewmoryVisibilityRestore, stopMewmoryBackfill,
} from './index.js';
import { getRequestHeaders } from '../../script.js';
import { currentUser } from '../user.js';
import { getFriendlyTokenizerName } from '../tokenizers.js';
import { uuidv4 } from '../utils.js';
import { dismissJob, retryJob } from '../jobs.js';
import { mewmoryConfigAutosave } from './config-autosave.js';
import { PREFIX_PRESETS, RAG_DEFAULTS } from './rag-settings.js';

function displayedSkipReason(reason) {
    if (reason === 'Entity ID is empty or too long.') return 'A character or object reference is missing or invalid.';
    if (reason === 'Pawspective and \'what a character knows\' memories must belong to a character played by the AI, not to you.') {
        return 'This entry could not be linked to a recognised AI-controlled character. Character knowledge and Pawspective entries require one.';
    }
    return reason;
}

const tabs = [['now', 'Now'], ['pawspective', 'Pawspective'], ['archive', 'Archive'], ['recall', 'Recall'], ['settings', 'Settings']];
const kinds = { entity: 'NPC or entity reference', state: 'Current state', event: 'Event', relationship: 'Relationship fact',
    knowledge: 'Character knowledge', commitment: 'Promise or unresolved matter', interview: 'Pawspective interview', overview: 'Current subject view' };
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
    searchMode: 'hybrid', searchType: '', searchReport: null, running: false, progress: '', scope: '' };

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

function field(label, value, onChange, { type = 'text', multiline = false, options = null, key = label, hint = '', disabled = false, autosave = false } = {}) {
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
    control.addEventListener(options ? 'change' : 'input', () => {
        onChange(type === 'number' ? numberValue(control.value) : control.value);
        if (autosave) scheduleConfigSave({ immediate: Boolean(options) });
    });
    const caption = node('label', '', label);
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

function section(title) {
    const element = node('section', 'mewmory-section');
    element.append(node('h4', '', title));
    return element;
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

function filters() {
    if (ui.tab === 'pawspective') return { kind: 'interview', ownerId: ui.owner, subjectId: ui.subject,
        significance: ui.significance, status: ui.status, offset: ui.offset };
    if (ui.tab === 'archive') return { kind: ui.kind, query: ui.query, offset: ui.offset };
    return {};
}

async function act(action, { refresh = true } = {}) {
    if (ui.running) return;
    const scope = getMewmoryScope();
    ui.running = scope;
    render();
    try {
        await action(scope);
        if (scope !== getMewmoryScope()) return;
        mewmory.error = '';
        if (refresh) await refreshMewmory(filters());
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

function renderRecord(record, root, { editable = true } = {}) {
    const article = node('article', 'mewmory-record');
    article.dataset.ineligible = String(record.eligible === false);
    const heading = node('div', 'mewmory-record-heading');
    const subjects = record.subjectIds.map(nameOf).join(', ');
    const title = record.kind === 'entity' ? record.name
        : record.ownerId ? nameOf(record.ownerId) + (subjects ? ' / ' + subjects : '') : kinds[record.kind];
    heading.append(node('h4', '', title), node('span', 'mewmory-caption',
        [record.status, record.significance ? record.significance + ' importance' : '', 'message ' + (record.asOf + 1), record.authorOverride ? 'edited by you' : ''].filter(Boolean).join(' · ')));
    article.append(heading);
    if (record.provenance?.model && !record.authorOverride) article.append(node('p', 'mewmory-caption',
        'Generated by ' + record.provenance.model + (record.provenance.modelRevision ? ' · ' + record.provenance.modelRevision : '') + ' · version ' + record.version));
    if (record.eligible === false) article.append(node('p', 'mewmory-caption', 'Not used in replies: a message or memory it is based on changed, or it was switched off.'));
    if (record.kind === 'interview') {
        const interview = node('div', 'mewmory-interview');
        for (const turn of record.interview) interview.append(node('strong', '', turn.question), node('p', 'mewmory-prose', turn.answer));
        article.append(interview, node('p', 'mewmory-caption', 'Imaginary interview. Its actions are not events in the story.'));
        if (record.changeExplanation) article.append(node('p', 'mewmory-prose', 'Their explanation of the change: ' + record.changeExplanation));
    } else {
        article.append(node('p', 'mewmory-prose', record.text));
        if (record.appearance) article.append(node('p', 'mewmory-prose', 'Appearance: ' + record.appearance));
        if (record.speech) article.append(node('p', 'mewmory-prose', 'Speech: ' + record.speech));
        if (record.evidenceStatus) article.append(node('p', 'mewmory-caption', 'How certain: ' + record.evidenceStatus));
        if (record.method) article.append(node('p', 'mewmory-caption', 'Learned through: ' + record.method));
    }
    article.append(sourceButtons(record.refs));
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
        }, { options: corrections, key: 'correction-' + record.id });
        actions.append(correction, button('Edit', () => openEditor(record)),
            button('Undo last change', () => act(() => changeMewmory('record/action', { id: record.id, action: 'undo' }))));
        article.append(actions);
    }
    root.append(article);
}

function renderNow(root) {
    const view = mewmory.view;
    if (!view?.enabled) {
        empty(root, 'Keep the story, and how it felt.',
            'Mewmory remembers events and NPC details. Pawspective tracks how each character’s view changes, linked back to the messages behind it.',
            'Set up model roles', () => switchTab('settings'));
        return;
    }
    const actions = node('div', 'mewmory-actions');
    actions.append(button('Preview next memory', () => act(() => requestMewmory('recall', { tokenizer: getFriendlyTokenizerName() })), { primary: true }),
        button(mewmory.busy ? 'Updating…' : 'Update now', () => processMewmory({ all: true }), { disabled: mewmory.busy }),
        button('Add NPC reference', () => openEditor(null, 'entity')));
    root.append(actions);
    const cast = section('Active NPCs');
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
    renderPreview(root);
}

function renderPreview(root) {
    const preview = mewmory.view?.preview;
    if (!preview) return;
    const block = section('Memories and passages selected for this reply');
    block.append(node('p', 'mewmory-caption', mewmory.view.previewCurrent
        ? 'This is the latest prepared snapshot. A later reply may use different memories. Why each memory was picked is shown in Recall.'
        : 'This preview is out of date. Preview again to refresh it.'));
    const counts = node('dl', 'mewmory-tokens');
    for (const [label, value] of [['NPC details, tokens', preview.tokens?.npc], ['Picked memories, tokens', preview.tokens?.memory],
        ['Recent chat kept, tokens', preview.history?.retainedTokens], ['Recent chat in this prepared reply, messages', preview.history?.retainedMessages]]) {
        if (value !== undefined) counts.append(node('dt', '', label), node('dd', '', Number(value).toLocaleString()));
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

function renderArchive(root) {
    const view = mewmory.view;
    root.append(node('p', 'mewmory-caption', 'Search saved memories and original sources. A search result is not necessarily used in a reply.'));
    const controls = node('div', 'mewmory-fields');
    const search = async () => {
        ui.offset = 0;
        const result = ui.query.trim() ? await requestMewmory('search', { query: ui.query, mode: ui.searchMode, dataType: ui.searchType }) : null;
        ui.matches = result?.matches || null;
        ui.searchReport = result?.retrieval || null;
        await refreshMewmory(filters());
    };
    controls.append(field('Memory type', ui.kind, value => {
        ui.kind = value;
        ui.offset = 0;
        void act(() => refreshMewmory(filters()), { refresh: false });
    }, { options: [['objective', 'All facts and events'], ...Object.entries(kinds).filter(([kind]) => !['interview', 'overview'].includes(kind))] }),
    field('Search memories and original messages', ui.query, value => { ui.query = value; }, { key: 'archive-search' }),
    field('Search method', ui.searchMode, value => { ui.searchMode = value; }, { options: [['hybrid', 'Keywords and meaning'], ['keyword', 'Keywords'], ['semantic', 'Meaning']] }),
    field('Search source', ui.searchType, value => { ui.searchType = value; }, { options: [['', 'All sources'], ['chat', 'Chat messages'],
        ['memory', 'Saved memories'], ['character', 'Character cards'], ['lore', 'Lorebooks'], ['file', 'Attached files and Data Bank']] }));
    const form = node('form');
    form.addEventListener('submit', event => { event.preventDefault(); void act(search, { refresh: false }); });
    form.append(controls);
    const actions = node('div', 'mewmory-actions');
    actions.append(button('Search archive', () => act(search, { refresh: false }), { primary: true }),
        button('Add memory', () => openEditor()));
    form.append(actions);
    root.append(form);
    if (ui.searchReport) root.append(node('p', 'mewmory-caption', 'Search used ' + ui.searchReport.usedMode + ' matching across '
        + ui.searchReport.documents + ' passages.' + (ui.searchReport.keywordFallback ? ' Meaning search is unavailable; keyword matches are shown.' : '')
        + (ui.searchReport.error ? ' ' + ui.searchReport.error : '')));
    const records = section('Memories');
    for (const record of view.records.filter(record => !['interview', 'overview'].includes(record.kind))) renderRecord(record, records);
    if (!view.records.length) empty(records, 'No memories here yet', 'Run an update, choose another memory type, or add a memory yourself.');
    root.append(records);
    pagination(root);
    const sources = section(ui.matches ? 'Ranked archive matches' : 'Recent messages, lore and files');
    if (ui.matches) {
        const passages = ui.matches;
        for (const passage of passages) {
            const row = node('article', 'mewmory-record');
            row.append(node('strong', '', passage.sourceName || kinds[passage.kind] || passage.dataType),
                node('p', 'mewmory-prose', passage.text), sourceButtons(passage.refs));
            if (passage.retrieval) row.append(node('p', 'mewmory-caption', 'Rank score: ' + passage.retrieval.score.toFixed(4)
                + (passage.retrieval.similarity === null ? '' : ' · Meaning similarity: ' + passage.retrieval.similarity.toFixed(3))));
            sources.append(row);
        }
        if (!passages.length) sources.append(node('p', 'mewmory-caption', 'No eligible memory or passage matches this search.'));
    } else {
        for (const source of view.sources) {
            const row = node('article', 'mewmory-record');
            row.append(node('strong', '', source.speaker + (source.eligible ? '' : ' · not used')),
                node('p', 'mewmory-caption', source.text), sourceButtons([source]));
            sources.append(row);
        }
    }
    root.append(sources);
}

function renderRecall(root) {
    root.append(button('Preview which memories would be picked', () => act(() => requestMewmory('recall', { tokenizer: getFriendlyTokenizerName() })), { primary: true }));
    const run = mewmory.view.recalls.at(-1);
    if (!run) {
        empty(root, 'Nothing to show yet', 'Preview memories or write the next reply to see what was picked and why.');
        return;
    }
    root.append(node('p', 'mewmory-caption', [{ complete: 'Done', needs_evidence: 'Needed more detail', uncertain: 'Unsure' }[run.status] || run.status,
        run.retrieval && !run.retrieval.aiSelection ? 'Ranked retrieval' : run.fallbackUsed ? 'Picked by Recall fallback' : 'Picked by Recall selector',
        new Date(run.at).toLocaleString()].join(' · ')));
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
            item.append(node('strong', '', (entry.relevanceType || candidate?.kind || 'Candidate').replaceAll('_', ' ')),
                node('p', 'mewmory-prose', entry.justification));
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
            row.append(node('strong', '', candidate?.sourceName || candidate?.kind || 'Neighbouring passage'), node('p', 'mewmory-caption', id));
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
            check('AI-controlled character', record.isCharacter, value => { record.isCharacter = value; }),
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
    return text.replaceAll('Hide messages beyond, tokens', 'Hide older messages when the visible chat reaches, tokens');
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
    }
    if (!missing.length) {
        if (!Number.isSafeInteger(draft.recentMessages) || draft.recentMessages < 1 || draft.recentMessages > 100000) return 'Keep at least this many recent messages must be between 1 and 100000.';
        if (!Number.isSafeInteger(draft.historyBatchMessages) || draft.historyBatchMessages < 1 || draft.historyBatchMessages > 10000) return 'Remove older chat in groups of must be between 1 and 10000.';
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
        || ['historyMode', 'recentMessages', 'historyBatchMessages', 'historyCatchUp'].some(key => expected[key] !== undefined && saved?.[key] !== expected[key])
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
    const settings = section('Memory updates');
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
    budgets.append(configField('Choose recent chat by', draft.historyMode, value => { draft.historyMode = value; render(); }, {
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
        };
        budgets.append(configField('Keep at least this many recent messages', draft.recentMessages, value => { draft.recentMessages = value; updateExample(); }, {
            type: 'number', key: 'recent-messages', hint: 'Include these messages in full with each reply. User messages and character replies count separately.',
        }), configField('Remove older chat in groups of', draft.historyBatchMessages, value => { draft.historyBatchMessages = value; updateExample(); }, {
            type: 'number', key: 'history-batch-messages', hint: 'Let extra messages accumulate, then leave out this many older messages together after they are remembered. This does not delay memory updates.',
        }));
        updateExample();
        budgets.append(example);
    } else {
        budgets.append(configField('Recent chat allowance, tokens', draft.historyWindow, value => { draft.historyWindow = value; }, {
            type: 'number', key: 'history-window', hint: 'Keep roughly this much original chat text. Character references, recalled memories and the rest of your prompt need additional room. Older chat stays until remembered.',
        }));
    }
    budgets.append(configField('Space for recalled memories, tokens', draft.memoryTokens, value => { draft.memoryTokens = value; }, {
        type: 'number', key: 'memory-tokens', hint: 'Maximum space for selected memories and original passages. Active character references need additional room.',
    }), configField('Maximum messages per memory request', draft.batchMessages, value => { draft.batchMessages = value; }, {
        type: 'number', key: 'batch-messages', hint: 'Read up to this many messages together when updating facts and character perspectives. A request can contain fewer. This does not set the recent-message window.',
    }), configField('Search matches considered for recall', draft.candidateLimit, value => { draft.candidateLimit = value; }, {
        type: 'number', key: 'candidate-limit', hint: 'How many possible matches to consider before choosing what helps the next reply.',
    }), configField('Token counter for replies', draft.writerTokenizer, value => { draft.writerTokenizer = value; }, {
        options: tokenizers, key: 'writer-tokenizer', hint: 'Match the model that writes replies. Auto follows the app setting. Counts can differ from your provider.',
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
                type: 'number', key: 'auto-hide-tokens', hint: 'At this size, hide older visible messages together. Keep the latest character reply and anything after it.',
            }));
    }
    root.append(settings);
    const retrieval = section('Finding relevant memories');
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
    root.append(retrieval);
    const model = section('Models used by Mewmory');
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
        configField('OpenAI-compatible endpoint', role.endpoint, value => { role.endpoint = value; }, { hint: 'For example: http://127.0.0.1:8000/v1', key: 'endpoint-' + ui.role }),
        configField('Model', role.model, value => { role.model = value; render(); }, { key: 'model-' + ui.role }),
        configField('API key', role.apiKey || '', value => { role.apiKey = value; }, { type: 'password', hint: role.hasKey ? 'A key is saved. Leave blank to keep it.' : 'Stored in the server’s protected credentials.', key: 'api-key-' + ui.role }),
    );
    const usedProfileId = usesShared ? draft.sharedProfileId : role.profileId;
    const usedOverride = usesShared ? draft.sharedModelOverride : role.modelOverride;
    const modelName = usedProfileId ? usedOverride || selectedProfile?.model : role.model;
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
    root.append(model);
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

function renderHealth(root) {
    const view = mewmory.view;
    if (!view) return;
    const health = section('Progress');
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
    actions.append(button('Update memories for the whole chat', () => processMewmory({ all: true }), { disabled: mewmory.busy || !view.enabled }),
        button('Review for missed details', () => processMewmory({ all: true, checkpoint: true }), { disabled: mewmory.busy || !view.enabled }),
        button('Rebuild meaning search', () => act(scope => requestMewmory('index', { reset: true }, { scope })),
            { disabled: !mewmory.config.roles.embedding.enabled || mewmory.busy }),
        button(mewmory.config.historyMode === 'messages' ? 'Hide messages outside the recent window' : 'Hide old messages at the token threshold', () => act(() => hideOverflowMessages())));
    health.append(node('p', 'mewmory-caption', 'Updating the whole chat includes recent messages and can make paid model requests. Reviewing missed details does not create a running story summary.'));
    if (mewmory.busy) actions.append(button('Stop updating', stopMewmoryBackfill));
    health.append(actions);
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
    const usage = node('dl', 'mewmory-tokens');
    for (const [role, total] of Object.entries(view.health.usage)) {
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

function renderTransfers(root, recover = false) {
    const archive = section('Export and restore');
    archive.append(node('p', 'mewmory-caption', 'Exports contain the story text and memories, but no API keys or passwords. Restoring checks every memory against the chat as it is now.'));
    const transfers = node('div', 'mewmory-actions');
    if (!recover) transfers.append(button('Export Mewmory', () => act(async () => {
        const data = await requestMewmory('export');
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'Mewmory-' + getMewmoryLocator().chat.replace(/[^\p{L}\p{N}_-]/gu, '-') + '.json';
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, { refresh: false })));
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
            const backup = JSON.parse(await selected.text());
            const review = await requestMewmory('restore', { locator, backup, revision, recover }, { scope });
            ui.restore = { backup, review, recover };
        }, { refresh: false });
    });
    upload.append(file);
    transfers.append(upload);
    archive.append(transfers);
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
    archive.append(node('p', 'mewmory-caption', 'Deleting a message also removes the memories based on it. Chat backups and downloaded exports are not affected.'));
    root.append(archive);
}

function render() {
    const root = ui.root;
    if (!root) return;
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
        ui.progress = '';
        ui.running = false;
    }
    root.replaceChildren();
    const heading = node('header', 'mewmory-heading');
    const locator = getMewmoryLocator();
    heading.append(node('p', 'mewmory-caption mewmory-scope', locator?.chat || 'No Roleplay chat selected'),
        button('Refresh', () => act(() => refreshMewmory(filters()), { refresh: false })));
    const restoration = mewmory.view?.visibilityRestore;
    const restoreMessage = restoration?.status === 'pending' ? 'Turning off Mewmory and showing its hidden messages…'
        : restoration?.status === 'failed' ? 'Mewmory is off, but some messages could not be shown. Retry restoration.'
            : restoration?.status === 'complete' && !mewmory.view?.enabled ? restoration.restored
                ? 'Mewmory is off. Restored ' + restoration.restored + ' hidden messages.' : 'Mewmory is off. No messages needed restoring.' : '';
    const status = node('p', 'mewmory-status', mewmory.error || restoreMessage || (mewmory.loading ? 'Loading this chat’s memory…' : mewmory.busy || mewmory.preparing ? 'Updating memories…'
        : mewmory.view?.enabled ? mewmory.config?.roles.extractor.enabled
            ? mewmory.view.health?.pending ? 'Messages are waiting for a memory update.' : 'Up to date'
            : 'Facts and events is switched off. Original passages remain searchable.' : 'Off'));
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.dataset.error = String(Boolean(mewmory.error));
    heading.append(status);
    root.append(heading);
    if (mewmory.view) {
        root.append(check('Use Mewmory in this chat', mewmory.view.enabled, enabled => act(async () => {
            await changeMewmory('enabled', { enabled });
            window.dispatchEvent(new Event('mewmory:configured'));
        }), ['pending', 'failed'].includes(restoration?.status)), node('p', 'mewmory-caption', 'Turning this off shows messages hidden by Mewmory. Messages you hid yourself stay hidden. Saved memories are kept.'));
        if (restoration?.status === 'failed') root.append(button('Retry restoration', () => act(() => retryMewmoryVisibilityRestore())));
    }
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
    root.append(navigation);
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
            if (locator && mewmory.error && !mewmory.loading) renderTransfers(page, true);
        } else {
            ({ now: renderNow, pawspective: renderPawspective, archive: renderArchive, recall: renderRecall, settings: renderSettings })[id](page);
            renderEditor(page);
            renderSource(page);
        }
    }
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
        style.href = 'css/mewmory.css?v=20261024a';
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
        window.addEventListener('mewmory:updated', render);
    }
    render();
    await act(() => refreshMewmory(filters()), { refresh: false });
    notifyMewmory();
}
