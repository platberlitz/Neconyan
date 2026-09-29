import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldToServer } from 'node:timers/promises';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { captureUserResetContent } from '../endpoints/content-manager.js';
import { createRoleplayDirectory, inspectRoleplayFile, prepareRoleplayResetContent, roleplayLease, withRoleplayAccount } from '../roleplay-store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { setJobResume } from '../jobs/store.js';
import { captureFolderImport, captureZipImport, openImportArchive } from './account-import-sources.js';
import { capturedArchiveInput } from './input-files.js';
import { captureImportInput } from './import-inputs.js';
import { captureExtensionReport } from './import-extension-report.js';
import { captureImportTarget, assertImportTarget, importNeedsCheck, importSkipReason, prepareImportValue, stageImportFile, publishImportFile } from './import-publication.js';
import { importBatches, publishImportBatches, readPlannedInput, stageImportBatch } from './import-batches.js';
import { publishFileDeletions } from './file-deletion.js';
import { BINARY_FILE_LIMIT } from './binary-files.js';
import { registerOperation } from './jobs.js';
import { operationError, withOperation } from './store.js';

const BATCHED_PIPELINE = 2;
const MAX_AUTOMATIC_ATTEMPTS = 6;
const SKIPPED_REPORT_LIMIT = 200;

function extensionRemovals(lease, files) {
    const root = roleplayLease(lease).scope.directories.root;
    const prefix = USER_DIRECTORY_TEMPLATE.extensions;
    const selected = new Set(files.map(file => file.relative));
    const folders = new Set(files.map(file => file.relative.split('/')).filter(parts => parts[0] === prefix && parts.length > 2).map(parts => `${prefix}/${parts[1]}`));
    const result = [];
    const visit = (relative, depth = 0) => {
        if (depth > 32 || result.length > 100000) throw operationError('The extension replacement exceeds its file capacity.', 413);
        const filename = path.join(root, relative);
        const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
        if (!stat) return;
        if (stat.isSymbolicLink()) throw operationError('A linked extension destination cannot be replaced.');
        if (stat.isDirectory()) {
            inspectRoleplayFile(path.join(filename, '.import-directory-check'), 1, { allowMissingParent: true });
            for (const entry of fs.readdirSync(filename).sort()) if (entry !== '.git') visit(`${relative}/${entry}`, depth + 1);
        } else if (!selected.has(relative)) {
            const file = inspectRoleplayFile(filename, BINARY_FILE_LIMIT);
            result.push({ relative, evidence: { physical: file.physical, rawHash: file.rawHash } });
        }
    };
    for (const folder of folders) visit(folder);
    return result;
}

export async function captureAccountImport(base, account, input, { defaults } = {}) {
    if (!['folder', 'zip', 'extensions'].includes(input.mode)) throw operationError('Select a folder, ZIP or extension import.', 400);
    let captured;
    if (input.mode === 'zip') {
        const archive = capturedArchiveInput(base, account, input.inputId);
        const source = await captureZipImport(archive);
        captured = { ...source, archive };
        delete captured.source;
    } else captured = captureFolderImport(base, input.path, { extensionsOnly: input.mode === 'extensions' });
    const extensionsReport = input.mode === 'extensions' ? captureExtensionReport(base, captured) : null;
    const content = { version: 1, ...(input.mode === 'extensions' ? { directories: [], files: [] } : defaults ?? captureUserResetContent(base.directories)) };
    const defaultsHash = prepareRoleplayResetContent(base, account, content);
    return withRoleplayAccount(base, account, lease => {
        const files = captured.files.map(file => ({ ...file, target: captureImportTarget(lease, file.relative) }));
        const selected = new Set(files.map(file => file.relative));
        for (const [defaultIndex, file] of content.files.entries()) {
            if (selected.has(file.relative)) continue;
            const target = captureImportTarget(lease, file.relative);
            if (target.evidence) continue;
            files.push({ relative: file.relative, defaultIndex, size: Buffer.from(file.data, 'base64').length, target });
        }
        // Saved settings become visible only after all other imported files are durable.
        files.sort((left, right) => Number(left.relative === 'settings.json') - Number(right.relative === 'settings.json'));
        const removals = input.mode === 'extensions' ? extensionRemovals(lease, files) : [];
        return { ...captured, mode: input.mode, account, files, defaults: defaultsHash, removals, extensionsReport, pipeline: BATCHED_PIPELINE,
            directories: [...new Set([...captured.directories, ...content.directories])], importedCount: captured.files.length };
    });
}

export async function runAccountImport(context, plan, dependencies = {}) {
    try {
        // Older imports which have not begun publication can also use the bounded-memory path.
        // Keep their accepted plan untouched; the record remembers which publication format to resume.
        const batched = plan.pipeline === BATCHED_PIPELINE || withOperation(context, ({ value }) => value.importPipeline === BATCHED_PIPELINE || !value.importReady);
        return batched ? await runBatchedImport(context, plan, dependencies) : await runCapturedImport(context, plan, dependencies);
    } catch (error) {
        const pending = withOperation(context, ({ value }) => value.importReady);
        if (!pending && [400, 409].includes(error.status)) error.operationRefused = true;
        throw error;
    }
}

function progressReporter(context) {
    let last = 0, lastStage;
    return async (stage, completed, total) => {
        // Even synchronous folder validation must let cancellation and progress requests run.
        await yieldToServer();
        context.signal.throwIfAborted();
        const now = Date.now();
        if (stage === lastStage && completed < total && now - last < 500) return;
        last = now; lastStage = stage;
        await context.progress({ stage, completed, total });
    };
}

/**
 * Imports captured by this version read ZIP entries straight from the retained archive and
 * save their progress once per batch rather than repeatedly copying the whole record.
 * A restart resumes the saved work; repeated crashes stop resuming automatically.
 */
async function runBatchedImport(context, plan, dependencies) {
    const attempts = withOperation(context, ({ value, save }) => {
        value.importPipeline = BATCHED_PIPELINE;
        value.importAttempts = (value.importAttempts ?? 0) + 1;
        save();
        return value.importAttempts;
    });
    // A restart resumes this import unless it keeps stopping at the same point.
    await setJobResume(context.directories, context.job.id, attempts <= MAX_AUTOMATIC_ATTEMPTS ? 'account-import' : null);
    const report = progressReporter(context);
    let record = withOperation(context, ({ value }) => value);
    await report('Opening saved backup', 0, plan.files.length);
    const archive = plan.archive && plan.files.some(file => file.zip) ? await openImportArchive(plan.archive) : null;
    try {
        if (!record.importReady) {
            const retained = [...plan.files.entries()].filter(([index, file]) => !(archive && file.zip)
                // Finish a single in-flight copy from an older interrupted import, preserving its evidence.
                || record.effects[`binary:import:${index}`] && record.effects[`binary:import:${index}`].state !== 'done');
            if (retained.length) await report('Copying import files', 0, retained.length);
            for (const [position, [index, file]] of retained.entries()) {
                context.signal.throwIfAborted();
                await captureImportInput(context, plan, file, index);
                await report('Copying import files', position + 1, retained.length);
            }
            dependencies.afterImportInputs?.();
            const checked = [...plan.files.entries()].filter(([, file]) => importNeedsCheck(file));
            const prepared = {};
            // Damaged files are listed and left out; every healthy file still imports.
            const skipped = [];
            if (checked.length) await report('Checking chats, characters and settings', 0, checked.length);
            for (const [position, [index, file]] of checked.entries()) {
                context.signal.throwIfAborted();
                try {
                    const value = prepareImportValue(context, file, index, await readPlannedInput(context, archive, file, index));
                    if (value?.bytes !== undefined) prepared[index] = { bytes: value.bytes };
                } catch (error) {
                    const reason = importSkipReason(file, error);
                    if (!reason) throw error;
                    skipped.push({ index, relative: file.relative, reason });
                }
                await report('Checking chats, characters and settings', position + 1, checked.length);
            }
            const assertTargets = lease => {
                const skip = new Set(skipped.map(item => item.index));
                for (const [index, file] of plan.files.entries()) if (!skip.has(index)) assertImportTarget(lease, file.target);
                for (const file of plan.removals) assertImportTarget(lease, { ...file, resource: null });
            };
            withOperation(context, ({ lease }) => {
                context.signal.throwIfAborted();
                assertTargets(lease);
                const root = roleplayLease(lease).scope.directories.root;
                for (const directory of plan.directories) createRoleplayDirectory(path.join(root, directory), root);
            });
            const unchecked = new Set(skipped.map(item => item.index));
            const staged = [...plan.files.entries()].filter(([index, file]) => !file.target.resource && !unchecked.has(index)).map(([index, file]) => ({ file, index }));
            let done = 0;
            if (staged.length) await report('Preparing imported files', 0, staged.length);
            for (const batch of importBatches(staged, item => item.file.size)) {
                skipped.push(...await stageImportBatch(context, batch, { archive, prepared }));
                done += batch.length;
                await report('Preparing imported files', done, staged.length);
            }
            record = withOperation(context, ({ lease, value, save }) => {
                context.signal.throwIfAborted();
                assertTargets(lease);
                const skippedImports = skipped.filter(item => plan.files[item.index].defaultIndex === undefined).length;
                value.importPrepared = null;
                value.importSkipped = skipped;
                value.importReady = true;
                value.importResult = { ...plan.extensionsReport, imported: plan.importedCount - skippedImports, defaults: plan.files.length - plan.importedCount,
                    removed: plan.removals.length, sourceRoot: plan.sourceRoot, mode: plan.mode,
                    skippedCount: skipped.length, skipped: skipped.slice(0, SKIPPED_REPORT_LIMIT).map(item => ({ file: item.relative, reason: item.reason })) };
                save();
                return value;
            });
            dependencies.afterImportStaged?.();
        }
        await report('Saving imported files', record.effects['import-publish']?.next ?? 0, plan.files.length);
        await publishImportBatches(context, plan, { archive, afterImportPublication: dependencies.afterImportPublication,
            skipped: new Set((record.importSkipped ?? []).map(item => item.index)),
            onProgress: (completed, total) => report('Saving imported files', completed, total) });
    } finally { archive?.close(); }
    if (plan.removals.length) publishFileDeletions(context, plan.removals, record.importResult, dependencies);
    return record.importResult;
}

async function runCapturedImport(context, plan, dependencies) {
    let record = withOperation(context, ({ value }) => value);
    if (!record.importReady) {
        for (const [index, file] of plan.files.entries()) {
            context.signal.throwIfAborted();
            await captureImportInput(context, plan, file, index);
            await context.progress({ stage: 'Retaining import sources', completed: index + 1, total: plan.files.length });
        }
        dependencies.afterImportInputs?.();
        const prepared = [];
        for (const [index, file] of plan.files.entries()) {
            let value = readArtifact(context.directories, context.job.id, `import-value:${index}`);
            if (value === undefined) {
                value = prepareImportValue(context, file, index);
                writeArtifact(context.directories, context.job.id, `import-value:${index}`, value);
            }
            prepared.push(value);
        }
        withOperation(context, ({ lease }) => {
            context.signal.throwIfAborted();
            for (const file of plan.files) assertImportTarget(lease, file.target);
            for (const file of plan.removals) assertImportTarget(lease, { ...file, resource: null });
            const root = roleplayLease(lease).scope.directories.root;
            for (const directory of plan.directories) createRoleplayDirectory(path.join(root, directory), root);
        });
        for (const [index, file] of plan.files.entries()) if (!file.target.resource) {
            const staged = await stageImportFile(context, file, index, prepared[index]);
            prepared[index] = { staged };
        }
        record = withOperation(context, ({ lease, value, save }) => {
            context.signal.throwIfAborted();
            for (const file of plan.files) assertImportTarget(lease, file.target);
            for (const file of plan.removals) assertImportTarget(lease, { ...file, resource: null });
            value.importPrepared = prepared;
            value.importReady = true;
            value.importResult = { ...plan.extensionsReport, imported: plan.importedCount, defaults: plan.files.length - plan.importedCount,
                removed: plan.removals.length, sourceRoot: plan.sourceRoot, mode: plan.mode };
            save();
            return value;
        });
        dependencies.afterImportStaged?.();
    }
    for (const [index, file] of plan.files.entries()) {
        publishImportFile(context, file, index, record.importPrepared[index], dependencies);
        await context.progress({ stage: 'Publishing retained import files', completed: index + 1, total: plan.files.length });
    }
    if (plan.removals.length) publishFileDeletions(context, plan.removals, record.importResult, dependencies);
    return record.importResult;
}

registerOperation('account-import', { label: 'Import saved account data', capture: captureAccountImport, run: runAccountImport,
    target: () => ({ kind: 'account', id: 'import' }), canRecover: () => true,
    canRefuse: value => value.importReady !== true });
