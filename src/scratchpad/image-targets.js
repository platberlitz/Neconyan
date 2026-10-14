import path from 'node:path';
import { roleplayLease, readRoleplayFile, validRoleplayAvatar } from '../roleplay-store.js';
import { roleplayEntityContent } from '../generation/roleplay-source.js';
import { CONVERSATION_STORE_KEY } from '../../public/scripts/neconyan-conversation/constants.js';
import { ScratchpadError } from './store.js';

const invalid = message => new ScratchpadError('SCRATCHPAD_IMAGE_TARGET', message, 409);

export function readImageCardLocked(lease, avatar) {
    if (!validRoleplayAvatar(avatar)) throw invalid('Choose an existing shared character card.');
    const file = readRoleplayFile(path.join(roleplayLease(lease).scope.directories.characters, avatar), 64 * 1024 * 1024);
    if (!file) throw invalid('The shared character card no longer exists.');
    const parsed = roleplayEntityContent('character', avatar, file.bytes).data;
    const data = parsed.data ?? parsed;
    return { file, character: { ...parsed, ...data, avatar, data }, name: String(data.name ?? parsed.name ?? '').trim().slice(0, 200) };
}

function sourceAvatarsLocked(lease, source) {
    if (source.kind === 'general') return source.avatar ? [source.avatar] : [];
    if (source.kind === 'notebook' || !source.scope) return [];
    if (source.scope.kind === 'character') return [source.scope.id];
    const dirs = roleplayLease(lease).scope.directories;
    let group;
    if (source.kind === 'roleplay') {
        const file = readRoleplayFile(path.join(dirs.groups, `${source.scope.id}.json`), 4 * 1024 * 1024);
        group = file && JSON.parse(file.bytes.toString('utf8'));
    } else {
        const file = readRoleplayFile(path.join(dirs.root, 'settings.json'), 32 * 1024 * 1024);
        const groups = file && JSON.parse(file.bytes.toString('utf8')).extension_settings?.[CONVERSATION_STORE_KEY]?.groups;
        const persona = /^conversation:persona:([^:]+):/.exec(source.key)?.[1];
        group = Array.isArray(groups) ? groups.find(item => String(item.id) === source.scope.id
            && String(groupPersonaId(item)) === (persona ? decodeURIComponent(persona) : '')) : null;
        if (!group) {
            const legacy = readRoleplayFile(path.join(dirs.groups, `${source.scope.id}.json`), 4 * 1024 * 1024);
            group = legacy && JSON.parse(legacy.bytes.toString('utf8'));
        }
    }
    return Array.isArray(group?.members) ? group.members.filter(validRoleplayAvatar) : [];
}

/** Conversation groups accept the same legacy persona field names the browser still reads. */
function groupPersonaId(group) {
    return group?.personaId || group?.persona || group?.personaAvatar || group?.userAvatar || '';
}

export function normaliseImageTargets(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 200).flatMap(item => {
        if (!item || !validRoleplayAvatar(item.avatar) || typeof item.name !== 'string' || !item.name.trim()) return [];
        // Long card names are shortened, not rejected, so a shared card never blocks a plain text reply.
        return [{ avatar: item.avatar, name: item.name.trim().slice(0, 200) }];
    });
}

export function imagePersonaIdLocked(lease, source) {
    if (source.kind === 'general') return source.personaId || '';
    const persona = /^conversation:persona:([^:]+):/.exec(source.key)?.[1];
    if (persona) return decodeURIComponent(persona).slice(0, 256);
    const dirs = roleplayLease(lease).scope.directories;
    const file = readRoleplayFile(path.join(dirs.root, 'settings.json'), 32 * 1024 * 1024);
    return String(file && JSON.parse(file.bytes.toString('utf8')).user_avatar || '').slice(0, 256);
}

/**
 * Capture the browser's shared targets. A bad target is dropped rather than thrown so it can never
 * block an ordinary text reply; generation re-checks the target and refuses if it is now missing.
 */
export function captureImageTargetsLocked(lease, source, targets, { shared = true } = {}) {
    const supplied = normaliseImageTargets(targets);
    if (!shared || source.kind === 'notebook') return [];
    const allowed = new Set(sourceAvatarsLocked(lease, source));
    const seen = new Set();
    const captured = [];
    for (const target of supplied) {
        if (!allowed.has(target.avatar) || seen.has(target.avatar)) continue;
        let card;
        try { card = readImageCardLocked(lease, target.avatar); } catch { continue; }
        if (card.name !== target.name) continue;
        seen.add(target.avatar);
        captured.push({ avatar: target.avatar, name: card.name });
    }
    return captured;
}

export function resolveImageTargetLocked(lease, source, message, name) {
    const matches = (message.targets ?? []).filter(target => target.name.toLowerCase() === name.trim().toLowerCase());
    if (matches.length !== 1) throw invalid(matches.length ? 'More than one shared character has that name. Ask for an unambiguous target.' : 'This reply did not share that character. Request a new image suggestion with its card shared.');
    const captured = captureImageTargetsLocked(lease, source, matches);
    if (captured.length !== 1) throw invalid('That shared character does not belong to this shared Scratchpad context or was renamed. Request a new image suggestion.');
    return { ...captured[0], ...readImageCardLocked(lease, captured[0].avatar) };
}
