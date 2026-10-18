import fs from 'node:fs';
import path from 'node:path';

const GLOBALVAR_PATTERN = /globalvar\w*/gi;
const GLOBAL_SHORTHAND_PATTERN = /\{\{\s*\$([a-zA-Z](?:[\w-]*\w)?)/g;
const ARGUMENT_STOP_PATTERN = /\}\}|\||\r|\n/;
const MAX_ARGUMENT_LENGTH = 400;
const CHAT_HEADER_LIMIT = 4 * 1024 * 1024;

const JSON_SOURCES = Object.freeze([
    ['openAI_Settings', 'Preset'],
    ['textGen_Settings', 'Preset'],
    ['novelAI_Settings', 'Preset'],
    ['koboldAI_Settings', 'Preset'],
    ['instruct', 'Preset'],
    ['context', 'Preset'],
    ['sysprompt', 'Preset'],
    ['reasoning', 'Preset'],
    ['worlds', 'Lorebook'],
    ['quickreplies', 'Quick Reply set'],
    ['inChatAgents', 'Agent'],
    ['inChatAgentGroups', 'Agent group'],
    ['groups', 'Group'],
]);

/**
 * Adds every name that a piece of text could refer to as a global variable.
 * The match is deliberately generous: anything that follows a globalvar macro
 * or command counts, so a name is only reported unused when nothing could
 * plausibly read or write it.
 * @param {string} text
 * @param {Set<string>} names
 */
export function collectGlobalVariableReferences(text, names) {
    if (typeof text !== 'string' || !text) {
        return;
    }

    if (/globalvar/i.test(text)) {
        for (const match of text.matchAll(GLOBALVAR_PATTERN)) {
            const start = match.index + match[0].length;
            let argument = text.slice(start, start + MAX_ARGUMENT_LENGTH);
            const stop = argument.search(ARGUMENT_STOP_PATTERN);
            if (stop >= 0) {
                argument = argument.slice(0, stop);
            }
            for (const segment of argument.split('::')) {
                const trimmed = segment.trim();
                if (trimmed) {
                    names.add(trimmed);
                }
                for (const quoted of trimmed.matchAll(/["']([^"']+)["']/g)) {
                    names.add(quoted[1].trim());
                }
                for (const token of trimmed.split(/[\s=]+/)) {
                    const cleaned = token.replace(/^["']|["']$/g, '').trim();
                    if (cleaned) {
                        names.add(cleaned);
                    }
                }
            }
        }
    }

    if (text.includes('$')) {
        for (const match of text.matchAll(GLOBAL_SHORTHAND_PATTERN)) {
            names.add(match[1]);
        }
    }
}

/**
 * Calls visit for every string inside a parsed JSON value, keys included.
 * @param {unknown} value
 * @param {(text: string) => void} visit
 */
export function visitStrings(value, visit) {
    const stack = [value];
    while (stack.length) {
        const current = stack.pop();
        if (typeof current === 'string') {
            visit(current);
        } else if (Array.isArray(current)) {
            stack.push(...current);
        } else if (current && typeof current === 'object') {
            for (const [key, child] of Object.entries(current)) {
                visit(key);
                stack.push(child);
            }
        }
    }
}

function listFiles(directory, extension) {
    if (!directory || !fs.existsSync(directory)) {
        return [];
    }
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
        .map(entry => path.join(directory, entry.name));
}

function listChatFiles(directories) {
    const files = [];
    const chatsRoot = directories.chats;
    if (chatsRoot && fs.existsSync(chatsRoot)) {
        for (const entry of fs.readdirSync(chatsRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                files.push(...listFiles(path.join(chatsRoot, entry.name), '.jsonl'));
            }
        }
    }
    files.push(...listFiles(directories.groupChats, '.jsonl'));
    return files;
}

async function readFirstLine(file) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const chunks = [];
        let total = 0;
        const buffer = Buffer.alloc(64 * 1024);
        while (total < CHAT_HEADER_LIMIT) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
            if (!bytesRead) {
                break;
            }
            const slice = buffer.subarray(0, bytesRead);
            const newline = slice.indexOf(10);
            if (newline >= 0) {
                chunks.push(Buffer.from(slice.subarray(0, newline)));
                break;
            }
            chunks.push(Buffer.from(slice));
            total += bytesRead;
        }
        return Buffer.concat(chunks).toString('utf8');
    } finally {
        await handle.close();
    }
}

/**
 * Reads the card text out of a character PNG without loading the image data:
 * only chunk headers and tEXt chunks are read, everything else is skipped.
 * Returns ccv3 when present, else chara, like the card parser.
 * @param {string} file
 * @returns {Promise<string|null>}
 */
export async function readCardText(file) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const { size } = await handle.stat();
        const header = Buffer.alloc(8);
        let position = 8;
        const texts = {};
        while (position + 8 <= size) {
            await handle.read(header, 0, 8, position);
            const length = header.readUInt32BE(0);
            const type = header.toString('latin1', 4, 8);
            if (type === 'IEND') {
                break;
            }
            if (type === 'tEXt' && length > 0 && position + 8 + length <= size) {
                const data = Buffer.alloc(length);
                await handle.read(data, 0, length, position + 8);
                const separator = data.indexOf(0);
                if (separator > 0) {
                    const keyword = data.toString('latin1', 0, separator).toLowerCase();
                    if (keyword === 'ccv3' || keyword === 'chara') {
                        texts[keyword] = data.toString('latin1', separator + 1);
                    }
                }
            }
            position += 12 + length;
        }
        const encoded = texts.ccv3 ?? texts.chara;
        return encoded === undefined ? null : Buffer.from(encoded, 'base64').toString('utf8');
    } finally {
        await handle.close();
    }
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Finds which of the given global variable names nothing on disk refers to.
 * Checks presets, lorebooks, Quick Replies, Agents, groups, characters, the
 * metadata line of every chat (where Author's Notes live) and settings.json
 * itself, minus the stored global values.
 * @param {object} options
 * @param {Record<string, string>} options.directories User directories
 * @param {string[]} options.names Global variable names to check
 * @returns {Promise<{ unused: string[], used: string[], checked: Record<string, number>, unreadable: number }>}
 */
export async function findUnusedGlobalVariables({ directories, names }) {
    const wanted = [...new Set(names.filter(name => typeof name === 'string' && name.trim()))];
    const references = new Set();
    const collect = text => collectGlobalVariableReferences(text, references);
    const checked = {};
    let unreadable = 0;
    const count = label => {
        checked[label] = (checked[label] ?? 0) + 1;
    };

    for (const [key, label] of JSON_SOURCES) {
        for (const file of listFiles(directories[key], '.json')) {
            const parsed = parseJson(await fs.promises.readFile(file, 'utf8'));
            if (parsed === null) {
                unreadable++;
                continue;
            }
            visitStrings(parsed, collect);
            count(label);
        }
    }

    for (const file of listFiles(directories.characters, '.png')) {
        try {
            const text = await readCardText(file);
            if (text === null) {
                continue;
            }
            const card = parseJson(text);
            if (card === null) {
                unreadable++;
                continue;
            }
            visitStrings(card, collect);
            count('Character');
        } catch {
            unreadable++;
        }
    }

    for (const file of listChatFiles(directories)) {
        try {
            const header = parseJson(await readFirstLine(file));
            if (header !== null) {
                visitStrings(header, collect);
                count('Chat');
            }
        } catch {
            unreadable++;
        }
    }

    const settingsFile = path.join(directories.root ?? '', 'settings.json');
    if (fs.existsSync(settingsFile)) {
        const settings = parseJson(await fs.promises.readFile(settingsFile, 'utf8'));
        if (settings === null) {
            unreadable++;
        } else {
            if (settings.extension_settings?.variables) {
                delete settings.extension_settings.variables.global;
            }
            visitStrings(settings, collect);
            count('Settings');
        }
    }

    const used = wanted.filter(name => references.has(name) || references.has(name.trim()));
    const unused = wanted.filter(name => !used.includes(name));
    return { unused, used, checked, unreadable };
}
