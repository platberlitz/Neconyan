import { SETTINGS_FILE, USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { operationError } from './store.js';

export const CORE_IMPORT_PARTS = ['chats', 'personas', 'characters'];
const ATTACHMENT_DIRECTORIES = [USER_DIRECTORY_TEMPLATE.files, USER_DIRECTORY_TEMPLATE.userImages];

export function normaliseCoreImportParts(parts = CORE_IMPORT_PARTS) {
    if (!Array.isArray(parts) || !parts.length || parts.length > CORE_IMPORT_PARTS.length || parts.some(part => !CORE_IMPORT_PARTS.includes(part))) {
        throw operationError('Select at least one library: chats, personas or character cards.', 400);
    }
    return CORE_IMPORT_PARTS.filter(part => parts.includes(part));
}

function importPart(relative, directory) {
    const root = relative.split('/')[0];
    if (root === 'characters') return 'characters';
    if (root === USER_DIRECTORY_TEMPLATE.avatars || relative === SETTINGS_FILE && !directory) return 'personas';
    if (['chats', 'group chats', 'groups'].includes(root) || ATTACHMENT_DIRECTORIES.some(root => relative === root || relative.startsWith(root + '/')
        || directory && root.startsWith(relative + '/'))) return 'chats';
    return null;
}

/** Keep the three libraries and the files their chats need, not the source application's configuration. */
export function coreImportPath(relative, directory = false, parts = CORE_IMPORT_PARTS) {
    return parts.includes(importPart(relative, directory));
}

export function importExclusionReason(relative, parts = CORE_IMPORT_PARTS) {
    const part = importPart(relative, false);
    if (part && !parts.includes(part)) {
        const labels = { chats: 'Chats', personas: 'Personas', characters: 'Character cards' };
        return `${labels[part]} were not selected for this import.`;
    }
    const root = relative.split('/')[0];
    if (['entity-date-added.json', 'entity-last-chat.json'].includes(root)) return 'Account bookkeeping is not needed for chats, personas or character cards.';
    if (root === 'secrets.json') return 'API keys and passwords are not imported.';
    if (root === USER_DIRECTORY_TEMPLATE.extensions) return 'Extensions are not part of this import. Use Sync Extensions separately.';
    if (root === 'themes') return 'Themes are not part of this import. Your current appearance is kept.';
    return 'Not needed for chats, personas or character cards.';
}
