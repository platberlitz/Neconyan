import { GENERATION_TRIGGERS, entryId, entryRef, entryRefKey } from './constants.js';
import { countTokens, getContext, loadHost, substitute } from './host.js';
import { normalizeScanSettings } from './sources.js';

const VOLATILE_MACRO = /{{\s*(?:random|randomPick|roll|dice|time|date|idle|pick|uuid)\b/ig;
const VARIABLE_SHORTHAND_MACRO = /{{\s*[.$][A-Za-z_][\w-]*/i;

export function buildMacroSnapshot(overrides = {}, macroEngine = 'legacy', substituteValue = substitute) {
    const source = overrides instanceof Map ? [...overrides] : Object.entries(overrides ?? {});
    if (source.some(([key, value]) => typeof key !== 'string' || typeof value !== 'string')) {
        throw new TypeError('Saved macro values are invalid. Recreate this saved test.');
    }
    const frozen = new Map(source);
    const cache = new Map();
    const expansions = new Map();
    const unsafe = new Set();
    const volatile = new Set();
    const expand = (value, scope = 'global') => {
        const input = String(value ?? '');
        const expansionKey = JSON.stringify([scope, input]);
        if (expansions.has(expansionKey)) {
            return expansions.get(expansionKey);
        }
        if (macroEngine === 'experimental' && VARIABLE_SHORTHAND_MACRO.test(input)) {
            unsafe.add(scope);
        }
        let volatileIndex = 0;
        for (const _match of input.matchAll(VOLATILE_MACRO)) {
            volatile.add(`${scope}:volatile:${volatileIndex++}`);
        }
        let index = 0;
        const output = substituteValue(input, (result) => {
            const key = `${scope}:${index++}`;
            const replacement = frozen.has(key) ? frozen.get(key) : String(result ?? '');
            cache.set(key, replacement);
            return replacement;
        });
        expansions.set(expansionKey, output);
        return output;
    };
    return { cache, unsafe, volatile, expand };
}

function getCharacterFilename(context, host) {
    const liveFilename = host?.utils?.getCharaFilename?.(context?.characterId);
    if (liveFilename !== undefined && liveFilename !== null) {
        return String(liveFilename);
    }
    const avatar = context?.characters?.[context?.characterId]?.avatar;
    return String(avatar ?? '').replace(/\.[^/.]+$/, '');
}

async function getCharacterTags(context, host) {
    const tagKey = host.tags?.getTagKeyForEntity?.(context?.characterId);
    const tags = tagKey ? context?.tagMap?.[tagKey] : null;
    return {
        tags: Array.isArray(tags) ? [...tags] : [],
        tagsAvailable: Array.isArray(tags),
    };
}

export function currentChatMessages(context, includeNames, trigger) {
    const messages = (context?.chat ?? [])
        .filter(message => message && !message.is_system && typeof message.mes === 'string')
        .map((message, index) => ({
            index,
            name: String(message.name ?? (message.is_user ? context.name1 : context.name2) ?? ''),
            mes: String(message.mes ?? ''),
            isUser: Boolean(message.is_user),
        }));
    if (trigger === 'swipe' || (trigger === 'regenerate' && messages.at(-1)?.isUser === false)) {
        messages.pop();
    }
    return messages.map(message => includeNames ? `${message.name}: ${message.mes}` : message.mes).reverse();
}

function pastedMessages(text) {
    const value = String(text ?? '').trim();
    return value ? [value] : [];
}

async function getScanInjections(context, expand) {
    const injections = [];
    for (const [index, prompt] of Object.values(context?.extensionPrompts ?? {}).entries()) {
        if (!prompt?.scan || !prompt?.value || (typeof prompt.filter === 'function' && !await prompt.filter())) {
            continue;
        }
        const value = expand(String(prompt.value), `prompt:${index}`);
        if (value) {
            injections.push(value);
        }
    }
    return injections;
}

export function getTimedEffects(context, entries, chatLength) {
    const metadata = context?.chatMetadata?.timedWorldInfo ?? {};
    const result = { sticky: [], cooldown: [], delay: [] };
    for (const entry of entries) {
        const id = entryId(entry);
        if (entry.delay && chatLength < Number(entry.delay)) {
            result.delay.push(entryRef(entry));
        }
        for (const type of ['sticky', 'cooldown']) {
            const effect = metadata?.[type]?.[id];
            if (!effect || !entry[type]) {
                continue;
            }
            const hashMatches = effect.hash !== undefined && String(effect.hash) === String(entry.hash);
            const advanced = chatLength > Number(effect.start) || effect.protected;
            if (hashMatches && advanced && chatLength < Number(effect.end)) {
                result[type].push(entryRef(entry));
            } else if (type === 'sticky' && hashMatches && advanced
                && chatLength >= Number(effect.end) && entry.cooldown) {
                result.cooldown.push(entryRef(entry));
            }
        }
    }
    result.cooldown = [...new Map(result.cooldown.map(reference => [entryRefKey(reference), reference])).values()];
    return result;
}

export async function buildSimulationRequest(snapshot, options = {}) {
    const context = options.context ?? getContext();
    const host = await loadHost();
    if (!host.ok) {
        throw new Error(host.reason);
    }
    const mode = options.mode === 'text' ? 'text' : 'chat';
    if (context?.groupId !== undefined && context?.groupId !== null && options.character === undefined) {
        throw new Error('Group-chat scans need an explicit target character. Select a one-to-one chat or run a saved test with a frozen character.');
    }
    const trigger = GENERATION_TRIGGERS.includes(options.trigger) ? options.trigger : 'normal';
    const macroEngine = options.macroEngine
        ?? (context?.powerUserSettings?.experimental_macro_engine ? 'experimental' : 'legacy');
    if (!['legacy', 'experimental'].includes(macroEngine)) {
        throw new TypeError('The saved macro engine is invalid. Recreate this saved test.');
    }
    const messages = Array.isArray(options.messages)
        ? options.messages.map(value => String(value ?? ''))
        : mode === 'text'
            ? pastedMessages(options.text)
            : currentChatMessages(context, snapshot.settings.includeNames, trigger);
    const fields = context?.getCharacterCardFields?.() ?? {};
    const macros = buildMacroSnapshot(options.macroSnapshot, macroEngine);
    const injections = Array.isArray(options.injections)
        ? options.injections.map(value => String(value ?? ''))
        : mode === 'chat' ? await getScanInjections(context, macros.expand) : [];
    const promptLimit = host.script.getMaxPromptTokens();
    const maxContext = Math.max(1, Number(options.maxContext ?? promptLimit ?? context?.maxContext ?? 4096));
    const character = options.character ?? {
        filename: getCharacterFilename(context, host),
        ...await getCharacterTags(context, host),
    };
    const warnings = [...snapshot.warnings];
    if (mode === 'chat') {
        warnings.push('This scan uses the saved chat. An actual reply may see different text after regex scripts, OOC handling, attachments, reasoning, or other prompt processing.');
        warnings.push('An actual reply may have less prompt space than this scan because model-provider and CFG settings can change the final token limit.');
    }
    if (injections.length) {
        warnings.push('Extension prompts marked for lorebook scanning are included after their filters and macros were evaluated.');
    }
    const vectors = context?.extensionSettings?.vectors;
    if (snapshot.entries.some(entry => entry.vectorized) || (vectors?.enabled_world_info && vectors?.enabled_for_all)) {
        warnings.push('Vector matching is not simulated, so entries selected only by vector similarity may be missing from these results.');
    }
    if (character.tagsAvailable === false && snapshot.entries.some(entry => Array.isArray(entry.characterFilter?.tags) && entry.characterFilter.tags.length)) {
        warnings.push('Character tags are unavailable, so tag-based character filters were skipped and may produce extra activations.');
    }
    return {
        mode,
        entries: structuredClone(snapshot.entries),
        messages,
        injections,
        settings: normalizeScanSettings({ ...snapshot.settings, ...(options.settings ?? {}) }),
        maxContext,
        trigger,
        seed: Number(options.seed ?? 1) >>> 0,
        forcedRefs: [...new Map((options.forcedRefs ?? []).map(reference => [entryRefKey(reference), structuredClone(reference)])).values()],
        timedEffects: options.timedEffects ?? getTimedEffects(context, snapshot.entries, messages.length),
        character,
        globalScanData: options.globalScanData ?? {
            personaDescription: fields.persona ?? '',
            characterDescription: fields.description ?? '',
            characterPersonality: fields.personality ?? '',
            characterDepthPrompt: fields.charDepthPrompt ?? '',
            scenario: fields.scenario ?? '',
            creatorNotes: fields.creatorNotes ?? '',
            trigger,
        },
        expand: macros.expand,
        macroEngine,
        macroSnapshot: macros.cache,
        unfrozenMacros: macros.unsafe,
        volatileMacros: macros.volatile,
        tokenCount: options.tokenCount ?? countTokens,
        parseRegex: host.worldInfo.parseRegexFromString,
        processRegex: host.regex?.getRegexedString
            ? (content, depth) => host.regex.getRegexedString(content, host.regex.regex_placement.WORLD_INFO, {
                depth,
                isMarkdown: false,
                isPrompt: true,
            })
            : null,
        warnings,
        sourcePlan: structuredClone(snapshot.plan),
    };
}
