/** A core-library import must not resume an older whole-account import. */
export function accountImportScope(input) {
    const base = `account-import:${input.mode}`;
    if (input.content !== 'core' || input.mode === 'extensions') return base;
    const parts = ['chats', 'personas', 'characters', 'lorebooks'].filter(part => !input.parts || input.parts.includes(part));
    // Retain the old three-library scope; including lorebooks must never resume a plan that excluded them.
    return `${base}:core${parts.length === 3 && !parts.includes('lorebooks') ? '' : `:${parts.join('+') || 'none'}`}`;
}

/** Keep an uploaded source and its acceptance separate from the lifetime of the importer. */
export function createAccountImportClient({ client, owner, storage, upload, uuid = () => crypto.randomUUID() }) {
    const storageKey = `neconyan-account-import-upload:${owner}`;
    async function retainedZip(file) {
        const raw = storage.getItem(storageKey);
        let pending = raw ? JSON.parse(raw) : null;
        const identity = file && { name: file.name, size: file.size, lastModified: file.lastModified };
        if (pending && (typeof pending.key !== 'string' || !pending.key || !pending.file)) throw new Error('The retained ZIP request is invalid. It has not been replaced.');
        if (!pending) {
            if (!file) throw new Error('Choose the ZIP to import.');
            pending = { key: uuid(), file: identity };
            storage.setItem(storageKey, JSON.stringify(pending));
        }
        // Browser storage outlives a reinstall. Only the current server can confirm a retained source.
        let saved;
        try { saved = await client.request(`/api/operations/import-input/${encodeURIComponent(pending.key)}`); } catch (error) { if (error.status !== 404) throw error; }
        if (!saved || file) {
            if (!file) throw new Error('Select the original ZIP to finish its retained upload.');
            // Picker metadata cannot prove byte identity. Verify every explicit selection,
            // keeping the old key for identical bytes and for uncertain upload outcomes.
            try { saved = await upload(pending.key, file); } catch (error) {
                if (error.code !== 'IMPORT_UPLOAD_CONFLICT') throw error;
                // Preparation only runs before a new operation. A confirmed different ZIP
                // gets its own retained upload; earlier uploads and accepted imports stay intact.
                pending = { key: uuid(), file: identity };
                storage.setItem(storageKey, JSON.stringify(pending));
                saved = await upload(pending.key, file);
            }
        }
        if (typeof saved.inputId !== 'string' || !/^[a-f0-9]{64}$/.test(saved.inputId)) throw new Error('The uploaded ZIP receipt is unreadable. The request has been retained.');
        pending.inputId = saved.inputId;
        if (identity) pending.file = identity;
        storage.setItem(storageKey, JSON.stringify(pending));
        return pending.inputId;
    }
    return async (input, { file, prepareInput = value => value, ...options } = {}) => {
        try {
            const record = await client.run('account-import', input, { ...options, scope: accountImportScope(input), prepareInput: async value => {
                const prepared = value.mode === 'zip' ? { ...value, inputId: await retainedZip(file) } : value;
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
