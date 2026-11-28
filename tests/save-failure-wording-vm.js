import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/save-failure-wording.js', import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/^export /gm, '');

/**
 * Runs the real save failure wording inside a vm context that provides `t` and `showSaveFailureNotice`.
 * @param {object} context vm context
 */
export function loadSaveFailureWording(context) {
    context.noteSaveFailure ??= () => {};
    vm.runInContext(source, context);
}
