/**
 * Pygmalion — https://pygmalion.chat
 *
 * A Connect-RPC API, which over GET is just JSON in a query parameter:
 *   /galatea.v1.PublicCharacterService/<Method>?connect=v1&encoding=json&message=<json>
 *
 * Hosts:
 *   server.pygmalion.chat  the RPC API we call
 *   assets.pygmalion.chat  avatars the thumbnail proxy fetches
 *   pygmalion.chat         the page and import URL, which we never contact —
 *                          Neconyan's importer pulls the UUID out of it
 *                          (content-manager.js:1640).
 *
 * Unlike the other adapters this one cannot rebuild its avatar URL from the
 * character id: the avatar lives under an unrelated asset UUID. So the upstream
 * value is used, but only after its host is checked against the allow-list, and
 * only the asset id travels in the thumbnail ref.
 */

import { buildSummary, buildDetail } from '../normalize.js';
import { clampInt, pick, own, hostCheckedUrl } from '../validate.js';
import { mintRef } from '../refs.js';
import { pageCursor } from '../paging.js';
import { UpstreamError } from '../guards.js';

const API = 'https://server.pygmalion.chat';
const SERVICE = 'galatea.v1.PublicCharacterService';
const ASSETS_HOST = 'assets.pygmalion.chat';
const SITE = 'https://pygmalion.chat';

const SORTS = Object.freeze([
    'approved_at',
    'trending',
    'stars',
    'downloads',
    'views',
    'chatCount',
    'createdAt',
    'updatedAt',
    'token_count',
    'display_name',
    'random',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Asset ids are UUIDs too; anything else is refused rather than fetched. */
const ASSET_ID = /^[0-9a-f-]{8,64}$/i;

/**
 * Builds a Connect-RPC GET URL. `message` is our own object, JSON-encoded by us
 * — never a string that came from upstream.
 */
function rpcUrl(method, message) {
    const url = new URL(`/${SERVICE}/${method}`, API);
    url.searchParams.set('connect', 'v1');
    url.searchParams.set('encoding', 'json');
    url.searchParams.set('message', JSON.stringify(message));
    return url;
}

/**
 * Extracts the asset id from an upstream avatar URL, after checking the host.
 * @returns {string | null}
 */
function assetIdOf(character) {
    const url = hostCheckedUrl(own(character, 'avatarUrl'), [ASSETS_HOST]);
    if (url === null) {
        return null;
    }
    const id = url.pathname.replace(/^\/+/, '');
    return ASSET_ID.test(id) ? id : null;
}

function assetUrl(assetId) {
    return `https://${ASSETS_HOST}/${assetId}`;
}

/** Unix seconds, as a string, in every timestamp field Pygmalion returns. */
function epochToIso(value) {
    const seconds = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return null;
    }
    const date = new Date(seconds * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function tagsOf(character) {
    const tags = own(character, 'tags');
    return Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string') : [];
}

/**
 * Pygmalion has no per-card adult flag on the public listing; `includeSensitive`
 * is a request-side filter only. Positive tags are sensitive; untagged cards
 * remain unknown because the source can misapply or ignore a request filter.
 */
function contentRating(tags) {
    const lowered = tags.map((tag) => tag.toLowerCase());
    return ['nsfw', 'nsfl', 'gore', 'explicit', 'smut'].some((flag) => lowered.includes(flag))
        ? 'sensitive'
        : 'unknown';
}

function creatorOf(character) {
    const owner = own(character, 'owner');
    return own(owner, 'displayName') ?? own(owner, 'username') ?? '';
}

function toSummary(character) {
    const id = own(character, 'id');
    if (typeof id !== 'string' || !UUID.test(id)) {
        return null;
    }

    const tags = tagsOf(character);
    const assetId = assetIdOf(character);

    return buildSummary({
        source: 'pygmalion',
        id,
        name: own(character, 'displayName'),
        tagline: own(character, 'description'),
        creator: creatorOf(character),
        tags,
        contentRating: contentRating(tags),
        stats: {
            views: own(character, 'views'),
            downloads: own(character, 'stars'),
            favorites: own(character, 'chatCount'),
            tokens: own(character, 'personalityTokenCount'),
        },
        createdAt: epochToIso(own(character, 'createdAt')),
        thumbUrl: assetId === null ? null : assetUrl(assetId),
        thumbRef: assetId === null ? null : mintRef('pygmalion', { a: assetId }),
        pageUrl: `${SITE}/character/${id}`,
        // getUuidFromUrl (content-manager.js) pulls the UUID back out of this.
        importUrl: `${SITE}/character/${id}`,
        nativeImport: true,
    });
}

function toDetail(payload, id) {
    const character = own(payload, 'character') ?? payload;
    const personality = own(character, 'personality');
    const tags = tagsOf(character);
    const assetId = assetIdOf(character);

    return buildDetail({
        source: 'pygmalion',
        id,
        name: own(character, 'displayName'),
        tagline: own(character, 'description'),
        creator: creatorOf(character) || own(personality, 'creator'),
        tags,
        contentRating: contentRating(tags),
        stats: {
            views: own(character, 'views'),
            downloads: own(character, 'stars'),
            favorites: own(character, 'chatCount'),
            tokens: own(character, 'personalityTokenCount'),
        },
        createdAt: epochToIso(own(character, 'createdAt')),
        thumbUrl: assetId === null ? null : assetUrl(assetId),
        thumbRef: assetId === null ? null : mintRef('pygmalion', { a: assetId }),
        pageUrl: `${SITE}/character/${id}`,
        importUrl: `${SITE}/character/${id}`,
        nativeImport: true,
        // The card body lives in `personality.persona`; `description` is a blurb.
        description: own(personality, 'persona') ?? own(character, 'description'),
        firstMessage: own(personality, 'greeting'),
        creatorNotes: '',
        inside: {
            // Pygmalion's public API exposes no lorebook or prompt-override
            // fields, so these are reported as unknown rather than guessed at.
            lorebookEntries: null,
            // `versions` contains revision metadata, not alternative greetings.
            alternateGreetings: null,
            hasSystemPrompt: null,
            hasPostHistoryInstructions: null,
            hasDepthPrompt: null,
            regexScripts: null,
            embeddedAssets: null,
            specVersion: null,
            originSite: own(character, 'source') || 'Pygmalion',
        },
    });
}

export const pygmalion = Object.freeze({
    id: 'pygmalion',
    label: 'Pygmalion',
    homepage: SITE,
    allowedHosts: Object.freeze(['server.pygmalion.chat', ASSETS_HOST]),
    linkHosts: Object.freeze(['pygmalion.chat']),
    idPattern: UUID,
    tier: 1,
    nativeImport: true,
    /**
     * Pygmalion has no preview endpoint and its CDN ignores width/resize
     * parameters, so a grid tile costs a full-resolution avatar: measured 42 KB
     * to 4.3 MB, median around 1.3 MB. The default 512 KB cap dropped three
     * quarters of them. This is genuinely expensive in proxy mode; users on a
     * small server or metered connection should prefer "No thumbnails".
     */
    maxThumbBytes: 5 * 1024 * 1024,
    capabilities: Object.freeze({
        search: true,
        query: true,
        paging: 'page',
        sorts: SORTS,
        sfwToggle: true,
        detail: true,
    }),

    async search(ctx, { query, cursor, limit, sort, sfwOnly }) {
        const pageSize = clampInt(limit, 1, 48, 24);
        const pageNumber = pageCursor(cursor, { first: 0, max: 999 });

        const message = {
            orderBy: pick(sort, SORTS, 'approved_at'),
            orderDescending: true,
            includeSensitive: sfwOnly !== true,
            pageSize,
            // The Connect schema calls this field `page`; unknown JSON fields
            // are silently ignored, so the former `pageNumber` repeated page 0.
            page: pageNumber,
        };
        if (typeof query === 'string' && query.trim() !== '') {
            message.query = query.trim().slice(0, 128);
        }

        const data = await ctx.fetchJson(rpcUrl('CharacterSearch', message), { maxBytes: 4 << 20, timeoutMs: 10000 });

        const raw = own(data, 'characters');
        const characters = Array.isArray(raw) ? raw.slice(0, pageSize) : [];
        // totalItems arrives as a string.
        const totalRaw = Number(own(data, 'totalItems'));
        const total = Number.isFinite(totalRaw) && totalRaw >= 0 ? Math.floor(totalRaw) : null;

        const items = characters.map(toSummary).filter((item) => item !== null);

        return {
            total,
            next: pageNumber < 999 && characters.length > 0
                && (total === null ? characters.length >= pageSize : (pageNumber + 1) * pageSize < total)
                ? { p: pageNumber + 1 }
                : null,
            items,
        };
    },

    async getDetail(ctx, id) {
        const url = rpcUrl('Character', { characterMetaId: id, characterVersionId: '' });
        const data = await ctx.fetchJson(url, { maxBytes: 6 << 20, timeoutMs: 12000 });
        const character = own(data, 'character') ?? data;
        if (own(character, 'id') !== id) {
            throw new UpstreamError('bad_json', 'detail_id');
        }
        return toDetail(data, id);
    },

    getImportTarget(_ctx, id) {
        return { kind: 'url', url: `${SITE}/character/${id}` };
    },

    thumbUrlFromRef(ref, _size) {
        const assetId = own(ref, 'a');
        if (typeof assetId !== 'string' || !ASSET_ID.test(assetId)) {
            throw new Error('bad_ref');
        }
        // One asset size is served; grid and detail share it.
        return assetUrl(assetId);
    },

    async probe(ctx) {
        const url = rpcUrl('CharacterSearch', { orderBy: 'approved_at', orderDescending: true, includeSensitive: false, pageSize: 1, page: 0 });
        const data = await ctx.fetchJson(url, { maxBytes: 1 << 20, timeoutMs: 8000 });
        return Array.isArray(own(data, 'characters'));
    },
});
