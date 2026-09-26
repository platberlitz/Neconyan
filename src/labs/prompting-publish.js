import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { fingerprint, validatePresetPayload, withCanonicalName } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/presets.js';
import { getPresetSettingsByAPI } from '../endpoints/presets.js';
import { clearDefaultPresetDeletion, findDefaultPreset } from '../endpoints/content-manager.js';
import { publishAuthoringFileLocked, readAuthoringFileLocked, stageAuthoringFileLocked } from '../authoring-store.js';
import { roleplayHash, withRoleplayAccount } from '../roleplay-store.js';
import { labError, withLabRecord } from './store.js';
import { publishPromptingDraft, readPromptingStorage } from './prompting-storage.js';

function assertAvailable(lease, directories, target) {
    const filename = path.join(directories.root, target.relative);
    // Inspect through the guarded authoring reader before enumerating the parent.
    if (readAuthoringFileLocked(lease, filename)
        || fs.readdirSync(path.dirname(filename)).some(name => name.toLowerCase() === path.basename(filename).toLowerCase())) {
        throw Object.assign(labError('That preset name is already in use. Review the draft under another name.'), { labRefused: true });
    }
}

export async function capturePromptingPublish(base, account, input) {
    const draft = (await readPromptingStorage(base, account, 'getDraft', [input.draftId])).value;
    if (!draft || input.version !== await fingerprint(draft)) throw labError('The saved preset draft changed before publication was submitted.');
    const name = draft.name.trim();
    if (!name || sanitize(name) !== name || Buffer.byteLength(`${name}.json`) > 255) throw labError('Choose a preset name that can be saved as a filename.', 400);
    const problems = validatePresetPayload(draft.apiId, draft.payload);
    if (problems.length) throw labError(problems.join(' '), 400);
    const { folder, extension } = getPresetSettingsByAPI(draft.apiId, base.directories);
    if (!folder || extension !== '.json') throw labError('That preset type is unavailable.', 400);
    const target = { kind: 'preset', relative: path.relative(base.directories.root, path.join(folder, name + extension)), name };
    withRoleplayAccount(base, account, lease => assertAvailable(lease, base.directories, target));
    return { draft, draftHash: roleplayHash(draft), target, payload: withCanonicalName(draft.apiId, draft.payload, name),
        display: { draftId: draft.id, apiId: draft.apiId, name } };
}

export async function runPromptingPublish(context, plan, { afterPresetPublication } = {}) {
    context.signal.throwIfAborted();
    withLabRecord(context, ({ lease, value, save }) => {
        if (!value.effects.preset) {
            assertAvailable(lease, context.directories, plan.target);
            const filename = path.join(context.directories.root, plan.target.relative);
            value.effects.preset = { state: 'prepared', staged: stageAuthoringFileLocked(lease, filename,
                JSON.stringify(plan.payload, null, 4), { expected: null }) };
            save();
        }
        if (value.effects.preset.state !== 'done') {
            publishAuthoringFileLocked(lease, value.effects.preset.staged);
            afterPresetPublication?.();
            value.effects.preset.state = 'done';
            save();
        }
        if (!value.effects.defaultMarker) {
            clearDefaultPresetDeletion(context.directories, findDefaultPreset(context.directories,
                { folder: path.dirname(path.join(context.directories.root, plan.target.relative)), name: plan.target.name }));
            value.effects.defaultMarker = { state: 'done' };
            save();
        }
    });
    return publishPromptingDraft(context, plan);
}
