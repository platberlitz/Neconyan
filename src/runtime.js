import process from 'node:process';

export const APP_NAME = 'Neconyan';

export function isBunRuntime() {
    return typeof Bun !== 'undefined' || Boolean(process.versions?.bun);
}

export function isNativeTermuxEnvironment() {
    return Boolean(process.env.TERMUX_VERSION)
        || process.env.PREFIX === '/data/data/com.termux/files/usr'
        || (typeof process.env.HOME === 'string' && process.env.HOME.startsWith('/data/data/com.termux/files/home'));
}

export function isConstrainedMobileRuntime({ platform = process.platform, env = process.env } = {}) {
    if (env?.NECONYAN_ANDROID_APP === '1' || env?.NECONYAN_IOS_APP === '1') {
        return true;
    }
    if (platform === 'android') {
        return true;
    }
    if (env === process.env && platform === process.platform) {
        return isNativeTermuxEnvironment();
    }
    return Boolean(env?.TERMUX_VERSION)
        || env?.PREFIX === '/data/data/com.termux/files/usr'
        || (typeof env?.HOME === 'string' && env.HOME.startsWith('/data/data/com.termux/files/home'));
}

export function getRuntimeName() {
    if (isBunRuntime()) {
        return 'Bun';
    }

    if (process.versions?.node) {
        return 'Node.js';
    }

    return 'JavaScript runtime';
}

export function getRuntimeVersion() {
    return process.versions?.bun ?? process.version ?? 'unknown';
}

export function formatRuntimeLabel() {
    return `${getRuntimeName()} ${getRuntimeVersion()}`;
}
