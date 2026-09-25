import { roleplayError, roleplayHash } from '../roleplay-store.js';

const fail = message => roleplayError('PATHFINDER_NOTEBOOK_INVALID', message, 409);
const LIMIT = 128 * 1024;

/** Edit only the saved chat's private notebook, never an assistant message or a swipe. */
export function preparePathfinderNotebookAction(records, { action, key = '', content = '', updatedAt = 0 }) {
    if (!Array.isArray(records) || !records.length || !records[0]?.chat_metadata
        || typeof records[0].chat_metadata !== 'object' || Array.isArray(records[0].chat_metadata)
        || !['read', 'write', 'delete'].includes(action)
        || typeof key !== 'string' || key.length > 1024 || typeof content !== 'string' || Buffer.byteLength(content) > 256 * 1024
        || action !== 'read' && !key.trim() || action === 'write' && !content.trim()
        || action !== 'read' && (!Number.isSafeInteger(updatedAt) || updatedAt < 0)) {
        throw fail('The notebook action or its accepted chat is invalid.');
    }
    const metadata = records[0].chat_metadata;
    const saved = metadata.pathfinder_notebook;
    if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved)
        || !Array.isArray(saved.entries) || saved.entries.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry)
            || typeof entry.key !== 'string' || typeof entry.content !== 'string'
            || !Number.isSafeInteger(entry.updated) || entry.updated < 0))) {
        throw fail('The saved notebook needs recovery.');
    }
    const entries = saved?.entries ?? [];
    let result;
    if (action === 'read') {
        result = entries.length ? `📓 Notebook (${entries.length} entries):\n\n${entries.map(entry => `**${entry.key}** (updated: ${new Date(entry.updated).toLocaleString()}):\n${entry.content}`).join('\n\n---\n\n')}`
            : '📓 Notebook is empty. Use "write" to add entries.';
        if (Buffer.byteLength(result) > LIMIT - 2048) throw roleplayError('PATHFINDER_TOOL_CAPACITY', 'The complete notebook result exceeds its reserved durable result capacity.', 409);
        return { records, result, changed: false, afterHash: roleplayHash(metadata) };
    }
    const name = key.trim();
    const index = entries.findIndex(entry => entry.key === name);
    if (action === 'delete' && index < 0) {
        return { records, result: `📓 No notebook entry "${name}" found.`, changed: false, afterHash: roleplayHash(metadata) };
    }
    const next = structuredClone(records);
    const notebook = next[0].chat_metadata.pathfinder_notebook ??= { entries: [], updated: updatedAt };
    if (action === 'write') {
        if (index < 0) notebook.entries.push({ key: name, content: content.trim(), updated: updatedAt });
        else Object.assign(notebook.entries[index], { content: content.trim(), updated: updatedAt });
        result = `📓 Wrote "${name}" to notebook.`;
    } else {
        notebook.entries.splice(index, 1);
        result = `📓 Deleted: ${name}`;
    }
    notebook.updated = updatedAt;
    if (Buffer.byteLength(JSON.stringify(next)) > 64 * 1024 * 1024) throw fail('The notebook exceeds the saved chat capacity.');
    return { records: next, result, changed: true, afterHash: roleplayHash(next[0].chat_metadata) };
}
