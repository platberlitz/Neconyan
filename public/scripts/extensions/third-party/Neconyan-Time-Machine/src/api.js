/**
 * Everything that talks to Neconyan: taking a snapshot, reading the current
 * state to compare against, and putting a version back.
 *
 * The division of labour with the host is deliberate.
 *
 * Characters, lorebooks and presets are separate files on disk and nothing in
 * Neconyan backs any of them up — only chats and settings.json have backups.
 * So this extension captures those three itself.
 *
 * Extension settings live in settings.json, which the server copies into its
 * backup folder. For those this reads the host's own backups and puts one safe
 * extension-owned block back without replacing the whole settings file.
 */
import { cardFromCharacter, isPlainObject, restorePayload } from './core.js';
import { commitSettings, getSettings, MODULE_NAME, save } from './store.js';

const RESERVED_EXTENSION_KEYS = new Set([
    MODULE_NAME,
    '__proto__',
    'prototype',
    'constructor',
    'attachments',
    'character_attachments',
    'disabledExtensions',
]);

const captureSuppressions = new Map();
const PRESET_CHANGE_APIS = new Set(['kobold', 'novel', 'openai', 'textgenerationwebui']);
const NAMED_PRESET_APIS = new Set(['instruct', 'context', 'sysprompt', 'reasoning']);

function ctx() {
    return globalThis.SillyTavern.getContext();
}

async function post(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const error = new Error(`${url} responded ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response;
}

function captureKey(kind, target) {
    return `${kind}:${target}`;
}

function isCaptureSuppressed(kind, target) {
    return captureSuppressions.has(captureKey(kind, target));
}

async function suppressCapture(kind, target, action) {
    const key = captureKey(kind, target);
    captureSuppressions.set(key, (captureSuppressions.get(key) ?? 0) + 1);
    try {
        return await action();
    } finally {
        const remaining = captureSuppressions.get(key) - 1;
        if (remaining > 0) {
            captureSuppressions.set(key, remaining);
        } else {
            captureSuppressions.delete(key);
        }
    }
}

function waitForPresetChange(apiId) {
    const context = ctx();
    const type = context.eventTypes?.PRESET_CHANGED;
    if (!type || !PRESET_CHANGE_APIS.has(apiId)) {
        return { promise: Promise.resolve(), cancel() {} };
    }
    let timer;
    let listener;
    let finish;
    const promise = new Promise(resolve => {
        let finished = false;
        finish = () => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timer);
            context.eventSource.removeListener(type, listener);
            resolve();
        };
        listener = (data = {}) => {
            if (data.apiId === apiId) {
                finish();
            }
        };
        context.eventSource.on(type, listener);
        timer = setTimeout(finish, 10_000);
    });
    return {
        promise,
        cancel: finish,
    };
}

function partialRestore(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.partial = true;
    return failure;
}

function isRestorableExtensionBlock(key, value) {
    return typeof key === 'string' && !RESERVED_EXTENSION_KEYS.has(key) && isPlainObject(value);
}

// ---------------------------------------------------------------- capture ---

/**
 * @param {string} avatar the character's avatar filename, which is its identity
 *   everywhere: chats, tags, and the last-chat sidecar are all keyed to it.
 */
export async function captureCharacter(avatar, { force = false } = {}) {
    if (isCaptureSuppressed('character', avatar) || (!force && !getSettings().captureCharacters)) {
        return null;
    }
    const context = ctx();
    const live = context.characters ?? [];
    const index = live.findIndex(character => character?.avatar === avatar);
    if (index === -1) {
        return null;
    }
    // A shallow entry has no definitions at all, so snapshotting one would store
    // an empty description as though the user had cleared it.
    await context.unshallowCharacter(index);
    const character = (context.characters ?? []).find(item => item?.avatar === avatar);
    const card = cardFromCharacter(character);
    if (!character || !card) {
        return null;
    }
    const tags = context.tagMap?.[avatar] ?? [];
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) {
        throw new Error(`Neconyan returned malformed tags for ${avatar}`);
    }

    return save({
        kind: 'character',
        target: avatar,
        label: character.name || avatar,
        data: card,
        // Tags are not in the card. They live in settings.json keyed by avatar
        // and are deleted outright when a character is, so a restored card
        // without them comes back untagged.
        extra: { tags: structuredClone(tags) },
    });
}

export async function captureLorebook(name, data, { force = false } = {}) {
    if (isCaptureSuppressed('lorebook', name) || (!force && !getSettings().captureLorebooks)) {
        return null;
    }
    // The whole book object, not a rebuild from `entries`: it also carries
    // originalData, which the host uses to write entries back in their source
    // form. Reconstructing the book would quietly drop it.
    const book = data ?? await liveLorebook(name);
    if (!book) {
        return null;
    }
    if (!isPlainObject(book)) {
        throw new Error(`Neconyan returned a malformed lorebook for ${name}`);
    }
    return save({ kind: 'lorebook', target: name, label: name, data: structuredClone(book) });
}

/**
 * Every named preset, from every API family that has them.
 *
 * One call: /api/settings/get assembles all of them from their directories, so
 * this is the whole preset collection in a single round trip rather than one per
 * preset. The four completion families return file CONTENTS as strings beside a
 * parallel array of names; instruct, context, sysprompt and reasoning return
 * already-parsed objects that carry their own name.
 *
 * @returns {Promise<{apiId: string, name: string, preset: object}[]>}
 */
export async function readAllPresets() {
    const response = await post('/api/settings/get', {});
    const settings = await response.json();
    const presets = [];

    const paired = [
        ['openai', 'openai_setting_names', 'openai_settings'],
        ['textgenerationwebui', 'textgenerationwebui_preset_names', 'textgenerationwebui_presets'],
        ['kobold', 'koboldai_setting_names', 'koboldai_settings'],
        ['novel', 'novelai_setting_names', 'novelai_settings'],
    ];
    for (const [apiId, namesKey, bodiesKey] of paired) {
        const names = settings?.[namesKey];
        const bodies = settings?.[bodiesKey];
        if (!Array.isArray(names) || !Array.isArray(bodies)) {
            continue;
        }
        names.forEach((name, index) => {
            const body = bodies[index];
            try {
                const preset = typeof body === 'string' ? JSON.parse(body) : body;
                if (typeof name === 'string' && isPlainObject(preset)) {
                    presets.push({ apiId, name, preset });
                }
            } catch {
                // A preset file that is not valid JSON is the host's problem to
                // report; skipping it is better than failing the whole sweep.
            }
        });
    }

    for (const apiId of ['instruct', 'context', 'sysprompt', 'reasoning']) {
        for (const preset of settings?.[apiId] ?? []) {
            if (isPlainObject(preset) && typeof preset.name === 'string') {
                presets.push({ apiId, name: preset.name, preset });
            }
        }
    }

    return presets;
}

/**
 * Snapshots every preset whose contents have changed.
 *
 * Presets have no save event of any kind — PRESET_CHANGED fires when one is
 * selected, not when one is saved, and the instruct/context/sysprompt families
 * emit nothing at all. So this runs on the coarse triggers instead (startup,
 * preset switch, and the manual button) and leans on hashing: a sweep where
 * nothing changed stores nothing and costs one local request.
 */
export async function capturePresets({ force = false } = {}) {
    const result = { taken: 0, skipped: 0, failed: 0 };
    if (!force && !getSettings().capturePresets) {
        return result;
    }
    const suppressedAtStart = new Set(captureSuppressions.keys());
    for (const { apiId, name, preset } of await readAllPresets()) {
        const key = captureKey('preset', `${apiId}/${name}`);
        if (suppressedAtStart.has(key) || captureSuppressions.has(key)) {
            result.skipped++;
            continue;
        }
        try {
            const row = await save({
                kind: 'preset',
                target: `${apiId}/${name}`,
                label: `${name} (${apiId})`,
                data: preset,
            });
            result[row ? 'taken' : 'skipped']++;
        } catch (error) {
            result.failed++;
            console.error(`[Time Machine] could not snapshot preset ${apiId}/${name}`, error);
        }
    }
    return result;
}

/**
 * Snapshots everything now.
 *
 * The events cover ordinary editing, but not every write announces itself —
 * /api/characters/merge-attributes emits nothing at all, which is how other
 * extensions store their own data on a card. This is the answer to that, and to
 * "I am about to do something I might regret".
 *
 * ponytail: no periodic sweep. It would mean reading every character and book on
 * a timer to hash them, on a box that is already sharing one core. Add one if a
 * silent write turns out to matter more than the cost.
 */
export async function captureEverything(onProgress = () => {}) {
    const [{ getOperationClient }, core, { getCurrentUserHandle }] = await Promise.all([
        import('../../../../operations-client.js'), import('../../../../../script.js'), import('../../../../user.js')]);
    const account = getCurrentUserHandle();
    const client = await getOperationClient();
    // One server job reads every card, lorebook and preset from disk and saves the
    // snapshots and index together, so closing the page cannot leave it half done.
    const record = await client.run('time-machine-capture', {}, {
        scope: 'time-machine-capture',
        onProgress: progress => {
            if (progress?.total) {
                onProgress(`Saving snapshots: ${progress.completed} of ${progress.total}`);
            }
        },
        prepareInput: async input => {
            if (!await core.saveSettings(0, { returnResult: true })) {
                throw new Error('Save your settings before taking snapshots.');
            }
            return input;
        },
    });
    const result = record?.result ?? {};
    if (account === getCurrentUserHandle() && result.module) {
        const settings = ctx().extensionSettings;
        settings[MODULE_NAME] = structuredClone(result.module);
        settings.character_attachments = isPlainObject(settings.character_attachments) ? settings.character_attachments : {};
        settings.character_attachments['__SillyBunny-Card-Time-Machine__'] = structuredClone(result.attachments ?? []);
        core.adoptServerSettingsWrite({ account, previousVersion: result.previousVersion, version: result.version, settingsRevision: result.settingsRevision });
    }
    return { taken: result.taken ?? 0, skipped: result.skipped ?? 0, failed: 0, removed: result.removed ?? 0 };
}

// ------------------------------------------------------------- live state ---

/** The complete recoverable character state as it is right now. */
export async function liveCharacterState(avatar) {
    const context = ctx();
    const live = context.characters ?? [];
    const index = live.findIndex(character => character?.avatar === avatar);
    if (index === -1) {
        return null;
    }
    await context.unshallowCharacter(index);
    const character = (context.characters ?? []).find(item => item?.avatar === avatar);
    const data = cardFromCharacter(character);
    if (!character || !data) {
        return null;
    }
    const tags = context.tagMap?.[avatar] ?? [];
    if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) {
        throw new Error(`Neconyan returned malformed tags for ${avatar}`);
    }
    return { data, tags: structuredClone(tags) };
}

/** The card as it is right now, to compare a snapshot against. */
export async function liveCharacterCard(avatar) {
    return (await liveCharacterState(avatar))?.data ?? null;
}

export async function liveLorebook(name) {
    const cached = await ctx().loadWorldInfo?.(name);
    if (cached !== null && cached !== undefined) {
        if (!isPlainObject(cached)) {
            throw new Error(`Neconyan returned a malformed lorebook for ${name}`);
        }
        return structuredClone(cached);
    }
    try {
        const response = await post('/api/worldinfo/get', { name });
        const book = await response.json();
        if (!isPlainObject(book)) {
            throw new Error(`Neconyan returned a malformed lorebook for ${name}`);
        }
        return book;
    } catch (error) {
        if (error.status === 404) {
            return null;
        }
        throw error;
    }
}

// ---------------------------------------------------------------- restore ---

/**
 * Writes a snapshot's card back over the live one.
 *
 * merge-attributes preserves the file's identity and skips the write entirely
 * when nothing would change, and it never touches the image. Importing the card
 * instead would reset its creation date and re-encode the PNG through Jimp on
 * every restore, losing a little image quality each time.
 *
 * @param {string} avatar
 * @param {object} card the snapshot's card
 * @param {object} live the card as it is now, for working out what to remove
 * @param {string[]|null} tags
 */
export async function restoreCharacter(avatar, card, live, tags) {
    const context = ctx();
    if (!isPlainObject(card) || !isPlainObject(live)) {
        throw new TypeError('Invalid character snapshot');
    }
    const payload = restorePayload(live ?? {}, card, context.constants?.unset);
    if (tags !== undefined && (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string') || !context.tagMap)) {
        throw new Error('This Neconyan version cannot restore character tags safely');
    }
    return suppressCapture('character', avatar, async () => {
        let started = false;
        try {
            started = true;
            await post('/api/characters/merge-attributes', { ...payload, avatar });
            if (tags !== undefined) {
                context.tagMap[avatar] = structuredClone(tags);
                await commitSettings();
            }
            await context.getCharacters();
        } catch (error) {
            throw started ? partialRestore(error) : error;
        }
    });
}

export async function restoreLorebook(name, book) {
    // `immediately`: the ordinary path debounces by several seconds, which races
    // the editor if the book being restored is the one on screen.
    if (!isPlainObject(book)) {
        throw new TypeError('Invalid lorebook snapshot');
    }
    return suppressCapture('lorebook', name, async () => {
        let started = false;
        try {
            const context = ctx();
            started = true;
            await context.saveWorldInfo(name, book, true);
            await context.updateWorldInfoList?.();
            await context.reloadWorldInfoEditor?.(name);
        } catch (error) {
            throw started ? partialRestore(error) : error;
        }
    });
}

/**
 * Writes one preset back.
 *
 * The raw route rather than PresetManager.savePreset: that opens a system-prompt
 * dialog for instruct presets and rewrites novel presets through a converter,
 * neither of which belongs in "put this back exactly as it was". Saving also
 * retires the tombstone that stops a deleted bundled preset from being seeded
 * again, so restoring one the user deliberately deleted really does bring it
 * back for good.
 */
export async function restorePreset(apiId, name, preset) {
    if (!isPlainObject(preset)) {
        throw new TypeError('Invalid preset snapshot');
    }
    const manager = ctx().getPresetManager?.(apiId);
    if (typeof manager?.updateList !== 'function') {
        throw new Error(`This Neconyan version cannot refresh ${apiId} presets safely`);
    }
    return suppressCapture('preset', `${apiId}/${name}`, async () => {
        let started = false;
        let changed;
        try {
            const restoredPreset = structuredClone(preset);
            if (NAMED_PRESET_APIS.has(apiId)) {
                restoredPreset.name = name;
            }
            started = true;
            const response = await post('/api/presets/save', { preset: restoredPreset, name, apiId });
            const body = await response.json().catch(() => ({}));
            // The server sanitises the name, so what it stored may not be what was sent.
            const storedName = typeof body?.name === 'string' ? body.name : name;
            if (NAMED_PRESET_APIS.has(apiId) && restoredPreset.name !== storedName) {
                restoredPreset.name = storedName;
                await post('/api/presets/save', { preset: restoredPreset, name: storedName, apiId });
            }
            const refresh = async () => {
                changed = waitForPresetChange(apiId);
                await manager.updateList(storedName, restoredPreset);
                await changed.promise;
            };
            if (storedName === name) {
                await refresh();
            } else {
                await suppressCapture('preset', `${apiId}/${storedName}`, refresh);
            }
            return storedName;
        } catch (error) {
            changed?.cancel();
            throw started ? partialRestore(error) : error;
        }
    });
}

/**
 * Writes one extension's settings block back from a host settings backup.
 *
 * Extensions read their settings once at startup, so this cannot take effect
 * until the page is reloaded — the caller has to say so.
 */
export async function restoreExtensionBlock(key, value) {
    if (!isRestorableExtensionBlock(key, value)) {
        throw new Error('Refusing to restore a reserved or malformed settings block');
    }
    const settings = ctx().extensionSettings;
    const hadPrevious = Object.prototype.hasOwnProperty.call(settings, key);
    const previous = settings[key];
    settings[key] = structuredClone(value);
    try {
        await commitSettings();
    } catch (error) {
        if (hadPrevious) {
            settings[key] = previous;
        } else {
            delete settings[key];
        }
        throw error;
    }
}

// -------------------------------------------------- the host's own backups ---

/** @returns {Promise<{name: string, date: number, size: number}[]>} newest first */
export async function listHostSnapshots() {
    const response = await post('/api/settings/get-snapshots', {});
    const rows = await response.json();
    return Array.isArray(rows)
        ? rows.filter(row => typeof row?.name === 'string' && Number.isFinite(row.date) && Number.isFinite(row.size))
            .sort((a, b) => b.date - a.date)
        : [];
}

/**
 * One past settings.json, parsed.
 *
 * Read only. /api/settings/restore-snapshot exists but replaces the entire file,
 * which would undo everything else the user has changed since — the opposite of
 * what this extension is for.
 */
export async function loadHostSnapshot(name) {
    const response = await post('/api/settings/load-snapshot', { name });
    const settings = await response.json();
    if (!isPlainObject(settings)) {
        throw new Error('Neconyan returned a malformed settings backup');
    }
    return settings;
}

/** The extension settings blocks a backup carries, as names a user recognises. */
export function hostSnapshotParts(settings) {
    const blocks = settings?.extension_settings;
    if (!isPlainObject(blocks)) {
        return [];
    }
    return Object.keys(blocks)
        .filter(key => isRestorableExtensionBlock(key, blocks[key]))
        .sort()
        .map(key => ({ kind: 'extension', key, label: key }));
}
