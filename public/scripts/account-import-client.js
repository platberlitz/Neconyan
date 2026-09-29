/** Keep an uploaded source and its acceptance separate from the lifetime of the importer. */
export function createAccountImportClient({ client, owner, storage, upload, uuid = () => crypto.randomUUID() }) {
    const storageKey = `neconyan-account-import-upload:${owner}`;
    async function retainedZip(file) {
        const raw = storage.getItem(storageKey);
        let pending = raw ? JSON.parse(raw) : null;
        const identity = file && { name: file.name, size: file.size, lastModified: file.lastModified };
        if (pending && (typeof pending.key !== 'string' || !pending.key || !pending.file)) throw new Error('The retained ZIP request is invalid. It has not been replaced.');
        if (pending && identity && JSON.stringify(pending.file) !== JSON.stringify(identity)) throw new Error('A different ZIP upload is still awaiting its saved result. Resume that import first.');
        if (!pending) {
            if (!file) throw new Error('Choose the ZIP to import.');
            pending = { key: uuid(), file: identity };
            storage.setItem(storageKey, JSON.stringify(pending));
        }
        if (!pending.inputId) {
            let saved;
            try { saved = await client.request(`/api/operations/import-input/${encodeURIComponent(pending.key)}`); } catch (error) { if (error.status !== 404) throw error; }
            if (!saved) {
                if (!file) throw new Error('Select the original ZIP to finish its retained upload.');
                saved = await upload(pending.key, file);
            }
            if (typeof saved.inputId !== 'string' || !/^[a-f0-9]{64}$/.test(saved.inputId)) throw new Error('The uploaded ZIP receipt is unreadable. The request has been retained.');
            pending.inputId = saved.inputId;
            storage.setItem(storageKey, JSON.stringify(pending));
        }
        return pending.inputId;
    }
    return async (input, { file, prepareInput = value => value, ...options } = {}) => {
        try {
            const record = await client.run('account-import', input, { ...options, scope: `account-import:${input.mode}`, prepareInput: async value => {
                const prepared = value.mode === 'zip' ? { mode: 'zip', inputId: await retainedZip(file) } : value;
                return prepareInput(prepared);
            } });
            if (input.mode === 'zip') storage.removeItem(storageKey);
            return record;
        } catch (error) {
            if (input.mode === 'zip' && (error.refused || error.cancelled || error.notAccepted === true)) storage.removeItem(storageKey);
            throw error;
        }
    };
}
