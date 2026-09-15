const REGEX_DEADLINE_MS = 100;

const WORKER_SOURCE = `
self.onmessage = ({ data }) => {
    try {
        self.postMessage({ found: new RegExp(data.pattern).test(data.text) });
    } catch (error) {
        self.postMessage({ error: String(error?.message ?? error) });
    }
};
`;

function workerSupported() {
    return typeof globalThis.Worker === 'function'
        && typeof globalThis.Blob === 'function'
        && typeof globalThis.URL?.createObjectURL === 'function'
        && typeof globalThis.URL?.revokeObjectURL === 'function';
}

/** Regexes are accepted only where they can run outside the main thread. */
export function regexSafetyProblem() {
    return workerSupported()
        ? ''
        : 'Search patterns are unavailable because this browser cannot run them with a safe deadline.';
}

/** Runs an untrusted regex in a disposable Worker and always terminates it. */
export async function testRegexSafely(pattern, text) {
    if (!workerSupported()) {
        return { status: 'unsupported', found: null };
    }

    let worker;
    let url;
    try {
        url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        worker = new Worker(url);
    } catch {
        worker?.terminate?.();
        if (url) {
            URL.revokeObjectURL(url);
        }
        return { status: 'unsupported', found: null };
    }

    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            worker.terminate();
            URL.revokeObjectURL(url);
            resolve(result);
        };
        const timeout = setTimeout(
            () => finish({ status: 'timeout', found: null }),
            REGEX_DEADLINE_MS,
        );

        worker.onmessage = ({ data }) => finish(data?.error
            ? { status: 'invalid', found: null, error: data.error }
            : { status: 'ok', found: Boolean(data?.found) });
        worker.onerror = () => finish({ status: 'unsupported', found: null });
        worker.onmessageerror = () => finish({ status: 'unsupported', found: null });
        try {
            worker.postMessage({ pattern: String(pattern ?? ''), text: String(text ?? '') });
        } catch {
            finish({ status: 'unsupported', found: null });
        }
    });
}
