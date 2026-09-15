/**
 * The per-source filter panel.
 *
 * Controls are built from the selected source's `capabilities.filters`, which
 * the server derives from the adapter. A source that cannot apply a filter never
 * shows the control for it — the same rule the SFW toggle follows, and for the
 * same reason: a control that silently does nothing is worse than no control.
 *
 * Values live in the DOM rather than in a parallel object, so there is one place
 * for them to be wrong.
 */

import { el, setText } from './render.js';
import { FILTER_LIMITS, FILTER_TYPES } from '../shared/schema.js';

const MAX_FILTERS = 16;
const MAX_VOCABULARY = 1_000;
const FILTER_KEY = /^[a-z][a-zA-Z0-9_-]{0,63}$/;

/**
 * Builds the controls for one source and returns a handle for reading them.
 *
 * @param {HTMLElement} host the container to fill
 * @param {readonly {key: string, type: string, label: string, placeholder?: string}[]} declared
 * @param {() => void} onChange fired when a value changes, for re-running the search
 * @returns {{ read: () => Record<string, unknown>, count: () => number, clear: () => void, set: (key: string, value: unknown) => boolean, setVocabulary: (tags: unknown) => void }}
 */
export function buildFilters(host, declared, onChange) {
    host.replaceChildren();

    const specs = normalizeSpecs(declared);
    let vocabulary = [];
    /** @type {Map<string, { spec: any, input: HTMLInputElement, tags: Set<string>, chips: HTMLElement | null, datalist: HTMLDataListElement | null }>} */
    const fields = new Map();

    for (const spec of specs) {
        const wrap = el('div', `sbbs-filter sbbs-filter-${spec.type}`);
        const id = `sbbs_filter_${spec.key}`;
        const input = document.createElement('input');
        input.id = id;
        const field = { spec, input, tags: new Set(), chips: null, datalist: null };

        if (spec.type === 'boolean') {
            input.type = 'checkbox';
            input.addEventListener('change', () => onChange());

            const checkbox = el('label', 'checkbox_label sbbs-filter-checkbox');
            checkbox.htmlFor = id;
            checkbox.append(input, el('span', undefined, spec.label ?? spec.key));
            wrap.append(checkbox);
        } else {
            const label = el('label', 'sbbs-filter-label', spec.label ?? spec.key);
            label.htmlFor = id;
            wrap.append(label);

            input.className = 'text_pole';
            input.autocomplete = 'off';

            if (spec.type === 'number') {
                input.type = 'number';
                input.min = String(FILTER_LIMITS.numberMin);
                input.max = String(FILTER_LIMITS.numberMax);
                input.step = '1';
                input.addEventListener('change', () => {
                    normalizeNumberInput(input);
                    onChange();
                });
            } else if (spec.type === 'date') {
                input.type = 'date';
                input.addEventListener('change', () => onChange());
            } else {
                input.type = 'text';
                input.maxLength = spec.type === 'tags'
                    ? FILTER_LIMITS.tagLength * FILTER_LIMITS.tagCount
                    : FILTER_LIMITS.textLength;
                if (spec.placeholder) {
                    input.placeholder = spec.placeholder;
                }

                if (spec.type === 'tags') {
                    field.datalist = document.createElement('datalist');
                    field.datalist.id = `${id}_suggestions`;
                    input.setAttribute('list', field.datalist.id);
                    input.addEventListener('input', () => renderSuggestions(field, vocabulary));

                    // Enter and comma both commit a tag. Enter must not reach the
                    // form, or every tag would also submit a search.
                    input.addEventListener('keydown', (event) => {
                        if (event.key === 'Enter' || event.key === ',') {
                            event.preventDefault();
                            const changed = commitTags(field, input.value);
                            input.value = '';
                            renderSuggestions(field, vocabulary);
                            if (changed) {
                                renderChips(field, onChange);
                                onChange();
                            }
                        } else if (event.key === 'Backspace' && input.value === '' && field.tags.size > 0) {
                            const last = [...field.tags].pop();
                            field.tags.delete(last);
                            renderChips(field, onChange);
                            onChange();
                        }
                    });
                    // Pasting "a, b, c" should not need three keystrokes to commit.
                    input.addEventListener('blur', () => {
                        const changed = commitTags(field, input.value);
                        if (input.value !== '') {
                            input.value = '';
                            renderSuggestions(field, vocabulary);
                        }
                        if (changed) {
                            renderChips(field, onChange);
                            onChange();
                        }
                    });
                } else {
                    input.addEventListener('change', () => onChange());
                }
            }

            wrap.append(input);
            if (field.datalist) {
                wrap.append(field.datalist);
            }

            if (spec.type === 'tags') {
                field.chips = el('div', 'sbbs-filter-chips');
                field.chips.setAttribute('role', 'list');
                wrap.append(field.chips);
            }
        }

        fields.set(spec.key, field);
        host.append(wrap);
    }

    return {
        read() {
            const out = Object.create(null);
            for (const [key, field] of fields) {
                if (field.spec.type === 'tags') {
                    // Anything typed but not yet committed still counts: a user
                    // who types a tag and hits Search means it.
                    const pending = splitTags(field.input.value);
                    const all = uniqueTags([...field.tags, ...pending]);
                    if (all.length > 0) {
                        out[key] = all;
                    }
                } else if (field.spec.type === 'number') {
                    const value = normalizeNumberInput(field.input);
                    if (value !== null) {
                        out[key] = value;
                    }
                } else if (field.spec.type === 'boolean') {
                    if (field.input.checked) {
                        out[key] = true;
                    }
                } else {
                    const text = field.input.value.trim();
                    if (text !== '') {
                        out[key] = text;
                    }
                }
            }
            // The internal map is null-prototype so an untrusted filter key cannot
            // alter it. Specs admit only ordinary identifiers, so expose the
            // backwards-compatible plain object callers expect.
            return { ...out };
        },

        count() {
            return Object.keys(this.read()).length;
        },

        clear() {
            for (const field of fields.values()) {
                if (field.spec.type === 'boolean') {
                    field.input.checked = false;
                } else {
                    field.input.value = '';
                }
                field.tags.clear();
                renderSuggestions(field, vocabulary);
                if (field.chips) {
                    renderChips(field, onChange);
                }
            }
        },

        /** Adds a value to a filter, e.g. from clicking a tag on a result card. */
        set(key, value) {
            const field = fields.get(key);
            if (!field) {
                return false;
            }
            if (field.spec.type === 'tags') {
                if (!commitTags(field, value)) {
                    return false;
                }
                renderChips(field, onChange);
            } else if (field.spec.type === 'boolean') {
                field.input.checked = value === true;
            } else {
                field.input.value = String(value);
                if (field.spec.type === 'number') {
                    normalizeNumberInput(field.input);
                }
            }
            return true;
        },

        setVocabulary(tags) {
            vocabulary = Array.isArray(tags) ? tags.slice(0, MAX_VOCABULARY) : [];
            for (const field of fields.values()) {
                renderSuggestions(field, vocabulary);
            }
        },
    };
}

const SUGGESTION_LIMIT = 20;

function renderSuggestions(field, vocabulary) {
    if (!field.datalist) {
        return;
    }
    field.datalist.replaceChildren();

    const typed = field.input.value.split(',').pop().trim().toLowerCase();
    if (typed === '') {
        return;
    }
    const underscored = typed.replace(/\s+/g, '_');

    const matches = [];
    for (const tag of vocabulary) {
        const name = tag && typeof tag === 'object' ? tag.n : null;
        const category = tag && typeof tag === 'object' ? tag.c : null;
        const count = tag && typeof tag === 'object' ? tag.k : null;
        if (typeof name !== 'string' || name === '' || name.length > FILTER_LIMITS.tagLength || typeof count !== 'number' || !Number.isFinite(count)) {
            continue;
        }
        const candidate = name.toLowerCase();
        if (!candidate.includes(typed) && !candidate.includes(underscored)) {
            continue;
        }
        matches.push({ name, category: typeof category === 'string' ? category : '', count: Math.floor(count) });
    }

    matches.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
    for (const match of matches.slice(0, SUGGESTION_LIMIT)) {
        const option = document.createElement('option');
        option.value = match.name;
        option.label = match.category === '' ? String(match.count) : `${match.category} · ${match.count}`;
        field.datalist.append(option);
    }
}

function normalizeSpecs(declared) {
    if (!Array.isArray(declared)) {
        return [];
    }

    const specs = [];
    const keys = new Set();
    for (const value of declared.slice(0, MAX_FILTERS)) {
        if (!value || typeof value !== 'object' || !FILTER_KEY.test(value.key) || !FILTER_TYPES.includes(value.type) || keys.has(value.key)) {
            continue;
        }
        keys.add(value.key);
        specs.push({
            key: value.key,
            type: value.type,
            label: typeof value.label === 'string' ? value.label.slice(0, 80) : value.key,
            placeholder: typeof value.placeholder === 'string' ? value.placeholder.slice(0, 80) : undefined,
        });
    }
    return specs;
}

function splitTags(raw) {
    return String(raw ?? '')
        .split(',')
        .map((tag) => tag.trim().slice(0, FILTER_LIMITS.tagLength))
        .filter((tag) => tag !== '');
}

function uniqueTags(tags) {
    const seen = new Set();
    const result = [];
    for (const tag of tags) {
        const normalized = tag.toLowerCase();
        if (seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(tag);
        if (result.length >= FILTER_LIMITS.tagCount) {
            break;
        }
    }
    return result;
}

function normalizeNumberInput(input) {
    if (input.value === '') {
        return null;
    }
    const value = Number(input.value);
    if (!Number.isFinite(value)) {
        input.value = '';
        return null;
    }
    const normalized = Math.min(FILTER_LIMITS.numberMax, Math.max(FILTER_LIMITS.numberMin, Math.round(value)));
    input.value = String(normalized);
    return normalized;
}

/** @returns {boolean} whether anything was added */
function commitTags(field, raw) {
    let added = false;
    for (const tag of splitTags(raw)) {
        // Case-insensitive dedupe, first spelling wins — sources are inconsistent
        // about capitalising their own tags.
        const seen = [...field.tags].some((existing) => existing.toLowerCase() === tag.toLowerCase());
        if (!seen && field.tags.size < FILTER_LIMITS.tagCount) {
            field.tags.add(tag);
            added = true;
        }
    }
    return added;
}

function renderChips(field, onChange) {
    if (!field.chips) {
        return;
    }
    field.chips.replaceChildren();

    for (const tag of field.tags) {
        const chip = el('span', 'sbbs-filter-chip');
        chip.setAttribute('role', 'listitem');
        setText(chip, tag);

        const remove = el('button', 'sbbs-filter-chip-remove');
        remove.type = 'button';
        // The tag itself is in the name, so screen-reader users are not left
        // with a list of identical "Remove" buttons.
        remove.setAttribute('aria-label', `Remove tag ${tag}`);
        setText(remove, '×');
        remove.addEventListener('click', () => {
            const index = [...field.tags].indexOf(tag);
            field.tags.delete(tag);
            renderChips(field, onChange);
            const neighbours = field.chips.querySelectorAll('button');
            (neighbours[index] ?? neighbours[index - 1] ?? field.input).focus();
            onChange();
        });

        chip.append(remove);
        field.chips.append(chip);
    }
}
