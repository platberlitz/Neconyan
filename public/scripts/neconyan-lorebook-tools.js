import { eventSource, event_types, getMaxPromptTokens, getRequestHeaders } from '../script.js';
import { t } from './i18n.js';
import { renderTemplateAsync } from './templates.js';
import { debounce, download } from './utils.js';
import { getTokenCountAsync } from './tokenizers.js';
import {
    convertCharacterBook, flushWorldInfoEditor, getWorldInfoEditorSnapshot, loadWorldInfo,
    restoreWorldInfoCommit, selectWorldInfoEntry, showWorldEditor, world_info_budget, world_info_budget_cap,
    world_info_case_sensitive, world_info_match_whole_words, world_names,
} from './world-info.js';
import {
    exportLorebookProject, lorebookChanges, lorebookDigest, lorebookEntryTitle,
    lorebookMergeCandidates, lorebookToCharacterBook, parseLorebookImport, serializeLorebook,
} from './neconyan-lorebook-tools-core.js';
import { malformedWrapperChip } from './neconyan-lorebook-delimiters.js';
import {
    HEALTH_RULES, HEALTH_SEVERITIES, healthSignature, quickHealthCount, runLorebookHealth, sanitizeHealthPrefs,
} from './neconyan-lorebook-health.js';
import { planLorebookRepair, repairChangeText, repairDefectText } from './neconyan-lorebook-repair.js';
import { formatTokenCount, measureTokenFootprint, tokenFootprintTitle, worldInfoTokenBudget } from './neconyan-lorebook-tokens.js';
import { getLabClient, mountLabRecovery } from './labs-client.js';

const CHOSEN_SCOPE = '__chosen__';

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

function delimiterNote(delimiter) {
    if (!delimiter) return '';
    const chip = delimiter.malformed ? malformedWrapperChip(delimiter.malformed) : '';
    if (chip) return ` - ${chip}, repaired`;
    return delimiter.replaced ? ` - replaces ${delimiter.replaced}` : '';
}

/**
 * Checks a lorebook for broken entry ids before it leaves Neconyan.
 * @param {object} book Native World Info or Character Book data
 * @returns {object} The same object when clean, or the repaired copy
 */
export function repairForExport(book) {
    const plan = planLorebookRepair(book);
    if (plan.defects.length) {
        throw new Error(`Export stopped: this lorebook has problems that cannot be fixed automatically. ${plan.defects.map(repairDefectText).join('; ')}.`);
    }
    if (plan.changes.length) {
        globalThis.toastr?.info(plan.changes.map(repairChangeText).join('\n'), `Fixed ${plan.changes.length} broken entr${plan.changes.length === 1 ? 'y' : 'ies'} for export`);
    }
    return plan.book;
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
    for (const [index, change] of changes.entries()) select.add(new Option(`${index + 1}. ${change.title}${change.matches === undefined ? '' : ` (${change.matches})`}${delimiterNote(change.delimiter)}`, String(index)));
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
        const client = await getLabClient();
        mountLabRecovery(panel);
        const saved = node('select', '', 'text_pole');
        saved.setAttribute('aria-label', 'Saved LoreStitch previews');
        status.before(saved);
        saved.addEventListener('change', () => void run(async () => {
            if (!saved.value) return;
            const record = await client.observe(await client.read(saved.value));
            if (record.result.target.name !== state.name) throw new Error('This preview belongs to another lorebook.');
            const toolMode = { replace: 'search', delimit: 'delimiters', merge: 'merge' }[record.result.operation];
            if (!toolMode) throw new Error('The saved preview operation is unavailable.');
            showMode(toolMode);
            preview(toolMode, { ...record.result, record });
        }));

        async function refreshSaved() {
            const records = await client.list('lorestitch');
            saved.replaceChildren(new Option('Choose a saved LoreStitch preview', ''));
            for (const record of records.filter(item => item.book === state.name)) {
                saved.add(new Option(`${record.operation} - ${new Date(record.createdAt).toLocaleString()} - ${record.state}`, record.key));
            }
        }

        async function nativePreview(toolMode, operation, options, extra = {}) {
            if (!await prepare()) return;
            const name = state.name;
            const record = await client.run('lorestitch', { book: name, revision: state.revision, operation, options, ...extra },
                { scope: `lorestitch:${name}:${operation}` });
            if (state.name !== name) return;
            preview(toolMode, { ...record.result, record });
            await refreshSaved();
            saved.value = record.key;
        }

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

        const healthButton = button('', event => open('health', event.currentTarget));
        healthButton.id = 'neco-lore-health-button';
        healthButton.classList.add('neco-lore-health-button');
        healthButton.setAttribute('aria-controls', panel.id);
        const healthIcon = node('i', '', 'fa-solid fa-shield-halved');
        healthIcon.setAttribute('aria-hidden', 'true');
        const healthBadge = node('span', '', 'neco-lore-badge');
        healthBadge.hidden = true;
        healthButton.append(healthIcon, node('span', 'Health'), healthBadge);
        const tokenButton = button('', event => open('tokens', event.currentTarget));
        tokenButton.id = 'neco-lore-token-meter';
        tokenButton.classList.add('neco-lore-token-meter');
        tokenButton.setAttribute('aria-controls', panel.id);
        tokenButton.setAttribute('aria-label', 'Always active token footprint - open token inspector');
        const battery = node('span', '', 'neco-lore-battery');
        const batteryFill = node('span', '', 'neco-lore-battery-fill');
        battery.setAttribute('aria-hidden', 'true');
        battery.append(batteryFill);
        const tokenLabel = node('span', '', 'neco-lore-token-label');
        const tokenWarning = node('i', '', 'fa-solid fa-triangle-exclamation');
        tokenWarning.setAttribute('aria-hidden', 'true');
        tokenWarning.hidden = true;
        tokenButton.append(battery, tokenLabel, tokenWarning);
        historyButton.after(healthButton, tokenButton);

        const noPrefs = () => ({ ignoredSignatures: [], mutedRules: [] });
        const currentPrefs = name => sanitizeHealthPrefs(histories.get(name)?.lintPrefs) ?? noPrefs();
        const healthDefaults = () => ({ caseSensitive: world_info_case_sensitive, matchWholeWords: world_info_match_whole_words });
        const healthKey = (name, data) => `${name}\n${JSON.stringify(currentPrefs(name))}\n${serializeLorebook(data)}`;
        const countTokens = text => getTokenCountAsync(text);
        let fullHealth = null;
        let healthResult = null;
        let healthRun = 0;
        let meterRequest = 0;

        function tokenBudget() {
            try {
                return worldInfoTokenBudget({ percent: world_info_budget, maxPromptTokens: getMaxPromptTokens(), cap: world_info_budget_cap });
            } catch {
                return null;
            }
        }

        function renderHealthBadge(count) {
            healthBadge.textContent = count ? String(count) : '';
            healthBadge.hidden = !count;
            healthButton.classList.toggle('neco-lore-has-issues', count > 0);
            healthButton.title = count
                ? `Health check: ${count} error${count === 1 ? '' : 's'} or warning${count === 1 ? '' : 's'}. Click to review.`
                : 'Health check: no errors or warnings found yet. Click for the full check.';
        }

        function renderTokenMeter(footprint) {
            const usage = footprint.budget ? Math.min(1, footprint.usage) : 0;
            batteryFill.style.width = `${Math.round(usage * 100)}%`;
            tokenButton.classList.toggle('neco-lore-near-budget', footprint.nearBudget && !footprint.overBudget);
            tokenButton.classList.toggle('neco-lore-over-budget', footprint.overBudget);
            tokenWarning.hidden = !footprint.overBudget;
            tokenLabel.textContent = `~${formatTokenCount(footprint.total)}`;
            tokenButton.title = tokenFootprintTitle(footprint);
        }

        async function updateMeters() {
            const editor = getWorldInfoEditorSnapshot();
            const request = ++meterRequest;
            healthButton.hidden = !editor?.data;
            tokenButton.hidden = !editor?.data;
            if (!editor?.data) return;
            const key = healthKey(editor.name, editor.data);
            renderHealthBadge(fullHealth?.key === key ? fullHealth.count
                : quickHealthCount(editor.data, { prefs: currentPrefs(editor.name), defaults: healthDefaults() }));
            const footprint = await measureTokenFootprint(editor.data, { count: countTokens, budget: tokenBudget() });
            if (request === meterRequest) renderTokenMeter(footprint);
        }
        const scheduleMeters = debounce(() => void updateMeters().catch(error => console.error('Lorebook meters:', error)), 300);

        async function jumpToEntry(uid) {
            close(false);
            await selectWorldInfoEntry(uid);
        }

        function entryTitleFor(data, uid) {
            return data?.entries?.[uid] ? lorebookEntryTitle(data.entries[uid]) : `Entry ${uid}`;
        }

        async function runHealth() {
            const editor = getWorldInfoEditorSnapshot();
            if (!editor?.data) return;
            const request = ++healthRun;
            const progress = panel.querySelector('.neco-lore-health-progress');
            const bar = progress.querySelector('progress');
            progress.hidden = false;
            bar.value = 0;
            panel.querySelector('.neco-lore-health-results').replaceChildren();
            panel.querySelector('.neco-lore-health-summary p').textContent = '';
            const result = await runLorebookHealth(editor.data, {
                defaults: healthDefaults(),
                onProgress: fraction => { bar.value = Math.round(fraction * 100); },
                isCancelled: () => request !== healthRun || mode !== 'health',
            });
            if (!result) return;
            progress.hidden = true;
            healthResult = { name: editor.name, data: editor.data, diagnostics: result.diagnostics };
            renderHealthResults();
        }

        function renderHealthResults() {
            if (!healthResult) return;
            const { name, data, diagnostics } = healthResult;
            const prefs = currentPrefs(name);
            const muted = new Set(prefs.mutedRules);
            const ignored = new Set(prefs.ignoredSignatures);
            const counts = new Map();
            for (const item of diagnostics) counts.set(item.rule, (counts.get(item.rule) ?? 0) + 1);
            const rules = panel.querySelector('.neco-lore-health-rules');
            rules.replaceChildren();
            for (const [rule, label] of Object.entries(HEALTH_RULES)) {
                const chip = button(`${label} (${counts.get(rule) ?? 0})`, () => void savePrefs(name, {
                    ...prefs, mutedRules: muted.has(rule) ? prefs.mutedRules.filter(item => item !== rule) : [...prefs.mutedRules, rule],
                }));
                chip.classList.add('neco-lore-chip');
                chip.setAttribute('aria-pressed', String(!muted.has(rule)));
                chip.title = muted.has(rule) ? `Show ${label.toLowerCase()} findings` : `Hide ${label.toLowerCase()} findings`;
                rules.append(chip);
            }
            const unmuted = diagnostics.filter(item => !muted.has(item.rule));
            const shown = unmuted.filter(item => !ignored.has(healthSignature(item)));
            const hidden = unmuted.length - shown.length;
            fullHealth = { key: healthKey(name, data), count: shown.filter(item => item.severity !== 'info').length };
            renderHealthBadge(fullHealth.count);
            const tally = HEALTH_SEVERITIES.map(([severity, heading]) => [heading, shown.filter(item => item.severity === severity).length])
                .filter(([, count]) => count).map(([heading, count]) => `${count} ${heading.toLowerCase()}`);
            const summary = shown.length ? `Found ${tally.join(', ')}.` : 'No issues found - lorebook looks healthy.';
            panel.querySelector('.neco-lore-health-summary p').textContent = hidden
                ? `${summary} ${hidden} finding${hidden === 1 ? '' : 's'} marked not an issue.` : summary;
            panel.querySelector('[data-health-restore]').hidden = !hidden;
            panel.querySelector('[data-health-unmute]').hidden = !muted.size;
            const results = panel.querySelector('.neco-lore-health-results');
            results.replaceChildren();
            for (const [severity, heading] of HEALTH_SEVERITIES) {
                const items = shown.filter(item => item.severity === severity);
                if (!items.length) continue;
                const section = node('section', '', `neco-lore-health-group neco-lore-health-${severity}`);
                const list = node('ul');
                section.append(node('h4', `${heading} (${items.length})`), list);
                for (const item of items) {
                    const row = node('li');
                    row.append(node('strong', HEALTH_RULES[item.rule] ?? item.rule), node('p', item.message));
                    if (item.details) row.append(node('code', item.details));
                    const actions = node('div', '', 'neco-lore-actions');
                    for (const uid of item.entryIds) {
                        const jump = button(item.entryIds.length === 1 ? 'Go to entry' : `Go to ${entryTitleFor(data, uid)}`, () => void jumpToEntry(uid));
                        actions.append(jump);
                    }
                    actions.append(button('Not an issue', () => void savePrefs(name, {
                        ...prefs, ignoredSignatures: [...prefs.ignoredSignatures, healthSignature(item)],
                    })));
                    row.append(actions);
                    list.append(row);
                }
                results.append(section);
            }
        }

        function savePrefs(name, next) {
            return run(async () => {
                const lintPrefs = sanitizeHealthPrefs(next) ?? noPrefs();
                const result = await historyRequest(name, { action: 'lint', lintPrefs });
                histories.set(name, result.history);
                if (state?.name === name) state = { ...state, history: result.history };
                renderHealthResults();
                scheduleMeters();
            });
        }

        async function renderTokens() {
            const editor = getWorldInfoEditorSnapshot();
            if (!editor?.data) return;
            const footprint = await measureTokenFootprint(editor.data, { count: countTokens, budget: tokenBudget() });
            renderTokenMeter(footprint);
            panel.querySelector('.neco-lore-token-summary').textContent = footprint.items.length
                ? tokenFootprintTitle(footprint).replace(/ ?Click to inspect\.$/, '')
                : 'No always-active entries - this lorebook adds nothing to every reply by itself.';
            const list = panel.querySelector('.neco-lore-token-list');
            list.replaceChildren();
            for (const item of footprint.items) {
                const row = node('li');
                const jump = button(item.title, () => void jumpToEntry(item.uid));
                const share = footprint.total ? Math.round(item.tokens / footprint.total * 100) : 0;
                row.append(jump, node('span', `~${formatTokenCount(item.tokens)} tokens (${share}%)`));
                list.append(row);
            }
        }

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
            if (toolMode === 'delimiters') panel.querySelector('.neco-lore-delimiter-banner').hidden = true;
        }

        function preview(toolMode, result) {
            previews.set(toolMode, result);
            renderDiff(panel.querySelector(`[data-preview="${toolMode}"]`), result.changes);
            panel.querySelector(`[data-apply="${toolMode}"]`).disabled = !result.changes.length;
            if (toolMode === 'delimiters') {
                const banner = panel.querySelector('.neco-lore-delimiter-banner');
                const count = result.changes.length;
                const repaired = result.changes.filter(change => change.delimiter?.malformed).length;
                banner.textContent = count
                    ? `${count} entr${count === 1 ? 'y' : 'ies'} will change.${repaired ? ` ${repaired} broken wrapper${repaired === 1 ? '' : 's'} (mismatched, unclosed or broken heading) will be repaired.` : ''}`
                    : '';
                banner.hidden = !count;
            }
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
                scope.replaceChildren(new Option('All entries', ''), new Option('Chosen entries', CHOSEN_SCOPE));
                for (const [uid, entry] of Object.entries(state.data.entries)) scope.add(new Option(lorebookEntryTitle(entry), uid));
                scope.value = scopeValue === CHOSEN_SCOPE || Object.hasOwn(state.data.entries, scopeValue) ? scopeValue : '';
                const checklist = panel.querySelector('.neco-lore-delimiter-checklist');
                const chosen = new Set([...checklist.querySelectorAll('input:checked')].map(input => input.value));
                checklist.replaceChildren();
                for (const [uid, entry] of Object.entries(state.data.entries)) {
                    const label = node('label', '', 'checkbox_label');
                    const input = node('input');
                    input.type = 'checkbox';
                    input.name = 'chosenUid';
                    input.value = uid;
                    input.checked = chosen.has(uid);
                    label.append(input, document.createTextNode(lorebookEntryTitle(entry)));
                    checklist.append(label);
                }
                syncDelimiterForm();
                const book = panel.querySelector('#neco-lore-merge-book');
                const previous = book.value;
                book.replaceChildren(new Option('--- Pick a lorebook ---', ''));
                for (const name of world_names.filter(name => name !== state.name)) book.add(new Option(name, name));
                book.value = previous;
                await refreshSaved();
            });
            panel.querySelector(`[data-mode="${nextMode}"]`)?.focus();
            if (mode === 'health' && nextMode === 'health') await runHealth();
            if (mode === 'tokens' && nextMode === 'tokens') await run(renderTokens);
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
            scheduleMeters();
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
                remove.setAttribute('aria-label', t`Close ${title}`);
                remove.setAttribute('data-i18n-ignore', '');
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
                await flushWorldInfoEditor();
                await client.run('apply', { proposalKey: result.record.key, resultHash: result.record.resultHash },
                    { scope: `apply:${result.record.key}` });
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
                await nativePreview('search', 'replace', {
                    search: String(form.get('search')), replacement: String(form.get('replacement')), fields,
                    regex: form.has('regex'), wholeWord: form.has('wholeWord'), caseSensitive: form.has('caseSensitive'),
                });
            });
        });
        const delimiterForm = panel.querySelector('.neco-lore-delimiter-form');
        function syncDelimiterForm() {
            const chosenScope = panel.querySelector('#neco-lore-delimiter-scope').value === CHOSEN_SCOPE;
            const source = panel.querySelector('#neco-lore-delimiter-source');
            const custom = source.querySelector('option[value="fixed"]');
            // Chosen entries are each wrapped under their own name, like LoreStitch's selection mode.
            custom.disabled = chosenScope;
            if (chosenScope && source.value === 'fixed') source.value = 'title';
            panel.querySelector('#neco-lore-delimiter-name').disabled = source.value !== 'fixed';
            panel.querySelector('.neco-lore-delimiter-chosen').hidden = !chosenScope;
            const markdown = panel.querySelector('#neco-lore-delimiter-style').value === 'markdown';
            for (const element of delimiterForm.querySelectorAll('[data-markdown-only]')) element.hidden = !markdown;
        }
        delimiterForm.addEventListener('input', () => {
            clearPreview('delimiters');
            syncDelimiterForm();
        });
        for (const choice of delimiterForm.querySelectorAll('[data-choose]')) choice.addEventListener('click', () => {
            for (const input of delimiterForm.querySelectorAll('input[name="chosenUid"]')) input.checked = choice.dataset.choose === 'all';
            clearPreview('delimiters');
        });
        delimiterForm.addEventListener('submit', event => {
            event.preventDefault();
            void run(async () => {
                const values = new FormData(delimiterForm);
                const chosenScope = values.get('uid') === CHOSEN_SCOPE;
                const uids = values.getAll('chosenUid').map(String);
                if (chosenScope && !uids.length) throw new Error('Choose at least one entry to change.');
                await nativePreview('delimiters', 'delimit', {
                    style: values.get('delimiterStyle'), name: values.get('delimiterName') ?? '',
                    nameSource: values.get('nameSource'), uid: chosenScope ? '' : values.get('uid'),
                    ...(chosenScope ? { uids } : {}),
                    level: Number(values.get('level') ?? 2), trailingSeparator: values.has('trailingSeparator'),
                });
            });
        });
        panel.querySelector('[data-health-restore]').addEventListener('click', () => {
            if (healthResult) void savePrefs(healthResult.name, { ...currentPrefs(healthResult.name), ignoredSignatures: [] });
        });
        panel.querySelector('[data-health-unmute]').addEventListener('click', () => {
            if (healthResult) void savePrefs(healthResult.name, { ...currentPrefs(healthResult.name), mutedRules: [] });
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
            const incomingBook = panel.querySelector('#neco-lore-merge-book').value;
            await nativePreview('merge', 'merge', { choices }, incomingBook ? { incomingBook } : { incoming });
        }));
        for (const action of panel.querySelectorAll('[data-export]')) action.addEventListener('click', () => void run(async () => {
            if (!await prepare()) return;
            const { name, data, history } = state;
            if (action.dataset.export === 'digest') {
                download(lorebookDigest(name, data), `${name}.md`, 'text/markdown');
                return;
            }
            const type = action.dataset.export;
            const exported = type === 'project' ? exportLorebookProject(name, repairForExport(data), history)
                : type === 'character' ? repairForExport(lorebookToCharacterBook(data)) : repairForExport(data);
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
                healthResult = null;
                fullHealth = null;
                healthRun++;
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
