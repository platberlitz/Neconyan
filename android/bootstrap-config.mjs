// Older saved app configurations predate some sections the launchers write
// (browserLaunch, extensions, git, logging, performance). Missing containers are
// created in place so an old saved file cannot crash every launch, including safe
// starts, before the normal configuration migration runs. A saved value that is
// not a container is malformed. The Android and iPhone launchers share this file.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const sections = ['browserLaunch', 'extensions', 'git', 'logging', 'performance', 'performance.frontendBuild'];

function malformed(fileName, sectionPath) {
    const where = sectionPath ? ` has a malformed '${sectionPath}' section` : ' is malformed';
    return new Error(`The saved app configuration${where}; fix or remove ${fileName} to start Neconyan.`);
}

function ensureContainer(parent, key, sectionPath, fileName) {
    const value = parent[key];
    if (value === undefined || value === null) {
        const created = {};
        parent[key] = created;
        return created;
    }
    if (typeof value !== 'object' || Array.isArray(value)) throw malformed(fileName, sectionPath);
    return value;
}

export function ensureBootstrapConfigSections(config, fileName = 'android-config.yaml') {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) throw malformed(fileName);
    // Validate every required container before creating anything, so a malformed
    // configuration is rejected without mutating the saved object at all.
    for (const sectionPath of sections) {
        let target = config;
        for (const part of sectionPath.split('.')) {
            const value = target[part];
            if (value === undefined || value === null) break;
            if (typeof value !== 'object' || Array.isArray(value)) throw malformed(fileName, sectionPath);
            target = value;
        }
    }
    for (const sectionPath of sections) {
        const parts = sectionPath.split('.');
        let target = config;
        for (let index = 0; index < parts.length - 1; ++index) {
            target = ensureContainer(target, parts[index], sectionPath, fileName);
        }
        ensureContainer(target, parts.at(-1), sectionPath, fileName);
    }
    return config;
}

/**
 * Reads the saved launcher configuration, or the bundled default when there is none.
 * A saved file that cannot be used used to stop every launch for good; it is now set
 * aside beside the original name and the app starts from the default. Chats and
 * characters live in the data folder, not in this file.
 */
export function loadBootstrapConfig(configPath, defaultPath, now = Date.now) {
    const fileName = path.basename(configPath);
    const readDefault = () => ensureBootstrapConfigSections(YAML.parse(fs.readFileSync(defaultPath, 'utf8')), fileName);
    if (!fs.existsSync(configPath)) return { config: readDefault(), setAside: null, reason: null };
    // A read failure (storage trouble) propagates; only contents that cannot be used are set aside.
    const saved = fs.readFileSync(configPath, 'utf8');
    try {
        return { config: ensureBootstrapConfigSections(YAML.parse(saved), fileName), setAside: null, reason: null };
    } catch (error) {
        const setAside = `${configPath}.broken-${now()}`;
        fs.renameSync(configPath, setAside);
        return { config: readDefault(), setAside, reason: String(error?.message ?? error) };
    }
}

export function setAsideNotice(setAside) {
    return `Neconyan's saved app settings file could not be read, so it started with default settings. Your chats and characters are untouched. The old file was kept as ${path.basename(setAside)}.`;
}
