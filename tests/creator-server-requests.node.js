/* global globalThis */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderCreatorServerRequests } from '../public/scripts/creator/server-generation.js';

class TestElement {
    constructor(tag) {
        this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {};
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    prepend(child) { child.parent = this; this.children.unshift(child); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(name, action) { this.events[name] = action; }
    click() { return this.events.click?.(); }
    get isConnected() { return this.root === true || !!this.parent?.isConnected; }
    querySelector(selector) {
        const matches = node => selector === '.creator-content' ? node.className === 'creator-content'
            : selector === '[data-creator-server-requests]' ? Object.hasOwn(node.dataset, 'creatorServerRequests')
                : selector === '[data-creator-server-result]' ? Object.hasOwn(node.dataset, 'creatorServerResult') : node.tag === selector;
        for (const child of this.children) {
            if (matches(child)) return child;
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }
}

function fixture(t, request) {
    const previous = globalThis.document;
    globalThis.document = { createElement: tag => new TestElement(tag) };
    t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
    const host = new TestElement('div'); host.root = true;
    const main = new TestElement('main'); main.className = 'creator-content';
    const actions = new TestElement('div'); host.append(actions, main);
    const workspace = {
        host, busy: false, session: { draft: { id: 'draft' }, request },
        async run(action) {
            if (this.busy) return;
            this.busy = true;
            try { return await action(); } finally { this.busy = false; }
        },
    };
    renderCreatorServerRequests(workspace, actions);
    return { workspace, main, toggle: actions.children[0], panel: () => main.querySelector('[data-creator-server-requests]') };
}

test('Server requests opens, closes on the second click without a request, and reopens with fresh jobs', async t => {
    const calls = [];
    const { toggle, panel } = fixture(t, async (...args) => { calls.push(args); return { jobs: [] }; });
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click();
    assert.ok(panel());
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.getAttribute('aria-controls'), panel().id);
    assert.equal(panel().getAttribute('aria-busy'), undefined);
    await toggle.click();
    assert.equal(panel(), null);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(calls.length, 1);
    await toggle.click();
    assert.ok(panel());
    assert.deepEqual(calls, [['generation', { id: 'draft' }], ['generation', { id: 'draft' }]]);
});

test('closing Server requests while loading prevents its late response from reopening the panel', async t => {
    const response = Promise.withResolvers();
    const { toggle, panel, workspace } = fixture(t, () => response.promise);
    const loading = toggle.click();
    assert.equal(workspace.busy, true);
    assert.ok(panel());
    await toggle.click();
    assert.equal(panel(), null);
    response.resolve({ jobs: [{ id: 'job', label: 'Late job', state: 'completed' }] });
    await loading;
    assert.equal(panel(), null);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('Server requests discards responses for a draft or view that has been left', async t => {
    const response = Promise.withResolvers();
    const { toggle, panel, workspace } = fixture(t, () => response.promise);
    const loading = toggle.click();
    workspace.session.draft = { id: 'another-draft' };
    response.resolve({ jobs: [] });
    await loading;
    assert.equal(panel(), null);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    const later = Promise.withResolvers();
    workspace.session.request = () => later.promise;
    const nextLoading = toggle.click();
    panel().remove();
    later.resolve({ jobs: [] });
    await nextLoading;
    assert.equal(panel(), null);
});

test('a failed Server requests fetch closes the panel and can be retried', async t => {
    const { toggle, panel, workspace } = fixture(t, async () => { throw new Error('Offline'); });
    await assert.rejects(toggle.click(), /Offline/);
    assert.equal(panel(), null);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    workspace.session.request = async () => ({ jobs: [] });
    await toggle.click();
    assert.ok(panel());
});
