import { t } from './i18n.js';
import { androidNotificationState, setAndroidNotifications } from './android-native-bridge.js';

const STORAGE_KEY = 'neconyan-system-notifications';
const STATE_CACHE = 'neconyan-notification-preferences';
const STATE_URL = '/__neconyan_notification_preferences';
let controller;

function stored() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}

function iosBridge() { return window.webkit?.messageHandlers?.neconyanNotifications; }
function nativeState() {
    if (iosBridge()) return iosBridge().postMessage({ action: 'status' });
    return Promise.resolve(androidNotificationState());
}
function nativeSet(enabled) {
    if (iosBridge()) return iosBridge().postMessage({ action: 'set', enabled });
    return setAndroidNotifications(enabled);
}

async function persist(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if ('caches' in window) {
        const cache = await caches.open(STATE_CACHE);
        await cache.put(STATE_URL, new Response(JSON.stringify(state)));
    }
}

function browserSupport() {
    if (!window.isSecureContext) return t`Notifications need HTTPS or localhost.`;
    if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
        return t`This browser does not support push notifications. On iPhone or iPad, add Neconyan to your Home Screen and open it there.`;
    }
    return '';
}

/** Initialisation never requests permission. The setting belongs to this device and account. */
export async function initPushNotifications({ owner, headers }) {
    const toggle = document.getElementById('push_notifications');
    const status = document.getElementById('push_notifications_status');
    if (!toggle || !status || controller) return;
    const api = async (route, body) => {
        const response = await fetch(`/api/push-notifications/${route}`, {
            method: 'POST', headers: { ...headers(), 'X-Neconyan-Account': owner }, body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(t`Notifications could not connect. Please try again.`);
        return response.status === 204 ? null : response.json();
    };
    let state = stored();
    let native = false;
    let busy = false;
    let revision = 0;
    const offText = () => native
        ? t`Off. Native notifications need the app’s local server to be running.`
        : t`Off. Background DMs need your Neconyan server to stay running.`;
    const update = text => { toggle.checked = Boolean(state.enabled && state.owner === owner); status.textContent = text; };
    const disable = async () => {
        revision++;
        state = { ...state, enabled: false };
        // Stop local delivery first, even if the server is offline.
        const ownsDevice = stored().owner === owner;
        if (ownsDevice) await persist(state).catch(() => {});
        update(offText());
        if (native && ownsDevice) await nativeSet(false);
        else if (ownsDevice && 'serviceWorker' in navigator) {
            const registration = await navigator.serviceWorker.getRegistration();
            await (await registration?.pushManager?.getSubscription())?.unsubscribe();
            for (const notification of await registration?.getNotifications() || []) notification.close();
        }
        if (state.owner === owner && state.device) await api('device', { device: state.device, enabled: false });
    };
    controller = { api, disable, getState: () => state };
    if (state.owner !== owner) {
        state = { owner, device: crypto.randomUUID(), enabled: false };
        await persist(state);
    }
    const refresh = async () => {
        const result = await nativeState();
        if (window.NeconyanExport && !result) {
            toggle.disabled = true;
            update(t`Waiting for native notification support.`);
            return;
        }
        native = Boolean(result);
        const unsupported = native ? '' : browserSupport();
        toggle.disabled = Boolean(unsupported);
        if (native && !state.enabled && result.enabled) await nativeSet(false);
        if (state.enabled && (native ? !result.enabled : unsupported || Notification.permission !== 'granted')) await disable().catch(() => {});
        if (state.enabled && !native && !await (await navigator.serviceWorker.getRegistration())?.pushManager?.getSubscription()) await disable().catch(() => {});
        update(unsupported || (state.enabled ? t`On for this device. Message previews may appear on your lock screen.` : offText()));
    };
    await refresh();
    window.addEventListener('neconyan:android-bridge-ready', () => void refresh());
    window.addEventListener('neconyan:account-changing', () => { void disable().catch(() => {}); });
    window.addEventListener('storage', event => {
        if (event.key === STORAGE_KEY) {
            revision++;
            const latest = stored();
            state = latest.owner === owner ? latest : { ...state, enabled: false };
            update(state.enabled ? t`On for this device.` : offText());
        }
    });
    toggle.addEventListener('change', async () => {
        if (busy) return;
        busy = true;
        toggle.disabled = true;
        const enable = toggle.checked;
        const operation = ++revision;
        const checkCurrent = () => {
            if (operation !== revision || stored().owner !== owner) throw new Error(t`Your notification setting changed. Please try again.`);
        };
        try {
            if (!enable) { await disable(); return; }
            if (stored().owner && stored().owner !== owner) throw new Error(t`Your account changed. Reload Neconyan before enabling notifications.`);
            // Ask within the click gesture, before any network request (required by Safari).
            if (native) {
                const permission = await nativeSet(true);
                if (!permission?.enabled) throw new Error(t`Allow notifications in your device settings, then try again.`);
            } else if (await Notification.requestPermission() !== 'granted') {
                throw new Error(t`Allow notifications in your browser settings, then try again.`);
            }
            checkCurrent();
            const capabilities = await api('capabilities', {});
            checkCurrent();
            if (native && !capabilities.native) throw new Error(t`Native notifications are unavailable on this server.`);
            let subscription;
            if (!native) {
                const registration = await navigator.serviceWorker.getRegistration();
                if (!registration?.active) throw new Error(t`Notifications are not ready yet. Reload Neconyan and try again.`);
                const base64 = capabilities.publicKey.replace(/-/g, '+').replace(/_/g, '/');
                const key = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
                subscription = await registration.pushManager.getSubscription();
                if (subscription && String(new Uint8Array(subscription.options.applicationServerKey)) !== String(key)) {
                    await subscription.unsubscribe();
                    subscription = null;
                }
                if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
            }
            checkCurrent();
            state = { owner, device: state.device || crypto.randomUUID(), enabled: false };
            await api('device', { device: state.device, enabled: true, native, subscription: subscription?.toJSON() });
            checkCurrent();
            state.enabled = true;
            await persist(state);
            update(t`On for this device. Message previews may appear on your lock screen.`);
        } catch (error) {
            await disable().catch(() => {});
            update(error.message);
        } finally { busy = false; toggle.disabled = false; }
    });
}

export async function disablePushNotifications() { await controller?.disable(); }

export function mirrorToastNotification(args) {
    if (args?.state !== 'visible' || args.map?.optionsOverride?.neconyanSystemNotification === false) return;
    const state = controller?.getState();
    if (!state?.enabled || state.owner !== stored().owner || !stored().enabled) return;
    const text = value => {
        const parsed = new DOMParser().parseFromString(String(value || ''), 'text/html');
        return parsed.body.textContent.trim().slice(0, 500);
    };
    void controller.api('toast', { device: state.device, title: text(args.map?.title) || 'Neconyan', body: text(args.map?.message) }).catch(() => {});
}
