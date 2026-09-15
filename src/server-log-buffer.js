import process from 'node:process';
import { formatWithOptions } from 'node:util';

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

const state = globalThis.__sillyBunnyServerLogBuffer ??= {
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

function appendLogEntry(stream, message) {
    const normalizedMessage = truncateMessage(String(message ?? ''));
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

function captureConsoleCall(stream, args) {
    const formattedMessage = formatWithOptions({
        colors: false,
        depth: 10,
        breakLength: Infinity,
        compact: false,
    }, ...args);

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

initServerLogBuffer();
