import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { installCardScriptTestDom } from './card-script-dom.js';
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
const { buildCardDocument, prepareSandboxHtml, sanitiseSandboxTheme, CARD_SCRIPT_SANDBOX_CSP, CARD_SCRIPT_PERMISSIONS } = await import('../public/scripts/card-script-sandbox/wrapper.js');
const { buildTrustedOuterDocument } = await import('../public/scripts/card-script-sandbox/outer.js');

beforeEach(() => installCardScriptTestDom());

describe('two-frame card sandbox', () => {
    test('installs the first policy before any card code, with no remote sources', () => {
        const card = buildCardDocument({ html: '<script>run()</script>', messageId: 1, nonce: 'inner' });
        const outer = buildTrustedOuterDocument();
        expect(card.indexOf('Content-Security-Policy')).toBeLessThan(card.indexOf('<script>'));
        expect(card.indexOf('window.triggerSlash')).toBeLessThan(card.indexOf('run()'));
        expect(outer).not.toContain('<script>run()</script>');
        expect(CARD_SCRIPT_SANDBOX_CSP).toContain('frame-src \'none\'; child-src \'none\'; worker-src \'none\'; object-src \'none\'');
        expect(outer).toContain('frame.setAttribute(\'sandbox\', \'allow-scripts\')');
        expect(outer).toContain('frame.setAttribute(\'referrerpolicy\', \'no-referrer\')');
        expect(CARD_SCRIPT_PERMISSIONS).toContain('camera \'none\'; clipboard-read \'none\'');
        expect(outer).not.toContain('allow-same-origin');
    });
    test('escapes JSON script terminators and exposes no host helpers', () => {
        const outer = buildTrustedOuterDocument();
        expect(outer.match(/<script>/g)).toHaveLength(1);
        expect(outer.match(/<\/script>/g)).toHaveLength(1);
        for (const name of ['SillyTavern', 'getContext', 'localStorage', 'sessionStorage', 'document.cookie']) expect(outer).not.toContain(name);
        expect(outer).toContain('event.source !== child');
        expect(outer).toContain('data.nonce !== cardNonce');
        expect(outer).toContain('event.source !== parent');
    });
    test('removes refresh, base, resource hints, objects and nested embeds inertly', () => {
        const { html } = prepareSandboxHtml('<base href="https://bad"><meta http-equiv="refresh" content="0;url=https://bad"><link rel="prefetch" href="https://bad"><object>object</object><embed src="https://bad"><iframe src="https://bad"></iframe><script>run()</script>');
        expect(html).not.toMatch(/<(base|meta|link|object|embed|iframe)/i);
        expect(html).toContain('Embedded frames are unavailable');
        expect(html).toContain('<script>run()</script>');
    });
    test('unwraps a sole inline-srcdoc card without fetching its src', () => {
        const { html } = prepareSandboxHtml('<iframe src="https://bad" srcdoc="&lt;p&gt;Inline&lt;/p&gt;&lt;script&gt;run()&lt;/script&gt;"></iframe>');
        expect(html).toBe('<p>Inline</p><script>run()</script>');
    });
    test.each(['preconnect', 'dns-prefetch', 'prefetch', 'preload'])('strips %s hints including inert nested templates', rel => {
        const { html } = prepareSandboxHtml(`<link rel="${rel}" href="https://bad"><template><link rel="${rel}" href="https://bad"><template><link rel="${rel}" href="https://bad"></template></template>`);
        expect(html).not.toContain('<link');
    });
    test('theme accepts only bounded CSS values and measurements can shrink', () => {
        expect(sanitiseSandboxTheme({ color: '<script>', fontSize: '500px', fontFamily: 'url(https://bad)', backgroundColor: 'invalid', extra: 'red', linkColor: 'rgb(1, 2, 3)' })).toEqual({ linkColor: 'rgb(1, 2, 3)' });
        const card = buildCardDocument({ html: '<p>Hello</p>', theme: { color: 'rgb(20, 30, 40)', fontSize: '16px' } });
        expect(card).toContain('const bounds = root.getBoundingClientRect()');
        expect(card).toContain('document.getElementById(\'neconyan-card-content\') || document.body');
        expect(card).not.toContain('document.documentElement.scrollHeight');
        expect(card).toContain('new ResizeObserver(schedule)');
    });
    test('quoted dialogue keeps only its literal quotation marks', () => {
        const card = buildCardDocument({ html: '<q>"Hello."</q>' });
        expect(card).toContain('q{quotes:none}q::before,q::after{content:\'\'}');
    });
});
