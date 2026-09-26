import { parentPort, workerData } from 'node:worker_threads';
import { delimitLorebook, mergeLorebooks, searchReplaceLorebook } from '../../public/scripts/neconyan-lorebook-tools-core.js';
import { computeWorldInfoLab } from './world-info-compute.js';
import { analysePromptingRun, compilePromptingCapture } from './prompting-compute.js';
import { parseImport, buildExport } from '../../public/scripts/extensions/third-party/Neconyan-Prompting-Lab/src/transfer.js';

const requests = new Map();
let nextRequest = 0;
parentPort.on('message', message => {
    const id = message.tokenResponse ?? message.memoryResponse;
    requests.get(id)?.(message.tokenResponse !== undefined ? message.count : message.memory);
    requests.delete(id);
});
const tokenCount = text => new Promise(resolve => {
    const id = nextRequest++;
    requests.set(id, resolve);
    parentPort.postMessage({ tokenRequest: id, text });
});
const prepareMemory = input => new Promise(resolve => {
    const id = nextRequest++;
    requests.set(id, resolve);
    parentPort.postMessage({ memoryRequest: id, input });
});

try {
    const { kind, plan } = workerData;
    let result;
    if (kind === 'lorestitch') {
        const operations = { replace: searchReplaceLorebook, delimit: delimitLorebook,
            merge: (book, options) => mergeLorebooks(book, plan.incoming.book, options.choices) };
        const operation = operations[plan.operation];
        if (!operation) throw new Error('Unknown LoreStitch operation.');
        result = operation(plan.target.book, plan.options);
    } else if (kind === 'prompting.capture') result = await compilePromptingCapture(plan, tokenCount, prepareMemory);
    else if (kind === 'prompting.run') result = await analysePromptingRun(plan, tokenCount, prepareMemory);
    else if (kind === 'prompting.import') result = parseImport(plan.text, { regex: { safetyProblem: () => null } });
    else if (kind === 'prompting.export') result = buildExport(plan.suite, plan.cases, plan.baselineRuns, plan.presets);
    else if (kind.startsWith('world-info.')) result = await computeWorldInfoLab(kind, plan, tokenCount);
    else throw new Error('Unknown Labs computation.');
    parentPort.postMessage({ result });
} catch (error) {
    parentPort.postMessage({ error: error.message });
}
