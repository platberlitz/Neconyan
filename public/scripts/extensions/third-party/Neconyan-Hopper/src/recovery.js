// Browser recovery is required, never an optional best-effort cache.
export function browserRecovery() {
    let opening;
    async function database() {
        if (!globalThis.indexedDB) throw new Error('Browser recovery storage is unavailable. Keep this tab open.');
        opening ??= new Promise((resolve, reject) => {
            const request = indexedDB.open('hopper-recovery', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('pending', { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Browser recovery storage is blocked.'));
        });
        return opening;
    }
    async function transaction(mode, run) {
        const db = await database();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('pending', mode, { durability: 'strict' });
            const request = run(tx.objectStore('pending'));
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Browser recovery could not be saved.'));
        });
    }
    return {
        claimOwner: owner => claimRecoveryOwner(owner),
        async list(account) {
            return (await transaction('readonly', store => store.getAll())).filter(item => item.account === account);
        },
        put: record => transaction('readwrite', store => store.put(record)),
        remove: record => transaction('readwrite', store => {
            const request = store.get(record.id);
            request.onsuccess = () => {
                if (request.result?.token === record.token) store.delete(record.id);
            };
            return request;
        }),
    };
}

/** Hold until disposal/tab death. No Web Locks means ownership cannot be proved. */
export async function claimRecoveryOwner(owner, locks = globalThis.navigator?.locks) {
    if (!locks?.request) return undefined;
    return new Promise((resolve, reject) => {
        const held = locks.request(`hopper-recovery-owner:${owner}`, { ifAvailable: true }, lock => {
            if (!lock) { resolve(null); return; }
            return new Promise(release => { resolve(() => { release(); return held; }); });
        });
        held.catch(reject);
    });
}
