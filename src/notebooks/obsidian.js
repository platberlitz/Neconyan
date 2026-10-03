import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfigValue } from '../util.js';
import { roleplayAccountStamp, withRoleplayAccount } from '../roleplay-store.js';
import { authoringEvidence, readAuthoringFileLocked } from '../authoring-store.js';
import { notebookError, requireNotebookId, sha256 } from './paths.js';
import { accountRootOf, invalidateNotebookFiles, listNotebookIdsLocked, notebookContentRoot, notebookControlRoot, prepareNotebook, readJsonLocked, readManifestLocked, readPoliciesLocked, runOperationLocked, updateManifestLocked, writeJsonLocked, writePoliciesLocked } from './store.js';
import { listCanvasesLocked, readCanvasLocked } from './canvas-store.js';
import { prepareInWorker, yieldNotebookWork } from './preparation.js';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import { notifyNotebookChanged } from './events.js';
import { obsidianHistoryFileLocked, obsidianHistoryLocked, pruneObsidianHistoryLocked, readObsidianHistoryIndexLocked, recordObsidianFileLocked } from './obsidian-history.js';

export { obsidianHistoryLocked, obsidianHistoryFileLocked };
const runtimes = new Map();
const folderClaims = new Map();
const stoppedRuntimes = new Map();
const bindingFile = (lease, id) => path.join(notebookControlRoot(accountRootOf(lease), requireNotebookId(id)), 'obsidian-sync.json');
const runtimeKey = (base, id) => `${base.directories.root}\0${id}`;
const physicalKey = folder => `${folder.physical.dev}:${folder.physical.ino}`;

function settings() {
    return { enabled: getConfigValue('notebooks.obsidianHeadless.enabled', false, 'boolean') === true,
        executable: getConfigValue('notebooks.obsidianHeadless.executable', ''),
        roots: getConfigValue('notebooks.obsidianHeadless.allowedRoots', []),
        interval: Math.min(60000, Math.max(500, Number(getConfigValue('notebooks.obsidianHeadless.pollIntervalMs', 5000)) || 5000)) };
}

function directoryIdentity(directory) {
    const resolved = path.resolve(directory);
    let current = path.parse(resolved).root;
    for (const segment of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw notebookError('OBSIDIAN_FOLDER_UNSAFE', 'The sync folder and its parents must be real folders, not links.', 409);
    }
    const stat = fs.lstatSync(resolved);
    return { path: resolved, physical: { dev: stat.dev, ino: stat.ino } };
}

function approvedFolder(lease, notebookId, wanted) {
    readManifestLocked(lease, notebookId);
    const config = settings();
    if (!config.enabled) throw notebookError('OBSIDIAN_DISABLED', 'The server administrator has not enabled the optional Obsidian adapter.', 403);
    const expected = notebookContentRoot(accountRootOf(lease), notebookId);
    if (typeof wanted !== 'string' || !path.isAbsolute(wanted) || path.resolve(wanted) !== expected) {
        throw notebookError('OBSIDIAN_FOLDER_NOT_ALLOWED', 'Choose this notebook’s existing content folder. Another folder or a second copied notebook is not allowed.', 403);
    }
    let allowed = false;
    for (const configured of Array.isArray(config.roots) ? config.roots : []) {
        if (typeof configured !== 'string') continue;
        const expanded = configured.replaceAll('$ACCOUNT_ROOT', accountRootOf(lease));
        if (!path.isAbsolute(expanded)) continue;
        try {
            const root = directoryIdentity(expanded).path;
            if (expected === root || expected.startsWith(root + path.sep)) { allowed = true; break; }
        } catch { /* An unavailable administrator root grants no access. */ }
    }
    if (!allowed) throw notebookError('OBSIDIAN_FOLDER_NOT_ALLOWED', 'The notebook folder is outside the administrator’s approved sync roots.', 403);
    return directoryIdentity(expected);
}

function readBinding(lease, notebookId) {
    readManifestLocked(lease, notebookId);
    const binding = readJsonLocked(lease, bindingFile(lease, notebookId), null);
    if (binding && (binding.schema !== 1 || binding.mechanism !== 'obsidian-headless' || typeof binding.revision !== 'string')) {
        throw notebookError('OBSIDIAN_BINDING_DAMAGED', 'The private sync settings could not be read safely.', 409);
    }
    return binding;
}

function checkedBinding(lease, notebookId) {
    const binding = readBinding(lease, notebookId);
    if (!binding?.enabled) throw notebookError('OBSIDIAN_NOT_CONFIGURED', 'Choose and approve this notebook’s sync folder first.', 409);
    const folder = approvedFolder(lease, notebookId, binding.folder);
    if (physicalKey(folder) !== physicalKey(binding)) throw notebookError('OBSIDIAN_FOLDER_CHANGED', 'The approved folder was replaced. Sync has paused; approve the correct folder again.', 409);
    return { binding, folder };
}

export function obsidianStatusLocked(lease, notebookId) {
    const config = settings();
    const binding = readBinding(lease, notebookId);
    if (binding?.enabled && config.enabled) checkedBinding(lease, notebookId);
    const runtime = runtimes.get(`${accountRootOf(lease)}\0${notebookId}`);
    const stopped = binding?.enabled ? stoppedRuntimes.get(`${accountRootOf(lease)}\0${notebookId}`) : null;
    let candidate = null;
    try { candidate = approvedFolder(lease, notebookId, notebookContentRoot(accountRootOf(lease), notebookId)).path; } catch { /* Disabled or unapproved folders are not offered. */ }
    return { status: 'success', adapter: { available: config.enabled && !!candidate, candidateFolder: candidate,
        configured: binding?.enabled === true, revision: binding?.revision ?? null, folder: binding?.folder ?? null,
        mechanism: 'obsidian-headless', running: runtime?.running === true, busy: !!runtime?.starting,
        lastCheckedAt: runtime?.lastCheckedAt ?? stopped?.lastCheckedAt ?? null,
        message: runtime?.message ?? stopped?.message ?? (binding?.enabled ? 'Configured. The client is stopped.' : 'No client has been started.') } };
}

export function configureObsidianLocked(lease, { notebookId, operationId, expectedRevision, folder, singleMechanism, actor }) {
    return runOperationLocked(lease, { operationId, kind: 'obsidian-configure', args: { notebookId, expectedRevision, folder, singleMechanism } }, () => {
        const previous = readBinding(lease, notebookId);
        if ((previous?.revision ?? null) !== expectedRevision) throw notebookError('OBSIDIAN_CONFLICT', 'Sync settings changed. Refresh them before choosing a folder again.', 409);
        if (runtimes.has(`${accountRootOf(lease)}\0${notebookId}`)) throw notebookError('OBSIDIAN_FOLDER_BUSY', 'Stop the current client before changing its folder.', 409);
        if (singleMechanism !== true) throw notebookError('OBSIDIAN_SINGLE_MECHANISM', 'Confirm that only Obsidian Headless will sync this content folder.', 400);
        const chosen = approvedFolder(lease, notebookId, folder);
        for (const otherId of listNotebookIdsLocked(lease)) {
            if (otherId === notebookId) continue;
            const other = readBinding(lease, otherId);
            if (other?.enabled && physicalKey(other) === physicalKey(chosen)) throw notebookError('OBSIDIAN_FOLDER_BUSY', 'This folder already has a sync mechanism assigned.', 409);
        }
        const manifest = readManifestLocked(lease, notebookId);
        const policies = readPoliciesLocked(lease, notebookId);
        let narrowed = false;
        for (const [noteId, note] of Object.entries(manifest.notes)) {
            const policy = policies.notes[noteId];
            if (note.adopted !== true || ['none', 'read', 'edit'].includes(policy?.assistant)) continue;
            policies.notes[noteId] = { ...(policy ?? {}), assistant: 'none', context: policy?.context ?? { mode: 'off' } };
            narrowed = true;
        }
        if (narrowed) writePoliciesLocked(lease, notebookId, policies);
        updateManifestLocked(lease, notebookId, manifest => { manifest.externalImportsDeny = true; });
        const binding = { schema: 1, mechanism: 'obsidian-headless', enabled: true, folder: chosen.path, physical: chosen.physical,
            revision: sha256(`${operationId}:${Date.now()}`), actor, at: new Date().toISOString() };
        writeJsonLocked(lease, bindingFile(lease, notebookId), binding);
        stoppedRuntimes.delete(`${accountRootOf(lease)}\0${notebookId}`);
        return { status: 'success', adapter: obsidianStatusLocked(lease, notebookId).adapter };
    });
}

async function reconcileEntry(entry) {
    if (entry.reconciling) { entry.again = true; return entry.reconciling; }
    entry.reconciling = (async () => {
        do {
            entry.again = false;
            const known = withRoleplayAccount(entry.base, entry.stamp, lease => {
                checkedBinding(lease, entry.notebookId);
                return readObsidianHistoryIndexLocked(lease, entry.notebookId).files;
            });
            const snapshot = await prepareInWorker('sync-snapshot', { contentRoot: entry.folder.path, known });
            const changed = [];
            for (const file of snapshot.files) {
                if (file.unchanged) continue;
                const recorded = withRoleplayAccount(entry.base, entry.stamp, lease => {
                    checkedBinding(lease, entry.notebookId);
                    const current = readAuthoringFileLocked(lease, path.join(entry.folder.path, file.path), MAX_ATTACHMENT_BYTES);
                    if (JSON.stringify(authoringEvidence(current)) !== JSON.stringify(file.evidence)) { entry.again = true; return false; }
                    recordObsidianFileLocked(lease, entry.notebookId, file);
                    invalidateNotebookFiles(lease, entry.notebookId, [file.path]);
                    return true;
                });
                if (recorded) changed.push(file.path);
                await yieldNotebookWork();
            }
            const present = new Set(snapshot.paths);
            for (const [relative, previous] of Object.entries(known)) {
                if (previous.deleted || present.has(relative)) continue;
                withRoleplayAccount(entry.base, entry.stamp, lease => {
                    checkedBinding(lease, entry.notebookId);
                    recordObsidianFileLocked(lease, entry.notebookId, { path: relative, hash: null, size: 0 });
                    invalidateNotebookFiles(lease, entry.notebookId, [relative]);
                });
                changed.push(relative);
                await yieldNotebookWork();
            }
            await prepareNotebook(entry.base, entry.notebookId, { stamp: entry.stamp, force: true });
            const canvases = withRoleplayAccount(entry.base, entry.stamp, lease => listCanvasesLocked(lease, entry.notebookId).canvases);
            for (const canvas of canvases) {
                try {
                    withRoleplayAccount(entry.base, entry.stamp, lease => readCanvasLocked(lease, { notebookId: entry.notebookId, canvasId: canvas.id }));
                } catch (error) {
                    if (error.code !== 'CANVAS_INVALID') throw error;
                }
                await yieldNotebookWork();
            }
            const noteChanges = withRoleplayAccount(entry.base, entry.stamp, lease => {
                pruneObsidianHistoryLocked(lease, entry.notebookId);
                const paths = new Set(changed);
                return Object.entries(readManifestLocked(lease, entry.notebookId).notes)
                    .filter(([, note]) => paths.has(note.path))
                    .map(([noteId, note]) => ({ noteId, revision: note.hash }));
            });
            entry.lastCheckedAt = new Date().toISOString();
            if (changed.length) {
                const owner = path.basename(entry.base.directories.root);
                notifyNotebookChanged({ owner, notebookId: entry.notebookId, kind: 'structure' });
                for (const change of noteChanges) notifyNotebookChanged({ owner, notebookId: entry.notebookId, kind: 'external', ...change });
            }
        } while (entry.again && !entry.stopping);
    })();
    try { return await entry.reconciling; } finally { entry.reconciling = null; }
}

export async function reconcileObsidian(base, notebookId, { stamp = roleplayAccountStamp(base) } = {}) {
    const active = runtimes.get(runtimeKey(base, notebookId));
    const entry = active ?? { base, stamp, notebookId, folder: withRoleplayAccount(base, stamp, lease => checkedBinding(lease, notebookId).folder) };
    await reconcileEntry(entry);
    return withRoleplayAccount(base, stamp, lease => ({ ...obsidianStatusLocked(lease, notebookId), lastCheckedAt: entry.lastCheckedAt }));
}

async function stopEntry(entry) {
    entry.stopping = true;
    clearInterval(entry.poll);
    clearTimeout(entry.debounce);
    entry.watcher?.close();
    if (entry.child && entry.child.exitCode === null && entry.child.signalCode === null) {
        await new Promise(resolve => {
            const child = entry.child;
            let closed = false;
            let timer = null;
            child.once('close', () => { closed = true; clearTimeout(timer); resolve(); });
            if (child.connected) child.send({ type: 'stop' });
            timer = setTimeout(() => {
                if (closed) return;
                // Only this wrapper's separate process group can contain its client.
                try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
            }, 5000);
            timer.unref();
        });
    }
    await entry.reconciling?.catch(() => null);
    if (runtimes.get(runtimeKey(entry.base, entry.notebookId)) === entry) runtimes.delete(runtimeKey(entry.base, entry.notebookId));
    if (folderClaims.get(physicalKey(entry.folder)) === entry) folderClaims.delete(physicalKey(entry.folder));
    entry.running = false;
    const key = runtimeKey(entry.base, entry.notebookId);
    stoppedRuntimes.delete(key);
    stoppedRuntimes.set(key, { lastCheckedAt: entry.lastCheckedAt ?? null, message: entry.message ?? 'Client stopped. Files and private history were kept.' });
    while (stoppedRuntimes.size > 1000) stoppedRuntimes.delete(stoppedRuntimes.keys().next().value);
}

export async function startObsidian(base, { notebookId, operationId, expectedRevision }, { stamp = roleplayAccountStamp(base) } = {}) {
    const configured = withRoleplayAccount(base, stamp, lease => {
        const checked = checkedBinding(lease, notebookId);
        if (checked.binding.revision !== expectedRevision) throw notebookError('OBSIDIAN_CONFLICT', 'Sync settings changed. Refresh before starting the client.', 409);
        return runOperationLocked(lease, { operationId, kind: 'obsidian-start', args: { notebookId, expectedRevision } }, () => ({ status: 'success', folder: checked.folder }));
    });
    if (runtimes.has(runtimeKey(base, notebookId)) || folderClaims.has(physicalKey(configured.folder))) {
        throw notebookError('OBSIDIAN_FOLDER_BUSY', 'This folder already has a client starting or running.', 409);
    }
    const config = settings();
    if (Number(process.versions.node.split('.')[0]) < 22 || typeof config.executable !== 'string' || !path.isAbsolute(config.executable)) {
        throw notebookError('OBSIDIAN_CLIENT_UNAVAILABLE', 'The administrator must provide an already-installed Headless executable and Node 22 or newer. Nothing was installed or signed in.', 400);
    }
    try { fs.accessSync(config.executable, fs.constants.X_OK); } catch { throw notebookError('OBSIDIAN_CLIENT_UNAVAILABLE', 'The prepared Headless executable is unavailable. Nothing was installed or signed in.', 400); }
    const entry = { base, stamp, notebookId, folder: configured.folder, starting: true, running: false, message: 'Checking the prepared folder...' };
    stoppedRuntimes.delete(runtimeKey(base, notebookId));
    runtimes.set(runtimeKey(base, notebookId), entry);
    folderClaims.set(physicalKey(entry.folder), entry);
    const stillStarting = () => {
        if (entry.stopping || runtimes.get(runtimeKey(base, notebookId)) !== entry || folderClaims.get(physicalKey(entry.folder)) !== entry) {
            throw notebookError('OBSIDIAN_START_CANCELLED', 'Client startup was cancelled. No new client will be started.', 409);
        }
    };
    try {
        await reconcileEntry(entry);
        stillStarting();
        entry.child = spawn(process.execPath, [new URL('./obsidian-client-runner.js', import.meta.url).pathname,
            Buffer.from(JSON.stringify({ folder: entry.folder.path, physical: entry.folder.physical, executable: config.executable, parentPid: process.pid })).toString('base64')],
        { cwd: entry.folder.path, shell: false, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        await new Promise((resolve, reject) => {
            let ready = false;
            entry.child.on('message', message => {
                if (message.type === 'ready') {
                    ready = true;
                    entry.clientPid = message.clientPid;
                    resolve();
                } else if (message.type === 'failed' && !ready) {
                    reject(notebookError(message.code, message.code === 'OBSIDIAN_FOLDER_BUSY' ? 'Another client holds this folder. Stop it before starting another.' : 'The folder or client is not prepared. Set up Headless outside Neconyan first; no installation or sign-in was attempted.', 409));
                }
            });
            entry.child.once('error', () => reject(notebookError('OBSIDIAN_CLIENT_UNAVAILABLE', 'The prepared client could not start.', 503)));
            entry.child.once('close', () => {
                if (!ready) reject(notebookError('OBSIDIAN_CLIENT_UNAVAILABLE', 'The prepared client stopped before it was ready.', 503));
                else if (!entry.stopping) { entry.message = 'The prepared client stopped. Refresh the folder before starting it again.'; void stopEntry(entry); }
            });
        });
        stillStarting();
        withRoleplayAccount(base, stamp, lease => checkedBinding(lease, notebookId));
        entry.starting = false;
        entry.running = true;
        entry.message = 'Client running. Incoming files do not gain AI access or publish lore.';
        const check = () => void reconcileEntry(entry).catch(() => {
            entry.message = 'The folder could not be reconciled safely. The client has paused; check the folder before restarting.';
            void stopEntry(entry);
        });
        entry.watcher = fs.watch(entry.folder.path, { recursive: true }, (_event, filename) => {
            if (String(filename ?? '').split(/[\\/]/).some(segment => segment.startsWith('.'))) return;
            clearTimeout(entry.debounce);
            entry.debounce = setTimeout(check, 80);
        });
        entry.watcher.on('error', check);
        entry.poll = setInterval(check, config.interval);
        entry.poll.unref();
        await reconcileEntry(entry);
        return withRoleplayAccount(base, stamp, lease => obsidianStatusLocked(lease, notebookId));
    } catch (error) { await stopEntry(entry); throw error; }
}

export async function stopObsidian(base, notebookId, { stamp = roleplayAccountStamp(base) } = {}) {
    withRoleplayAccount(base, stamp, lease => readManifestLocked(lease, notebookId));
    const entry = runtimes.get(runtimeKey(base, notebookId));
    if (entry) {
        entry.message = 'Client stopped. Files and private history were kept.';
        await stopEntry(entry);
    }
    if (settings().enabled) await reconcileObsidian(base, notebookId, { stamp });
    return withRoleplayAccount(base, stamp, lease => obsidianStatusLocked(lease, notebookId));
}
