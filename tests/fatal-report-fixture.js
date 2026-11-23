const MIB = 1024 * 1024;

export const FATAL_REPORT_PRIVATE_TEXT = Object.freeze({
    host: 'private-host-name',
    cwd: '/private/working/directory',
    argument: '--api-key=private-command-line-value',
    sharedObject: '/private/lib/libprivate.so',
    installPath: '/data/data/com.termux/files/private-account/bin',
    environment: 'PRIVATE_ENVIRONMENT_VALUE',
});

/**
 * The shape of the report Node writes when it dies from a fatal error, with the
 * private sections (host, working directory, command line, shared objects and
 * environment) filled with recognisable text so tests can prove they are dropped.
 */
export function nodeFatalReport(overrides = {}) {
    return {
        header: {
            reportVersion: 5,
            event: 'Allocation failed - JavaScript heap out of memory',
            trigger: 'OOMError',
            filename: 'fatal-1.json',
            dumpEventTime: '2026-11-23T18:05:00Z',
            dumpEventTimeStamp: String(Date.UTC(2026, 10, 23, 10, 5, 0)),
            processId: 1,
            cwd: FATAL_REPORT_PRIVATE_TEXT.cwd,
            commandLine: ['node', FATAL_REPORT_PRIVATE_TEXT.argument, 'server.js'],
            host: FATAL_REPORT_PRIVATE_TEXT.host,
            ...overrides.header,
        },
        javascriptStack: { message: 'No stack.', stack: ['Unavailable.'] },
        javascriptHeap: {
            totalMemory: 1020 * MIB,
            usedMemory: 1010 * MIB,
            memoryLimit: 1014 * MIB,
            availableMemory: 4 * MIB,
            heapSpaces: {
                new_space: { memorySize: 16 * MIB, used: 2 * MIB },
                old_space: { memorySize: 900 * MIB, used: 890 * MIB },
                code_space: { memorySize: 0, used: 0 },
                'not a valid name!': { memorySize: 5, used: 5 },
            },
            ...overrides.javascriptHeap,
        },
        nativeStack: overrides.nativeStack ?? [
            { pc: '0x1', symbol: `node::OOMErrorHandler(char const*, v8::OOMDetails const&) [${FATAL_REPORT_PRIVATE_TEXT.installPath}/node]` },
            { pc: '0x2', symbol: ` [${FATAL_REPORT_PRIVATE_TEXT.installPath}/node]` },
            { pc: '0x3', symbol: `v8::Object::operator[](unsigned long) [${FATAL_REPORT_PRIVATE_TEXT.installPath}\\node.exe]` },
            { pc: '0x4', symbol: 'bare_symbol_without_module' },
        ],
        resourceUsage: { rss: 1200 * MIB, maxRss: 1250 * MIB, free_memory: 2000 * MIB, total_memory: 12288 * MIB, ...overrides.resourceUsage },
        libuv: [{ type: 'tcp', address: FATAL_REPORT_PRIVATE_TEXT.host }],
        userLimits: { core_file_size_blocks: { soft: 0, hard: 'unlimited' } },
        sharedObjects: [FATAL_REPORT_PRIVATE_TEXT.sharedObject],
        environmentVariables: { SECRET: FATAL_REPORT_PRIVATE_TEXT.environment },
    };
}
