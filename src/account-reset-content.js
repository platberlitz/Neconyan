import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tryWriteFileSync } from './util.js';

const LIMIT = 64 * 1024 * 1024;
const TOTAL = 512 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const validPath = value => typeof value === 'string' && value && value.length <= 1000 && !path.isAbsolute(value)
    && !value.includes('\\') && value.split('/').every(part => part && !['.', '..'].includes(part)) && value.split('/')[0] !== 'jobs';

function validate(value, error) {
    if (value?.version !== 1 || !Array.isArray(value.directories) || !Array.isArray(value.files)
        || value.directories.length + value.files.length > 100000 || value.directories.some(name => !validPath(name))) throw error('The reset content manifest is invalid.');
    const names = new Set();
    for (const file of value.files) {
        if (!validPath(file?.relative) || names.has(file.relative) || typeof file.data !== 'string'
            || Buffer.from(file.data, 'base64').toString('base64') !== file.data) throw error('The reset content manifest is invalid.');
        names.add(file.relative);
    }
    if (value.directories.some(name => names.has(name))) throw error('A reset file conflicts with a required directory.');
    for (const name of [...names, ...value.directories]) {
        const pieces = name.split('/');
        for (let index = 1; index < pieces.length; index++) if (names.has(pieces.slice(0, index).join('/'))) throw error('A reset file contains another path.');
    }
    return value;
}

export function saveResetContent(root, value, { readFile, createDirectory, error }) {
    validate(value, error);
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > LIMIT) throw error('The reset content exceeds its reserved size.');
    const id = hash(bytes);
    const directory = path.join(root, 'reset-content');
    readFile(path.join(directory, '.path-check'), 1, { allowMissingParent: true });
    let total = bytes.length;
    let existing = false;
    for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw error('The retained reset content needs recovery.');
        const file = readFile(path.join(directory, name), LIMIT, { flush: true });
        if (!file || hash(file.bytes) !== name.slice(0, -5)) throw error('The retained reset content needs recovery.');
        if (name === `${id}.json`) existing = true;
        else total += file.bytes.length;
    }
    if (existing) return id;
    if (total > TOTAL) throw error('Reset storage is full. Existing evidence was retained.');
    createDirectory(directory, root);
    const filename = path.join(directory, `${id}.json`);
    tryWriteFileSync(filename, bytes, { mode: 0o600 }, { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
    if (readFile(filename, LIMIT, { flush: true })?.rawHash !== id) throw error('The reset content write needs recovery.');
    return id;
}

export function loadResetContent(root, id, { readFile, error }) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw error('The reset content identity is invalid.');
    const file = readFile(path.join(root, 'reset-content', `${id}.json`), LIMIT, { flush: true });
    if (!file || file.rawHash !== id) throw error('The retained reset content is unavailable.');
    try { return validate(JSON.parse(file.bytes.toString('utf8')), error); } catch (cause) { throw error('The retained reset content is damaged.', cause); }
}

/** The account remains fenced in maintenance until all of these captured files are durable. */
export function installResetContent(userRoot, value, { createDirectory, readFile, error }) {
    for (const name of value.directories) createDirectory(path.join(userRoot, name), userRoot);
    for (const file of value.files) {
        const filename = path.join(userRoot, file.relative);
        createDirectory(path.dirname(filename), userRoot);
        const bytes = Buffer.from(file.data, 'base64');
        tryWriteFileSync(filename, bytes, { mode: 0o600 }, { expectedFileAbsent: true, durable: true, preserveOnCreateError: true });
        if (readFile(filename, LIMIT, { flush: true })?.rawHash !== hash(bytes)) throw error('A reset content file needs recovery.');
    }
}
