/**
 * Turns an adapter's field mapping into a record the client is allowed to see.
 *
 * The rule that matters: this module CONSTRUCTS a new object containing only
 * whitelisted keys. It never spreads an upstream object. Spreading is how a
 * browser extension ends up handing arbitrary attacker-chosen fields to its own
 * renderer — CleanBotBrowser's transformQuillgenCard does exactly that.
 *
 * Adapters map upstream names to our names; this module owns types and limits.
 */

import {
    CARD_SUMMARY_FIELDS,
    CARD_DETAIL_FIELDS,
    CONTENT_RATINGS,
    FIELD_LIMITS,
} from '../shared/schema.js';
import { str, intOrNull, isoOrNull } from './strings.js';

const SUMMARY_KEYS = new Set(CARD_SUMMARY_FIELDS);
const DETAIL_KEYS = new Set(CARD_DETAIL_FIELDS);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function tags(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    const out = [];
    for (const entry of value) {
        if (out.length >= FIELD_LIMITS.tagCount) {
            break;
        }
        const name = str(entry, FIELD_LIMITS.tagLength);
        if (name !== '') {
            out.push(name);
        }
    }
    return out;
}

/**
 * @param {unknown} value
 */
function stats(value) {
    const source = value && typeof value === 'object' ? value : {};
    const out = Object.create(null);
    for (const key of ['views', 'downloads', 'favorites', 'tokens']) {
        out[key] = intOrNull(Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined);
    }
    return out;
}

/**
 * The Card contents summary as a SOURCE reported it. Counts only — a listing's
 * claims about a card are not a reason to ship its lorebook text around.
 *
 * The byte-derived report in cardbytes.js does carry card text, including the
 * lorebook's, because the intake screen measures its token cost with the host
 * tokenizer. That text is counted and never rendered; this shape is a different
 * thing and stays counts-only.
 * @param {unknown} value
 */
function inside(value) {
    const source = value && typeof value === 'object' ? value : {};
    const read = (key) => (Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined);

    return {
        lorebookEntries: intOrNull(read('lorebookEntries')),
        alternateGreetings: intOrNull(read('alternateGreetings')),
        hasSystemPrompt: nullableBoolean(read('hasSystemPrompt')),
        hasPostHistoryInstructions: nullableBoolean(read('hasPostHistoryInstructions')),
        hasDepthPrompt: nullableBoolean(read('hasDepthPrompt')),
        regexScripts: intOrNull(read('regexScripts')),
        embeddedAssets: intOrNull(read('embeddedAssets')),
        specVersion: str(read('specVersion'), 32) || null,
        originSite: str(read('originSite'), 64) || null,
    };
}

function nullableBoolean(value) {
    return typeof value === 'boolean' ? value : null;
}

/**
 * @param {Record<string, unknown>} candidate values already mapped to our names
 * @param {Set<string>} allowedKeys
 */
function build(candidate, allowedKeys) {
    const record = Object.create(null);
    const get = (key) => (Object.prototype.hasOwnProperty.call(candidate, key) ? candidate[key] : undefined);

    const put = (key, value) => {
        if (allowedKeys.has(key)) {
            record[key] = value;
        }
    };

    put('source', str(get('source'), 64));
    // Adapters validate opaque identifiers; display-text normalisation changes
    // valid Unicode paths and makes subsequent exact lookups fail.
    const id = get('id');
    put('id', typeof id === 'string' && id.length <= FIELD_LIMITS.id ? id : '');
    put('name', str(get('name'), FIELD_LIMITS.shortText));
    put('tagline', str(get('tagline'), FIELD_LIMITS.shortText));
    put('creator', str(get('creator'), FIELD_LIMITS.shortText));
    put('tags', tags(get('tags')));
    put('contentRating', CONTENT_RATINGS.includes(get('contentRating')) ? get('contentRating') : 'unknown');
    put('stats', stats(get('stats')));
    put('createdAt', isoOrNull(get('createdAt')));
    put('thumbUrl', urlOrNull(get('thumbUrl')));
    put('thumbRef', str(get('thumbRef'), 512) || null);
    put('pageUrl', urlOrNull(get('pageUrl')));
    put('importUrl', urlOrNull(get('importUrl')));
    put('nativeImport', get('nativeImport') === true);

    if (allowedKeys.has('description')) {
        put('description', str(get('description'), FIELD_LIMITS.longText));
        put('firstMessage', str(get('firstMessage'), FIELD_LIMITS.longText));
        put('creatorNotes', str(get('creatorNotes'), FIELD_LIMITS.longText));
        put('inside', inside(get('inside')));
    }

    // Object.create(null) has no prototype, which JSON.stringify handles fine but
    // some consumers dislike; hand back a normal object with the same own keys.
    return { ...record };
}

/**
 * Only absolute https URLs survive. The adapter built these from its own base,
 * so anything else means a bug rather than an attack — either way it is dropped.
 * @param {unknown} value
 */
function urlOrNull(value) {
    if (typeof value !== 'string' || value === '') {
        return null;
    }
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && (url.port === '' || url.port === '443')
            && url.username === '' && url.password === ''
            ? url.toString()
            : null;
    } catch {
        return null;
    }
}

/**
 * @param {Record<string, unknown>} candidate
 */
export function buildSummary(candidate) {
    return build(candidate, SUMMARY_KEYS);
}

/**
 * @param {Record<string, unknown>} candidate
 */
export function buildDetail(candidate) {
    return build(candidate, DETAIL_KEYS);
}
