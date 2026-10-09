import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
const {
    JANNY_CLOUDFLARE_ERROR_CODE,
    isJannyCloudflareBlock,
    isJannyImportHost,
} = await import('../src/endpoints/content-manager.js');
const {
    JANNY_BRIDGE_URL,
    canonicalJannyCharacterUrl,
    fetchJannyCardThroughBrowser,
    jannyBridgeGuidance,
} = await import('../public/scripts/janny-import.js');

const ID = 'd9e73da5-e776-4a89-8863-fb1a4b4bbf4d';

test('server recognises JannyAI and JanitorAI import hosts', () => {
    assert.equal(isJannyImportHost('jannyai.com'), true);
    assert.equal(isJannyImportHost('www.jannyai.com'), true);
    assert.equal(isJannyImportHost('janitorai.com'), true);
    assert.equal(isJannyImportHost('notjannyai.com'), false);
    assert.equal(isJannyImportHost('chub.ai'), false);
    assert.equal(JANNY_CLOUDFLARE_ERROR_CODE, 'janny_cloudflare_blocked');
});

test('server tells a Cloudflare challenge apart from other Janny failures', () => {
    const challenge = '<!DOCTYPE html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>';
    assert.equal(isJannyCloudflareBlock(403, challenge), true);
    assert.equal(isJannyCloudflareBlock(503, 'Attention Required! | Cloudflare'), true);
    assert.equal(isJannyCloudflareBlock(404, challenge), false);
    assert.equal(isJannyCloudflareBlock(403, '{"error":"forbidden"}'), false);
});

test('client canonicalises Janny links and UUIDs for the browser import', () => {
    const canonical = `https://jannyai.com/characters/${ID}`;
    assert.equal(canonicalJannyCharacterUrl(`https://jannyai.com/characters/${ID}_character-miguel-o-hara`), canonical);
    assert.equal(canonicalJannyCharacterUrl(`https://www.janitorai.com/characters/${ID.toUpperCase()}?ref=x#top`), canonical);
    assert.equal(canonicalJannyCharacterUrl(`  ${ID}_character-miguel  `), canonical);
    assert.equal(canonicalJannyCharacterUrl(ID), null);
    assert.equal(canonicalJannyCharacterUrl(`https://chub.ai/characters/${ID}`), null);
    assert.equal(canonicalJannyCharacterUrl(`https://jannyai.com/creators/${ID}`), null);
    assert.equal(canonicalJannyCharacterUrl(''), null);
});

test('client guidance points at the server browser login for a logged-out bridge', () => {
    const blocked = jannyBridgeGuidance('janny_login_required');
    assert.equal(blocked.title, 'JannyAI login needed on the server');
    assert.match(blocked.message, /Open JannyAI login window/);
    assert.match(blocked.message, /your own browser does not count/);
    assert.match(jannyBridgeGuidance('janny_admin_required').message, /administrator/);
    assert.match(jannyBridgeGuidance('janny_browser_unavailable').message, /download the card PNG/i);
});

test('client guidance names the real failure instead of always blaming Cloudflare', () => {
    const failed = jannyBridgeGuidance('janny_browser_request_failed');
    assert.equal(failed.title, 'JannyAI browser did not answer');
    assert.match(failed.message, /Refresh status/);

    assert.equal(jannyBridgeGuidance('janny_private_card_unsupported').title, 'JannyAI card definition is hidden');
    assert.equal(jannyBridgeGuidance('janny_private_capture_failed').title, 'JannyAI hidden card not captured');
    assert.equal(jannyBridgeGuidance('source_down').title, 'JannyAI is not responding');
    assert.equal(jannyBridgeGuidance('bad_import_url').title, 'JannyAI link not recognised');
    assert.equal(jannyBridgeGuidance('janny_bridge_unreachable').title, 'JannyAI import could not reach the server');

    const limited = jannyBridgeGuidance('rate_limited', 42);
    assert.equal(limited.title, 'JannyAI import rate limited');
    assert.match(limited.message, /in 42 seconds/);
    assert.match(jannyBridgeGuidance('source_busy', 1).message, /in 1 second\./);
    assert.match(jannyBridgeGuidance('source_busy').message, /in a moment/);

    const unknown = jannyBridgeGuidance('http_500');
    assert.equal(unknown.title, 'JannyAI import failed');
    assert.match(unknown.message, /\(http_500\)/);
    assert.match(unknown.message, /Extensions > BotSearcher/);
    for (const code of ['janny_browser_request_failed', 'rate_limited', 'source_busy', 'http_500']) {
        assert.notEqual(jannyBridgeGuidance(code).title, 'JannyAI import needs a Cloudflare check', code);
    }
});

test('BotSearcher explains card-specific bridge failures instead of blaming Cloudflare', async () => {
    const { JANNY_CARD_ERRORS, intakeErrorMessage } = await import('../public/scripts/extensions/third-party/Neconyan-BotSearcher/client/copy.js');
    assert.ok(JANNY_CARD_ERRORS.includes('janny_private_capture_failed'));
    for (const code of JANNY_CARD_ERRORS) {
        const message = intakeErrorMessage(Object.assign(new Error(code), { code }), 'jannyai');
        assert.doesNotMatch(message, /Cloudflare/, code);
        assert.notEqual(message, 'The card could not be inspected.', code);
    }
    assert.match(intakeErrorMessage(new Error('janny_private_capture_failed'), 'jannyai'), /hides its definition/);
    assert.match(intakeErrorMessage(new Error('native_download_failed'), 'jannyai'), /Cloudflare/);
});

test('server refuses a No Proxy hidden card before changing JanitorAI settings', async () => {
    const { assertCardCapturable, JannyBrowserError } = await import('../public/scripts/extensions/third-party/Neconyan-BotSearcher/server/janny-browser.js');
    assert.throws(() => assertCardCapturable({ showdefinition: false, allow_proxy: false }), (error) => {
        assert.ok(error instanceof JannyBrowserError);
        assert.equal(error.code, 'janny_proxy_disabled');
        assert.equal(error.status, 422);
        return true;
    });
    assert.doesNotThrow(() => assertCardCapturable({ showdefinition: false, allow_proxy: true }));
    assert.doesNotThrow(() => assertCardCapturable({ showdefinition: false }));
    assert.doesNotThrow(() => assertCardCapturable(null));

    const { createJannyBrowser } = await import('../public/scripts/extensions/third-party/Neconyan-BotSearcher/server/janny-browser.js');
    async function importWith(meta) {
        const requests = [];
        const page = {
            url: () => 'https://janitorai.com/',
            goto: async () => {},
            setDefaultTimeout: () => {},
            close: async () => {},
            context: () => ({ on: () => {}, off: () => {} }),
            evaluate: async (_fn, arg) => {
                if (typeof arg?.target !== 'string') {
                    return null;
                }
                requests.push(`${arg.request?.method ?? 'GET'} ${new URL(arg.target).pathname}`);
                const body = arg.target.includes('/hampter/characters/') ? { character: meta } : {};
                return { status: 200, body: JSON.stringify(body) };
            },
        };
        const browser = createJannyBrowser({
            profileDir: '/tmp/opencode/janny-test-profile',
            launchContext: async () => ({ pages: () => [page], newPage: async () => page, on: () => {}, close: async () => {} }),
        });
        const error = await browser.fetchCard(`https://jannyai.com/characters/${ID}`).catch((caught) => caught);
        return { error, requests };
    }

    const blocked = await importWith({ id: ID, name: 'Nick', showdefinition: false, allow_proxy: false });
    assert.equal(blocked.error?.code, 'janny_proxy_disabled');
    assert.deepEqual(blocked.requests, [`GET /hampter/characters/${ID}`]);

    const allowed = await importWith({ id: ID, name: 'Nick', showdefinition: false, allow_proxy: true });
    assert.notEqual(allowed.error?.code, 'janny_proxy_disabled');
    assert.ok(allowed.requests.length > 1, 'a proxy-friendly hidden card still attempts the capture');

    const guidance = jannyBridgeGuidance('janny_proxy_disabled');
    assert.equal(guidance.title, 'JannyAI card blocks proxies');
    assert.doesNotMatch(guidance.message, /Cloudflare/);
});

test('client fetches the card through the BotSearcher browser import', async () => {
    const calls = [];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const ok = await fetchJannyCardThroughBrowser(`https://jannyai.com/characters/${ID}`, { 'X-CSRF-Token': 't' }, async (url, init) => {
        calls.push({ url, init });
        return new Response(png, { status: 200, headers: { 'X-SBBS-Card-Kind': 'png' } });
    });
    assert.equal(calls[0].url, JANNY_BRIDGE_URL);
    assert.deepEqual(JSON.parse(calls[0].init.body), { source: 'jannyai', url: `https://jannyai.com/characters/${ID}` });
    assert.equal(calls[0].init.headers['X-CSRF-Token'], 't');
    assert.equal(ok.file.name, `${ID}.png`);
    assert.equal(ok.file.type, 'image/png');

    const blocked = await fetchJannyCardThroughBrowser(`https://jannyai.com/characters/${ID}`, {}, async () => Response.json({ error: 'janny_login_required' }, { status: 401 }));
    assert.deepEqual(blocked, { error: 'janny_login_required' });

    const limited = await fetchJannyCardThroughBrowser(`https://jannyai.com/characters/${ID}`, {}, async () => Response.json({ error: 'rate_limited', retryAfter: 30 }, { status: 429 }));
    assert.deepEqual(limited, { error: 'rate_limited', retryAfter: 30 });

    const missing = await fetchJannyCardThroughBrowser(`https://jannyai.com/characters/${ID}`, {}, async () => new Response('Not Found', { status: 404 }));
    assert.deepEqual(missing, { error: 'http_404' });

    const offline = await fetchJannyCardThroughBrowser(`https://jannyai.com/characters/${ID}`, {}, async () => { throw new TypeError('offline'); });
    assert.deepEqual(offline, { error: 'janny_bridge_unreachable' });
});

test('server logs why a JannyAI link import failed', async () => {
    const { logJannyUrlCardFailure } = await import('../public/scripts/extensions/third-party/Neconyan-BotSearcher/server/router.js');
    const { JannyBrowserError } = await import('../public/scripts/extensions/third-party/Neconyan-BotSearcher/server/janny-browser.js');
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => lines.push(args.join(' '));
    try {
        const error = new JannyBrowserError('janny_browser_request_failed', 502, 'page.evaluate: Target page,\n  context or browser has been closed');
        logJannyUrlCardFailure(error.code, error.detail, ID);
        logJannyUrlCardFailure('bad_import_url');
        logJannyUrlCardFailure('janny_login_required', 'x'.repeat(500), ID);
    } finally {
        console.warn = original;
    }
    assert.equal(lines[0], `[BotSearcher] JannyAI link import failed for ${ID}: janny_browser_request_failed (page.evaluate: Target page, context or browser has been closed)`);
    assert.equal(lines[1], '[BotSearcher] JannyAI link import failed: bad_import_url');
    assert.equal(lines[2], `[BotSearcher] JannyAI link import failed for ${ID}: janny_login_required (${'x'.repeat(300)})`);
});
