import { getRequestHeaders, refreshCsrfToken } from '../script.js';
import { getCurrentUserHandle } from './user.js';
import { fetchWithCsrfRetry } from './csrf-token-refresh.js';

const groups = { character: 'Characters', persona: 'Personas', chat: 'Chat messages', lorebook: 'Lorebooks', lore: 'Lorebook entries', notebook: 'Notebooks', note: 'Notebook notes' };
const actions = { character: 'Open character', persona: 'Find persona', chat: 'Open chat', lorebook: 'Open lorebook', lore: 'Open entry', notebook: 'Open notebook', note: 'Open note' };

export async function searchSavedContent(query, { signal, offset = 0 } = {}) {
    const owner = getCurrentUserHandle();
    const response = await fetchWithCsrfRetry('/api/account-search', () => ({
        method: 'POST', signal, headers: { ...getRequestHeaders(), 'X-Neconyan-Account': owner },
        body: JSON.stringify({ query, offset }),
    }), { refreshCsrfToken });
    if (!response.ok) throw new Error('Saved content could not be searched. Try again.');
    const data = await response.json();
    if (owner !== getCurrentUserHandle()) throw new Error('The account changed. Search again.');
    return { ...data, results: data.results.map(result => ({ ...result, displayText: result.title,
        groupLabel: groups[result.kind], kindLabel: result.target.orphan ? 'Find in Chat Archive' : actions[result.kind],
        dedupeKey: result.id, shellKey: 'saved', owner })) };
}

export async function openSavedSearchResult(result, { openCharacters, openPersona, openLorebooks, openArchive }) {
    if (result.owner !== getCurrentUserHandle()) throw new Error('The account changed. Search again.');
    const target = result.target;
    switch (result.kind) {
        case 'character': return openCharacters(target.avatar);
        case 'persona': return openPersona(target);
        case 'notebook':
        case 'note': return (await import('./notebooks/notes-app.js')).openNotes(target);
        case 'lorebook':
        case 'lore': {
            openLorebooks();
            const world = await import('./world-info.js');
            const select = document.getElementById('world_editor_select');
            if (select) select.value = String(world.world_names.indexOf(target.name));
            await world.showWorldEditor(target.name);
            if (target.uid !== undefined) await world.selectWorldInfoEntry(target.uid);
            return;
        }
        case 'chat':
            if (target.orphan) return openArchive(target.archiveHash);
            return (await import('./chat-navigation.js')).requestSavedSearchNavigation(target);
    }
}
