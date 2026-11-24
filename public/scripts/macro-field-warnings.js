/**
 * Inline warnings under macro-capable fields ([data-macros]) for unknown or
 * malformed {{...}} macros.
 *
 * Parsing is shared with Scratchpad (scanMacroProblems). Known names are read
 * from the live registry at every check, so macros registered later by
 * extensions count as soon as they exist. The module imports nothing from the
 * app beyond the scanner, so it runs under Jest with injected names.
 */

import { scanMacroProblems } from './scratchpad/checks/macros.js';

/** Handlebars helpers plus the values renderStoryString passes to the story string template. */
export const STORY_STRING_MACRO_NAMES = Object.freeze([
    'if', 'unless', 'each', 'with', 'else', 'lookup', 'log', 'this',
    'description', 'personality', 'persona', 'scenario', 'system', 'char', 'user',
    'wiBefore', 'wiAfter', 'loreBefore', 'loreAfter', 'anchorBefore', 'anchorAfter',
    'mesExamples', 'mesExamplesRaw',
]);

/** Instruct sequences replace {{name}} with the speaker's name (instruct-format.js). */
export const INSTRUCT_SEQUENCE_MACRO_NAMES = Object.freeze(['name']);

export const MACRO_WARNING_CLASS = 'nn-macro-field-warning';
export const MACRO_WARNING_NAME_CAP = 3;
const FIELD_SELECTOR = 'textarea[data-macros], input[data-macros]';
const WATCHED_ATTRIBUTES = ['data-macros', 'data-macro-dialect'];

const dialects = new Map([
    ['story-string', () => STORY_STRING_MACRO_NAMES],
    ['instruct', () => INSTRUCT_SEQUENCE_MACRO_NAMES],
]);

/**
 * Adds names a field dialect accepts on top of the registry, such as Agent-only macros.
 * @param {string} name Value of the field's data-macro-dialect attribute
 * @param {Iterable<string>|(() => Iterable<string>)} names Names, or a function returning them at check time
 */
export function registerMacroFieldDialect(name, names) {
    if (!name) return;
    dialects.set(String(name), typeof names === 'function' ? names : () => names);
}

/** @param {string} [dialect] */
export function macroFieldDialectNames(dialect) {
    const source = dialect ? dialects.get(String(dialect)) : null;
    if (!source) return [];
    try {
        return [...(source() ?? [])].map(String);
    } catch {
        return [];
    }
}

function unclosedSnippet(text) {
    const line = String(text ?? '').split(/\r?\n/, 1)[0];
    const clipped = line.length > 24 ? `${line.slice(0, 24)}…` : line;
    return clipped.trimEnd();
}

/**
 * The problems a field warning reports: unknown names, unclosed {{ and stray }}.
 * @param {string} text Field text
 * @param {{knownNames?: Iterable<string>, dialect?: string}} options
 * @returns {{unknown: string[], unclosed: string[], strayClosers: number}}
 */
export function macroFieldProblems(text, { knownNames = [], dialect = '' } = {}) {
    const names = [...knownNames];
    // Without registry names the unknown rule cannot judge anything, so it stays silent.
    const known = names.length ? [...names, ...macroFieldDialectNames(dialect)] : [];
    const unknown = [];
    const seen = new Set();
    const unclosed = [];
    let strayClosers = 0;
    for (const finding of scanMacroProblems(text, { knownNames: known })) {
        if (finding.rule === 'macro-unknown') {
            const key = String(finding.details).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            unknown.push(String(finding.details));
        } else if (finding.rule === 'macro-unbalanced') {
            unclosed.push(...(finding.unclosed ?? []).map(unclosedSnippet));
            strayClosers += Number(finding.extraClosers) || 0;
        }
    }
    return { unknown, unclosed: [...new Set(unclosed)], strayClosers };
}

export function hasMacroFieldProblems(problems) {
    return Boolean(problems && (problems.unknown.length || problems.unclosed.length || problems.strayClosers));
}

const identity = (strings, ...values) => strings.reduce((out, part, index) => out + part + (index < values.length ? values[index] : ''), '');
let translator = identity;

/** Local tag so the locale builder collects these captions; it calls the app's translator once set. */
function t(strings, ...values) {
    try {
        return translator(strings, ...values);
    } catch {
        return identity(strings, ...values);
    }
}

/**
 * The visible lines of a warning, each with a label, code samples and a hint.
 * @param {{unknown: string[], unclosed: string[], strayClosers: number}} problems
 * @param {{cap?: number}} [options]
 * @returns {{kind: string, label: string, codes: string[], more: string, hint: string}[]}
 */
export function formatMacroFieldProblems(problems, { cap = MACRO_WARNING_NAME_CAP } = {}) {
    const lines = [];
    const capped = (items) => {
        const shown = items.slice(0, cap);
        const hidden = items.length - shown.length;
        return { shown, more: hidden > 0 ? t`+${hidden} more` : '' };
    };
    if (problems.unknown.length) {
        const { shown, more } = capped(problems.unknown);
        lines.push({
            kind: 'unknown',
            label: problems.unknown.length === 1 ? t`Unknown macro:` : t`Unknown macros:`,
            codes: shown.map(name => `{{${name}}}`),
            more,
            hint: t`Check the spelling. Neconyan sends unknown macros as plain text.`,
        });
    }
    if (problems.unclosed.length) {
        const { shown, more } = capped(problems.unclosed);
        lines.push({
            kind: 'unclosed',
            label: t`Unclosed macro:`,
            codes: shown,
            more,
            hint: t`Add the closing braces.`,
        });
    }
    if (problems.strayClosers) {
        lines.push({
            kind: 'stray',
            label: t`Extra closing braces:`,
            codes: ['}}'],
            more: problems.strayClosers > 1 ? `×${problems.strayClosers}` : '',
            hint: t`Remove them or add the opening braces.`,
        });
    }
    return lines;
}

function isMacroField(element) {
    if (!(element instanceof Element) || !element.matches(FIELD_SELECTOR)) return false;
    const value = element.getAttribute('data-macros');
    return value === '' || value === 'true';
}

let controller = null;

/**
 * Starts watching every macro-capable field in the document. Safe to call twice.
 * @param {{getKnownNames?: () => Iterable<string>, t?: Function, root?: Document, debounceMs?: number, registryPollMs?: number}} [options]
 * @returns {Promise<{scan: (field: Element) => void, scanAll: () => void, destroy: () => void}>}
 */
export async function initMacroFieldWarnings(options = {}) {
    if (controller) return controller;
    let { getKnownNames } = options;
    if (!getKnownNames) {
        const { MacroRegistry } = await import('./macros/engine/MacroRegistry.js');
        getKnownNames = () => MacroRegistry.getAllMacros().map(definition => definition.name);
    }
    if (typeof options.t === 'function') translator = options.t;
    controller = createMacroFieldWarnings({ ...options, getKnownNames });
    return controller;
}

/** @returns {boolean} Whether the app-wide watcher has started. */
export function macroFieldWarningsStarted() {
    return controller !== null;
}

/**
 * The DOM half, exported for tests. Prefer initMacroFieldWarnings.
 * @param {{getKnownNames: () => Iterable<string>, root?: Document, debounceMs?: number, registryPollMs?: number}} options
 */
export function createMacroFieldWarnings({ getKnownNames, root = document, debounceMs = 250, registryPollMs = 1500 }) {
    const view = root.defaultView ?? globalThis;
    const timers = new WeakMap();
    const warnings = new Map();
    const signatures = new WeakMap();
    const patched = new WeakSet();
    const pending = new Set();
    let flushQueued = false;
    let namesCache = null;
    let registrySignature = '';
    let pollTimer = null;
    let counter = 0;

    const knownNames = () => {
        if (!namesCache) {
            try {
                namesCache = [...(getKnownNames() ?? [])];
            } catch {
                namesCache = [];
            }
            Promise.resolve().then(() => { namesCache = null; });
        }
        return namesCache;
    };

    const isFlexRowOrGrid = (element) => {
        const style = view.getComputedStyle?.(element);
        if (!style) return false;
        if (/grid/.test(style.display)) return true;
        return /flex/.test(style.display) && !/column/.test(style.flexDirection);
    };

    // The warning goes after the field, or after the nearest ancestor that sits
    // in normal flow, so a row of controls never gains a new column.
    const anchorFor = (field) => {
        let anchor = field;
        while (anchor.parentElement && anchor.parentElement !== root.body && isFlexRowOrGrid(anchor.parentElement)) {
            anchor = anchor.parentElement;
        }
        return anchor;
    };

    const setDescribedBy = (field, id, on) => {
        const tokens = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        const has = tokens.includes(id);
        if (on && !has) tokens.push(id);
        if (!on && has) tokens.splice(tokens.indexOf(id), 1);
        if (on === has) return;
        if (tokens.length) field.setAttribute('aria-describedby', tokens.join(' '));
        else field.removeAttribute('aria-describedby');
    };

    const clear = (field) => {
        const warning = warnings.get(field);
        signatures.delete(field);
        if (!warning) return;
        warnings.delete(field);
        setDescribedBy(field, warning.id, false);
        warning.remove();
        if (!warnings.size) stopPolling();
    };

    const render = (warning, lines) => {
        warning.replaceChildren(...lines.map(line => {
            const row = root.createElement('div');
            row.className = `${MACRO_WARNING_CLASS}-line`;
            row.dataset.kind = line.kind;
            const label = root.createElement('span');
            label.className = `${MACRO_WARNING_CLASS}-label`;
            label.textContent = line.label;
            row.append(label);
            for (const code of line.codes) {
                const sample = root.createElement('code');
                sample.textContent = code;
                row.append(' ', sample);
            }
            if (line.more) {
                const more = root.createElement('span');
                more.className = `${MACRO_WARNING_CLASS}-more`;
                more.textContent = line.more;
                row.append(' ', more);
            }
            const hint = root.createElement('span');
            hint.className = `${MACRO_WARNING_CLASS}-hint`;
            hint.textContent = line.hint;
            row.append(' ', hint);
            return row;
        }));
    };

    const scan = (field) => {
        clearTimeout(timers.get(field));
        timers.delete(field);
        if (!field.isConnected || !isMacroField(field)) {
            clear(field);
            return;
        }
        const problems = macroFieldProblems(field.value, {
            knownNames: knownNames(),
            dialect: field.getAttribute('data-macro-dialect') ?? '',
        });
        if (!hasMacroFieldProblems(problems)) {
            clear(field);
            return;
        }
        let warning = warnings.get(field);
        if (!warning) {
            warning = root.createElement('div');
            warning.className = MACRO_WARNING_CLASS;
            warning.id = `nn-macro-warning-${++counter}`;
            warning.setAttribute('role', 'status');
            warning.setAttribute('aria-live', 'polite');
            warnings.set(field, warning);
            startPolling();
        }
        const signature = JSON.stringify(problems);
        if (signatures.get(field) !== signature) {
            signatures.set(field, signature);
            render(warning, formatMacroFieldProblems(problems));
        }
        const anchor = anchorFor(field);
        if (anchor.nextElementSibling !== warning) anchor.after(warning);
        setDescribedBy(field, warning.id, true);
    };

    const flush = () => {
        flushQueued = false;
        const fields = [...pending];
        pending.clear();
        for (const field of fields) scan(field);
    };

    const queue = (field) => {
        pending.add(field);
        if (flushQueued) return;
        flushQueued = true;
        queueMicrotask(flush);
    };

    // jQuery .val() and plain assignments do not fire input events, so a
    // character switch or entry open would otherwise leave a stale warning.
    const patchValue = (field) => {
        if (patched.has(field)) return;
        const proto = Object.getPrototypeOf(field);
        let owner = proto;
        let descriptor;
        while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, 'value'))) owner = Object.getPrototypeOf(owner);
        if (!descriptor?.set || !descriptor.get) return;
        patched.add(field);
        Object.defineProperty(field, 'value', {
            configurable: true,
            enumerable: descriptor.enumerable,
            get() { return descriptor.get.call(this); },
            set(next) {
                const before = descriptor.get.call(this);
                descriptor.set.call(this, next);
                if (descriptor.get.call(this) !== before) queue(this);
            },
        });
    };

    const attach = (field) => {
        if (!isMacroField(field)) {
            clear(field);
            return;
        }
        patchValue(field);
        queue(field);
    };

    const fieldsIn = (node) => {
        if (!(node instanceof Element)) return [];
        const found = node.matches(FIELD_SELECTOR) ? [node] : [];
        return found.concat([...node.querySelectorAll(FIELD_SELECTOR)]);
    };

    const onInput = (event) => {
        const field = event.target;
        if (!isMacroField(field)) return;
        patchValue(field);
        clearTimeout(timers.get(field));
        timers.set(field, setTimeout(() => scan(field), debounceMs));
    };

    const onChange = (event) => {
        const field = event.target;
        if (!isMacroField(field)) return;
        patchValue(field);
        scan(field);
    };

    const observer = new view.MutationObserver((records) => {
        let removed = false;
        for (const record of records) {
            if (record.type === 'attributes') {
                if (record.target instanceof Element && record.target.matches('textarea, input')) attach(record.target);
                continue;
            }
            for (const node of record.addedNodes) {
                if (node instanceof Element && node.classList.contains(MACRO_WARNING_CLASS)) continue;
                for (const field of fieldsIn(node)) attach(field);
            }
            if (record.removedNodes.length) removed = true;
        }
        if (removed) {
            for (const field of [...warnings.keys()]) {
                if (!field.isConnected) clear(field);
            }
        }
    });

    function startPolling() {
        if (pollTimer || !registryPollMs) return;
        registrySignature = knownNames().join('\n');
        pollTimer = setInterval(() => {
            const next = knownNames().join('\n');
            if (next === registrySignature) return;
            registrySignature = next;
            for (const field of [...warnings.keys()]) scan(field);
        }, registryPollMs);
    }

    function stopPolling() {
        clearInterval(pollTimer);
        pollTimer = null;
    }

    root.addEventListener('input', onInput, true);
    root.addEventListener('change', onChange, true);
    observer.observe(root.body ?? root.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: WATCHED_ATTRIBUTES,
    });
    for (const field of root.querySelectorAll(FIELD_SELECTOR)) attach(field);

    const api = {
        scan,
        scanAll: () => { for (const field of root.querySelectorAll(FIELD_SELECTOR)) scan(field); },
        warningFor: field => warnings.get(field) ?? null,
        destroy() {
            observer.disconnect();
            root.removeEventListener('input', onInput, true);
            root.removeEventListener('change', onChange, true);
            stopPolling();
            for (const field of [...warnings.keys()]) clear(field);
            if (controller === api) controller = null;
        },
    };
    return api;
}
