import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import color from 'chalk';
import _ from 'lodash';
import { serverDirectory } from './server-directory.js';
import { keyToEnv, setConfigFilePath } from './util.js';

const keyMigrationMap = [
    {
        oldKey: 'disableThumbnails',
        newKey: 'thumbnails.enabled',
        migrate: (value) => !value,
    },
    {
        oldKey: 'thumbnailsQuality',
        newKey: 'thumbnails.quality',
        migrate: (value) => value,
    },
    {
        oldKey: 'avatarThumbnailsPng',
        newKey: 'thumbnails.format',
        migrate: (value) => (value ? 'png' : 'jpg'),
    },
    {
        oldKey: 'disableChatBackup',
        newKey: 'backups.chat.enabled',
        migrate: (value) => !value,
    },
    {
        oldKey: 'numberOfBackups',
        newKey: 'backups.common.numberOfBackups',
        migrate: (value) => value,
    },
    {
        oldKey: 'maxTotalChatBackups',
        newKey: 'backups.chat.maxTotalBackups',
        migrate: (value) => value,
    },
    {
        oldKey: 'chatBackupThrottleInterval',
        newKey: 'backups.chat.throttleInterval',
        migrate: (value) => value,
    },
    {
        oldKey: 'enableExtensions',
        newKey: 'extensions.enabled',
        migrate: (value) => value,
    },
    {
        oldKey: 'enableExtensionsAutoUpdate',
        newKey: 'extensions.autoUpdate',
        migrate: (value) => value,
    },
    {
        oldKey: 'minLogLevel',
        newKey: 'logging.minLogLevel',
        migrate: (value) => value,
    },
    {
        oldKey: 'cardsCacheCapacity',
        newKey: 'performance.memoryCacheCapacity',
        migrate: (value) => `${value}mb`,
    },
    {
        oldKey: 'cookieSecret',
        newKey: 'cookieSecret',
        migrate: () => void 0,
        remove: true,
    },
    {
        oldKey: 'autheliaAuth',
        newKey: 'sso.autheliaAuth',
        migrate: (value) => value,
    },
    {
        oldKey: 'authentikAuth',
        newKey: 'sso.authentikAuth',
        migrate: (value) => value,
    },
];

/**
 * Gets all keys from an object recursively.
 * @param {object} obj Object to get all keys from
 * @param {string} prefix Prefix to prepend to all keys
 * @returns {string[]} Array of all keys in the object
 */
function getAllKeys(obj, prefix = '') {
    if (typeof obj !== 'object' || Array.isArray(obj) || obj === null) {
        return [];
    }

    return _.flatMap(Object.keys(obj), key => {
        const newPrefix = prefix ? `${prefix}.${key}` : key;
        if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
            return getAllKeys(obj[key], newPrefix);
        } else {
            return [newPrefix];
        }
    });
}

const HOST_CHECK_MARKER_KEY = 'hostWhitelist.upgraded';

/**
 * Tells whether a hostname is one the host check always lets through, so it never needs listing.
 * @param {string} hostname Lower-cased hostname without a port
 * @returns {boolean} True for localhost names and IP addresses
 */
function isAlwaysAllowedHostname(hostname) {
    return hostname === 'localhost'
        || hostname.endsWith('.localhost')
        || hostname.startsWith('[')
        || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
        || hostname.includes(':');
}

/**
 * Tells whether the one-time host check switch has to wait because the environment, not the file,
 * decides `hostWhitelist.enabled` for now. Recording the marker then would leave the file's old
 * `false` in charge, silently, once the variable is removed.
 * @param {object} config Saved config, before defaults are merged in
 * @returns {boolean} True when the file still has the old `false`, no marker, and the variable is set
 */
function isHostCheckUpgradeWaiting(config) {
    return !_.has(config, HOST_CHECK_MARKER_KEY)
        && _.get(config, 'hostWhitelist.enabled') === false
        && keyToEnv('hostWhitelist.enabled') in process.env;
}

/**
 * Turns the host check on once for a config saved by a version that shipped it off.
 * Configs written before the check was on by default carry `hostWhitelist.enabled: false` from
 * the old template. They have no marker, so the first start on this version switches the check
 * on and records the marker; after that a deliberate `false` is left alone.
 * @param {object} config Saved config, before defaults are merged in
 * @returns {{ addedHosts: string[] }|null} What changed, or null when nothing did
 */
export function upgradeHostCheck(config) {
    if (!config || typeof config !== 'object' || _.has(config, HOST_CHECK_MARKER_KEY) || isHostCheckUpgradeWaiting(config)) {
        return null;
    }

    _.set(config, HOST_CHECK_MARKER_KEY, true);

    if (_.get(config, 'hostWhitelist.enabled') !== false) {
        return null;
    }

    _.set(config, 'hostWhitelist.enabled', true);

    const hosts = _.get(config, 'hostWhitelist.hosts');
    const hostList = Array.isArray(hosts) ? hosts : [];
    if (!Array.isArray(hosts)) {
        _.set(config, 'hostWhitelist.hosts', hostList);
    }

    // The server opens this name in the browser itself, so it would block its own launch otherwise.
    const addedHosts = [];
    const launchHostname = _.get(config, 'browserLaunch.hostname');
    if (typeof launchHostname === 'string') {
        const hostname = launchHostname.trim().toLowerCase();
        const listed = hostList.some(host => typeof host === 'string' && host.trim().toLowerCase() === hostname);
        if (hostname && hostname !== 'auto' && !isAlwaysAllowedHostname(hostname) && !listed) {
            hostList.push(hostname);
            addedHosts.push(hostname);
        }
    }

    return { addedHosts };
}

/**
 * Keeps a copy of config.yaml beside the real file before the one-time host check switch rewrites it,
 * since the rewrite drops its comments. An existing copy is never overwritten.
 * @param {string} configPath Path to config.yaml, which may be a symlink (as in the Docker image)
 * @returns {{ path: string, created: boolean }|null} The copy, and whether this call made it, or null when none could be kept
 */
function keepConfigCopy(configPath) {
    let realPath;
    let copyPath;
    try {
        realPath = fs.realpathSync(configPath);
        copyPath = `${realPath}.before-host-check`;
        if (fs.existsSync(copyPath)) {
            return { path: copyPath, created: false };
        }
        fs.copyFileSync(realPath, copyPath, fs.constants.COPYFILE_EXCL);
    } catch (error) {
        console.warn(color.yellow('Could not keep a copy of config.yaml before switching host checking on:'), error.message);
        return null;
    }
    try {
        fs.chmodSync(copyPath, fs.statSync(realPath).mode & 0o777);
    } catch (error) {
        console.warn(color.yellow(`Kept a copy of config.yaml in ${copyPath}, but could not give it the same permissions as the original:`), error.message);
    }
    return { path: copyPath, created: true };
}

/**
 * Errors after which config.yaml is written in place instead: the folder takes no new files while the
 * file itself is writable, or the file is a single-file bind mount that cannot be renamed over.
 * A full disk is not among them, because writing in place is what leaves a half-written file.
 */
const WRITE_IN_PLACE_CODES = new Set(['EACCES', 'EPERM', 'EBUSY', 'EXDEV']);

/**
 * Replaces config.yaml through a temporary file beside it and a rename, so a full disk leaves the old
 * file whole rather than cut short. The replacement keeps the original's permissions.
 * @param {string} realPath Resolved path of config.yaml
 * @param {string} text New contents
 */
function replaceConfigFile(realPath, text) {
    // A file the owner made read-only stays as it is, even where the folder would let it be replaced.
    fs.accessSync(realPath, fs.constants.W_OK);
    const original = fs.statSync(realPath);
    const tmpPath = path.join(path.dirname(realPath), `.${path.basename(realPath)}.${process.pid}.tmp`);
    const removeTmp = () => {
        try {
            fs.rmSync(tmpPath, { force: true });
        } catch {
            // The error that brought us here is the one worth reporting.
        }
    };

    try {
        fs.writeFileSync(tmpPath, text, { flag: 'wx', mode: 0o600 });
    } catch (error) {
        removeTmp();
        if (!WRITE_IN_PLACE_CODES.has(error.code)) {
            throw error;
        }
        fs.writeFileSync(realPath, text);
        return;
    }

    try {
        fs.chmodSync(tmpPath, original.mode & 0o777);
        if (process.getuid && (original.uid !== process.getuid() || original.gid !== process.getgid())) {
            fs.chownSync(tmpPath, original.uid, original.gid);
        }
    } catch (error) {
        console.warn(color.yellow(`Could not give the updated ${realPath} the same owner and permissions as before:`), error.message);
    }

    try {
        fs.renameSync(tmpPath, realPath);
    } catch (error) {
        removeTmp();
        if (!WRITE_IN_PLACE_CODES.has(error.code)) {
            throw error;
        }
        fs.writeFileSync(realPath, text);
    }
}

/**
 * Whether the file at filePath still holds exactly the given bytes.
 * @param {string} filePath File to check
 * @param {Buffer} bytes Expected contents
 * @returns {boolean}
 */
function fileStillHolds(filePath, bytes) {
    try {
        return Buffer.compare(fs.readFileSync(filePath), bytes) === 0;
    } catch {
        return false;
    }
}

/**
 * Prints what the one-time host check switch did and how to adjust it.
 * @param {{ addedHosts: string[] }} upgrade Result of upgradeHostCheck
 * @param {string} configPath Path to config.yaml
 * @param {string|null} copyPath Path of the copy kept before the rewrite
 */
function logHostCheckUpgrade({ addedHosts }, configPath, copyPath) {
    // Name the real file, so a Docker log points into the config volume rather than at the link.
    try {
        configPath = fs.realpathSync(configPath);
    } catch {
        // Keep the path as given.
    }
    console.warn(color.yellow('Host checking is now on.'), 'Neconyan only answers requests addressed to localhost, an IP address or a name listed in', color.yellow('hostWhitelist.hosts') + '.');
    if (addedHosts.length > 0) {
        console.warn('Added the browser launch hostname to the list:', addedHosts.join(', '));
    }
    console.warn(`If you open Neconyan through a domain name (a reverse proxy, a tunnel or a local DNS name), add that name under ${color.yellow('hostWhitelist')} -> ${color.yellow('hosts')} in ${color.green(configPath)} and restart.`);
    console.warn(`To keep host checking off instead, set ${color.yellow('hostWhitelist.enabled')} back to false there. The file now records this switch, so it is not made again.`);
    if (copyPath) {
        console.warn('A copy of the file as it was before this change, comments included, is kept in', color.green(copyPath));
        console.warn(`That copy does not record the switch: if you put it back in place of the file and want host checking to stay off, add ${color.yellow('upgraded: true')} under ${color.yellow('hostWhitelist')} in it, or set ${color.yellow('hostWhitelist.enabled')} to false in the current file instead.`);
    }
}

/**
 * Compares the current config.yaml with the default config.yaml and adds any missing values.
 * @param {string} configPath Path to config.yaml
 */
export function addMissingConfigValues(configPath) {
    try {
        const defaultConfig = yaml.parse(fs.readFileSync(path.join(serverDirectory, './default/config.yaml'), 'utf8'));

        if (!fs.existsSync(configPath)) {
            console.warn(color.yellow(`Warning: config.yaml not found at ${configPath}. Creating a new one with default values.`));
            fs.writeFileSync(configPath, yaml.stringify(defaultConfig));
            return;
        }

        let config = yaml.parse(fs.readFileSync(configPath, 'utf8'));

        // Migrate old keys to new keys
        const migratedKeys = [];
        for (const { oldKey, newKey, migrate, remove } of keyMigrationMap) {
            // Migrate environment variables
            const oldEnvKey = keyToEnv(oldKey);
            const newEnvKey = keyToEnv(newKey);
            if (process.env[oldEnvKey] && !process.env[newEnvKey]) {
                const oldValue = process.env[oldEnvKey];
                const newValue = migrate(oldValue);
                process.env[newEnvKey] = newValue;
                delete process.env[oldEnvKey];
                console.warn(color.yellow(`Warning: Using a deprecated environment variable: ${oldEnvKey}. Please use ${newEnvKey} instead.`));
                console.log(`Redirecting ${color.blue(oldEnvKey)}=${oldValue} -> ${color.blue(newEnvKey)}=${newValue}`);
            }

            if (_.has(config, oldKey)) {
                if (remove) {
                    _.unset(config, oldKey);
                    migratedKeys.push({
                        oldKey,
                        newValue: void 0,
                    });
                    continue;
                }

                const oldValue = _.get(config, oldKey);
                const newValue = migrate(oldValue);
                _.set(config, newKey, newValue);
                _.unset(config, oldKey);

                migratedKeys.push({
                    oldKey,
                    newKey,
                    oldValue,
                    newValue,
                });
            }
        }

        // Get all keys from the original config
        const originalKeys = getAllKeys(config);

        // While the environment decides hostWhitelist.enabled over an old `false`, the template's
        // marker stays out too, or the switch would be skipped for good once the variable is gone.
        const defaults = isHostCheckUpgradeWaiting(config) ? _.omit(defaultConfig, HOST_CHECK_MARKER_KEY) : defaultConfig;
        const hostCheckUpgrade = upgradeHostCheck(config);

        // Use lodash's defaultsDeep function to recursively apply default properties
        config = _.defaultsDeep(config, defaults);

        // Get all keys from the updated config
        const updatedKeys = getAllKeys(config);

        // Find the keys that were added
        const addedKeys = _.difference(updatedKeys, originalKeys);

        if (addedKeys.length === 0 && migratedKeys.length === 0 && !hostCheckUpgrade) {
            return;
        }

        if (addedKeys.length > 0) {
            console.log('Adding missing config values to config.yaml:', addedKeys);
        }

        if (migratedKeys.length > 0) {
            console.log('Migrating config values in config.yaml:', migratedKeys);
        }

        if (!hostCheckUpgrade) {
            fs.writeFileSync(configPath, yaml.stringify(config));
            return;
        }

        const realPath = fs.realpathSync(configPath);
        const originalBytes = fs.readFileSync(realPath);
        const copy = keepConfigCopy(configPath);
        try {
            replaceConfigFile(realPath, yaml.stringify(config));
        } catch (error) {
            if (!fileStillHolds(realPath, originalBytes)) {
                const kept = copy ? `The file as it was before, comments included, is kept in ${color.green(copy.path)}.` : 'No copy of the file as it was before could be kept.';
                console.warn(color.red(`Could not finish writing ${realPath}, so it may only have been partially written:`), error.message);
                console.warn(`Check that file before starting Neconyan again. ${kept}`);
                return;
            }
            console.warn(color.yellow(`Could not update ${realPath}, so host checking stays off:`), error.message);
            // Nothing was switched, so a copy made just now would only go stale beside the file.
            // It goes only while the file still matches it byte for byte.
            if (copy?.created) {
                try {
                    if (fileStillHolds(realPath, fs.readFileSync(copy.path))) {
                        fs.rmSync(copy.path, { force: true });
                    }
                } catch {
                    // A stale copy is harmless beside an unchanged file.
                }
            }
            return;
        }
        logHostCheckUpgrade(hostCheckUpgrade, configPath, copy?.path ?? null);
    } catch (error) {
        console.warn(color.yellow('Could not add missing config values to config.yaml'), error);
    }
}

/**
 * Performs early initialization tasks before the server starts.
 * @param {string} configPath Path to config.yaml
 */
export function initConfig(configPath) {
    console.log('Using config path:', color.green(configPath));
    setConfigFilePath(configPath);
    addMissingConfigValues(configPath);
}
