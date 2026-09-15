// Shared utilities for the Quick Reply extension.
//
// Having a dedicated module under src/ lets the other src/*.js files avoid
// importing back into ../index.js. That back-edge was the source of a
// duplicate-drawer bug: the extension loader tags index.js with a cache-
// busting ?v=<version> query, so children that did `from '../index.js'`
// resolved to the bare URL and the browser treated them as a second
// module instance. Two evaluations meant two init() calls, two SettingsUi
// renders, and every eventSource handler getting registered twice.
export { debounceAsync } from '../../../utils.js';

const _VERBOSE = true;
export const debug = (...msg) => _VERBOSE ? console.debug('[QR2]', ...msg) : null;
export const log = (...msg) => _VERBOSE ? console.log('[QR2]', ...msg) : null;
export const warn = (...msg) => _VERBOSE ? console.warn('[QR2]', ...msg) : null;
