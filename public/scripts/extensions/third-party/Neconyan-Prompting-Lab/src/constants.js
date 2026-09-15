export const EXTENSION_NAME = 'Neconyan-Prompting-Lab';
export const EXTENSION_LABEL = 'Prompting Lab';
export const SETTINGS_KEY = 'SillyBunnyPromptingLab';
export const EMBED_KEY = 'SillyBunnyPromptingLab';
export const DB_NAME = 'SillyBunnyPromptingLab';

// Existing exported files use this identifier independently of the host name.
export const EXPORT_FORMAT = 'sillybunny-prompting-lab';
export const EXPORT_VERSION = 3;

export const SETTINGS_VERSION = 1;
export const CASE_VERSION = 2;
export const DRAFT_VERSION = 1;
export const PROMPT_DRAFT_VERSION = 1;
export const SUITE_VERSION = 1;
export const RUN_VERSION = 2;
export const EMBED_VERSION = 1;
export const LEDGER_VERSION = 1;

export const STORE_PREFIX = Object.freeze({
    SUITE: 'suite:',
    CASE: 'case:',
    RUN: 'run:',
    DRAFT: 'draft:',
    PROMPT: 'prompt:',
    LEDGER: 'ledger:',
});

export const INDEX_KEY = Object.freeze({
    SUITES: 'index:suites',
    CASES: 'index:cases',
    RUNS: 'index:runs:',
    DRAFTS: 'index:drafts',
    PROMPTS: 'index:prompts',
    LEDGER: 'index:ledger',
});

/** Status of a single case within a run. */
export const STATUS = Object.freeze({
    PASS: 'pass',
    CHANGED: 'changed',
    UNCHECKED: 'unchecked',
    FAIL: 'fail',
    ERROR: 'error',
    SKIPPED: 'skipped',
});

export const STATUS_LABEL = Object.freeze({
    [STATUS.PASS]: 'Passed',
    [STATUS.CHANGED]: 'Changed',
    [STATUS.UNCHECKED]: 'Needs review',
    [STATUS.FAIL]: 'Failed',
    [STATUS.ERROR]: 'Could not run',
    [STATUS.SKIPPED]: 'Skipped',
});

export const SECTION_LABEL = Object.freeze({
    worldInfoBefore: 'World Info (before character)',
    main: 'Main prompt',
    worldInfoAfter: 'World Info (after character)',
    charDescription: 'Character description',
    charPersonality: 'Character personality',
    scenario: 'Scenario',
    personaDescription: 'Persona description',
    controlPrompts: 'Control prompts',
    nsfw: 'Auxiliary prompt',
    jailbreak: 'Post-history instructions',
    enhanceDefinitions: 'Enhance definitions',
    bias: 'Bias',
    dialogueExamples: 'Example messages',
    chatHistory: 'Chat history',
    continueNudge: 'Continue nudge',
    sillybunnyRuntimeAgents: 'In-chat agents',
    storyString: 'Story string',
    mesExmString: 'Example messages',
    mesSendString: 'Chat history',
    finalMesSend: 'Chat history (final)',
    finalInterceptors: 'Final interceptor output',
    worldInfoString: 'World Info',
    description: 'Character description',
    personality: 'Character personality',
    persona: 'Persona description',
    naiPreamble: 'NovelAI preamble',
});

/** Assertion type identifiers. */
export const ASSERTION = Object.freeze({
    SECTION_PRESENT: 'section-present',
    SECTION_ABSENT: 'section-absent',
    SECTION_UNIQUE: 'section-unique',
    TOKEN_CEILING: 'token-ceiling',
    CONTENT_MATCH: 'content-match',
    WI_ACTIVATED: 'wi-activated',
    CACHE_PREFIX_STABLE: 'cache-prefix-stable',
});

export const ASSERTION_LABEL = Object.freeze({
    [ASSERTION.SECTION_PRESENT]: 'Section is present',
    [ASSERTION.SECTION_ABSENT]: 'Section is absent',
    [ASSERTION.SECTION_UNIQUE]: 'Section appears only once',
    [ASSERTION.TOKEN_CEILING]: 'Stays under a token limit',
    [ASSERTION.CONTENT_MATCH]: 'Text appears in the prompt',
    [ASSERTION.WI_ACTIVATED]: 'Lorebook entry activates',
    [ASSERTION.CACHE_PREFIX_STABLE]: 'Cached part of the prompt is stable',
});

/**
 * Caveats recorded on every run. A dry run cannot reproduce every step of a
 * real send, and the differences are surfaced rather than hidden.
 */
export const CAVEAT = Object.freeze({
    NO_INTERCEPTORS: 'no-interceptors',
    NO_SQUASH_LIVE: 'no-squash-live',
    PROMPT_TAGS_MISSING: 'prompt-tags-missing',
    CACHE_DEPTH_UNKNOWN: 'cache-depth-unknown',
    CACHE_BOUNDARY_PREDICTED: 'cache-boundary-predicted',
    TOKENIZER_FALLBACK: 'tokenizer-fallback',
    EXISTING_CHAT: 'existing-chat',
    LIVE_CHAT_DRY_RUN: 'live-chat-dry-run',
    MACRO_SANDBOX_UNAVAILABLE: 'macro-sandbox-unavailable',
    MACRO_ROLLBACK_UNCONFIRMED: 'macro-rollback-unconfirmed',
    FINAL_METRICS_INCOMPLETE: 'final-metrics-incomplete',
});

export const CAVEAT_TEXT = Object.freeze({
    [CAVEAT.NO_INTERCEPTORS]: 'Neconyan skips send-only generation interceptors during dry runs. The captured prompt and its checks are provisional, not the exact request a real send would use.',
    [CAVEAT.NO_SQUASH_LIVE]: 'Your setup merges consecutive system messages when sending. This analysis models that grouping itself rather than observing a real send, so message grouping may differ slightly.',
    [CAVEAT.PROMPT_TAGS_MISSING]: 'This test pins a Prompt Tags profile, but the Prompt Tags extension is not installed or enabled.',
    [CAVEAT.CACHE_DEPTH_UNKNOWN]: 'The prompt caching depth is unknown, so cache checks were skipped. Set it in Prompting Lab settings.',
    [CAVEAT.CACHE_BOUNDARY_PREDICTED]: 'Cache boundaries are predictions inferred from the captured prompt. The server does not report the actual boundary; this analysis follows Claude-style caching.',
    [CAVEAT.TOKENIZER_FALLBACK]: 'Token counts are estimates because the tokenizer was unavailable.',
    [CAVEAT.EXISTING_CHAT]: 'This character already had a chat open, and everything in it was part of the prompt, underneath the opening chosen here. Start a new chat in Neconyan for a scene that begins where you think it does.',
    [CAVEAT.LIVE_CHAT_DRY_RUN]: 'Neconyan has no isolated synthetic-message prompt builder. Generation starts observed while the test message is in live memory are held until it is removed; an overlapping test capture is discarded.',
    [CAVEAT.MACRO_SANDBOX_UNAVAILABLE]: 'Neconyan has no sandboxed dry-run macro API. Prompting Lab restores accessible local, global, and Macro Enhanced state and requests host saves, but cannot undo external macro side effects.',
    [CAVEAT.MACRO_ROLLBACK_UNCONFIRMED]: 'Prompting Lab restored macro state in memory, but this Neconyan build could not perform or confirm every persistence save needed for that rollback.',
    [CAVEAT.FINAL_METRICS_INCOMPLETE]: 'An observed dry-run hook changed the outbound messages after section token counts were built, so section and token metrics are incomplete. Send-only interceptors remain unobserved.',
});

export const TAB = Object.freeze({
    CASES: 'cases',
    PRESETS: 'presets',
    PROMPTS: 'prompts',
    RUN: 'run',
    LEDGER: 'ledger',
    DIFF: 'diff',
    EXPERIMENT: 'experiment',
    AB: 'ab',
    SCENES: 'scenes',
    SETTINGS: 'settings',
});

export const TAB_LABEL = Object.freeze({
    [TAB.CASES]: 'Tests',
    [TAB.PRESETS]: 'Presets',
    [TAB.PROMPTS]: 'Prompts',
    [TAB.RUN]: 'Run tests',
    [TAB.LEDGER]: 'Token ledger',
    [TAB.DIFF]: 'Compare runs',
    [TAB.EXPERIMENT]: 'Compare prompts',
    [TAB.AB]: 'Compare models',
    [TAB.SCENES]: 'Compare scenes',
    [TAB.SETTINGS]: 'Settings',
});

/**
 * What each tab is for, in the words the workspace shows around it: an icon
 * and a short line for the side rail, a sentence for the panel heading, and
 * whether opening this tab can end up spending tokens.
 */
export const TAB_META = Object.freeze({
    [TAB.CASES]: Object.freeze({
        icon: 'fa-vials',
        hint: 'Suites, test cases and their checks',
        blurb: 'A test case is one character and its prompt settings. A suite is a group of test cases that run together.',
        sends: false,
    }),
    [TAB.PRESETS]: Object.freeze({
        icon: 'fa-sliders',
        hint: 'Copy, edit and publish presets',
        blurb: 'Work on a copy of a preset without touching the one you rely on, then publish the copy as a new preset.',
        sends: false,
    }),
    [TAB.PROMPTS]: Object.freeze({
        icon: 'fa-align-left',
        hint: 'Single prompts and their versions',
        blurb: 'Prompts on their own, outside any preset, with as many draft versions of each as you like.',
        sends: false,
    }),
    [TAB.RUN]: Object.freeze({
        icon: 'fa-play',
        hint: 'Build every prompt in a suite',
        blurb: 'Rebuilds each prompt the way Neconyan would before sending it, then checks it and compares it against your baseline.',
        sends: false,
    }),
    [TAB.LEDGER]: Object.freeze({
        icon: 'fa-receipt',
        hint: 'Where the tokens of real replies went',
        blurb: 'Records the prompt behind each reply you actually send, with the token cost of every section, once recording is switched on. Recording stays off until you turn it on, and this tab never sends anything itself.',
        sends: false,
    }),
    [TAB.DIFF]: Object.freeze({
        icon: 'fa-code-compare',
        hint: 'Two runs, or two setups, side by side',
        blurb: 'Shows what changed between two runs of the same test case, section by section, with the token cost of each change. It can also build one test case under two setups, such as two presets, and compare those.',
        sends: false,
    }),
    [TAB.EXPERIMENT]: Object.freeze({
        icon: 'fa-flask',
        hint: 'Two wordings, one connection',
        blurb: 'Sends a prompt and a modified version of it through the same connection, with the same card and message, and puts the replies side by side.',
        sends: true,
    }),
    [TAB.AB]: Object.freeze({
        icon: 'fa-scale-balanced',
        hint: 'One prompt, two connections',
        blurb: 'Sends a saved prompt to two connections and shows both replies next to each other. Nothing is added to any chat.',
        sends: true,
    }),
    [TAB.SCENES]: Object.freeze({
        icon: 'fa-masks-theater',
        hint: 'One scene, several presets',
        blurb: 'Plays the same scene under each preset you pick, up to four exchanges deep, and puts what each one wrote side by side. Nothing is added to any chat.',
        sends: true,
    }),
    [TAB.SETTINGS]: Object.freeze({
        icon: 'fa-gear',
        hint: 'History, caching depth, transfer',
        blurb: 'How much run history to keep, the caching depth the cache checks need, and moving suites between installations.',
        sends: false,
    }),
});

/**
 * The order tabs appear in, and the headings the side rail groups them under.
 * Flattened, this is the tab order everywhere else in the lab.
 */
export const TAB_GROUPS = Object.freeze([
    Object.freeze({ id: 'build', label: 'Build', tabs: Object.freeze([TAB.CASES, TAB.PRESETS, TAB.PROMPTS]) }),
    Object.freeze({ id: 'run', label: 'Run', tabs: Object.freeze([TAB.RUN, TAB.LEDGER]) }),
    Object.freeze({ id: 'compare', label: 'Compare', tabs: Object.freeze([TAB.DIFF, TAB.EXPERIMENT, TAB.AB, TAB.SCENES]) }),
    Object.freeze({ id: 'setup', label: 'Set up', tabs: Object.freeze([TAB.SETTINGS]) }),
]);

export const TAB_ORDER = Object.freeze(TAB_GROUPS.flatMap(group => [...group.tabs]));

export const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: SETTINGS_VERSION,
    lastTab: TAB.CASES,
    manualCachingAtDepth: null,
    runRetention: 20,
    abMaxTokens: 300,
    normalizeVolatile: true,
    dismissedWarnings: Object.freeze({}),
    ledgerRetention: 200,
});

/** Regex input is untrusted; short catastrophic patterns can still backtrack. */
export const MAX_REGEX_LENGTH = 512;

export const MAX_EXPORT_BYTES = 1024 * 1024;
export const MAX_EXPORT_WITH_BASELINES_BYTES = 10 * 1024 * 1024;
