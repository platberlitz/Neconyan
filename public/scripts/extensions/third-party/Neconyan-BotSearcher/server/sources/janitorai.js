/**
 * JanitorAI — https://janitorai.com
 *
 * JanitorAI's own front-page lists (popular, trending, latest). The site blocks
 * plain server requests, so the router hands this adapter a reader backed by
 * the server's signed-in JanitorAI browser window, the same one Beau uses.
 * JanitorAI has no public text search, so this source lists only.
 */

import { buildSummary } from '../normalize.js';
import { clampInt, own, pick } from '../validate.js';
import { mintRef } from '../refs.js';
import { indexedPageCursor } from '../paging.js';
import { UpstreamError } from '../guards.js';
import { FRONTPAGE_MAX_PAGE, JANITOR_ORIGIN as SITE, JANITOR_BACKUP_ORIGIN, JannyBrowserError } from '../janny-browser.js';
const IMAGES = 'https://ella.janitorai.com/bot-avatars';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVATAR = /^[A-Za-z0-9_-]{1,180}\.(?:avif|gif|jpe?g|png|webp)$/i;
const SORTS = Object.freeze(['trending_day', 'trending_week', 'popular', 'latest']);
const SECTIONS = Object.freeze({
    trending_day: 'trending24',
    trending_week: 'trending',
    popular: 'popular',
    latest: 'latest',
});
const MAX_UPSTREAM_ITEMS = 256;

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

/** JanitorAI descriptions are HTML; the card grid wants a short plain line. */
function plainDescription(item) {
    const raw = own(item, 'description');
    if (typeof raw !== 'string') {
        return '';
    }

    return raw
        .slice(0, 4000)
        .replace(/<br\s*\/?\s*>/gi, ' ')
        .replace(/<\/(?:div|h[1-6]|li|p)\s*>/gi, ' ')
        .replace(/<[^>]*(?:>|$)/g, ' ')
        .replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, decodeEntity)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
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

function pageUrl(id, name, origin = SITE) {
    return `${origin}/characters/${id}_character-${slugOf(name)}`;
}

function avatarOf(item) {
    const value = own(item, 'avatar');
    return typeof value === 'string' && AVATAR.test(value) ? value : null;
}

function avatarUrl(filename) {
    return `${IMAGES}/${filename}?width=400`;
}

function tagsOf(item) {
    const names = [];
    for (const list of [own(item, 'tags'), own(item, 'custom_tags')]) {
        if (!Array.isArray(list)) {
            continue;
        }
        for (const tag of list.slice(0, 40)) {
            const raw = typeof tag === 'string' ? tag : own(tag, 'name');
            // JanitorAI decorates its own tags with an emoji prefix.
            const name = typeof raw === 'string'
                ? raw.replace(/^[^\p{L}\p{N}]+/u, '').trim()
                : '';
            if (name) {
                names.push(name);
            }
        }
    }
    return [...new Set(names)];
}

function dateOf(item) {
    for (const key of ['first_published_at', 'created_at']) {
        const value = own(item, key);
        if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
            return value;
        }
    }
    return null;
}

function toSummary(item, origin) {
    const id = own(item, 'id');
    if (typeof id !== 'string' || !UUID.test(id)) {
        return null;
    }

    const name = own(item, 'name');
    const avatar = avatarOf(item);
    const isNsfw = own(item, 'is_nsfw');
    const creator = own(item, 'creator_name');
    const url = pageUrl(id, name, origin);

    return buildSummary({
        source: 'janitorai',
        id,
        name,
        tagline: plainDescription(item),
        creator: typeof creator === 'string' ? creator : '',
        tags: tagsOf(item),
        contentRating: isNsfw === true ? 'sensitive' : (isNsfw === false ? 'sfw' : 'unknown'),
        stats: {
            tokens: own(item, 'total_tokens'),
            views: own(own(item, 'stats'), 'chat'),
        },
        createdAt: dateOf(item),
        thumbUrl: avatar === null ? null : avatarUrl(avatar),
        thumbRef: avatar === null ? null : mintRef('janitorai', { a: avatar }),
        pageUrl: url,
        importUrl: url,
        nativeImport: true,
    });
}

function listOf(payload) {
    const list = own(payload, 'data');
    if (!Array.isArray(list)) {
        throw new UpstreamError('bad_json', 'search_shape');
    }
    return list.slice(0, MAX_UPSTREAM_ITEMS);
}

export const janitorai = Object.freeze({
    id: 'janitorai',
    label: 'JanitorAI',
    homepage: SITE,
    allowedHosts: Object.freeze(['ella.janitorai.com']),
    linkHosts: Object.freeze(['janitorai.com', 'jani.com']),
    idPattern: UUID,
    tier: 2,
    nativeImport: true,
    capabilities: Object.freeze({
        search: true,
        query: false,
        paging: 'page',
        sorts: SORTS,
        sfwToggle: true,
        detail: false,
        browserImport: true,
    }),

    async search(ctx, { cursor, limit, sort, sfwOnly }) {
        if (typeof ctx?.frontpage !== 'function') {
            throw new JannyBrowserError('janny_browser_unavailable', 503);
        }
        const perPage = clampInt(limit, 1, 48, 24);
        const { page, index } = indexedPageCursor(cursor);
        if (page > FRONTPAGE_MAX_PAGE) {
            return { total: null, next: null, items: [] };
        }
        const section = SECTIONS[pick(sort, SORTS, SORTS[0])];
        const payload = await ctx.frontpage(section, sfwOnly === true ? 'sfw' : 'all', page);
        const origin = own(payload, 'origin') === JANITOR_BACKUP_ORIGIN ? JANITOR_BACKUP_ORIGIN : SITE;
        const all = listOf(payload);
        const slice = all.slice(index, index + perPage);
        const consumed = index + slice.length;
        let next = null;
        if (consumed < all.length) {
            next = { p: page, i: consumed };
        } else if (all.length > 0 && page < FRONTPAGE_MAX_PAGE) {
            next = { p: page + 1, i: 0 };
        }
        return {
            total: null,
            next,
            items: slice.map((item) => toSummary(item, origin)).filter((item) => item !== null),
        };
    },

    getImportTarget(_ctx, id) {
        return { kind: 'url', url: pageUrl(id, 'character') };
    },

    thumbUrlFromRef(ref, _size) {
        const avatar = own(ref, 'a');
        if (typeof avatar !== 'string' || !AVATAR.test(avatar)) {
            throw new Error('bad_ref');
        }
        return avatarUrl(avatar);
    },
});
