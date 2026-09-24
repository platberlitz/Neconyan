import path from 'node:path';
import { imageSize } from 'image-size';
import { readWorldInfoFile, isValidWorldInfoData } from '../endpoints/worldinfo.js';
import { readJson } from '../mewmory/store.js';
import { getCounter } from '../mewmory/tokens.js';
import { readRoleplayFile, roleplayError, roleplayHash, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked, readRoleplayEntityLocked } from './roleplay-source.js';
import { prepareWorldInfoEntries } from '../../public/scripts/world-info-scan-core.js';
import { createMacroEnvironment } from '../macros/index.js';
import { applyRegexScriptList, AGENT_REGEX_PLACEMENT } from '../../public/scripts/extensions/in-chat-agents/regex-scripts.js';
import { scanWorldInfo } from './world-info-scan.js';
import { normalizeExtensionBootId } from '../../public/scripts/extension-boot-lifecycle/index.js';

const SETTINGS = ['world_info_depth', 'world_info_min_activations', 'world_info_min_activations_depth_max',
    'world_info_budget', 'world_info_budget_cap', 'world_info_recursive', 'world_info_case_sensitive',
    'world_info_match_whole_words', 'world_info_use_group_scoring', 'world_info_character_strategy',
    'world_info_max_recursion_steps', 'world_info_include_names'];
const DEFAULTS = { world_info_depth: 2, world_info_budget: 25, world_info_recursive: true,
    world_info_case_sensitive: false, world_info_match_whole_words: false, world_info_include_names: true,
    world_info_character_strategy: 1, world_info_budget_cap: 0, world_info_min_activations: 0,
    world_info_min_activations_depth_max: 0, world_info_use_group_scoring: false, world_info_max_recursion_steps: 0 };

function savedAttachments(directories, records) {
    return records.slice(1).map((message, index) => {
        const files = message.extra?.files;
        if (files === undefined) return null;
        if (!Array.isArray(files) || files.length > 16 || !files.length) {
            throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay file attachments need a supported prompt.', 409);
        }
        const texts = files.map(file => {
            if (!file || typeof file !== 'object' || Array.isArray(file)) {
                throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay file attachment is invalid.', 409);
            }
            if (typeof file.text === 'string' && file.text) return { text: file.text };
            if (typeof file.url !== 'string' || !file.url.startsWith('/user/files/')) {
                throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay file is not in this account.', 409);
            }
            let name;
            try { name = decodeURIComponent(file.url.slice('/user/files/'.length)); } catch {
                throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay file name is invalid.', 409);
            }
            if (!name || name === '.' || name === '..' || path.basename(name) !== name || name.includes('\\')) {
                throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay file name is invalid.', 409);
            }
            const saved = readRoleplayFile(path.join(directories.files, name), 1024 * 1024);
            if (!saved) throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'A saved Roleplay file attachment is missing.', 404);
            try {
                return { text: new TextDecoder('utf-8', { fatal: true }).decode(saved.bytes),
                    rawHash: saved.rawHash, physical: saved.physical };
            } catch {
                throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A saved Roleplay file attachment is unreadable.', 409);
            }
        }).filter(item => item?.text);
        return texts.length ? { index, text: `${texts.map(item => item.text).join('\n\n')}\n\n`, files: texts } : null;
    }).filter(Boolean);
}

function savedImages(directories, records, display) {
    return records.slice(1).flatMap((message, index) => {
        const media = message.extra?.media;
        if (media === undefined) return [];
        if (!Array.isArray(media) || !media.length || media.length > 4) {
            throw roleplayError('ROLEPLAY_INVALID', 'This saved media needs a supported Roleplay prompt.', 409);
        }
        const mode = message.extra?.media_display ?? display;
        if (!['list', 'gallery'].includes(mode)) throw roleplayError('ROLEPLAY_INVALID', 'The saved media display is unsupported.', 409);
        const selected = mode === 'gallery' ? [media[message.extra?.media_index ?? 0]] : media;
        if (selected.some(item => !item || (item.type !== undefined && item.type !== 'image')
            || typeof item.url !== 'string' || !item.url.startsWith('/user/images/'))) {
            throw roleplayError('ROLEPLAY_INVALID', 'Only saved account images can enter a bound Roleplay prompt.', 409);
        }
        return selected.map(item => {
            let components;
            try { components = item.url.slice('/user/images/'.length).split('/').map(decodeURIComponent); } catch {
                throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay image path is invalid.', 409);
            }
            if (components.length < 1 || components.length > 2 || components.some(part => !part || part === '.'
                || part === '..' || part.includes('\\') || part.includes('/') || part.includes('\0'))) {
                throw roleplayError('ROLEPLAY_INVALID', 'The saved Roleplay image path is invalid.', 409);
            }
            const saved = readRoleplayFile(path.join(directories.userImages, ...components), 1024 * 1024);
            if (!saved) throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'A saved Roleplay image is missing.', 404);
            let dimensions;
            try { dimensions = imageSize(saved.bytes); } catch {
                throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A saved Roleplay image is unreadable.', 409);
            }
            const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[dimensions.type];
            if (!mime || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
                || dimensions.width < 1 || dimensions.height < 1
                || dimensions.width > 2048 || dimensions.height > 2048) {
                throw roleplayError('ROLEPLAY_INVALID', 'This saved image format is not supported in a bound prompt.', 409);
            }
            return { index, url: `data:${mime};base64,${saved.bytes.toString('base64')}`,
                width: dimensions.width, height: dimensions.height, rawHash: saved.rawHash, physical: saved.physical };
        });
    });
}

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
        const note = extensions.note ?? {};
        if (!note || typeof note !== 'object' || !Array.isArray(note.chara ?? [])) {
            throw roleplayError('ROLEPLAY_INVALID', 'Saved Author\'s Note settings are invalid.', 409);
        }
        const scoped = saved.locator.group ? saved.records[0].chat_metadata?.note_chara
            : note.chara?.find(item => item?.name === `individual:${avatar}`)
                ?? note.chara?.find(item => item?.name === path.parse(avatar).name);
        const attachments = savedAttachments(base.directories, saved.records);
        const images = savedImages(base.directories, saved.records, settings.power_user?.media_display ?? 'list');
        const chat = saved.records.slice(1).flatMap((message, index) => {
            if (message.is_system) return [];
            const text = (attachments.find(item => item.index === index)?.text ?? '') + String(message.mes ?? '');
            return [(settings.world_info_include_names ?? DEFAULTS.world_info_include_names)
                ? `${message.name}: ${text}` : text];
        }).reverse();
        const snapshot = { account: { accountId: account.accountId, dataEpoch: account.dataEpoch }, source,
            character: { instanceId: character.instanceId, revision: character.revision, rawHash: character.rawHash },
            characterExamples: character.data?.data?.mes_example ?? character.data?.mes_example ?? '',
            attachments,
            images,
            mediaDisplay: settings.power_user?.media_display ?? 'list',
            systemPrompt: (settings.power_user?.prefer_character_prompt ?? true)
                ? saved.records[0].chat_metadata?.system_prompt || character.data?.data?.system_prompt
                    || character.data?.system_prompt || '' : '',
            postHistory: { character: (settings.power_user?.prefer_character_jailbreak ?? true)
                ? character.data?.data?.post_history_instructions ?? character.data?.post_history_instructions ?? '' : '',
            textEnabled: Boolean(settings.power_user?.sysprompt?.enabled),
            text: settings.power_user?.sysprompt?.post_history ?? '' },
            storyTemplate: settings.power_user?.context?.story_string ?? '',
            storyPosition: settings.power_user?.context?.story_string_position ?? 0,
            enhancedLoreMacros: Boolean(settings.power_user?.experimental_macro_engine)
                && !extensions.disabledExtensions?.some(name => normalizeExtensionBootId(name) === 'macroenhanced'),
            reasoningInPrompt: Boolean(settings.power_user?.reasoning?.add_to_prompts),
            reasoning: settings.power_user?.reasoning?.add_to_prompts ? {
                prefix: settings.power_user.reasoning.prefix ?? '<think>',
                suffix: settings.power_user.reasoning.suffix ?? '</think>',
                separator: settings.power_user.reasoning.separator ?? '\n',
                max_additions: settings.power_user.reasoning.max_additions ?? 1,
            } : null,
            settingsHash: roleplayHash(savedSettings),
            names, settings: Object.fromEntries(SETTINGS.map(key => [key, settings[key] ?? DEFAULTS[key]])),
            bookHashes: Object.fromEntries(Object.entries(selected).map(([name, value]) => [name, value.hash])),
            characterFile: path.parse(avatar).name, avatar, maxContext, tokenizer, chat, regex,
            metadata: structuredClone(saved.records[0].chat_metadata ?? {}),
            authorNote: { prompt: saved.records[0].chat_metadata?.note_prompt ?? note.default ?? '',
                interval: saved.records[0].chat_metadata?.note_interval ?? note.defaultInterval ?? 1,
                position: saved.records[0].chat_metadata?.note_position ?? note.defaultPosition ?? 1,
                depth: saved.records[0].chat_metadata?.note_depth ?? note.defaultDepth ?? 4,
                role: saved.records[0].chat_metadata?.note_role ?? note.defaultRole ?? 0,
                scoped: scoped ? structuredClone(scoped) : null,
                userMessages: saved.records.slice(1).filter(message => message.is_user).length },
            global: {
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
export function assertRoleplayWorldInfoCurrent(base, snapshot) {
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
}

export async function prepareRoleplayWorldInfo(base, snapshot, { random = Math.random, onEntriesLoaded, onScan, macros } = {}) {
    assertRoleplayWorldInfoCurrent(base, snapshot);
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
    const outputText = [result.worldInfoBefore, result.worldInfoAfter,
        ...result.EMEntries.map(entry => entry.content), ...result.WIDepthEntries.flatMap(entry => entry.entries),
        ...result.ANBeforeEntries, ...result.ANAfterEntries, ...Object.values(result.outletEntries).flat()].join('\n');
    if (await count(outputText) > snapshot.maxContext) {
        throw roleplayError('ROLEPLAY_INVALID', 'The transformed World Info exceeds the saved context limit.', 409);
    }
    assertRoleplayWorldInfoCurrent(base, snapshot);
    return { ...result, bookHashes: snapshot.bookHashes,
        boundLore: [...new Set([...snapshot.names.chat, ...snapshot.names.character, ...snapshot.names.global])]
            .flatMap(name => Object.values(selected[name].data.entries).filter(entry => !entry.disable).map(entry => ({
                book: name,
                title: String(entry.comment ?? '').trim() || String(Array.isArray(entry.key) && entry.key[0] || entry.uid),
                content: String(entry.content ?? ''),
                entry,
            }))),
        activeLore: result.activated.map(({ title, content }) => ({ title, content })),
        timedBaseline: roleplayHash(snapshot.metadata.timedWorldInfo ?? {}) };
}
