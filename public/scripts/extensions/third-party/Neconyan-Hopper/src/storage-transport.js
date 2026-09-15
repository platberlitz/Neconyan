import { SETTINGS_KEY } from './core.js';
import { HOST_PLUGIN_MARKER, HOST_STORE_NAME, MAX_STORE_BYTES, encodedLimit, migrateLegacy, parseBytes, storeFrom } from './storage-format.js';

/** Use Neconyan's native storage service when available; never downgrade an established server store. */
export function createStorageTransport({ request, readJson, localStorage = () => globalThis.localStorage }) {
    let mode = 'unknown';
    let account;
    let fileSeen = false;
    const storePath = `/user/files/${HOST_STORE_NAME}`;

    function fileEvidence() {
        try {
            const storage = localStorage();
            const key = `hopper:standalone-established:${JSON.stringify(account)}`;
            const saved = storage.getItem(key);
            if (saved !== null && saved !== '0' && saved !== '1') throw new Error('Invalid standalone evidence.');
            fileSeen ||= saved === '1';
            // Check persistence before an initial upload without claiming that a file exists yet.
            storage.setItem(key, fileSeen ? '1' : '0');
            return fileSeen;
        } catch (cause) {
            throw new Error('Browser localStorage could not read or save standalone file evidence. Meower is blocked to prevent overwriting saved history; restore localStorage access before retrying.', { cause });
        }
    }

    async function signedIn() {
        const response = await request('/api/users/me', { method: 'GET' });
        if (!response.ok) throw new Error('Sign in before opening or saving Meower.');
        const user = await readJson(response, 'The signed-in account');
        if (typeof user?.handle !== 'string' || !user.handle.trim()) throw new Error('The host did not identify the signed-in account.');
        if (account && user.handle !== account) throw new Error('The signed-in account changed. Reload Meower before continuing.');
        account = user.handle;
        return account;
    }

    async function readFile(url, limit) {
        const response = await request(url, { method: 'GET' });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Saved Meower data could not be read (${response.status}). Nothing was replaced.`);
        if (Number(response.headers.get('content-length')) > limit) throw new Error('Saved Meower data exceeds the supported size limit.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > limit) throw new Error('Saved Meower data exceeds the supported size limit.');
        return bytes;
    }

    async function extensionStore() {
        if (await readFile(`/user/files/${HOST_PLUGIN_MARKER}`, 4096) !== null) {
            throw new Error('This account has moved to native storage. Restart Neconyan to open its latest history; the older local copy will not be overwritten.');
        }
        const bytes = await readFile(storePath, encodedLimit());
        if (bytes !== null) {
            const raw = parseBytes(bytes, { base64: true });
            if (raw?.account !== undefined && raw.account !== account) throw new Error('The saved Meower file belongs to a different account. Nothing was replaced.');
            const { store, warnings } = storeFrom(raw);
            fileSeen = true;
            fileEvidence();
            return { ...store, account, warnings };
        }
        if (fileEvidence()) throw new Error('The saved Meower file is missing. Restore it before saving; old history will not be reimported.');
        const response = await request('/api/settings/get', { method: 'POST', body: '{}' });
        if (!response.ok) throw new Error(`The existing host settings could not be read (${response.status}).`);
        const data = await readJson(response, 'The host settings');
        if (typeof data?.settings !== 'string') throw new Error('The host settings could not be read safely.');
        const host = parseBytes(new TextEncoder().encode(data.settings));
        if (!host || typeof host !== 'object' || Array.isArray(host) || (host.extension_settings !== undefined
            && (!host.extension_settings || typeof host.extension_settings !== 'object' || Array.isArray(host.extension_settings)))) {
            throw new Error('The host settings could not be read safely.');
        }
        const raw = Object.hasOwn(host.extension_settings ?? {}, SETTINGS_KEY) ? host.extension_settings[SETTINGS_KEY] : undefined;
        const { store, warnings } = await migrateLegacy(raw, readFile);
        return { ...store, account, warnings };
    }

    async function plugin(method, body, revision) {
        const response = await request(`/api/plugins/hopper/store${revision === undefined ? '' : `?revision=${revision}`}`, {
            method, ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (response.status === 404) {
            if (mode === 'server') throw new Error('The native Meower storage service is unavailable. Restart Neconyan before saving; local storage was not used.');
            return null;
        }
        const data = await readJson(response, 'Meower storage');
        if (!response.ok && response.status !== 409) throw new Error(data.error || `Could not save or read Meower storage (${response.status}).`);
        return { ...data, ...(response.status === 409 ? { conflict: true } : {}) };
    }

    async function writeExtension(body) {
        await signedIn();
        if (body?.account !== account) throw new Error('The signed-in account changed. Reload Meower before saving.');
        const current = await extensionStore();
        const candidate = storeFrom(body, { strict: true, status: 400 }).store;
        if (candidate.revision !== current.revision) return { ...current, conflict: true };
        if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error('The Meower revision limit has been reached. Nothing was saved.');
        const store = { ...candidate, revision: current.revision + 1, account };
        const bytes = new TextEncoder().encode(JSON.stringify(store));
        if (bytes.byteLength > MAX_STORE_BYTES) throw new Error('The Meower store exceeds 128 MiB. Nothing was saved.');
        const binary = [];
        for (let offset = 0; offset < bytes.length; offset += 32768) binary.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
        // Check again after reading/migrating, which can outlast the initial availability check.
        if (await plugin('GET') !== null) throw new Error('The native Meower storage service is now available. Reload Meower to use shared storage; your pending changes are kept for recovery.');
        await signedIn();
        const response = await request('/api/files/upload', {
            method: 'POST', body: JSON.stringify({ name: HOST_STORE_NAME, data: btoa(binary.join('')) }),
        });
        if (!response.ok) throw new Error(`The Meower file could not be saved (${response.status}). Your changes are kept for recovery.`);
        const result = await readJson(response, 'The Meower file upload');
        if (result.path !== storePath) throw new Error('The host did not confirm the expected Meower file. Your changes are kept for recovery.');
        fileSeen = true;
        fileEvidence();
        await signedIn();
        const saved = await extensionStore();
        if (JSON.stringify(storeFrom(saved).store) !== JSON.stringify(storeFrom(store).store)) {
            throw new Error('The Meower file changed before its save could be confirmed. Keep one tab/device active and export recovery.');
        }
        return saved;
    }

    return {
        get mode() { return mode; },
        async request(method, body, revision) {
            const shared = await plugin(mode === 'extension' ? 'GET' : method, mode === 'extension' ? undefined : body, revision);
            if (shared !== null) {
                if (mode === 'extension') throw new Error('The native Meower storage service is now available. Reload Meower to use shared storage; your pending changes are kept for recovery.');
                mode = 'server';
                return shared;
            }
            await signedIn();
            if (method === 'GET') {
                const saved = await extensionStore();
                mode = 'extension';
                return revision === saved.revision ? { account, revision, unchanged: true } : saved;
            }
            if (mode !== 'extension') throw new Error('Open Meower storage before saving.');
            // ponytail: Web Locks coordinate this browser only. The optional server is required
            // for concurrent devices because the host upload endpoint cannot compare revisions.
            const locks = globalThis.navigator?.locks;
            return locks?.request ? locks.request(`hopper-extension-store:${account}`, () => writeExtension(body)) : writeExtension(body);
        },
    };
}
