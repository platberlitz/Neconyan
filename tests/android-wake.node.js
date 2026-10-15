import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { beginServerWork, configureServerWakeMarker, isServerWorking, serverWorkMiddleware, SERVER_WAKE_IDLE_MS } from '../src/android-wake.js';

function markerFile(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-wake-'));
    const marker = path.join(directory, 'android-busy');
    t.after(() => {
        configureServerWakeMarker(null);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return marker;
}

test('the marker exists while work runs and goes away only after the idle wait', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const marker = markerFile(t);
    fs.writeFileSync(marker, '');
    configureServerWakeMarker(marker);
    assert.equal(fs.existsSync(marker), false, 'a marker left by an earlier run must not keep the phone awake');

    const first = beginServerWork();
    const second = beginServerWork();
    assert.equal(fs.existsSync(marker), true);
    first();
    first();
    t.mock.timers.tick(SERVER_WAKE_IDLE_MS);
    assert.equal(fs.existsSync(marker), true, 'other work is still running');
    second();
    assert.equal(isServerWorking(), false);
    t.mock.timers.tick(SERVER_WAKE_IDLE_MS - 1);
    assert.equal(fs.existsSync(marker), true, 'chained steps get a short grace period');
    const next = beginServerWork();
    t.mock.timers.tick(SERVER_WAKE_IDLE_MS);
    assert.equal(fs.existsSync(marker), true, 'new work cancels the pending release');
    next();
    t.mock.timers.tick(SERVER_WAKE_IDLE_MS);
    assert.equal(fs.existsSync(marker), false);
});

test('requests count as work until they close, but change streams never do', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const marker = markerFile(t);
    configureServerWakeMarker(marker);
    const call = requestPath => {
        const response = new EventEmitter();
        let passed = false;
        serverWorkMiddleware(/** @type {any} */ ({ path: requestPath }), /** @type {any} */ (response), () => { passed = true; });
        assert.equal(passed, true);
        return response;
    };

    call('/api/notebooks/events');
    call('/api/jobs/events/');
    assert.equal(fs.existsSync(marker), false, 'an open Notes page must not keep the phone awake');

    const response = call('/api/backends/chat-completions/generate');
    assert.equal(isServerWorking(), true);
    assert.equal(fs.existsSync(marker), true);
    response.emit('close');
    assert.equal(isServerWorking(), false);
    t.mock.timers.tick(SERVER_WAKE_IDLE_MS);
    assert.equal(fs.existsSync(marker), false);
});

test('servers outside the Android app never write a marker', t => {
    const marker = markerFile(t);
    configureServerWakeMarker(null);
    const response = new EventEmitter();
    serverWorkMiddleware(/** @type {any} */ ({ path: '/api/settings/get' }), /** @type {any} */ (response), () => {});
    assert.equal(response.listenerCount('close'), 0);
    beginServerWork()();
    assert.equal(fs.existsSync(marker), false);
});
