/**
 * Saucepan — https://saucepan.ai
 *
 * Saucepan has no safe public catalogue endpoint. It is therefore a URL-import
 * source: the server accepts one exact companion URL, uses a profile-scoped
 * bearer, and assembles the authenticated definition into a v2 JSON card.
 */

import { own } from '../validate.js';
import { UpstreamError } from '../guards.js';

const BASE = 'https://saucepan.ai';
const COMPANION_PATH = '/companion/';
const COMPANION_ID = /^[a-f0-9-]{8,64}$/i;

const REQUEST_HEADERS = Object.freeze({
    Origin: BASE,
    Referer: `${BASE}/`,
    'x-saucepan-client-version': '1',
});

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function rotl(value, bits) {
    return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function fragmentHash(mask, derivedKey, text) {
    let hash = (FNV_OFFSET ^ rotl(mask, 7) ^ rotl(derivedKey, 13)) >>> 0;
    for (const byte of new TextEncoder().encode(text)) {
        hash ^= byte;
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    return hash >>> 0;
}

/** Reassembles real fragments and drops Saucepan's decoys. */
export function assembleFragments(content) {
    const fragments = Array.isArray(content?.fragments) ? content.fragments : [];
    const mask = (content?.mask ?? 0) >>> 0;
    return fragments
        .filter((fragment) => {
            if (!fragment || typeof fragment.text !== 'string' || !Number.isInteger(fragment.key)) {
                return false;
            }
            const derivedKey = (fragment.key ^ mask) >>> 0;
            return fragmentHash(mask, derivedKey, fragment.text) === (fragment.proof >>> 0);
        })
        .sort((left, right) => ((left.key ^ mask) >>> 0) - ((right.key ^ mask) >>> 0))
        .map((fragment) => fragment.text)
        .join('');
}

/**
 * Accepts only https://saucepan.ai/companion/<id>, without query or fragment.
 * @returns {{ id: string, url: string } | null}
 */
export function parseCompanionUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 512) {
        return null;
    }
    let url;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'saucepan.ai'
        || (url.port !== '' && url.port !== '443')
        || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
        return null;
    }
    const match = url.pathname.match(/^\/companion\/([a-f0-9-]{8,64})\/?$/i);
    if (!match || !COMPANION_ID.test(match[1])) {
        return null;
    }
    return { id: match[1], url: `${BASE}${COMPANION_PATH}${match[1]}` };
}

function text(value, max = 32768) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function stringList(value, maxItems = 64) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter((item) => typeof item === 'string')
        .slice(0, maxItems)
        .map((item) => item.slice(0, 32768));
}

function greetingsOf(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .slice(0, 32)
        .map((scenario) => assembleFragments(own(scenario, 'message')))
        .filter((greeting) => greeting.trim() !== '');
}

function sectionText(sections, title) {
    const section = sections.find((candidate) => candidate?.title === title);
    return section?.content ? assembleFragments(section.content) : '';
}

function companionOf(payload) {
    return own(payload, 'companion') ?? payload;
}

export const saucepan = Object.freeze({
    id: 'saucepan',
    label: 'Saucepan.ai',
    homepage: BASE,
    allowedHosts: Object.freeze(['saucepan.ai']),
    idPattern: COMPANION_ID,
    authHost: 'saucepan.ai',
    requestHeaders: REQUEST_HEADERS,
    tier: 2,
    nativeImport: false,
    capabilities: Object.freeze({
        search: false,
        query: false,
        paging: 'none',
        sorts: Object.freeze(['default']),
        sfwToggle: false,
        detail: false,
        accountLogin: true,
        urlImport: true,
    }),

    async login(ctx, handle, password) {
        const data = await ctx.fetchJson(new URL('/api/v1/auth/sign_in_password', BASE), {
            method: 'POST',
            contentType: 'application/json',
            body: JSON.stringify({ handle, password }),
            headers: { Referer: `${BASE}/sign-in` },
            maxBytes: 256 * 1024,
            timeoutMs: 12000,
        });
        const token = own(data, 'token')
            ?? own(data, 'access_token')
            ?? own(data, 'session_token')
            ?? own(data, 'sessionToken');
        return typeof token === 'string' ? token : null;
    },

    async buildCard(ctx, id) {
        const [definition, metadata] = await Promise.all([
            ctx.fetchJson(new URL(`/api/v1/companion/definition?companion_id=${encodeURIComponent(id)}`, BASE), {
                maxBytes: 6 << 20,
                timeoutMs: 15000,
            }),
            ctx.fetchJson(new URL(`/api/v2/companions/${encodeURIComponent(id)}`, BASE), {
                maxBytes: 6 << 20,
                timeoutMs: 15000,
            }),
        ]);

        const rawSections = own(definition, 'sections');
        const sections = Array.isArray(rawSections) ? rawSections.slice(0, 32) : [];
        const companion = companionOf(metadata);
        if (!companion || typeof companion !== 'object') {
            throw new UpstreamError('bad_json', 'companion_shape');
        }

        const greetings = greetingsOf(own(companion, 'starting_scenarios_fragments'));
        const description = sectionText(sections, 'Companion Core')
            || assembleFragments(own(companion, 'full_description_fragments'));
        const notes = [
            text(own(companion, 'short_description'), 32768),
            sectionText(sections, 'Advanced Prompt') ? `--- Advanced Prompt ---\n${sectionText(sections, 'Advanced Prompt')}` : '',
            sectionText(sections, 'Response Formatting Instructions')
                ? `--- Response Formatting ---\n${sectionText(sections, 'Response Formatting Instructions')}` : '',
        ].filter(Boolean).join('\n\n');
        return {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: text(own(companion, 'display_name') ?? own(companion, 'name'), 200) || 'Unnamed',
                description: text(description),
                personality: '',
                scenario: '',
                first_mes: greetings[0] ?? '',
                mes_example: sectionText(sections, 'Example Dialogue'),
                creator_notes: notes,
                system_prompt: '',
                post_history_instructions: '',
                alternate_greetings: greetings.slice(1),
                tags: stringList(own(companion, 'tags'), 32),
                creator: text(own(companion, 'creator') ?? own(companion, 'handle'), 200),
                character_version: '',
                extensions: {},
            },
        };
    },

    getImportTarget(_ctx, _id) {
        return { kind: 'inline', expect: 'json' };
    },

    parseImportUrl(raw) {
        return parseCompanionUrl(raw);
    },

    async probe() {
        return true;
    },
});
