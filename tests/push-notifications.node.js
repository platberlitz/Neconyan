import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createECDH, randomUUID } from 'node:crypto';
import test from 'node:test';
import webpush from 'web-push';
import express from 'express';
import { notificationCapabilities, setNotificationDevice, sendSystemNotification, shouldNotifyConversation, validatePushSubscription } from '../src/push-notifications.js';
import { router } from '../src/endpoints/push-notifications.js';

const subscription = (endpoint = 'https://fcm.googleapis.com/fcm/send/fixture') => {
    const key = createECDH('prime256v1');
    return { endpoint, keys: { p256dh: key.generateKeys().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } };
};
function account(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-notifications-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root };
}

test('default-off does not create credentials; opt-in persists private keys and device-scoped delivery', async t => {
    const directories = account(t);
    const deliveries = [];
    t.mock.method(webpush, 'sendNotification', async (target, payload, options) => deliveries.push({ target, payload: JSON.parse(payload), options }));
    await sendSystemNotification(directories, 'alice', { body: 'Before opting in' });
    assert.deepEqual(fs.readdirSync(directories.root), []);
    const a = randomUUID(), b = randomUUID();
    const keys = notificationCapabilities(directories);
    assert.deepEqual(notificationCapabilities(directories), keys);
    assert.equal(fs.statSync(path.join(directories.root, 'push-notifications.json')).mode & 0o777, 0o600);
    setNotificationDevice(directories, { device: a, enabled: true, subscription: subscription() });
    setNotificationDevice(directories, { device: b, enabled: true, subscription: subscription('https://web.push.apple.com/fixture') });
    await sendSystemNotification(directories, 'alice', { title: '<b>Toast</b>', body: 'Only here' }, a);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.device, a);
    assert.equal(deliveries[0].payload.owner, 'alice');
    assert.equal(deliveries[0].payload.title, 'Toast');
    await sendSystemNotification(directories, 'alice', { id: 'reply-1', body: 'DM on all devices' });
    assert.equal(deliveries.length, 3);
    setNotificationDevice(directories, { device: a, enabled: false });
    await sendSystemNotification(directories, 'alice', { body: 'Disabled toast' }, a);
    assert.equal(deliveries.length, 3);
    const other = account(t);
    await sendSystemNotification(other, 'bob', { body: 'Private' });
    assert.equal(deliveries.length, 3);
});

test('push registration rejects server-side request forgery and malformed keys', () => {
    for (const endpoint of ['http://fcm.googleapis.com/a', 'https://127.0.0.1/a', 'https://fcm.googleapis.com.evil.test/a', 'https://user@web.push.apple.com/a', 'https://web.push.apple.com:444/a']) {
        assert.throws(() => validatePushSubscription(subscription(endpoint)));
    }
    assert.throws(() => validatePushSubscription({ ...subscription(), keys: { auth: 'x', p256dh: 'y' } }));
    assert.equal(validatePushSubscription(subscription('https://updates.push.services.mozilla.com/wpush/v2/a')).endpoint, 'https://updates.push.services.mozilla.com/wpush/v2/a');
});

test('expired registrations are removed without losing concurrent opt-ins', async t => {
    const directories = account(t), device = randomUUID(), added = randomUUID();
    setNotificationDevice(directories, { device, enabled: true, subscription: subscription() });
    t.mock.method(webpush, 'sendNotification', async () => {
        setNotificationDevice(directories, { device: added, enabled: true, subscription: subscription('https://web.push.apple.com/new') });
        throw Object.assign(new Error('Gone'), { statusCode: 410 });
    });
    await sendSystemNotification(directories, 'alice', { body: 'Hello' });
    const saved = JSON.parse(fs.readFileSync(path.join(directories.root, 'push-notifications.json')));
    assert.deepEqual(Object.keys(saved.devices), [added]);
});

test('native delivery uses a bounded private inbox and stops after opt-out', async t => {
    const directories = account(t), device = randomUUID();
    const previous = { app: process.env.NECONYAN_IOS_APP, file: process.env.NECONYAN_NATIVE_NOTIFICATION_FILE };
    t.after(() => {
        for (const [key, value] of [['NECONYAN_IOS_APP', previous.app], ['NECONYAN_NATIVE_NOTIFICATION_FILE', previous.file]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
    process.env.NECONYAN_IOS_APP = '1';
    const file = path.join(directories.root, 'inbox.json');
    process.env.NECONYAN_NATIVE_NOTIFICATION_FILE = file;
    setNotificationDevice(directories, { device, enabled: true, native: true });
    for (let i = 0; i < 60; i++) await sendSystemNotification(directories, 'default-user', { id: String(i), body: 'Hello' });
    await sendSystemNotification(directories, 'default-user', { id: '59', body: 'Same ID' });
    const before = fs.readFileSync(file, 'utf8');
    const events = JSON.parse(before).events;
    assert.equal(events.length, 50);
    assert.equal(new Set(events.map(event => event.id)).size, 50);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    setNotificationDevice(directories, { device, enabled: false });
    await sendSystemNotification(directories, 'default-user', { body: 'Disabled' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('DM policy honours mute, priority, timezone and overnight quiet hours', () => {
    const at = new Date('2026-11-07T15:00:00Z');
    const quiet = { quiet_hours_start: '22:00', quiet_hours_end: '08:00' };
    assert.equal(shouldNotifyConversation(quiet, 'Asia/Manila', at), false);
    assert.equal(shouldNotifyConversation(quiet, 'UTC', at), true);
    assert.equal(shouldNotifyConversation({ ...quiet, notification_priority: 'priority' }, 'Asia/Manila', at), true);
    assert.equal(shouldNotifyConversation({ notification_priority: 'priority', notifications_muted: true }), false);
    assert.equal(shouldNotifyConversation({ notification_priority: 'silent' }), false);
    assert.equal(shouldNotifyConversation({ quiet_hours_start: '15:00', quiet_hours_end: '16:00' }, 'UTC', at), false);
    assert.equal(shouldNotifyConversation({ quiet_hours_start: '14:00', quiet_hours_end: '15:00' }, 'UTC', at), true);
});

test('notification routes require matching authenticated accounts', async t => {
    const directories = account(t);
    const app = express();
    app.use(express.json());
    app.use((request, _response, next) => { request.user = { directories, profile: { handle: 'alice' } }; next(); });
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/capabilities`, { method: 'POST' })).status, 409);
    assert.equal((await fetch(`${url}/device`, { method: 'POST', headers: { 'X-Neconyan-Account': 'bob' } })).status, 409);
    assert.deepEqual(fs.readdirSync(directories.root), []);
    const response = await fetch(`${url}/capabilities`, { method: 'POST', headers: { 'X-Neconyan-Account': 'alice' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${url}/toast`, { method: 'POST', headers: { 'X-Neconyan-Account': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ device: '', body: 'Do not broadcast' }) })).status, 400);
});

test('background service worker delivers only opted-in account/device and never opens supplied links', async () => {
    const handlers = {}, shown = [], opened = [];
    let preferences = { owner: 'alice', device: 'one', enabled: false };
    const context = { URL, console, caches: { open: async () => ({ match: async () => ({ json: async () => preferences }) }) },
        self: { addEventListener: (name, handler) => { handlers[name] = handler; }, location: { origin: 'https://neconyan.test' },
            registration: { showNotification: async (...args) => shown.push(args) },
            clients: { matchAll: async () => [], openWindow: async url => opened.push(url) } } };
    vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
    const push = async message => { let completion; handlers.push({ data: { json: () => message }, waitUntil: work => { completion = work; } }); await completion; };
    const message = { owner: 'alice', device: 'one', id: 'dm-1', title: 'Nova', body: 'Hello', url: 'https://evil.test' };
    await push(message);
    preferences.enabled = true;
    await push({ ...message, owner: 'bob' });
    await push({ ...message, device: 'two' });
    assert.equal(shown.length, 0);
    await push(message);
    assert.equal(shown.length, 1);
    assert.equal(shown[0][1].tag, 'dm-1');
    let completion;
    handlers.notificationclick({ notification: { data: message, close() {} }, waitUntil: work => { completion = work; } });
    await completion;
    assert.deepEqual(opened, ['/']);
    preferences.enabled = false;
    handlers.notificationclick({ notification: { data: message, close() {} }, waitUntil: work => { completion = work; } });
    await completion;
    assert.deepEqual(opened, ['/']);
});
