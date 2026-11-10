import fs from 'node:fs';

const read = filename => fs.readFileSync(new URL('../' + filename, import.meta.url), 'utf8');

describe('Device sync shell and shipping contracts', () => {
    test('uses the existing shared phone and desktop settings navigation and loads on selection', () => {
        const shell = read('public/scripts/neconyan-settings-tabs.js');
        expect(shell).toContain('id: \'device-sync\'');
        expect(shell).toContain('import(\'./neconyan-device-sync.js\')');
        expect(shell).toContain('data-settings-tab="device-sync"');
        expect(shell).not.toMatch(/^import .*neconyan-device-sync/m);
    });

    test('keeps sync styling deferred, accent-aware and free of motion or hardcoded button colours', () => {
        const css = read('public/css/neconyan-device-sync.css');
        const html = read('public/index.html');
        const version = read('public/sw.js').match(/NN_SW_CACHE_VERSION = 'neconyan-cache-v([^']+)'/)[1];
        expect(html).toContain(`<link href="css/neconyan-device-sync.css?v=${version}" rel="preload" as="style" data-sb-deferred-style data-sb-media="all">`);
        for (const token of ['--neco-ginger', '--neco-ginger-hover', '--neco-on-accent']) expect(css).toContain(token);
        expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|!important|\b(?:transition|animation)\s*:/i);
    });

    test('accounts and errors use the existing browser request and translation helpers', () => {
        const ui = read('public/scripts/neconyan-device-sync.js');
        expect(ui).toContain('getRequestHeaders()');
        expect(ui).toContain('\'X-Neconyan-Account\': owner');
        expect(ui).toContain('translate(value.error)');
        const catalogue = JSON.parse(read('public/locales/neconyan/en.json'));
        for (const text of ['Device sync', 'Character cards and solo chats', 'Download encrypted file', 'This sync method is switched off.', 'Remove preserved copies']) expect(catalogue[text]).toBe(text);
    });

    test('pre-authentication admission is narrow and independently authenticated, not a broad exemption', () => {
        const main = read('src/server-main.js');
        expect(main.indexOf('\'/api/device-sync/pair\'')).toBeLessThan(main.indexOf('app.use(basicAuthMiddleware'));
        const endpoint = read('src/endpoints/device-sync.js');
        expect(endpoint).toContain('pairingRouter.post(\'/:owner/:id\'');
        expect(endpoint).toContain('request.get(\'Origin\') || request.get(\'Sec-Fetch-Mode\')');
        expect(endpoint).toContain('authoriseGrant(base, account, request.params.id, token)');
        expect(read('src/middleware/basicAuth.js')).not.toContain('device-sync');
    });

    test('mutating browser operations flush and pause ordinary saves, then require a protected reload instead of adopting stale settings', () => {
        const ui = read('public/scripts/neconyan-device-sync.js');
        expect(ui).toContain('await pauseSettingsForAccountImport()');
        expect(ui).toContain('await saveChatConditional(');
        expect(ui.indexOf('resume = await pauseSettingsForAccountImport()')).toBeLessThan(ui.indexOf('dispatched = true'));
        expect(ui).toContain('[\'import\', \'now\', \'resolve\', \'recover\'].includes(route)');
        expect(ui).toContain('allowEscapeClose: false');
        expect(ui).toContain('onClosing: () => closable');
        expect(ui).toContain('location.reload()');
        expect(ui).not.toContain('adoptServerSettingsWrite(');
    });
});
