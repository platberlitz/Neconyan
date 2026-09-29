import { debounce } from './utils.js';
import {
    KEY_TEST_HIGHLIGHT_LIMIT, KEY_TEST_SAMPLE_LIMIT, canTestEntryKeys, classifyKey, keyTestVerdictText, testEntryKeys,
} from './neconyan-lorebook-keytest.js';

const INVALID_REGEX_HINT = 'looks like a regex but is not valid, so SillyTavern matches it as plain text';

function invalidRegexKeys(entry) {
    return [...(entry?.key ?? []), ...(entry?.keysecondary ?? [])]
        .filter(key => typeof key === 'string' && classifyKey(key) === 'invalid-regex');
}

const HINT = 'Matches against the text you type here, not the assembled chat history (message names, scan depth, recursion). '
    + 'Options left unset use the global World Info settings. Probability rolls, sticky and cooldown timers, inclusion groups, '
    + 'recursion and Vector Storage can still change the live outcome.';

function node(tag, text = '', className = '') {
    const element = document.createElement(tag);
    element.textContent = text;
    element.className = className;
    return element;
}

function stateText(row) {
    const state = row.matched ? 'Matches' : 'No match';
    const suffix = row.blocks ? ' (blocks activation)' : '';
    return row.kind === 'invalid-regex' ? `${state} - invalid regex, treated as plain text${suffix}` : `${state}${suffix}`;
}

/**
 * Builds the per-entry Test keys section (LoreStitch 1.3/1.4) for a World Info entry editor.
 * @param {() => object|undefined} getEntry Returns the live draft entry
 * @param {() => {caseSensitive: boolean, matchWholeWords: boolean}} getDefaults Global World Info matching settings
 * @returns {HTMLDetailsElement}
 */
export function createKeyTestSection(getEntry, getDefaults) {
    const section = node('details', '', 'neco-lore-keytest');
    const summary = node('summary', 'Test keys');
    summary.title = 'Test keys against a sample text';
    // Neconyan defaults to the plain-text key box, so broken regex keys are flagged here, visible while folded.
    const warning = node('span', '', 'neco-lore-keytest-warning');
    warning.hidden = true;
    summary.append(warning);
    const body = node('div', '', 'neco-lore-keytest-body');
    const label = node('label', 'Sample text');
    const sample = node('textarea', '', 'text_pole');
    sample.rows = 3;
    sample.maxLength = KEY_TEST_SAMPLE_LIMIT;
    sample.placeholder = 'Enter sample text...';
    // Sample text is scratch input, not entry data; the World Info autosave must ignore it.
    sample.dataset.necoKeytest = 'sample';
    label.append(sample);
    const verdict = node('p', '', 'neco-lore-keytest-verdict');
    verdict.setAttribute('role', 'status');
    verdict.setAttribute('aria-live', 'polite');
    const rows = node('ul', '', 'neco-lore-keytest-rows');
    const preview = node('div', '', 'neco-lore-keytest-preview');
    preview.setAttribute('aria-label', 'Highlighted matches');
    const clamped = node('p', `Showing the first ${KEY_TEST_HIGHLIGHT_LIMIT} matches.`, 'neco-lore-hint');
    clamped.hidden = true;
    body.append(label, node('p', HINT, 'neco-lore-hint'), verdict, rows, preview, clamped);
    section.append(summary, body);

    function render() {
        const entry = getEntry();
        section.hidden = !canTestEntryKeys(entry);
        const broken = invalidRegexKeys(entry);
        warning.hidden = !broken.length;
        warning.textContent = broken.length === 1 ? '1 broken regex key' : `${broken.length} broken regex keys`;
        warning.title = broken.map(key => `${key} ${INVALID_REGEX_HINT}.`).join('\n');
        if (section.hidden || !section.open) return;
        rows.replaceChildren();
        preview.replaceChildren();
        clamped.hidden = true;
        if (!sample.value) {
            verdict.textContent = '';
            verdict.dataset.outlook = '';
            preview.hidden = true;
            return;
        }
        const result = testEntryKeys(entry, sample.value, getDefaults());
        verdict.textContent = keyTestVerdictText(result);
        verdict.dataset.outlook = result.verdict.outlook;
        for (const row of [...result.primary, ...result.secondary]) {
            const item = node('li', '', `neco-lore-keytest-row${row.matched ? ' is-match' : ''}${row.kind === 'invalid-regex' ? ' is-invalid' : ''}`);
            const head = node('div', '', 'neco-lore-keytest-row-head');
            head.append(
                node('span', stateText(row), 'neco-lore-keytest-state'),
                node('code', row.key),
                node('span', row.group === 'primary' ? 'Primary' : `Secondary · ${result.logicLabel}`, 'neco-lore-chip'),
            );
            if (row.kind === 'regex') head.append(node('span', 'Regex', 'neco-lore-chip'));
            item.append(head);
            if (row.excerpt) item.append(node('q', row.excerpt, 'neco-lore-keytest-excerpt'));
            rows.append(item);
        }
        for (const segment of result.segments) {
            if (segment.tone === 'none') preview.append(document.createTextNode(segment.text));
            else preview.append(node('mark', segment.text, `neco-lore-mark-${segment.tone}`));
        }
        preview.hidden = !result.segments.length;
        clamped.hidden = !result.clamped;
    }

    const schedule = debounce(render, 200);
    sample.addEventListener('input', event => {
        event.stopPropagation();
        schedule();
    });
    sample.addEventListener('change', event => event.stopPropagation());
    section.addEventListener('toggle', render);
    queueMicrotask(() => {
        const form = section.closest('.world_entry') ?? section.parentElement;
        for (const type of ['input', 'change']) form?.addEventListener(type, event => {
            if (event.target !== sample) schedule();
        });
        render();
    });
    return section;
}
