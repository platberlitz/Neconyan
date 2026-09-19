/**
 * Node/Bun half of the macro vendor seam.
 *
 * The browser half lives in public/index.html's import map, which maps
 * `#macro-vendor` straight at the webpack bundle. Node and Bun cannot use an
 * import map, so package.json's `imports` field points the same specifier here.
 * Both halves therefore expose the identical four bindings from one specifier,
 * and the shared macro modules stay free of runtime branching.
 */
export { default as seedrandom } from 'seedrandom';
export { default as droll } from 'droll';
export { default as moment } from 'moment';
export * as chevrotain from 'chevrotain';
