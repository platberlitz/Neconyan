import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { getCrashReports } from '../src/crash-diagnostics.js';

const url = file => new URL(`../src/${file}`, import.meta.url).href;
const MIB = 1024 * 1024;

function temporary(t, prefix = 'neconyan-oom-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const exhaustHeap = 'const keep = []; for (;;) keep.push(new Array(1e5).fill(Math.random()));';

test('a real server that runs out of heap is reported as out of memory, restarted, and leaves no raw report', t => {
    const dataRoot = temporary(t);
    const cwd = temporary(t, 'neconyan-oom-cwd-');
    const flag = path.join(temporary(t, 'neconyan-oom-flag-'), 'started-once');
    const crashDirectory = path.join(dataRoot, 'crash-reports');
    const child = path.join(cwd, 'child.mjs');
    fs.mkdirSync(path.join(cwd, 'plugins'));
    // Starts, announces startup, sends its first memory reading, then exhausts a 40 MB heap.
    // Its replacement finds the flag and exits cleanly.
    fs.writeFileSync(child, `
        import fs from 'node:fs';
        import { initialiseCrashDiagnostics, installCrashHandlers } from ${JSON.stringify(url('crash-diagnostics.js'))};
        import { startMemoryPressureMonitor } from ${JSON.stringify(url('memory-pressure.js'))};
        import { notifyServerStartup } from ${JSON.stringify(url('server-plugin-update-ipc.js'))};
        const [dataRoot, flag] = process.argv.slice(2);
        initialiseCrashDiagnostics(dataRoot);
        installCrashHandlers();
        if (fs.existsSync(flag)) process.exit(0);
        fs.writeFileSync(flag, '');
        startMemoryPressureMonitor();
        notifyServerStartup([]);
        setTimeout(() => { ${exhaustHeap} }, 400);
    `);
    const runner = `
        import { runSupervisor } from ${JSON.stringify(url('server-supervisor.js'))};
        await runSupervisor({
            argv: [process.execPath, ${JSON.stringify(child)}, ${JSON.stringify(dataRoot)}, ${JSON.stringify(flag)}],
            execArgv: ['--max-old-space-size=40'], heapArguments: [], restartDelayMs: 0, pluginsRoot: ${JSON.stringify(path.join(cwd, 'plugins'))},
        });
    `;

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', runner], { cwd, encoding: 'utf8', timeout: 90_000 });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /\[Neconyan\] The server stopped unexpectedly: it ran out of JavaScript memory \(\d+ MB of \d+ MB\)\./);
    assert.match(result.stdout, /\[Neconyan\] Starting the server again\.\.\./);

    const names = fs.readdirSync(crashDirectory);
    assert.deepEqual(names.filter(name => !/^crash-[\w.-]+\.json$/.test(name)), [], 'no raw fatal report or stale marker may remain');
    const reports = getCrashReports(crashDirectory);
    assert.equal(reports.length, 1);
    const [report] = reports;
    assert.equal(report.kind, 'server-out-of-memory');
    assert.equal(report.child.signal, 'SIGABRT');
    assert.equal(report.child.fatal.outOfMemory, true);
    assert.equal(report.child.fatal.trigger, 'OOMError');
    const { used, limit } = report.child.fatal.heap;
    assert.ok(used > 0 && used <= limit && limit < 1024 * MIB, `implausible heap figures ${used} of ${limit}`);
    assert.match(report.error.message, /^The server ran out of JavaScript memory and stopped\. It was using \d+ MB of its \d+ MB limit when Node reported: .*heap out of memory\.$/);
    assert.ok(report.child.memory.samples.length >= 1, 'the first memory reading is sent as the server starts');
    const reading = report.child.memory.samples.at(-1);
    assert.ok(reading.heapUsed > 0 && reading.heapLimit > 0 && reading.deviceTotal > 0 && reading.rss > 0);
    assert.ok(report.child.fatal.nativeStack.length > 0 && report.child.fatal.nativeStack.length <= 20);

    const text = fs.readFileSync(path.join(crashDirectory, names[0]), 'utf8');
    for (const private_ of [cwd, dataRoot, process.execPath]) assert.ok(!text.includes(private_), `the report holds ${private_}`);
    const host = os.hostname();
    if (host.length >= 4) assert.ok(!text.includes(host), 'the report holds the host name');
    for (const section of ['commandLine', 'sharedObjects', 'userLimits', 'libuv', 'environmentVariables', 'javascriptStack']) assert.ok(!text.includes(`"${section}"`), `the report holds ${section}`);
});

test('a server that dies of heap exhaustion with no supervisor is explained by the next start', t => {
    const dataRoot = temporary(t);
    const crashDirectory = path.join(dataRoot, 'crash-reports');
    const moduleUrl = url('crash-diagnostics.js');
    const died = spawnSync(process.execPath, ['--max-old-space-size=40', '--input-type=module', '-e', `
        import { initialiseCrashDiagnostics, installCrashHandlers } from ${JSON.stringify(moduleUrl)};
        initialiseCrashDiagnostics(${JSON.stringify(dataRoot)}); installCrashHandlers();
        ${exhaustHeap}
    `], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(died.signal, 'SIGABRT', died.stderr);
    // Node honours the file name set at run time for fatal-error reports.
    assert.ok(fs.existsSync(path.join(crashDirectory, `fatal-${died.pid}.json`)));

    const recovered = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { initialiseCrashDiagnostics, installCrashHandlers } from ${JSON.stringify(moduleUrl)};
        initialiseCrashDiagnostics(${JSON.stringify(dataRoot)}); installCrashHandlers();
    `], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(recovered.status, 0, recovered.stderr);

    const reports = getCrashReports(crashDirectory);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].kind, 'unclean-previous-exit');
    assert.equal(reports[0].previous.pid, died.pid);
    assert.equal(reports[0].fatal.outOfMemory, true);
    assert.match(reports[0].error.message, /^The previous server process ran out of JavaScript memory and stopped\. It was using \d+ MB of its \d+ MB limit/);
    assert.deepEqual(fs.readdirSync(crashDirectory).filter(name => !name.startsWith('crash-')), []);
});
