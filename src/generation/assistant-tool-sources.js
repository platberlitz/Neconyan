import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { isNeconyanAssistant } from '../../public/scripts/neconyan-assistant-knowledge.js';
import { getExistingWorldInfoFilename, isValidWorldInfoData } from '../endpoints/worldinfo.js';
import { getPresetSettingsByAPI } from '../endpoints/presets.js';
import { agentCollectionDirectory, readAgentCollection, readAgentRecordLocked } from '../in-chat-agent-storage.js';
import { authoringEvidence, readAuthoringFileLocked } from '../authoring-store.js';
import { readRoleplayFile, roleplayError, roleplayHash, roleplayLease, validRoleplayAvatar } from '../roleplay-store.js';
import { assertQuickImageGenConfigured, readQuickImageGenSettings } from './quick-image-gen.js';
import { captureQuickImageReferenceSources } from './quick-image-gen-reference.js';
import { quickImageGenSettingsFingerprint } from './quick-image-gen-job.js';
import { assertRoleplaySourceLocked, readRoleplayEntityLocked } from './roleplay-source.js';
import { EDITABLE_AGENT_FIELDS, EDITABLE_CHARACTER_FIELDS, PRESET_FIELDS, assistantToolName,
    projectAssistantAgent, projectAssistantCharacter, projectAssistantPreset, validateAssistantPresetValue } from './assistant-tool-data.js';

const invalid = message => roleplayError('ASSISTANT_TOOL_INVALID', message, 409);
const MAX_RESULT = 128 * 1024;
const requireText = (value, name, nonempty = true) => {
    if (typeof value !== 'string' || nonempty && !value.trim()) throw invalid(`The ${name} must be a string${nonempty ? ' with content' : ''}.`);
    return value;
};
const relative = (dirs, filename) => path.relative(dirs.root, filename);
const toResult = result => {
    const value = { status: 'success', ...result };
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESULT) throw invalid('The complete assistant tool result exceeds its reserved capacity.');
    return value;
};

function readSettings(lease) {
    const { scope } = roleplayLease(lease);
    const file = readRoleplayFile(path.join(scope.directories.root, 'settings.json'), 8 * 1024 * 1024);
    let settings;
    try { settings = JSON.parse(file.bytes.toString('utf8')); } catch { throw invalid('The saved account settings are unavailable.'); }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalid('The saved account settings are invalid.');
    return { settings, evidence: authoringEvidence(file), hash: roleplayHash(settings) };
}

export function readBoundAssistantContextLocked(lease, source, avatar) {
    if (source.locator.group || !source.dependencies?.some(item => item.kind === 'character' && item.locator.avatar === avatar)) {
        throw invalid('The assistant tool call belongs to an individual assistant chat only.');
    }
    assertRoleplaySourceLocked(lease, source);
    const assistant = characterResource(lease, avatar);
    if (!isNeconyanAssistant(assistant.saved.data)) throw invalid('The selected character is not a Neconyan assistant.');
    const { settings, evidence: settingsEvidence, hash: settingsHash } = readSettings(lease);
    return { assistant: assistant.resource, assistantId: assistant.saved.data?.data?.extensions?.neconyan_assistant?.id
        ?? assistant.saved.data?.extensions?.neconyan_assistant?.id, settings, settingsHash, settingsEvidence };
}

function lorebooks(lease) {
    const { scope } = roleplayLease(lease), folder = scope.directories.worlds;
    if (!folder) throw invalid('The account has no saved lorebook directory.');
    readAuthoringFileLocked(lease, path.join(folder, '.assistant-directory-check'));
    if (!fs.existsSync(folder)) return [];
    const files = fs.readdirSync(folder, { withFileTypes: true }).filter(item => item.isFile() && item.name.endsWith('.json'));
    if (files.length > 512) throw invalid('The saved lorebook list exceeds its result limit.');
    return files.sort((a, b) => a.name.localeCompare(b.name)).map(item => {
        const file = readAuthoringFileLocked(lease, path.join(folder, item.name), 8 * 1024 * 1024);
        if (!file) throw invalid('A saved lorebook changed during selection.');
        let book;
        try { book = JSON.parse(file.bytes.toString('utf8')); } catch { throw invalid('The saved lorebook is unreadable.'); }
        if (!isValidWorldInfoData(book)) throw invalid('The saved lorebook is invalid.');
        return { name: item.name.slice(0, -5), filename: item.name, book, file };
    });
}

function bookResource(lease, name) {
    const { scope } = roleplayLease(lease), dirs = scope.directories;
    requireText(name, 'lorebook name');
    const filename = getExistingWorldInfoFilename(dirs, name);
    if (!filename) throw invalid('The named lorebook is not available.');
    const full = path.join(dirs.worlds, filename);
    const file = readAuthoringFileLocked(lease, full, 8 * 1024 * 1024);
    let book;
    try { book = JSON.parse(file.bytes.toString('utf8')); } catch { throw invalid('The saved lorebook is unreadable.'); }
    if (!isValidWorldInfoData(book)) throw invalid('The saved lorebook is invalid.');
    return { filename, full, file, book, resource: { kind: 'lorebook', id: filename, relative: relative(dirs, full),
        evidence: authoringEvidence(file), hash: roleplayHash(book) } };
}

function entryResource(book, uid) {
    const id = typeof uid === 'number' && Number.isSafeInteger(uid) && uid >= 0 ? uid
        : typeof uid === 'string' && /^\d+$/.test(uid.trim()) ? Number(uid.trim()) : -1;
    if (!Number.isSafeInteger(id) || id < 0) throw invalid('The entry UID is invalid.');
    const entry = Object.values(book.entries).find(item => item?.uid === id);
    if (!entry || entry.agentBlacklisted) throw invalid('The named lorebook entry is unavailable.');
    return { uid: id, entry, projected: { uid: id, title: String(entry.comment ?? ''), label: String(entry.comment || entry.key?.[0] || ''),
        content: String(entry.content ?? ''), disabled: Boolean(entry.disable) } };
}

function agentResource(lease, id) {
    const { scope } = roleplayLease(lease), dirs = scope.directories;
    requireText(id, 'Agent ID');
    const current = readAgentRecordLocked(lease, 'agent', id);
    if (!current) throw invalid('The named Agent is unavailable.');
    const full = path.join(agentCollectionDirectory(dirs), `${id}.json`);
    return { current, resource: { kind: 'agent', id, relative: relative(dirs, full),
        evidence: current.file, revision: current.revision } };
}

function presetResource(lease, api, name) {
    const { scope } = roleplayLease(lease), dirs = scope.directories;
    if (!Object.hasOwn(PRESET_FIELDS, api)) throw invalid('The preset API is unsupported.');
    requireText(name, 'preset name');
    if (sanitize(name) !== name || name === '.' || name === '..') throw invalid('The exact preset name is invalid.');
    const folder = getPresetSettingsByAPI(api, dirs).folder;
    if (!folder) throw invalid('The selected preset directory is unavailable.');
    const full = path.join(folder, `${name}.json`);
    const file = readAuthoringFileLocked(lease, full, 8 * 1024 * 1024);
    if (!file) throw invalid('The named saved preset is unavailable.');
    let data;
    try { data = JSON.parse(file.bytes.toString('utf8')); } catch { throw invalid('The named saved preset is unreadable.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('The named preset is invalid.');
    return { data, resource: { kind: 'preset', id: relative(dirs, full), relative: relative(dirs, full),
        evidence: authoringEvidence(file), hash: roleplayHash(data) } };
}

function characterResource(lease, avatar) {
    requireText(avatar, 'character avatar');
    const { scope } = roleplayLease(lease);
    const saved = readRoleplayEntityLocked(lease, 'character', avatar);
    if (saved.changed) throw invalid('The selected character needs its protected identity saved before admission.');
    const file = readRoleplayFile(path.join(scope.directories.characters, avatar), 64 * 1024 * 1024);
    if (!file || roleplayHash(file.physical) !== roleplayHash(saved.physical)) throw invalid('The selected character file changed.');
    return { saved, resource: { kind: 'character', id: avatar,
        relative: relative(scope.directories, path.join(scope.directories.characters, avatar)),
        contentHash: saved.contentHash, rawHash: file.rawHash, physical: saved.physical } };
}

function validateAgentEdit(input, current, settings) {
    const field = requireText(input.field, 'Agent field');
    if (!EDITABLE_AGENT_FIELDS.includes(field)) throw invalid('The Agent field cannot be edited.');
    const value = input.value;
    if (['name', 'description', 'prompt', 'modelOverride'].includes(field)) {
        if (typeof value !== 'string' || field === 'name' && !value.trim()) throw invalid('This Agent field requires a string.');
    } else if (field === 'favorite' && typeof value !== 'boolean') throw invalid('The favourite field requires a boolean.');
    else if (field === 'tags') {
        if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string' || !tag.trim())
            || new Set(value.map(tag => tag.trim())).size !== value.length) throw invalid('Agent tags must be unique non-empty strings.');
    } else if (field === 'connectionProfile') {
        if (typeof value !== 'string' || value.trim() && !settings.extension_settings?.connectionManager?.profiles?.some(item => item.id === value.trim())) {
            throw invalid('The selected connection profile is not saved.');
        }
    }
    const next = field === 'tags' ? value.map(tag => tag.trim()) : field === 'connectionProfile' ? value.trim() : value;
    return { field, before: projectAssistantAgent(current)[field], after: next };
}

/** Resolve an assistant tool against the protected saved assistant card and selected account records. */
export function captureAssistantToolSourceLocked(lease, source, { avatar, name, args = {}, callId } = {}) {
    const { scope } = roleplayLease(lease), dirs = scope.directories;
    const tool = assistantToolName(name);
    if (!tool || !args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 1024 * 1024
        || typeof callId !== 'string' || !callId || callId.length > 256) throw invalid('The assistant tool call is incomplete.');
    const { assistant, assistantId, settings, settingsEvidence, settingsHash } = readBoundAssistantContextLocked(lease, source, avatar);
    const result = { tool, name, callId, avatar, assistant, assistantId, settingsHash, settingsEvidence,
        args: structuredClone(args), mutating: tool.startsWith('edit-') || tool === 'create-character' };
    let resource = null, response = null, change = null;
    if (tool === 'lorebooks') response = toResult({ books: lorebooks(lease).map(item => ({ name: item.name })) });
    else if (tool === 'lorebook-entries' || tool === 'lorebook-entry' || tool === 'edit-lorebook-entry') {
        const bookName = requireText(args.book, 'lorebook name');
        const selected = bookResource(lease, bookName);
        resource = selected.resource;
        if (tool === 'lorebook-entries') response = toResult({ book: bookName,
            entries: Object.values(selected.book.entries).filter(item => !item.agentBlacklisted)
                .map(item => {
                    const entry = entryResource(selected.book, item.uid).projected;
                    return { uid: entry.uid, title: entry.title, label: entry.label, disabled: entry.disabled };
                }) });
        else {
            const entry = entryResource(selected.book, args.uid);
            if (tool === 'lorebook-entry') response = toResult({ book: bookName, entry: entry.projected });
            else {
                const field = requireText(args.field, 'lorebook field');
                if (!['title', 'content'].includes(field)) throw invalid('Only an entry title or content may be edited.');
                const value = requireText(args.value, 'lorebook replacement', false);
                if (Object.hasOwn(args, 'expected') && (!args.expected || typeof args.expected !== 'object' || Array.isArray(args.expected)
                    || typeof args.expected.title !== 'string' || typeof args.expected.content !== 'string'
                    || args.expected.title !== entry.projected.title || args.expected.content !== entry.projected.content)) {
                    throw invalid('The exact supplied lorebook entry snapshot is stale.');
                }
                change = { book: bookName, uid: entry.uid, field, before: entry.projected[field], after: value,
                    entryHash: roleplayHash(entry.entry), expected: { title: entry.projected.title, content: entry.projected.content } };
            }
        }
    } else if (tool === 'agents') {
        const library = readAgentCollection(agentCollectionDirectory(dirs));
        if (library.errors.length) throw invalid('The saved Agent library needs recovery.');
        response = toResult({ agents: library.records.map(agent => ({ id: agent.id, name: String(agent.name ?? '') })) });
    } else if (tool === 'agent' || tool === 'edit-agent') {
        const selected = agentResource(lease, args.id);
        resource = selected.resource;
        if (tool === 'agent') response = toResult({ agent: projectAssistantAgent(selected.current.record) });
        else change = validateAgentEdit(args, selected.current.record, settings);
    } else if (tool === 'presets') {
        const apiId = requireText(args.apiId, 'preset API');
        if (!Object.hasOwn(PRESET_FIELDS, apiId)) throw invalid('The selected preset API is not supported.');
        const folder = getPresetSettingsByAPI(apiId, dirs).folder;
        if (!folder) throw invalid('The selected preset directory is unavailable.');
        readAuthoringFileLocked(lease, path.join(folder, '.assistant-directory-check'));
        const presets = fs.existsSync(folder) ? fs.readdirSync(folder, { withFileTypes: true })
            .filter(item => item.isFile() && item.name.endsWith('.json')).map(item => ({ name: item.name.slice(0, -5) })) : [];
        response = toResult({ apiId, presets });
    } else if (tool === 'preset' || tool === 'edit-preset') {
        const apiId = requireText(args.apiId, 'preset API'), presetName = requireText(args.name, 'preset name');
        const selected = presetResource(lease, apiId, presetName);
        resource = selected.resource;
        if (tool === 'preset') response = toResult({ apiId, name: presetName, preset: projectAssistantPreset(apiId, selected.data) });
        else {
            const field = requireText(args.field, 'preset field');
            if (!Object.hasOwn(selected.data, field)) throw invalid('The named preset field is not present.');
            const value = validateAssistantPresetValue(apiId, field, args.value, selected.data[field]);
            change = { apiId, name: presetName, field, before: structuredClone(selected.data[field]), after: value };
        }
    } else if (tool === 'characters') {
        const folder = dirs.characters;
        readAuthoringFileLocked(lease, path.join(folder, '.assistant-directory-check'));
        const avatars = fs.readdirSync(folder).filter(item => item.endsWith('.png'));
        if (avatars.length > 512) throw invalid('The complete character list exceeds its limit.');
        response = toResult({ characters: avatars.map(id => {
            const saved = characterResource(lease, id);
            return { avatar: id, name: String(saved.saved.data?.data?.name ?? saved.saved.data?.name ?? '') };
        }) });
    } else if (tool === 'character' || tool === 'edit-character') {
        const selected = characterResource(lease, args.avatar);
        resource = selected.resource;
        const projected = projectAssistantCharacter(selected.saved.data, args.avatar);
        if (tool === 'character') response = toResult({ character: projected });
        else {
            const field = requireText(args.field, 'character field');
            if (!EDITABLE_CHARACTER_FIELDS.includes(field) || !Object.hasOwn(projected, field)) throw invalid('This character field cannot be edited.');
            const value = requireText(args.value, 'character replacement', false);
            if (field === 'name' && !value.trim()) throw invalid('A character name cannot be empty.');
            change = { avatar: args.avatar, field, before: projected[field], after: field === 'name' ? value.trim() : value };
        }
    } else if (tool === 'create-character') {
        if (!args.character || typeof args.character !== 'object' || Array.isArray(args.character)
            || typeof args.character.name !== 'string' || !args.character.name.trim() || args.character.name.length > 200
            || /[\\/\x00-\x1f]/.test(args.character.name) || /^\.+$/.test(args.character.name)
            || Object.entries(args.character).some(([key, value]) => !EDITABLE_CHARACTER_FIELDS.includes(key)
                || typeof value !== 'string' || value.length > 100000)
            || args.characterNote !== undefined && (typeof args.characterNote !== 'string' || args.characterNote.length > 100000)
            || args.avatarPrompt !== undefined && (typeof args.avatarPrompt !== 'string' || args.avatarPrompt.length > 10000)
            || args.alternateGreetings !== undefined && (!Array.isArray(args.alternateGreetings) || args.alternateGreetings.length > 20
                || args.alternateGreetings.some(item => typeof item !== 'string' || item.length > 100000))) {
            throw invalid('The proposed character exceeds its accepted fields or limits.');
        }
        change = { character: { ...args.character, name: args.character.name.trim() }, characterNote: args.characterNote ?? '',
            alternateGreetings: args.alternateGreetings ?? [], avatarPrompt: args.avatarPrompt?.trim() ?? '' };
        const name = sanitize(change.character.name);
        if (!name || name === '.' || name === '..') throw invalid('The character name cannot be used for a saved avatar.');
        const baseName = Buffer.byteLength(`${name}10000.png`) <= 255 ? name : `character-${roleplayHash(name).slice(0, 24)}`;
        let suffix = 0;
        let filename;
        do {
            filename = `${baseName}${suffix || ''}.png`;
            suffix++;
            if (suffix > 10000) throw invalid('The character avatar directory has no available name.');
        } while (readRoleplayFile(path.join(dirs.characters, filename), 64 * 1024 * 1024, { allowMissingParent: true }));
        if (!validRoleplayAvatar(filename)) throw invalid('The selected character filename cannot be protected.');
        resource = { kind: 'character', id: filename, relative: relative(dirs, path.join(dirs.characters, filename)), contentHash: null, physical: null };
        if (change.avatarPrompt) {
            const imageSettings = readQuickImageGenSettings(dirs);
            assertQuickImageGenConfigured(imageSettings);
            change.imageSettingsFingerprint = quickImageGenSettingsFingerprint(imageSettings);
            change.imageReferences = captureQuickImageReferenceSources(dirs, imageSettings);
        }
    }
    if (!resource && !response && !change) throw invalid('The assistant tool is unsupported.');
    if (result.mutating && args.userConfirmed !== true) return { ...result, resource, change,
        response: toResult({ status: 'needs_confirmation', reason: 'Ask the user in chat, then request this exact change after their next message confirms.' }),
        target: { kind: 'assistant-read', id: source.instanceId } };
    return { ...result, resource, ...(change ? { change } : {}), ...(response ? { response } : {}),
        target: result.mutating ? { kind: resource.kind, id: resource.id } : { kind: 'assistant-read', id: source.instanceId } };
}
