import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const SERVER_MAIN_SOURCE = new URL('../src/server-main.js', import.meta.url);
const SERVER_STARTUP_SOURCE = new URL('../src/server-startup.js', import.meta.url);

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.destroyed = false;
        this.destroy = jest.fn(() => {
            this.destroyed = true;
        });
    }
}

class FakeServer extends EventEmitter {
    /**
     * @param {object} [options] Fake behavior
     * @param {boolean} [options.autoClose] Whether close() invokes its callback
     * @param {boolean} [options.withCloseAllConnections] Whether the runtime exposes closeAllConnections
     */
    constructor({ autoClose = true, withCloseAllConnections = true } = {}) {
        super();
        this.closeCallbacks = [];
        this.close = jest.fn((callback) => {
            this.closeCallbacks.push(callback);
            if (autoClose && typeof callback === 'function') {
                callback();
            }
            return this;
        });

        if (withCloseAllConnections) {
            this.closeAllConnections = jest.fn();
        }
    }
}

function addressInUseError() {
    const error = new Error('listen EADDRINUSE: address already in use 127.0.0.1:4444');
    error.code = 'EADDRINUSE';
    return error;
}

async function loadListenModule() {
    jest.resetModules();
    return import('../src/server-listen.js');
}

describe('listen port release', () => {
    afterEach(() => {
        jest.resetModules();
    });

    test('destroys tracked connections so a streaming request cannot hold the port', async () => {
        const { closeListeningServers, trackListeningServer } = await loadListenModule();
        const server = new FakeServer();
        const socket = new FakeSocket();

        trackListeningServer(server);
        server.emit('connection', socket);

        await closeListeningServers();

        expect(server.close).toHaveBeenCalledTimes(1);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
        expect(socket.destroy).toHaveBeenCalledTimes(1);
    });

    test('destroys tracked connections when the runtime lacks closeAllConnections', async () => {
        const { closeListeningServers, trackListeningServer } = await loadListenModule();
        const server = new FakeServer({ withCloseAllConnections: false });
        const socket = new FakeSocket();

        trackListeningServer(server);
        server.emit('connection', socket);

        await closeListeningServers();

        expect(server.closeAllConnections).toBeUndefined();
        expect(socket.destroy).toHaveBeenCalledTimes(1);
    });

    test('forgets sockets that closed on their own and servers that already closed', async () => {
        const { closeListeningServers, trackListeningServer } = await loadListenModule();
        const closedServer = new FakeServer();
        const openServer = new FakeServer();
        const closedSocket = new FakeSocket();

        trackListeningServer(closedServer);
        trackListeningServer(openServer);
        openServer.emit('connection', closedSocket);
        closedSocket.emit('close');
        closedServer.emit('close');

        await closeListeningServers();

        expect(closedServer.close).not.toHaveBeenCalled();
        expect(openServer.close).toHaveBeenCalledTimes(1);
        expect(closedSocket.destroy).not.toHaveBeenCalled();
    });

    test('resolves on timeout when a server never reports closed', async () => {
        const { closeListeningServers, trackListeningServer } = await loadListenModule();
        const server = new FakeServer({ autoClose: false });

        trackListeningServer(server);

        await expect(closeListeningServers({ timeoutMs: 10 })).resolves.toBeUndefined();
        expect(server.close).toHaveBeenCalledTimes(1);
    });

    test('is a no-op when nothing is listening', async () => {
        const { closeListeningServers } = await loadListenModule();

        await expect(closeListeningServers()).resolves.toBeUndefined();
    });
});

describe('listen retry on an occupied port', () => {
    let retryOnAddressInUse;
    let isAddressInUseError;

    beforeEach(async () => {
        ({ isAddressInUseError, retryOnAddressInUse } = await loadListenModule());
    });

    test('recognizes only EADDRINUSE errors', () => {
        expect(isAddressInUseError(addressInUseError())).toBe(true);
        expect(isAddressInUseError(Object.assign(new Error('nope'), { code: 'EACCES' }))).toBe(false);
        expect(isAddressInUseError(new Error('nope'))).toBe(false);
        expect(isAddressInUseError(null)).toBe(false);
        expect(isAddressInUseError('EADDRINUSE')).toBe(false);
    });

    test('retries until the port is released', async () => {
        const attemptFn = jest.fn()
            .mockRejectedValueOnce(addressInUseError())
            .mockRejectedValueOnce(addressInUseError())
            .mockResolvedValueOnce('listening');
        const onRetry = jest.fn();

        await expect(retryOnAddressInUse(attemptFn, { delayMs: 0, onRetry })).resolves.toBe('listening');

        expect(attemptFn).toHaveBeenCalledTimes(3);
        expect(onRetry).toHaveBeenCalledTimes(2);
        expect(onRetry).toHaveBeenNthCalledWith(1, 1, 40);
    });

    test('gives up after the attempt cap and rethrows the original error', async () => {
        const error = addressInUseError();
        const attemptFn = jest.fn().mockRejectedValue(error);

        await expect(retryOnAddressInUse(attemptFn, { attempts: 3, delayMs: 0 })).rejects.toBe(error);

        expect(attemptFn).toHaveBeenCalledTimes(3);
    });

    test('does not retry other startup failures', async () => {
        const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const attemptFn = jest.fn().mockRejectedValue(error);
        const onRetry = jest.fn();

        await expect(retryOnAddressInUse(attemptFn, { delayMs: 0, onRetry })).rejects.toBe(error);

        expect(attemptFn).toHaveBeenCalledTimes(1);
        expect(onRetry).not.toHaveBeenCalled();
    });

    test('defaults to a bounded window of about a minute', async () => {
        const { LISTEN_RETRY_ATTEMPTS, LISTEN_RETRY_DELAY_MS } = await loadListenModule();

        expect(LISTEN_RETRY_ATTEMPTS).toBe(40);
        expect(LISTEN_RETRY_DELAY_MS).toBe(1500);
        // Long enough to outlast an update straggler holding an inherited
        // socket handle, short enough that a genuine conflict still surfaces.
        const windowMs = (LISTEN_RETRY_ATTEMPTS - 1) * LISTEN_RETRY_DELAY_MS;
        expect(windowMs).toBeGreaterThanOrEqual(45_000);
        expect(windowMs).toBeLessThanOrEqual(120_000);
    });
});

describe('port holder diagnostics', () => {
    const NETSTAT_OUTPUT = [
        'Active Connections',
        '',
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    127.0.0.1:4444         0.0.0.0:0              LISTENING       4321',
        '  TCP    127.0.0.1:4444         127.0.0.1:52001        TIME_WAIT       0',
        '  TCP    127.0.0.1:44440       0.0.0.0:0              LISTENING       9999',
        '  TCP    [::1]:4444             [::]:0                 LISTENING       4321',
        '  UDP    0.0.0.0:5353           *:*                                    777',
    ].join('\r\n');

    test('parses only the TCP rows of the requested port', async () => {
        const { parseNetstatPortRows } = await loadListenModule();

        const rows = parseNetstatPortRows(NETSTAT_OUTPUT, 4444);

        expect(rows).toEqual([
            { local: '127.0.0.1:4444', state: 'LISTENING', pid: 4321 },
            { local: '127.0.0.1:4444', state: 'TIME_WAIT', pid: 0 },
            { local: '[::1]:4444', state: 'LISTENING', pid: 4321 },
        ]);
    });

    test('reads a process name from tasklist CSV output and misses cleanly', async () => {
        const { parseTasklistProcessName } = await loadListenModule();

        expect(parseTasklistProcessName('"bun.exe","4321","Console","1","120,000 K"', 4321)).toBe('bun.exe');
        expect(parseTasklistProcessName('INFO: No tasks are running which match the specified criteria.', 4321)).toBeNull();
        expect(parseTasklistProcessName('', 4321)).toBeNull();
    });

    test('names a live Windows holder and flags a dead one as an inherited handle', async () => {
        const { describePortHolders, BUN_SOCKET_INHERIT_ISSUE_URL } = await loadListenModule();
        const liveRunner = jest.fn(async (command) => command === 'netstat'
            ? '  TCP    127.0.0.1:4444    0.0.0.0:0    LISTENING    4321'
            : '"bun.exe","4321","Console","1","120,000 K"');
        const deadRunner = jest.fn(async (command) => command === 'netstat'
            ? '  TCP    127.0.0.1:4444    0.0.0.0:0    LISTENING    4321'
            : 'INFO: No tasks are running which match the specified criteria.');

        const liveLines = await describePortHolders(4444, { runCommand: liveRunner, platform: 'win32' });
        expect(liveLines).toEqual(['Port 4444 is held open by "bun.exe" (PID 4321).']);

        const deadLines = await describePortHolders(4444, { runCommand: deadRunner, platform: 'win32' });
        expect(deadLines).toHaveLength(1);
        expect(deadLines[0]).toContain('no longer running');
        expect(deadLines[0]).toContain(BUN_SOCKET_INHERIT_ISSUE_URL);
    });

    test('relays raw socket tool output on POSIX and stays quiet when tools fail', async () => {
        const { describePortHolders } = await loadListenModule();
        const ssRunner = jest.fn(async (command) => command === 'ss'
            ? 'LISTEN 0 511 127.0.0.1:4444 0.0.0.0:* users:(("node",pid=4321,fd=20))\n'
            : '');
        const failingRunner = jest.fn(async () => '');

        const lines = await describePortHolders(4444, { runCommand: ssRunner, platform: 'linux' });
        expect(lines).toEqual(['Port 4444: LISTEN 0 511 127.0.0.1:4444 0.0.0.0:* users:(("node",pid=4321,fd=20))']);

        await expect(describePortHolders(4444, { runCommand: failingRunner, platform: 'linux' })).resolves.toEqual([]);
    });
});

describe('server wiring', () => {
    test('shutdown releases the listen ports before tearing down state', () => {
        const source = readFileSync(SERVER_MAIN_SOURCE, 'utf8');

        expect(source).toContain('import { closeListeningServers } from \'./server-listen.js\';');
        expect(source).toContain('await closeListeningServers();');
        // The ports must be released before the slower teardown work runs.
        expect(source.indexOf('await closeListeningServers();')).toBeLessThan(source.indexOf('await statsOnExit();'));
        expect(source).toContain('if (process.connected === false)');
        expect(source).toContain('await exitAfterSupervisorDisconnect();');
        expect(source).toContain('process.on(\'message\', (message) =>');
        expect(source).toContain('process.on(\'disconnect\', exitAfterSupervisorDisconnect);');
        expect(source).toContain('process.on(\'SIGHUP\', () => exitProcess(0));');
        expect(source).toContain('process.on(\'SIGBREAK\', () => exitProcess(0));');
    });

    test('startup tracks its listeners and retries an occupied port', () => {
        const source = readFileSync(SERVER_STARTUP_SOURCE, 'utf8');

        expect(source).toContain('trackListeningServer(server);');
        expect(source).toContain('retryOnAddressInUse(() => createFunc(url, ipVersion)');
        expect(source).not.toContain('await createFunc(this.cliArgs.getIPv6ListenUrl(), 6);');
        expect(source).not.toContain('await createFunc(this.cliArgs.getIPv4ListenUrl(), 4);');
        expect(source).toContain('await Promise.all([startIPv6, startIPv4]);');
    });
});

describe('Android IPv4 readiness', () => {
    // Exercise the complete production class with deterministic interface
    // detection and bind outcomes. Real sockets are covered by the restart test.
    function startupFixture({ host = 'android', hasIPv4 = true, failIPv4 = false } = {}) {
        const source = readFileSync(SERVER_STARTUP_SOURCE, 'utf8');
        const bound = [];
        const watched = [];
        const bindError = Object.assign(new Error('occupied fixture IPv4 port'), { code: 'EADDRINUSE' });
        const http = {
            createServer() {
                const server = new EventEmitter();
                server.close = callback => callback?.();
                server.listen = ({ host }) => {
                    if (host === '127.0.0.1' && failIPv4) server.emit('error', bindError);
                    else {
                        server.listening = true;
                        bound.push(host);
                        server.emit('listening');
                    }
                };
                return server;
            },
        };
        const ServerStartup = vm.runInNewContext(`${source.slice(source.indexOf('export class ServerStartup')).replace('export class', 'class')}\nServerStartup;`, {
            http, URL,
            process: { env: host === 'android' ? { NECONYAN_ANDROID_APP: '1' } : host === 'ios' ? { NECONYAN_IOS_APP: '1' } : {}, versions: {}, platform: 'linux', exit: () => { throw new Error('unexpected fatal exit'); } },
            console: { log() {}, warn() {}, error() {} }, color: { green: value => value, red: value => value },
            getHasIP: async () => ({ hasIPv4Any: hasIPv4, hasIPv6Any: true }),
            urlHostnameToIPv6: value => value.replace(/^\[|\]$/g, ''),
            trackListeningServer() {}, retryOnAddressInUse: attempt => attempt(),
            keepAppListenerOpen: (server, options) => { watched.push(options); },
            isAddressInUseError: error => error?.code === 'EADDRINUSE', reportPortHolders: async () => {},
            writeStartupNote() {}, APP_NAME: 'Neconyan',
        });
        const startup = new ServerStartup(() => {}, {
            listen: true, ssl: false, enableIPv4: 'auto', enableIPv6: true,
            getIPv4ListenUrl: () => new URL('http://127.0.0.1:28193'),
            getIPv6ListenUrl: () => new URL('http://[::1]:28193'),
        });
        return { startup, bound, bindError, watched };
    }

    test('auto with detected IPv4 binds before readiness can be published', async () => {
        const { startup, bound } = startupFixture();
        const result = await startup.start();
        expect(result.useIPv4).toBe(true);
        expect(result.v4Failed).toBe(false);
        expect(bound).toContain('127.0.0.1');
        expect(bound).toContain('::1');
    });

    test('undetected IPv4 cannot publish Android readiness even with successful IPv6', async () => {
        const { startup, bound } = startupFixture({ hasIPv4: false });
        let ready = false;
        const starting = startup.start().then(() => { ready = true; });
        await expect(starting).rejects.toThrow(/requires IPv4/);
        expect(bound).toContain('::1');
        expect(bound).not.toContain('127.0.0.1');
        expect(ready).toBe(false);
    });

    test('occupied IPv4 cannot publish Android readiness even with successful IPv6', async () => {
        const { startup, bound, bindError } = startupFixture({ failIPv4: true });
        let ready = false;
        const starting = startup.start().then(() => { ready = true; });
        await expect(starting).rejects.toBe(bindError);
        expect(bound).toContain('::1');
        expect(bound).not.toContain('127.0.0.1');
        expect(ready).toBe(false);
    });

    test.each(['android', 'ios'])('the %s app keeps watching every listener with the address it bound', async host => {
        const { startup, watched } = startupFixture({ host });
        await startup.start();
        expect(watched).toEqual(expect.arrayContaining([
            expect.objectContaining({ host: '127.0.0.1', port: 28193 }),
            expect.objectContaining({ host: '::1', port: 28193 }),
        ]));
    });

    test('a desktop server leaves its listeners alone', async () => {
        const { startup, watched } = startupFixture({ host: 'desktop' });
        await startup.start();
        expect(watched).toEqual([]);
    });

    test.each(['desktop', 'ios'])('%s keeps successful IPv6 partial-stack behaviour', async host => {
        const { startup } = startupFixture({ host, failIPv4: true });
        const result = await startup.start();
        expect(result.v4Failed).toBe(true);
        expect(result.v6Failed).toBe(false);
    });
});

describe('phone app listener recovery', () => {
    /** @type {import('../src/server-listen.js')} */
    let listen;
    const servers = [];
    const watches = [];

    beforeEach(async () => {
        listen = await loadListenModule();
    });

    afterEach(async () => {
        for (const watch of watches.splice(0)) watch?.stop();
        await Promise.all(servers.splice(0).map(server => new Promise((resolve) => {
            server.closeAllConnections?.();
            if (server.listening) server.close(() => resolve());
            else resolve();
        })));
    });

    async function startServer(handler = (request, response) => response.end('ok')) {
        const server = http.createServer(handler);
        servers.push(server);
        server.listen({ host: '127.0.0.1', port: 0 });
        await once(server, 'listening');
        return server;
    }

    function get(port, path = '/') {
        return new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path, agent: false }, (response) => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { body += chunk; });
                response.on('end', () => resolve(body));
            }).on('error', reject);
        });
    }

    function fakeClock() {
        const clock = { time: 1_000_000, wakes: [] };
        clock.now = () => clock.time;
        clock.setTimer = (callback) => {
            const timer = { callback, unref() { return timer; } };
            clock.wakes.push(timer);
            return timer;
        };
        clock.clearTimer = jest.fn((timer) => {
            clock.wakes = clock.wakes.filter(entry => entry !== timer);
        });
        clock.advance = (ms) => {
            clock.time += ms;
            const due = clock.wakes.splice(0);
            for (const timer of due) timer.callback();
        };
        return clock;
    }

    const quietLog = () => ({ warn: jest.fn(), info: jest.fn() });
    // Unlike events.once, this keeps waiting through the 'error' that starts a recovery.
    const listensAgain = server => new Promise(resolve => server.once('listening', resolve));

    function watch(server, options) {
        const handle = listen.keepAppListenerOpen(server, { host: '127.0.0.1', port: server.address().port }, options);
        watches.push(handle);
        return handle;
    }

    test('a listening server accepts its own probe; a closed one or someone else\'s port does not', async () => {
        const server = await startServer();
        const ownListeners = server.listenerCount('connection');
        await expect(listen.listenerAccepts(server)).resolves.toBe(true);
        expect(server.listenerCount('connection')).toBe(ownListeners);

        const elsewhere = net.createServer(socket => socket.destroy());
        elsewhere.listen({ host: '127.0.0.1', port: 0 });
        await once(elsewhere, 'listening');
        const lost = Object.assign(new EventEmitter(), { listening: true, address: () => elsewhere.address() });
        await expect(listen.listenerAccepts(lost, { timeoutMs: 50 })).resolves.toBe(false);
        expect(lost.listenerCount('connection')).toBe(0);
        await new Promise(resolve => elsewhere.close(resolve));

        await new Promise(resolve => server.close(resolve));
        await expect(listen.listenerAccepts(server)).resolves.toBe(false);
    });

    test('ordinary wakes never probe; a wake long after it was due checks the listener and leaves a healthy one alone', async () => {
        const server = await startServer();
        const clock = fakeClock();
        const accepts = jest.fn(async () => true);
        const close = jest.spyOn(server, 'close');
        watch(server, { accepts, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: quietLog() });

        for (let wake = 0; wake < 10; wake++) clock.advance(listen.APP_LISTENER_CHECK_MS + 1_000);
        expect(accepts).not.toHaveBeenCalled();

        clock.advance(10 * 60_000);
        await new Promise(resolve => setImmediate(resolve));
        expect(accepts).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
        expect(clock.wakes).toHaveLength(1);
    });

    test('a listener that stopped accepting listens again on the same port while an open reply keeps streaming', async () => {
        let streaming = null;
        const server = await startServer((request, response) => {
            if (request.url === '/stream') {
                streaming = response;
                response.write('first ');
                return;
            }
            response.end('ok');
        });
        listen.trackListeningServer(server);
        server.on('listening', () => listen.trackListeningServer(server));
        const port = server.address().port;
        const log = quietLog();
        const { check } = watch(server, { accepts: async () => false, log });

        const reply = new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path: '/stream', agent: false }, (response) => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', chunk => {
                    body += chunk;
                    if (body === 'first ') resolve({ response, more: new Promise(done => response.on('end', () => done(body))) });
                });
            }).on('error', reject);
        });
        const { more } = await reply;

        await expect(check('test')).resolves.toBe(true);
        expect(server.listening).toBe(true);
        expect(server.address().port).toBe(port);
        await expect(get(port)).resolves.toBe('ok');
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('listening again'));

        streaming.end('second');
        await expect(more).resolves.toBe('first second');

        // Shutdown still finds the reopened server.
        await listen.closeListeningServers();
        expect(server.listening).toBe(false);
    });

    test('an error from a listener that still answers changes nothing; one that does not answer is reopened', async () => {
        const server = await startServer();
        const accepts = jest.fn(async () => true);
        const close = jest.spyOn(server, 'close');
        const log = quietLog();
        watch(server, { accepts, log });

        server.emit('error', Object.assign(new Error('accept ECONNABORTED'), { code: 'ECONNABORTED' }));
        await new Promise(resolve => setImmediate(resolve));
        expect(accepts).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();

        accepts.mockResolvedValue(false);
        const reopened = listensAgain(server);
        server.emit('error', Object.assign(new Error('accept EBADF'), { code: 'EBADF' }));
        await reopened;
        expect(close).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('EBADF'));
        await expect(get(server.address().port)).resolves.toBe('ok');
    });

    test('a port that cannot be taken back is tried again on every later wake until it frees up', async () => {
        const server = await startServer();
        const holder = await startServer();
        const port = holder.address().port;
        const clock = fakeClock();
        const accepts = jest.fn(async () => false);
        const log = quietLog();
        const handle = listen.keepAppListenerOpen(server, { host: '127.0.0.1', port }, {
            accepts, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
            relistenAttempts: 2, relistenDelayMs: 1, log,
        });
        watches.push(handle);

        await expect(handle.check('test')).resolves.toBe(false);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('attempt 2 of 2'));

        await new Promise(resolve => holder.close(resolve));
        const reopened = listensAgain(server);
        clock.advance(listen.APP_LISTENER_CHECK_MS);
        await reopened;
        expect(server.address().port).toBe(port);
        expect(accepts).toHaveBeenCalledTimes(1);
        await new Promise(resolve => setImmediate(resolve));
        expect(log.info).toHaveBeenCalledWith('The local server is accepting connections again.');
    });

    test('shutting the server down ends the watch, and a server is only ever watched once', async () => {
        const server = await startServer();
        const clock = fakeClock();
        const handle = watch(server, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: quietLog() });
        expect(listen.keepAppListenerOpen(server, {})).toBeNull();

        await new Promise(resolve => server.close(resolve));
        expect(clock.clearTimer).toHaveBeenCalled();
        expect(clock.wakes).toHaveLength(0);
        expect(server.listenerCount('error')).toBe(0);
        await expect(handle.check('after shutdown')).resolves.toBe(false);
    });
});
