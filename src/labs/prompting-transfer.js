import path from 'node:path';
import sanitize from 'sanitize-filename';
import { getPresetSettingsByAPI } from '../endpoints/presets.js';
import { readRoleplayFile, withRoleplayAccount } from '../roleplay-store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { createDraft } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/schema.js';
import { reviewConnectionFields, withoutFields } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/presets.js';
import { MAX_EXPORT_WITH_BASELINES_BYTES } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/constants.js';
import { suggestedFileName } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/transfer.js';
import { labError } from './store.js';
import { promptingMemory, readPromptingDatabaseLocked, runPromptingStorage } from './prompting-storage.js';
import { computeLab } from './compute.js';

export async function capturePromptingTransfer(base, account, input) {
    const database = withRoleplayAccount(base, account, readPromptingDatabaseLocked);
    if (input.operation === 'import') {
        if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > MAX_EXPORT_WITH_BASELINES_BYTES) throw labError('Choose a Prompting Lab suite file of 10 MB or less.', 413);
        return { operation: 'import', text: input.text, revision: database.value.revision };
    }
    if (input.operation !== 'export') throw labError('Choose a suite import or export.', 400);
    const { storage } = promptingMemory(database.value.data);
    const suite = await storage.getSuite(input.suiteId);
    if (!suite) throw labError('The suite to export no longer exists.');
    const cases = await Promise.all(suite.caseIds.map(id => storage.getCase(id)));
    if (cases.some(item => !item)) throw labError('A test case in this suite is missing.');
    const baselineRuns = input.includeBaselines ? (await Promise.all(Object.values(suite.baselines).map(id => storage.getRun(id)))).filter(Boolean) : null;
    const presets = [];
    if (input.includePresets) {
        const references = new Map(cases.flatMap(item => item.pins.presets).map(ref => [`${ref.apiId}:${ref.name}`, ref]));
        for (const ref of references.values()) {
            if (sanitize(ref.name) !== ref.name || !ref.name) throw labError('A pinned preset name is invalid.');
            const { folder, extension } = getPresetSettingsByAPI(ref.apiId, base.directories);
            if (!folder) throw labError('A pinned preset type is unavailable.');
            const file = readRoleplayFile(path.join(folder, ref.name + extension), 8 * 1024 * 1024, { allowMissingParent: true });
            if (!file) continue;
            const payload = JSON.parse(file.bytes.toString('utf8'));
            const fields = reviewConnectionFields(ref.apiId, payload);
            presets.push(createDraft({ apiId: ref.apiId, name: ref.name, payload: input.includeConnection ? payload : withoutFields(payload, fields.map(item => item.field)) }));
        }
    }
    return { operation: 'export', suite, cases, baselineRuns, presets };
}

export async function runPromptingTransfer(context, plan, dependencies) {
    if (plan.operation === 'export') {
        return { ...await computeLab('prompting.export', plan, context.signal), fileName: suggestedFileName(plan.suite),
            caseCount: plan.cases.length, presetCount: plan.presets.length };
    }
    let parsed = readArtifact(context.directories, context.job.id, 'imported-suite');
    if (parsed === undefined) {
        parsed = await computeLab('prompting.import', plan, context.signal);
        writeArtifact(context.directories, context.job.id, 'imported-suite', parsed);
    }
    return runPromptingStorage(context, { method: 'saveImportBatch', args: [parsed], revision: plan.revision }, dependencies);
}
