import {
    changeMewmory, getMewmoryLocator, getMewmoryScope, hideOverflowMessages, initMewmory, mewmory, notifyMewmory,
    processMewmory, refreshMewmory, requestMewmory, stopMewmoryBackfill,
} from './index.js';
import { getFriendlyTokenizerName } from '../tokenizers.js';
import { uuidv4 } from '../utils.js';
import { dismissJob, retryJob } from '../jobs.js';
import { PREFIX_PRESETS, RAG_DEFAULTS } from './rag-settings.js';

const tabs = [['now', 'Now'], ['pawspective', 'Pawspective'], ['archive', 'Archive'], ['recall', 'Recall'], ['settings', 'Settings']];
const kinds = { entity: 'NPC or entity reference', state: 'Current state', event: 'Event', relationship: 'Relationship fact',
    knowledge: 'Character knowledge', commitment: 'Promise or unresolved matter', interview: 'Pawspective interview', overview: 'Current subject view' };
const roles = { extractor: 'Facts and events', pawspective: 'Pawspective interviews', embedding: 'Embeddings', selector: 'Recall selector', fallback: 'Recall fallback' };
const SWITCHES = ['enableNewChats', 'autoUpdate', 'localOnly', 'excludeHistory', 'autoHide'];
const tokenizers = ['auto', 'o200k_base', 'cl100k_base', 'gpt2', 'llama', 'llama3', 'mistral', 'gemma', 'claude', 'qwen2', 'deepseek', 'nemo', 'jamba', 'yi'];
const ui = { root: null, tab: 'now', owner: '', subject: '', significance: '', status: '', kind: 'objective', query: '', offset: 0,
    source: null, editor: null, draft: null, savedDraft: '', configError: '', role: 'extractor', restore: null, matches: null,
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

function field(label, value, onChange, { type = 'text', multiline = false, options = null, key = label, hint = '', disabled = false } = {}) {
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
    control.addEventListener(options ? 'change' : 'input', () => onChange(type === 'number' ? Number(control.value) : control.value));
    const caption = node('label', '', label);
    caption.htmlFor = control.id;
    wrapper.append(caption, control);
    if (hint) wrapper.append(node('small', 'mewmory-caption', hint));
    return wrapper;
}

function check(label, checked, onChange, disabled = false) {
    const wrapper = node('label', 'mewmory-check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    input.disabled = disabled || ui.running;
    input.addEventListener('change', () => onChange(input.checked));
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
    const block = section('Memories sent with the next reply');
    block.append(node('p', 'mewmory-caption', mewmory.view.previewCurrent
        ? 'This text is added to the next reply. Why each memory was picked is shown in Recall.'
        : 'This preview is out of date. Preview again to refresh it.'));
    const counts = node('dl', 'mewmory-tokens');
    for (const [label, value] of [['NPC details, tokens', preview.tokens?.npc], ['Picked memories, tokens', preview.tokens?.memory],
        ['Recent chat kept, tokens', preview.history?.retainedTokens]]) {
        if (value !== undefined) counts.append(node('dt', '', label), node('dd', '', Number(value).toLocaleString()));
    }
    block.append(counts, node('pre', 'mewmory-prompt', [preview.npcText, preview.memoryText].filter(Boolean).join('\n\n') || 'No older memories were picked.'));
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
    if (run.omitted?.length) root.append(node('p', 'mewmory-caption', run.omitted.length + ' memories did not fit in Selected memory budget, tokens.'));
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

function resetSettingsDraft(config = mewmory.config) {
    ui.draft = structuredClone(config);
    ui.draft.retrieval = { ...RAG_DEFAULTS, ...ui.draft.retrieval };
    ui.savedDraft = JSON.stringify(ui.draft);
}

function updateSettingsStatus() {
    const status = document.getElementById('mewmory-settings-status');
    if (!status || !ui.draft) return;
    const changed = JSON.stringify(ui.draft) !== ui.savedDraft;
    status.textContent = ui.configError ? 'Not saved: ' + ui.configError
        : ui.draft.revision !== mewmory.config.revision ? 'Settings were saved elsewhere. Discard your unsaved settings to load them before editing again.'
            : changed ? 'Unsaved changes. Mewmory still uses the saved configuration.'
                : ui.draft.revision ? 'Configuration saved.' : 'No model configuration saved yet.';
    status.dataset.error = String(Boolean(ui.configError));
}

// A server still running older code drops switches it does not know and saves the rest.
function confirmSavedSwitches(saved, expected) {
    if (SWITCHES.some(key => typeof expected[key] === 'boolean' && saved?.[key] !== expected[key])) {
        throw new Error('Neconyan was updated but is still running the old version. Restart Neconyan, then try again.');
    }
}

function saveSwitch(key, value) {
    const edited = JSON.stringify(ui.draft) !== ui.savedDraft;
    const previous = ui.draft[key];
    ui.draft[key] = value;
    return act(async () => {
        try {
            const saved = await changeMewmory('config/save', { config: { ...mewmory.config, [key]: value } });
            confirmSavedSwitches(saved.config, { [key]: value });
            const draft = ui.draft;
            resetSettingsDraft(saved.config);
            if (edited) ui.draft = { ...draft, [key]: value, revision: saved.config.revision };
            ui.configError = '';
            window.dispatchEvent(new Event('mewmory:configured'));
        } catch (error) {
            ui.draft[key] = previous;
            if (!edited) resetSettingsDraft();
            ui.configError = error.message;
            throw error;
        }
    }, { refresh: false });
}

function renderSettings(root) {
    if (mewmory.config && (!ui.draft || JSON.stringify(ui.draft) === ui.savedDraft)) resetSettingsDraft();
    const draft = ui.draft;
    if (!draft) return;
    const settings = section('Automatic memory');
    settings.dataset.mewmoryTour = 'automatic';
    settings.append(node('p', 'mewmory-caption', 'Model roles are shared by all your chats; turning Mewmory on is per chat. These models are set up separately from the model that writes replies.'),
        check('Turn on Mewmory in every new chat', draft.enableNewChats, value => saveSwitch('enableNewChats', value)),
        check('Update automatically during play', draft.autoUpdate, value => saveSwitch('autoUpdate', value)),
        check('Only use models on this computer', draft.localOnly, value => saveSwitch('localOnly', value)),
        check('Leave out older chat that Mewmory has already remembered', draft.excludeHistory, value => saveSwitch('excludeHistory', value)),
        check('Hide old messages automatically', draft.autoHide, value => saveSwitch('autoHide', value)));
    const budgets = node('div', 'mewmory-fields');
    budgets.append(
        field('Hide messages beyond, tokens', draft.autoHideTokens, value => { draft.autoHideTokens = value; }, { type: 'number', hint: 'With automatic hiding on, older messages past this size are hidden after each reply. Mewmory still remembers them.' }),
        field('Recent chat target, tokens', draft.historyWindow, value => { draft.historyWindow = value; }, { type: 'number', hint: 'Chat only. NPC references, selected memory and the rest of your prompt need additional room.' }),
        field('Selected memory budget, tokens', draft.memoryTokens, value => { draft.memoryTokens = value; }, { type: 'number' }),
        field('Messages per update', draft.batchMessages, value => { draft.batchMessages = value; }, { type: 'number', hint: 'Smaller batches use less space in the Facts and events model.' }),
        field('Recall candidates', draft.candidateLimit, value => { draft.candidateLimit = value; }, { type: 'number' }),
        field('Writer tokenizer', draft.writerTokenizer, value => { draft.writerTokenizer = value; }, { options: tokenizers, hint: 'Counts tokens, the units models measure text in. Auto follows the app’s own setting; pick one yourself if your service only gives rough estimates.' }),
    );
    settings.append(budgets);
    root.append(settings);
    const retrieval = section('Search and passages');
    const rag = draft.retrieval;
    retrieval.append(node('p', 'mewmory-caption', 'Retrieval finds relevant saved text for the writer. Current replies use quick local search and completed recall; fresh meaning search and AI selection run in the background.'));
    const ragFields = node('div', 'mewmory-fields');
    ragFields.append(field('Retrieval method', rag.mode, value => { rag.mode = value; }, { options: [['hybrid', 'Keywords and meaning'], ['keyword', 'Keywords'], ['semantic', 'Meaning, with keyword recovery']] }));
    for (const [key, label, hint] of [
        ['chunkSize', 'Passage size, characters', 'Maximum size. Splitting prefers paragraphs, lines and words.'],
        ['chunkOverlap', 'Passage overlap, characters', 'Repeated context between passages; less than half the passage size. Repeated text is removed from the final prompt.'],
        ['queryMessages', 'Recent messages to search with', 'Between 1 and 12 accepted messages.'],
        ['semanticWeight', 'Meaning weight, 0 to 1', 'Hybrid search only: 0 favours keywords, 1 favours meaning.'],
        ['minSimilarity', 'Minimum meaning similarity, 0 to 1', 'Raise this to demand closer matches. Scores are not confidence percentages.'],
        ['resultLimit', 'Maximum selected results', 'Before neighbouring passages are added. Pinned memories are always considered.'],
        ['maxPerSource', 'Maximum matches per source', 'Keeps a long file from filling every candidate position.'],
        ['neighbourChunks', 'Neighbouring passages, each side', '0 to 2. Adds nearby original text within the memory budget.'],
        ['batchSize', 'Passages per embedding request', '1 to 10. Provider limits may lower this further.'],
    ]) ragFields.append(field(label, rag[key], value => { rag[key] = value; }, { type: 'number', key: 'rag-' + key, hint }));
    retrieval.append(ragFields, check('Search attached files and the Data Bank', rag.includeFiles, value => { rag.includeFiles = value; }),
        node('p', 'mewmory-caption', 'Only files attached to this account, character or chat are searched. File passages are references for the writer, not knowledge automatically given to characters. Allow file access separately for each model role.'));
    root.append(retrieval);
    const model = section('Model roles');
    model.dataset.mewmoryTour = 'models';
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
    roleForm.append(node('legend', '', roles[ui.role]), check('Enable this role', role.enabled, value => { role.enabled = value; }));
    const fields = node('div', 'mewmory-fields');
    const native = ui.role === 'embedding' && role.provider === 'native';
    if (ui.role === 'embedding') fields.append(field('Embedding connection', role.provider || 'custom', value => {
        role.provider = value; render();
    }, { key: 'embedding-provider', options: [['custom', 'Mewmory connection'], ['native', 'Use native Vectorization']],
        hint: 'Native mode follows Vectorization’s saved provider, model, credentials and prefixes. Its server providers work even when Vectorization chat retrieval is off.' }));
    if (native) roleForm.append(node('p', 'mewmory-caption', role.native
        ? 'Saved Vectorization connection: ' + role.native.source + ' · ' + (role.native.model || 'server default')
        : 'Save this configuration to resolve the current Vectorization connection. Configure its provider and prefixes in Included tools > Vectorization.'));
    const profiles = (mewmory.config.profiles || []).filter(profile => ui.role !== 'embedding' || profile.embeddings);
    const selectedProfile = profiles.find(profile => profile.id === role.profileId);
    if (!native) fields.append(field('Connection profile', role.profileId || '', value => {
        role.profileId = value;
        const profile = profiles.find(profile => profile.id === value);
        role.model = profile?.model || '';
        role.modelOverride = '';
        render();
    }, { options: [['', 'Manual endpoint'], ...profiles.map(profile => [profile.id, profile.name]),
        ...(role.profileId && !selectedProfile ? [[role.profileId, 'Unavailable saved profile']] : [])], key: 'profile-' + ui.role,
    hint: 'Uses the saved profile’s model and server-side credentials. Embeddings need an OpenAI-compatible profile.' }));
    if (!native && role.profileId) fields.append(field(selectedProfile?.model ? 'Model override, optional' : 'Model', role.modelOverride || '', value => {
        role.modelOverride = value;
        render();
    }, { key: 'model-override-' + ui.role, hint: selectedProfile?.model
        ? 'Leave blank to use the profile’s model: ' + selectedProfile.model
        : 'This profile has no saved model. Enter the model name provided by your service.' }));
    if (!native && !role.profileId) fields.append(
        field('OpenAI-compatible endpoint', role.endpoint, value => { role.endpoint = value; }, { hint: 'For example: http://127.0.0.1:8000/v1', key: 'endpoint-' + ui.role }),
        field('Model', role.model, value => { role.model = value; render(); }, { key: 'model-' + ui.role }),
        field('API key', role.apiKey || '', value => { role.apiKey = value; }, { type: 'password', hint: role.hasKey ? 'A key is saved. Leave blank to keep it.' : 'Stored in the server’s protected credentials.', key: 'api-key-' + ui.role }),
    );
    const modelName = role.profileId ? role.modelOverride || selectedProfile?.model : role.model;
    const savedRole = mewmory.config.roles[ui.role];
    if (savedRole.error && role.profileId === savedRole.profileId) roleForm.append(node('p', 'mewmory-error', savedRole.error));
    const autoTokenizer = role.profileId && !role.modelOverride ? selectedProfile?.autoTokenizer
        : modelName === savedRole.model ? savedRole.autoTokenizer : '';
    fields.append(
        field('Model revision, optional', role.modelRevision, value => { role.modelRevision = value; }, { key: 'revision-' + ui.role }),
        field('Context limit, tokens', role.contextTokens, value => { role.contextTokens = value; }, { type: 'number', key: 'context-' + ui.role,
            hint: 'Tokens are pieces of text counted by the model. Each role has its own limit. Set this to what your model service supports; changing it does not increase the model’s actual limit.' }),
        field('Output limit, tokens', role.maxOutputTokens, value => { role.maxOutputTokens = value; }, { type: 'number', disabled: ui.role === 'embedding', key: 'output-' + ui.role,
            hint: ui.role === 'embedding' ? '' : 'Space reserved for the reply. A larger value leaves less room for the request.' }),
        field('Timeout, seconds', role.timeoutMs / 1000, value => { role.timeoutMs = value * 1000; }, { type: 'number', key: 'timeout-' + ui.role }),
        field('Tokenizer for this role', role.tokenizer, value => { role.tokenizer = value; render(); }, {
            options: tokenizers.map(value => value === 'auto' ? ['auto', 'Auto (match this model)'] : value), key: 'tokenizer-' + ui.role,
            hint: role.tokenizer === 'auto' ? (autoTokenizer ? 'Auto uses ' + autoTokenizer + '.' : 'Save the model settings to see Auto’s local tokenizer match.')
                + ' Counts are approximate. Choose a tokenizer manually if your provider uses a different one.' : '',
        }),
    );
    if (ui.role === 'embedding') {
        if (!native) fields.append(field('Prefix preset', '', value => {
            const preset = PREFIX_PRESETS[Number(value)];
            if (!preset || value === '') return;
            role.queryPrefix = preset.query; role.documentPrefix = preset.document; render();
        }, { options: [['', 'Choose a preset'], ...PREFIX_PRESETS.map((preset, index) => [String(index), preset.label])],
            hint: 'Use the prefix recommended by your embedding model. Leading spaces, trailing spaces and line breaks are kept exactly.' }));
        fields.append(field('Query prefix, optional', native ? role.native?.queryPrefix || '' : role.queryPrefix, value => { role.queryPrefix = value; }, { multiline: true, disabled: native }),
            field('Document prefix, optional', native ? role.native?.documentPrefix || '' : role.documentPrefix, value => { role.documentPrefix = value; }, { multiline: true, disabled: native }));
    }
    roleForm.append(fields, check('Allow sending story data to a service on another computer', role.allowRemote, value => { role.allowRemote = value; }));
    if (!native && !role.profileId) roleForm.append(check('Remove the saved API key when saving', role.clearKey, value => { role.clearKey = value; }));
    const scope = section('This role may read');
    scope.dataset.mewmoryTour = 'permissions';
    for (const [type, label] of [['chat', 'Chat messages'], ['character', 'Character cards'], ['lore', 'Enabled lore'], ['memory', 'Saved memories'], ['file', 'Attached files and Data Bank']]) {
        scope.append(check(label, role.allowedData.includes(type), checked => {
            role.allowedData = role.allowedData.filter(item => item !== type);
            if (checked) role.allowedData.push(type);
        }));
    }
    roleForm.append(scope);
    model.append(roleForm, node('p', 'mewmory-caption', 'Recall selector and Recall fallback only pick from memories that already exist. Only use models on this computer applies to every role. Embeddings are optional; keyword search always works.'));
    root.append(model);
    const actions = node('div', 'mewmory-actions');
    actions.append(button('Save configuration', () => act(async () => {
        try {
            const saved = await changeMewmory('config/save', { config: ui.draft });
            confirmSavedSwitches(saved.config, ui.draft);
            resetSettingsDraft(saved.config);
            ui.configError = '';
            window.dispatchEvent(new Event('mewmory:configured'));
        } catch (error) {
            ui.configError = error.message;
            throw error;
        }
    }), { primary: true }), button('Discard unsaved settings', () => { resetSettingsDraft(); ui.configError = ''; render(); }));
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
    health.append(progress, node('p', 'mewmory-caption', view.health.pending + ' messages waiting to be remembered. '
        + (view.health.preservedThrough >= 0 ? 'Messages 1 to ' + (view.health.preservedThrough + 1) + ' are fully remembered, so they can be left out of the prompt.'
            : 'No messages are fully remembered yet.')),
    node('p', 'mewmory-caption', 'Search: ' + (view.health.indexStatus === 'lexical' ? 'keyword search only'
        : view.health.indexStatus === 'ready' ? 'meaning search (embeddings) and keyword search ready' : 'building meaning search (embeddings); keyword search works meanwhile')
        + (view.health.indexVersion ? ' · index ' + view.health.indexVersion.slice(0, 12) : '')),
    node('p', 'mewmory-caption', 'Older messages stay saved and searchable. If the memories plus recent chat cannot fit the writing model, the reply stops with an error instead of dropping them.'),
    node('p', 'mewmory-caption', 'Hide old messages that no longer fit: counts back from the latest reply using your context size and hides everything older from the prompt. Mewmory still remembers them.'));
    const actions = node('div', 'mewmory-actions');
    actions.append(button('Catch up on this whole chat', () => processMewmory({ all: true }), { disabled: mewmory.busy || !view.enabled }),
        button('Check for missed details', () => processMewmory({ all: true, checkpoint: true }), { disabled: mewmory.busy || !view.enabled }),
        button('Rebuild search index', () => act(scope => requestMewmory('index', { reset: true }, { scope })),
            { disabled: !mewmory.config.roles.embedding.enabled || mewmory.busy }),
        button('Hide old messages that no longer fit', () => act(() => hideOverflowMessages())));
    if (mewmory.busy) actions.append(button('Stop updating', stopMewmoryBackfill));
    health.append(actions);
    if (view.operationsError) health.append(node('p', 'mewmory-caption', view.operationsError));
    for (const job of view.operations || []) {
        health.append(node('p', 'mewmory-caption', job.label + ' · ' + job.state + (job.error?.message ? ': ' + job.error.message : job.warning ? ': ' + job.warning : '')));
        if (['failed', 'interrupted'].includes(job.state)) health.append(button('Retry ' + job.label.toLocaleLowerCase(), () => act(() => retryJob(job.id))));
        if (['failed', 'interrupted', 'completed', 'cancelled'].includes(job.state)) health.append(button('Dismiss ' + job.label.toLocaleLowerCase(), () => act(() => dismissJob(job.id))));
    }
    if (view.health.jobs.length) health.append(node('h4', '', 'Recent updates'));
    for (const job of view.health.jobs.slice(-5).reverse()) {
        health.append(node('p', 'mewmory-caption', (job.checkpoint ? 'Missed-details check' : 'Memory update') + ', messages '
            + (job.from + 1) + ' to ' + (job.through + 1) + ': '
            + ({ processing: 'running', complete: 'done', failed: 'didn’t finish' }[job.status] || job.status)
            + (job.error ? '. ' + job.error : '')
            + (job.skipped ? '. ' + job.skipped + (job.skipped === 1 ? ' detail the model got wrong was' : ' details the model got wrong were')
                + ' left out' + (job.skippedReasons?.length ? ', for example: ' + job.skippedReasons[0] : '.') : '')));
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
    const status = node('p', 'mewmory-status', mewmory.error || (mewmory.loading ? 'Loading this chat’s memory…' : mewmory.busy || mewmory.preparing ? 'Updating memories…'
        : mewmory.view?.enabled ? mewmory.config?.roles.extractor.enabled ? 'Up to date' : 'Facts and events is switched off. Original passages remain searchable.' : 'Off'));
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.dataset.error = String(Boolean(mewmory.error));
    heading.append(status);
    root.append(heading);
    if (mewmory.view) {
        root.append(check('Use Mewmory in this chat', mewmory.view.enabled, enabled => act(async () => {
            await changeMewmory('enabled', { enabled });
            window.dispatchEvent(new Event('mewmory:configured'));
        })));
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
        style.href = 'css/mewmory.css?v=20260926c';
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
