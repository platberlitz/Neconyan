import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { read as readCard } from './character-card-parser.js';
import { readRoleplayFile, roleplayAccountStamp, roleplayHash, roleplayLease, roleplayPathKey, withRoleplayAccount } from './roleplay-store.js';
import { listNotebookIdsLocked, prepareNotebook, loadNotebookLocked } from './notebooks/store.js';
import { createSearchMatcher, searchSnippet } from '../public/scripts/util/fuzzy-search.js';

const FILE_LIMIT = 64 * 1024 * 1024;
const PAGE_SIZE = 30;

function entries(directory) {
    // Validate every parent before enumerating, including directories with no matching files.
    readRoleplayFile(path.join(directory, '.search-path-check'), 1, { allowMissingParent: true });
    try { return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function read(filename) {
    return readRoleplayFile(filename, FILE_LIMIT, { allowMissingParent: true })?.bytes;
}

function json(filename) {
    const bytes = read(filename);
    return bytes ? JSON.parse(bytes) : {};
}

const strings = values => values.flat(Infinity).filter(value => typeof value === 'string').join(' ');

/** Search only server-resolved account directories. No model calls or persistent transcript index. */
export async function searchAccount(base, query, { offset = 0, signal } = {}) {
    const stamp = roleplayAccountStamp(base);
    const locked = callback => withRoleplayAccount(base, stamp, callback);
    const matcher = createSearchMatcher(query);
    const matches = [];
    const unavailable = new Set();
    let total = 0;
    const keep = offset + PAGE_SIZE;
    const add = (kind, id, title, text, target, location = '') => {
        const titleScore = matcher(title);
        const bodyScore = matcher(strings([title, location, text]));
        if (!titleScore && !bodyScore) return;
        total++;
        matches.push({ kind, id, title: String(title).slice(0, 160), detail: strings([location, searchSnippet(text, query)]),
            score: titleScore ? titleScore + 20 : bodyScore * 0.65, target });
        matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        if (matches.length > keep) matches.pop();
    };
    const step = async (category, callback) => {
        signal?.throwIfAborted();
        try { locked(callback); } catch (error) {
            // Account replacement must invalidate the whole response, not produce partial old results.
            if (error.code === 'ROLEPLAY_ACCOUNT_CHANGED') throw error;
            unavailable.add(category);
        }
        await yieldTurn();
    };
    const dirs = base.directories;
    const list = (directory, category) => {
        try { return locked(() => entries(directory)); } catch (error) {
            if (error.code === 'ROLEPLAY_ACCOUNT_CHANGED') throw error;
            unavailable.add(category);
            return [];
        }
    };
    const characterNames = new Map();
    for (const file of list(dirs.characters, 'Characters')) {
        if (!file.isFile() || !file.name.endsWith('.png')) continue;
        await step('Characters', () => {
            const card = JSON.parse(readCard(read(path.join(dirs.characters, file.name))));
            const data = card.data || card;
            const title = data.name || file.name.slice(0, -4);
            characterNames.set(file.name, title);
            add('character', `character:${file.name}`, title, strings([data.description, data.personality, data.scenario,
                data.first_mes, data.alternate_greetings, data.mes_example, data.creator_notes, data.tags, data.creator,
                data.system_prompt, data.post_history_instructions, data.extensions?.depth_prompt?.prompt,
                Object.values(data.character_book?.entries || {}).map(entry => [entry.name, entry.keys, entry.content])]), { avatar: file.name });
        });
    }
    let settings = {};
    await step('Personas and Conversation', () => { settings = json(path.join(dirs.root, 'settings.json')); });
    const personas = settings.power_user?.personas || {};
    for (const [avatar, name] of Object.entries(personas)) {
        const description = settings.power_user?.persona_descriptions?.[avatar] || {};
        add('persona', `persona:${avatar}`, name || avatar, strings([description.title, description.description]), { avatar, name });
    }
    for (const [key, thread] of Object.entries(settings.extension_settings?.neconyan_conversation?.characters || {})) {
        await step('Conversation', () => {
            const scoped = /^persona:([^:]+):(.+)$/.exec(key);
            const personaId = scoped ? decodeURIComponent(scoped[1]) : settings.user_avatar || '';
            const unscoped = scoped ? scoped[2] : key;
            const group = /^group:([^:]+):(.+)$/.exec(unscoped);
            const avatar = group ? group[2] : unscoped;
            for (const [branchId, branch] of Object.entries(thread.branches || {})) {
                const title = `${characterNames.get(avatar) || avatar} · ${branch.name || branchId}`;
                const target = { mode: 'conversation', target: { avatar, personaId, groupId: group?.[1] || '', branchId },
                    expectedBranch: { navigationId: branch.navigationId || null, lifetimeSeed: branch.lifetimeSeed || '', createdAt: String(branch.createdAt || '') } };
                const messages = branch.messages || [];
                add('chat', `conversation:${key}:${branchId}`, title, strings(messages.map(message => message.mes)), target, 'Conversation');
            }
        });
    }
    const groupOwners = new Map();
    for (const file of list(dirs.groups, 'Groups')) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        await step('Groups', () => {
            const group = json(path.join(dirs.groups, file.name));
            for (const chat of new Set([...(group.chats || []), group.chat_id].filter(Boolean))) {
                const filename = `${chat}.jsonl`;
                if (groupOwners.has(filename)) {
                    groupOwners.set(filename, null);
                    unavailable.add('Ambiguous group chats');
                } else groupOwners.set(filename, { id: String(group.id), name: group.name });
            }
        });
    }
    const scanChats = async (directory, avatar = null, isGroup = false) => {
        for (const file of list(directory, 'Chats')) {
            if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
            await step('Chats', lease => {
                const text = read(path.join(directory, file.name))?.toString('utf8') || '';
                const messages = [];
                let mode = 'roleplay';
                let sourceId;
                for (const line of text.split(/\r?\n/)) {
                    if (!line.trim()) continue;
                    try {
                        const row = JSON.parse(line);
                        if (typeof row.mes === 'string') messages.push(strings([row.mes, row.swipes]));
                        if (row.chat_metadata?.story_mode?.enabled) mode = 'story';
                        if (row.chat_metadata?.neconyan_roleplay?.instanceId) sourceId = row.chat_metadata.neconyan_roleplay.instanceId;
                    } catch { unavailable.add('Some chat messages'); }
                }
                const group = isGroup ? groupOwners.get(file.name) : null;
                const chat = file.name.slice(0, -6);
                const linked = isGroup ? Boolean(group) : characterNames.has(avatar);
                const locator = { group: isGroup, ...(isGroup ? {} : { avatar }), chat };
                if (linked) {
                    const { state } = roleplayLease(lease);
                    sourceId = state.paths[roleplayPathKey(state, 'chat', locator)]?.instanceId || sourceId;
                }
                const target = linked ? { mode, ...(sourceId ? { sourceId } : {}), locator, ...(group ? { groupId: group.id } : {}) }
                    : { orphan: true, archiveHash: roleplayHash(path.relative(dirs.root, path.join(directory, file.name))) };
                add('chat', `chat:${path.relative(dirs.root, directory)}:${file.name}`, chat, strings(messages), target,
                    group?.name || characterNames.get(avatar) || 'Chat Archive');
            });
        }
    };
    await scanChats(dirs.chats);
    for (const directory of list(dirs.chats, 'Chats')) {
        if (directory.isDirectory()) await scanChats(path.join(dirs.chats, directory.name), `${directory.name}.png`);
    }
    await scanChats(dirs.groupChats, null, true);
    for (const file of list(dirs.worlds, 'Lorebooks')) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        await step('Lorebooks', () => {
            const name = file.name.slice(0, -5);
            const book = json(path.join(dirs.worlds, file.name));
            add('lorebook', `lorebook:${name}`, name, '', { name });
            for (const [uid, entry] of Object.entries(book.entries || {})) {
                add('lore', `lore:${name}:${uid}`, entry.comment || strings(entry.key || []) || `Entry ${uid}`,
                    strings([entry.key, entry.keysecondary, entry.content]), { name, uid }, name);
            }
        });
    }
    for (const notebookId of locked(lease => listNotebookIdsLocked(lease))) {
        signal?.throwIfAborted();
        try { await prepareNotebook(base, notebookId, { stamp }); } catch (error) {
            if (error.code === 'ROLEPLAY_ACCOUNT_CHANGED') throw error;
            unavailable.add('Notebooks');
            continue;
        }
        await step('Notebooks', lease => {
            const notebook = loadNotebookLocked(lease, notebookId);
            if (notebook.skipped.length) unavailable.add('Some notebook files');
            add('notebook', `notebook:${notebookId}`, notebook.manifest.name, '', { notebookId });
            for (const note of notebook.entries) {
                add('note', `note:${notebookId}:${note.id}`, note.title, strings([note.aliases, note.tags, note.path, note.text]),
                    { notebookId, noteId: note.id }, notebook.manifest.name);
            }
        });
    }
    signal?.throwIfAborted();
    locked(() => {});
    return { results: matches.slice(offset), total, nextOffset: total > keep ? keep : null, unavailable: [...unavailable] };
}
