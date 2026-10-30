import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { read as readCharacterCard } from '../character-card-parser.js';
import { readWorldInfoFile } from '../endpoints/worldinfo.js';
import { fail, hash, POLICY_VERSION, purgeSources, sourceAt } from './core.js';
import { readConfig, legacyRoleVersion, resolvedRoleIdentity, roleVersion } from './models.js';
import { processingVersion } from './processing.js';
import { captureBranchMemory, readChatShared, readJsonShared, readStateShared, synchronize } from './store.js';
import { fileCollections } from '../operations/vector-sources.js';

const cardTextCache = new Map();
const CARD_TEXT_CACHE_MAX_ENTRIES = 128;

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

/** The server resolves the applicable books; a request cannot add another story's library. */
export async function readContextSources(directories, locator, state) {
    return readContextSourcesSync(directories, locator, state);
}

/** Synchronous reads can stay inside the protected account lock. */
export function readContextSourcesSync(directories, locator, state, source = readChatShared(directories, locator)) {
    const { metadata } = source;
    if (!state) {
        captureBranchMemory(directories, locator, source);
        state = readStateShared(directories, locator);
    }
    const aliases = state.characterAliases || {};
    const settings = readJsonShared(path.join(directories.root, 'settings.json'), {});
    const worlds = new Set(Array.isArray(settings.world_info?.globalSelect) ? settings.world_info.globalSelect : []);
    if (metadata.world_info) worlds.add(metadata.world_info);
    if (settings.power_user?.persona_description_lorebook) worlds.add(settings.power_user.persona_description_lorebook);
    const avatars = new Set(locator.avatar ? [locator.avatar] : []);
    if (locator.group && fs.existsSync(directories.groups)) {
        for (const filename of fs.readdirSync(directories.groups).filter(name => name.endsWith('.json'))) {
            const group = readJsonShared(path.join(directories.groups, filename), {});
            if (String(group.chat_id) !== locator.chat && !(group.chats || []).map(String).includes(locator.chat)
                && !(group.past_chats || []).map(String).includes(locator.chat)) continue;
            for (const avatar of group.members || []) if (safeFilename(avatar)) avatars.add(avatar);
        }
    }
    const sources = [];
    for (const avatar of avatars) {
        if (!safeFilename(avatar)) fail('Mewmory could not identify that character card.');
        const filename = path.join(directories.characters, avatar);
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
        const book = readWorldInfoFile(directories, world, false);
        if (!book) continue;
        for (const [uid, entry] of Object.entries(book.entries || {})) {
            if (!entry || typeof entry !== 'object') continue;
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
        const files = fileCollections({ directories }, settings, chat, {}, [], { skipMissing: true, avatars: [...avatars] });
        for (const file of files) {
            const messageIndex = file.inlineMessageIndex ?? (file.dataBank ? -1 : source.messages.findIndex(row => row.extra?.files?.some(item => item.url === file.url)));
            sources.push({ id: 'file:' + hash(file.url).slice(0, 32), type: 'file', name: decodeURIComponent(file.url.slice('/user/files/'.length)),
                text: file.text, meta: { url: file.url, ...(messageIndex >= 0 ? { messageIndex } : {}) } });
        }
    }
    return sources;
}

export async function loadCurrentState(directories, locator) {
    return loadCurrentStateSync(directories, locator);
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

export function loadCurrentStateSync(directories, locator) {
    const source = readChatShared(directories, locator);
    const context = readContextSourcesSync(directories, locator, undefined, source);
    const config = readConfig(directories);
    const policy = processingVersion(config);
    const roleKeys = Object.fromEntries(PROCESSING_ROLES.map(name => [name, roleVersion(config, name)]));
    const identities = Object.fromEntries(PROCESSING_ROLES.map(name => [name, resolvedRoleIdentity(config, name)]));
    // Preserve existing coverage when upgrading a policy that included request timeouts or
    // operational role settings. Both formulas are rebuilt from the current configuration.
    const legacyPolicy = hash([POLICY_VERSION, ...['extractor', 'pawspective'].map(name => hash([config.localOnly, config.roles[name]]))]);
    const legacyCurrentPolicy = hash([POLICY_VERSION, ...['extractor', 'pawspective'].map(name => legacyRoleVersion(config, name))]);
    return synchronize(directories, locator, context, source, current => {
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
                // Delete only marks produced with the old connection, never another stored version.
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
        if (clearedPolicies.size) {
            for (const coverage of [current.coverage, current.checkpoints]) {
                for (const key of Object.keys(coverage)) if (clearedPolicies.has(coverage[key])) delete coverage[key];
            }
        }
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
        return purgeMissingContextSources(directories, current);
    });
}

export function purgeMissingContextSources(directories, state) {
    const books = new Map();
    const deleted = [];
    for (const source of Object.values(state.sources)) {
        if (source.active || source.type === 'chat') continue;
        const revision = sourceAt(state, { id: source.id, revision: source.current });
        if (!revision) continue;
        if (source.type === 'lore' && revision.meta.world) {
            if (!books.has(revision.meta.world)) books.set(revision.meta.world, readWorldInfoFile(directories, revision.meta.world, false));
            const book = books.get(revision.meta.world);
            if (!book || !book.entries?.[revision.meta.uid]) deleted.push(source.id);
        } else if (source.type === 'character' && revision.meta.avatar
            && !fs.existsSync(path.join(directories.characters, revision.meta.avatar))) {
            deleted.push(source.id);
        } else if (source.type === 'file' && revision.meta.url
            && !fs.existsSync(path.join(directories.files, decodeURIComponent(revision.meta.url.slice('/user/files/'.length))))) {
            deleted.push(source.id);
        }
    }
    if (deleted.length) purgeSources(state, deleted);
    return state;
}
