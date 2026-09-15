/**
 * Shared contract between the frontend extension and the server plugin.
 *
 * Loaded by BOTH halves: by Node from disk, and by the browser over HTTP from
 * /scripts/extensions/third-party/Neconyan-BotSearcher/shared/schema.js.
 * It must therefore stay pure ESM with no `node:` imports and no DOM access.
 *
 * The frontend and server plugin are installed as separate git clones and can drift, so every
 * response carries PROTOCOL_VERSION and the client refuses to talk to a server
 * that reports a different one.
 */

/** Protocol 8 adds inside.scan={complete,reasons} and changes merged-search cursors. */
export const PROTOCOL_VERSION = 8;

/**
 * How many sources one search may fan out to.
 *
 * Each source in a search is another upstream request. Eight covers every
 * searchable source today, so "All sources" means all of them; the per-source
 * limiters in server/limits.js are what protect the sites and the box, and the
 * page budget is shared out between the sources rather than multiplied.
 */
export const MAX_FANOUT = 8;

/** Release version. `tests/invariants.test.js` asserts this matches package.json and manifest.json. */
export const VERSION = '0.9.0';

export const PLUGIN_ID = 'neconyan-botsearcher';

/** Directory name of the frontend extension; also the repo name. */
export const EXTENSION_NAME = 'Neconyan-BotSearcher';

/** Repository identity pinned by the host-owned exact-release updater. */
export const REPOSITORY_URL = 'https://github.com/SillyBunnyTeam/SillyBunny-BotSearcher.git';

/**
 * Fields a normalized search result may contain. `server/normalize.js` builds
 * records by picking from this list — it never spreads an upstream object, so
 * unknown upstream fields can never reach the DOM.
 */
export const CARD_SUMMARY_FIELDS = Object.freeze([
    'source',
    'id',
    'name',
    'tagline',
    'creator',
    'tags',
    'contentRating',
    'stats',
    'createdAt',
    // Absolute https thumbnail URL, built by the adapter and host-checked twice
    // (server before it is sent, client before it reaches an <img>). Used in
    // 'direct' image mode.
    'thumbUrl',
    // Opaque HMAC-signed token for the /thumb proxy. Added in Phase 2.
    'thumbRef',
    'pageUrl',
    'importUrl',
    'nativeImport',
]);

/** Detail adds the long-form text fields. Same whitelist discipline. */
export const CARD_DETAIL_FIELDS = Object.freeze([
    ...CARD_SUMMARY_FIELDS,
    'description',
    'firstMessage',
    'creatorNotes',
    'inside',
]);

/**
 * Per-field length caps, applied server-side by `str()` before the client ever sees them.
 *
 * `id` is 256 rather than 128 because Chub's identifier is "creator/slug", whose
 * own pattern allows 64 + 1 + 160 characters. At 128 a long slug was silently
 * truncated, the truncated string still matched the adapter's id pattern, and the
 * resulting detail request 404'd — which health.js classifies as a hard failure,
 * so one such card removed the whole source for half an hour.
 */
export const FIELD_LIMITS = Object.freeze({
    id: 256,
    shortText: 200,
    longText: 8000,
    tagLength: 48,
    tagCount: 32,
    itemsPerPage: 48,
    accountUsername: 64,
    accountPassword: 1024,
    accountToken: 8192,
});

/**
 * Request body cap enforced by the plugin after host parsing. Deployments must
 * also enforce this limit before the host's global parser at their proxy/host
 * boundary.
 */
export const MAX_REQUEST_BYTES = 8192;

/**
 * Body cap for /ingest only, which carries a source's raw search or detail
 * response rather than a handful of query fields. Matched to the largest
 * `maxBytes` any adapter passes to fetchJson, so the direct path cannot accept
 * a payload the server-side path would have refused.
 */
export const MAX_INGEST_BYTES = 6 << 20;

/** Maximum card file size accepted by both the server route and browser importer. */
export const MAX_CARD_BYTES = 8 << 20;

/**
 * Kinds of upstream payload /ingest will normalize. Each maps to an adapter
 * `parse*` method; nothing else is dispatchable.
 */
export const INGEST_KINDS = Object.freeze(['search', 'detail']);

export const IMAGE_MODES = Object.freeze(['proxy', 'direct', 'off']);

/**
 * Filter control kinds an adapter may declare. The client builds its filter UI from
 * what each source declares, so a control only ever appears when the source
 * behind it can actually apply the filter — the same rule the SFW toggle
 * follows. A source that declares nothing shows nothing, rather than showing a
 * control that quietly does nothing.
 */
export const FILTER_TYPES = Object.freeze(['tags', 'text', 'number', 'boolean', 'date']);

/** Caps applied to filter values server-side, before any adapter sees them. */
export const FILTER_LIMITS = Object.freeze({
    tagCount: 8,
    tagLength: 48,
    textLength: 64,
    numberMin: 0,
    numberMax: 1_000_000,
});

/** Honest content classification: unknown must never be presented as safe. */
export const CONTENT_RATINGS = Object.freeze(['sfw', 'sensitive', 'unknown']);

export const THUMB_SIZES = Object.freeze(['grid', 'detail']);

/** Source health states surfaced by /healthz. */
export const SOURCE_STATES = Object.freeze(['up', 'unknown', 'down']);
