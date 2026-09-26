import path from 'node:path';
import { imageSize } from 'image-size';
import { getExistingWorldInfoFilename, isValidWorldInfoData } from '../endpoints/worldinfo.js';
import { readJson } from '../mewmory/store.js';
import { getCounter } from '../mewmory/tokens.js';
import { readRoleplayFile, roleplayError, roleplayHash, roleplaySettingsHash, saveRoleplayAccount, withRoleplayAccount } from '../roleplay-store.js';
import { assertRoleplaySourceLocked, readRoleplayEntityLocked } from './roleplay-source.js';
import { prepareWorldInfoEntries } from '../../public/scripts/world-info-scan-core.js';
import { createMacroEnvironment } from '../macros/index.js';
import { applyRegexScriptList, AGENT_REGEX_PLACEMENT } from '../../public/scripts/extensions/in-chat-agents/regex-scripts.js';
import { scanWorldInfo } from './world-info-scan.js';
import { normalizeExtensionBootId } from '../../public/scripts/extension-boot-lifecycle/index.js';
import { captureWorldInfoHookPolicy, worldInfoActivationActions } from './world-info-hook-policy.js';
import { capturePathfinderSource } from './world-info-pathfinder.js';
import { captureIncomingRoleplayTranslation, captureRoleplayInputTranslation } from './roleplay-translation.js';
import { captureRoleplayCaptions } from './roleplay-captions.js';
import { captureSpeechPolicy } from './speech-config.js';
import { agentHistorySources, captureRoleplayAgents, readRoleplayAgentsLocked } from './roleplay-agents-source.js';
import { captureCompanionCapacity } from './companion-capacity.js';
import { captureRoleplayToolBindings } from './roleplay-tool-bindings.js';
import { activeRoleplayAuthorNote, isWorldInfoAuthorNoteActive, selectRoleplayPromptRecords, savedRoleplayMacroSnapshot } from './roleplay-prompt.js';

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

export function captureSavedRoleplayImages(directories, records, display, caption = {}) {
    return records.slice(1).flatMap((message, index) => {
        const media = message.extra?.media;
        if (media === undefined) return [];
        if (!Array.isArray(media) || !media.length || media.length > 4) {
            throw roleplayError('ROLEPLAY_INVALID', 'This saved media needs a supported Roleplay prompt.', 409);
        }
        const mode = message.extra?.media_display ?? display;
        if (!['list', 'gallery'].includes(mode)) throw roleplayError('ROLEPLAY_INVALID', 'The saved media display is unsupported.', 409);
        const selected = mode === 'gallery' ? [media[message.extra?.media_index ?? 0]] : media;
        if (selected.some(item => !item || (item.type !== undefined && !['image', 'video'].includes(item.type))
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
            const filename = path.join(directories.userImages ?? path.join(directories.root, 'user/images'), ...components);
            const video = item.type === 'video';
            const saved = readRoleplayFile(filename, (video ? 25 : 1) * 1024 * 1024);
            if (!saved) throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'A saved Roleplay image is missing.', 404);
            const captioned = item.captioned === true && typeof item.title === 'string' && item.title.trim()
                && (item.append_title === true || String(message.mes ?? '').includes(item.title));
            if (video) {
                if (!captioned && (caption.source !== 'multimodal' || !['google', 'vertexai', 'zai'].includes(caption.multimodal_api))) {
                    throw roleplayError('ROLEPLAY_INVALID', 'This saved video needs a compatible caption connection.', 409);
                }
                const mimeType = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.ogv': 'video/ogg' }[path.extname(filename).toLowerCase()];
                if (!mimeType || saved.bytes.length < 12) throw roleplayError('ROLEPLAY_INVALID', 'The saved video format is unsupported.', 409);
                const file = path.relative(directories.root, filename).split(path.sep).join('/');
                if (file.split('/').some(part => !part || part === '..' || part === '.')) throw roleplayError('ROLEPLAY_INVALID', 'The saved video is outside this account.', 409);
                return { index, file, url: item.url, mimeType, width: 0, height: 0, captionOnly: true,
                    ...(captioned ? { captioned: true } : {}), rawHash: saved.rawHash, physical: saved.physical };
            }
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
            return { index, url: `data:${mime};base64,${saved.bytes.toString('base64')}`, ...(captioned ? { captioned: true } : {}),
                width: dimensions.width, height: dimensions.height, rawHash: saved.rawHash, physical: saved.physical };
        });
    });
}

function books(directories, names) {
    const result = Object.create(null);
    let totalBytes = 0;
    for (const name of new Set(names.flat())) {
        if (typeof name !== 'string' || !name || name.length > 234) throw roleplayError('ROLEPLAY_INVALID', 'Invalid World Info book name.', 400);
        let book, file;
        try {
            const filename = getExistingWorldInfoFilename(directories, name);
            file = filename && readRoleplayFile(path.join(directories.worlds, filename), 8 * 1024 * 1024);
            if (file && (totalBytes += file.bytes.length) <= 16 * 1024 * 1024) {
                book = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
            }
        } catch {
            throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', `A saved World Info book is unreadable: ${name}.`, 409);
        }
        if (!isValidWorldInfoData(book)) throw roleplayError('ROLEPLAY_SOURCE_DAMAGED', 'A saved World Info book is missing or damaged.', 409);
        result[name] = { data: book, hash: roleplayHash(book), rawHash: file.rawHash, physical: file.physical };
    }
    return result;
}

function boundBooks(directories, snapshot) {
    const current = books(directories, [...Object.values(snapshot.names).flat(), ...(snapshot.pathfinder?.books ?? []), ...(snapshot.tools?.pathfinder?.books ?? [])]);
    for (const [name, hash] of Object.entries(snapshot.bookHashes)) {
        if (current[name]?.hash !== hash
            || roleplayHash({ rawHash: current[name].rawHash, physical: current[name].physical })
                !== roleplayHash(snapshot.bookEvidence?.[name])) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'A World Info book changed after admission.');
        }
    }
    if (Object.keys(current).length !== Object.keys(snapshot.bookHashes).length) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The World Info selection changed after admission.');
    }
    return current;
}

/** Read a manually enabled Pathfinder book under the same account/source/physical identity checks as native lore. */
export function readBoundPathfinderBooks(base, snapshot) {
    if (!snapshot.pathfinder) return {};
    assertRoleplayWorldInfoCurrent(base, snapshot);
    return withRoleplayAccount(base, snapshot.account, lease => {
        assertRoleplaySourceLocked(lease, snapshot.source);
        if (roleplaySettingsHash(readJson(path.join(base.directories.root, 'settings.json'), {})) !== snapshot.settingsHash) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved Pathfinder settings changed after admission.');
        }
        const current = boundBooks(base.directories, snapshot);
        return Object.fromEntries(snapshot.pathfinder.books.map(name => [name, current[name].data]));
    });
}

/** Resolve the chat lock, character connection and default before reading the account's last active persona. */
function selectedPersona(settings, saved, source, avatar, directories) {
    const power = settings.power_user ?? {};
    const descriptions = power.persona_descriptions ?? {};
    if (!descriptions || typeof descriptions !== 'object' || Array.isArray(descriptions)) {
        throw roleplayError('ROLEPLAY_INVALID', 'Saved persona descriptions are invalid.', 409);
    }
    const scope = saved.locator.group ? source.groupId : avatar;
    const locked = saved.records[0].chat_metadata?.persona;
    const connected = locked ? [] : Object.entries(descriptions)
        .filter(([, descriptor]) => {
            if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
                || (descriptor.connections != null && !Array.isArray(descriptor.connections))) {
                throw roleplayError('ROLEPLAY_INVALID', 'A saved persona connection is invalid.', 409);
            }
            return descriptor.connections?.some(connection => connection?.id === scope);
        })
        .map(([id]) => id);
    if (!locked && connected.length > 1 && power.persona_allow_multi_connections) {
        throw roleplayError('ROLEPLAY_INVALID', 'Select a persona for this chat before a bound World Info scan.', 409);
    }
    const selected = locked || connected[0] || power.default_persona || settings.user_avatar;
    const descriptor = selected && Object.hasOwn(descriptions, selected) ? descriptions[selected] : null;
    if (!selected || (!locked && !connected.length && !power.default_persona && !descriptor)) {
        return { name: settings.username, description: power.persona_description ?? '', position: power.persona_description_position ?? 0,
            depth: power.persona_description_depth ?? 2, role: power.persona_description_role ?? 0,
            lorebook: power.persona_description_lorebook ?? '', evidence: null };
    }
    if (typeof selected !== 'string' || !selected || selected === '.' || selected === '..'
        || path.basename(selected) !== selected || selected.includes('\\')) {
        throw roleplayError('ROLEPLAY_INVALID', 'The selected persona avatar name is invalid.', 409);
    }
    const savedAvatar = readRoleplayFile(path.join(directories.avatars ?? path.join(directories.root, 'User Avatars'), selected),
        8 * 1024 * 1024, { allowMissingParent: true });
    if (!savedAvatar) throw roleplayError('ROLEPLAY_SOURCE_MISSING', 'The selected persona avatar is missing.', 404);
    if (descriptor && (typeof descriptor !== 'object' || Array.isArray(descriptor))) {
        throw roleplayError('ROLEPLAY_INVALID', 'The selected persona description is invalid.', 409);
    }
    const appendices = descriptor?.appendices ?? [];
    const selections = descriptor?.activeAppendices;
    if (selections != null && (typeof selections !== 'object' || Array.isArray(selections))) {
        throw roleplayError('ROLEPLAY_INVALID', 'The selected persona appendices are invalid.', 409);
    }
    const selectedIds = selections && Object.hasOwn(selections, scope) ? selections[scope]
        : saved.records[0].chat_metadata?.persona_appendices?.[selected] ?? [];
    if (!Array.isArray(appendices) || !Array.isArray(selectedIds)) {
        throw roleplayError('ROLEPLAY_INVALID', 'The selected persona description is invalid.', 409);
    }
    const parts = [String(descriptor?.description ?? '').trim()];
    for (const appendix of appendices) {
        if (!selectedIds.includes(appendix?.id)) continue;
        if (typeof appendix.description !== 'string' || typeof appendix.name !== 'string') {
            throw roleplayError('ROLEPLAY_INVALID', 'A selected persona appendix is invalid.', 409);
        }
        if (appendix.description.trim()) parts.push(`(${appendix.name})\n${appendix.description.trim()}`);
    }
    return { name: power.personas?.[selected] || settings.username, description: parts.filter(Boolean).join('\n\n'), position: descriptor?.position ?? 0,
        depth: descriptor?.depth ?? 2, role: descriptor?.role ?? 0, lorebook: descriptor?.lorebook ?? '',
        evidence: { avatar: selected, rawHash: savedAvatar.rawHash, physical: savedAvatar.physical } };
}

export { selectedPersona as selectSavedRoleplayPersona };

function selectedBooks(settings, saved, character, avatar, personaLorebook) {
    const global = settings.world_info?.globalSelect ?? [];
    const charLore = settings.world_info?.charLore ?? [];
    if (!Array.isArray(global) || !Array.isArray(charLore)) {
        throw roleplayError('ROLEPLAY_INVALID', 'Invalid saved World Info selection.', 400);
    }
    const chat = saved.records[0].chat_metadata?.world_info || '';
    const persona = personaLorebook || '';
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
export function captureRoleplayWorldInfo(base, account, source, { avatar, maxContext, tokenizer = 'o200k_base', trigger = 'normal', serverPrompt = false,
    agentIds = [], agentContext = false, nativeBindingVersion = 1, promptEffect = null }) {
    if (!['normal', 'continue', 'swipe', 'regenerate'].includes(trigger) || typeof serverPrompt !== 'boolean'
        || ![0, 1].includes(nativeBindingVersion) || nativeBindingVersion === 0 && agentIds.length
        || promptEffect !== null && !['append', 'continue', 'swipe', 'alternative', 'replace'].includes(promptEffect)) {
        throw roleplayError('ROLEPLAY_INVALID', 'The World Info generation trigger is invalid.', 400);
    }
    return withRoleplayAccount(base, account, lease => {
        const saved = assertRoleplaySourceLocked(lease, source);
        const promptRecords = serverPrompt ? selectRoleplayPromptRecords(saved.records, source,
            promptEffect ?? { normal: 'append', regenerate: 'replace', swipe: 'swipe', continue: 'continue' }[trigger]) : saved.records;
        if (!source.dependencies?.some(dependency => dependency.kind === 'character' && dependency.locator.avatar === avatar)) {
            throw roleplayError('ROLEPLAY_INVALID', 'World Info must use a character in the accepted Roleplay source.', 409);
        }
        const character = readRoleplayEntityLocked(lease, 'character', avatar);
        if (character.changed) saveRoleplayAccount(lease);
        const file = path.join(base.directories.root, 'settings.json');
        const savedSettings = readJson(file, {});
        const settings = { ...savedSettings, ...savedSettings.world_info_settings };
        settings.power_user = savedSettings.power_user;
        const persona = selectedPersona(settings, saved, source, avatar, base.directories);
        const group = source.locator.group ? readRoleplayEntityLocked(lease, 'group', source.groupId).data : null;
        const members = group ? group.members.map(member => ({ avatar: member,
            card: member === avatar ? character.data : readRoleplayEntityLocked(lease, 'character', member).data })) : [];
        const memberName = member => member.card?.data?.name ?? member.card?.name;
        const names = selectedBooks(settings, saved, character, avatar, persona.lorebook);
        const hookPolicy = captureWorldInfoHookPolicy(base.directories, savedSettings,
            saved.records[0].chat_metadata, avatar, saved.locator.group);
        const pathfinder = capturePathfinderSource(base.directories, hookPolicy, {
            chatBook: saved.records[0].chat_metadata?.world_info, personaBook: persona.lorebook,
            members: group ? members : [{ avatar, card: character.data }], charLore: settings.world_info?.charLore ?? [],
        });
        const agents = nativeBindingVersion && serverPrompt ? captureRoleplayAgents(lease, savedSettings,
            { group: Boolean(source.locator.group), serverPrompt,
                characterAvatars: source.locator.group ? members.map(member => member.avatar) : [avatar],
                ...agentHistorySources(saved.records), forcedIds: agentIds }) : null;
        const companionCapacity = agents ? captureCompanionCapacity(readRoleplayAgentsLocked(lease, agents), saved.records,
            source, { agentContext, trigger }) : null;
        const tools = nativeBindingVersion && serverPrompt && !agentContext
            ? captureRoleplayToolBindings(lease, source, avatar, character.data, agents, savedSettings) : null;
        const selected = books(base.directories, [...Object.values(names).flat(), ...(pathfinder?.books ?? []), ...(tools?.pathfinder?.books ?? [])]);
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
        const attachments = agentContext ? [] : savedAttachments(base.directories, promptRecords);
        const images = agentContext ? [] : captureSavedRoleplayImages(base.directories, promptRecords, settings.power_user?.media_display ?? 'list', extensions.caption);
        const captions = agentContext ? null : captureRoleplayCaptions(base.directories, savedSettings, { records: promptRecords, images,
            serverPrompt, display: settings.power_user?.media_display ?? 'list' });
        const chat = promptRecords.slice(1).flatMap((message, index) => {
            if (message.is_system) return [];
            const text = (attachments.find(item => item.index === index)?.text ?? '') + String(message.mes ?? '');
            return [(settings.world_info_include_names ?? DEFAULTS.world_info_include_names)
                ? `${message.name}: ${text}` : text];
        }).reverse();
        const authorNote = { prompt: saved.records[0].chat_metadata?.note_prompt ?? note.default ?? '',
            interval: saved.records[0].chat_metadata?.note_interval ?? note.defaultInterval ?? 1,
            position: saved.records[0].chat_metadata?.note_position ?? note.defaultPosition ?? 1,
            depth: saved.records[0].chat_metadata?.note_depth ?? note.defaultDepth ?? 4,
            role: saved.records[0].chat_metadata?.note_role ?? note.defaultRole ?? 0,
            scoped: scoped ? structuredClone(scoped) : null,
            userMessages: promptRecords.slice(1).filter(message => message.is_user).length };
        const depthPrompt = character.data?.data?.extensions?.depth_prompt?.prompt
            ?? character.data?.extensions?.depth_prompt?.prompt ?? '';
        const inject = [];
        if (note.allowWIScan) {
            let depthPrompts = [depthPrompt];
            if (saved.locator.group) {
                const group = readRoleplayEntityLocked(lease, 'group', source.groupId).data;
                if (group.generation_mode !== 0) {
                    depthPrompts = group.members.filter(member => member === avatar || !group.disabled_members?.includes(member))
                        .map(member => {
                            const card = member === avatar ? character : readRoleplayEntityLocked(lease, 'character', member);
                            return card.data?.data?.extensions?.depth_prompt?.prompt
                                ?? card.data?.extensions?.depth_prompt?.prompt ?? '';
                        }).filter(prompt => typeof prompt === 'string' && prompt.trim());
                    if (!depthPrompts.length) depthPrompts = [depthPrompt];
                }
            }
            for (const prompt of depthPrompts) {
                if (typeof prompt !== 'string') {
                    throw roleplayError('ROLEPLAY_INVALID', 'The saved depth prompt must be text.', 409);
                }
                if (prompt.trim()) inject.push(prompt.trim());
            }
        }
        if (note.allowWIScan && isWorldInfoAuthorNoteActive(authorNote)) {
            let prompt = activeRoleplayAuthorNote(authorNote);
            if (persona.description && persona.position === 2) prompt = `${persona.description}\n${prompt}`;
            if (persona.description && persona.position === 3) prompt = `${prompt}\n${persona.description}`;
            if (typeof prompt !== 'string') throw roleplayError('ROLEPLAY_INVALID', 'The saved Author\'s Note must be text.', 409);
            if (prompt) inject.push(prompt);
        }
        // The browser sets the persona depth prompt before World Info scans.
        if (persona.position === 4 && persona.description) {
            if (typeof persona.description !== 'string') {
                throw roleplayError('ROLEPLAY_INVALID', 'The saved persona description must be text.', 409);
            }
            inject.push(persona.description);
        }
        const translation = captureIncomingRoleplayTranslation(base.directories, savedSettings, { serverPrompt: serverPrompt && !agentContext });
        const inputTranslation = captureRoleplayInputTranslation(base.directories, savedSettings, promptRecords, { serverPrompt: serverPrompt && !agentContext });
        const speech = serverPrompt && !agentContext ? captureSpeechPolicy(base.directories, savedSettings) : null;
        const snapshot = { account: { accountId: account.accountId, dataEpoch: account.dataEpoch }, source, serverPrompt,
            ...(serverPrompt && nativeBindingVersion ? { nativeBindingVersion } : {}),
            ...(agentContext ? { agentContext: true } : {}),
            character: { instanceId: character.instanceId, revision: character.revision, rawHash: character.rawHash },
            speakerNames: { character: character.data?.data?.name ?? character.data?.name,
                user: persona.name || (saved.records[0].user_name !== 'unused' && saved.records[0].user_name) || 'User' },
            groupNames: members.map(memberName),
            unmutedGroupNames: members.filter(member => !group.disabled_members?.includes(member.avatar)).map(memberName),
            pinExamples: Boolean(settings.power_user?.pin_examples),
            alwaysForceName: Boolean(settings.power_user?.always_force_name2),
            contextRetention: { html: settings.power_user?.html_context_depth ?? -1, ooc: settings.power_user?.ooc_context_depth ?? -1 },
            characterExamples: saved.records[0].chat_metadata?.mes_example || character.data?.data?.mes_example || character.data?.mes_example || '',
            characterFields: { version: character.data?.data?.character_version ?? character.data?.character_version ?? '',
                firstMessage: character.data?.data?.first_mes ?? character.data?.first_mes ?? '',
                alternateGreetings: character.data?.data?.alternate_greetings ?? character.data?.alternate_greetings ?? [] },
            promptSettings: Object.fromEntries(['instruct', 'context', 'sysprompt', 'collapse_newlines', 'strip_examples', 'token_padding', 'user_prompt_bias']
                .filter(key => settings.power_user?.[key] !== undefined).map(key => [key, structuredClone(settings.power_user[key])])),
            groupPrompt: group?.generation_mode ? { mode: group.generation_mode, prefix: group.generation_mode_join_prefix ?? '',
                suffix: group.generation_mode_join_suffix ?? '', members: members.map(member => ({ name: memberName(member),
                    selected: member.avatar === avatar, disabled: Boolean(group.disabled_members?.includes(member.avatar)),
                    fields: Object.fromEntries(['description', 'personality', 'scenario', 'mes_example'].map(key => [key, member.card.data?.[key] ?? member.card[key] ?? ''])),
                    depth: member.card.data?.extensions?.depth_prompt ?? member.card.extensions?.depth_prompt ?? {} })) } : null,
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
            personaPosition: persona.position, personaDepth: persona.depth, personaRole: persona.role, personaEvidence: persona.evidence,
            promptVariables: { local: saved.records[0].chat_metadata?.variables ?? {}, global: extensions.variables?.global ?? {} },
            experimentalMacroEngine: Boolean(settings.power_user?.experimental_macro_engine),
            depthPrompt: { prompt: depthPrompt,
                depth: (character.data?.data?.extensions ?? character.data?.extensions)?.depth_prompt?.depth ?? 4,
                role: (character.data?.data?.extensions ?? character.data?.extensions)?.depth_prompt?.role ?? 'system' },
            enhancedLoreMacros: Boolean(settings.power_user?.experimental_macro_engine)
                && !extensions.disabledExtensions?.some(name => normalizeExtensionBootId(name) === 'macroenhanced'),
            noteScanEnabled: Boolean(note.allowWIScan), cfg: extensions.cfg ?? null,
            reasoningInPrompt: Boolean(settings.power_user?.reasoning?.add_to_prompts),
            reasoning: {
                prefix: settings.power_user?.reasoning?.prefix ?? '<think>',
                suffix: settings.power_user?.reasoning?.suffix ?? '</think>',
                separator: settings.power_user?.reasoning?.separator ?? '\n',
                max_additions: settings.power_user?.reasoning?.max_additions ?? 1,
            },
            settingsHash: roleplaySettingsHash(savedSettings),
            ...(agents ? { agents } : {}),
            ...(companionCapacity ? { companionCapacity } : {}),
            ...(tools ? { tools } : {}),
            hookPolicy, ...(pathfinder ? { pathfinder } : {}),
            ...(translation ? { translation } : {}),
            ...(inputTranslation ? { inputTranslation } : {}),
            ...(speech ? { speech } : {}),
            ...(captions ? { captions } : {}),
            names, settings: Object.fromEntries(SETTINGS.map(key => [key, settings[key] ?? DEFAULTS[key]])),
            bookHashes: Object.fromEntries(Object.entries(selected).map(([name, value]) => [name, value.hash])),
            bookEvidence: Object.fromEntries(Object.entries(selected).map(([name, value]) =>
                [name, { rawHash: value.rawHash, physical: value.physical }])),
            characterFile: path.parse(avatar).name, avatar, maxContext, tokenizer, chat, regex,
            savedChatLength: saved.records.length - 1,
            metadata: structuredClone(saved.records[0].chat_metadata ?? {}),
            authorNote,
            global: {
                trigger, ...(promptEffect ? { promptEffect } : {}),
                characterDescription: character.data?.data?.description ?? character.data?.description ?? '',
                characterPersonality: character.data?.data?.personality ?? character.data?.personality ?? '',
                personaDescription: persona.description,
                characterDepthPrompt: depthPrompt,
                creatorNotes: character.data?.data?.creator_notes ?? character.data?.creator_notes ?? '',
                scenario: saved.records[0].chat_metadata?.scenario || character.data?.data?.scenario || character.data?.scenario || '',
                characterTags, inject,
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
        promptEffect: snapshot.global?.promptEffect ?? null,
        serverPrompt: snapshot.serverPrompt,
        agentIds: snapshot.agents?.forcedIds ?? [], agentContext: snapshot.agentContext ?? false,
        nativeBindingVersion: Object.hasOwn(snapshot, 'nativeBindingVersion') ? snapshot.nativeBindingVersion : 0,
    });
    if (roleplayHash(captured) !== roleplayHash(snapshot)) {
        throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved World Info selection differs from the account sources.');
    }
}

export async function prepareRoleplayWorldInfo(base, snapshot, { random = Math.random, onEntriesLoaded, onScan, macros, promptChat, promptGlobal, promptInjections = [] } = {}) {
    assertRoleplayWorldInfoCurrent(base, snapshot);
    let records;
    const selected = withRoleplayAccount(base, snapshot.account, lease => {
        records = assertRoleplaySourceLocked(lease, snapshot.source).records;
        const character = readRoleplayEntityLocked(lease, 'character', snapshot.avatar);
        if (character.instanceId !== snapshot.character.instanceId || character.revision !== snapshot.character.revision
            || character.rawHash !== snapshot.character.rawHash) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The World Info character changed after admission.');
        }
        if (character.changed) saveRoleplayAccount(lease);
        if (roleplaySettingsHash(readJson(path.join(base.directories.root, 'settings.json'), {})) !== snapshot.settingsHash) {
            throw roleplayError('ROLEPLAY_SOURCE_CHANGED', 'The saved World Info settings changed after admission.');
        }
        return boundBooks(base.directories, snapshot);
    });
    const lore = Object.fromEntries(['global', 'character', 'chat', 'persona'].map(type => [type + 'Lore',
        (snapshot.names[type] ?? []).flatMap(name => Object.entries(selected[name].data.entries).map(([key, entry]) => {
            const { uid = Number.isNaN(Number(key)) ? key : Number(key), ...rest } = entry;
            return { uid, world: name, ...rest };
        }))]));
    const entriesLoaded = { bookHashes: snapshot.bookHashes, entries: Object.fromEntries(
        ['global', 'character', 'chat', 'persona'].map(type => [type,
            lore[type + 'Lore'].map(entry => ({ world: entry.world, uid: entry.uid, rawHash: roleplayHash(entry) }))])) };
    const loadedHash = roleplayHash(lore);
    await onEntriesLoaded?.(lore);
    if (roleplayHash(lore) !== loadedHash) {
        throw roleplayError('ROLEPLAY_INVALID', 'A World Info loading hook changed the saved book selection.', 409);
    }
    const entries = prepareWorldInfoEntries(lore, Number(snapshot.settings.world_info_character_strategy ?? 1));
    const { count } = await getCounter(snapshot.tokenizer);
    const environment = createMacroEnvironment(macros ?? savedRoleplayMacroSnapshot(snapshot, records), {}, { readOnly: true });
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
    if (promptChat !== undefined && (!Array.isArray(promptChat) || promptChat.some(value => typeof value !== 'string')
        || Buffer.byteLength(JSON.stringify(promptChat)) > 2 * 1024 * 1024)) {
        throw roleplayError('ROLEPLAY_INVALID', 'The prepared World Info history is invalid.', 409);
    }
    if (!Array.isArray(promptInjections) || promptInjections.some(value => typeof value !== 'string')
        || Buffer.byteLength(JSON.stringify(promptInjections)) > 2 * 1024 * 1024) {
        throw roleplayError('ROLEPLAY_INVALID', 'The prepared World Info prompt contributions are invalid.', 409);
    }
    const global = promptGlobal ?? { ...snapshot.global, inject: snapshot.global.inject.map(substitute) };
    if (global.trigger !== snapshot.global.trigger || roleplayHash(global.characterTags) !== roleplayHash(snapshot.global.characterTags)
        || Object.keys(global).some(key => !Object.hasOwn(snapshot.global, key))
        || Object.keys(snapshot.global).some(key => !Object.hasOwn(global, key))
        || !Array.isArray(global.inject) || global.inject.some(value => typeof value !== 'string')
        || Object.entries(global).some(([key, value]) => !['inject', 'characterTags'].includes(key) && typeof value !== 'string')
        || Buffer.byteLength(JSON.stringify(global)) > 2 * 1024 * 1024) {
        throw roleplayError('ROLEPLAY_INVALID', 'The prepared World Info character context is invalid.', 409);
    }
    const result = await scanWorldInfo({ entries, chat: promptChat ?? snapshot.chat, metadata: snapshot.metadata,
        settings: snapshot.settings, global: { ...global, inject: [...global.inject, ...promptInjections], characterFile: snapshot.characterFile },
        maxContext: snapshot.maxContext, countTokens: count, substitute, random, onScan, transform });
    const outputText = [result.worldInfoBefore, result.worldInfoAfter,
        ...result.EMEntries.map(entry => entry.content), ...result.WIDepthEntries.flatMap(entry => entry.entries),
        ...result.ANBeforeEntries, ...result.ANAfterEntries, ...Object.values(result.outletEntries).flat()].join('\n');
    if (await count(outputText) > snapshot.maxContext) {
        throw roleplayError('ROLEPLAY_INVALID', 'The transformed World Info exceeds the saved context limit.', 409);
    }
    assertRoleplayWorldInfoCurrent(base, snapshot);
    const hookEvents = { ...result.hookEvents, entriesLoaded,
        actions: worldInfoActivationActions(snapshot.hookPolicy, result.activated) };
    return { ...result, hookEvents, bookHashes: snapshot.bookHashes, snapshotHash: roleplayHash(snapshot),
        ...(promptChat !== undefined ? { promptChatHash: roleplayHash(promptChat) } : {}),
        ...(promptGlobal !== undefined ? { promptGlobalHash: roleplayHash(promptGlobal) } : {}),
        ...(promptInjections.length ? { promptInjectionsHash: roleplayHash(promptInjections) } : {}),
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
