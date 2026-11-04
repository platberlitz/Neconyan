// Older saved Android configurations predate some sections this launcher writes
// (browserLaunch, extensions, git, logging, performance). Missing containers are
// created in place so an old android-config.yaml cannot crash every launch,
// including safe starts, before the normal configuration migration runs.
// A saved value that is not a container is malformed: the launcher fails with a
// clear message and never writes the user's file back to disk.

const sections = ['browserLaunch', 'extensions', 'git', 'logging', 'performance', 'performance.frontendBuild'];

function ensureContainer(parent, key, sectionPath) {
    const value = parent[key];
    if (value === undefined || value === null) {
        const created = {};
        parent[key] = created;
        return created;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`The saved Android configuration has a malformed '${sectionPath}' section; fix or remove android-config.yaml to start Neconyan.`);
    }
    return value;
}

export function ensureBootstrapConfigSections(config) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        throw new Error('The saved Android configuration is malformed; fix or remove android-config.yaml to start Neconyan.');
    }
    // Validate every required container before creating anything, so a malformed
    // configuration is rejected without mutating the saved object at all.
    for (const sectionPath of sections) {
        const parts = sectionPath.split('.');
        let target = config;
        for (const part of parts) {
            const value = target[part];
            if (value === undefined || value === null) break;
            if (typeof value !== 'object' || Array.isArray(value)) {
                throw new Error(`The saved Android configuration has a malformed '${sectionPath}' section; fix or remove android-config.yaml to start Neconyan.`);
            }
            target = value;
        }
    }
    for (const sectionPath of sections) {
        const parts = sectionPath.split('.');
        let target = config;
        for (let index = 0; index < parts.length - 1; ++index) {
            target = ensureContainer(target, parts[index], sectionPath);
        }
        ensureContainer(target, parts.at(-1), sectionPath);
    }
    return config;
}
