import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { read as readCharacterCard } from '../character-card-parser.js';
import { getWorldInfoFilenameCandidates, readWorldInfoFile } from '../endpoints/worldinfo.js';
import { agentCollectionDirectory } from '../in-chat-agent-storage.js';
import { recoverFileWriteSync } from '../util.js';
import { fail, hash, POLICY_VERSION, purgeSources, retireCoverage, sourceAt } from './core.js';
import { readConfig, legacyRoleVersion, resolvedRoleIdentity, roleVersion } from './models.js';
import { processingVersion } from './processing.js';
import {
    captureBranchMemory, chatPath, fileIdentity, hasLegacyTrackerResults, readChatShared, readJsonShared, readStateShared,
    recoveryPath, statePath, synchronize,
} from './store.js';
import { fileCollections } from '../operations/vector-sources.js';
import { selectSavedRoleplayPersona } from '../generation/world-info.js';
import { registerMemoryReclaimer } from '../memory-pressure.js';

const cardTextCache = new Map();
const CARD_TEXT_CACHE_MAX_ENTRIES = 128;

registerMemoryReclaimer(() => {
    cardTextCache.clear();
});

/** Decoding a card PNG costs a crc32 pass plus base64 decode; the text is immutable, so share it. */
function readCharacterCardTextSync(filename) {
    const key = path.resolve(filename);
    let stat;
    try {
        stat = fs.statSync(filename);
    } catch {
        cardTextCache.delete(key);
        return null;
    }
    const cached = cardTextCache.get(key);
    if (cached && cached.dev === stat.dev && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.text;
    const text = readCharacterCard(fs.readFileSync(filename));
    cardTextCache.set(key, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, text });
    if (cardTextCache.size > CARD_TEXT_CACHE_MAX_ENTRIES) cardTextCache.delete(cardTextCache.keys().next().value);
    return text;
}

function safeFilename(value) {
    return typeof value === 'string' && value && value === sanitize(value);
}

/**
 * The files one synchronise read, each stamped just before it was read, so a change after that
 * point shows up as a different stamp. A stamp is null for a missing file: creating it counts too.
 */
function createInputStamps() {
    return { files: new Map(), late: new Set(), tainted: false, startedAt: Date.now() };
}

// A file stamped after it was read could have been overwritten in between. Its stamp is trusted only when the file
// had been quiet for longer than the clock of the file system can resolve before this synchronise began.
const QUIET_BEFORE_START_MS = 50;

function stampsAreTrustworthy(inputs) {
    return !inputs.tainted && [...inputs.late].every(filename => {
        try {
            const stat = fs.statSync(filename);
            return Math.max(stat.mtimeMs, stat.ctimeMs) < inputs.startedAt - QUIET_BEFORE_START_MS;
        } catch {
            return false;
        }
    });
}

/** Saved tracker results from before the category snapshot are resolved against the Agent library: its folder and every record are inputs. */
function stampAgentLibrary(inputs, directories) {
    let directory;
    try {
        directory = agentCollectionDirectory(directories);
    } catch {
        inputs.tainted = true;
        return;
    }
    stampFile(inputs, directory);
    stampFile(inputs, path.join(directory, '.agent-path-check'));
    let names = [];
    try { names = fs.readdirSync(directory).filter(name => name.toLowerCase().endsWith('.json')); } catch { /* A missing folder stays a missing stamp. */ }
    for (const name of names) stampFile(inputs, path.join(directory, name));
}

function stampFile(inputs, filename) {
    if (inputs && !inputs.files.has(filename)) inputs.files.set(filename, fileIdentity(filename));
}

/** For a file whose name only became known by reading it: stamp it, then make sure it is the file that was read. */
function stampReadFile(inputs, filename, physical) {
    if (!inputs) return;
    stampFile(inputs, filename);
    inputs.late.add(filename);
    try {
        const stat = fs.statSync(filename, { bigint: true });
        if (String(stat.dev) === physical?.dev && String(stat.ino) === physical?.ino && String(stat.birthtimeNs) === physical?.birthtimeNs) return;
    } catch { /* The file went away: do not trust the stamp. */ }
    inputs.tainted = true;
}

function existsStamped(inputs, filename) {
    stampFile(inputs, filename);
    return fs.existsSync(filename);
}

function stampWorld(inputs, directories, world) {
    for (const candidate of getWorldInfoFilenameCandidates(world)) if (candidate) stampFile(inputs, path.join(directories.worlds, candidate));
}

/** The server resolves the applicable books; a request cannot add another story's library. */
export async function readContextSources(directories, locator, state) {
    return readContextSourcesSync(directories, locator, state);
}

/** Synchronous reads can stay inside the protected account lock. */
export function readContextSourcesSync(directories, locator, state, source = readChatShared(directories, locator), inputs = null) {
    const { metadata } = source;
    if (!state) {
        captureBranchMemory(directories, locator, source);
        state = readStateShared(directories, locator);
    }
    const aliases = state.characterAliases || {};
    stampFile(inputs, path.join(directories.root, 'settings.json'));
    const settings = readJsonShared(path.join(directories.root, 'settings.json'), {});
    const worlds = new Set(Array.isArray(settings.world_info?.globalSelect) ? settings.world_info.globalSelect : []);
    if (metadata.world_info) worlds.add(metadata.world_info);
    const avatars = new Set(locator.avatar ? [locator.avatar] : []);
    let groupId;
    if (locator.group) stampFile(inputs, directories.groups);
    if (locator.group && fs.existsSync(directories.groups)) {
        for (const filename of fs.readdirSync(directories.groups).filter(name => name.endsWith('.json'))) {
            stampFile(inputs, path.join(directories.groups, filename));
            const group = readJsonShared(path.join(directories.groups, filename), {});
            if (String(group.chat_id) !== locator.chat && !(group.chats || []).map(String).includes(locator.chat)
                && !(group.past_chats || []).map(String).includes(locator.chat)) continue;
            groupId = String(group.id ?? filename.slice(0, -5));
            for (const avatar of group.members || []) if (safeFilename(avatar)) avatars.add(avatar);
        }
    }
    const sources = [];
    const persona = selectSavedRoleplayPersona(settings, { locator, records: [{ chat_metadata: metadata }] },
        { groupId }, locator.avatar, directories);
    const playerName = persona.name || source.messages.findLast(message => message.is_user)?.name || settings.name1;
    if (playerName) {
        sources.push({
            id: 'character:player', type: 'character', entityId: 'player', name: String(playerName || 'Player'),
            // The writer already receives the persona through its preset. Mewmory needs only the identity.
            text: String(playerName), meta: { persona: persona.evidence?.avatar || '' },
        });
    }
    if (persona.evidence) stampReadFile(inputs, path.join(directories.avatars ?? path.join(directories.root, 'User Avatars'), persona.evidence.avatar), persona.evidence.physical);
    if (persona.lorebook) worlds.add(persona.lorebook);
    for (const avatar of avatars) {
        if (!safeFilename(avatar)) fail('Mewmory could not identify that character card.');
        const filename = path.join(directories.characters, avatar);
        stampFile(inputs, filename);
        if (!fs.existsSync(filename)) continue;
        let card;
        try {
            const parsed = JSON.parse(readCharacterCardTextSync(filename));
            card = parsed.data || parsed;
        } catch {
            fail('A character card could not be read. Reload the character, then try again.', 409);
        }
        const canonicalAvatar = aliases[avatar] || avatar;
        const entityId = 'npc:' + hash(canonicalAvatar).slice(0, 20);
        sources.push({
            id: 'character:' + hash(canonicalAvatar).slice(0, 32), type: 'character', entityId,
            name: String(card.name || avatar),
            text: [card.description, card.personality, card.scenario, card.mes_example].filter(Boolean).join('\n\n'),
            meta: { avatar },
        });
        if (card.extensions?.world) worlds.add(card.extensions.world);
        for (const link of settings.world_info?.charLore || []) {
            if (link.name === avatar.replace(/\.png$/, '')) {
                for (const world of link.extraBooks || []) worlds.add(world);
            }
        }
    }
    for (const world of worlds) {
        if (!safeFilename(world)) continue;
        stampWorld(inputs, directories, world);
        const book = readWorldInfoFile(directories, world, false);
        if (!book) continue;
        for (const [uid, entry] of Object.entries(book.entries || {})) {
            if (!entry || typeof entry !== 'object' || entry.mewmoryRecordId) continue;
            sources.push({
                id: 'lore:' + hash([state.worldAliases?.[world] || world, uid]).slice(0, 32), type: 'lore',
                name: String(entry.comment || world + ' / ' + uid),
                text: [entry.comment, (entry.key || []).join(', '), entry.content].filter(Boolean).join('\n'),
                enabled: !entry.disable && entry.enabled !== false,
                meta: { world, uid, keywords: Array.isArray(entry.key) ? entry.key : [] },
            });
        }
    }
    if (readConfig(directories).retrieval.includeFiles) {
        const chat = { locator, records: [{ chat_metadata: metadata }, ...source.messages] };
        // A file created later changes the folder; one replaced in place changes its own stamp.
        stampFile(inputs, directories.files);
        const read = [];
        const files = fileCollections({ directories }, settings, chat, {}, read, { skipMissing: true, avatars: [...avatars] });
        for (const { relative, evidence } of read) stampReadFile(inputs, path.join(directories.root, relative), evidence?.physical);
        for (const file of files) {
            const messageIndex = file.inlineMessageIndex ?? (file.dataBank ? -1 : source.messages.findIndex(row => row.extra?.files?.some(item => item.url === file.url)));
            sources.push({ id: 'file:' + hash(file.url).slice(0, 32), type: 'file', name: decodeURIComponent(file.url.slice('/user/files/'.length)),
                text: file.text, meta: { url: file.url, ...(messageIndex >= 0 ? { messageIndex } : {}) } });
        }
    }
    return sources;
}

export async function loadCurrentState(directories, locator, options) {
    return loadCurrentStateSync(directories, locator, options);
}

const PROCESSING_ROLES = ['extractor', 'pawspective'];

/** True when a resolved profile-backed source or model differs from the one stored for this semantic role version. */
export function roleIdentityChanged(state, config) {
    return PROCESSING_ROLES.some(name => {
        const live = resolvedRoleIdentity(config, name);
        const stored = state.roleIdentities?.[name];
        const saved = typeof stored === 'string' ? stored : stored?.[roleVersion(config, name)];
        return Boolean(live && saved != null && saved !== live);
    });
}

/** Every value the synchronise folds in from the Mewmory configuration. */
function foldedPolicy(config) {
    const policy = processingVersion(config);
    const roleKeys = Object.fromEntries(PROCESSING_ROLES.map(name => [name, roleVersion(config, name)]));
    const identities = Object.fromEntries(PROCESSING_ROLES.map(name => [name, resolvedRoleIdentity(config, name)]));
    // Preserve existing coverage when upgrading a policy that included request timeouts or
    // operational role settings. Both formulas are rebuilt from the current configuration.
    const legacyPolicy = hash([POLICY_VERSION, ...['extractor', 'pawspective'].map(name => hash([config.localOnly, config.roles[name]]))]);
    const legacyCurrentPolicy = hash([POLICY_VERSION, ...['extractor', 'pawspective'].map(name => legacyRoleVersion(config, name))]);
    return { policy, roleKeys, identities, legacyPolicy, legacyCurrentPolicy,
        key: hash([policy, roleKeys, identities, legacyPolicy, legacyCurrentPolicy, config.retrieval.includeFiles]) };
}

/**
 * What the last completed synchronise of each story read, so an unchanged story is not reconciled again
 * (hashing every message, re-reading cards and lorebooks, cloning and serialising the archive) each time
 * it is loaded. An entry holds only stamps, never data, and is dropped when any stamp differs.
 */
const currentStateMemo = new Map();
// A few stamps for each of at most this many stories, so memory pressure has nothing to reclaim here: keeping them
// means the first load after a reclaim does not run the full synchronise at the worst moment.
const CURRENT_STATE_MEMO_MAX_ENTRIES = 64;

/** The chat file's identity, or null when Mewmory reads it without caching (missing, linked, not a plain file). */
function chatStamp(filename) {
    try {
        const stat = fs.lstatSync(filename);
        return stat.isFile() && !stat.isSymbolicLink() ? fileIdentity(filename) : null;
    } catch {
        return null;
    }
}

/** Callers may reassign top-level fields (index) of what they load; nested data stays the shared, read-only parse. */
function ownedView(shared) {
    const view = { ...shared };
    if (view.index && typeof view.index === 'object' && !Array.isArray(view.index)) {
        view.index = { ...view.index };
        if (view.index.build && typeof view.index.build === 'object') view.index.build = { ...view.index.build };
    }
    return view;
}

function memoizedCurrentState(directories, locator, key) {
    const memo = currentStateMemo.get(key);
    if (!memo) return null;
    const chatFile = chatPath(directories, locator);
    // Readers apply an interrupted chat write first, so this does too before comparing.
    recoverFileWriteSync(path.resolve(chatFile));
    const current = chatStamp(chatFile) === memo.chat && fileIdentity(key) === memo.archive
        && fileIdentity(recoveryPath(directories, locator)) === memo.guard
        && memo.files.every(([filename, identity]) => fileIdentity(filename) === identity)
        && foldedPolicy(readConfig(directories)).key === memo.policy;
    if (!current) {
        currentStateMemo.delete(key);
        return null;
    }
    currentStateMemo.delete(key);
    currentStateMemo.set(key, memo);
    return ownedView(readStateShared(directories, locator));
}

/** `fresh` makes the load reconcile from scratch, as the worker's periodic safety pass does. */
export function loadCurrentStateSync(directories, locator, { fresh = false } = {}) {
    const key = statePath(directories, locator);
    const reused = fresh ? null : memoizedCurrentState(directories, locator, key);
    if (fresh) currentStateMemo.delete(key);
    if (reused) return reused;
    const inputs = createInputStamps();
    // Stamped before the chat is read: a save after this point leaves an older stamp, never a newer one.
    const chat = chatStamp(chatPath(directories, locator));
    const source = readChatShared(directories, locator);
    if (hasLegacyTrackerResults(source.messages)) stampAgentLibrary(inputs, directories);
    const context = readContextSourcesSync(directories, locator, undefined, source, inputs);
    const config = readConfig(directories);
    const { policy, roleKeys, identities, legacyPolicy, legacyCurrentPolicy, key: policyKey } = foldedPolicy(config);
    let settled = null;
    const state = synchronize(directories, locator, context, source, current => {
        const identitiesChanged = [];
        const books = {};
        for (const name of PROCESSING_ROLES) {
            const stored = current.roleIdentities?.[name];
            if (typeof stored === 'string') {
                // Migrate the earlier single-identity archive shape to one entry per semantic role version.
                books[name] = { [roleKeys[name]]: stored };
                identitiesChanged.push(name);
            } else {
                books[name] = stored && typeof stored === 'object' ? { ...stored } : {};
            }
        }
        const policies = { ...(current.rolePolicies || {}) };
        const clearedPolicies = new Set();
        for (const name of PROCESSING_ROLES) {
            const live = identities[name];
            if (!live) continue;
            const key = roleKeys[name];
            const previous = books[name][key];
            if (previous == null) {
                // Archives written before identities were tracked start from the current
                // connection instead of being treated as a change.
                books[name][key] = live;
                identitiesChanged.push(name);
            } else if (previous !== live) {
                // The same semantic role version now resolves to a different source or model.
                // Flag only marks produced with the old connection as read earlier, never another stored version.
                books[name][key] = live;
                identitiesChanged.push(name);
                clearedPolicies.add(policy);
                for (const [savedPolicy, snapshot] of Object.entries(policies)) {
                    const saved = snapshot?.[name];
                    if (saved?.key === key && saved.identity === previous) clearedPolicies.add(savedPolicy);
                }
            }
        }
        for (const coverage of [current.coverage, current.checkpoints]) {
            for (const key of Object.keys(coverage)) {
                if (coverage[key] === legacyPolicy || coverage[key] === legacyCurrentPolicy) coverage[key] = policy;
            }
        }
        if (clearedPolicies.size) retireCoverage(current, value => clearedPolicies.has(value));
        policies[policy] = Object.fromEntries(PROCESSING_ROLES.map(name => {
            const saved = policies[policy]?.[name];
            // A temporary profile failure leaves the live identity null. Keep the last nonempty
            // identity for the same semantic role version so a later return to it can still detect
            // that the profile actually changed while it was away.
            const identity = identities[name]
                ?? (saved?.key === roleKeys[name] ? saved.identity : null);
            return [name, { key: roleKeys[name], identity }];
        }));
        const used = new Set([policy, ...Object.values(current.coverage), ...Object.values(current.checkpoints)]);
        for (const key of Object.keys(policies)) if (!used.has(key)) delete policies[key];
        if (identitiesChanged.length) current.roleIdentities = books;
        current.rolePolicies = policies;
        return purgeMissingContextSources(directories, current, inputs);
    }, result => { settled = result; });
    if (settled && chat && settled.identity && settled.guard && stampsAreTrustworthy(inputs)) {
        currentStateMemo.delete(key);
        currentStateMemo.set(key, { chat, archive: settled.identity, guard: settled.guard, files: [...inputs.files], policy: policyKey });
        while (currentStateMemo.size > CURRENT_STATE_MEMO_MAX_ENTRIES) currentStateMemo.delete(currentStateMemo.keys().next().value);
    }
    // Unchanged: hand out the shared parse and let this call's private copy go.
    return settled && !settled.changed ? ownedView(settled.shared) : state;
}

export function purgeMissingContextSources(directories, state, inputs = null) {
    const books = new Map();
    const deleted = [];
    for (const source of Object.values(state.sources)) {
        if (source.active || source.type === 'chat') continue;
        const revision = sourceAt(state, { id: source.id, revision: source.current });
        if (!revision) continue;
        if (source.type === 'lore' && revision.meta.world) {
            if (!books.has(revision.meta.world)) {
                stampWorld(inputs, directories, revision.meta.world);
                books.set(revision.meta.world, readWorldInfoFile(directories, revision.meta.world, false));
            }
            const book = books.get(revision.meta.world);
            if (!book || !book.entries?.[revision.meta.uid]) deleted.push(source.id);
        } else if (source.type === 'character' && revision.meta.avatar && !existsStamped(inputs, path.join(directories.characters, revision.meta.avatar))) {
            deleted.push(source.id);
        } else if (source.type === 'file' && revision.meta.url
            && !existsStamped(inputs, path.join(directories.files, decodeURIComponent(revision.meta.url.slice('/user/files/'.length))))) {
            deleted.push(source.id);
        }
    }
    if (deleted.length) purgeSources(state, deleted);
    return state;
}
