/**
 * RisuRealm — https://realm.risuai.net
 *
 * The only source here with no JSON API. Its site is SvelteKit, so the data
 * behind the gallery is reachable through /__data.json in devalue encoding;
 * see devalue.js. That is genuinely fragile — a framework upgrade can change
 * the encoding silently — so this adapter is written to fail cleanly and let
 * the circuit breaker retire the source rather than to paper over breakage.
 *
 * Hosts:
 *   realm.risuai.net  the site and its data endpoint
 *   sv.risuai.xyz     images, served with NO content-type header at all, which
 *                     is why the thumbnail proxy sniffs magic bytes instead of
 *                     trusting the response
 */

import { buildSummary, buildDetail } from '../normalize.js';
import { clampInt, pick, own } from '../validate.js';
import { mintRef } from '../refs.js';
import { readSvelteKitData } from '../devalue.js';
import { indexedPageCursor, MAX_INDEXED_PAGE } from '../paging.js';
import { UpstreamError } from '../guards.js';

const SITE = 'https://realm.risuai.net';
const IMAGES = 'https://sv.risuai.xyz';

/** SvelteKit needs these or it answers with the HTML shell instead of data. */
const SVELTEKIT_PARAMS = Object.freeze({
    'x-sveltekit-trailing-slash': '1',
    'x-sveltekit-invalidated': '01',
});

const SORTS = Object.freeze(['recommended', 'download', 'newest', 'trending']);

/** The site has both newer UUID ids and legacy 64-character hex ids. */
const CHARACTER_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$/i;

/** Image references are content hashes. */
const IMAGE_HASH = /^[0-9a-f]{16,128}$/i;

function dataUrl(params = {}) {
    const url = new URL('/__data.json', SITE);
    for (const [key, value] of Object.entries({ ...SVELTEKIT_PARAMS, ...params })) {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    }
    return url;
}

function imageUrl(hash) {
    return `${IMAGES}/resource/${hash}`;
}

function hashOf(card) {
    const img = own(card, 'img');
    return typeof img === 'string' && IMAGE_HASH.test(img) ? img : null;
}

function tagsOf(card) {
    const tags = own(card, 'tags');
    return Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : [];
}

function contentRating(tags) {
    const lowered = tags.map((tag) => tag.toLowerCase());
    return ['nsfw', 'nsfl', 'gore', 'explicit', 'smut', 'hentai'].some((flag) => lowered.includes(flag))
        ? 'sensitive'
        : 'unknown';
}

/**
 * RisuRealm formats download counts for display ("2.8k"), so there is no exact
 * number to report. Expanding the abbreviation would invent precision that the
 * source did not provide, so it is reported as unknown instead.
 */
function toSummary(card) {
    const id = own(card, 'id');
    if (typeof id !== 'string' || !CHARACTER_ID.test(id)) {
        return null;
    }

    const tags = tagsOf(card);
    const hash = hashOf(card);

    return buildSummary({
        source: 'risurealm',
        id,
        name: own(card, 'name'),
        tagline: own(card, 'desc'),
        creator: own(card, 'authorname'),
        tags,
        contentRating: contentRating(tags),
        stats: { views: undefined, downloads: undefined, favorites: undefined, tokens: undefined },
        createdAt: null,
        thumbUrl: hash === null ? null : imageUrl(hash),
        thumbRef: hash === null ? null : mintRef('risurealm', { h: hash }),
        pageUrl: `${SITE}/character/${id}`,
        // parseRisuUrl (content-manager.js:1686) pulls the UUID back out.
        importUrl: `${SITE}/character/${id}`,
        nativeImport: true,
    });
}

function toDetail(card, id) {
    const tags = tagsOf(card);
    const hash = hashOf(card);

    return buildDetail({
        source: 'risurealm',
        id,
        name: own(card, 'name'),
        tagline: '',
        creator: own(card, 'authorname'),
        tags,
        contentRating: contentRating(tags),
        stats: { views: undefined, downloads: undefined, favorites: undefined, tokens: undefined },
        createdAt: null,
        thumbUrl: hash === null ? null : imageUrl(hash),
        thumbRef: hash === null ? null : mintRef('risurealm', { h: hash }),
        pageUrl: `${SITE}/character/${id}`,
        importUrl: `${SITE}/character/${id}`,
        nativeImport: true,
        description: own(card, 'desc'),
        firstMessage: '',
        creatorNotes: '',
        inside: {
            // The gallery exposes flags rather than counts.
            lorebookEntries: own(card, 'haslore') === true
                ? null
                : (own(card, 'haslore') === false ? 0 : null),
            alternateGreetings: null,
            hasSystemPrompt: null,
            hasPostHistoryInstructions: null,
            hasDepthPrompt: null,
            regexScripts: null,
            embeddedAssets: own(card, 'hasAsset') === true
                ? null
                : (own(card, 'hasAsset') === false ? 0 : null),
            specVersion: 'chara_card_v3',
            originSite: 'RisuRealm',
        },
    });
}

/**
 * Pulls the card list out of the decoded page data. RisuRealm has moved this
 * around before, so try the shapes we know rather than assuming one.
 */
function cardsFrom(root) {
    if (!root || typeof root !== 'object') {
        return [];
    }
    for (const key of ['cards', 'characters', 'data']) {
        const value = own(root, key);
        if (Array.isArray(value)) {
            return value;
        }
    }
    return [];
}

export const risurealm = Object.freeze({
    id: 'risurealm',
    label: 'RisuRealm',
    homepage: SITE,
    allowedHosts: Object.freeze(['realm.risuai.net', 'sv.risuai.xyz']),
    idPattern: CHARACTER_ID,
    tier: 1,
    nativeImport: true,
    /** Full-size art, measured around 1.4 MB; there is no preview endpoint. */
    maxThumbBytes: 4 * 1024 * 1024,
    capabilities: Object.freeze({
        search: true,
        query: true,
        paging: 'page',
        sorts: SORTS,
        // The gallery has an NSFW switch, but it is unreliable enough that
        // claiming it would be a lie; tags drive the blur instead.
        sfwToggle: false,
        detail: true,
    }),

    async search(ctx, { query, cursor, limit, sort }) {
        const perPage = clampInt(limit, 1, 48, 24);
        const { page, index } = indexedPageCursor(cursor);

        const url = dataUrl({
            page,
            q: typeof query === 'string' && query !== '' ? query.slice(0, 128) : undefined,
            sort: pick(sort, SORTS, 'recommended'),
        });

        const payload = await ctx.fetchJson(url, { maxBytes: 4 << 20, timeoutMs: 12000 });

        const root = readSvelteKitData(payload);
        if (root === null) {
            // The encoding changed, or we were served the HTML shell. Say so
            // plainly so the breaker retires the source.
            throw new UpstreamError('bad_json', 'risurealm');
        }

        const allCards = cardsFrom(root).slice(0, 256);
        const cards = allCards.slice(index, index + perPage);
        const items = cards.map(toSummary).filter((item) => item !== null);
        const consumed = index + cards.length;
        const next = cards.length === 0 && allCards.length === 0
            ? null
            : (consumed < allCards.length
                ? { p: page, i: consumed }
                : (page < MAX_INDEXED_PAGE ? { p: page + 1, i: 0 } : null));

        return {
            // RisuRealm reports no total.
            total: null,
            next,
            items,
        };
    },

    async getDetail(ctx, id) {
        const url = new URL(`/character/${encodeURIComponent(id)}/__data.json`, SITE);
        for (const [key, value] of Object.entries(SVELTEKIT_PARAMS)) {
            url.searchParams.set(key, value);
        }

        const payload = await ctx.fetchJson(url, { maxBytes: 6 << 20, timeoutMs: 12000 });
        const root = readSvelteKitData(payload);
        if (root === null) {
            throw new UpstreamError('bad_json', 'risurealm');
        }

        const card = own(root, 'card') ?? own(root, 'character') ?? root;
        if (own(card, 'id') !== id) {
            throw new UpstreamError('bad_json', 'detail_id');
        }
        return toDetail(card, id);
    },

    getImportTarget(_ctx, id) {
        return { kind: 'url', url: `${SITE}/character/${id}` };
    },

    thumbUrlFromRef(ref, _size) {
        const hash = own(ref, 'h');
        if (typeof hash !== 'string' || !IMAGE_HASH.test(hash)) {
            throw new Error('bad_ref');
        }
        return imageUrl(hash);
    },

    async probe(ctx) {
        const payload = await ctx.fetchJson(dataUrl({ page: 1 }), { maxBytes: 4 << 20, timeoutMs: 10000 });
        return cardsFrom(readSvelteKitData(payload)).length > 0;
    },
});
