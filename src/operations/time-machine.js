import fs from 'node:fs';
import path from 'node:path';
import { authoringEvidence, publishAuthoringFileLocked, readAuthoringFileLocked, stageAuthoringFileLocked } from '../authoring-store.js';
import { read as readCard } from '../character-card-parser.js';
import { getPresetSettingsByAPI } from '../endpoints/presets.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { readRoleplayFile, roleplayHash, roleplayLease } from '../roleplay-store.js';
import { getSettingsVersion, prepareSettingsSave } from '../settings-version.js';
import { publishFileDeletions } from './file-deletion.js';
import { registerOperation } from './jobs.js';
import { operationError, withOperation } from './store.js';
import {
    DEFAULT_KEEP_PER_TARGET, DEFAULT_MAX_TOTAL_BYTES, hashOf, isPlainObject, normalizeRow, prunePlan, snapshotFileName, validateSnapshotPayload,
} from '../../public/scripts/extensions/third-party/Neconyan-Time-Machine/src/core.js';

export const TIME_MACHINE_MODULE = 'NeconyanCardTimeMachine';
const ATTACHMENT_KEY = '__Neconyan-Card-Time-Machine__';
const KINDS = ['character', 'lorebook', 'preset'];
const SETTINGS_LIMIT = 16 * 1024 * 1024;
const SOURCE_LIMIT = 64 * 1024 * 1024;
const TOTAL_LIMIT = 256 * 1024 * 1024;
const SNAPSHOT_LIMIT = 16 * 1024 * 1024;
const PAIRED_PRESETS = ['openai', 'textgenerationwebui', 'kobold', 'novel'];
const NAMED_PRESETS = ['instruct', 'context', 'sysprompt', 'reasoning'];

function settingsPath(lease) {
    return path.join(roleplayLease(lease).scope.directories.root, 'settings.json');
}

function parseSettings(file) {
    if (!file) throw operationError('Save the account settings before taking snapshots.');
    try {
        const settings = JSON.parse(file.bytes.toString('utf8'));
        if (isPlainObject(settings)) return settings;
    } catch { /* reported below */ }
    throw operationError('The saved account settings are unreadable.');
}

function validRow(value) {
    return normalizeRow(value) !== null;
}

/** Reads the module index the same way the page does, keeping unrecognised rows out of retention. */
function moduleIndex(settings) {
    const module = isPlainObject(settings.extension_settings?.[TIME_MACHINE_MODULE]) ? settings.extension_settings[TIME_MACHINE_MODULE] : {};
    const rows = Array.isArray(module.snapshots) ? module.snapshots.filter(validRow) : [];
    return {
        module,
        rows,
        keepPerTarget: Number.isFinite(module.keepPerTarget) ? Math.max(1, Math.floor(module.keepPerTarget)) : DEFAULT_KEEP_PER_TARGET,
        maxTotalBytes: Number.isFinite(module.maxTotalBytes) && module.maxTotalBytes > 0 ? Math.floor(module.maxTotalBytes) : DEFAULT_MAX_TOTAL_BYTES,
    };
}

function jsonFiles(folder) {
    if (!folder || !fs.existsSync(folder)) return [];
    return fs.readdirSync(folder, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map(entry => entry.name).sort();
}

function readJson(filename) {
    const file = readRoleplayFile(filename, SOURCE_LIMIT);
    if (!file) return null;
    try {
        const value = JSON.parse(file.bytes.toString('utf8'));
        return isPlainObject(value) ? { value, size: file.bytes.length } : null;
    } catch {
        return null;
    }
}

/** Reads every character, lorebook and preset from disk, not from any page's memory. */
function readSources(lease, kinds, settings) {
    const dirs = roleplayLease(lease).scope.directories;
    const sources = [];
    let failed = 0;
    let total = 0;
    const add = (source, size) => {
        total += size;
        if (total > TOTAL_LIMIT) throw operationError('There is too much to snapshot in one go.', 413);
        sources.push(source);
    };
    if (kinds.includes('character')) {
        const names = fs.existsSync(dirs.characters) ? fs.readdirSync(dirs.characters, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.png')).map(entry => entry.name).sort() : [];
        for (const avatar of names) {
            const file = readRoleplayFile(path.join(dirs.characters, avatar), SOURCE_LIMIT);
            if (!file) { failed++; continue; }
            let card;
            try { card = JSON.parse(readCard(file.bytes)); } catch { failed++; continue; }
            if (!isPlainObject(card)) { failed++; continue; }
            delete card.chat; delete card.json_data; delete card.avatar;
            const tags = settings.tag_map?.[avatar] ?? [];
            if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) throw operationError(`The saved tags for ${avatar} are malformed.`);
            add({ kind: 'character', target: avatar, label: card.data?.name || card.name || avatar, content: { data: card, tags: [...tags] } }, file.bytes.length);
        }
    }
    if (kinds.includes('lorebook')) {
        for (const filename of jsonFiles(dirs.worlds)) {
            const book = readJson(path.join(dirs.worlds, filename));
            if (!book) { failed++; continue; }
            const name = filename.slice(0, -5);
            add({ kind: 'lorebook', target: name, label: name, content: { data: book.value } }, book.size);
        }
    }
    if (kinds.includes('preset')) {
        for (const apiId of [...PAIRED_PRESETS, ...NAMED_PRESETS]) {
            const { folder } = getPresetSettingsByAPI(apiId, dirs);
            for (const filename of jsonFiles(folder)) {
                const preset = readJson(path.join(folder, filename));
                if (!preset) { failed++; continue; }
                const name = NAMED_PRESETS.includes(apiId) && typeof preset.value.name === 'string' ? preset.value.name : filename.slice(0, -5);
                add({ kind: 'preset', target: `${apiId}/${name}`, label: `${name} (${apiId})`, content: { data: preset.value } }, preset.size);
            }
        }
    }
    return { sources, failed };
}

async function readableSnapshot(context, row) {
    try {
        const file = withOperation(context, ({ lease }) => readAuthoringFileLocked(lease,
            path.join(roleplayLease(lease).scope.directories.files, row.name), SNAPSHOT_LIMIT));
        if (!file) return false;
        await validateSnapshotPayload(row, JSON.parse(file.bytes.toString('utf8')));
        return true;
    } catch {
        return false;
    }
}

export function captureTimeMachine(base, account, input = {}) {
    const kinds = input.kinds === undefined ? KINDS : input.kinds;
    if (!Array.isArray(kinds) || !kinds.length || new Set(kinds).size !== kinds.length || !kinds.every(kind => KINDS.includes(kind))) {
        throw operationError('Choose what to snapshot.', 400);
    }
    return { account, kinds: [...kinds], takenAt: Date.now() };
}

/** Decides the complete set of new snapshots once, so an interrupted run never picks different names or contents. */
async function planSnapshots(context, plan) {
    const saved = readArtifact(context.directories, context.job.id, 'time-machine-plan');
    if (saved) return saved;
    const { settings, sources, failed } = withOperation(context, ({ lease }) => {
        const settings = parseSettings(readAuthoringFileLocked(lease, settingsPath(lease), SETTINGS_LIMIT));
        return { settings, ...readSources(lease, plan.kinds, settings) };
    });
    const { rows } = moduleIndex(settings);
    const newest = new Map();
    for (const row of rows) {
        const key = `${row.kind}:${row.target}`;
        if (!newest.has(key) || newest.get(key).ts < row.ts) newest.set(key, row);
    }
    const taken = new Set(rows.map(row => row.name));
    let ts = rows.reduce((latest, row) => Math.max(latest, row.ts + 1), plan.takenAt);
    const snapshots = [];
    let skipped = 0;
    for (const [index, source] of sources.entries()) {
        const hash = await hashOf(source.content);
        const previous = newest.get(`${source.kind}:${source.target}`);
        if (hash && previous?.hash === hash && await readableSnapshot(context, previous)) {
            skipped++;
            continue;
        }
        const token = roleplayHash([context.job.id, index]).slice(0, 16);
        const name = snapshotFileName(source.kind, source.target, `${ts}_${token}`, taken);
        taken.add(name);
        const text = JSON.stringify({ format: 1, kind: source.kind, target: source.target, label: source.label, ts, ...source.content, hash });
        const size = Buffer.byteLength(text);
        if (size > SNAPSHOT_LIMIT) throw operationError(`${source.label} is too large to snapshot.`, 413);
        writeArtifact(context.directories, context.job.id, `time-machine-blob:${snapshots.length}`, text);
        snapshots.push({ id: name, ts, kind: source.kind, target: source.target, label: source.label, name, url: `/user/files/${name}`, hash, size });
        ts++;
    }
    const result = { snapshots, skipped, failed };
    writeArtifact(context.directories, context.job.id, 'time-machine-plan', result);
    return result;
}

function publishBlob(context, row, index, text) {
    return withOperation(context, ({ lease, value, save }) => {
        const key = `snapshot:${index}`;
        if (value.effects[key]?.state === 'done') return;
        const filename = path.join(roleplayLease(lease).scope.directories.files, row.name);
        let staged = value.effects[key]?.staged;
        if (!staged) {
            context.signal.throwIfAborted();
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            staged = stageAuthoringFileLocked(lease, filename, text, { expected: null, limit: SNAPSHOT_LIMIT });
            value.effects[key] = { state: 'prepared', staged };
            save();
        }
        publishAuthoringFileLocked(lease, staged);
        value.effects[key].state = 'done';
        save();
    });
}

/** Adds the new rows to the saved index, applies retention and records which old snapshot files may go. */
function publishIndex(context, planned, { afterTimeMachineIndex } = {}) {
    return withOperation(context, ({ lease, value, save }) => {
        if (value.effects.settings?.state === 'done') return value.timeMachineResult;
        const filename = settingsPath(lease);
        const current = readAuthoringFileLocked(lease, filename, SETTINGS_LIMIT);
        const evidence = roleplayHash(authoringEvidence(current));
        let staged = value.effects.settings?.staged;
        if (!staged || (evidence !== roleplayHash(staged.before) && evidence !== roleplayHash(staged.after))) {
            const settings = parseSettings(current);
            const { module, rows, keepPerTarget, maxTotalBytes } = moduleIndex(settings);
            const known = new Set(rows.map(row => row.name));
            const combined = [...(Array.isArray(module.snapshots) ? module.snapshots : []), ...planned.snapshots.filter(row => !known.has(row.name))];
            const valid = combined.filter(validRow);
            const doomed = new Set(prunePlan(valid.map(row => ({ ...row, id: row.name })), { keepPerTarget, maxTotalBytes,
                protectedIds: planned.snapshots.map(row => row.name) }));
            const snapshots = combined.filter(row => !(validRow(row) && doomed.has(row.name)));
            const extensionSettings = isPlainObject(settings.extension_settings) ? settings.extension_settings : {};
            const allAttachments = isPlainObject(extensionSettings.character_attachments) ? extensionSettings.character_attachments : {};
            const listed = Array.isArray(allAttachments[ATTACHMENT_KEY]) ? allAttachments[ATTACHMENT_KEY] : [];
            const attachments = [...listed.filter(entry => !doomed.has(entry?.name)),
                ...planned.snapshots.filter(row => !listed.some(entry => entry?.url === row.url))
                    .map(row => ({ url: row.url, size: row.size, name: row.name, created: row.ts }))];
            const nextModule = { ...module, snapshots, lastCommit: `server-${context.job.id}-${Date.now()}` };
            const next = { ...settings, extension_settings: { ...extensionSettings, [TIME_MACHINE_MODULE]: nextModule,
                character_attachments: { ...allAttachments, [ATTACHMENT_KEY]: attachments } }, _version: getSettingsVersion(settings) };
            const prepared = prepareSettingsSave(next, settings);
            if (!prepared.ok) throw operationError('The saved settings changed. Try again.');
            const dirs = roleplayLease(lease).scope.directories;
            const root = path.resolve(dirs.root);
            const deletions = [];
            for (const row of valid.filter(item => doomed.has(item.name))) {
                const file = readAuthoringFileLocked(lease, path.join(dirs.files, row.name), SNAPSHOT_LIMIT);
                if (file) deletions.push({ relative: path.relative(root, path.join(dirs.files, row.name)), evidence: authoringEvidence(file) });
            }
            context.signal.throwIfAborted();
            staged = stageAuthoringFileLocked(lease, filename, JSON.stringify(prepared.settings, null, 4),
                { expected: authoringEvidence(current), limit: SETTINGS_LIMIT });
            value.effects.settings = { state: 'prepared', staged };
            value.timeMachineDeletions = deletions;
            value.timeMachineResult = { taken: planned.snapshots.length, skipped: planned.skipped, failed: planned.failed ?? 0, removed: doomed.size,
                module: nextModule, attachments, previousVersion: getSettingsVersion(settings), version: prepared.version,
                settingsRevision: prepared.settingsRevision };
            save();
        }
        publishAuthoringFileLocked(lease, staged);
        afterTimeMachineIndex?.(staged);
        value.effects.settings.state = 'done';
        save();
        return value.timeMachineResult;
    });
}

export async function runTimeMachine(context, plan, dependencies = {}) {
    const planned = await planSnapshots(context, plan);
    for (const [index, row] of planned.snapshots.entries()) {
        await context.progress({ stage: 'Saving snapshots', completed: index, total: planned.snapshots.length });
        publishBlob(context, row, index, readArtifact(context.directories, context.job.id, `time-machine-blob:${index}`));
    }
    const result = publishIndex(context, planned, dependencies);
    const deletions = withOperation(context, ({ value }) => value.timeMachineDeletions ?? []);
    if (deletions.length) await publishFileDeletions(context, deletions, result, dependencies);
    return result;
}

registerOperation('time-machine-capture', {
    label: 'Snapshot everything',
    target: () => ({ kind: 'settings', id: 'time-machine' }),
    canRecover: value => Object.keys(value.effects).length > 0,
    capture: captureTimeMachine,
    run: runTimeMachine,
});
