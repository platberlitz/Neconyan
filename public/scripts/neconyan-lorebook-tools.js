import { eventSource, event_types, getRequestHeaders } from '../script.js';
import { renderTemplateAsync } from './templates.js';
import { debounce, download } from './utils.js';
import {
    convertCharacterBook, flushWorldInfoEditor, getWorldInfoEditorSnapshot, loadWorldInfo,
    replaceWorldInfoData, restoreWorldInfoCommit, selectWorldInfoEntry, showWorldEditor, world_names,
} from './world-info.js';
import {
    delimitLorebook, exportLorebookProject, lorebookChanges, lorebookDigest, lorebookEntryTitle,
    lorebookMergeCandidates, lorebookToCharacterBook, mergeLorebooks, parseLorebookImport,
    searchReplaceLorebook, serializeLorebook,
} from './neconyan-lorebook-tools-core.js';

function node(tag, text = '', className = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
}

function button(text, action) {
    const element = node('button', text, 'menu_button');
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
}

async function historyRequest(name, options = {}) {
    const response = await fetch('/api/worldinfo/history', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name, ...options }),
    });
    if (!response.ok) throw new Error(`World Info save failed with status ${response.status}`);
    return response.json();
}

function renderDiff(host, changes) {
    host.replaceChildren();
    if (!changes.length) {
        host.append(node('p', 'No changes'));
        return;
    }
    const controls = node('div', '', 'neco-lore-diff-controls');
    const select = node('select', '', 'text_pole');
    select.setAttribute('aria-label', 'Changes');
    for (const [index, change] of changes.entries()) select.add(new Option(`${index + 1}. ${change.title}${change.matches === undefined ? '' : ` (${change.matches})`}`, String(index)));
    const previous = button('Previous change', () => { select.selectedIndex--; render(); });
    const next = button('Next change', () => { select.selectedIndex++; render(); });
    const counter = node('span');
    counter.setAttribute('aria-live', 'polite');
    controls.append(previous, select, next, counter);
    const diff = node('div', '', 'neco-lore-diff');
    const before = node('pre');
    const after = node('pre');
    for (const [label, pre] of [['Before', before], ['After', after]]) {
        const column = node('div');
        pre.tabIndex = 0;
        pre.setAttribute('aria-label', label);
        column.append(node('strong', label), pre);
        diff.append(column);
    }
    host.append(controls, diff);
    select.addEventListener('change', render);
    function render() {
        const index = select.selectedIndex;
        const change = changes[index];
        previous.disabled = index === 0;
        next.disabled = index === changes.length - 1;
        counter.textContent = `${index + 1} / ${changes.length}`;
        before.replaceChildren();
        after.replaceChildren();
        const left = change.before === undefined ? '' : JSON.stringify(change.before, null, 2);
        const right = change.after === undefined ? '' : JSON.stringify(change.after, null, 2);
        if (!globalThis.diff_match_patch) {
            before.textContent = left;
            after.textContent = right;
            return;
        }
        const engine = new globalThis.diff_match_patch();
        engine.Diff_Timeout = 0.2;
        const chunks = engine.diff_main(left, right);
        engine.diff_cleanupSemantic(chunks);
        for (const [kind, text] of chunks) {
            if (kind <= 0) before.append(node(kind < 0 ? 'del' : 'span', text));
            if (kind >= 0) after.append(node(kind > 0 ? 'ins' : 'span', text));
        }
    }
    render();
}

export async function mountLorebookTools(root) {
    if (root.dataset.lorebookTools) return;
    root.dataset.lorebookTools = 'loading';
    try {
        const template = document.createElement('template');
        template.innerHTML = await renderTemplateAsync('neconyanLorebookTools');
        const panel = template.content.firstElementChild;
        root.querySelector('#world_popup_workspace').before(panel);
        const workspace = root.querySelector('#world_popup_workspace');
        const status = panel.querySelector('.neco-lore-status');
        const histories = new Map();
        const visitedEntries = new Map();
        const previews = new Map();
        let state = null;
        let mode = '';
        let busy = false;
        let incoming = null;
        let selectedCommit = null;
        let opener = null;
        let generation = 0;
        let selectedUid = null;

        const historyButton = button('History', event => open('history', event.currentTarget));
        historyButton.id = 'neco-lore-history-button';
        historyButton.setAttribute('aria-controls', panel.id);
        root.querySelector('.world_popup_action_group--entry').append(historyButton);
        const tools = root.querySelector('.world_popup_action_group_details .world_popup_action_group_contents');
        for (const [toolMode, label] of [['search', 'Search & replace'], ['delimiters', 'Delimiters'], ['merge', 'Merge lorebook']]) {
            tools?.append(button(label, event => open(toolMode, event.currentTarget)));
        }

        const entryTabs = node('div', '', 'neco-lore-entry-tabs');
        entryTabs.setAttribute('role', 'tablist');
        entryTabs.setAttribute('aria-label', 'Entries');
        entryTabs.addEventListener('keydown', event => {
            if (event.target.getAttribute('role') !== 'tab') return;
            const tabs = [...entryTabs.querySelectorAll('[role="tab"]')];
            const index = tabs.indexOf(event.target);
            if (event.key === 'Delete') {
                event.preventDefault();
                event.target.nextElementSibling.click();
            } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                tabs[next].focus();
                tabs[next].click();
            }
        });
        root.querySelector('#world_popup_editor_header').after(entryTabs);
        const focus = button('Focus mode', () => {
            const active = focus.getAttribute('aria-pressed') !== 'true';
            focus.setAttribute('aria-pressed', String(active));
            workspace.classList.toggle('neco-lore-focus', active);
        });
        focus.classList.add('neco-lore-focus-button');
        focus.setAttribute('aria-pressed', 'false');
        root.querySelector('.world_popup_editor_actions').prepend(focus);

        function close(restoreFocus = true) {
            mode = '';
            panel.hidden = true;
            workspace.hidden = false;
            historyButton.setAttribute('aria-expanded', 'false');
            if (restoreFocus && opener?.isConnected) {
                // Apply releases its save lock before focus returns to the opening control.
                requestAnimationFrame(() => { if (panel.hidden) opener?.focus(); });
            }
        }

        async function run(action) {
            if (busy) return;
            busy = true;
            panel.inert = true;
            workspace.inert = true;
            historyButton.disabled = true;
            panel.setAttribute('aria-busy', 'true');
            status.textContent = 'Loading...';
            status.classList.remove('error');
            try {
                await action();
                status.textContent = '';
            } catch (error) {
                console.error('Lorebook tools:', error);
                status.textContent = String(error.message ?? error);
                status.classList.add('error');
                globalThis.toastr?.error(String(error.message ?? error), 'World Info Save Failed');
            } finally {
                busy = false;
                panel.inert = false;
                workspace.inert = false;
                panel.removeAttribute('aria-busy');
                historyButton.disabled = !getWorldInfoEditorSnapshot()?.data;
            }
        }

        async function prepare() {
            const editor = await flushWorldInfoEditor();
            if (!editor?.data) throw new Error('World Info file has an invalid format');
            const result = await historyRequest(editor.name, { includeBook: true });
            if (getWorldInfoEditorSnapshot()?.name !== editor.name) return false;
            state = { name: editor.name, data: result.data, ...result };
            histories.set(editor.name, result.history);
            updateDirty();
            return true;
        }

        function clearPreview(toolMode) {
            previews.delete(toolMode);
            panel.querySelector(`[data-apply="${toolMode}"]`).disabled = true;
            panel.querySelector(`[data-preview="${toolMode}"]`).replaceChildren();
        }

        function preview(toolMode, result) {
            previews.set(toolMode, result);
            renderDiff(panel.querySelector(`[data-preview="${toolMode}"]`), result.changes);
            panel.querySelector(`[data-apply="${toolMode}"]`).disabled = !result.changes.length;
        }

        function showMode(nextMode) {
            mode = nextMode;
            panel.hidden = false;
            workspace.hidden = true;
            historyButton.setAttribute('aria-expanded', String(mode === 'history'));
            for (const tab of panel.querySelectorAll('[data-mode]')) {
                const selected = tab.dataset.mode === mode;
                tab.setAttribute('aria-selected', String(selected));
                tab.tabIndex = selected ? 0 : -1;
                panel.querySelector(`#neco-lore-${tab.dataset.mode}`).hidden = !selected;
            }
        }

        async function open(nextMode, source = null) {
            if (busy || !getWorldInfoEditorSnapshot()?.data) return;
            if (source) opener = source;
            showMode(nextMode);
            await run(async () => {
                if (!await prepare()) { close(); return; }
                for (const toolMode of ['search', 'delimiters', 'merge']) clearPreview(toolMode);
                renderHistory();
                const scope = panel.querySelector('#neco-lore-delimiter-scope');
                const scopeValue = scope.value;
                scope.replaceChildren(new Option('All entries', ''));
                for (const [uid, entry] of Object.entries(state.data.entries)) scope.add(new Option(lorebookEntryTitle(entry), uid));
                scope.value = Object.hasOwn(state.data.entries, scopeValue) ? scopeValue : '';
                const book = panel.querySelector('#neco-lore-merge-book');
                const previous = book.value;
                book.replaceChildren(new Option('--- Pick a lorebook ---', ''));
                for (const name of world_names.filter(name => name !== state.name)) book.add(new Option(name, name));
                book.value = previous;
            });
            panel.querySelector(`[data-mode="${nextMode}"]`)?.focus();
        }

        function renderHistory() {
            const list = panel.querySelector('.neco-lore-history-list');
            const diff = panel.querySelector('.neco-lore-history-diff');
            const rollback = panel.querySelector('[data-rollback]');
            list.replaceChildren();
            selectedCommit = null;
            rollback.hidden = true;
            const head = state.history.commits.find(commit => commit.id === state.history.headCommitId);
            const changes = lorebookChanges(head?.snapshot, state.data);
            panel.querySelector('[data-commit]').disabled = Boolean(head) && !changes.length;
            const working = button('Uncommitted changes', () => {
                selectedCommit = null;
                rollback.hidden = true;
                for (const sibling of list.querySelectorAll('button')) sibling.setAttribute('aria-pressed', String(sibling === working));
                renderDiff(diff, changes);
            });
            list.append(working);
            if (!state.history.commits.length) list.append(node('p', 'No commits yet'));
            for (const commit of [...state.history.commits].reverse()) {
                const row = button('', () => {
                    selectedCommit = commit.id;
                    const parent = state.history.commits.find(item => item.id === commit.parentId);
                    renderDiff(diff, lorebookChanges(parent?.snapshot, commit.snapshot));
                    rollback.hidden = false;
                    rollback.disabled = serializeLorebook(state.data) === serializeLorebook(commit.snapshot);
                    for (const sibling of list.querySelectorAll('button')) sibling.setAttribute('aria-pressed', String(sibling === row));
                });
                row.append(node('strong', commit.message), node('small', `${commit.id.slice(0, 7)} · ${new Date(commit.timestamp).toLocaleString()}`));
                list.append(row);
            }
            renderDiff(diff, changes);
        }

        function updateDirty() {
            const editor = getWorldInfoEditorSnapshot();
            if (!editor?.data) { historyButton.disabled = true; entryTabs.replaceChildren(); return; }
            const history = histories.get(editor.name);
            const head = history?.commits.find(commit => commit.id === history.headCommitId);
            const changes = history ? lorebookChanges(head?.snapshot, editor.data) : [];
            historyButton.textContent = changes.length ? `History (${changes.length})` : 'History';
            historyButton.disabled = busy;
            const dirty = new Set(changes.map(change => change.uid));
            const tabs = visitedEntries.get(editor.name) ?? [];
            const liveTabs = tabs.filter(uid => Object.hasOwn(editor.data.entries, uid));
            visitedEntries.set(editor.name, liveTabs);
            const restoreTabFocus = entryTabs.contains(document.activeElement);
            entryTabs.replaceChildren();
            for (const uid of liveTabs) {
                const title = lorebookEntryTitle(editor.data.entries[uid]);
                const tab = button(`${title}${dirty.has(uid) ? ' *' : ''}`, () => void selectWorldInfoEntry(uid));
                // Host button roles and shell-navigation sizing must not override entry tabs.
                tab.className = 'neco-lore-tab';
                tab.dataset.uid = uid;
                tab.setAttribute('role', 'tab');
                tab.setAttribute('aria-selected', String(uid === String(selectedUid)));
                tab.setAttribute('aria-controls', 'world_popup_editor_host');
                tab.tabIndex = uid === String(selectedUid) ? 0 : -1;
                const remove = button('×', () => {
                    const remaining = liveTabs.filter(item => item !== uid);
                    visitedEntries.set(editor.name, remaining);
                    if (uid === String(selectedUid)) {
                        selectedUid = remaining.at(-1) ?? null;
                        void selectWorldInfoEntry(selectedUid);
                    }
                    updateDirty();
                });
                remove.setAttribute('aria-label', `Close ${title}`);
                const item = node('div', '', 'neco-lore-entry-tab');
                item.append(tab, remove);
                entryTabs.append(item);
            }
            if (restoreTabFocus) entryTabs.querySelector('[aria-selected="true"]')?.focus();
        }

        function setIncoming(book) {
            incoming = book;
            clearPreview('merge');
            const list = panel.querySelector('.neco-lore-merge-list');
            list.replaceChildren();
            for (const candidate of book ? lorebookMergeCandidates(state.data, book) : []) {
                const row = node('div', '', 'neco-lore-merge-row');
                const label = node('label', lorebookEntryTitle(candidate.incoming));
                const choice = node('select', '', 'text_pole');
                choice.id = `neco-lore-merge-choice-${candidate.uid}`;
                label.htmlFor = choice.id;
                choice.dataset.uid = candidate.uid;
                choice.add(new Option('Import as new', 'import'));
                if (candidate.local) choice.add(new Option(`Overwrite: ${lorebookEntryTitle(candidate.local)}`, 'overwrite'));
                choice.add(new Option('Skip', 'skip'));
                choice.value = candidate.local ? 'skip' : 'import';
                choice.addEventListener('change', () => clearPreview('merge'));
                const compare = button('Compare', () => renderDiff(panel.querySelector('[data-preview="merge"]'), [{
                    title: lorebookEntryTitle(candidate.incoming), before: candidate.local ?? undefined, after: candidate.incoming,
                }]));
                row.append(label, choice, compare);
                list.append(row);
            }
            panel.querySelector('[data-merge-preview]').disabled = !book || !Object.keys(book.entries).length;
        }

        panel.querySelector('[data-close]').addEventListener('click', close);
        for (const tab of panel.querySelectorAll('[data-mode]')) tab.addEventListener('click', () => void open(tab.dataset.mode));
        panel.querySelector('[role="tablist"]').addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const tabs = [...panel.querySelectorAll('[data-mode]')];
            const index = tabs.indexOf(event.target);
            if (index < 0) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            void open(tabs[next].dataset.mode);
        });

        panel.querySelector('.neco-lore-commit-form').addEventListener('submit', event => {
            event.preventDefault();
            const message = panel.querySelector('#neco-lore-commit-message').value.trim();
            if (!message) return;
            void run(async () => {
                if (!await prepare()) return;
                const result = await historyRequest(state.name, { action: 'commit', revision: state.revision, headCommitId: state.history.headCommitId, message });
                state = { ...state, ...result };
                histories.set(state.name, state.history);
                panel.querySelector('#neco-lore-commit-message').value = '';
                renderHistory();
                updateDirty();
            });
        });
        panel.querySelector('[data-rollback]').addEventListener('click', () => {
            if (!selectedCommit) return;
            void run(async () => {
                const name = state.name;
                const result = await restoreWorldInfoCommit(name, {
                    revision: state.revision, headCommitId: state.history.headCommitId, commitId: selectedCommit,
                });
                if (root.querySelector('#world_editor_select')?.selectedOptions[0]?.textContent !== name) return;
                state = { name, ...result };
                histories.set(name, result.history);
                await showWorldEditor(name);
                renderHistory();
                updateDirty();
            });
        });
        for (const toolMode of ['search', 'delimiters', 'merge']) {
            panel.querySelector(`[data-apply="${toolMode}"]`).addEventListener('click', () => void run(async () => {
                const result = previews.get(toolMode);
                if (!result?.changes.length) return;
                const name = state.name;
                await replaceWorldInfoData(name, result.book, state.revision);
                if (root.querySelector('#world_editor_select')?.selectedOptions[0]?.textContent !== name) return;
                await showWorldEditor(name);
                if (!await prepare()) return;
                clearPreview(toolMode);
                close();
            }));
        }

        const searchForm = panel.querySelector('.neco-lore-search-form');
        searchForm.addEventListener('input', () => clearPreview('search'));
        searchForm.addEventListener('submit', event => {
            event.preventDefault();
            void run(async () => {
                const form = new FormData(searchForm);
                const fields = form.getAll('field');
                if (fields.includes('comment')) fields.push('name');
                preview('search', searchReplaceLorebook(state.data, {
                    search: String(form.get('search')), replacement: String(form.get('replacement')), fields,
                    regex: form.has('regex'), wholeWord: form.has('wholeWord'), caseSensitive: form.has('caseSensitive'),
                }));
            });
        });
        const delimiterForm = panel.querySelector('.neco-lore-delimiter-form');
        delimiterForm.addEventListener('input', () => {
            clearPreview('delimiters');
            panel.querySelector('#neco-lore-delimiter-name').disabled = panel.querySelector('#neco-lore-delimiter-source').value !== 'fixed';
        });
        delimiterForm.addEventListener('submit', event => {
            event.preventDefault();
            void run(async () => {
                const values = new FormData(delimiterForm);
                preview('delimiters', delimitLorebook(state.data, {
                    style: values.get('delimiterStyle'), name: values.get('delimiterName') ?? '',
                    nameSource: values.get('nameSource'), uid: values.get('uid'),
                }));
            });
        });
        panel.querySelector('#neco-lore-merge-book').addEventListener('change', event => {
            const name = event.target.value;
            setIncoming(null);
            panel.querySelector('#neco-lore-merge-file').value = '';
            if (name) void run(async () => {
                const book = await loadWorldInfo(name);
                if (!book) throw new Error('World Info file has an invalid format');
                setIncoming(book);
            });
        });
        panel.querySelector('#neco-lore-merge-file').addEventListener('change', event => {
            const file = event.target.files?.[0];
            setIncoming(null);
            panel.querySelector('#neco-lore-merge-book').value = '';
            if (file) void run(async () => {
                const result = parseLorebookImport(JSON.parse(await file.text()), convertCharacterBook);
                setIncoming(result.book);
            });
        });
        panel.querySelector('[data-merge-preview]').addEventListener('click', () => void run(async () => {
            if (!incoming) return;
            const choices = Object.fromEntries([...panel.querySelectorAll('.neco-lore-merge-list select')].map(select => [select.dataset.uid, select.value]));
            preview('merge', mergeLorebooks(state.data, incoming, choices));
        }));
        for (const action of panel.querySelectorAll('[data-export]')) action.addEventListener('click', () => void run(async () => {
            if (!await prepare()) return;
            const { name, data, history } = state;
            if (action.dataset.export === 'digest') {
                download(lorebookDigest(name, data), `${name}.md`, 'text/markdown');
                return;
            }
            const type = action.dataset.export;
            const exported = type === 'project' ? exportLorebookProject(name, data, history)
                : type === 'character' ? lorebookToCharacterBook(data) : data;
            download(JSON.stringify(exported, null, 2), `${name}${type === 'project' ? '.stproj' : type === 'character' ? '-lorebook.json' : '.json'}`, 'application/json');
        }));

        const scheduleDirty = debounce(updateDirty, 150);
        root.addEventListener('input', event => {
            if (event.target.closest('.world_entry, .world_entry_edit')) scheduleDirty();
        });
        eventSource.on(event_types.WORLDINFO_UPDATED, scheduleDirty);
        window.addEventListener('neconyan:lorebook-entry', event => {
            if (!event.detail.name || event.detail.uid === undefined) return;
            const tabs = visitedEntries.get(event.detail.name) ?? [];
            const uid = String(event.detail.uid);
            if (!tabs.includes(uid)) visitedEntries.set(event.detail.name, [...tabs, uid]);
            selectedUid = uid;
            scheduleDirty();
        });
        window.addEventListener('neconyan:lorebook-export', event => {
            event.preventDefault();
            void open('export', root.querySelector('#world_popup_export'));
        });
        window.addEventListener('neconyan:lorebook-editor', onEditor);
        async function onEditor() {
            const editor = getWorldInfoEditorSnapshot();
            const request = ++generation;
            if (state?.name !== editor?.name) {
                close(false);
                state = null;
                incoming = null;
                panel.querySelector('#neco-lore-merge-book').value = '';
                panel.querySelector('#neco-lore-merge-file').value = '';
                panel.querySelector('.neco-lore-merge-list').replaceChildren();
                panel.querySelector('[data-merge-preview]').disabled = true;
            }
            updateDirty();
            if (!editor?.data || busy) return;
            try {
                const result = await historyRequest(editor.name, { summary: true });
                if (request !== generation) return;
                histories.set(editor.name, result.history);
                updateDirty();
            } catch (error) {
                console.error('Lorebook history:', error);
            }
        }
        root.dataset.lorebookTools = 'ready';
        await onEditor();
    } catch (error) {
        delete root.dataset.lorebookTools;
        console.error('Lorebook tools failed to load:', error);
    }
}
