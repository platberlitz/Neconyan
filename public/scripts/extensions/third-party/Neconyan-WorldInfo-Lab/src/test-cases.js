import { getLabClient } from '../../../../labs-client.js';
import { applyWorldInfoLab, runWorldInfoLab } from './native.js';

export async function listTestCases({ bookNames = null } = {}) {
    const client = await getLabClient();
    return client.request('/api/labs/world-info/cases', { method: 'POST', body: JSON.stringify({ bookNames }) });
}

export function saveTestCase(input) {
    if (!input.result?.labRecord) throw new Error('Reopen a saved native scan before preparing this test.');
    return runWorldInfoLab('case', { operation: 'save', book: input.bookName, name: input.name,
        scanKey: input.result.labRecord.key, scanHash: input.result.labRecord.resultHash, ...(input.result.labRecord.caseId ? { caseId: input.result.labRecord.caseId } : {}),
        confirmReplayStorage: input.confirmReplayStorage });
}

export function deleteTestCase(id, { bookName } = {}) {
    return runWorldInfoLab('case', { operation: 'delete', book: bookName, id });
}

export async function applyTestCase(preview, options) {
    return { ...preview.item, bookName: preview.target.name, deleted: preview.operation === 'delete',
        ...await applyWorldInfoLab(preview, options) };
}

export async function runTestCases(cases, options) {
    return runWorldInfoLab('tests', { cases: cases.map(item => ({ id: item.id, book: item.bookName })) }, options);
}

export async function runTestCase(item, options) {
    const batch = await runTestCases([item], options);
    const result = batch.tests[0];
    return { ...result, result: { ...result.result, labRecord: { ...batch.labRecord, caseId: item.id } } };
}
