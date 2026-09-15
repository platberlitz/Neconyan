/**
 * Character Tavern — https://character-tavern.com
 *
 * Search returns complete card bodies, so this uses the `inline` import mode
 * like Wyvern: the card is assembled from published fields and validated
 * exactly as a downloaded one would be.
 *
 * No thumbnails. Its image CDN (cards.character-tavern.com) answers 403 with a
 * bot-protection page to anything that is not a real browser session, and this
 * plugin will not forge Origin or Referer headers to get around a site's own
 * access control. Cards therefore render with the letter tile. That is a real
 * downgrade, stated here rather than worked around.
 *
 * There is no per-card endpoint either — /api/character/<id> is a 404 — but a
 * card's `path` is distinctive enough that searching for it finds the card
 * again, which is how detail and import look one up.
 */

import { buildSummary, buildDetail } from '../normalize.js';
import { clampInt, own } from '../validate.js';
import { pageCursor, MAX_PAGE } from '../paging.js';
import { UpstreamError } from '../guards.js';

const SITE = 'https://character-tavern.com';
const SEARCH = '/api/search/cards';

/** "author/slug", the stable identifier and page path in one. */
const PATH = /^(?=.{3,226}$)(?!.*[\u0000-\u001F\u007F])(?!\.{1,2}\/)(?![^/]+\/\.{1,2}$)(?!\s*\/)(?![^/]+\/\s*$)[^/]{1,64}\/[^/]{1,160}$/u;

/** Internal id, used only for the lorebook lookup. */
const CT_ID = /^CT_[0-9a-f]{16,64}(?:_\d{10,16})?$/i;

function pathOf(hit) {
    const path = own(hit, 'path');
    return typeof path === 'string' && PATH.test(path) ? path : null;
}

function pageUrl(path) {
    return `${SITE}/character/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function tagsOf(hit) {
    const out = [];
    const seen = new Set();
    for (const source of [own(hit, 'tags'), own(hit, 'contentWarnings')]) {
        if (!Array.isArray(source)) {
            continue;
        }
        for (const tag of source) {
            if (out.length >= 128) {
                return out;
            }
            if (typeof tag === 'string' && !seen.has(tag)) {
                seen.add(tag);
                out.push(tag);
            }
        }
    }
    return out;
}

/** Character Tavern rates its own content, which beats guessing from tags. */
function contentRating(hit, tags) {
    if (own(hit, 'isNSFW') === true) {
        return 'sensitive';
    }
    const lowered = tags.map((tag) => tag.toLowerCase());
    if (['nsfw', 'nsfl', 'gore', 'explicit'].some((flag) => lowered.includes(flag))) {
        return 'sensitive';
    }
    return own(hit, 'isNSFW') === false ? 'sfw' : 'unknown';
}

/** Unix seconds. */
function epochToIso(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return null;
    }
    const date = new Date(seconds * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function insideOf(hit) {
    const greetings = own(hit, 'alternativeFirstMessage');

    return {
        // hasLorebook is a flag, not a count; null means "present, size unknown".
        lorebookEntries: own(hit, 'hasLorebook') === true
            ? null
            : (own(hit, 'hasLorebook') === false ? 0 : null),
        alternateGreetings: Array.isArray(greetings) ? greetings.length : null,
        hasSystemPrompt: null,
        hasPostHistoryInstructions: reportedNonEmpty(hit, 'characterPostHistoryPrompt'),
        hasDepthPrompt: null,
        regexScripts: null,
        embeddedAssets: null,
        specVersion: 'chara_card_v2',
        originSite: 'Character Tavern',
    };
}

function nonEmpty(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function reportedNonEmpty(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key) ? nonEmpty(own(object, key)) : null;
}

function toRecord(hit, build) {
    const path = pathOf(hit);
    if (path === null) {
        return null;
    }

    const tags = tagsOf(hit);

    return build({
        source: 'charactertavern',
        id: path,
        name: own(hit, 'name') ?? own(hit, 'inChatName'),
        tagline: own(hit, 'tagline') ?? own(hit, 'pageDescription'),
        creator: own(hit, 'author'),
        tags,
        contentRating: contentRating(hit, tags),
        stats: {
            views: own(hit, 'messages'),
            downloads: own(hit, 'downloads'),
            favorites: own(hit, 'likes'),
            tokens: own(hit, 'totalTokens'),
        },
        createdAt: epochToIso(own(hit, 'createdAt')),
        // The image CDN blocks us; the letter tile stands in.
        thumbUrl: null,
        thumbRef: null,
        pageUrl: pageUrl(path),
        importUrl: null,
        nativeImport: false,
        description: own(hit, 'characterDefinition'),
        firstMessage: own(hit, 'characterFirstMessage'),
        creatorNotes: own(hit, 'pageDescription'),
        inside: insideOf(hit),
    });
}

function text(value) {
    return typeof value === 'string' ? value : '';
}

function stringList(value, cap = 32) {
    if (!Array.isArray(value)) {
        return [];
    }
    const out = [];
    for (const item of value) {
        if (out.length >= cap) {
            break;
        }
        if (typeof item === 'string') {
            out.push(item.slice(0, 4096));
        }
    }
    return out;
}

/**
 * Finds one card again by searching for its path. There is no per-card
 * endpoint, and the path is distinctive enough that this is reliable — but the
 * match is on id, never on position in the results.
 */
async function findByPath(ctx, path) {
    const url = new URL(SEARCH, SITE);
    url.searchParams.set('query', path);
    url.searchParams.set('limit', '20');
    url.searchParams.set('page', '1');

    const data = await ctx.fetchJson(url, { maxBytes: 6 << 20, timeoutMs: 12000 });
    const hits = own(data, 'hits');
    if (!Array.isArray(hits)) {
        return null;
    }

    return hits.find((hit) => pathOf(hit) === path) ?? null;
}

export const charactertavern = Object.freeze({
    id: 'charactertavern',
    label: 'Character Tavern',
    homepage: SITE,
    allowedHosts: Object.freeze(['character-tavern.com']),
    idPattern: PATH,
    tier: 2,
    nativeImport: false,
    capabilities: Object.freeze({
        search: true,
        query: true,
        paging: 'page',
        sorts: Object.freeze(['default']),
        sfwToggle: false,
        detail: true,
    }),

    async search(ctx, { query, cursor, limit }) {
        const perPage = clampInt(limit, 1, 48, 24);
        const page = pageCursor(cursor);

        const url = new URL(SEARCH, SITE);
        url.searchParams.set('query', typeof query === 'string' ? query.slice(0, 128) : '');
        url.searchParams.set('limit', String(perPage));
        url.searchParams.set('page', String(page));

        // Hits carry full card bodies, so a page is large.
        const data = await ctx.fetchJson(url, { maxBytes: 12 << 20, timeoutMs: 15000 });

        const raw = own(data, 'hits');
        const hits = Array.isArray(raw) ? raw.slice(0, perPage) : [];
        const rawTotal = own(data, 'totalHits');
        const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? Math.floor(rawTotal) : null;

        const items = hits.map((hit) => toRecord(hit, buildSummary)).filter((item) => item !== null);

        return {
            total,
            next: page < MAX_PAGE && hits.length > 0
                && (total === null ? hits.length >= perPage : page * perPage < total)
                ? { p: page + 1 }
                : null,
            items,
        };
    },

    async getDetail(ctx, id) {
        const hit = await findByPath(ctx, id);
        return hit === null
            ? buildDetail({ source: 'charactertavern', id })
            : toRecord(hit, buildDetail) ?? buildDetail({ source: 'charactertavern', id });
    },

    getImportTarget() {
        return { kind: 'inline', expect: 'json' };
    },

    async buildCard(ctx, id) {
        const hit = await findByPath(ctx, id);
        if (hit === null) {
            throw new UpstreamError('http_error', '404');
        }

        const data = {
            name: text(own(hit, 'name')) || text(own(hit, 'inChatName')) || 'Unnamed',
            description: text(own(hit, 'characterDefinition')),
            personality: text(own(hit, 'characterPersonality')),
            scenario: text(own(hit, 'characterScenario')),
            first_mes: text(own(hit, 'characterFirstMessage')),
            mes_example: text(own(hit, 'characterExampleMessages')),
            creator_notes: text(own(hit, 'pageDescription')),
            system_prompt: '',
            post_history_instructions: text(own(hit, 'characterPostHistoryPrompt')),
            alternate_greetings: stringList(own(hit, 'alternativeFirstMessage')),
            tags: stringList(tagsOf(hit)),
            creator: text(own(hit, 'author')),
            character_version: '',
            extensions: {},
        };

        // The lorebook lives behind a separate endpoint keyed by the internal id.
        const internalId = own(hit, 'id');
        if (own(hit, 'hasLorebook') === true && typeof internalId === 'string' && CT_ID.test(internalId)) {
            const entries = await fetchLorebook(ctx, internalId);
            if (entries.length > 0) {
                data.character_book = { name: `${data.name} lorebook`, entries };
            }
        }

        return { spec: 'chara_card_v2', spec_version: '2.0', data };
    },

    async probe(ctx) {
        const url = new URL(SEARCH, SITE);
        url.searchParams.set('query', '');
        url.searchParams.set('limit', '1');
        url.searchParams.set('page', '1');

        const data = await ctx.fetchJson(url, { maxBytes: 4 << 20, timeoutMs: 10000 });
        return Array.isArray(own(data, 'hits'));
    },
});

async function fetchLorebook(ctx, internalId) {
    try {
        const url = new URL(`/api/character/${encodeURIComponent(internalId)}/lorebook`, SITE);
        const book = await ctx.fetchJson(url, { maxBytes: 4 << 20, timeoutMs: 10000 });

        if (Array.isArray(book)) {
            return book;
        }
        const entries = own(book, 'entries');
        return Array.isArray(entries) ? entries : [];
    } catch (error) {
        // Character Tavern sometimes advertises a lorebook that was deleted.
        if (error instanceof UpstreamError && error.code === 'http_error' && error.detail === '404') {
            return [];
        }
        throw error;
    }
}
