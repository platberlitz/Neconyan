import assert from 'node:assert/strict';
import { test } from 'node:test';

const SERVER = '../public/scripts/extensions/third-party/Neconyan-BotSearcher/server';
const { createJannyBrowser, JannyBrowserError } = await import(`${SERVER}/janny-browser.js`);
const { janitorai } = await import(`${SERVER}/sources/janitorai.js`);
const { getSource } = await import(`${SERVER}/registry.js`);

const ID = 'd9e73da5-e776-4a89-8863-fb1a4b4bbf4d';
const PRIMARY = 'https://janitorai.com';
const BACKUP = 'https://jani.com';

function character(index, extra = {}) {
    const hex = index.toString(16).padStart(12, '0');
    return {
        id: `d9e73da5-e776-4a89-8863-${hex}`,
        name: `Character ${index}`,
        avatar: `avatar-${index}.webp`,
        creator_name: 'Maker',
        description: '<p>Hello &amp; <b>welcome</b></p>',
        is_nsfw: false,
        stats: { chat: 1200, message: 9000 },
        total_tokens: 1500,
        tags: [{ name: '🧝 Fantasy' }],
        custom_tags: ['Elf'],
        first_published_at: '2026-11-01T10:00:00Z',
        ...extra,
    };
}

const HOUR = 60 * 60 * 1000;

function fakeBrowser({ payload = () => ({ data: [character(1)] }), clock, session = () => Date.now() + HOUR, sessionWaitMs } = {}) {
    const reads = [];
    const probes = [];
    const visits = [];
    const origins = [];
    let currentUrl = PRIMARY;
    const page = {
        url: () => currentUrl,
        goto: async (url) => {
            visits.push(url);
            currentUrl = url;
        },
        setDefaultTimeout: () => {},
        close: async () => {},
        context: () => ({ on: () => {}, off: () => {} }),
        evaluate: async (_fn, arg) => {
            if (arg?.origin) assert.equal(arg.origin, new URL(currentUrl).origin);
            if (arg?.probe) {
                probes.push(visits.length);
                return { expiresAt: session(probes.length, visits.length, arg.origin) };
            }
            if (typeof arg?.target !== 'string') {
                return null;
            }
            const url = new URL(arg.target);
            origins.push(url.origin);
            reads.push(Object.fromEntries(url.searchParams));
            const body = payload(url);
            return body instanceof Error ? { status: 403, body: '' } : { status: 200, body: JSON.stringify(body) };
        },
    };
    const browser = createJannyBrowser({
        profileDir: '/tmp/opencode/janitorai-test-profile',
        launchContext: async () => ({ pages: () => [page], newPage: async () => page, on: () => {}, close: async () => {} }),
        now: clock ?? Date.now,
        ...(sessionWaitMs === undefined ? {} : { sessionWaitMs }),
    });
    return { browser, reads, probes, visits, origins };
}

test('JanitorAI front page reads ask for the right list and page', async () => {
    const { browser, reads } = fakeBrowser();
    await browser.frontpage('trending24', 'sfw', 3);
    await browser.frontpage('popular', 'all', 1);
    assert.equal(reads.length, 2);
    assert.equal(reads[0].special_mode, 'trending24');
    assert.equal(reads[0].mode, 'sfw');
    assert.equal(reads[0].page, '3');
    assert.equal(reads[0].sort, undefined);
    assert.equal(reads[1].sort, 'popular');
    assert.equal(reads[1].page, '1');
    await assert.rejects(browser.frontpage('favorites'), /Unsupported/);
    await assert.rejects(browser.frontpage('popular', 'all', 0), /Unsupported/);
    await assert.rejects(browser.frontpage('popular', 'all', 51), /Unsupported/);
});

test('one five-minute copy of each list is shared between readers', async () => {
    let time = 1_000_000;
    const { browser, reads } = fakeBrowser({ clock: () => time });
    const [first, second] = await Promise.all([browser.frontpage('latest'), browser.frontpage('latest')]);
    assert.deepEqual(first, second);
    assert.equal(reads.length, 1, 'parallel readers share one browser read');

    time += 4 * 60 * 1000;
    await browser.frontpage('latest');
    assert.equal(reads.length, 1, 'still fresh after four minutes');

    await browser.frontpage('latest', 'sfw');
    await browser.frontpage('latest', 'all', 2);
    assert.equal(reads.length, 3, 'each mode and page has its own copy');

    time += 2 * 60 * 1000;
    await browser.frontpage('latest');
    assert.equal(reads.length, 4, 'expired after five minutes');
});

test('a failed list read is not kept', async () => {
    let fail = true;
    const { browser, reads } = fakeBrowser({ payload: () => (fail ? new Error('blocked') : { data: [] }) });
    await assert.rejects(browser.frontpage('popular'), (error) => {
        assert.ok(error instanceof JannyBrowserError);
        assert.equal(error.code, 'janny_login_required');
        assert.equal(error.status, 401);
        return true;
    });
    fail = false;
    assert.deepEqual(await browser.frontpage('popular'), { data: [], origin: PRIMARY });
    assert.equal(reads.length, 3);
});

test('a failed primary read uses the signed-in backup and links the resulting cards there', async () => {
    const { browser, origins, visits } = fakeBrowser({
        payload: (url) => url.origin === PRIMARY ? new Error('blocked') : { data: [character(1)], origin: PRIMARY },
    });
    const result = await janitorai.search({ frontpage: browser.frontpage }, { sort: 'popular' });
    assert.deepEqual(origins, [PRIMARY, BACKUP]);
    assert.deepEqual(visits, [BACKUP]);
    assert.equal(result.items[0].pageUrl, `${BACKUP}/characters/${character(1).id}_character-character-1`);
    assert.equal(result.items[0].importUrl, result.items[0].pageUrl);
    await browser.frontpage('latest');
    assert.deepEqual(origins, [PRIMARY, BACKUP, BACKUP]);
});

// JanitorAI answers an expired or missing token with its signed-out list and
// HTTP 200, so the list must wait for a live session rather than trust 200.
test('a list waits until a freshly launched browser has renewed its session', async () => {
    const { browser, reads, probes } = fakeBrowser({
        session: (probe) => (probe < 3 ? Date.now() - HOUR : Date.now() + HOUR),
    });
    await browser.frontpage('trending24');
    assert.equal(probes.length, 3);
    assert.equal(reads.length, 1, 'the list is read once, after the session renewed');
});

test('a token about to expire counts as expired', async () => {
    const { browser, reads, probes } = fakeBrowser({
        session: (probe) => Date.now() + (probe === 1 ? 30 * 1000 : HOUR),
    });
    await browser.frontpage('trending24');
    assert.equal(probes.length, 2);
    assert.equal(reads.length, 1);
});

test('a session that is never renewed asks for a login and is not cached', async () => {
    let renewed = false;
    const { browser, reads, visits } = fakeBrowser({
        session: (_probe, _visits, origin) => origin === BACKUP ? null : Date.now() + (renewed ? HOUR : -HOUR),
        sessionWaitMs: 1500,
    });
    await assert.rejects(browser.frontpage('trending24'), (error) => {
        assert.ok(error instanceof JannyBrowserError);
        assert.equal(error.code, 'janny_login_required');
        assert.equal(error.status, 401);
        return true;
    });
    assert.equal(reads.length, 0, 'no signed-out list is read');
    assert.deepEqual(visits, [PRIMARY, BACKUP], 'the primary site is loaded again once to start renewal, then the backup is checked');
    renewed = true;
    await browser.frontpage('trending24');
    assert.equal(reads.length, 1, 'the next request reads the list instead of a kept failure');
});

test('a browser with no session asks for a login without the full wait', async () => {
    const { browser, reads, visits } = fakeBrowser({ session: () => null, sessionWaitMs: 60 * 1000 });
    const started = Date.now();
    await assert.rejects(browser.frontpage('popular'), (error) => error.code === 'janny_login_required');
    assert.ok(Date.now() - started < 5000);
    assert.equal(reads.length, 0);
    assert.deepEqual(visits, [BACKUP]);
});

test('JanitorAI is registered as a list-only source', () => {
    assert.equal(getSource('janitorai'), janitorai);
    assert.equal(janitorai.capabilities.query, false);
    assert.equal(janitorai.capabilities.search, true);
    assert.equal(janitorai.capabilities.sfwToggle, true);
    assert.deepEqual([...janitorai.capabilities.sorts], ['trending_day', 'trending_week', 'popular', 'latest']);
    assert.deepEqual([...janitorai.allowedHosts], ['ella.janitorai.com']);
});

test('JanitorAI search maps sorts, the SFW toggle and cards', async () => {
    const calls = [];
    const ctx = {
        frontpage: async (section, mode, page) => {
            calls.push([section, mode, page]);
            return { data: [character(1), character(2, { is_nsfw: true }), { id: 'not-a-uuid' }] };
        },
    };
    const result = await janitorai.search(ctx, { cursor: null, limit: 24, sort: 'trending_week', sfwOnly: true });
    assert.deepEqual(calls, [['trending', 'sfw', 1]]);
    assert.equal(result.total, null);
    assert.deepEqual(result.next, { p: 2, i: 0 });
    assert.equal(result.items.length, 2);

    const [card, sensitive] = result.items;
    assert.equal(card.source, 'janitorai');
    assert.equal(card.name, 'Character 1');
    assert.equal(card.creator, 'Maker');
    assert.equal(card.tagline, 'Hello & welcome');
    assert.deepEqual(card.tags, ['Fantasy', 'Elf']);
    assert.equal(card.contentRating, 'sfw');
    assert.equal(card.stats.tokens, 1500);
    assert.equal(card.stats.views, 1200);
    assert.equal(card.thumbUrl, 'https://ella.janitorai.com/bot-avatars/avatar-1.webp?width=400');
    assert.equal(card.pageUrl, `https://janitorai.com/characters/${card.id}_character-character-1`);
    assert.equal(card.importUrl, card.pageUrl);
    assert.equal(sensitive.contentRating, 'sensitive');

    await janitorai.search(ctx, { cursor: null, limit: 24, sort: 'unknown', sfwOnly: false });
    assert.deepEqual(calls.at(-1), ['trending24', 'all', 1], 'unknown sorts fall back to Trending 24h');
    await janitorai.search(ctx, { cursor: null, limit: 24, sort: 'popular' });
    assert.deepEqual(calls.at(-1), ['popular', 'all', 1]);
});

test('JanitorAI paging walks through each upstream page before the next', async () => {
    const pages = new Map([[1, 34], [2, 0]]);
    const ctx = {
        frontpage: async (_section, _mode, page) => ({
            data: Array.from({ length: pages.get(page) ?? 0 }, (_, index) => character(page * 100 + index)),
        }),
    };
    const first = await janitorai.search(ctx, { cursor: null, limit: 24, sort: 'latest' });
    assert.equal(first.items.length, 24);
    assert.deepEqual(first.next, { p: 1, i: 24 });
    const second = await janitorai.search(ctx, { cursor: first.next, limit: 24, sort: 'latest' });
    assert.equal(second.items.length, 10);
    assert.deepEqual(second.next, { p: 2, i: 0 });
    const third = await janitorai.search(ctx, { cursor: second.next, limit: 24, sort: 'latest' });
    assert.deepEqual(third.items, []);
    assert.equal(third.next, null);
});

test('JanitorAI search without the browser reader says the browser is missing', async () => {
    await assert.rejects(janitorai.search({}, { cursor: null, limit: 24 }), (error) => {
        assert.ok(error instanceof JannyBrowserError);
        assert.equal(error.code, 'janny_browser_unavailable');
        return true;
    });
    await assert.rejects(janitorai.search({ frontpage: async () => ({ nope: true }) }, { cursor: null, limit: 24 }), /bad_json|search_shape/);
});

test('JanitorAI thumbnails and imports point at JanitorAI', () => {
    assert.equal(janitorai.thumbUrlFromRef({ a: 'x.webp' }), 'https://ella.janitorai.com/bot-avatars/x.webp?width=400');
    assert.throws(() => janitorai.thumbUrlFromRef({ a: '../x.webp' }), /bad_ref/);
    assert.deepEqual(janitorai.getImportTarget(null, ID), {
        kind: 'url',
        url: `https://janitorai.com/characters/${ID}_character-character`,
    });
});
