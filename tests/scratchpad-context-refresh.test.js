import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from '@jest/globals';

const source = fs.readFileSync(new URL('../public/scripts/scratchpad/index.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const functions = ['activeSession', 'currentSettings', 'applyBucket', 'render', 'renderContext', 'renderNotes'];
const code = functions.map(name => source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0]).join('\n');
const defaults = { notes: [], picked: [], include: {}, assistantConnections: {}, depth: 15, maxTokens: 16000 };
const ref = id => ({ notebookId: 'book', noteId: id });

class Element {
    constructor(tag, attributes = {}, children = []) {
        this.tag = tag;
        this.attributes = attributes;
        this.children = [];
        this.parent = null;
        this.root = false;
        this.append(...children);
    }
    get isConnected() { return this.root || Boolean(this.parent?.isConnected); }
    get childElementCount() { return this.children.length; }
    get textContent() { return [this.attributes.text || '', ...this.children.map(child => child.textContent)].join(' '); }
    append(...children) {
        for (const child of children.flat(Infinity).filter(Boolean)) {
            child.parent = this;
            this.children.push(child);
        }
    }
    replaceChildren(...children) {
        for (const child of this.children) child.parent = null;
        this.children = [];
        this.append(...children);
    }
    find(className) {
        return this.children.flatMap(child => [
            ...(child.attributes.class?.split(' ').includes(className) ? [child] : []), ...child.find(className),
        ]);
    }
}

function fixture() {
    const panel = new Element('div');
    panel.root = true;
    const requests = [];
    const scope = { kind: 'roleplay', key: 'chat' };
    const app = { built: true, open: true, tab: 'context', source: scope, bucket: null, contextKey: '', ticket: 1,
        el: { panels: { context: panel } } };
    const h = (tag, attributes, ...children) => new Element(tag, attributes, children);
    const runtime = vm.createContext({ app, structuredClone, DEFAULT_SETTINGS: defaults, ASSISTANTS: [],
        h, append: (element, children) => element.append(children), clear: element => element.replaceChildren(),
        t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
        renderHeader() {}, renderChat() {}, renderSessions() {}, syncDraft() {}, syncWatchers() {},
        rememberedConnections: () => ({}), connectionProfiles: () => [],
        checkbox: () => h('label'), renderPicks: () => h('section'), renderLore: () => h('section'), renderPreview: () => h('section'),
        iconButton: (text, onclick) => h('button', { text, onclick }), wireSource: value => value,
        isCurrentSource: value => value.key === app.source?.key,
        api: { readNotebookContext: (_source, sessionId) => new Promise((resolve, reject) => requests.push({ sessionId, resolve, reject })) },
    });
    vm.runInContext(code, runtime);
    const bucket = (notes, sessionId = 'one') => ({ source: scope, activeSessionId: sessionId, limits: { notes: 12 },
        sessions: [{ id: sessionId, assistant: 'miso', settings: { ...structuredClone(defaults), notes }, messages: [] }] });
    const apply = (notes, sessionId = 'one', options) => runtime.applyBucket(bucket(notes, sessionId), options);
    const rows = () => panel.find('scratchpad-note').map(row => row.textContent);
    const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
    const reply = (request, notes) => request.resolve({ notes: notes.map(reference => ({ reference, title: reference.noteId, nextOffset: null })) });
    return { app, panel, requests, runtime, apply, rows, settle, reply };
}

describe('Scratchpad Context refresh lifecycle', () => {
    test.each(['session first', 'notes first'])('redraws changed shared notes with %s', async order => {
        const f = fixture();
        f.apply([ref('old')]);
        const stale = f.requests[0];
        if (order === 'notes first') { f.reply(stale, [ref('old')]); await f.settle(); }
        f.apply([ref('old'), ref('new')]);
        expect(f.requests).toHaveLength(2);
        f.reply(f.requests[1], [ref('old'), ref('new')]);
        await f.settle();
        if (order === 'session first') { f.reply(stale, [ref('obsolete')]); await f.settle(); }
        expect(f.rows()).toHaveLength(2);
        expect(f.panel.textContent).toContain('new');
        expect(f.panel.textContent).not.toContain('obsolete');
        expect(f.panel.textContent).not.toContain('Checking shared notes');
        expect(f.app.bucket.sessions[0].settings.notes).toEqual([ref('old'), ref('new')]);
    });

    test.each(['resolve', 'reject'])('ignores a stale note %s after switching sessions', async result => {
        const f = fixture();
        f.apply([ref('old')]);
        const stale = f.requests[0];
        f.apply([ref('current')], 'two');
        f.reply(f.requests[1], [ref('current')]);
        await f.settle();
        if (result === 'resolve') f.reply(stale, [ref('obsolete')]);
        else stale.reject(new Error('Obsolete oversize error'));
        await f.settle();
        expect(f.rows()).toHaveLength(1);
        expect(f.panel.textContent).toContain('current');
        expect(f.panel.textContent).not.toContain('Obsolete');
        expect(f.panel.textContent).not.toContain('obsolete');
        expect(f.app.bucket.activeSessionId).toBe('two');
    });

    test('redraws same-length replacements and pages, but preserves unchanged Context controls', () => {
        const f = fixture();
        f.apply([ref('old')]);
        const originalPanel = f.panel.children[1];
        f.apply([ref('old')]);
        expect(f.requests).toHaveLength(1);
        expect(f.panel.children[1]).toBe(originalPanel);
        f.apply([ref('new')]);
        expect(f.requests).toHaveLength(2);
        f.apply([{ ...ref('new'), offset: 24000 }]);
        expect(f.requests).toHaveLength(3);
    });

    test('redraws empty and populated lists and rejects an outdated bucket ticket', async () => {
        const f = fixture();
        f.apply([]);
        f.apply([ref('new')]);
        expect(f.requests).toHaveLength(1);
        const stale = f.requests[0];
        f.apply([ref('obsolete')], 'one', { ticket: 0 });
        expect(f.requests).toHaveLength(1);
        f.apply([]);
        f.reply(stale, [ref('obsolete')]);
        await f.settle();
        expect(f.rows()).toEqual([]);
        expect(f.panel.textContent).toContain('No saved notes are shared');
        expect(f.panel.textContent).not.toContain('obsolete');
    });

    test('keeps current oversize references removable and rejects a stale error after recovery', async () => {
        const f = fixture();
        f.apply([ref('old')]);
        const stale = f.requests[0];
        f.apply([ref('old'), { ...ref('temporary'), grantId: 'grant' }]);
        f.requests[1].reject(new Error('Share fewer notes or choose a section before sending.'));
        await f.settle();
        expect(f.rows()).toHaveLength(2);
        expect(f.panel.textContent).toContain('Remove');
        expect(f.panel.textContent).toContain('Stop sharing');
        stale.reject(new Error('Obsolete error'));
        await f.settle();
        expect(f.panel.textContent).not.toContain('Obsolete error');
        f.apply([ref('old')]);
        f.reply(f.requests[2], [ref('old')]);
        await f.settle();
        expect(f.rows()).toHaveLength(1);
        expect(f.panel.find('scratchpad-error')).toHaveLength(0);
    });
});
