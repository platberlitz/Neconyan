export const MIN_AUTO_CLOSE_TOAST_MS = 5000;

const TOAST_METHODS = ['info', 'success', 'warning', 'error'];
const INSTALLED = Symbol.for('neconyan.toastMinimumDuration');

function raiseDuration(value) {
    return typeof value === 'number' && value > 0 && value < MIN_AUTO_CLOSE_TOAST_MS
        ? MIN_AUTO_CLOSE_TOAST_MS
        : value;
}

/**
 * Returns toast options where any auto-close delay shorter than the minimum is raised to it.
 * Zero (stay until dismissed) and longer delays are left alone.
 * @param {object} [options]
 * @returns {object|undefined}
 */
export function withMinimumToastDuration(options) {
    if (!options || typeof options !== 'object') {
        return options;
    }
    let raised = options;
    for (const key of ['timeOut', 'extendedTimeOut']) {
        const value = raiseDuration(options[key]);
        if (value !== options[key]) {
            raised = { ...raised, [key]: value };
        }
    }
    return raised;
}

/**
 * Makes every auto-closing toast stay on screen for at least MIN_AUTO_CLOSE_TOAST_MS.
 * @param {object} toastrApi The global toastr object
 */
export function installToastMinimumDuration(toastrApi) {
    if (!toastrApi || toastrApi[INSTALLED]) {
        return;
    }
    if (toastrApi.options) {
        toastrApi.options = withMinimumToastDuration(toastrApi.options);
    }
    for (const method of TOAST_METHODS) {
        const original = toastrApi[method];
        if (typeof original !== 'function') {
            continue;
        }
        toastrApi[method] = function (message, title, optionsOverride, ...rest) {
            return original.call(this, message, title, withMinimumToastDuration(optionsOverride), ...rest);
        };
    }
    toastrApi[INSTALLED] = true;
}
