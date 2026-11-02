import { parentPort, workerData } from 'node:worker_threads';
import { createMacroEnvironment } from '../macros/index.js';

try {
    const environment = createMacroEnvironment({
        names: { user: workerData.user, char: workerData.character },
        variables: { local: workerData.variables, global: {} },
        extra: { characterScope: 'none' },
    });
    parentPort.postMessage({ output: environment.evaluate(workerData.text) });
} catch (error) { parentPort.postMessage({ error: error.message }); }
