import { t } from './i18n.js';
import { acceptAndroidMemoryProfile } from './low-memory-mode.js';

let callerToken = null;
let installed = false;

function isMainPage() {
    return globalThis.window && globalThis.window === globalThis.window.top;
}

function invoke(bridge, method, args = [], token = callerToken) {
    if (!isMainPage() || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
    const target = globalThis[bridge];
    if (typeof target?.[method] !== 'function') return false;
    return target[method](token, ...args);
}

export function installAndroidNativeBridge(token, expectedOrigin, memoryProfile) {
    if (!isMainPage() || globalThis.window.location.origin !== expectedOrigin || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return false;
    callerToken = token;
    if (typeof acceptAndroidMemoryProfile === 'function') acceptAndroidMemoryProfile(memoryProfile);
    if (!installed) {
        installed = true;
        globalThis.document.addEventListener('click', event => {
            const anchor = event.target.closest('a[download]');
            if (anchor && anchor.href.startsWith('blob:')) { event.preventDefault(); void saveAndroidBlob(anchor.href, anchor.download); }
        }, true);
        const click = globalThis.HTMLAnchorElement.prototype.click;
        globalThis.HTMLAnchorElement.prototype.click = function () {
            if (!this.isConnected && this.hasAttribute('download') && this.href.startsWith('blob:')) { void saveAndroidBlob(this.href, this.download); return; }
            return click.call(this);
        };
        // Existing download callbacks may call this function; the capability itself is never public.
        globalThis.window.neconyanSaveBlob = saveAndroidBlob;
    }
    globalThis.window.dispatchEvent(new Event('neconyan:android-bridge-ready'));
    return true;
}

export function requestAndroidUpdate(version) {
    if (typeof version !== 'string') return false;
    return invoke('NeconyanAndroid', 'installUpdate', [version]);
}

export function showAndroidCrashReports() {
    return invoke('NeconyanExport', 'showCrashReports');
}

export async function saveAndroidBlob(url, name) {
    const token = callerToken;
    try {
        if (!isMainPage() || !token) return false;
        const blob = await (await globalThis.fetch(url)).blob();
        if (invoke('NeconyanExport', 'beginExport', [name || 'Neconyan-export', blob.size], token) !== true) throw new Error(t`Another export is open, the page changed, or the file exceeds 1 GiB.`);
        for (let at = 0; at < blob.size; at += 49152) {
            const bytes = new Uint8Array(await blob.slice(at, at + 49152).arrayBuffer());
            if (invoke('NeconyanExport', 'appendExport', [globalThis.btoa(String.fromCharCode(...bytes))], token) !== true) throw new Error(t`Could not save the export. Check free storage.`);
        }
        if (invoke('NeconyanExport', 'finishExport', [], token) !== true) throw new Error(t`The page changed before the export finished. Try again.`);
        return true;
    } catch (error) {
        invoke('NeconyanExport', 'cancelExport', [], token);
        globalThis.alert(error.message);
        return false;
    }
}
