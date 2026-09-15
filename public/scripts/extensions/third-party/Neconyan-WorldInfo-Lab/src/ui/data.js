import { HISTORY_KEY } from '../constants.js';
import { clearSettings } from '../settings.js';

function historyClearer(module) {
    return module?.clearHistory
        ?? module?.deleteHistory
        ?? module?.resetHistory
        ?? null;
}

export async function clearExtensionData() {
    clearSettings();

    try {
        const history = await import('../history.js');
        const clearHistory = historyClearer(history);
        if (typeof clearHistory === 'function') {
            await clearHistory();
        }
    } catch {
        // History is an optional future module; extension-owned storage is still cleared below.
    }

    for (const name of ['localStorage', 'sessionStorage']) {
        try {
            const storage = globalThis[name];
            storage?.removeItem?.(HISTORY_KEY);
        } catch {
            // Storage can be unavailable in private or sandboxed browser contexts.
        }
    }
}
