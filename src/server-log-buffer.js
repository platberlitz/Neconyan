import process from 'node:process';
import { formatWithOptions, inspect, types } from 'node:util';

const MAX_SERVER_LOG_ENTRIES = 1500;
const MAX_SERVER_LOG_MESSAGE_LENGTH = 12000;
const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const OSC_ESCAPE_PATTERN = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
const CONSOLE_METHOD_STREAMS = Object.freeze({
    log: 'stdout',
    info: 'stdout',
    debug: 'stdout',
    warn: 'stderr',
    error: 'stderr',
    trace: 'stderr',
});

function getCurrentTimestamp() {
    const runtimePerformance = globalThis.performance;
    if (runtimePerformance
        && Number.isFinite(runtimePerformance.timeOrigin)
        && typeof runtimePerformance.now === 'function'
    ) {
        const performanceTimestamp = Math.trunc(runtimePerformance.timeOrigin + runtimePerformance.now());
        if (Number.isFinite(performanceTimestamp) && performanceTimestamp > 0) {
            return performanceTimestamp;
        }
    }

    const fallbackTimestamp = Date.now();
    if (Number.isFinite(fallbackTimestamp) && fallbackTimestamp > 0) {
        return fallbackTimestamp;
    }

    return 0;
}

const state = globalThis.__neconyanServerLogBuffer ??= {
    initialized: false,
    captureStartedAt: getCurrentTimestamp(),
    nextId: 1,
    entries: [],
    pending: {
        stdout: '',
        stderr: '',
    },
    consoleSuppression: {
        stdout: 0,
        stderr: 0,
    },
};

function clampNumber(value, min, max, fallback) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, Math.trunc(numericValue)));
}

function stripAnsiFormatting(value) {
    return String(value ?? '')
        .replace(OSC_ESCAPE_PATTERN, '')
        .replace(ANSI_ESCAPE_PATTERN, '')
        .replace(CONTROL_CHAR_PATTERN, '');
}

function normalizeChunk(chunk, encoding) {
    if (typeof chunk === 'string') {
        return chunk;
    }

    if (Buffer.isBuffer(chunk)) {
        return chunk.toString(typeof encoding === 'string' ? encoding : 'utf8');
    }

    return String(chunk ?? '');
}

function truncateMessage(value) {
    if (value.length <= MAX_SERVER_LOG_MESSAGE_LENGTH) {
        return value;
    }

    return `${value.slice(0, MAX_SERVER_LOG_MESSAGE_LENGTH - 1).trimEnd()}…`;
}

/**
 * A kept line must own its characters. The pieces a long output is split into, and a truncated line, are
 * views onto the whole parent string, so keeping one of them keeps the whole output alive. Appending a
 * character forces a flat copy of just this text, and slicing that off leaves a view onto the copy.
 */
function detachedText(value) {
    return value.length < 13 ? value : `${value}\0`.slice(0, -1);
}

function appendLogEntry(stream, message) {
    const normalizedMessage = detachedText(truncateMessage(String(message ?? '')));
    if (!normalizedMessage) {
        return;
    }

    state.entries.push({
        id: state.nextId++,
        timestamp: getCurrentTimestamp(),
        stream,
        message: normalizedMessage,
    });

    if (state.entries.length > MAX_SERVER_LOG_ENTRIES) {
        state.entries.splice(0, state.entries.length - MAX_SERVER_LOG_ENTRIES);
    }
}

function flushPendingStream(stream) {
    const pendingMessage = state.pending[stream];

    if (!pendingMessage) {
        return;
    }

    appendLogEntry(stream, pendingMessage);
    state.pending[stream] = '';
}

function consumeNormalizedOutput(stream, chunk, encoding, { flushTrailing = false } = {}) {
    const normalizedChunk = stripAnsiFormatting(
        normalizeChunk(chunk, encoding)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n'),
    );

    if (!normalizedChunk) {
        if (flushTrailing) {
            flushPendingStream(stream);
        }
        return;
    }

    const combined = `${state.pending[stream]}${normalizedChunk}`;
    const lines = combined.split('\n');
    state.pending[stream] = lines.pop() ?? '';

    for (const line of lines) {
        appendLogEntry(stream, line);
    }

    if (flushTrailing) {
        flushPendingStream(stream);
    }
}

function consumeStreamChunk(stream, chunk, encoding) {
    consumeNormalizedOutput(stream, chunk, encoding);
}

// What util.inspect prints is bounded by its depth and by these defaults for arrays and strings, but not by how
// many properties an object has, so a logged object with a million keys is formatted line by line however little
// of it the buffer keeps.
const FORMAT_DEPTH = 10;
const INSPECT_ARRAY_ITEMS = 100;
const INSPECT_STRING_CHARACTERS = 10000;
// An argument that would print more than this many values, or this much text, is cut before it is formatted. It
// would fill the whole 1,500 line buffer three times over, and only its last lines would survive. Everything
// smaller is formatted exactly as util.format always did. Every value counts as one, a string and an empty string
// too, because each prints at least one line; a string also counts its characters (at most the 10,000 that
// util.inspect prints), so a few long strings are cut by the text limit and many short ones by the value limit.
const FORMAT_VALUE_LIMIT = 5000;
const FORMAT_CHARACTER_LIMIT = 1_000_000;
// A cut argument keeps its first lines only: at most this many for the whole call (under 7% of the buffer,
// shared by its cut arguments, at least five each), from a copy of at most this many values whose arrays show
// 20 items and whose strings 1,000 characters.
const CUT_CALL_LINES = 100;
const CUT_COPY_VALUES = 40;
const CUT_ARRAY_ITEMS = 20;
const CUT_STRING_CHARACTERS = 1000;

/** Objects whose own data properties are read to size or copy them: plain objects, arrays, maps and sets. */
function isReadable(value) {
    if (types.isProxy(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null || Array.isArray(value) || types.isMap(value) || types.isSet(value);
}

/**
 * The values util.inspect would print for an object, without running a getter or a proxy trap (an accessor
 * is printed as [Getter], so it counts as one value and is not read). Returns null for what is not read.
 */
function* shownValues(value) {
    if (types.isMap(value) || types.isSet(value)) {
        let shown = 0;
        for (const entry of types.isMap(value) ? Map.prototype.entries.call(value) : Set.prototype.values.call(value)) {
            if (shown++ >= INSPECT_ARRAY_ITEMS) return;
            yield* types.isMap(value) ? entry : [entry];
        }
        return;
    }
    const keys = Array.isArray(value) ? Array.from({ length: Math.min(value.length, INSPECT_ARRAY_ITEMS) }, (_, index) => String(index)) : Object.keys(value);
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        yield descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    }
}

/** Whether an argument would print more than the limits above: more values (strings included), or more text. Shared references count each time they print; a reference back to an object being printed prints once as [Circular]. */
function exceedsFormatLimit(root) {
    const left = { values: FORMAT_VALUE_LIMIT, characters: FORMAT_CHARACTER_LIMIT };
    const ancestors = new Set();
    const exceeds = (value, depth) => {
        if (--left.values < 0) return true;
        if (typeof value === 'string') return (left.characters -= Math.min(value.length, INSPECT_STRING_CHARACTERS)) < 0;
        // An object deeper than the print depth prints as [Object]; an ancestor prints as [Circular].
        if (!value || typeof value !== 'object' || depth > FORMAT_DEPTH || ancestors.has(value) || !isReadable(value)) return false;
        ancestors.add(value);
        try {
            for (const child of shownValues(value)) if (exceeds(child, depth + 1)) return true;
            return false;
        } finally {
            ancestors.delete(value);
        }
    };
    return exceeds(root, 0);
}

/** A copy of at most CUT_COPY_VALUES values of an argument, keeping shared and circular references and never running a getter. */
function cutCopy(root) {
    const left = { values: CUT_COPY_VALUES };
    const copies = new Map();
    const copy = (value, depth) => {
        if (!value || typeof value !== 'object') return value;
        if (copies.has(value)) return copies.get(value);
        if (!isReadable(value)) return `[${types.isProxy(value) ? 'Proxy' : Object.getPrototypeOf(value)?.constructor?.name ?? 'Object'}]`;
        if (depth > FORMAT_DEPTH) return Array.isArray(value) ? ['…'] : { '…': 'deeper' };
        const array = Array.isArray(value);
        const result = array ? [] : types.isMap(value) ? new Map() : types.isSet(value) ? new Set() : Object.getPrototypeOf(value) === null ? Object.create(null) : {};
        copies.set(value, result);
        const mark = () => { if (array) result.push('…'); else if (types.isMap(value)) result.set('…', 'more'); else if (types.isSet(value)) result.add('…'); else result['…'] = 'more'; };
        if (types.isMap(value) || types.isSet(value)) {
            for (const entry of types.isMap(value) ? Map.prototype.entries.call(value) : Set.prototype.values.call(value)) {
                if (--left.values < 0 || result.size >= CUT_ARRAY_ITEMS) { mark(); break; }
                if (types.isMap(value)) result.set(copy(entry[0], depth + 1), copy(entry[1], depth + 1)); else result.add(copy(entry, depth + 1));
            }
            return result;
        }
        const keys = array ? Array.from({ length: Math.min(value.length, CUT_ARRAY_ITEMS) }, (_, index) => String(index)) : Object.keys(value);
        for (const key of keys) {
            if (--left.values < 0) { mark(); break; }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor && !Object.hasOwn(descriptor, 'value')) {
                // Printed as [Getter], [Setter] or [Getter/Setter] without being run.
                Object.defineProperty(result, key, { enumerable: true, get: descriptor.get && (() => undefined), set: descriptor.set && (() => {}) });
            } else result[key] = copy(descriptor?.value, depth + 1);
        }
        if (array && value.length > keys.length) mark();
        return result;
    };
    return copy(root, 0);
}

function cutText(argument, lines, options) {
    const text = inspect(cutCopy(argument), { ...options, maxArrayLength: CUT_ARRAY_ITEMS, maxStringLength: CUT_STRING_CHARACTERS }).split('\n');
    return [...text.slice(0, lines - 1), '… (a value too large to keep in the log; only its start is kept)'].join('\n');
}

/**
 * What stands in for a cut argument. util.format prints it as the text however the format reads it: as an
 * argument, through %s, %o or %O, and as a JSON string through %j. A plain string would be printed as itself by
 * %s, but %o and %O would inspect it, quoting it as one line, and a string first argument would be read as a format.
 */
function cutArgument(text) {
    return { [inspect.custom]: () => text, toString: () => text, toJSON: () => text };
}

function captureConsoleCall(stream, args) {
    const options = {
        colors: false,
        depth: FORMAT_DEPTH,
        breakLength: Infinity,
        compact: false,
    };
    // Only an argument too large to be kept is formatted differently; the terminal always gets the original arguments.
    const cut = args.map(argument => argument !== null && typeof argument === 'object' && exceedsFormatLimit(argument));
    const cutCount = cut.filter(Boolean).length;
    const lines = Math.max(5, Math.floor(CUT_CALL_LINES / Math.max(1, cutCount)));
    const shown = args.map((argument, index) => cut[index] ? cutArgument(cutText(argument, lines, options)) : argument);
    // A cut first argument is an object, so format does not read any % in its text as a format.
    const formattedMessage = formatWithOptions(options, ...shown);

    consumeNormalizedOutput(stream, formattedMessage, 'utf8', { flushTrailing: true });
}

function patchStream(streamName, stream) {
    const originalWrite = stream.write.bind(stream);

    stream.write = function patchedWrite(chunk, encoding, callback) {
        const shouldCapture = !state.consoleSuppression[streamName];
        const result = originalWrite(chunk, encoding, callback);

        if (shouldCapture) {
            try {
                consumeStreamChunk(streamName, chunk, encoding);
            } catch {
                // Ignore log capture failures so terminal output keeps flowing.
            }
        }

        return result;
    };
}

function patchConsoleMethod(methodName, streamName) {
    const originalMethod = console[methodName];

    if (typeof originalMethod !== 'function') {
        return;
    }

    console[methodName] = function patchedConsoleMethod(...args) {
        state.consoleSuppression[streamName] = (state.consoleSuppression[streamName] || 0) + 1;

        try {
            captureConsoleCall(streamName, args);
        } catch {
            // Ignore log capture failures so terminal output keeps flowing.
        }

        try {
            return originalMethod.apply(this, args);
        } finally {
            state.consoleSuppression[streamName] = Math.max(0, (state.consoleSuppression[streamName] || 1) - 1);
        }
    };
}

export function initServerLogBuffer() {
    if (state.initialized) {
        return;
    }

    patchStream('stdout', process.stdout);
    patchStream('stderr', process.stderr);

    for (const [methodName, streamName] of Object.entries(CONSOLE_METHOD_STREAMS)) {
        patchConsoleMethod(methodName, streamName);
    }

    state.captureStartedAt = getCurrentTimestamp();
    state.initialized = true;
}

export function getServerLogSnapshot({ limit = 250, afterId = 0 } = {}) {
    initServerLogBuffer();
    flushPendingStream('stdout');
    flushPendingStream('stderr');

    const normalizedLimit = clampNumber(limit, 50, 600, 250);
    const normalizedAfterId = clampNumber(afterId, 0, Number.MAX_SAFE_INTEGER, 0);
    const latestId = state.entries.at(-1)?.id ?? 0;
    let entries = normalizedAfterId > 0
        ? state.entries.filter(entry => entry.id > normalizedAfterId)
        : state.entries;
    const truncated = entries.length > normalizedLimit;

    if (truncated) {
        entries = entries.slice(-normalizedLimit);
    }

    return {
        captureStartedAt: state.captureStartedAt,
        totalBuffered: state.entries.length,
        latestId,
        truncated,
        entries: entries.map(entry => ({
            id: entry.id,
            timestamp: entry.timestamp,
            stream: entry.stream,
            message: entry.message,
        })),
    };
}

/**
 * Writes lines directly to the operator terminal without recording them in the
 * HTTP-accessible server log buffer.
 * @param {...string} lines
 */
export function writeTerminalOnly(...lines) {
    initServerLogBuffer();
    state.consoleSuppression.stdout = (state.consoleSuppression.stdout || 0) + 1;
    try {
        for (const line of lines) {
            process.stdout.write(`${line ?? ''}\n`);
        }
    } finally {
        state.consoleSuppression.stdout = Math.max(0, (state.consoleSuppression.stdout || 1) - 1);
    }
}

initServerLogBuffer();
