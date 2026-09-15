import {
    DEFAULT_SCAN_SETTINGS,
    POSITION,
    SOURCE_STRATEGY,
    entryId,
} from './constants.js';
import { getContext, loadHost } from './host.js';

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function stripExtension(value) {
    return String(value ?? '').replace(/\.[^/.]+$/, '');
}

export function parseDecorators(value) {
    const content = String(value ?? '');
    if (!content.startsWith('@@')) {
        return { decorators: [], content };
    }
    const lines = content.split(/\r?\n/);
    const decorators = [];
    let fallback = false;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.startsWith('@@')) {
            return { decorators, content: lines.slice(index).join('\n') };
        }
        if (line.startsWith('@@@') && !fallback) {
            continue;
        }
        const normalized = line.startsWith('@@@') ? line.slice(1) : line;
        if (normalized.startsWith('@@activate') || normalized.startsWith('@@dont_activate')) {
            decorators.push(normalized);
            fallback = false;
        } else {
            fallback = true;
        }
    }
    return { decorators, content: '' };
}

export function normalizeScanSettings(raw = {}) {
    const number = (value, fallback, name, min, max, integer = true) => {
        const parsed = value ?? fallback;
        const normalized = Number(parsed);
        if (!Number.isFinite(normalized) || (integer && !Number.isInteger(normalized)) || normalized < min || normalized > max) {
            throw new TypeError(`Lorebook setting "${name}" must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
        }
        return normalized;
    };
    const boolean = (value, fallback, name) => {
        const normalized = value ?? fallback;
        if (typeof normalized !== 'boolean') {
            throw new TypeError(`Lorebook setting "${name}" must be true or false.`);
        }
        return normalized;
    };
    return {
        depth: number(raw.world_info_depth ?? raw.depth, DEFAULT_SCAN_SETTINGS.depth, 'depth', 0, 1000),
        minActivations: number(raw.world_info_min_activations ?? raw.minActivations, DEFAULT_SCAN_SETTINGS.minActivations, 'minimum activations', 0, 100),
        minActivationsDepthMax: number(raw.world_info_min_activations_depth_max ?? raw.minActivationsDepthMax, DEFAULT_SCAN_SETTINGS.minActivationsDepthMax, 'minimum activation depth', 0, 1000),
        budgetPercent: number(raw.world_info_budget ?? raw.budgetPercent, DEFAULT_SCAN_SETTINGS.budgetPercent, 'budget percent', 1, 100, false),
        budgetCap: number(raw.world_info_budget_cap ?? raw.budgetCap, DEFAULT_SCAN_SETTINGS.budgetCap, 'budget cap', 0, 65536),
        includeNames: boolean(raw.world_info_include_names ?? raw.includeNames, DEFAULT_SCAN_SETTINGS.includeNames, 'include names'),
        recursive: boolean(raw.world_info_recursive ?? raw.recursive, DEFAULT_SCAN_SETTINGS.recursive, 'recursive'),
        caseSensitive: boolean(raw.world_info_case_sensitive ?? raw.caseSensitive, DEFAULT_SCAN_SETTINGS.caseSensitive, 'case sensitive'),
        matchWholeWords: boolean(raw.world_info_match_whole_words ?? raw.matchWholeWords, DEFAULT_SCAN_SETTINGS.matchWholeWords, 'match whole words'),
        useGroupScoring: boolean(raw.world_info_use_group_scoring ?? raw.useGroupScoring, DEFAULT_SCAN_SETTINGS.useGroupScoring, 'group scoring'),
        characterStrategy: number(raw.world_info_character_strategy ?? raw.characterStrategy, DEFAULT_SCAN_SETTINGS.characterStrategy, 'character strategy', 0, 2),
        maxRecursionSteps: number(raw.world_info_max_recursion_steps ?? raw.maxRecursionSteps, DEFAULT_SCAN_SETTINGS.maxRecursionSteps, 'maximum recursion steps', 0, 10),
    };
}

export function getActiveBookPlan(context = getContext(), host = null) {
    const liveGlobal = host?.worldInfo?.selected_world_info;
    const global = [...(
        Array.isArray(liveGlobal)
            ? liveGlobal
            : (context?.worldInfoSettings?.globalSelect ?? [])
    )].filter(Boolean);
    const chat = context?.chatMetadata?.world_info;
    const persona = context?.powerUserSettings?.persona_description_lorebook;
    const character = context?.characters?.[context?.characterId];
    const filename = host?.utils?.getCharaFilename?.(context?.characterId)
        ?? stripExtension(character?.avatar);
    const characterBooks = [];
    const addCharacter = (name) => {
        if (name && !characterBooks.includes(name)) {
            characterBooks.push(name);
        }
    };
    addCharacter(character?.data?.extensions?.world);
    const extras = context?.worldInfoSettings?.charLore?.find(item => item?.name === filename)?.extraBooks ?? [];
    extras.forEach(addCharacter);

    const globalSet = new Set(global);
    const chatName = chat && !globalSet.has(chat) ? chat : '';
    const personaName = persona && persona !== chatName && !globalSet.has(persona) ? persona : '';
    const characterFiltered = characterBooks.filter(name => (
        !globalSet.has(name) && name !== chatName && name !== personaName
    ));

    return {
        chat: chatName ? [chatName] : [],
        persona: personaName ? [personaName] : [],
        character: characterFiltered,
        global,
        all: [...new Set([
            ...(chatName ? [chatName] : []),
            ...(personaName ? [personaName] : []),
            ...characterFiltered,
            ...global,
        ])],
    };
}

function getWorldEntries(data, world, source) {
    if (!data?.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
        return [];
    }
    return Object.entries(data.entries)
        .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map(([key, entry]) => {
            const {
                uid = Number.isNaN(Number(key)) ? key : Number(key),
                world: _world,
                hash: _hash,
                labSource: _labSource,
                ...rest
            } = entry;
            return { uid, world, ...clone(rest), labSource: source };
        });
}

function sortDescending(entries) {
    return entries.sort((a, b) => b.order - a.order);
}

function sortByStrategy(groups, strategy) {
    const character = [...groups.character];
    const global = [...groups.global];
    let remainder;
    switch (Number(strategy)) {
        case SOURCE_STRATEGY.character_first:
            remainder = [...sortDescending(character), ...sortDescending(global)];
            break;
        case SOURCE_STRATEGY.global_first:
            remainder = [...sortDescending(global), ...sortDescending(character)];
            break;
        case SOURCE_STRATEGY.evenly:
        default:
            remainder = sortDescending([...global, ...character]);
            break;
    }
    return [
        ...sortDescending([...groups.chat]),
        ...sortDescending([...groups.persona]),
        ...remainder,
    ];
}

function normalizePlan(value) {
    const plan = {};
    const seen = new Set();
    for (const source of ['chat', 'persona', 'character', 'global']) {
        plan[source] = Array.isArray(value?.[source])
            ? [...new Set(value[source].filter(name => typeof name === 'string' && name))]
                .filter((name) => {
                    if (seen.has(name)) return false;
                    seen.add(name);
                    return true;
                })
            : [];
    }
    plan.all = [...new Set([
        ...plan.chat,
        ...plan.persona,
        ...plan.character,
        ...plan.global,
    ])];
    return plan;
}

export async function snapshotLorebooks({
    context = getContext(),
    bookNames = null,
    sourcePlan = null,
    settings: settingsOverride = null,
} = {}) {
    if (!context || typeof context.loadWorldInfo !== 'function') {
        throw new Error("Neconyan's lorebook loader is unavailable. Reload and try again.");
    }
    const host = await loadHost();
    if (!host.ok) {
        throw new Error(host.reason);
    }
    const rawSettings = host.worldInfo.getWorldInfoSettings();
    const settings = settingsOverride
        ? normalizeScanSettings(settingsOverride)
        : normalizeScanSettings(rawSettings);
    const plan = sourcePlan
        ? normalizePlan(sourcePlan)
        : bookNames
            ? normalizePlan({ global: bookNames })
            : getActiveBookPlan(context, host);
    const results = await Promise.allSettled(plan.all.map(async name => [name, await context.loadWorldInfo(name)]));
    const loaded = results
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
    const validBook = data => data?.entries && typeof data.entries === 'object' && !Array.isArray(data.entries);
    const books = new Map(loaded.filter(([, data]) => validBook(data)).map(([name, data]) => [name, clone(data)]));
    const malformed = loaded.filter(([, data]) => data && !validBook(data)).map(([name]) => name);
    const missing = plan.all.filter(name => !books.has(name) && !malformed.includes(name));
    const groups = { chat: [], persona: [], character: [], global: [] };
    for (const source of Object.keys(groups)) {
        for (const name of plan[source]) {
            groups[source].push(...getWorldEntries(books.get(name), name, source));
        }
    }
    const entries = sortByStrategy(groups, settings.characterStrategy).map((raw) => {
        const { labSource, ...entryWithoutSource } = raw;
        const decorated = parseDecorators(entryWithoutSource.content);
        const decoratedEntry = { ...entryWithoutSource, ...decorated };
        const hash = host.utils.getStringHash(JSON.stringify(decoratedEntry));
        const position = host.characterBook.normalizeWorldInfoPosition(
            decoratedEntry.position,
            host.worldInfo.world_info_position,
        ) ?? POSITION.before;
        return {
            ...host.scanCore.normalizeWorldInfoProbability({ ...decoratedEntry, position }),
            hash,
            labSource,
        };
    });
    return {
        plan,
        books,
        entries: clone(entries),
        settings,
        missing,
        warnings: [
            ...(host.warnings ?? []),
            ...(missing.length ? [`Could not load these lorebooks: ${missing.join(', ')}. Check that they still exist, then run the scan again.`] : []),
            ...(malformed.length ? [`These lorebooks returned invalid entry data and were not scanned: ${malformed.join(', ')}. Reload or repair them, then try again.`] : []),
            'Other extensions that modify lorebook entries while a reply is being prepared are not run by this scan, so results may differ.',
        ],
        entryIndex: entries.reduce((index, entry, position) => {
            const id = entryId(entry);
            const positions = index.get(id) ?? [];
            positions.push(position);
            index.set(id, positions);
            return index;
        }, new Map()),
    };
}
