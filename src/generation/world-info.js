import path from 'node:path';
import { readWorldInfoFile, isValidWorldInfoData } from '../endpoints/worldinfo.js';
import { readJson } from '../mewmory/store.js';
import { getCounter } from '../mewmory/tokens.js';
import { roleplayError, roleplayHash, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked, readRoleplayEntityLocked } from './roleplay-source.js';
import { prepareWorldInfoEntries } from '../../public/scripts/world-info-scan-core.js';
import { createMacroEnvironment } from '../macros/index.js';
import { applyRegexScriptList, AGENT_REGEX_PLACEMENT } from '../../public/scripts/extensions/in-chat-agents/regex-scripts.js';
import { scanWorldInfo } from './world-info-scan.js';

const SETTINGS = ['world_info_depth', 'world_info_min_activations', 'world_info_min_activations_depth_max',
    'world_info_budget', 'world_info_budget_cap', 'world_info_recursive', 'world_info_case_sensitive',
    'world_info_match_whole_words', 'world_info_use_group_scoring', 'world_info_character_strategy',
    'world_info_max_recursion_steps', 'world_info_include_names'];
const DEFAULTS = { world_info_depth: 2, world_info_budget: 25, world_info_recursive: true,
    world_info_case_sensitive: false, world_info_match_whole_words: false, world_info_include_names: true,
    world_info_character_strategy: 1, world_info_budget_cap: 0, world_info_min_activations: 0,
    world_info_min_activations_depth_max: 0, world_info_use_group_scoring: false, world_info_max_recursion_steps: 0 };

function books(directories, names) {
    const result = Object.create(null);
    for (const name of new Set(names.flat())) {
        if (typeof name !== 'string' || !name || name.length > 234) throw roleplayError('ROLEPLAY_INVALID', 'Invalid World Info book name.', 400);
        let book;
        try { book = readWorldInfoFile(directories, name, false); } catch {
            throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', `A saved World Info book is unreadable: ${name}.`, 409);
        }
        if (!isValidWorldInfoData(book)) throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A saved World Info book is missing or damaged.', 409);
        result[name] = { data: book, hash: roleplayHash(book) };
    }
    return result;
}

function selectedBooks(settings, saved, character, avatar) {
    const global = settings.world_info?.globalSelect ?? [];
    const charLore = settings.world_info?.charLore ?? [];
    if (!Array.isArray(global) || !Array.isArray(charLore)) {
        throw roleplayError('ROLEPLAY_INVALID', 'Invalid saved World Info selection.', 400);
    }
    const chat = saved.records[0].chat_metadata?.world_info || '';
    const persona = settings.power_user?.persona_description_lorebook || '';
    const file = path.parse(avatar).name;
    const extraBooks = charLore.find(item => item?.name === file)?.extraBooks ?? [];
    if (!Array.isArray(extraBooks)) throw roleplayError('ROLEPLAY_INVALID', 'Invalid character World Info selection.', 400);
    const characterBooks = [character.data?.data?.extensions?.world ?? character.data?.extensions?.world,
        ...extraBooks].filter(Boolean);
    return { global, chat: chat && !global.includes(chat) ? [chat] : [],
        persona: persona && persona !== chat && !global.includes(persona) ? [persona] : [],
        character: [...new Set(characterBooks)].filter(name => name !== chat && name !== persona && !global.includes(name)) };
}

/** Capture the actual saved book selection before private job admission. */
export function captureRoleplayWorldInfo(base, account, source, { avatar, maxContext, tokenizer = 'o200k_base', trigger = 'normal' }) {
    if (!['normal', 'continue', 'swipe', 'regenerate'].includes(trigger)) {
        throw roleplayError('ROLEPLAY_INVALID', 'The World Info generation trigger is invalid.', 400);
    }
    return withRoleplayAccount(base, account, lease => {
        const saved = assertRoleplaySourceLocked(lease, source);
        if (!source.dependencies?.some(dependency => dependency.kind === 'character' && dependency.locator.avatar === avatar)) {
            throw roleplayError('ROLEPLAY_INVALID', 'World Info must use a character in the accepted Roleplay source.', 409);
        }
        const character = readRoleplayEntityLocked(lease, 'character', avatar);
        if (character.changed) saveRoleplayAccount(lease);
        const file = path.join(base.directories.root, 'settings.json');
        const savedSettings = readJson(file, {});
        const settings = { ...savedSettings, ...savedSettings.world_info_settings };
        settings.power_user = savedSettings.power_user;
        const names = selectedBooks(settings, saved, character, avatar);
        const selected = books(base.directories, Object.values(names));
        const characterTags = savedSettings.tag_map?.[avatar] ?? [];
        if (!Array.isArray(characterTags)) throw roleplayError('ROLEPLAY_INVALID', 'The saved character tags are invalid.', 400);
        const extensions = savedSettings.extension_settings ?? {};
        if (!Array.isArray(extensions.regex ?? []) || !Array.isArray(extensions.character_allowed_regex ?? [])) {
            throw roleplayError('ROLEPLAY_INVALID', 'Saved World Info transformations are invalid.', 409);
        }
        const scopedRegex = extensions.character_allowed_regex?.includes(avatar)
            ? character.data?.data?.extensions?.regex_scripts ?? character.data?.extensions?.regex_scripts ?? [] : [];
        if (!Array.isArray(scopedRegex)) throw roleplayError('ROLEPLAY_INVALID', 'Saved World Info transformations are invalid.', 409);
        const regex = extensions.disabledExtensions?.includes('regex') ? [] : [
            ...(extensions.regex ?? []), ...scopedRegex,
        ];
        const chat = saved.records.slice(1).map(message => (settings.world_info_include_names ?? DEFAULTS.world_info_include_names)
            ? `${message.name}: ${message.mes}` : String(message.mes ?? '')).reverse();
        const snapshot = { account: { accountId: account.accountId, dataEpoch: account.dataEpoch }, source,
            character: { instanceId: character.instanceId, revision: character.revision, rawHash: character.rawHash },
            settingsHash: roleplayHash(savedSettings),
            names, settings: Object.fromEntries(SETTINGS.map(key => [key, settings[key] ?? DEFAULTS[key]])),
            bookHashes: Object.fromEntries(Object.entries(selected).map(([name, value]) => [name, value.hash])),
            characterFile: path.parse(avatar).name, avatar, maxContext, tokenizer, chat, regex,
            metadata: structuredClone(saved.records[0].chat_metadata ?? {}), global: {
                trigger, characterDescription: character.data?.data?.description ?? character.data?.description ?? '',
                characterPersonality: character.data?.data?.personality ?? character.data?.personality ?? '',
                personaDescription: settings.power_user?.persona_description ?? '',
                characterDepthPrompt: character.data?.data?.extensions?.depth_prompt?.prompt
                    ?? character.data?.extensions?.depth_prompt?.prompt ?? '',
                creatorNotes: character.data?.data?.creator_notes ?? character.data?.creator_notes ?? '',
                scenario: character.data?.data?.scenario ?? character.data?.scenario ?? '',
                characterTags,
            } };
        if (!Number.isSafeInteger(maxContext) || maxContext < 1 || Buffer.byteLength(JSON.stringify(snapshot)) > 2 * 1024 * 1024) {
            throw roleplayError('ROLEPLAY_INVALID', 'World Info input is too large or lacks a context limit.', 400);
        }
        roleplayHash(snapshot);
        return snapshot;
    });
}

/** Verify named books, scan them with local token counts, and return an immutable result for a job artifact. */
export async function prepareRoleplayWorldInfo(base, snapshot, { random = Math.random, onEntriesLoaded, onScan, macros } = {}) {
    if (!snapshot?.account || !snapshot.source || !snapshot.character || !snapshot.names || !snapshot.bookHashes) {
        throw roleplayError('ROLEPLAY_INVALID', 'A bound World Info selection is required.', 400);
    }
    const captured = captureRoleplayWorldInfo(base, snapshot.account, snapshot.source, {
        avatar: snapshot.avatar, maxContext: snapshot.maxContext, tokenizer: snapshot.tokenizer,
        trigger: snapshot.global?.trigger,
    });
    if (roleplayHash(captured) !== roleplayHash(snapshot)) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved World Info selection differs from the account sources.');
    }
    const selected = withRoleplayAccount(base, snapshot.account, lease => {
        assertRoleplaySourceLocked(lease, snapshot.source);
        const character = readRoleplayEntityLocked(lease, 'character', snapshot.avatar);
        if (character.instanceId !== snapshot.character.instanceId || character.revision !== snapshot.character.revision
            || character.rawHash !== snapshot.character.rawHash) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The World Info character changed after admission.');
        }
        if (character.changed) saveRoleplayAccount(lease);
        if (roleplayHash(readJson(path.join(base.directories.root, 'settings.json'), {})) !== snapshot.settingsHash) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved World Info settings changed after admission.');
        }
        const current = books(base.directories, Object.values(snapshot.names));
        for (const [name, hash] of Object.entries(snapshot.bookHashes)) {
            if (current[name]?.hash !== hash) throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'A World Info book changed after admission.');
        }
        if (Object.keys(current).length !== Object.keys(snapshot.bookHashes).length) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The World Info selection changed after admission.');
        }
        return current;
    });
    const lore = Object.fromEntries(['global', 'character', 'chat', 'persona'].map(type => [type + 'Lore',
        (snapshot.names[type] ?? []).flatMap(name => Object.entries(selected[name].data.entries).map(([key, entry]) => {
            const { uid = Number.isNaN(Number(key)) ? key : Number(key), ...rest } = entry;
            return { uid, world: name, ...rest };
        }))]));
    const loadedHash = roleplayHash(lore);
    await onEntriesLoaded?.(lore);
    if (roleplayHash(lore) !== loadedHash) {
        throw roleplayError('ROLEPLAY_INVALID', 'A World Info loading hook changed the saved book selection.', 409);
    }
    const entries = prepareWorldInfoEntries(lore, Number(snapshot.settings.world_info_character_strategy ?? 1));
    const { count } = await getCounter(snapshot.tokenizer);
    const environment = createMacroEnvironment(macros || {}, {}, { readOnly: true });
    const substitute = value => environment.evaluate(value, { strictCapabilities: true });
    if (!Array.isArray(snapshot.regex)) throw roleplayError('ROLEPLAY_INVALID', 'Saved World Info transformations are invalid.', 409);
    for (const script of snapshot.regex) {
        if (!script || !Array.isArray(script.placement)) {
            throw roleplayError('ROLEPLAY_INVALID', 'Saved World Info transformations are invalid.', 409);
        }
        if (!script.placement.includes(AGENT_REGEX_PLACEMENT.WORLD_INFO) || script.disabled
            || script.markdownOnly || !script.promptOnly) continue;
        if (script.trimStrings !== undefined && !Array.isArray(script.trimStrings)) {
            throw roleplayError('ROLEPLAY_INVALID', 'Saved World Info transformations are invalid.', 409);
        }
        if (Number(script.substituteRegex) || [script.findRegex, script.replaceString, ...(script.trimStrings ?? [])]
            .some(value => typeof value !== 'string' || value.includes('{{') || /<(?:USER|BOT|CHAR|GROUP)>/i.test(value))) {
            throw roleplayError('ROLEPLAY_INVALID', 'This World Info transformation needs browser-only macros.', 409);
        }
    }
    const transform = (content, entry) => applyRegexScriptList(content, snapshot.regex, AGENT_REGEX_PLACEMENT.WORLD_INFO,
        { isPrompt: true, depth: entry.position === 4 ? entry.depth ?? 4 : undefined });
    const result = await scanWorldInfo({ entries, chat: snapshot.chat, metadata: snapshot.metadata,
        settings: snapshot.settings, global: { ...snapshot.global, characterFile: snapshot.characterFile },
        maxContext: snapshot.maxContext, countTokens: count, substitute, random, onScan, transform });
    return { ...result, bookHashes: snapshot.bookHashes,
        timedBaseline: roleplayHash(snapshot.metadata.timedWorldInfo ?? {}) };
}
