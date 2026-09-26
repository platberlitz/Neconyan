import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { withRoleplayAccount } from '../roleplay-store.js';
import { readArtifact, writeArtifact } from '../jobs/artifacts.js';
import { TEST_CASE_VERSION, MAX_CASE_BYTES, storedCases, writeStoredCases, validateReplay, expectedFrom, compare }
    from '../../public/scripts/extensions/third-party/Neconyan-WorldInfo-Lab/src/test-case-core.js';
import { captureLabBook, captureLabBookLocked } from './books.js';
import { labError, readLabRecord } from './store.js';
import { captureWorldInfoLab, runWorldInfoLab } from './world-info.js';
import { readLabSettings } from './sources.js';

export function listWorldInfoCases(base, account, bookNames = null) {
    return withRoleplayAccount(base, account, lease => {
        const names = bookNames ?? fs.readdirSync(base.directories.worlds).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
        if (!Array.isArray(names) || names.length > 10000 || names.some(name => typeof name !== 'string')) throw labError('The lorebook list is invalid.', 400);
        const cases = [], failures = [];
        for (const name of [...new Set(names)]) {
            try { cases.push(...storedCases(captureLabBookLocked(lease, name).book).map(item => ({ ...item, bookName: name }))); } catch (error) { failures.push({ bookName: name, message: error.message }); }
        }
        cases.sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')));
        return { cases, failures };
    });
}

export function captureWorldInfoCase(base, account, input) {
    const target = captureLabBook(base, account, input.book), book = structuredClone(target.book);
    const cases = storedCases(book);
    let item;
    if (input.operation === 'delete') {
        const matches = cases.filter(item => item.id === input.id);
        if (matches.length !== 1) throw labError('The selected saved test is missing or ambiguous. Reload the saved tests.');
        item = matches[0];
        writeStoredCases(book, cases.filter(candidate => candidate.id !== item.id));
    } else if (input.operation === 'save') {
        if (input.confirmReplayStorage !== true) throw labError('Confirm storing the displayed scan inside this lorebook.', 400);
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw labError('Enter a test name of up to 120 characters.', 400);
        const scan = readLabRecord(base, input.scanKey);
        if (scan?.state !== 'completed' || scan.resultHash !== input.scanHash) throw labError('The saved scan is missing or changed.');
        const result = scan.kind === 'world-info.scan' ? scan.result
            : scan.kind === 'world-info.tests' ? scan.result.tests.find(test => test.caseId === input.caseId)?.result : null;
        if (result?.kind !== 'simulated') throw labError('Choose a saved native scan before preparing a test.', 400);
        const replay = validateReplay(result.replay);
        const now = new Date().toISOString();
        item = { id: randomUUID(), version: TEST_CASE_VERSION, name: input.name.trim(), createdAt: now, updatedAt: now,
            replay, expected: expectedFrom(result) };
        if (Buffer.byteLength(JSON.stringify(item)) > MAX_CASE_BYTES) throw labError('This saved test exceeds 2 MiB. Use a smaller scan.', 413);
        writeStoredCases(book, [...cases, item]);
    } else throw labError('Choose whether to save or delete a test.', 400);
    return { target, book, item, operation: input.operation };
}

export function captureWorldInfoTests(base, account, input) {
    if (!Array.isArray(input.cases) || !input.cases.length || input.cases.length > 100) throw labError('Choose between 1 and 100 saved tests.', 400);
    const seen = new Set(), mode = readLabSettings(base).power_user?.experimental_macro_engine ? 'experimental' : 'legacy';
    return { tests: input.cases.map(reference => {
        const identity = JSON.stringify([reference.book, reference.id]);
        if (typeof reference.id !== 'string' || !reference.id || seen.has(identity)) throw labError('The selected test is invalid or duplicated.', 400);
        seen.add(identity);
        const target = captureLabBook(base, account, reference.book);
        const matches = storedCases(target.book).filter(item => item.id === reference.id);
        if (matches.length !== 1 || matches[0].version !== TEST_CASE_VERSION) throw labError('A selected saved test is missing, ambiguous or incompatible.');
        const item = matches[0], replay = validateReplay(item.replay);
        if (replay.macroEngine !== mode) throw labError('The saved test uses different macro settings. Restore those settings or recreate the test.');
        return { item, bookName: target.name, scan: captureWorldInfoLab(base, account, replay, 'world-info.replay') };
    }) };
}

export async function runWorldInfoTests(context, plan) {
    const tests = [];
    for (const [index, test] of plan.tests.entries()) {
        context.signal.throwIfAborted();
        const artifact = `world-info-test:${index}`;
        let result = readArtifact(context.directories, context.job.id, artifact);
        if (result === undefined) {
            result = await runWorldInfoLab(context, test.scan, 'world-info.scan');
            writeArtifact(context.directories, context.job.id, artifact, result);
        }
        const comparison = compare(test.item, result);
        tests.push({ ...comparison, result, caseId: test.item.id, bookName: test.bookName,
            summary: comparison.passed ? `${test.item.name}: saved scan matched.` : `${test.item.name}: changed ${comparison.differences.join(', ')}.` });
        await context.progress({ stage: 'Checking saved tests', completed: index + 1, total: plan.tests.length });
    }
    return { tests, passed: tests.every(test => test.passed) };
}
