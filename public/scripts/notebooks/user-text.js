import { translate } from '../i18n.js';
import { h } from './dom.js';

/* The user's own words inside interface sentences. The run-time localiser (ui-localization.js) translates any
   visible text it can match, so the user's words are marked with data-i18n-ignore and the interface wording
   around them is translated here, once, instead. */

/** The user's words as written, in a span the run-time localiser leaves alone. */
function userWords(value) {
    return h('span', { text: String(value ?? ''), 'data-i18n-ignore': '' });
}

/**
 * An interface sentence holding the user's words, written as a tag: userPhrase`Edit ${key}`.
 * The sentence is translated whole through its ${n} key, as t`` does, so each language keeps its own word order;
 * the user's words go in as written. Both are marked, so the run-time localiser does not translate them again.
 * A value may itself be a phrase. Returns one span, so the sentence stays one item in a flex row.
 */
export function userPhrase(strings, ...values) {
    const key = strings.reduce((sentence, part, index) => sentence + part + (index < values.length ? `\${${index}}` : ''), '');
    const trimmed = key.trim();
    const translated = trimmed ? key.replace(trimmed, () => translate(trimmed)) : key;
    const placed = new Set();
    return h('span', {}, translated.split(/\$\{(\d+)\}/).map((part, index) => {
        if (index % 2) {
            const value = values[Number(part)];
            if (value === null || typeof value !== 'object') return userWords(value);
            // A translation may use a placeholder twice; a node can only stand in one place, so the second use is a copy.
            if (placed.has(value) && value.cloneNode) return value.cloneNode(true);
            placed.add(value);
            return value;
        }
        return part.trim() ? h('span', { text: part, 'data-i18n-ignore': '' }) : part;
    }).filter(Boolean));
}

/**
 * A selection's label from the server (src/notebooks/lore.js selectorLabel). Only the selector's kind tells a whole-note selection
 * ('Whole note', interface wording) from a heading the user named 'Whole note', so the label is translated only for kind 'note';
 * a heading path or block id is shown as written.
 */
export function regionLabel(selector, label) {
    return selector?.kind === 'note' ? translate('Whole note') : label;
}

/** The server's proposal label ('Create note: <title>' and so on, src/notebooks/assistant.js) as a phrase; any other label is shown as written. */
export function proposalLabel(summary) {
    const { operation, label = '', noteTitle } = summary ?? {};
    if (typeof noteTitle === 'string') {
        if (operation === 'create' && label === `Create note: ${noteTitle}`) return userPhrase`Create note: ${noteTitle}`;
        if (operation === 'append' && label === `Add to note: ${noteTitle}`) return userPhrase`Add to note: ${noteTitle}`;
        if (operation === 'edit' && label === `Change note: ${noteTitle}`) return userPhrase`Change note: ${noteTitle}`;
        // 21 is the length of 'Publish to lore: ' and ' to ' around the title; the label must then match exactly.
        const book = label.slice(noteTitle.length + 21);
        if (operation === 'publish' && label === `Publish to lore: ${noteTitle} to ${book}`) return userPhrase`Publish to lore: ${noteTitle} to ${book}`;
    }
    return userWords(label);
}
