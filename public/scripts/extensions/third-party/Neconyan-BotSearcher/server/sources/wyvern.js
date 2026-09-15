/**
 * Wyvern — https://app.wyvern.chat
 *
 * Wyvern publishes complete card data through its public browse API but offers
 * no downloadable card file: there is no /export, /download or /card.png. So
 * this adapter uses the `inline` import mode — it assembles a v2 card from the
 * published fields, and the router runs that through exactly the same
 * validation a downloaded card gets.
 *
 * Two things worth carrying faithfully rather than quietly dropping:
 * lorebooks and regex_scripts. Regex scripts rewrite messages as they pass
 * through, which is the closest a card comes to executable content, so they
 * are preserved in a bounded form but disabled until the user explicitly enables
 * them. Their count remains visible in the trust panel.
 *
 * Avatars are on Cloudflare Images, which accepts a flexible variant: `w=320`
 * returns 28 KB where the default `public` variant returns 82 KB.
 */

import { buildSummary, buildDetail } from '../normalize.js';
import { clampInt, own, hostCheckedUrl, isPlainObject } from '../validate.js';
import { mintRef } from '../refs.js';
import { pageCursor, MAX_PAGE } from '../paging.js';
import { UpstreamError } from '../guards.js';

const API = 'https://app.wyvern.chat';
const IMAGE_HOST = 'imagedelivery.net';

const ID = /^[A-Za-z0-9_-]{6,64}$/;

/** Cloudflare Images path: /<accountHash>/<imageId>/<variant> */
const CF_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

const PREVIEW_WIDTH = Object.freeze({ grid: 320, detail: 640 });
const MAX_SOURCE_TAGS = 128;
const MAX_LOREBOOKS = 16;
const MAX_LOREBOOK_ENTRIES = 128;
const MAX_REGEX_SCRIPTS = 32;

function idOf(character) {
    const id = own(character, 'id') ?? own(character, '_id');
    return typeof id === 'string' && ID.test(id) ? id : null;
}

function tagsOf(character) {
    const out = [];
    const seen = new Set();
    for (const key of ['tags', 'community_tags']) {
        const list = own(character, key);
        if (!Array.isArray(list)) {
            continue;
        }
        for (const tag of list) {
            if (out.length >= MAX_SOURCE_TAGS) {
                break;
            }
            if (typeof tag === 'string' && !seen.has(tag)) {
                seen.add(tag);
                out.push(tag);
            }
        }
        if (out.length >= MAX_SOURCE_TAGS) {
            break;
        }
    }
    return out;
}

function contentRating(character, tags) {
    const rating = own(character, 'rating');
    if (typeof rating === 'string' && ['nsfw', 'explicit', 'adult'].includes(rating.toLowerCase())) {
        return 'sensitive';
    }
    if (typeof rating === 'string' && ['sfw', 'safe', 'general'].includes(rating.toLowerCase())) {
        return 'sfw';
    }
    const lowered = tags.map((tag) => tag.toLowerCase());
    return ['nsfw', 'nsfl', 'gore', 'explicit', 'smut'].some((flag) => lowered.includes(flag))
        ? 'sensitive'
        : 'unknown';
}

function creatorOf(character) {
    const creator = own(character, 'creator');
    if (typeof creator === 'string') {
        return creator;
    }
    return own(creator, 'username') ?? own(creator, 'displayName') ?? own(creator, 'name') ?? '';
}

/**
 * Splits a Cloudflare Images URL into the two path segments we need, after
 * checking the host. Anything unexpected yields null rather than a guess.
 */
function imageRefOf(character) {
    const url = hostCheckedUrl(own(character, 'avatar'), [IMAGE_HOST]);
    if (url === null) {
        return null;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || !CF_SEGMENT.test(parts[0]) || !CF_SEGMENT.test(parts[1])) {
        return null;
    }
    return { c: parts[0], i: parts[1] };
}

function imageUrl(ref, size) {
    return `https://${IMAGE_HOST}/${ref.c}/${ref.i}/w=${PREVIEW_WIDTH[size] ?? PREVIEW_WIDTH.grid}`;
}

function lorebookEntries(lorebooks) {
    if (!Array.isArray(lorebooks)) {
        return null;
    }

    const out = [];
    for (const book of lorebooks.slice(0, MAX_LOREBOOKS)) {
        const entries = own(book, 'entries');
        if (Array.isArray(entries)) {
            for (const entry of entries) {
                appendLorebookEntry(out, entry);
                if (out.length >= MAX_LOREBOOK_ENTRIES) {
                    return out;
                }
            }
        } else if (isPlainObject(entries)) {
            for (const key in entries) {
                if (!Object.prototype.hasOwnProperty.call(entries, key)) {
                    continue;
                }
                appendLorebookEntry(out, entries[key]);
                if (out.length >= MAX_LOREBOOK_ENTRIES) {
                    return out;
                }
            }
        }
    }
    return out;
}

function appendLorebookEntry(out, value) {
    const entry = safeLorebookEntry(value);
    if (entry !== null) {
        out.push(entry);
    }
}

function safeLorebookEntry(value) {
    if (!isPlainObject(value)) {
        return null;
    }

    const entry = {};
    const keys = stringList(own(value, 'keys'), 32, 256);
    const secondaryKeys = stringList(own(value, 'secondary_keys'), 32, 256);
    if (keys.length > 0) {
        entry.keys = keys;
    }
    if (secondaryKeys.length > 0) {
        entry.secondary_keys = secondaryKeys;
    }
    for (const key of ['content', 'comment']) {
        const textValue = limitedText(own(value, key), 32768);
        if (textValue !== '') {
            entry[key] = textValue;
        }
    }
    for (const key of ['constant', 'selective', 'enabled']) {
        if (typeof own(value, key) === 'boolean') {
            entry[key] = own(value, key);
        }
    }
    for (const key of ['insertion_order', 'position']) {
        const number = own(value, key);
        if (Number.isSafeInteger(number) && number >= 0 && number <= 100000) {
            entry[key] = number;
        }
    }
    return Object.keys(entry).length > 0 ? entry : null;
}

function safeRegexScripts(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    const out = [];
    for (const raw of value) {
        if (out.length >= MAX_REGEX_SCRIPTS) {
            break;
        }
        if (!isPlainObject(raw)) {
            continue;
        }
        const findRegex = limitedText(own(raw, 'findRegex'), 2048);
        if (findRegex === '') {
            continue;
        }
        // Imported regexes are inert until the user explicitly enables them.
        out.push({
            scriptName: limitedText(own(raw, 'scriptName'), 128) || 'Imported regex',
            findRegex,
            replaceString: limitedText(own(raw, 'replaceString'), 8192),
            disabled: true,
        });
    }
    return out;
}

function insideOf(character) {
    const greetings = own(character, 'alternate_greetings') ?? own(character, 'greetings');
    const regex = own(character, 'regex_scripts');
    const gallery = own(character, 'gallery');

    return {
        lorebookEntries: lorebookEntries(own(character, 'lorebooks'))?.length ?? null,
        alternateGreetings: Array.isArray(greetings) ? greetings.length : null,
        hasSystemPrompt: reportedNonEmpty(character, 'pre_history_instructions'),
        hasPostHistoryInstructions: reportedNonEmpty(character, 'post_history_instructions'),
        hasDepthPrompt: reportedNonEmpty(character, 'character_note'),
        regexScripts: Array.isArray(regex) ? regex.length : null,
        embeddedAssets: Array.isArray(gallery) ? gallery.length : null,
        specVersion: 'chara_card_v2',
        originSite: 'Wyvern',
    };
}

function nonEmpty(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function reportedNonEmpty(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key) ? nonEmpty(own(object, key)) : null;
}

function toRecord(character, build) {
    const id = idOf(character);
    if (id === null) {
        return null;
    }

    const tags = tagsOf(character);
    const image = imageRefOf(character);

    return build({
        source: 'wyvern',
        id,
        name: own(character, 'name'),
        tagline: own(character, 'tagline'),
        creator: creatorOf(character),
        tags,
        contentRating: contentRating(character, tags),
        stats: {
            views: undefined,
            downloads: undefined,
            favorites: own(character, 'likes'),
            tokens: own(character, 'token_count'),
        },
        createdAt: own(character, 'created_at'),
        thumbUrl: image === null ? null : imageUrl(image, 'grid'),
        thumbRef: image === null ? null : mintRef('wyvern', image),
        pageUrl: `${API}/characters/${id}`,
        importUrl: null,
        nativeImport: false,
        description: own(character, 'description'),
        firstMessage: own(character, 'first_mes'),
        creatorNotes: own(character, 'creator_notes'),
        inside: insideOf(character),
    });
}

/** Only strings; anything else becomes an empty field rather than a surprise. */
function limitedText(value, maxLength = 32768) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function text(value) {
    return limitedText(value);
}

function stringList(value, cap = 32, maxLength = 4096) {
    if (!Array.isArray(value)) {
        return [];
    }
    const out = [];
    for (const item of value) {
        if (out.length >= cap) {
            break;
        }
        if (typeof item === 'string') {
            out.push(item.slice(0, maxLength));
        }
    }
    return out;
}

export const wyvern = Object.freeze({
    id: 'wyvern',
    label: 'Wyvern',
    homepage: API,
    allowedHosts: Object.freeze(['app.wyvern.chat', IMAGE_HOST]),
    idPattern: ID,
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
        const pageSize = clampInt(limit, 1, 48, 24);
        const page = pageCursor(cursor);
        const url = new URL('/api/characters/public', API);
        url.searchParams.set('limit', String(pageSize));
        url.searchParams.set('page', String(page));
        if (typeof query === 'string' && query !== '') {
            url.searchParams.set('search', query.slice(0, 128));
        }

        // Wyvern returns full card bodies, so a page is large.
        const data = await ctx.fetchJson(url, { maxBytes: 12 << 20, timeoutMs: 15000 });

        const raw = own(data, 'characters');
        const characters = Array.isArray(raw) ? raw.slice(0, pageSize) : [];
        const rawTotal = own(data, 'total');
        const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? Math.floor(rawTotal) : null;

        const items = characters.map((character) => toRecord(character, buildSummary)).filter((item) => item !== null);
        return {
            total,
            next: page < MAX_PAGE && characters.length > 0
                && (total === null ? characters.length >= pageSize : page * pageSize < total)
                ? { p: page + 1 }
                : null,
            items,
        };
    },

    async getDetail(ctx, id) {
        const character = await ctx.fetchJson(new URL(`/api/characters/${encodeURIComponent(id)}`, API), {
            maxBytes: 8 << 20,
            timeoutMs: 15000,
        });
        const raw = own(character, 'character') ?? character;
        if (idOf(raw) !== id) {
            throw new UpstreamError('bad_json', 'detail_id');
        }
        return toRecord(raw, buildDetail) ?? (() => { throw new UpstreamError('bad_json', 'detail_id'); })();
    },

    getImportTarget() {
        return { kind: 'inline', expect: 'json' };
    },

    /**
     * Assembles a v2 card. Every field is coerced to the type the spec expects,
     * so a hostile value cannot change the card's SHAPE — only its content,
     * which is the author's prerogative anyway.
     */
    async buildCard(ctx, id) {
        const raw = await ctx.fetchJson(new URL(`/api/characters/${encodeURIComponent(id)}`, API), {
            maxBytes: 8 << 20,
            timeoutMs: 15000,
        });
        const character = own(raw, 'character') ?? raw;
        if (idOf(character) !== id) {
            throw new UpstreamError('bad_json', 'detail_id');
        }

        const name = text(own(character, 'name')) || 'Unnamed';
        const lorebooks = own(character, 'lorebooks');

        const data = {
            name,
            description: text(own(character, 'description')),
            personality: text(own(character, 'personality')),
            scenario: text(own(character, 'scenario')),
            first_mes: text(own(character, 'first_mes')),
            mes_example: text(own(character, 'mes_example')),
            creator_notes: text(own(character, 'creator_notes')),
            system_prompt: text(own(character, 'pre_history_instructions')),
            post_history_instructions: text(own(character, 'post_history_instructions')),
            alternate_greetings: stringList(own(character, 'alternate_greetings') ?? own(character, 'greetings')),
            tags: stringList(tagsOf(character)),
            creator: text(creatorOf(character)),
            character_version: '',
            extensions: {},
        };

        const depthPrompt = text(own(character, 'character_note'));
        if (depthPrompt !== '') {
            data.extensions.depth_prompt = { prompt: depthPrompt };
        }

        const regex = safeRegexScripts(own(character, 'regex_scripts'));
        if (regex.length > 0) {
            data.extensions.regex_scripts = regex;
        }

        const entries = lorebookEntries(lorebooks) ?? [];
        if (entries.length > 0) {
            data.character_book = { name: `${name} lorebook`, entries };
        }

        return { spec: 'chara_card_v2', spec_version: '2.0', data };
    },

    thumbUrlFromRef(ref, size) {
        const account = own(ref, 'c');
        const image = own(ref, 'i');
        if (typeof account !== 'string' || !CF_SEGMENT.test(account)
            || typeof image !== 'string' || !CF_SEGMENT.test(image)) {
            throw new Error('bad_ref');
        }
        return imageUrl({ c: account, i: image }, size === 'detail' ? 'detail' : 'grid');
    },

    async probe(ctx) {
        const url = new URL('/api/characters/public', API);
        url.searchParams.set('limit', '1');
        const data = await ctx.fetchJson(url, { maxBytes: 4 << 20, timeoutMs: 10000 });
        return Array.isArray(own(data, 'characters'));
    },
});
