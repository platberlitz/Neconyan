/**
 * JannyAI — https://jannyai.com
 *
 * Search comes from JannyAI's public MeiliSearch index. Character pages and the
 * download API are Cloudflare-challenged from many servers, so this adapter
 * deliberately exposes listing metadata only and delegates imports to
 * Neconyan's existing Janny downloader.
 */

import { buildSummary } from '../normalize.js';
import { clampInt, own, pick } from '../validate.js';
import { mintRef } from '../refs.js';
import { pageCursor, MAX_PAGE } from '../paging.js';
import { UpstreamError } from '../guards.js';

const SEARCH = 'https://search.jannyai.com/multi-search';
const IMAGES = 'https://image.jannyai.com/bot-avatars';
const SITE = 'https://jannyai.com';
const IMPORT_SITE = 'https://janitorai.com';
const INDEX = 'janny-characters';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVATAR = /^[A-Za-z0-9_-]{1,180}\.(?:avif|gif|jpe?g|png|webp)$/i;
const SORTS = Object.freeze(['relevant', 'newest', 'oldest', 'tokens_desc', 'tokens_asc']);
const SORT_FIELDS = Object.freeze({
    newest: 'createdAtStamp:desc',
    oldest: 'createdAtStamp:asc',
    tokens_desc: 'totalToken:desc',
    tokens_asc: 'totalToken:asc',
});

const ATTRIBUTES = Object.freeze([
    'name',
    'id',
    'avatar',
    'tagIds',
    'isNsfw',
    'permanentToken',
    'totalToken',
    'isLowQuality',
    'createdAt',
    'createdAtStamp',
]);

const TAGS = new Map([
    [1, 'Male'], [2, 'Female'], [3, 'Non-binary'], [4, 'Celebrity'],
    [5, 'OC'], [6, 'Fictional'], [7, 'Real'], [8, 'Game'], [9, 'Anime'],
    [10, 'Historical'], [11, 'Royalty'], [12, 'Detective'], [13, 'Hero'],
    [14, 'Villain'], [15, 'Magical'], [16, 'Non-human'], [17, 'Monster'],
    [18, 'Monster Girl'], [19, 'Alien'], [20, 'Robot'], [21, 'Politics'],
    [22, 'Vampire'], [23, 'Giant'], [24, 'OpenAI'], [25, 'Elf'],
    [26, 'Multiple'], [27, 'VTuber'], [28, 'Dominant'], [29, 'Submissive'],
    [30, 'Scenario'], [31, 'Pokemon'], [32, 'Assistant'], [34, 'Non-English'],
    [36, 'Philosophy'], [38, 'RPG'], [39, 'Religion'], [41, 'Books'],
    [42, 'AnyPOV'], [43, 'Angst'], [44, 'Demi-Human'],
    [45, 'Enemies to Lovers'], [46, 'Smut'], [47, 'MLM'], [48, 'WLW'],
    [49, 'Action'], [50, 'Romance'], [51, 'Horror'], [52, 'Slice of Life'],
    [53, 'Fantasy'], [54, 'Drama'], [55, 'Comedy'], [56, 'Mystery'],
    [57, 'Sci-Fi'], [59, 'Yandere'], [60, 'Furry'], [61, 'Movies/TV'],
]);

const ENTITIES = Object.freeze({
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
});

function decodeEntity(match, name) {
    if (name.startsWith('#')) {
        const hexadecimal = name[1]?.toLowerCase() === 'x';
        const value = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        if (Number.isInteger(value) && value > 0 && value <= 0x10ffff
            && (value < 0xd800 || value > 0xdfff)) {
            return String.fromCodePoint(value);
        }
        return '';
    }

    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
}

/** Converts JannyAI's cropped HTML description into plain display text. */
function plainDescription(hit) {
    const formatted = own(hit, '_formatted');
    const raw = own(formatted, 'description');
    if (typeof raw !== 'string') {
        return '';
    }

    return raw
        .replace(/<br\s*\/?\s*>/gi, ' ')
        .replace(/<\/(?:div|h[1-6]|li|p)\s*>/gi, ' ')
        // Cropping can cut an HTML tag before its closing bracket.
        .replace(/<[^>]*(?:>|$)/g, ' ')
        .replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, decodeEntity)
        .replace(/\s+/g, ' ')
        .trim();
}

function slugOf(value) {
    if (typeof value !== 'string') {
        return 'character';
    }
    const slug = value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return slug || 'character';
}

function avatarOf(hit) {
    const value = own(hit, 'avatar');
    return typeof value === 'string' && AVATAR.test(value) ? value : null;
}

function avatarUrl(filename) {
    return `${IMAGES}/${filename}`;
}

function tagsOf(hit) {
    const ids = own(hit, 'tagIds');
    if (!Array.isArray(ids)) {
        return [];
    }
    return [...new Set(ids
        .filter((id) => Number.isSafeInteger(id) && TAGS.has(id))
        .map((id) => TAGS.get(id)))];
}

function createdAtOf(hit) {
    const value = own(hit, 'createdAt');
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
        return value;
    }
    const stamp = own(hit, 'createdAtStamp');
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) {
        return null;
    }
    const date = new Date(stamp * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function pageUrl(id, name, base = SITE) {
    return `${base}/characters/${id}_character-${slugOf(name)}`;
}

function toSummary(hit) {
    const id = own(hit, 'id');
    if (typeof id !== 'string' || !UUID.test(id)) {
        return null;
    }

    const name = own(hit, 'name');
    const avatar = avatarOf(hit);
    const isNsfw = own(hit, 'isNsfw');

    return buildSummary({
        source: 'jannyai',
        id,
        name,
        tagline: plainDescription(hit),
        creator: '',
        tags: tagsOf(hit),
        contentRating: isNsfw === true ? 'sensitive' : (isNsfw === false ? 'sfw' : 'unknown'),
        stats: { tokens: own(hit, 'totalToken') },
        createdAt: createdAtOf(hit),
        thumbUrl: avatar === null ? null : avatarUrl(avatar),
        thumbRef: avatar === null ? null : mintRef('jannyai', { a: avatar }),
        pageUrl: pageUrl(id, name),
        // Neconyan's Janny downloader dispatches on "janitorai" and extracts
        // the UUID; JannyAI's page URL is retained separately above.
        importUrl: pageUrl(id, name, IMPORT_SITE),
        nativeImport: true,
    });
}

function buildRequest({ query, cursor, limit, sort, sfwOnly }) {
    const perPage = clampInt(limit, 1, 48, 24);
    const page = pageCursor(cursor);
    const selectedSort = pick(sort, SORTS, 'relevant');
    const text = typeof query === 'string' ? query.trim().slice(0, 128) : '';
    const request = {
        indexUid: INDEX,
        q: text,
        attributesToRetrieve: ATTRIBUTES,
        attributesToCrop: ['description:32'],
        cropMarker: '...',
        attributesToHighlight: [],
        hitsPerPage: perPage,
        page,
    };
    if (sfwOnly === true) {
        request.filter = 'isNsfw = false';
    }
    if (selectedSort !== 'relevant') {
        request.sort = [SORT_FIELDS[selectedSort]];
    }
    return { body: JSON.stringify({ queries: [request] }), page, perPage };
}

function searchResult(data) {
    const results = own(data, 'results');
    const result = Array.isArray(results) ? results[0] : null;
    if (!result || own(result, 'indexUid') !== INDEX || !Array.isArray(own(result, 'hits'))) {
        throw new UpstreamError('bad_json', 'search_shape');
    }
    return result;
}

function nonNegativeInt(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseSearch(data, page, perPage) {
    const result = searchResult(data);
    const hits = own(result, 'hits').slice(0, perPage);
    const total = nonNegativeInt(own(result, 'totalHits'));
    const totalPages = nonNegativeInt(own(result, 'totalPages'));

    return {
        total,
        next: page < MAX_PAGE && hits.length > 0
            && (totalPages === null
                ? (total === null ? hits.length >= perPage : page * perPage < total)
                : page < totalPages)
            ? { p: page + 1 }
            : null,
        items: hits.map(toSummary).filter((item) => item !== null),
    };
}

export const jannyai = Object.freeze({
    id: 'jannyai',
    label: 'JannyAI',
    homepage: SITE,
    allowedHosts: Object.freeze(['search.jannyai.com', 'image.jannyai.com']),
    linkHosts: Object.freeze(['jannyai.com', 'janitorai.com']),
    idPattern: UUID,
    tier: 2,
    nativeImport: true,
    capabilities: Object.freeze({
        search: true,
        query: true,
        paging: 'page',
        sorts: SORTS,
        sfwToggle: true,
        detail: false,
        browserImport: true,
    }),

    async search(ctx, args) {
        const request = buildRequest(args);
        const data = await ctx.fetchJson(SEARCH, {
            method: 'POST',
            contentType: 'application/json',
            body: request.body,
            maxBytes: 2 << 20,
            timeoutMs: 10000,
        });
        return parseSearch(data, request.page, request.perPage);
    },

    getImportTarget(_ctx, id) {
        return { kind: 'url', url: pageUrl(id, 'character', IMPORT_SITE) };
    },

    thumbUrlFromRef(ref, _size) {
        const avatar = own(ref, 'a');
        if (typeof avatar !== 'string' || !AVATAR.test(avatar)) {
            throw new Error('bad_ref');
        }
        return avatarUrl(avatar);
    },

    async probe(ctx) {
        const request = buildRequest({ query: '', cursor: null, limit: 1, sort: 'newest', sfwOnly: true });
        const data = await ctx.fetchJson(SEARCH, {
            method: 'POST',
            contentType: 'application/json',
            body: request.body,
            maxBytes: 1 << 20,
            timeoutMs: 8000,
        });
        searchResult(data);
        return true;
    },
});
