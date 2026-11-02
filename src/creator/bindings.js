import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { roleplayLease, roleplayError } from '../roleplay-store.js';
import { readAuthoringFileLocked, authoringEvidence, stageAuthoringFileLocked, publishAuthoringFileLocked } from '../authoring-store.js';
import { prepareSettingsSave, getSettingsVersion, getSettingsRevision } from '../settings-version.js';
import { invalidateParsedSettingsFile } from '../settings-file-cache.js';

const LIMIT = 32 * 1024 * 1024;
const key = avatar => path.parse(avatar).name;
const world = settings => settings.world_info_settings?.world_info ?? settings.world_info ?? {};
const books = (settings, avatar) => world(settings).charLore?.find(item => item.name === key(avatar))?.extraBooks ?? [];
const conflict = () => roleplayError('CREATOR_BINDING_CONFLICT', 'The character’s additional lorebook links changed. Compare them before saving.', 409);

function readSettings(lease) {
    const filename = path.join(roleplayLease(lease).scope.directories.root, 'settings.json');
    const file = readAuthoringFileLocked(lease, filename, LIMIT);
    return { filename, file, settings: file ? JSON.parse(file.bytes.toString('utf8')) : {} };
}

export function creatorAdditionalBooks(lease, avatar) {
    return structuredClone(books(readSettings(lease).settings, avatar));
}

/** Merge only this character's links into the latest settings, retaining unrelated edits. */
export function publishCreatorBindings(lease, receipt, persist) {
    const binding = receipt.binding;
    if (!binding || binding.state === 'done') return;
    const { filename, file, settings } = readSettings(lease);
    const current = books(settings, receipt.avatar);
    if (binding.staged && isDeepStrictEqual(current, binding.after)) {
        binding.state = 'done'; persist();
        return;
    }
    if (!isDeepStrictEqual(current, binding.before)) throw conflict();
    if (!binding.staged || !isDeepStrictEqual(authoringEvidence(file), binding.staged.before)) {
        const previous = world(settings);
        const charLore = structuredClone(previous.charLore ?? []);
        const index = charLore.findIndex(item => item.name === key(receipt.avatar));
        if (!binding.after.length) {
            if (index >= 0) charLore.splice(index, 1);
        } else if (index >= 0) charLore[index].extraBooks = [...binding.after];
        else charLore.push({ name: key(receipt.avatar), extraBooks: [...binding.after] });
        const next = structuredClone(settings);
        if (next.world_info_settings) next.world_info_settings.world_info = { ...previous, charLore };
        else next.world_info = { ...previous, charLore };
        const prepared = prepareSettingsSave(next, settings);
        if (!prepared.ok) throw conflict();
        binding.staged = stageAuthoringFileLocked(lease, filename, JSON.stringify(prepared.settings, null, 4), { expected: authoringEvidence(file), limit: LIMIT });
        binding.settingsWrite = { previousVersion: getSettingsVersion(settings), previousSettingsRevision: getSettingsRevision(settings), version: prepared.version, settingsRevision: prepared.settingsRevision };
        persist();
    }
    publishAuthoringFileLocked(lease, binding.staged, { checkpoint: persist });
    invalidateParsedSettingsFile(filename);
    binding.state = 'done';
    persist();
}
