import path from 'node:path';
import fs from 'node:fs';
import { parseChatJsonl } from '../chat-recovery.js';
import { readRoleplayFile, roleplayLease, withRoleplayAccount } from '../roleplay-store.js';
import { normaliseRoleplayLocator, roleplayChatPath, roleplayEntityContent } from '../generation/roleplay-source.js';
import { captureGenerationBinding, resolveGenerationProfile } from '../generation/profiles.js';
import { validateActiveGenerationContext } from '../generation/service.js';
import { createMacroEnvironment } from '../macros/index.js';
import { selectSavedRoleplayPersona } from '../generation/world-info.js';
import { labError } from './store.js';

/** Saved chats are read with the same ceiling as replies, so long chats open in Labs too. */
export const LAB_CHAT_LIMIT = 64 * 1024 * 1024;

export function readLabSettings(base) {
    const file = readRoleplayFile(path.join(base.directories.root, 'settings.json'), 16 * 1024 * 1024);
    if (!file) throw labError('Save the account settings before running a Lab.');
    try { return JSON.parse(file.bytes.toString('utf8')); } catch { throw labError('The saved account settings are unreadable.'); }
}

export function captureLabChat(base, account, locator) {
    const selected = normaliseRoleplayLocator(locator);
    return withRoleplayAccount(base, account, lease => {
        const { scope } = roleplayLease(lease);
        const file = readRoleplayFile(roleplayChatPath(scope, selected), LAB_CHAT_LIMIT, { allowMissingParent: true });
        if (!file) throw labError('The selected saved chat no longer exists.');
        const parsed = parseChatJsonl(file.bytes);
        if (parsed.status !== 'ok') throw labError('The selected saved chat is damaged.');
        let character = {}, groupId = null;
        if (selected.group) {
            const owners = [];
            for (const name of fs.readdirSync(scope.directories.groups).filter(name => name.endsWith('.json'))) {
                const groupFile = readRoleplayFile(path.join(scope.directories.groups, name), 8 * 1024 * 1024);
                const group = roleplayEntityContent('group', name.slice(0, -5), groupFile.bytes).data;
                if ((group.chats ?? []).map(String).includes(selected.chat)) owners.push(String(group.id));
            }
            if (owners.length !== 1) throw labError(owners.length ? 'More than one group owns this saved chat.' : 'The saved chat has no owning group.');
            [groupId] = owners;
        }
        if (!selected.group) {
            const card = readRoleplayFile(path.join(base.directories.characters, selected.avatar), 16 * 1024 * 1024);
            if (!card) throw labError('The chat character no longer exists.');
            const data = roleplayEntityContent('character', selected.avatar, card.bytes).data;
            character = data.data ?? data;
        }
        const settings = readLabSettings(base);
        const persona = selectSavedRoleplayPersona(settings, { locator: selected, records: parsed.records },
            { groupId }, selected.avatar, base.directories);
        const name = persona.name || settings.name1 || parsed.records[0].user_name || 'User';
        return { locator: selected, records: parsed.records, rawHash: file.rawHash, physical: file.physical, persona: { ...persona, name },
            macros: { names: { user: name, char: character.name || parsed.records[0].character_name || 'Character' },
                character: { ...character, persona: persona?.description || '' },
                variables: { global: settings.extension_settings?.variables?.global || {}, local: parsed.records[0].chat_metadata?.variables || {} },
                extra: { chat: parsed.records.slice(1), chatMetadata: parsed.records[0].chat_metadata || {} } } };
    });
}

export async function captureLabConnection(base, { profileId = '', acknowledgement, maxTokens }, macros) {
    const binding = captureGenerationBinding(base.directories, profileId ? { kind: 'profile', profileId } : { kind: 'active' }, acknowledgement);
    const material = resolveGenerationProfile(base.directories, binding);
    await validateActiveGenerationContext(material, createMacroEnvironment(macros), [], {}, { maxTokens });
    return { binding, contextLimit: Number(material.contextLimit || material.preset?.openai_max_context
        || material.active?.openai_max_context || readLabSettings(base).max_context || 4096) };
}
