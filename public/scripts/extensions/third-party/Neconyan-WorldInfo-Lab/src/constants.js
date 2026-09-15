export const EXTENSION_NAME = 'Neconyan-WorldInfo-Lab';
export const EXTENSION_LABEL = 'World Info Lab';
export const SETTINGS_KEY = 'SillyBunnyWorldInfoLab';
export const METADATA_KEY = 'SillyBunnyWorldInfoLab';
export const HISTORY_KEY = 'SillyBunnyWorldInfoLab.history.v1';
export const SCHEMA_VERSION = 1;

export const SCAN_STATE = Object.freeze({
    NONE: 0,
    INITIAL: 1,
    RECURSION: 2,
    MIN_ACTIVATIONS: 3,
});

export const SCAN_STATE_LABEL = Object.freeze({
    [SCAN_STATE.NONE]: 'Stopped',
    [SCAN_STATE.INITIAL]: 'Initial',
    [SCAN_STATE.RECURSION]: 'Recursion',
    [SCAN_STATE.MIN_ACTIVATIONS]: 'Minimum activations',
});

export const LOGIC = Object.freeze({
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
});

export const LOGIC_LABEL = Object.freeze({
    [LOGIC.AND_ANY]: 'AND any',
    [LOGIC.NOT_ALL]: 'NOT all',
    [LOGIC.NOT_ANY]: 'NOT any',
    [LOGIC.AND_ALL]: 'AND all',
});

export const POSITION = Object.freeze({
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
});

export const POSITION_LABEL = Object.freeze({
    [POSITION.before]: 'Before character definition',
    [POSITION.after]: 'After character definition',
    [POSITION.ANTop]: "Author's Note, top",
    [POSITION.ANBottom]: "Author's Note, bottom",
    [POSITION.atDepth]: 'At chat depth',
    [POSITION.EMTop]: 'Example messages, top',
    [POSITION.EMBottom]: 'Example messages, bottom',
    [POSITION.outlet]: 'Named outlet',
});

export const SOURCE_STRATEGY = Object.freeze({
    evenly: 0,
    character_first: 1,
    global_first: 2,
});

export const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    lastTab: 'scan',
    inputMode: 'chat',
    trigger: 'normal',
    seed: 1,
    selectedBook: '',
    historyLimit: 100,
});

export const DEFAULT_SCAN_SETTINGS = Object.freeze({
    depth: 2,
    minActivations: 0,
    minActivationsDepthMax: 0,
    budgetPercent: 25,
    budgetCap: 0,
    includeNames: true,
    recursive: false,
    caseSensitive: false,
    matchWholeWords: false,
    useGroupScoring: false,
    characterStrategy: SOURCE_STRATEGY.character_first,
    maxRecursionSteps: 0,
});

export const GENERATION_TRIGGERS = Object.freeze([
    'normal',
    'continue',
    'impersonate',
    'swipe',
    'regenerate',
    'quiet',
]);

export function entryId(entry) {
    return `${String(entry?.world ?? '')}.${String(entry?.uid ?? '')}`;
}

export function entryRef(entry) {
    return { id: entryId(entry), hash: String(entry?.hash ?? '') };
}

export function entryRefKey(reference) {
    return JSON.stringify([String(reference?.id ?? ''), String(reference?.hash ?? '')]);
}
