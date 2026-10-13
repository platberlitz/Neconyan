import { describe, expect, jest, test } from '@jest/globals';
import { detectCardScriptProtection, buildTrustedOuterDocument } from '../public/scripts/card-script-sandbox/outer.js';
import { BOOTSTRAP_MESSAGE_TYPE, INIT_MESSAGE_TYPE, validateBootstrapMessage, validateInitMessage } from '../public/scripts/card-script-sandbox/messages.js';

const validReport = { type: 'connection-allowlist', body: { connection: 'webrtc', disposition: 'enforce', allowlist: [] } };
function platform(report = null, { throws = false, nativeBridge = false } = {}) {
    let callback;
    const disconnect = jest.fn();
    const close = jest.fn();
    return {
        setTimeout, clearTimeout,
        NeconyanExport: nativeBridge ? {} : undefined,
        ReportingObserver: class { constructor(fn, options) { callback = fn; expect(options).toEqual({ types: ['connection-allowlist'], buffered: false }); } observe() {} disconnect = disconnect; },
        RTCPeerConnection: class { constructor(config) { expect(config).toEqual({ iceServers: [] }); if (report) queueMicrotask(() => callback([report])); if (throws) throw Object.assign(Error('Not allowed'), { name: 'NotAllowedError' }); } close = close; },
        disconnect, close,
    };
}

describe('native connection protection proof', () => {
    test('only an empty native enforced WebRTC report succeeds', async () => {
        const env = platform(validReport);
        expect(await detectCardScriptProtection(env, 20)).toBe('protected');
        expect(env.close).toHaveBeenCalledTimes(1); expect(env.disconnect).toHaveBeenCalledTimes(1);
    });
    test.each([
        { ...validReport, type: 'csp-violation' },
        { ...validReport, body: { ...validReport.body, connection: 'fetch' } },
        { ...validReport, body: { ...validReport.body, disposition: 'report' } },
        { ...validReport, body: { ...validReport.body, allowlist: ['response-origin'] } },
        { ...validReport, body: { ...validReport.body, allowlist: '()' } },
        { ...validReport, body: null }, null,
    ])('ignores missing or inappropriate reports: %j', async report => {
        expect(await detectCardScriptProtection(platform(report), 5)).toBe('unsupported');
    });
    test('API absence and constructor errors are not proof', async () => {
        expect(await detectCardScriptProtection({ setTimeout, clearTimeout }, 5)).toBe('unsupported');
        expect(await detectCardScriptProtection(platform(null, { throws: true }), 5)).toBe('unsupported');
    });
    test('legacy ungated Android native bridges disallow execution even with a valid policy report', async () => {
        expect(await detectCardScriptProtection(platform(validReport, { nativeBridge: true }), 5)).toBe('android-bridge');
    });
    test('token-gated Android uses the same native report detection as browsers', async () => {
        const env = platform(validReport);
        env.NeconyanExport = { bridgeRequiresToken: () => true };
        env.NeconyanAndroid = { bridgeRequiresToken: () => true };
        expect(await detectCardScriptProtection(env, 5)).toBe('protected');
        expect(await detectCardScriptProtection({ ...platform(), NeconyanAndroid: env.NeconyanAndroid }, 5)).toBe('unsupported');
    });
    test('fixed outer response contains no card, theme, identifiers or reporting destination', () => {
        const html = buildTrustedOuterDocument();
        expect(html).not.toContain('Reporting-Endpoints'); expect(html).not.toContain('response-origin');
        expect(html).toContain('event.source !== parent'); expect(html).toContain('event.origin !== hostOrigin');
        expect(html).toContain('data.nonce !== nonce'); expect(html).toContain('initialised');
        expect(html).not.toContain('createOffer'); expect(html).not.toContain('createDataChannel');
        expect(html).toContain('new Peer({ iceServers: [] })');
    });
});

test('bootstrap and init have distinct strict bounded schemas', () => {
    const envelope = { version: 1, protocol: 2, nonce: 'nonce-for-tests-long-enough', messageId: 0 };
    expect(validateBootstrapMessage({ ...envelope, type: BOOTSTRAP_MESSAGE_TYPE, protection: 'protected' }).ok).toBe(true);
    for (const changes of [{ protocol: 1 }, { protection: 'guessed' }, { messageId: '0' }, { nonce: '' }]) expect(validateBootstrapMessage({ ...envelope, type: BOOTSTRAP_MESSAGE_TYPE, protection: 'protected', ...changes }).ok).toBe(false);
    const init = { ...envelope, type: INIT_MESSAGE_TYPE, cardNonce: 'card-nonce-long-enough', document: '<html></html>', title: 'Card', allowUnprotected: false };
    expect(validateInitMessage(init).ok).toBe(true);
    for (const changes of [{ cardNonce: 'x' }, { document: '' }, { document: 'x'.repeat(4 * 1024 * 1024 + 1) }, { title: 'x'.repeat(257) }, { allowUnprotected: 'true' }]) expect(validateInitMessage({ ...init, ...changes }).ok).toBe(false);
});
