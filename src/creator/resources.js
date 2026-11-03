import path from 'node:path';
import { readRoleplayEntityLocked } from '../generation/roleplay-source.js';
import { roleplayLease, saveRoleplayAccount, roleplayError } from '../roleplay-store.js';
import { readAuthoringFileLocked } from '../authoring-store.js';
import { getExistingWorldInfoFilename, getWorldInfoFilename, isValidWorldInfoData } from '../endpoints/worldinfo.js';
import { worldInfoRevision } from '../world-info-history.js';
import { creatorAdditionalBooks } from './bindings.js';

export function creatorCharacterSource(lease, avatar) {
    const source = readRoleplayEntityLocked(lease, 'character', avatar);
    if (source.changed) saveRoleplayAccount(lease);
    return { card: source.data, avatar, revision: source.rawHash, identity: source.instanceId, extraBooks: creatorAdditionalBooks(lease, avatar) };
}

export function creatorBookSource(lease, name, { allowMissing = false } = {}) {
    if (typeof name !== 'string' || !name.trim()) throw roleplayError('CREATOR_BOOK', 'Give the lorebook a name.', 400);
    const { directories } = roleplayLease(lease).scope;
    const filename = getExistingWorldInfoFilename(directories, name) ?? getWorldInfoFilename(name);
    if (!filename) throw roleplayError('CREATOR_BOOK', 'Choose a valid lorebook name.', 400);
    const file = readAuthoringFileLocked(lease, path.join(directories.worlds, filename));
    if (!file && !allowMissing) throw roleplayError('CREATOR_BOOK_MISSING', 'This lorebook no longer exists.', 404);
    const data = file ? JSON.parse(file.bytes.toString('utf8')) : null;
    if (data && !isValidWorldInfoData(data)) throw roleplayError('CREATOR_BOOK', 'This lorebook has invalid entries.', 409);
    return { name: path.parse(filename).name, filename, data, revision: data ? worldInfoRevision(data) : null, file };
}
