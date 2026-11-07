import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import webpush from 'web-push';

const MAX_DEVICES = 32;
const MAX_AGE = 24 * 60 * 60 * 1000;
const devicePattern = /^[a-f0-9-]{36}$/i;

export function nativeNotificationFile() {
    return (process.env.NECONYAN_ANDROID_APP === '1' || process.env.NECONYAN_IOS_APP === '1')
        ? process.env.NECONYAN_NATIVE_NOTIFICATION_FILE || '' : '';
}

function read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function save(file, state) {
    writeFileAtomicSync(file, JSON.stringify(state), { mode: 0o600 });
}

function storage(directories) {
    if (!directories?.root) throw new Error('Notification storage is unavailable.');
    return path.join(directories.root, 'push-notifications.json');
}

function load(directories) {
    const file = storage(directories);
    const state = read(file, null);
    if (state) return state;
    const initial = { keys: webpush.generateVAPIDKeys(), devices: {} };
    save(file, initial);
    return initial;
}

export function notificationCapabilities(directories) {
    return { publicKey: load(directories).keys.publicKey, native: Boolean(nativeNotificationFile()) };
}

/** Push URLs are server-side requests, so accept only browser-owned HTTPS services. */
export function validatePushSubscription(value) {
    const url = new URL(value?.endpoint);
    const host = url.hostname;
    const trusted = host === 'fcm.googleapis.com' || host === 'web.push.apple.com'
        || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com')
        || host.endsWith('.notify.windows.com');
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !trusted
        || url.hash || value.endpoint.length > 4096) throw new Error('Unsupported push service.');
    const { p256dh, auth } = value.keys || {};
    const key = text => typeof text === 'string' && /^[\w-]+={0,2}$/.test(text);
    if (!key(p256dh) || Buffer.from(p256dh, 'base64url').length !== 65
        || Buffer.from(p256dh, 'base64url')[0] !== 4 || !key(auth) || Buffer.from(auth, 'base64url').length !== 16) {
        throw new Error('Invalid push keys.');
    }
    return { endpoint: url.href, keys: { p256dh, auth } };
}

export function setNotificationDevice(directories, { device, subscription, native = false, enabled }) {
    if (!devicePattern.test(device || '') || typeof enabled !== 'boolean') throw new Error('Invalid notification device.');
    const state = load(directories);
    if (!enabled) delete state.devices[device];
    else {
        if (native && !nativeNotificationFile()) throw new Error('Native notifications are unavailable.');
        if (!Object.hasOwn(state.devices, device) && Object.keys(state.devices).length >= MAX_DEVICES) throw new Error('Too many notification devices.');
        state.devices[device] = { native: Boolean(native), subscription: native ? null : validatePushSubscription(subscription) };
    }
    save(storage(directories), state);
}

export function shouldNotifyConversation(settings, timeZone = 'UTC', date = new Date()) {
    if (settings?.notifications_muted || settings?.notification_priority === 'silent') return false;
    if (settings?.notification_priority === 'priority') return true;
    const minute = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
    const start = minute(settings?.quiet_hours_start);
    const end = minute(settings?.quiet_hours_end);
    if (start === null || end === null || start === end) return true;
    let parts;
    try { parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date); } catch { parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date); }
    const now = Number(parts.find(part => part.type === 'hour').value) * 60 + Number(parts.find(part => part.type === 'minute').value);
    return !(start < end ? now >= start && now < end : now >= start || now < end);
}

/** Bounded text also keeps encrypted payloads below the Web Push size limit. */
export function notificationText(value, limit = 240) {
    return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function nativeDeliver(payload) {
    const file = nativeNotificationFile();
    if (!file) return;
    const state = read(file, { events: [] });
    const events = state.events.filter(event => event.createdAt > Date.now() - MAX_AGE && event.id !== payload.id);
    events.push(payload);
    save(file, { events: events.slice(-50) });
}

/** Notification failures never turn a successfully saved reply into a failed generation. */
export async function sendSystemNotification(directories, owner, message, onlyDevice = null) {
    try {
        // Do not create keys or files for accounts that have never opted in.
        const state = read(storage(directories), null);
        if (!state) return;
        const common = { id: message.id || randomUUID(), owner, title: notificationText(message.title, 80) || 'Neconyan',
            body: notificationText(message.body), createdAt: Date.now() };
        await Promise.allSettled(Object.entries(state.devices).filter(([id]) => !onlyDevice || id === onlyDevice).map(async ([device, record]) => {
            const payload = { ...common, device };
            if (record.native) { nativeDeliver(payload); return; }
            try {
                await webpush.sendNotification(record.subscription, JSON.stringify(payload), {
                    TTL: 3600, timeout: 10000, urgency: 'normal',
                    vapidDetails: { subject: 'https://github.com/platberlitz/Neconyan', ...state.keys },
                });
            } catch (error) {
                if ([404, 410].includes(error.statusCode)) {
                    const latest = load(directories);
                    if (latest.devices[device]?.subscription?.endpoint === record.subscription.endpoint) {
                        delete latest.devices[device];
                        save(storage(directories), latest);
                    }
                }
            }
        }));
    } catch { console.warn('System notification delivery was unavailable.'); }
}
