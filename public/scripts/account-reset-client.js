/** Only the operation key is retained. Passwords and confirmation codes stay in this invocation. */
export function createAccountResetClient({ client, owner, storage, uuid = () => crypto.randomUUID() }) {
    const storageKey = `neconyan-account-reset:${owner}`;
    return async function reset(credentials, options = {}) {
        options.signal?.throwIfAborted();
        const retained = storage.getItem(storageKey);
        const key = retained || uuid();
        if (typeof key !== 'string' || !key || key.length > 200) throw new Error('The saved reset request needs recovery.');
        let record;
        if (retained) {
            try { record = await client.read(key); } catch (error) { if (error.status !== 404) throw error; }
        } else storage.setItem(storageKey, key);
        if (!record) {
            const accepted = await client.request('/api/users/reset-step2', { method: 'POST',
                body: JSON.stringify({ key, password: credentials.password, code: credentials.code }) });
            record = accepted.record;
        }
        try {
            const completed = await client.observe(record, options);
            storage.removeItem(storageKey);
            return completed;
        } catch (error) {
            if (error.refused || error.cancelled) storage.removeItem(storageKey);
            throw error;
        }
    };
}
