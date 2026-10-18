/**
 * UI state that must outlive a redraw: the selected tab, Playground text, the
 * reference query and the open custom-macro draft. None of this belongs in
 * extension settings, which are saved as a whole file.
 */
const STORAGE_KEY = 'MacroEnhanced.ui.v1';
const VALID_TABS = Object.freeze(['playground', 'reference', 'macros', 'chat', 'setup']);

function readStoredTab() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return 'playground';
        }
        const parsed = JSON.parse(raw);
        return VALID_TABS.includes(parsed?.tab) ? parsed.tab : 'playground';
    } catch {
        return 'playground';
    }
}

export const uiState = {
    activeTab: readStoredTab(),
    playgroundText: '',
    referenceQuery: '',
    referenceFilter: 'all',
    /** @type {{def: object, scope: string, persistedScope: string|null, snapshot: object, isNew: boolean}|null} */
    editorDraft: null,
};

export function setActiveTab(tab, { persist = true } = {}) {
    const next = VALID_TABS.includes(tab) ? tab : 'playground';
    uiState.activeTab = next;
    if (!persist) {
        return;
    }
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ tab: next }));
    } catch {
        // A blocked localStorage must never stop the page working.
    }
}
