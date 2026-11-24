/**
 * What the supervisor knows about a server process that stopped, and the words
 * used to describe it. Pure functions with no imports: the supervisor and the
 * crash report writer both load this module.
 */

const MIB = 1024 * 1024;

export const MEMORY_SAMPLE_LIMIT = 12;
export const SERVER_CRASH_BUILD_MESSAGE = 'neconyan:crash-build';
const SAMPLE_NUMBERS = ['uptimeSeconds', 'rss', 'heapUsed', 'heapTotal', 'heapLimit', 'external', 'arrayBuffers', 'deviceAvailable', 'deviceTotal'];

const isCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const megabytes = bytes => Math.round(bytes / MIB);

/** Keep only the package version and Git revision, not private branch names or paths. */
export function parseCrashBuild(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { version, revision } = value;
    const build = {};
    if (typeof version === 'string' && version.length <= 60 && /^\d+(?:\.\d+){2,3}(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i.test(version)) build.version = version;
    if (typeof revision === 'string' && /^[0-9a-f]{4,64}$/i.test(revision)) build.revision = revision;
    return Object.keys(build).length ? build : null;
}

/**
 * Accepts one memory reading sent by the server process. Anything that is not a
 * complete set of finite, non-negative numbers with a valid time is dropped.
 * @param {unknown} value Message payload
 * @returns {object|null} A clean copy, or null
 */
export function parseMemorySample(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const at = typeof value.at === 'string' && value.at.length <= 40 ? Date.parse(value.at) : NaN;
    if (!Number.isFinite(at)) return null;
    const sample = { at: new Date(at).toISOString() };
    for (const field of SAMPLE_NUMBERS) {
        if (!isCount(value[field])) return null;
        sample[field] = Math.round(value[field]);
    }
    return sample;
}

/** The newest readings from one server process, plus its highest JavaScript heap reading. */
export function createMemoryEvidence() {
    const samples = [];
    let peak = null;
    return {
        add(value) {
            const sample = parseMemorySample(value);
            if (!sample) return false;
            samples.push(sample);
            if (samples.length > MEMORY_SAMPLE_LIMIT) samples.shift();
            if (!peak || sample.heapUsed > peak.heapUsed) peak = sample;
            return true;
        },
        snapshot: () => samples.length ? { samples: samples.slice(), peak } : null,
    };
}

function heapFigures(fatal) {
    const used = fatal?.heap?.used;
    const limit = fatal?.heap?.limit;
    return isCount(used) && isCount(limit) && limit > 0 ? { used: megabytes(used), limit: megabytes(limit) } : null;
}

function eventText(fatal) {
    return String(fatal?.event ?? '').replace(/\.+$/, '');
}

/**
 * Plain-language cause taken from the report Node wrote as the process stopped.
 * @param {object} fatal Extract from consumeFatalReport
 * @param {string} subject Who stopped, for example 'The server'
 */
export function describeFatalStop(fatal, subject = 'The server') {
    const event = eventText(fatal);
    if (fatal?.outOfMemory) {
        const figures = heapFigures(fatal);
        const reported = event || 'a JavaScript heap out of memory error';
        return {
            kind: 'server-out-of-memory',
            explanation: figures
                ? `${subject} ran out of JavaScript memory and stopped. It was using ${figures.used} MB of its ${figures.limit} MB limit when Node reported: ${reported}.`
                : `${subject} ran out of JavaScript memory and stopped. Node reported: ${reported}.`,
            headline: figures ? `it ran out of JavaScript memory (${figures.used} MB of ${figures.limit} MB)` : 'it ran out of JavaScript memory',
        };
    }
    return {
        kind: 'server-fatal-error',
        explanation: `${subject} stopped after Node reported a fatal error${event ? `: ${event}` : ''}.`,
        headline: event ? `Node reported a fatal error (${event})` : 'Node reported a fatal error',
    };
}

function lastReadingNote(last, stoppedAt) {
    if (!last) return '';
    const seconds = Math.max(0, Math.round((stoppedAt - Date.parse(last.at)) / 1000));
    const lead = `The last reading, ${seconds} second${seconds === 1 ? '' : 's'} before it stopped, showed`;
    if (last.heapLimit > 0 && last.heapUsed / last.heapLimit >= 0.9) {
        return ` ${lead} the JavaScript heap at ${Math.round(100 * last.heapUsed / last.heapLimit)}% of its ${megabytes(last.heapLimit)} MB limit.`;
    }
    if (last.deviceTotal > 0 && last.deviceAvailable / last.deviceTotal < 0.05) {
        return ` ${lead} ${megabytes(last.deviceAvailable)} MB of ${megabytes(last.deviceTotal)} MB of device memory available.`;
    }
    return '';
}

/**
 * Builds the crash report for a server process that stopped unexpectedly, from
 * the evidence the supervisor holds. It states a cause only when Node's own
 * fatal-error report supplied one.
 * @param {object} stop
 * @param {number} stop.pid Child process id
 * @param {number|null} stop.code Exit code
 * @param {string|null} stop.signal Terminating signal
 * @param {object|null} [stop.app] The validated build of the child that stopped
 * @param {object|null} [stop.fatal] Extract of the report Node wrote as the process stopped
 * @param {{ samples: object[], peak: object }|null} [stop.memory] The child's own readings
 * @param {string|null} [stop.heapLimitArgument] Heap flag the supervisor added
 * @param {number} [stop.stoppedAt] When the supervisor saw the exit, in epoch milliseconds
 * @returns {{ kind: string, explanation: string, headline: string, extra: object }} extra is the report's additional fields
 */
export function describeChildStop({ pid, code, signal, app = null, fatal = null, memory = null, heapLimitArgument = null, stoppedAt = Date.now() }) {
    const child = { pid, signal, exitCode: code };
    if (app) child.app = app;
    if (heapLimitArgument) child.heapLimitArgument = heapLimitArgument;
    if (fatal) child.fatal = fatal;
    if (memory) child.memory = memory;

    const readings = memory
        ? 'child.memory holds the server\'s own readings, the newest taken up to 10 seconds before it stopped.'
        : 'No memory reading arrived from the server before it stopped.';
    const extra = {
        child,
        limitation: `The environment block describes the surviving supervisor, not the server. ${readings}${fatal ? ' child.fatal is taken from the report Node wrote as the server stopped.' : ''}`,
    };

    if (fatal) {
        const { kind, explanation, headline } = describeFatalStop(fatal);
        const figures = heapFigures(fatal);
        if (fatal.outOfMemory && figures) {
            extra.nextStep = `If this device has memory to spare, raise the limit above ${figures.limit} MB in the Server panel under Server Memory (Node.js), or start the server with NODE_OPTIONS=--max-old-space-size=<MB>.${memory ? ' The readings taken before it stopped are in child.memory.' : ''}`;
        }
        return { kind, explanation, headline, extra };
    }

    const note = lastReadingNote(memory?.samples.at(-1), stoppedAt);
    return signal
        ? {
            kind: 'child-process-signal',
            explanation: `The operating system terminated the server with ${signal}. A signal alone does not establish why it was sent.${note}`,
            headline: `it was terminated by ${signal}`,
            extra,
        }
        : {
            kind: 'child-process-exit',
            explanation: `The server exited with code ${code} without completing its exit handler. No further cause was supplied.${note}`,
            headline: `it exited with code ${code}`,
            extra,
        };
}
