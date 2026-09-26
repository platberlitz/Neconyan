import path from 'node:path';
import { normalizePlan, normalizeScanSettings } from '../../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/sources.js';
import { currentChatMessages } from '../../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/scan-input.js';
import { GENERATION_TRIGGERS } from '../../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/constants.js';
import { resolveChatTokenizerModel } from '../../public/scripts/chat-prompt-tokens.js';
import { countOpenAIChatTokens, getTokenizerModel, encodeGenerationText } from '../endpoints/tokenizers.js';
import { captureGenerationBinding, resolveGenerationProfile } from '../generation/profiles.js';
import { createRoleplayTextCounter } from '../generation/roleplay-budget.js';
import { activeRoleplayAuthorNote, isWorldInfoAuthorNoteActive } from '../generation/roleplay-prompt.js';
import { getSettingsRevision } from '../settings-version.js';
import { getCounter } from '../mewmory/tokens.js';
import { roleplayHash } from '../roleplay-store.js';
import { captureLabBook } from './books.js';
import { captureLabChat, readLabSettings } from './sources.js';
import { computeLab } from './compute.js';
import { labError } from './store.js';

function captureTokenizer(base, saved) {
    if (saved.main_api === 'openai') {
        const model = resolveChatTokenizerModel(saved.oai_settings ?? {}, { main_api: 'openai' });
        if (typeof model !== 'string' || !model) throw labError('Save a model selection before counting lorebook tokens.');
        return { kind: 'chat', model, tokenizer: getTokenizerModel(model) };
    }
    if (saved.main_api === 'novel') {
        const model = saved.nai_settings?.model_novel || '';
        return { kind: 'local', model, tokenizer: model.includes('erato') ? 'llama3' : model.includes('kayra') ? 'nerdstash_v2' : 'nerdstash' };
    }
    // Read-only tokenisation uses the saved connection, without dispatching generation.
    return { kind: 'binding', binding: captureGenerationBinding(base.directories, { kind: 'active' }, { settingsRevision: getSettingsRevision(saved) }) };
}

export async function labTokenCounter(context, tokenizer) {
    if (tokenizer.kind === 'chat') {
        await getCounter(tokenizer.tokenizer);
        return async text => text ? await countOpenAIChatTokens(tokenizer.tokenizer, tokenizer.model,
            [{ role: 'system', content: text }], { strict: true }) - 1 : 0;
    }
    if (tokenizer.kind === 'local') return async text => (await encodeGenerationText(tokenizer.tokenizer, text, tokenizer.model, context.signal)).length;
    return createRoleplayTextCounter(context, resolveGenerationProfile(context.directories, tokenizer.binding), { signal: context.signal });
}

export function captureWorldInfoLab(base, account, input, kind, captured = {}) {
    if (kind === 'world-info.batch') {
        const target = captureLabBook(base, account, input.book);
        if (input.expectedBook && roleplayHash(input.expectedBook) !== roleplayHash(target.book)) throw labError('The lorebook changed. Reload it before creating a preview.');
        const options = Object.fromEntries(['operation', 'find', 'replacement', 'filter', 'field', 'value']
            .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
        return { target, options };
    }
    const stored = captured.settings ?? readLabSettings(base);
    const saved = { ...stored, ...stored.world_info_settings }, power = saved.power_user ?? {}, extensions = saved.extension_settings ?? {};
    const chat = captured.chat ?? (input.locator ? captureLabChat(base, account, input.locator) : null);
    if (chat?.locator.group) throw labError('Choose a character chat before scanning its active lorebooks.', 400);
    if (input.mode !== 'text' && !chat && kind !== 'world-info.replay') throw labError('Select a saved chat or paste text for the scan.', 400);
    const card = chat?.macros.character ?? {}, metadata = chat?.records[0].chat_metadata ?? {};
    const avatar = chat?.locator.avatar ?? '';
    const persona = chat?.persona ?? { description: power.persona_description ?? '', position: power.persona_description_position ?? 0,
        lorebook: power.persona_description_lorebook ?? '' };
    const personaBook = persona.lorebook;
    const selection = saved.world_info ?? {};
    const global = selection.globalSelect ?? [];
    const chatBook = metadata.world_info;
    const characterBooks = [card.extensions?.world, ...(selection.charLore?.find(item => item.name === path.parse(avatar).name)?.extraBooks ?? [])].filter(Boolean);
    const sourcePlan = normalizePlan(input.book ? { global: [input.book] } : input.sourcePlan ?? {
        chat: chatBook && !global.includes(chatBook) ? [chatBook] : [],
        persona: personaBook && personaBook !== chatBook && !global.includes(personaBook) ? [personaBook] : [],
        character: characterBooks.filter(name => name !== chatBook && name !== personaBook && !global.includes(name)), global,
    });
    if (!sourcePlan.all.length && !captured.allowEmpty) throw labError('Select at least one saved lorebook before running this Lab.', 400);
    const books = Object.fromEntries(sourcePlan.all.map(name => [name, captureLabBook(base, account, name)]));
    const settings = normalizeScanSettings(input.settings ?? { ...saved, ...saved.world_info_settings });
    const trigger = input.trigger ?? 'normal';
    if (!GENERATION_TRIGGERS.includes(trigger)) throw labError('The lorebook scan trigger is invalid.', 400);
    const macros = chat?.macros ?? { names: { user: saved.username || 'User', char: '' }, character: {}, variables: {}, extra: { chat: [], chatMetadata: {} } };
    const messages = input.messages ?? (input.mode === 'text' && !(kind === 'world-info.health' && chat) ? [String(input.text ?? '').trim()].filter(Boolean)
        : currentChatMessages({ chat: chat.records.slice(1), name1: macros.names.user, name2: macros.names.char }, settings.includeNames, trigger));
    const note = extensions.note ?? {}, depthPrompt = card.extensions?.depth_prompt?.prompt ?? '';
    const authorNote = { prompt: metadata.note_prompt ?? note.default ?? '', interval: metadata.note_interval ?? note.defaultInterval ?? 1,
        userMessages: chat?.records.slice(1).filter(item => item.is_user).length ?? 0,
        scoped: note.chara?.find(item => item.name === `individual:${avatar}`) ?? note.chara?.find(item => item.name === path.parse(avatar).name) ?? null };
    let notePrompt = activeRoleplayAuthorNote(authorNote);
    if (persona.description && persona.position === 2) notePrompt = `${persona.description}\n${notePrompt}`;
    if (persona.description && persona.position === 3) notePrompt = `${notePrompt}\n${persona.description}`;
    const injections = input.injections ?? (input.mode === 'text' ? [] : [
        ...(note.allowWIScan && depthPrompt ? [depthPrompt] : []),
        ...(note.allowWIScan && isWorldInfoAuthorNoteActive(authorNote) ? [notePrompt] : []),
        ...(persona.position === 4 && persona.description ? [persona.description] : []),
    ]);
    const regex = extensions.disabledExtensions?.includes('regex') ? [] : [...(extensions.regex ?? []),
        ...(extensions.character_allowed_regex?.includes(avatar) ? card.extensions?.regex_scripts ?? [] : [])];
    const contextLimit = saved.main_api === 'openai' ? saved.oai_settings?.openai_max_context : saved.max_context;
    const responseLimit = saved.main_api === 'openai' ? saved.oai_settings?.openai_max_tokens : saved.amount_gen;
    const maxContext = Number(input.maxContext ?? (Number(contextLimit || 4096) - Number(responseLimit || 0)));
    if (!Number.isSafeInteger(maxContext) || maxContext < 1 || maxContext > 2000000) throw labError('The scan context limit is invalid.', 400);
    if (![messages, injections].every(list => Array.isArray(list) && list.every(value => typeof value === 'string'))) throw labError('The scan text is invalid.', 400);
    return { books, sourcePlan, settings, messages, injections, macros, regex, maxContext, trigger,
        mode: input.mode === 'text' ? 'text' : 'chat', seed: Number(input.seed ?? 1) >>> 0,
        macroEngine: power.experimental_macro_engine ? 'experimental' : 'legacy', macroSnapshot: input.macroSnapshot ?? {},
        timedEffects: input.timedEffects ?? null, forcedRefs: input.forcedRefs ?? [],
        character: input.character ?? { filename: path.parse(avatar).name, tags: saved.tag_map?.[avatar] ?? [], tagsAvailable: true },
        globalScanData: input.globalScanData ?? { personaDescription: card.persona ?? '', characterDescription: card.description ?? '',
            characterPersonality: card.personality ?? '', characterDepthPrompt: depthPrompt, scenario: card.scenario ?? '', creatorNotes: card.creator_notes ?? '', trigger },
        tokenizer: captured.tokenizer ?? captureTokenizer(base, saved), warnings: [
            'This scan reads saved chat and lorebooks. Reply-time attachments, transformations and extension hooks can change an actual reply.',
            ...(Object.values(books).some(target => Object.values(target.book.entries).some(entry => entry.vectorized))
                || extensions.vectors?.enabled_world_info && extensions.vectors?.enabled_for_all ? ['Vector matching is not included in this scan.'] : []),
        ] };
}

export async function runWorldInfoLab(context, plan, kind) {
    await context.progress({ stage: 'Checking saved lorebooks', completed: 0, total: 1 });
    const tokenCount = kind === 'world-info.batch' ? undefined : await labTokenCounter(context, plan.tokenizer);
    return computeLab(kind, plan, context.signal, { tokenCount });
}
