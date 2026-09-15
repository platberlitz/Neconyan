export const MODULE_NAME = 'Neconyan-Regex-Agent-Themes';
export const EXTENSION_PATH = `third-party/${MODULE_NAME}`;

/**
 * Bumped whenever a renderer changes shape. It is embedded in the `data-rat` marker on
 * every generated root element, so a bump makes previously applied themes read as
 * `outdated` and get regenerated on the next reconcile pass.
 */
export const ENGINE_VERSION = 2;

export const DRAWER_ID = 'rat_drawer';
export const SETTINGS_KEY = MODULE_NAME;

/** Prefix for regex scripts this extension appends to an agent. */
export const OWNED_SCRIPT_PREFIX = 'rat:';

/** Sentinel theme id meaning "leave the stock markup alone". */
export const STOCK_THEME = 'stock';
