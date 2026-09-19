/**
 * Vendor library surface for the macro engine.
 *
 * The one specifier both runtimes understand is `#macro-vendor`: an internal
 * subpath import for Node and Bun (see the `imports` map in package.json) and
 * an import-map entry for the browser (see public/index.html, which points it
 * at the webpack bundle). Keeping the static re-export means webpack never has
 * to understand the specifier itself, because this file is served as-is.
 */
export { seedrandom, droll, moment, chevrotain } from '#macro-vendor';
