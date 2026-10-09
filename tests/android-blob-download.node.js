import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../android/app/src/main/java/io/github/platberlitz/neconyan/MainActivity.java', import.meta.url), 'utf8');
const hook = JSON.parse(source.match(/evaluateJavascript\(("if \(!window\.neconyanDownloadHook\).*?"), null\)/)[1]);

function installHook() {
    const live = new Map();
    const fetched = [];
    const nativeClicks = [];
    const alerts = [];
    const saved = { chunks: [] };
    class HTMLAnchorElement {
        constructor({ href, download = null, connected = false }) {
            Object.assign(this, { href, download: download ?? '', isConnected: connected, attributes: download === null ? [] : ['download'] });
        }
        hasAttribute(name) { return this.attributes.includes(name); }
        click() { nativeClicks.push(this); }
    }
    const window = {
        HTMLAnchorElement,
        Blob,
        btoa,
        Uint8Array,
        Error,
        String,
        document: { addEventListener() {} },
        alert: message => alerts.push(message),
        fetch: async url => {
            fetched.push(url);
            if (!live.has(url)) throw new TypeError('Failed to fetch');
            const blob = live.get(url);
            return { blob: async () => blob };
        },
        NeconyanExport: {
            beginExport(name, size) { Object.assign(saved, { name, size }); return true; },
            appendExport(chunk) { saved.chunks.push(chunk); return true; },
            finishExport() { saved.done = true; },
            cancelExport() { saved.cancelled = true; },
        },
    };
    window.window = window;
    vm.runInNewContext(hook, window);
    let next = 0;
    const blobUrl = blob => { const url = `blob:http://127.0.0.1:8000/${++next}`; live.set(url, blob); return url; };
    return { window, HTMLAnchorElement, live, fetched, nativeClicks, alerts, saved, blobUrl };
}

test('a detached download link starts the save before its blob is revoked', async () => {
    const page = installHook();
    const content = '{"user_name":"User"}\n'.repeat(5000);
    const a = new page.HTMLAnchorElement({ href: page.blobUrl(new Blob([content])), download: 'Kina - 2026-10-07 12-17-58.jsonl' });

    a.click();
    page.live.delete(a.href);

    assert.deepEqual(page.fetched, [a.href], 'the blob must be read during click(), before the caller revokes it');
    assert.equal(page.nativeClicks.length, 0, 'the WebView must not also start its own download of the same blob');
    await new Promise(resolve => setImmediate(resolve));
    for (let i = 0; i < 20 && !page.saved.done; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(page.saved.name, 'Kina - 2026-10-07 12-17-58.jsonl');
    assert.equal(page.saved.chunks.map(chunk => Buffer.from(chunk, 'base64').toString()).join(''), content);
    assert.ok(page.saved.done);
    assert.deepEqual(page.alerts, []);
});

test('links on the page and ordinary links keep their normal click', () => {
    const page = installHook();
    const attached = new page.HTMLAnchorElement({ href: page.blobUrl(new Blob(['x'])), download: 'card.png', connected: true });
    const plain = new page.HTMLAnchorElement({ href: page.blobUrl(new Blob(['x'])) });
    const remote = new page.HTMLAnchorElement({ href: 'https://example.com/file.zip', download: 'file.zip' });

    for (const a of [attached, plain, remote]) a.click();

    assert.deepEqual(page.nativeClicks, [attached, plain, remote]);
    assert.deepEqual(page.fetched, []);
});
