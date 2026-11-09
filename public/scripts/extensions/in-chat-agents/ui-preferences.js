/** Keep navigation on this device through reloads while account settings save. */
export function createAgentUiPreferences({ accountStorage, getAccount, getLocalStorage = () => globalThis.localStorage }) {
    const session = new Map();
    const keyFor = key => `ica--ui:${JSON.stringify([getAccount(), key])}`;

    function getItem(key) {
        const localKey = keyFor(key);
        if (session.has(localKey)) return session.get(localKey);
        try {
            const value = getLocalStorage().getItem(localKey);
            if (value !== null) {
                session.set(localKey, value);
                // Restore changes made before the previous page's delayed save.
                try { accountStorage.setItem(key, value); } catch { /* Local state still works. */ }
                return value;
            }
        } catch { /* Browser storage can be disabled. */ }
        try { return accountStorage.getItem(key); } catch { return null; }
    }

    function setItem(key, value) {
        const localKey = keyFor(key);
        session.set(localKey, value);
        try { getLocalStorage().setItem(localKey, value); } catch { /* Keep the session choice. */ }
        try { accountStorage.setItem(key, value); } catch { /* Browser persistence still works. */ }
    }

    return { getItem, setItem };
}

export function readCollapsedAgentCategories(preferences, key, categories) {
    try {
        const saved = JSON.parse(preferences.getItem(key));
        return new Set(Array.isArray(saved) ? saved.filter(category => typeof category === 'string' && Object.hasOwn(categories, category)) : []);
    } catch {
        return new Set();
    }
}
