import { isIP } from 'node:net';

// Only these leaves differ from the bundled desktop defaults. Saved preferences
// are retained; factory and recovered documents receive the whole table.
export const ANDROID_CONFIG_DEFAULTS = Object.freeze({
    listen: true,
    'listenAddress.ipv4': '127.0.0.1',
    'listenAddress.ipv6': '::1',
    'protocol.ipv4': true,
    'protocol.ipv6': false,
    'ssl.enabled': false,
    basicAuthMode: true,
    perUserBasicAuth: false,
    enableUserAccounts: false,
    enableServerPlugins: false,
    enableServerPluginsAutoUpdate: false,
    'browserLaunch.enabled': false,
    'extensions.autoUpdate': false,
    'git.backend': 'builtin',
    'performance.frontendBuild.enabled': true,
    'logging.enableAccessLog': false,
});

const requirements = {
    dataRoot: 'The Android app uses its private data folder for backups and notifications.',
    port: 'The Android launcher manages the port used by its WebView and readiness checks.',
    listen: 'The Android app needs listen enabled for native browser sign-in.',
    basicAuthMode: 'The Android app needs global basic authentication for native browser sign-in.',
    'basicAuthUser.username': 'The Android launcher manages the global sign-in credentials.',
    'basicAuthUser.password': 'The Android launcher manages the global sign-in credentials.',
    perUserBasicAuth: 'Native sign-in uses the global identity, not per-user credentials.',
    enableUserAccounts: 'The Android recovery backup currently covers only the default account.',
    'protocol.ipv4': 'The native WebView requires a working IPv4 listener; use true or auto.',
    'listenAddress.ipv4': 'The native WebView requires loopback access; use 127.0.0.1 or 0.0.0.0.',
    'ssl.enabled': 'The native WebView uses an HTTP origin.',
    'browserLaunch.enabled': 'The Android app uses its native WebView instead of a desktop browser launcher.',
    'extensions.autoUpdate': 'Automatic extension updates require system Git, which the APK does not supply.',
    enableServerPluginsAutoUpdate: 'Automatic server plugin updates require system Git, which the APK does not supply.',
    'git.backend': 'The APK does not supply system Git; use builtin or auto.',
};
const containers = ['listenAddress', 'protocol', 'ssl', 'basicAuthUser', 'browserLaunch', 'extensions', 'git', 'logging', 'performance', 'performance.frontendBuild'];
const listenerFields = ['listen', 'listenAddress.ipv4', 'listenAddress.ipv6', 'protocol.ipv4', 'protocol.ipv6', 'ssl.enabled'];

function get(config, field) {
    return field.split('.').reduce((value, key) => value?.[key], config);
}

function set(config, field, value) {
    const keys = field.split('.');
    let target = config;
    for (const key of keys.slice(0, -1)) target = target[key] ??= {};
    target[keys.at(-1)] = value;
}

function reject(field, reason) {
    const error = new Error(`Cannot use ${field} in the Android app. ${reason}`);
    error.status = 400;
    throw error;
}

function mapping(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateShape(config) {
    if (!mapping(config)) reject('config', 'Use a YAML mapping of configuration fields.');
    for (const field of containers) {
        const value = get(config, field);
        if (value !== undefined && !mapping(value)) reject(field, 'Use a YAML mapping for this section.');
    }
}

function validIPv6(value) {
    // WHATWG URLs cannot represent scoped zone identifiers, even though isIP
    // accepts them. Reject before Save rather than failing on the next launch.
    if (typeof value !== 'string' || value.includes('%')) return false;
    const address = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    return isIP(address) === 6;
}

function validateListenerField(config, field) {
    const value = get(config, field);
    if (value === undefined) return;
    if (field === 'listenAddress.ipv6') {
        if (!validIPv6(value)) reject(field, 'Use a valid IPv6 address, optionally enclosed in brackets, without a zone identifier.');
    } else if (field === 'protocol.ipv6') {
        if (![true, false, 'auto'].includes(value)) reject(field, 'Use true, false or auto.');
    } else if (field === 'protocol.ipv4') {
        if (value !== true && value !== 'auto') reject(field, requirements[field]);
    } else if (field === 'listenAddress.ipv4') {
        if (value !== '127.0.0.1' && value !== '0.0.0.0') reject(field, requirements[field]);
    } else if (value !== ANDROID_CONFIG_DEFAULTS[field]) {
        reject(field, requirements[field]);
    }
}

/** Reject invalid transport before startup; runtime bind errors remain real failures. */
export function validateAndroidListenerConfig(config) {
    validateShape(config);
    for (const field of listenerFields) validateListenerField(config, field);
    for (const field of ['enableServerPlugins', 'logging.enableAccessLog', 'performance.frontendBuild.enabled']) {
        const value = get(config, field);
        if (value !== undefined && typeof value !== 'boolean') reject(field, 'Use true or false.');
    }
}

function requiredValues(managed) {
    return {
        dataRoot: managed.dataRoot,
        port: managed.port,
        'basicAuthUser.username': managed.basicAuthUser.username,
        'basicAuthUser.password': managed.basicAuthUser.password,
        ...Object.fromEntries(Object.keys(requirements)
            .filter(field => field in ANDROID_CONFIG_DEFAULTS && !['protocol.ipv4', 'listenAddress.ipv4', 'git.backend'].includes(field))
            .map(field => [field, ANDROID_CONFIG_DEFAULTS[field]])),
    };
}

/** Validate without changing the submitted object or including its values in errors. */
export function validateAndroidConfigEdit(config, managed) {
    validateAndroidListenerConfig(config);
    for (const [field, expected] of Object.entries(requiredValues(managed))) {
        const value = get(config, field);
        if (value !== undefined && value !== expected) reject(field, requirements[field]);
    }
    if (get(config, 'git.backend') !== undefined && !['builtin', 'auto'].includes(get(config, 'git.backend'))) {
        reject('git.backend', requirements['git.backend']);
    }
}

/** The iPhone launcher owns only its data folder, port, plain-HTTP origin and sign-in; other fields stay editable. */
export function validateIOSConfigEdit(config, managed) {
    validateShape(config);
    const expected = {
        dataRoot: managed.dataRoot,
        port: managed.port,
        'ssl.enabled': false,
        'basicAuthUser.username': managed.basicAuthUser.username,
        'basicAuthUser.password': managed.basicAuthUser.password,
    };
    for (const [field, value] of Object.entries(expected)) {
        if (get(config, field) !== undefined && get(config, field) !== value) {
            const error = new Error(`Cannot use ${field} in the iPhone app. The launcher manages this setting.`);
            error.status = 400;
            throw error;
        }
    }
}

/** Apply Android defaults and launcher requirements to a loader-owned document. */
export function applyAndroidConfigPolicy(config, { source, managed }) {
    validateShape(config);
    const repairs = [];
    for (const [field, value] of Object.entries(ANDROID_CONFIG_DEFAULTS)) {
        if (source !== 'saved' || get(config, field) === undefined) set(config, field, value);
    }
    for (const [field, value] of Object.entries(requiredValues(managed))) {
        if (source === 'saved' && get(config, field) !== undefined && get(config, field) !== value) {
            repairs.push({ field, reason: requirements[field] });
        }
        set(config, field, value);
    }
    if (!['builtin', 'auto'].includes(config.git.backend)) {
        repairs.push({ field: 'git.backend', reason: requirements['git.backend'] });
        config.git.backend = 'builtin';
    }
    validateAndroidConfigEdit(config, managed);
    return { config, repairs };
}
