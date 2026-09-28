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

test('client guidance points at the Cloudflare check for a blocked bridge', () => {
    const blocked = jannyBridgeGuidance('janny_login_required');
    assert.equal(blocked.title, 'JannyAI import needs a Cloudflare check');
    assert.match(blocked.message, /Open JannyAI login window/);
    assert.match(jannyBridgeGuidance('http_404').message, /Extensions > BotSearcher/);
    assert.match(jannyBridgeGuidance('janny_admin_required').message, /administrator/);
    assert.match(jannyBridgeGuidance('janny_browser_unavailable').message, /download the card PNG/i);
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

    const missing = await fetchJannyCardThroughBrowser(`https://jannyai.com/characters/${ID}`, {}, async () => new Response('Not Found', { status: 404 }));
    assert.deepEqual(missing, { error: 'http_404' });

    const offline = await fetchJannyCardThroughBrowser(`https://jannyai.com/characters/${ID}`, {}, async () => { throw new TypeError('offline'); });
    assert.deepEqual(offline, { error: 'janny_bridge_unreachable' });
});
