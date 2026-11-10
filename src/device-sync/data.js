import fs from 'node:fs';
import path from 'node:path';
import { imageSize } from 'image-size';
import { entry, fail, hash, json, LIMITS, plain, validateSnapshot } from './protocol.js';
import { importChatRecords, captureImportTarget, assertImportTarget } from '../operations/import-publication.js';
import { roleplayEntityContent } from '../generation/roleplay-source.js';
import { isNativeLorebook } from '../../public/scripts/neconyan-lorebook-tools-core.js';
import { readRoleplayFile, roleplayLease } from '../roleplay-store.js';
import { authoringEvidence, readAuthoringFileLocked, stageAuthoringFileLocked, publishAuthoringFileLocked, deleteAuthoringFileLocked } from '../authoring-store.js';
import { getSettingsVersion, prepareSettingsSave } from '../settings-version.js';
import { commitRoleplayLifecycleLocked, commitSingleChatWriteLocked } from '../roleplay-lifecycle.js';
import { roleplayNativeHost } from '../endpoints/chats.js';
import { withChatFileLocks } from '../chat-file-lock.js';

const roots = { characters: ['characters', 'chats'], lorebooks: ['worlds'], presets: ['instruct', 'context', 'sysprompt', 'reasoning'], personas: ['User Avatars'], backgrounds: ['backgrounds'] };
const appearanceKeys = ['font_scale', 'chat_width', 'blur_strength'];
const personaKeys = ['description', 'position', 'depth', 'role'];
export const virtual = relative => relative.startsWith('portable/');
const rootOf = lease => roleplayLease(lease).scope.directories.root;
const settings = lease => {
    const file = readAuthoringFileLocked(lease, path.join(rootOf(lease), 'settings.json'));
    const value = file ? json(file.bytes) : {};
    if (!plain(value) || value.power_user !== undefined && !plain(value.power_user)) throw fail('The current settings need recovery.', 409);
    return { file, value };
};

function appearance(power = {}) {
    return Object.fromEntries(appearanceKeys.filter(key => typeof power[key] === 'number' && Number.isFinite(power[key])).map(key => [key, power[key]]));
}

function persona(power, avatar) {
    if (!Object.hasOwn(power.personas ?? {}, avatar) && !Object.hasOwn(power.persona_descriptions ?? {}, avatar)) return null;
    const description = power.persona_descriptions?.[avatar] ?? {};
    return { name: power.personas?.[avatar] ?? '', description: Object.fromEntries(personaKeys.filter(key => Object.hasOwn(description, key)).map(key => [key, description[key]])) };
}

/** Required content is never added from an unchecked category. */
export function dependencyPaths(item, entries) {
    if (item.path.startsWith('portable/personas/')) return ['User Avatars/' + item.path.slice(18, -5)];
    if (!item.path.startsWith('chats/')) return [];
    const owner = item.path.split('/')[1];
    const card = entries.find(value => value.path.startsWith('characters/') && value.path.slice(11).replace('.png', '') === owner);
    if (!card) throw fail('A chat is missing its character card.');
    const avatars = new Set();
    const add = avatar => {
        if (typeof avatar !== 'string') throw fail('A chat has an invalid persona reference.');
        entry('User Avatars/' + avatar, Buffer.alloc(0));
        avatars.add(avatar);
    };
    const records = importChatRecords(Buffer.from(item.data, 'base64'));
    if (records[0].chat_metadata.persona) add(records[0].chat_metadata.persona);
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, field] of Object.entries(value)) {
            if (key === 'force_avatar' && typeof field === 'string') {
                let url;
                try { url = new URL(field, 'http://neconyan.invalid'); } catch { continue; }
                if (url.pathname === '/thumbnail' && url.searchParams.get('type') === 'persona') add(url.searchParams.get('file'));
                else {
                    let pathname;
                    try { pathname = decodeURIComponent(url.pathname); } catch { throw fail('A chat has an invalid persona reference.'); }
                    if (pathname.startsWith('/User Avatars/')) add(pathname.slice(14));
                }
            } else if (field && typeof field === 'object') visit(field);
        }
    };
    visit(records);
    return [card.path, ...[...avatars].flatMap(avatar => ['User Avatars/' + avatar, 'portable/personas/' + avatar + '.json'])];
}

export function dependencyEntries(item, entries) {
    return dependencyPaths(item, entries).map(relative => {
        const dependency = entries.find(value => value.path === relative);
        if (!dependency) throw fail('A chat requires its persona and avatar. Select Personas and avatars on the sending installation before sharing.');
        return dependency;
    });
}

export function currentDependencies(lease, item, entries) {
    return item ? dependencyPaths(item, entries).map(relative => currentEntry(lease, relative)).filter(Boolean) : [];
}

/** Only generated local integrity evidence is removed; user chat metadata is retained. */
function portableChat(bytes) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('A chat is not valid UTF-8.'); }
    const records = importChatRecords(bytes);
    delete records[0].chat_metadata.integrity;
    // File attachments and compatible copies require a different ownership protocol.
    // Refuse, rather than silently sending a chat whose local attachments disappear.
    if (/\/user\/(?:images|files)\//.test(JSON.stringify(records))) throw fail('Chats with local file or image attachments are not supported by device sync yet. Nothing was shared.');
    return Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

export function currentEntry(lease, relative) {
    if (virtual(relative)) {
        const power = settings(lease).value.power_user ?? {};
        let value = relative === 'portable/appearance.json' ? appearance(power) : persona(power, relative.slice(18, -5));
        if (relative === 'portable/appearance.json' && !Object.keys(value).length) value = null;
        return value === null ? null : entry(relative, Buffer.from(JSON.stringify(value)));
    }
    const file = readRoleplayFile(path.join(rootOf(lease), relative), LIMITS.file, { allowMissingParent: true });
    return file ? entry(relative, relative.startsWith('chats/') ? portableChat(file.bytes) : file.bytes) : null;
}

export function snapshotLocked(lease, deviceId, sequence, selected) {
    const entries = [];
    let total = 0;
    const add = value => {
        if (!value) return;
        total += value.size;
        if (entries.length >= LIMITS.entries || total > LIMITS.bytes) throw fail('The selection exceeds 1000 files or 32 MiB. Choose fewer categories; no partial snapshot was shared.', 413);
        entries.push(value);
    };
    const walk = (relative, depth) => {
        const filename = path.join(rootOf(lease), relative);
        // Validate all ancestors before enumerating a directory.
        readRoleplayFile(path.join(filename, '.sync-path-check'), 1, { allowMissingParent: true });
        if (!fs.existsSync(filename)) return;
        for (const dirent of fs.readdirSync(filename, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (dirent.isSymbolicLink()) throw fail('Linked files or folders cannot be synced.');
            if (dirent.name.startsWith('.')) continue;
            const child = relative + '/' + dirent.name;
            if (dirent.isDirectory()) { if (depth > 0) walk(child, depth - 1); continue; }
            if (!dirent.isFile()) throw fail('Only ordinary files can be synced.');
            const allowed = relative === 'characters' ? /\.png$/ : relative.startsWith('chats/') ? /\.jsonl$/
                : ['User Avatars', 'backgrounds'].includes(relative) ? /\.(png|jpg|jpeg|webp|gif)$/ : /\.json$/;
            if (allowed.test(dirent.name)) add(currentEntry(lease, child));
        }
    };
    for (const category of selected) for (const root of roots[category] ?? []) walk(root, root === 'chats' ? 1 : 0);
    if (selected.includes('personas')) {
        const power = settings(lease).value.power_user ?? {};
        for (const avatar of new Set([...Object.keys(power.personas ?? {}), ...Object.keys(power.persona_descriptions ?? {})])) {
            if (!entries.some(item => item.path === 'User Avatars/' + avatar)) throw fail('A persona avatar is missing or unsupported. Repair it before sharing personas.');
            add(currentEntry(lease, 'portable/personas/' + avatar + '.json'));
        }
    }
    if (selected.includes('appearance')) add(currentEntry(lease, 'portable/appearance.json'));
    return validateData(validateSnapshot({ format: 'neconyan-device-sync', version: 1, deviceId, sequence, categories: selected, entries }));
}

/** Validate every content format before recording any publication plan. */
export function validateData(snapshot) {
    validateSnapshot(snapshot);
    for (const item of snapshot.entries) {
        const bytes = Buffer.from(item.data, 'base64');
        if (item.path.startsWith('characters/')) roleplayEntityContent('character', item.path.slice(11), bytes, { storage: true });
        else if (item.path.startsWith('chats/')) {
            if (!portableChat(bytes).equals(bytes)) throw fail('A chat contains non-portable integrity evidence or has not been canonicalised.');
        } else if (item.category === 'backgrounds' || item.path.startsWith('User Avatars/')) {
            try {
                const image = imageSize(bytes);
                const extension = path.extname(item.path).slice(1).replace('jpeg', 'jpg');
                if (image.type !== extension || !image.width || !image.height || image.width * image.height > 64 * 1024 * 1024) throw new Error();
            } catch { throw fail('A sync image is damaged or exceeds 64 million pixels.'); }
        } else {
            const value = json(bytes);
            if (!plain(value)) throw fail('A sync JSON file is not an object.');
            if (item.category === 'lorebooks' && !isNativeLorebook(value)) throw fail('A sync lorebook is not valid.');
            if (item.path === 'portable/appearance.json' && (Object.keys(value).some(key => !appearanceKeys.includes(key))
                || Object.values(value).some(number => typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 10000))) throw fail('Unsupported portable appearance setting.');
            if (item.path.startsWith('portable/personas/') && (Object.keys(value).sort().join(',') !== 'description,name' || typeof value.name !== 'string'
                || !plain(value.description) || Object.keys(value.description).some(key => !['description', 'position', 'depth', 'role'].includes(key))
                || Object.entries(value.description).some(([key, field]) => key === 'description' ? typeof field !== 'string' : !Number.isFinite(field)))) throw fail('Invalid portable persona.');
            if (virtual(item.path)) {
                const avatar = item.path.slice(18, -5);
                const canonical = item.path === 'portable/appearance.json' ? appearance(value)
                    : persona({ personas: { [avatar]: value.name }, persona_descriptions: { [avatar]: value.description } }, avatar);
                if (!Object.keys(canonical).length || !Buffer.from(JSON.stringify(canonical)).equals(bytes)) throw fail('Portable settings must use the canonical sync format.');
            }
        }
        dependencyEntries(item, snapshot.entries);
    }
    return snapshot;
}

export function captureTarget(lease, relative) {
    return captureImportTarget(lease, virtual(relative) ? 'settings.json' : relative);
}

export function discardEntryStage(lease, effect) {
    if (effect?.staged?.temporary) {
        const filename = path.join(rootOf(lease), effect.staged.temporary);
        // Atomic publication consumes this path. Absence is a settled cleanup,
        // but any existing replacement still needs the original evidence.
        if (readAuthoringFileLocked(lease, filename)) deleteAuthoringFileLocked(lease, filename, effect.staged.after);
    }
}

/** Called with the account lease, then the same per-file lock used by ordinary saves. */
export function publishEntry(lease, item, effect, operationKey, save) {
    const filename = path.join(rootOf(lease), virtual(item.path) ? 'settings.json' : item.path);
    const publish = () => {
        const current = currentEntry(lease, item.path);
        if (virtual(item.path)) {
            if (current?.hash === item.hash) {
                discardEntryStage(lease, effect);
                return;
            }
            const latest = settings(lease).file;
            if (effect.staged && JSON.stringify(authoringEvidence(latest)) !== JSON.stringify(effect.staged.before)) {
                // Only the portable projection was selected. Rebase it onto the
                // latest whole document, never publish stale unrelated values.
                discardEntryStage(lease, effect);
                delete effect.staged;
                delete effect.target;
                save();
            }
            if (effect.target && !effect.staged) effect.target = captureTarget(lease, item.path);
        }
        // Native lifecycle receipts must settle even after publication. Ordinary
        // atomic authoring writes have no native receipt; matching content is
        // already applied and its consumed staging path is harmless.
        if (current?.hash === item.hash && !effect.target?.resource) {
            discardEntryStage(lease, effect);
            return;
        }
        const bytes = Buffer.from(item.data, 'base64');
        if (!effect.target) { effect.target = captureTarget(lease, item.path); save(); }
        const resource = effect.target.resource;
        if (resource?.kind === 'chat') {
            commitSingleChatWriteLocked(lease, { operationKey, mode: effect.target.source ? 'update' : 'create', sourceKind: 'storage',
                ...(effect.target.source ? { source: effect.target.source } : { destination: resource.locator, expectedVacancy: effect.target.vacancy }),
                records: importChatRecords(bytes), force: true, allowShrink: true, backup: { deferBackup: true } }, roleplayNativeHost);
        } else if (resource) {
            commitRoleplayLifecycleLocked(lease, { operationKey, action: 'device-sync', intent: { path: item.path, hash: item.hash, target: effect.target },
                steps: [{ op: effect.target.evidence ? 'update' : 'create', ...resource, bytes }] });
        } else {
            if (!effect.staged) {
                assertImportTarget(lease, effect.target);
                let output = bytes;
                if (virtual(item.path)) {
                    const { value: latest, file } = settings(lease);
                    const power = { ...(latest.power_user ?? {}) }, incoming = json(bytes);
                    if (item.path === 'portable/appearance.json') {
                        for (const key of appearanceKeys) delete power[key];
                        Object.assign(power, incoming);
                    } else {
                        const avatar = item.path.slice(18, -5);
                        power.personas = { ...(power.personas ?? {}), [avatar]: incoming.name };
                        const descriptor = { ...(power.persona_descriptions?.[avatar] ?? {}) };
                        for (const key of personaKeys) delete descriptor[key];
                        Object.assign(descriptor, incoming.description);
                        power.persona_descriptions = { ...(power.persona_descriptions ?? {}), [avatar]: descriptor };
                    }
                    const prepared = prepareSettingsSave({ ...latest, _version: getSettingsVersion(latest), _conversationOmitted: true, power_user: power }, latest);
                    if (!prepared.ok) throw fail('Portable settings conflict with current saved work.', 409);
                    output = Buffer.from(JSON.stringify(prepared.settings, null, 4));
                    effect.target.evidence = authoringEvidence(file);
                }
                effect.staged = stageAuthoringFileLocked(lease, filename, output, { expected: effect.target.evidence, limit: virtual(item.path) ? 32 * 1024 * 1024 : LIMITS.file, mode: 0o600 });
                save();
            }
            publishAuthoringFileLocked(lease, effect.staged, { checkpoint: save });
        }
        const after = currentEntry(lease, item.path);
        if (after?.hash !== item.hash) throw fail('The imported file changed during publication. Retry to recover safely.', 409);
    };
    // Protected native writers already take their complete, sorted lock set.
    // Taking the same non-reentrant lock here would deadlock their publication.
    if (item.path.startsWith('characters/') || item.path.startsWith('chats/')) return publish();
    return withChatFileLocks([filename], publish);
}

export const snapshotHash = snapshot => hash(Buffer.from(JSON.stringify(snapshot)));
