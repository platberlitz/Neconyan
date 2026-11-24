import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { normalisePromptRecord } from '../../public/scripts/scratchpad/last-prompt.js';
import { getConversationThreadKey } from '../endpoints/conversation-store.js';

// Keeps the latest prompt each Roleplay chat or Conversation branch sent to its model,
// so Scratchpad can share it on request. One small file per chat, oldest pruned first.
export const MAX_STORED_LAST_PROMPTS = 48;
export const MAX_LAST_PROMPT_FILE_BYTES = 3 * 1024 * 1024;

const KEY_PATTERN = /^(?:roleplay|conversation|character|group):[^\0\r\n]{1,600}$/;

function storeDirectory(directories) {
    const root = directories?.root;
    return typeof root === 'string' && root ? path.join(root, 'scratchpad', 'last-prompts') : '';
}

function keyFile(directory, key) {
    const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);
    return path.join(directory, `${digest}.json`);
}

function validKey(key) {
    return typeof key === 'string' && KEY_PATTERN.test(key);
}

/** The Scratchpad source key a server Conversation turn belongs to. */
export function conversationPromptKey(target) {
    if (!target?.avatar || !target?.branchId) return '';
    const thread = getConversationThreadKey(target.avatar, target.groupId || '', target.personaId || '');
    return thread ? `conversation:${thread}:${target.branchId}` : '';
}

/** The Scratchpad source keys a server Roleplay reply belongs to: the stable key first, then the legacy chat key. */
export function roleplayPromptKeys(source) {
    const locator = source?.locator;
    if (!locator?.chat) return [];
    const keys = [];
    if (locator.group) {
        if (source.instanceId && source.groupId) keys.push(`roleplay:${source.instanceId}:group:${source.groupId}`);
        if (source.groupId) keys.push(`group:${source.groupId}:${locator.chat}`);
    } else {
        if (source.instanceId) keys.push(`roleplay:${source.instanceId}`);
        if (locator.avatar) keys.push(`character:${locator.avatar}:${locator.chat}`);
    }
    return keys.filter(validKey);
}

function prune(directory) {
    let names;
    try {
        names = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
    } catch {
        return;
    }
    if (names.length <= MAX_STORED_LAST_PROMPTS) return;
    const files = names.map(name => {
        const file = path.join(directory, name);
        try {
            return { file, time: fs.statSync(file).mtimeMs };
        } catch {
            return null;
        }
    }).filter(Boolean).sort((a, b) => a.time - b.time);
    for (const { file } of files.slice(0, files.length - MAX_STORED_LAST_PROMPTS)) {
        fs.rmSync(file, { force: true });
    }
}

/**
 * Save the prompt that was just sent for one chat. Best effort: a failure here never stops the reply.
 * @param {{ root?: string }} directories Account directories.
 * @param {string[]} keys Scratchpad source keys for this chat.
 * @param {object} input Prompt record before cleaning.
 * @returns {boolean} Whether the prompt was saved.
 */
export function recordLastPrompt(directories, keys, input) {
    try {
        const directory = storeDirectory(directories);
        const wanted = [...new Set((keys || []).filter(validKey))];
        if (!directory || !wanted.length) return false;
        const record = normalisePromptRecord({ ...input, origin: 'server', recordedAt: input?.recordedAt || Date.now() });
        if (!record) return false;
        let body = JSON.stringify({ keys: wanted, record });
        if (Buffer.byteLength(body) > MAX_LAST_PROMPT_FILE_BYTES) return false;
        fs.mkdirSync(directory, { recursive: true });
        for (const key of wanted) {
            const file = keyFile(directory, key);
            const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
            fs.writeFileSync(temporary, body);
            fs.renameSync(temporary, file);
        }
        body = '';
        prune(directory);
        return true;
    } catch (error) {
        console.warn('Scratchpad could not keep the last prompt sent:', error?.message || error);
        return false;
    }
}

const BACKEND_APIS = Object.freeze({ chat: 'openai', text: 'textgenerationwebui', kobold: 'kobold', horde: 'koboldhorde', novel: 'novel' });

/**
 * Build an `onPromptReady` listener for server generation that keeps the prompt for Scratchpad.
 * @param {{ root?: string }} directories Account directories.
 * @param {string[]} keys Scratchpad source keys for this chat.
 * @param {{ mode: 'roleplay'|'conversation', speaker?: string, generationType?: string, contextLimit?: number }} details
 * @returns {Function|undefined}
 */
export function lastPromptRecorder(directories, keys, details = {}) {
    if (!storeDirectory(directories) || !(keys || []).some(validKey)) return undefined;
    return ({ prompt, backend, source, model, preset, contextLimit }) => {
        recordLastPrompt(directories, keys, {
            prompt,
            mode: details.mode,
            api: BACKEND_APIS[backend] || '',
            backend: source || backend,
            model,
            preset,
            speaker: details.speaker,
            generationType: details.generationType,
            contextLimit: contextLimit || details.contextLimit,
            recordedAt: Date.now(),
        });
    };
}

/**
 * Read the newest prompt saved for any of a chat's keys.
 * @param {{ root?: string }} directories Account directories.
 * @param {string[]} keys Scratchpad source keys for the open chat.
 * @returns {object|null}
 */
export function readLastPrompt(directories, keys) {
    const directory = storeDirectory(directories);
    if (!directory) return null;
    let newest = null;
    for (const key of new Set((keys || []).filter(validKey))) {
        try {
            const file = keyFile(directory, key);
            if (fs.statSync(file).size > MAX_LAST_PROMPT_FILE_BYTES) continue;
            const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!Array.isArray(stored?.keys) || !stored.keys.includes(key)) continue;
            const record = normalisePromptRecord(stored.record);
            if (record && (!newest || record.recordedAt > newest.recordedAt)) newest = { ...record, origin: 'server' };
        } catch (error) {
            if (error?.code !== 'ENOENT') console.warn('Scratchpad could not read a saved prompt:', error?.message || error);
        }
    }
    return newest;
}
