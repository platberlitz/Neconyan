export const POLICY_MODES = Object.freeze({
    DISABLED: 'disabled',
    ALLOWLIST: 'allowlist',
    ADVANCED: 'advanced',
});

export const DEFAULT_ALLOWLIST = Object.freeze([
    '/audioselect',
    '/audiomode',
    '/audioplay',
    '/echo',
    '/getchatname',
]);

export const DEFAULT_ADVANCED_ALLOWLIST = Object.freeze([
    ...DEFAULT_ALLOWLIST,
    '/buttons',
    '/popup',
]);

export const DEFAULT_LIMITS = Object.freeze({
    maxCommandLength: 2000,
    maxPipedCommands: 5,
});

export function createDefaultPolicy(overrides = {}) {
    const mode = overrides.mode ?? POLICY_MODES.DISABLED;

    return {
        mode,
        allowlist: buildAllowlistSet(overrides.allowlist ?? getDefaultAllowlistForMode(mode)),
        limits: {
            ...DEFAULT_LIMITS,
            ...(overrides.limits ?? {}),
        },
    };
}

export function parseSlashCommandRequest(raw, policy = createDefaultPolicy()) {
    const activePolicy = normalizePolicy(policy);

    if (activePolicy.mode === POLICY_MODES.DISABLED) {
        return { ok: false, reason: 'policy_disabled' };
    }

    if (typeof raw !== 'string') {
        return { ok: false, reason: 'malformed' };
    }

    if (/[{}\x00-\x1f\x7f]/.test(raw)) return { ok: false, reason: 'unsafe_syntax' };

    const trimmed = raw.trim();
    if (!trimmed) {
        return { ok: false, reason: 'empty_input' };
    }

    if (trimmed.length > activePolicy.limits.maxCommandLength) {
        return { ok: false, reason: 'too_long' };
    }

    const pipeline = splitSlashPipeline(trimmed);
    if (!pipeline.ok) {
        return pipeline;
    }

    const { segments } = pipeline;
    if (segments.length > activePolicy.limits.maxPipedCommands) {
        return { ok: false, reason: 'too_many_commands' };
    }

    const commands = [];

    for (const segment of segments) {
        const parsed = parseCommandSegment(segment, activePolicy.allowlist);
        if (!parsed.ok) {
            return parsed;
        }

        commands.push(parsed.command);
    }

    return {
        ok: true,
        command: commands.join('|'),
        commands,
    };
}

function normalizePolicy(policy) {
    if (!policy || typeof policy !== 'object') {
        return createDefaultPolicy();
    }

    const validModes = new Set(Object.values(POLICY_MODES));
    const mode = validModes.has(policy.mode) ? policy.mode : POLICY_MODES.DISABLED;

    return {
        mode,
        allowlist: buildAllowlistSet(policy.allowlist ?? getDefaultAllowlistForMode(mode)),
        limits: {
            ...DEFAULT_LIMITS,
            ...(policy.limits ?? {}),
        },
    };
}

function parseCommandSegment(segment, allowlist) {
    const trimmed = segment.trim();

    if (!trimmed || !trimmed.startsWith('/')) {
        return { ok: false, reason: 'malformed' };
    }

    const match = trimmed.match(/^\/[^\s|]+/);
    if (!match) {
        return { ok: false, reason: 'malformed' };
    }

    const commandName = match[0].toLowerCase();
    if (!allowlist.has(commandName)) {
        return { ok: false, reason: 'command_not_allowed' };
    }

    const args = trimmed.slice(match[0].length).trim();
    const quoting = validateArgumentPipes(args);
    if (!quoting.ok) return quoting;
    if (commandName === '/echo') {
        const checked = validateEchoArguments(args);
        if (!checked.ok) return checked;
    }
    return {
        ok: true,
        command: args ? `${commandName} ${args}` : commandName,
    };
}

/**
 * The real slash parser only honours quotes around named argument values; unnamed
 * text (and /echo, which keeps raw quotes) ends at any unescaped pipe. A pipe the
 * splitter kept inside quotes anywhere else would start a hidden, unchecked command.
 */
function validateArgumentPipes(args) {
    let rest = args;
    while (/^\w+=/.test(rest)) {
        const match = rest.match(/^\w+=(?:"(?:\\.|[^"\\])*"|[^\s"\\|[\]]+)(?:\s+|$)/);
        if (!match) return { ok: false, reason: 'unsafe_syntax' };
        rest = rest.slice(match[0].length);
    }
    let escaped = false;
    for (const char of rest) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '|') return { ok: false, reason: 'unsafe_syntax' };
    }
    return { ok: true };
}

function validateEchoArguments(args) {
    let rest = args;
    const seen = new Set();
    while (/^\w+=/.test(rest)) {
        const match = rest.match(/^(\w+)=("(?:\\.|[^"\\])*"|[^\s"\\[\]]+)(?:\s+|$)/);
        if (!match) return { ok: false, reason: 'unsafe_echo_option' };
        const [, name, rawValue] = match;
        const value = rawValue.startsWith('"') ? rawValue.slice(1, -1) : rawValue;
        if (seen.has(name)) return { ok: false, reason: 'unsafe_echo_option' };
        seen.add(name);
        const valid = name === 'title' ? value.length <= 200 && !/[\\<>]/.test(value)
            : name === 'severity' ? /^(info|success|warning|error)$/.test(value)
                : ['timeout', 'extendedTimeout'].includes(name) ? /^\d+$/.test(value) && Number(value) >= 100 && Number(value) <= 10000
                    : name === 'preventDuplicates' && /^(true|false)$/.test(value);
        if (!valid) return { ok: false, reason: 'unsafe_echo_option' };
        rest = rest.slice(match[0].length);
    }
    return { ok: true };
}

function splitSlashPipeline(input) {
    const segments = [];
    let current = '';
    let quote = '';
    let escaped = false;

    for (const char of input) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === '\\') {
            current += char;
            escaped = true;
            continue;
        }

        if (quote) {
            current += char;
            if (char === quote) {
                quote = '';
            }
            continue;
        }

        if (char === '"') {
            current += char;
            quote = char;
            continue;
        }

        if (char === '|') {
            segments.push(current);
            current = '';
            continue;
        }

        current += char;
    }

    if (quote || escaped) {
        return { ok: false, reason: 'malformed' };
    }

    segments.push(current);
    return { ok: true, segments };
}

function buildAllowlistSet(allowlist) {
    const allowed = new Set();

    if (!allowlist || typeof allowlist[Symbol.iterator] !== 'function') {
        return allowed;
    }

    for (const command of allowlist) {
        const normalized = normalizeAllowedCommand(command);
        if (normalized) {
            allowed.add(normalized);
        }
    }

    return allowed;
}

function getDefaultAllowlistForMode(mode) {
    return mode === POLICY_MODES.ADVANCED ? DEFAULT_ADVANCED_ALLOWLIST : DEFAULT_ALLOWLIST;
}

function normalizeAllowedCommand(command) {
    if (typeof command !== 'string') {
        return null;
    }

    const trimmed = command.trim().toLowerCase();
    if (!trimmed) {
        return null;
    }

    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
