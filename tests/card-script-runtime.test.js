/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { installCardScriptTestDom } from './card-script-dom.js';
import { eventSource, event_types } from '../public/scripts/events.js';
import { MESSAGE_TYPE, MESSAGE_VERSION, RESIZE_MESSAGE_TYPE, READY_MESSAGE_TYPE, BOOTSTRAP_MESSAGE_TYPE, INIT_MESSAGE_TYPE } from '../public/scripts/card-script-sandbox/messages.js';
import { markCardScriptHtml, getCardScriptSnapshot, forgetAllCardScripts } from '../public/scripts/card-script-detection.js';
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
const api = await import('../public/scripts/card-script-runtime.js');
const runtime = { ...api, createSandbox: startVerified };

function dispatchProof(frame, protection = 'protected') {
    const fields = new URLSearchParams(frame.getAttribute('src').split('#')[1]);
    return api.handleSandboxMessage({ source: frame.contentWindow, data: { type: BOOTSTRAP_MESSAGE_TYPE, version: MESSAGE_VERSION, protocol: 2, messageId: Number(fields.get('messageId')), nonce: fields.get('nonce'), protection } });
}

async function startVerified(id, options) {
    const record = await api.createSandbox(id, options);
    if (!record) return null;
    await Promise.all(globalThis.document.querySelectorAll('iframe.card-script-sandbox-frame').filter(frame => Number(new URLSearchParams(frame.getAttribute('src').split('#')[1]).get('messageId')) === Number(id)).map(frame => dispatchProof(frame)));
    return record.initialized && api.getActiveSandbox(id) === record ? record : null;
}

class Observer {
    static instances = [];
    constructor(callback) { this.callback = callback; this.disconnected = false; Observer.instances.push(this); }
    observe() {}
    unobserve() {}
    disconnect() { this.disconnected = true; }
}

function setup({ enabled = true, consent = true, storageThrows = false, showConfirmation = jest.fn(async () => true) } = {}) {
    const doc = installCardScriptTestDom();
    doc.querySelector('#chat').bounds = { top: 0, bottom: 900, width: 400, height: 900 };
    const settings = { allow_card_scripts: enabled };
    const messages = [];
    const context = { scope: '0', streaming: false, editing: false };
    const executor = jest.fn(async () => {});
    const buildCardDocument = jest.fn(() => '<html></html>');
    const window = new EventTarget();
    window.requestAnimationFrame = fn => setTimeout(fn, 0);
    window.cancelAnimationFrame = clearTimeout;
    const storage = new Map(consent ? [[runtime.CARD_SCRIPT_CONFIRMATION_STORAGE_KEY, 'true']] : [['card_scripts_confirmed', 'true']]);
    runtime.configureCardScriptRuntime({
        getDocument: () => doc, getWindow: () => window,
        getPowerUser: () => settings, getMessage: id => messages[id], getChatScope: () => context.scope,
        isMessageStreaming: () => context.streaming, isMessageEditing: () => context.editing,
        getMutationObserver: () => Observer, getIntersectionObserver: () => Observer,
        getComputedStyle: () => ({ color: 'rgb(20, 30, 40)', fontSize: '16px', lineHeight: '24px', fontFamily: 'system-ui', colorScheme: 'dark', backgroundColor: 'rgb(10, 10, 10)', getPropertyValue: () => '' }),
        getLocalStorage: () => { if (storageThrows) throw Error('Storage unavailable'); return { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }; },
        showConfirmation, executeSlashCommandsWithOptions: executor,
        createNonce: () => 'secure-nonce-for-tests', buildCardDocument, toastr: () => ({ warning: jest.fn() }),
    });
    function add(id = messages.length, html = '<p>Fallback</p><script>run()</script>', options = {}) {
        messages[id] = { mes: html, swipe_id: 0 };
        const element = doc.createElement('div');
        element.className = 'mes'; element.setAttribute('mesid', id);
        element.innerHTML = `<div class="mes_run_card_scripts"></div><div class="mes_text">${markCardScriptHtml(html, id, { scopeKey: context.scope, ...options })}</div>`;
        doc.querySelector('#chat').appendChild(element);
        return element;
    }
    return { doc, settings, context, messages, executor, showConfirmation, storage, add, buildCardDocument, window };
}

function envelope(record, type = MESSAGE_TYPE, extra = {}) {
    return { type, version: MESSAGE_VERSION, messageId: record.messageId, nonce: record.nonce, command: '/echo hello', ...extra };
}
const tick = async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    for (const frame of globalThis.document.querySelectorAll('iframe.card-script-sandbox-frame')) void dispatchProof(frame);
    await new Promise(resolve => setTimeout(resolve, 15));
};

beforeEach(() => { forgetAllCardScripts(); Observer.instances = []; });
afterEach(() => { runtime.resetCardScriptRuntimeForTests(); jest.restoreAllMocks(); });

describe('visible card script runtime', () => {
    test('automatically mounts visible final content and restores the owned fallback', async () => {
        const { add } = setup(); const message = add();
        runtime.initCardScriptRuntime(); await tick();
        expect(runtime.getActiveSandboxCount()).toBe(1);
        const record = runtime.getActiveSandbox(0);
        expect(record.iframeElement.getAttribute('sandbox')).toBe('allow-scripts');
        expect(record.iframeElement.getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(record.iframeElement.getAttribute('allow')).toContain('camera \'none\'');
        expect(message.querySelector('.mes_text').textContent).not.toContain('Fallback');
        runtime.destroySandbox(0); await tick();
        expect(message.querySelector('.mes_text').textContent).toContain('Fallback');
        expect(runtime.getActiveSandboxCount()).toBe(0);
        await runtime.createSandbox(0, { manual: true });
        expect(runtime.getActiveSandboxCount()).toBe(1);
    });
    test.each(['disabled', 'streaming', 'editing', 'offscreen', 'hidden'])('does not auto-run when %s', async condition => {
        const fixture = setup({ enabled: condition !== 'disabled' });
        const message = fixture.add();
        fixture.context.streaming = condition === 'streaming'; fixture.context.editing = condition === 'editing';
        if (condition === 'offscreen') message.bounds = { top: 2000, bottom: 2100 };
        fixture.doc.hidden = condition === 'hidden';
        runtime.initCardScriptRuntime(); await tick();
        expect(runtime.getActiveSandboxCount()).toBe(0);
    });
    test('explicit streaming state outranks the processor until final DOM is written', async () => {
        const { add } = setup(); add();
        runtime.setCardScriptMessageStreaming(0, true);
        expect(await runtime.createSandbox(0)).toBeNull();
        runtime.setCardScriptMessageStreaming(0, false);
        await runtime.createSandbox(0);
        expect(runtime.getActiveSandboxCount()).toBe(1);
    });
    test('old manual consent is ignored and concurrent cards share one fresh confirmation', async () => {
        let accept; const confirmation = jest.fn(() => new Promise(resolve => { accept = resolve; }));
        const { add, storage } = setup({ consent: false, showConfirmation: confirmation }); add(); add();
        const first = runtime.createSandbox(0); const second = runtime.createSandbox(1); await tick();
        expect(runtime.getActiveSandboxCount()).toBe(2); expect(confirmation).toHaveBeenCalledTimes(1);
        expect(runtime.getActiveSandbox(0).initialized).toBe(false);
        accept(true); await Promise.all([first, second]);
        expect(runtime.getActiveSandboxCount()).toBe(2);
        expect(storage.get('card_scripts_auto_confirmed')).toBe('true');
    });
    test('a storage getter failure still allows in-memory consent once', async () => {
        const { add, showConfirmation } = setup({ storageThrows: true }); add(); add();
        await runtime.createSandbox(0); await runtime.createSandbox(1);
        expect(showConfirmation).toHaveBeenCalledTimes(1);
    });
    test.each(['disable', 'switch', 'replace', 'raw edit'])('confirmation cannot mount after %s', async action => {
        let accept; const { add, settings, context, messages } = setup({ consent: false, showConfirmation: () => new Promise(resolve => { accept = resolve; }) });
        const message = add(); const pending = runtime.createSandbox(0); await tick();
        if (action === 'disable') settings.allow_card_scripts = false;
        if (action === 'switch') { context.scope = '1'; runtime.resetCardScriptSession({ clearSnapshots: true }); }
        if (action === 'replace') message.querySelector('.mes_text').innerHTML = 'Replacement';
        if (action === 'raw edit') messages[0].mes = 'Edited while consent was pending';
        accept(true); await pending;
        expect(runtime.getActiveSandboxCount()).toBe(0);
    });
    test('declined consent does not prompt repeatedly', async () => {
        const { add, showConfirmation } = setup({ consent: false, showConfirmation: jest.fn(async () => false) }); add();
        await runtime.createSandbox(0); await runtime.createSandbox(0);
        expect(showConfirmation).toHaveBeenCalledTimes(1);
        expect(runtime.getActiveSandboxCount()).toBe(0);
    });
    test('a completed replacement while consent is pending starts only its new snapshot after acceptance', async () => {
        let accept;
        const { add, messages } = setup({ consent: false, showConfirmation: () => new Promise(resolve => { accept = resolve; }) });
        const message = add(); runtime.initCardScriptRuntime();
        const pending = runtime.createSandbox(0); await tick();
        messages[0].mes = '<p>Current replacement</p><script>current()</script>';
        message.querySelector('.mes_text').innerHTML = markCardScriptHtml(messages[0].mes, 0, { scopeKey: '0' });
        runtime.scheduleCardScriptReconcile(); await tick();
        accept(true); expect(await pending).toBeNull(); await tick();
        expect(runtime.getActiveSandboxCount()).toBe(1);
        expect(runtime.getActiveSandbox(0).snapshot.html).toContain('current()');
    });
    test('reserves the five-frame capacity across concurrent starts', async () => {
        const { add } = setup(); for (let i = 0; i < 8; i++) add();
        await Promise.all(Array.from({ length: 8 }, (_, i) => runtime.createSandbox(i)));
        expect(runtime.getActiveSandboxCount()).toBe(5);
    });
    test('two full-page blocks mount independently with prose intact and count per frame', async () => {
        const { add } = setup();
        const page = '<body><p>Page</p><script>run()</script></body>';
        const pre = '<pre data-card-script-fenced="0"><code>&lt;body&gt;&lt;p&gt;Page&lt;/p&gt;&lt;script&gt;run()&lt;/script&gt;&lt;/body&gt;</code></pre>';
        const message = add(0, `<p>Before</p>${pre}<p>Between</p>${pre}<p>After</p>`, { fencedPages: [page, page] });
        await runtime.createSandbox(0);
        expect(runtime.getActiveSandboxCount()).toBe(2);
        expect(message.querySelector('.mes_text').textContent).toContain('Between');
        expect(message.querySelectorAll('pre')).toHaveLength(0);
        runtime.destroySandbox(0);
        expect(message.querySelectorAll('pre')).toHaveLength(2);
    });
    test('an inline widget script sandboxes only its widget and leaves the prose in the chat', async () => {
        const { add, buildCardDocument } = setup();
        const widget = '<div style="padding:16px"><div id="dadcall">ringing</div></div><script>document.getElementById(\'dadcall\').textContent = \'ringing.\';</script>';
        const message = add(0, `<p><q>"All of it."</q> Leonard nudges the bridge.</p>${widget}<p><q>"It's your dining room."</q></p>`);
        await runtime.createSandbox(0);
        expect(runtime.getActiveSandboxCount()).toBe(1);
        const text = message.querySelector('.mes_text');
        expect(text.textContent).toContain('Leonard nudges the bridge.');
        expect(text.textContent).toContain('It\'s your dining room.');
        expect(text.querySelectorAll('.card-script-sandbox-slot')).toHaveLength(1);
        const sandboxed = buildCardDocument.mock.calls.at(-1)[0].html;
        expect(sandboxed).toContain('dadcall');
        expect(sandboxed).not.toContain('Leonard');
        runtime.destroySandbox(0);
        expect(text.textContent).toContain('ringing');
        expect(text.querySelectorAll('.card-script-sandbox-slot')).toHaveLength(0);
    });
    test('a visible candidate replaces a nearby frame and offscreen frames stop', async () => {
        const { add } = setup(); const messages = Array.from({ length: 6 }, () => add());
        messages[0].bounds = { top: -400, bottom: -100 };
        for (let i = 0; i < 5; i++) await runtime.createSandbox(i);
        await runtime.createSandbox(5);
        expect(runtime.getActiveSandbox(0)).toBeNull(); expect(runtime.getActiveSandbox(5)).not.toBeNull();
        runtime.initCardScriptRuntime(); messages[5].bounds = { top: 2000, bottom: 2100 }; await tick();
        expect(runtime.getActiveSandbox(5)).toBeNull();
    });
    test('post-render chat change retains snapshots and active content', async () => {
        const { add } = setup(); add(); runtime.initCardScriptRuntime(); await tick();
        await eventSource.emit(event_types.CHAT_CHANGED); await tick();
        expect(getCardScriptSnapshot(0)).not.toBeNull(); expect(runtime.getActiveSandboxCount()).toBe(1);
    });
    test('body replacement never restores stale fallback and a new swipe runs its own content', async () => {
        const { add, messages, doc } = setup(); const message = add(); const old = await runtime.createSandbox(0);
        const text = message.querySelector('.mes_text'); text.innerHTML = 'New plain text';
        runtime.destroySandbox(0, { reason: 'edit' }); expect(text.textContent).toBe('New plain text');
        messages[0].swipe_id = 1;
        text.innerHTML = markCardScriptHtml('<script>newSwipe()</script>', 0, { scopeKey: '0' });
        await runtime.createSandbox(0);
        expect(runtime.getActiveSandbox(0)).not.toBe(old);
        doc.querySelector('#chat').innerHTML = '';
        runtime.initCardScriptRuntime(); await tick(); expect(runtime.getActiveSandboxCount()).toBe(0);
    });
    test('stop persists across incidental body rerenders but changed content can restart', async () => {
        const { add, messages } = setup(); const message = add(); await runtime.createSandbox(0); runtime.destroySandbox(0);
        message.querySelector('.mes_text').innerHTML = markCardScriptHtml(messages[0].mes, 0, { scopeKey: '0' });
        expect(await runtime.createSandbox(0)).toBeNull();
        messages[0].mes = '<script>changed()</script>';
        message.querySelector('.mes_text').innerHTML = markCardScriptHtml(messages[0].mes, 0, { scopeKey: '0' });
        expect(await runtime.createSandbox(0)).not.toBeNull();
    });
    test('teardown disconnects shared observers and cancels starts', async () => {
        const { add } = setup(); add(); runtime.initCardScriptRuntime(); await tick(); runtime.teardownCardScriptRuntime();
        expect(runtime.getActiveSandboxCount()).toBe(0); expect(Observer.instances.every(item => item.disconnected)).toBe(true);
    });
    test('plain messages are skipped by reconcile and deletion repair needs known card scripts', async () => {
        const { doc, add } = setup();
        const plain = doc.createElement('div');
        plain.className = 'mes'; plain.setAttribute('mesid', 0);
        plain.innerHTML = '<div class="mes_run_card_scripts"></div><div class="mes_text"><p>Hello</p></div>';
        plain.querySelector('.mes_run_card_scripts').style.display = 'none';
        doc.querySelector('#chat').appendChild(plain);
        const refreshRenderedCardScriptMessages = jest.fn();
        runtime.configureCardScriptRuntime({ refreshRenderedCardScriptMessages });
        runtime.initCardScriptRuntime(); await tick();
        expect(plain.querySelector('.mes_run_card_scripts').getAttribute('aria-pressed')).toBeNull();
        await eventSource.emit(event_types.MESSAGE_DELETED, 0); await tick();
        expect(refreshRenderedCardScriptMessages).not.toHaveBeenCalled();
        add(1); await eventSource.emit(event_types.MESSAGE_DELETED, 0); await tick();
        expect(refreshRenderedCardScriptMessages).toHaveBeenCalledTimes(1);
    });
    test('the snapshot scope changes only when snapshots are discarded', () => {
        const before = runtime.getCardScriptChatScope();
        runtime.resetCardScriptSession();
        expect(runtime.getCardScriptChatScope()).toBe(before);
        runtime.resetCardScriptSession({ clearSnapshots: true });
        expect(runtime.getCardScriptChatScope()).toBe(before + 1);
    });
    test('cryptographic failure is closed', async () => {
        const { add } = setup(); add(); runtime.configureCardScriptRuntime({ createNonce: () => { throw Error('No crypto'); } });
        await expect(runtime.createSandbox(0)).rejects.toThrow('No crypto'); expect(runtime.getActiveSandboxCount()).toBe(0);
    });
});

describe('authenticated card relay', () => {
    test('only the registered outer window with the correct envelope can execute', async () => {
        const { add, executor } = setup(); add(); const record = await runtime.createSandbox(0);
        for (const [source, changes, reason] of [[{}, {}, 'unknown_source'], [record.iframeWindow, { nonce: 'wrong' }, 'bad_nonce'], [record.iframeWindow, { messageId: 7 }, 'bad_message_id'], [record.iframeWindow, { type: 'evil' }, 'wrong_type']]) {
            expect(await runtime.handleSandboxMessage({ source, data: envelope(record, MESSAGE_TYPE, changes) })).toMatchObject({ ok: false, reason });
        }
        expect(executor).not.toHaveBeenCalled();
        expect(await runtime.handleSandboxMessage({ source: record.iframeWindow, data: envelope(record) })).toEqual({ ok: true });
        expect(executor).toHaveBeenCalledWith('/echo escapeHtml=true hello', expect.objectContaining({ parserFlags: { 1: true, 2: false } }));
    });
    test.each([NaN, Infinity, -1, '100'])('rejects invalid height %s', async height => {
        const { add } = setup(); add(); const record = await runtime.createSandbox(0);
        expect(await runtime.handleSandboxMessage({ source: record.iframeWindow, data: envelope(record, RESIZE_MESSAGE_TYPE, { height }) })).toMatchObject({ ok: false });
    });
    test.each([[0, 48], [50000, 4096], [123.2, 124]])('clamps height %s to %s', async (height, expected) => {
        const { add } = setup(); add(); const record = await runtime.createSandbox(0);
        await runtime.handleSandboxMessage({ source: record.iframeWindow, data: envelope(record, RESIZE_MESSAGE_TYPE, { height }) }); await tick();
        expect(record.iframeElement.style.height).toBe(`${expected}px`);
    });
    test('resize and slash have separate budgets and ready cancels the startup timer', async () => {
        const { add, executor } = setup(); add(); const record = await runtime.createSandbox(0);
        await runtime.handleSandboxMessage({ source: record.iframeWindow, data: envelope(record, READY_MESSAGE_TYPE) }); expect(record.ready).toBe(true);
        for (let i = 0; i < 10; i++) await runtime.handleSandboxMessage({ source: record.iframeWindow, data: envelope(record, RESIZE_MESSAGE_TYPE, { height: 100 + i }) });
        for (let i = 0; i < 5; i++) await runtime.handleSandboxMessage({ source: record.iframeWindow, data: envelope(record) });
        expect(executor).toHaveBeenCalledTimes(5);
        expect(await runtime.handleSandboxMessage({ source: record.iframeWindow, data: envelope(record) })).toMatchObject({ ok: false, reason: 'rate_limited' });
    });
    test('a stopped frame awaiting executor import cannot execute', async () => {
        let resolve; const { add, executor } = setup(); add(); await runtime.createSandbox(0);
        runtime.configureCardScriptRuntime({ executeSlashCommandsWithOptions: null, getSlashExecutor: () => new Promise(done => { resolve = done; }) });
        const pending = runtime.executeSandboxCommand('/echo hello', 0); await tick(); runtime.destroySandbox(0); resolve(executor);
        expect(await pending).toMatchObject({ ok: false, reason: 'stale_sandbox' }); expect(executor).not.toHaveBeenCalled();
    });
    test.each(['/echo {: /send nope :}()', '/echo {{setvar::x::y}}', '/echo onClick=test', '/echo escapeHtml=false <img>', '/echo a"b | /send x"'])('never calls the executor for %s', async command => {
        const { add, executor } = setup(); add(); await runtime.createSandbox(0);
        expect(await runtime.executeSandboxCommand(command, 0)).toMatchObject({ ok: false }); expect(executor).not.toHaveBeenCalled();
    });
});

describe('hybrid protection handshake', () => {
    test('the real outer URL carries no card data and no inner document is built before proof', async () => {
        const { add, buildCardDocument } = setup(); add();
        const record = await api.createSandbox(0);
        const post = jest.spyOn(record.iframeWindow, 'postMessage');
        expect(record.iframeElement.getAttribute('src')).toMatch(/^\/sandbox\/card-script\?v=2#protocol=2&messageId=0&nonce=/);
        expect(record.iframeElement.getAttribute('srcdoc')).toBeNull();
        expect(record.initialized).toBe(false); expect(buildCardDocument).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
        await dispatchProof(record.iframeElement);
        expect(buildCardDocument).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: INIT_MESSAGE_TYPE, protocol: 2, allowUnprotected: false }), '*');
        expect(record.initialized).toBe(true);
    });
    test('unsupported is a stable fallback state even with old and new automatic consent', async () => {
        const { add, buildCardDocument, showConfirmation } = setup(); const message = add();
        const record = await api.createSandbox(0); await dispatchProof(record.iframeElement, 'unsupported');
        expect(api.getActiveSandboxCount()).toBe(0);
        expect(message.querySelector('.mes_text').textContent).toContain('Fallback');
        expect(message.querySelector('.card-script-run-anyway').textContent).toBe('Run anyway');
        expect(message.querySelector('.card-script-isolation-notice').textContent).toContain('anything you type');
        expect(buildCardDocument).not.toHaveBeenCalled(); expect(showConfirmation).not.toHaveBeenCalled();
        expect(await api.createSandbox(0)).toBeNull(); expect(api.getActiveSandboxCount()).toBe(0);
    });
    test('an override binds to this exact message and hash for this page only', async () => {
        const { add, messages } = setup(); const first = add(); add();
        let record = await api.createSandbox(0); await dispatchProof(record.iframeElement, 'unsupported');
        record = await api.createSandbox(0, { manual: true, allowUnprotected: true }); await dispatchProof(record.iframeElement, 'unsupported');
        expect(record.initialized).toBe(true); expect(first.querySelector('.card-script-isolation-notice')).toBeNull();
        expect(await api.createSandbox(1)).toBeNull();
        api.destroySandbox(0, { reason: 'edit' });
        messages[0].mes = '<p>Different content</p><script>different()</script>';
        first.querySelector('.mes_text').innerHTML = markCardScriptHtml(messages[0].mes, 0, { scopeKey: '0' });
        expect(await api.createSandbox(0)).toBeNull();
        expect(first.querySelector('.card-script-run-anyway')).not.toBeNull();
        api.resetCardScriptSession();
        expect(await api.createSandbox(0)).toBeNull();
    });
    test('a later native proof lifts a slow first check so other cards auto-run again', async () => {
        const { add } = setup(); add(); add();
        let record = await api.createSandbox(0); await dispatchProof(record.iframeElement, 'unsupported');
        expect(await api.createSandbox(1)).toBeNull();
        record = await api.createSandbox(0, { manual: true, allowUnprotected: true }); await dispatchProof(record.iframeElement, 'protected');
        expect(record.initialized).toBe(true);
        const other = await api.createSandbox(1);
        expect(other).not.toBeNull(); expect(other.initialized).toBe(false);
    });
    test('direct card or foreign-window bootstrap messages cannot initialise a document', async () => {
        const { add, buildCardDocument } = setup(); add(); const record = await api.createSandbox(0);
        const data = envelope(record, BOOTSTRAP_MESSAGE_TYPE, { protocol: 2, protection: 'protected' });
        expect(await api.handleSandboxMessage({ source: {}, data })).toMatchObject({ reason: 'unknown_source' });
        expect(await api.handleSandboxMessage({ source: record.iframeWindow, data: { ...data, nonce: 'wrong' } })).toMatchObject({ reason: 'bad_nonce' });
        expect(buildCardDocument).not.toHaveBeenCalled();
        expect(await api.handleSandboxMessage({ source: record.iframeWindow, data: envelope(record, READY_MESSAGE_TYPE) })).toMatchObject({ reason: 'not_initialized' });
    });
    test('outer reload invalidates the run; stopped/replaced loading frames cannot send card data', async () => {
        const { add, buildCardDocument } = setup(); add(); let record = await api.createSandbox(0);
        api.destroySandbox(0);
        expect(await dispatchProof(record.iframeElement)).toMatchObject({ reason: 'unknown_source' }); expect(buildCardDocument).not.toHaveBeenCalled();
        record = await api.createSandbox(0, { manual: true }); await dispatchProof(record.iframeElement);
        record.iframeElement.dispatchEvent(new Event('load')); record.iframeElement.dispatchEvent(new Event('load'));
        expect(api.getActiveSandboxCount()).toBe(0);
    });
    test('legacy ungated Android bridge exposure cannot be overridden', async () => {
        const { add, window, buildCardDocument } = setup(); const message = add(); window.NeconyanAndroid = {};
        expect(await api.createSandbox(0, { manual: true, allowUnprotected: true })).toBeNull();
        expect(message.querySelector('.card-script-isolation-notice').textContent).toContain('Update the Android app');
        expect(message.querySelector('.card-script-run-anyway')).toBeNull(); expect(buildCardDocument).not.toHaveBeenCalled();
    });
    test('secured Android can auto-run after proof or run a per-card unsupported override', async () => {
        const { add, window } = setup(); add();
        window.NeconyanExport = { bridgeRequiresToken: () => true };
        window.NeconyanAndroid = { bridgeRequiresToken: () => true };
        let record = await api.createSandbox(0); await dispatchProof(record.iframeElement);
        expect(record.initialized).toBe(true);
        api.destroySandbox(0, { reason: 'edit' });
        record = await api.createSandbox(0); await dispatchProof(record.iframeElement, 'unsupported');
        expect(api.getActiveSandboxCount()).toBe(0);
        record = await api.createSandbox(0, { manual: true, allowUnprotected: true }); await dispatchProof(record.iframeElement, 'unsupported');
        expect(record.initialized).toBe(true);
    });
});
