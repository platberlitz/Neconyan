import path from 'node:path';
import sanitize from 'sanitize-filename';
import { authoringEvidence, publishAuthoringFileLocked, readAuthoringFileLocked, stageAuthoringFileLocked } from '../authoring-store.js';
import { roleplayHash, roleplayLease } from '../roleplay-store.js';
import { getSettingsVersion, prepareSettingsSave } from '../settings-version.js';
import { operationError } from './store.js';

const LIMIT = 32 * 1024 * 1024;
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => roleplayHash(left) === roleplayHash(right);
const damaged = reason => Object.assign(operationError(reason, 400), { importDamage: reason });

function settingsObject(bytes, current = false) {
    try {
        const value = JSON.parse(bytes.toString('utf8'));
        if (!plain(value)) throw new Error('Not an object');
        return value;
    } catch {
        throw damaged(current ? 'The current settings could not be read. Persona names and descriptions were left unchanged.' : 'The file is not valid JSON.');
    }
}

/** Persona libraries live in settings.json, but the rest of that file must not replace this account's settings. */
export function readImportPersonas(bytes) {
    const incoming = settingsObject(bytes);
    const power = incoming.power_user ?? {};
    if (!plain(power)) throw damaged('The persona settings are not an object.');
    const names = power.personas ?? {};
    const descriptions = power.persona_descriptions ?? {};
    if (!plain(names) || !plain(descriptions)) throw damaged('The persona names or descriptions are not an object.');
    for (const key of new Set([...Object.keys(names), ...Object.keys(descriptions)])) {
        if (!key || key !== sanitize(key) || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(key)) throw damaged('A persona has an invalid avatar filename.');
        if (Object.hasOwn(names, key) && typeof names[key] !== 'string') throw damaged('A persona name is not text.');
        if (Object.hasOwn(descriptions, key) && (!plain(descriptions[key])
            || descriptions[key].description !== undefined && typeof descriptions[key].description !== 'string')) throw damaged('A persona description is not valid.');
    }
    return { names, descriptions };
}

/** Save only the persona libraries into the latest settings, with a durable witness for restart recovery. */
export function publishImportPersonasLocked(lease, value, save, file, index, bytes, dependencies = {}) {
    const key = `persona-settings:${index}`;
    let effect = value.effects[key];
    if (effect?.state === 'done') return effect.skipped ?? null;
    const root = roleplayLease(lease).scope.directories.root;
    const filename = path.join(root, 'settings.json');
    const current = readAuthoringFileLocked(lease, filename, LIMIT);
    if (effect && !same(authoringEvidence(current), effect.staged.before) && !same(authoringEvidence(current), effect.staged.after)) {
        // An interrupted import must never restore a persona over a later edit or deletion.
        const reason = `Cannot import '${file.relative}': Settings changed after the persona import was interrupted. The newer settings were kept.`;
        value.effects[key] = { ...effect, state: 'done', skipped: reason };
        save();
        return reason;
    }
    if (!effect) {
        const { names, descriptions } = readImportPersonas(bytes);
        if (!Object.keys(names).length && !Object.keys(descriptions).length) {
            value.effects[key] = { state: 'done' };
            save();
            return null;
        }
        const latest = current ? settingsObject(current.bytes, true) : {};
        if (latest.power_user !== undefined && !plain(latest.power_user)) throw damaged('The current persona settings are invalid. They were left unchanged.');
        const power = latest.power_user ?? {};
        if (power.personas !== undefined && !plain(power.personas) || power.persona_descriptions !== undefined && !plain(power.persona_descriptions)) {
            throw damaged('The current persona library is invalid. It was left unchanged.');
        }
        const prepared = prepareSettingsSave({ ...latest, _version: getSettingsVersion(latest), _conversationOmitted: true, power_user: { ...power,
            personas: { ...(plain(power.personas) ? power.personas : {}), ...names },
            persona_descriptions: { ...(plain(power.persona_descriptions) ? power.persona_descriptions : {}), ...descriptions },
        } }, latest);
        if (!prepared.ok) throw damaged('The persona names and descriptions could not be merged safely. Current settings were kept.');
        const output = JSON.stringify(prepared.settings, null, 4);
        if (Buffer.byteLength(output) > LIMIT) throw damaged('The merged persona settings exceed the 32 MiB settings limit.');
        effect = value.effects[key] = { state: 'prepared', staged: stageAuthoringFileLocked(lease, filename, output, { expected: authoringEvidence(current), limit: LIMIT }) };
        save();
        dependencies.afterPersonaSettingsPrepared?.();
    }
    publishAuthoringFileLocked(lease, effect.staged);
    dependencies.afterPersonaSettingsPublication?.();
    effect.state = 'done';
    save();
    return null;
}
