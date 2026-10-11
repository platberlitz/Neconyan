import path from 'node:path';
import { readAuthoringFileLocked, writeAuthoringFileLocked } from '../authoring-store.js';
import { roleplayLease, readRoleplayFile } from '../roleplay-store.js';
import { normaliseRoleplayLocator, roleplayEntityContent } from '../generation/roleplay-source.js';
import Jimp from '../jimp.js';
import { decodeServerImage, encodeServerImage } from '../media-codecs.js';
import { newScratchpadId, ScratchpadError, sessionAssistants } from './store.js';
import { isCustomAssistant, MAX_ASSISTANTS, normaliseAssistantProfile, assistantProfileError } from './assistant-profiles.js';

const FILE_LIMIT = 8 * 1024 * 1024;
const filename = lease => path.join(roleplayLease(lease).scope.directories.root, 'scratchpad', 'assistants.json');

export function readAssistantsLocked(lease) {
    const file = readAuthoringFileLocked(lease, filename(lease), FILE_LIMIT);
    if (!file) return { version: 1, revision: 0, assistants: [] };
    try {
        const library = JSON.parse(file.bytes.toString('utf8'));
        if (library.version !== 1 || !Number.isSafeInteger(library.revision) || library.revision < 0
            || !Array.isArray(library.assistants) || library.assistants.length > MAX_ASSISTANTS) throw new Error('Invalid library.');
        const assistants = library.assistants.map(normaliseAssistantProfile);
        if (new Set(assistants.map(item => item.id)).size !== assistants.length) throw new Error('Duplicate identity.');
        return { version: 1, revision: library.revision, assistants };
    } catch {
        throw new ScratchpadError('SCRATCHPAD_ASSISTANTS_DAMAGED', 'The saved assistant library could not be read.', 500);
    }
}

export function saveAssistantLocked(lease, input, expectedRevision) {
    const library = readAssistantsLocked(lease);
    if (expectedRevision !== library.revision) throw new ScratchpadError('SCRATCHPAD_ASSISTANTS_CHANGED', 'Your assistants changed elsewhere. Copy your edits, then reopen the editor.', 409);
    const index = library.assistants.findIndex(item => item.id === input?.id);
    if (input?.id && index < 0) throw assistantProfileError('This assistant no longer exists.', 404);
    if (index < 0 && library.assistants.length >= MAX_ASSISTANTS) throw assistantProfileError(`You can save up to ${MAX_ASSISTANTS} assistants.`);
    const assistant = normaliseAssistantProfile({ ...input, id: input?.id || `assistant_${newScratchpadId()}` });
    if (index < 0) library.assistants.push(assistant);
    else library.assistants[index] = assistant;
    library.revision++;
    writeAuthoringFileLocked(lease, filename(lease), JSON.stringify(library), { limit: FILE_LIMIT });
    return { library, assistant };
}

/** Sessions keep their own copies, so deleting from the library leaves earlier conversations readable. */
export function deleteAssistantLocked(lease, id, expectedRevision) {
    const library = readAssistantsLocked(lease);
    if (expectedRevision !== library.revision) throw new ScratchpadError('SCRATCHPAD_ASSISTANTS_CHANGED', 'Your assistants changed elsewhere. Reopen the editor and try again.', 409);
    const index = library.assistants.findIndex(item => item.id === id);
    if (!isCustomAssistant(id) || index < 0) throw assistantProfileError('This assistant no longer exists.', 404);
    library.assistants.splice(index, 1);
    library.revision++;
    writeAuthoringFileLocked(lease, filename(lease), JSON.stringify(library), { limit: FILE_LIMIT });
    return { library };
}

const clipBytes = (text, limit) => {
    let value = typeof text === 'string' ? text : '';
    if (Buffer.byteLength(value) <= limit) return value;
    value = Buffer.from(value).subarray(0, limit).toString('utf8');
    while (Buffer.byteLength(value) > limit || value.endsWith('\uFFFD')) value = value.slice(0, -1);
    return value;
};

/** Decode and re-encode portraits so neither card metadata nor active image content is retained. */
export async function assistantPortrait(bytes) {
    try {
        const image = Jimp.fromBitmap(await decodeServerImage(bytes));
        image.cover({ w: 256, h: 256 });
        const jpeg = await encodeServerImage(image.bitmap, 'jpeg', { quality: 80 });
        return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    } catch {
        throw assistantProfileError('That picture could not be read. Choose another PNG, JPEG or WebP image.');
    }
}

export function readAssistantCardLocked(lease, avatar) {
    normaliseRoleplayLocator({ group: false, chat: 'source', avatar });
    const file = readRoleplayFile(path.join(roleplayLease(lease).scope.directories.characters, avatar), 64 * 1024 * 1024);
    if (!file) throw assistantProfileError('That character card no longer exists.', 404);
    const card = roleplayEntityContent('character', avatar, file.bytes).data;
    const data = card.data ?? card;
    // Cards often run past the assistant limits; keep the opening of each field instead of refusing the card.
    const name = String(data.name ?? '').trim().slice(0, 80).replace(/[\uD800-\uDBFF]$/, '').trim();
    return { bytes: file.bytes, profile: {
        name,
        personality: clipBytes([data.description, data.personality].filter(Boolean).join('\n\n'), 64000) || `You are ${name}.`,
        examples: clipBytes(data.mes_example, 64000),
        sourceCard: avatar,
    } };
}

export function resolveAssistant(library, id, snapshots = {}) {
    if (!isCustomAssistant(id)) return undefined;
    const profile = library.assistants.find(item => item.id === id) ?? snapshots[id];
    if (!profile) throw new ScratchpadError('SCRATCHPAD_ASSISTANT_MISSING', 'This assistant is unavailable. Choose another assistant or import a session containing their personality.', 404);
    return profile;
}

export function refreshSessionAssistants(session, library) {
    const snapshots = session.settings.assistants ??= {};
    const ids = new Set([session.assistant, ...sessionAssistants(session), ...session.messages.map(message => message.assistant)]);
    for (const id of ids) {
        const profile = resolveAssistant(library, id, snapshots);
        if (profile) snapshots[id] = structuredClone(profile);
    }
    return snapshots;
}
