import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isHostAllowed } from 'host-validation-middleware';

// This file is also run on the code before the change, so it imports nothing the change adds at the top: the
// tests that need the new module import it inside their own body, and the server tests only read what a real
// start prints and answers.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-host-whitelist-entries-')));
process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));

const entriesModule = () => import('../src/host-whitelist-entries.js');

const NORMALISED = [
    ['neconyan.purabunny.cc', 'neconyan.purabunny.cc'],
    ['https://neconyan.purabunny.cc', 'neconyan.purabunny.cc'],
    ['https://neconyan.purabunny.cc/', 'neconyan.purabunny.cc'],
    ['http://example.com:8443/', 'example.com'],
    ['HTTPS://Example.COM/', 'example.com'],
    ['hTtP://example.com', 'example.com'],
    ['  https://example.com/  ', 'example.com'],
    ['https://example.com/some/path', 'example.com'],
    ['https://example.com?token=abc', 'example.com'],
    ['https://example.com/#top', 'example.com'],
    ['https://example.com:443/a/b?c=d#e', 'example.com'],
    ['example.com/', 'example.com'],
    ['example.com:8000', 'example.com'],
    ['localhost:3000', 'localhost'],
    ['  Example.COM  ', 'example.com'],
    ['.example.com', '.example.com'],
    ['.trycloudflare.com', '.trycloudflare.com'],
    ['.Example.com:8443/', '.example.com'],
    ['my_host.lan', 'my_host.lan'],
    ['example.com.', 'example.com.'],
    ['192.168.1.5', '192.168.1.5'],
    ['192.168.1.5:8080', '192.168.1.5'],
    ['http://[::1]:8000/', '[::1]'],
    ['[::1]', '[::1]'],
    ['::1', '::1'],
];

const REFUSED = [
    ['https://', 'invalid'],
    ['http://', 'invalid'],
    ['http:///', 'invalid'],
    ['https:///example.com', 'invalid'],
    ['https://:443', 'invalid'],
    ['https://?x', 'invalid'],
    ['//example.com', 'invalid'],
    ['.', 'invalid'],
    ['..', 'invalid'],
    ['.:8000', 'invalid'],
    ['https://./', 'dottedUrl'],
    ['https://.example.com', 'dottedUrl'],
    ['a..b.com', 'invalid'],
    ['exa mple.com', 'invalid'],
    ['example.com /', 'invalid'],
    ['exam\tple.com', 'invalid'],
    ['example.com\nevil.com', 'invalid'],
    ['bücher.de', 'invalid'],
    ['example.com:', 'invalid'],
    ['example.com:/path', 'invalid'],
    ['https://example.com:8443abc', 'invalid'],
    ['example.com:80:80', 'invalid'],
    ['localhost:abc', 'invalid'],
    ['localhost:', 'invalid'],
    ['example.com:abc/x', 'invalid'],
    ['https://localhost:abc/', 'invalid'],
    ['https://good.com\\evil.com', 'invalid'],
    ['[::1', 'invalid'],
    ['[not-ip]', 'invalid'],
    ['[::1]junk', 'invalid'],
    ['file:///etc/passwd', 'scheme'],
    ['file:/etc/passwd', 'scheme'],
    ['file:', 'scheme'],
    ['FILE://example.com', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['javascript://example.com/%0aalert(1)', 'scheme'],
    ['ftp://example.com', 'scheme'],
    ['ws://example.com', 'scheme'],
    ['chrome-extension://abcdef', 'scheme'],
    ['data:text/html,hi', 'scheme'],
    ['about:blank', 'scheme'],
    ['vbscript:msgbox(1)', 'scheme'],
    ['ftp:example.com', 'scheme'],
    ['wss://example.com', 'scheme'],
    ['chrome-extension:abcdef', 'scheme'],
    ['mailto:me@example.com', 'userinfo'],
    ['https://user:pass@example.com', 'userinfo'],
    ['https://user@example.com', 'userinfo'],
    ['https://good.com@evil.com', 'userinfo'],
    ['https://good.com\\@evil.com', 'userinfo'],
    ['https://good.com:443@evil.com/', 'userinfo'],
    ['user:secret@example.com', 'userinfo'],
    ['@evil.com', 'userinfo'],
    ['*.example.com', 'wildcard'],
    ['https://*.example.com/', 'wildcard'],
    ['*', 'wildcard'],
];

// Host headers a refused or blank entry must never let through. ':80' and 'evil.com.' are what an empty entry or a
// bare '.' would have matched in host-validation-middleware.
const PROBES = ['evil.com', 'evil.com.', 'good.com', 'example.com', 'a.example.com', 'etc', 'file', 'javascript', ':80', 'x', '-', '_'];

test('W1 pasted addresses become the bare host name the library compares against', async () => {
    const { normaliseHostWhitelistEntry } = await entriesModule();
    for (const [entry, host] of NORMALISED) {
        assert.deepEqual(normaliseHostWhitelistEntry(entry), { host }, JSON.stringify(entry));
    }
});

test('W2 empty, malformed, foreign-scheme, userinfo and wildcard entries are refused, never guessed at', async () => {
    const { normaliseHostWhitelistEntry, HOST_ENTRY_REASONS } = await entriesModule();
    for (const [entry, reason] of REFUSED) {
        assert.deepEqual(normaliseHostWhitelistEntry(entry), { reason }, JSON.stringify(entry));
        assert.ok(HOST_ENTRY_REASONS[reason], reason);
    }
    for (const entry of ['', ' ', '\t\n', null, undefined, 8080, true, {}, ['example.com']]) {
        assert.equal(normaliseHostWhitelistEntry(entry), null, JSON.stringify(entry));
    }
});

test('W3 no refused or blank entry lets any host through', async () => {
    const { normaliseHostWhitelist } = await entriesModule();
    const entries = [...REFUSED.map(([entry]) => entry), '', ' ', null, 8080];
    const { hosts, changed, ignored } = normaliseHostWhitelist(entries);
    assert.deepEqual(hosts, []);
    assert.deepEqual(changed, []);
    for (const probe of PROBES) {
        assert.equal(isHostAllowed(probe, Object.freeze(hosts)), false, probe);
    }
    assert.equal(ignored.length, REFUSED.length);
    // The same entries left raw would have been far more permissive.
    assert.equal(isHostAllowed(':80', ['']), true);
    assert.equal(isHostAllowed('evil.com.', ['.']), true);
});

test('W4 normalised lists keep their first-seen order with duplicates dropped', async () => {
    const { normaliseHostWhitelist } = await entriesModule();
    const result = normaliseHostWhitelist([
        'https://neconyan.purabunny.cc/',
        'neconyan.purabunny.cc',
        'NECONYAN.purabunny.cc',
        'http://neconyan.purabunny.cc:8443',
        '.example.com',
        'https://neconyan.purabunny.cc/',
        'example.com',
        '.example.com',
        'ftp://neconyan.purabunny.cc',
        'ftp://neconyan.purabunny.cc',
    ]);
    assert.deepEqual(result.hosts, ['neconyan.purabunny.cc', '.example.com', 'example.com']);
    assert.deepEqual(result.changed, [
        { shown: '\'https://neconyan.purabunny.cc/\'', host: 'neconyan.purabunny.cc' },
        { shown: '\'http://neconyan.purabunny.cc:8443\'', host: 'neconyan.purabunny.cc' },
    ]);
    assert.deepEqual(result.ignored, [
        { shown: '\'ftp://neconyan.purabunny.cc\'', reason: 'only http:// and https:// addresses can be listed' },
    ]);
    // The same address in another case is one line in the note, not two.
    assert.deepEqual(normaliseHostWhitelist(['https://A.example.test/', 'https://a.example.test/', 'FTP://b.test', 'ftp://b.test']), {
        hosts: ['a.example.test'],
        changed: [{ shown: '\'https://A.example.test/\'', host: 'a.example.test' }],
        ignored: [{ shown: '\'FTP://b.test\'', reason: 'only http:// and https:// addresses can be listed' }],
        notAList: null,
    });
});

test('W4b a value that is not a list allows nothing and says what it was, without guessing at it', async () => {
    const { normaliseHostWhitelist, parseHostListEnv } = await entriesModule();
    const empty = { hosts: [], changed: [], ignored: [] };
    for (const value of [undefined, null, [], '', '   ']) {
        assert.deepEqual(normaliseHostWhitelist(value), { ...empty, notAList: null }, JSON.stringify(value));
    }
    assert.deepEqual(normaliseHostWhitelist('example.com'), { ...empty, notAList: 'the text \'example.com\'' });
    assert.deepEqual(normaliseHostWhitelist('a.example.test,b.example.test'), { ...empty, notAList: 'the text \'a.example.test,b.example.test\'' });
    assert.deepEqual(normaliseHostWhitelist('https://kris:hunter2@x.test'), { ...empty, notAList: 'the text an entry with a user name or password (not shown)' });
    assert.deepEqual(normaliseHostWhitelist('x.test\u001b[2J'), { ...empty, notAList: 'the text \'x.test?[2J\'' });
    assert.deepEqual(normaliseHostWhitelist(8080), { ...empty, notAList: '8080' });
    assert.deepEqual(normaliseHostWhitelist(true), { ...empty, notAList: 'true' });
    assert.deepEqual(normaliseHostWhitelist({ 'example.com': true }), { ...empty, notAList: 'a set of named values' });
    assert.equal(parseHostListEnv(''), null);
    assert.equal(parseHostListEnv('  '), null);
    assert.equal(parseHostListEnv('null'), null);
    assert.deepEqual(parseHostListEnv('["https://x.test/"]'), ['https://x.test/']);
    assert.equal(parseHostListEnv('"https://bad"'), 'https://bad');
    assert.equal(parseHostListEnv('a.example.test,b.example.test'), 'a.example.test,b.example.test');
});

test('W5 normalised entries match through host-validation-middleware as the written name would', async () => {
    const { normaliseHostWhitelist } = await entriesModule();
    const hosts = Object.freeze(normaliseHostWhitelist(['https://neconyan.purabunny.cc/', 'http://.example.org', '.example.com:8443', 'http://example.net:8443/x']).hosts);
    const allowed = ['neconyan.purabunny.cc', 'neconyan.purabunny.cc:443', 'neconyan.purabunny.cc:8443', 'example.com', 'a.example.com', 'a.b.example.com:8443', 'example.net', 'example.net:8443', '127.0.0.1:8000', '[::1]:8000', 'localhost:8000'];
    const blocked = ['untrusted.example.test', 'evil.purabunny.cc', 'purabunny.cc', 'neconyan.purabunny.cc.evil.com', 'badexample.com', 'example.com.evil.test', 'example.org', 'a.example.org', 'sub.example.net', 'https', 'http'];
    for (const host of allowed) assert.equal(isHostAllowed(host, hosts), true, host);
    for (const host of blocked) assert.equal(isHostAllowed(host, hosts), false, host);
});

test('W6 log text hides credentials, query strings and terminal control characters', async () => {
    const { showHostWhitelistEntry } = await entriesModule();
    assert.equal(showHostWhitelistEntry('https://user:hunter2@example.com'), 'an entry with a user name or password (not shown)');
    assert.equal(showHostWhitelistEntry('https://good.com@evil.com'), 'an entry with a user name or password (not shown)');
    assert.equal(showHostWhitelistEntry('https://example.com/?token=hunter2'), '\'https://example.com/...\'');
    assert.equal(showHostWhitelistEntry('https://example.com/#hunter2'), '\'https://example.com/...\'');
    assert.equal(showHostWhitelistEntry('ex\u001b[31mample\u202e.com'), '\'ex?[31mample?.com\'');
    assert.equal(showHostWhitelistEntry('a\u2028b\u2029c\u0085d'), '\'a?b?c?d\'');
    assert.equal(showHostWhitelistEntry(`  ${'a'.repeat(150)}  `), `'${'a'.repeat(100)}...'`);
});

test('W7 the startup note appears only when an entry was rewritten or refused', async () => {
    const { describeHostWhitelist, normaliseHostWhitelist } = await entriesModule();
    const source = '/srv/neconyan/config.yaml';
    for (const entries of [undefined, null, '', [], ['example.com', '.example.org', 'Example.NET', '  spaced.test  ', 'example.com', '', null]]) {
        for (const enforced of [true, false]) {
            assert.deepEqual(describeHostWhitelist(normaliseHostWhitelist(entries), { source, enforced }), { notes: [], warnings: [] }, JSON.stringify(entries));
        }
    }
    const entries = ['https://neconyan.purabunny.cc/', 'https://me:hunter2@evil.com', 'ftp://x.test'];
    const { notes, warnings } = describeHostWhitelist(normaliseHostWhitelist(entries), { source });
    assert.deepEqual(notes, [
        'Host whitelist: hostWhitelist.hosts lists host names, so Neconyan is using the name on the right for each of these entries:',
        '  \'https://neconyan.purabunny.cc/\' -> neconyan.purabunny.cc',
        'To tidy up, write just the host name in /srv/neconyan/config.yaml. Neconyan hasn\'t changed it.',
    ]);
    assert.deepEqual(warnings, [
        'Host whitelist: ignoring these hostWhitelist.hosts entries, so they allow no requests:',
        '  an entry with a user name or password (not shown): it has a user name or password in it',
        '  \'ftp://x.test\': only http:// and https:// addresses can be listed',
        'Fix or remove them in /srv/neconyan/config.yaml and restart Neconyan.',
    ]);
    assert.ok(!`${notes}${warnings}`.includes('hunter2'));
    assert.ok(!`${notes}${warnings}`.includes('evil.com'));

    // With only the scan on, every request still gets through, so a refused entry means scan reports, not blocks.
    const scanOnly = describeHostWhitelist(normaliseHostWhitelist(entries), { source, enforced: false });
    assert.deepEqual(scanOnly.notes, notes);
    assert.equal(scanOnly.warnings[0], 'Host whitelist: ignoring these hostWhitelist.hosts entries, so the scan reports requests for them as untrusted:');
    assert.ok(!scanOnly.warnings.join('\n').includes('allow no requests'));
});

test('W7b a value that is not a list gets a warning naming where it came from', async () => {
    const { describeHostWhitelist, normaliseHostWhitelist } = await entriesModule();
    assert.deepEqual(describeHostWhitelist(normaliseHostWhitelist('https://neconyan.purabunny.cc/'), { source: '/srv/neconyan/config.yaml' }), {
        notes: [],
        warnings: [
            'Host whitelist: hostWhitelist.hosts has to be a list of host names, but /srv/neconyan/config.yaml sets it to the text \'https://neconyan.purabunny.cc/\'. Neconyan is ignoring it, so only localhost and IP addresses get through.',
            'Write it as a list, for example hosts: [\'example.com\'], and restart Neconyan.',
        ],
    });
    const fromEnv = describeHostWhitelist(normaliseHostWhitelist('a.example.test,b.example.test'), { source: 'the SILLYTAVERN_HOSTWHITELIST_HOSTS environment variable', fromEnv: true, enforced: false });
    assert.deepEqual(fromEnv.warnings, [
        'Host whitelist: hostWhitelist.hosts has to be a list of host names, but the SILLYTAVERN_HOSTWHITELIST_HOSTS environment variable sets it to the text \'a.example.test,b.example.test\'. Neconyan is ignoring it, so the scan reports every host name except localhost as untrusted.',
        'Write it as a list, for example SILLYTAVERN_HOSTWHITELIST_HOSTS=\'["example.com"]\', and restart Neconyan.',
    ]);
    const secret = describeHostWhitelist(normaliseHostWhitelist('https://kris:hunter2@x.test\u2028'), { source: 'config.yaml' });
    assert.ok(!secret.warnings.join('\n').includes('hunter2') && !secret.warnings.join('\n').includes('kris'));
});

test('W8 the one-time host check switch counts a pasted address as listing the launch host', async () => {
    const { upgradeHostCheck } = await import('../src/config-init.js');
    const config = { hostWhitelist: { enabled: false, hosts: ['https://st.example.test/'] }, browserLaunch: { hostname: 'st.example.test' } };
    assert.deepEqual(upgradeHostCheck(config), { addedHosts: [] });
    assert.deepEqual(config.hostWhitelist.hosts, ['https://st.example.test/']);
    const other = { hostWhitelist: { enabled: false, hosts: ['ftp://st.example.test'] }, browserLaunch: { hostname: 'st.example.test' } };
    assert.deepEqual(upgradeHostCheck(other), { addedHosts: ['st.example.test'] });
});

// Starts the real middleware in its own process, as a server start would, and sends one request per Host header.
const CHILD = `
import http from 'node:http';
import express from 'express';
const { setConfigFilePath } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src', 'util.js')).href)});
setConfigFilePath(process.env.TEST_CONFIG);
globalThis.DATA_ROOT = process.env.TEST_DATA_ROOT;
const { default: middleware } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'src', 'middleware', 'hostWhitelist.js')).href)});
console.log('--- requests ---');
const app = express();
app.use(middleware);
app.use((_req, res) => res.status(200).send('passed'));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const statuses = {};
for (const host of JSON.parse(process.env.TEST_HOSTS)) {
    statuses[host] = await new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: server.address().port, headers: { host } }, response => {
            response.resume();
            response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
        request.end();
    });
}
server.close();
console.log('STATUSES ' + JSON.stringify(statuses));
`;

let counter = 0;
async function startMiddleware({ section, hosts, env = {} }) {
    const folder = path.join(base, `run-${++counter}`);
    fs.mkdirSync(path.join(folder, 'data', '_errors'), { recursive: true });
    const config = path.join(folder, 'config.yaml');
    fs.writeFileSync(config, section);
    const before = fs.readFileSync(config);
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
        cwd: root,
        env: { ...process.env, ...env, NODE_ENV: 'production', FORCE_COLOR: '0', TEST_CONFIG: config, TEST_DATA_ROOT: path.join(folder, 'data'), TEST_HOSTS: JSON.stringify(hosts) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.on('close', resolve));
    assert.equal(code, 0, output);
    const [startup, rest] = output.split('--- requests ---');
    const statuses = JSON.parse(/STATUSES (.*)/.exec(rest)[1]);
    assert.ok(fs.readFileSync(config).equals(before), 'config.yaml is left byte for byte as it was');
    return { config, startup, requests: rest, statuses };
}

const section = (enabled, scan, hosts) => ['hostWhitelist:', `  enabled: ${enabled}`, `  scan: ${scan}`, '  hosts:', ...hosts.map(host => `    - ${JSON.stringify(host)}`), ''].join('\n');

test('W9 a server with a pasted https address lets that host in, blocks others and says what it used', async () => {
    const { config, startup, statuses } = await startMiddleware({
        section: section(true, false, ['https://neconyan.purabunny.cc/']),
        hosts: ['neconyan.purabunny.cc', 'NeconYan.PuraBunny.cc:443', 'untrusted.example.test', 'neconyan.purabunny.cc.evil.test'],
    });
    assert.deepEqual(statuses, { 'neconyan.purabunny.cc': 200, 'NeconYan.PuraBunny.cc:443': 200, 'untrusted.example.test': 403, 'neconyan.purabunny.cc.evil.test': 403 });
    assert.ok(startup.includes('\'https://neconyan.purabunny.cc/\' -> neconyan.purabunny.cc'), startup);
    assert.ok(startup.includes(`write just the host name in ${config}`), startup);
});

test('W10 a list of clean host names starts silently and still matches', async () => {
    const { startup, statuses } = await startMiddleware({
        section: section(true, false, ['example.com', '.example.org', 'Example.NET']),
        hosts: ['example.com', 'a.example.org', 'example.net:8000', 'evil.test'],
    });
    assert.equal(startup.trim(), '');
    assert.deepEqual(statuses, { 'example.com': 200, 'a.example.org': 200, 'example.net:8000': 200, 'evil.test': 403 });
});

test('W11 credentials in a refused entry never reach the log, and the host they name stays blocked', async () => {
    const { startup, statuses } = await startMiddleware({
        section: section(true, false, ['https://kris:hunter2@good.example.test', 'https://good.example.test@evil.example.test', 'https://', '.', 'file:///etc/passwd']),
        hosts: ['good.example.test', 'evil.example.test', 'evil.example.test.', 'etc'],
    });
    assert.deepEqual(statuses, { 'good.example.test': 403, 'evil.example.test': 403, 'evil.example.test.': 403, 'etc': 403 });
    assert.ok(startup.includes('ignoring these hostWhitelist.hosts entries'), startup);
    assert.ok(!startup.includes('hunter2') && !startup.includes('kris'), startup);
    assert.ok(!startup.includes('-> '), 'no entry was turned into a host name');
});

test('W12 a switched-off check stays quiet, but the scan that still reads the list gets the note', async () => {
    const quiet = await startMiddleware({ section: section(false, false, ['https://neconyan.purabunny.cc/', 'ftp://x.test']), hosts: ['untrusted.example.test'] });
    assert.equal(quiet.startup.trim(), '');
    assert.deepEqual(quiet.statuses, { 'untrusted.example.test': 200 });
    const scanned = await startMiddleware({ section: section(false, true, ['https://neconyan.purabunny.cc/']), hosts: ['neconyan.purabunny.cc', 'untrusted.example.test'] });
    assert.ok(scanned.startup.includes('-> neconyan.purabunny.cc'), scanned.startup);
    assert.deepEqual(scanned.statuses, { 'neconyan.purabunny.cc': 200, 'untrusted.example.test': 200 });
    // The scan counts the tidied name as listed, so only the other host is reported.
    assert.ok(scanned.requests.includes('Request from untrusted host: untrusted.example.test'), scanned.requests);
    assert.ok(!scanned.requests.includes('untrusted host: neconyan.purabunny.cc'), scanned.requests);
    assert.ok(!scanned.requests.includes('add neconyan.purabunny.cc'), scanned.requests);
});

test('W13 a list from the environment is normalised too, and the note and scan advice name the variable', async () => {
    const { startup, requests, statuses } = await startMiddleware({
        section: section(true, true, []),
        hosts: ['neconyan.purabunny.cc', 'untrusted.example.test'],
        env: { SILLYTAVERN_HOSTWHITELIST_HOSTS: JSON.stringify(['https://neconyan.purabunny.cc:8443/']) },
    });
    assert.deepEqual(statuses, { 'neconyan.purabunny.cc': 200, 'untrusted.example.test': 403 });
    assert.ok(startup.includes('in the SILLYTAVERN_HOSTWHITELIST_HOSTS environment variable'), startup);
    // The variable overrides config.yaml, so editing the file would not help.
    assert.ok(requests.includes('add untrusted.example.test to the list in the SILLYTAVERN_HOSTWHITELIST_HOSTS environment variable and restart Neconyan.'), requests);
    assert.ok(!requests.includes('under hostWhitelist -> hosts'), requests);
});

const NOT_A_LIST = 'hostWhitelist.hosts has to be a list of host names';

test('W14 a single address written without list brackets is reported, not dropped silently, and allows nothing', async () => {
    for (const value of ['https://neconyan.purabunny.cc/', 'neconyan.purabunny.cc', '8080', '{ neconyan.purabunny.cc: true }']) {
        const { config, startup, statuses } = await startMiddleware({
            section: ['hostWhitelist:', '  enabled: true', '  scan: false', `  hosts: ${value}`, ''].join('\n'),
            hosts: ['neconyan.purabunny.cc', 'untrusted.example.test', '127.0.0.1'],
        });
        assert.deepEqual(statuses, { 'neconyan.purabunny.cc': 403, 'untrusted.example.test': 403, '127.0.0.1': 200 }, value);
        assert.ok(startup.includes(`${NOT_A_LIST}, but ${config} sets it to`), startup);
        assert.ok(startup.includes('so only localhost and IP addresses get through'), startup);
    }
    const secret = await startMiddleware({
        section: ['hostWhitelist:', '  enabled: true', '  scan: false', '  hosts: https://kris:hunter2@neconyan.purabunny.cc/', ''].join('\n'),
        hosts: ['neconyan.purabunny.cc'],
    });
    assert.deepEqual(secret.statuses, { 'neconyan.purabunny.cc': 403 });
    assert.ok(secret.startup.includes(NOT_A_LIST), secret.startup);
    assert.ok(!secret.startup.includes('hunter2') && !secret.startup.includes('kris'), secret.startup);
    for (const value of ['', '[]', 'null', '~']) {
        const quiet = await startMiddleware({ section: ['hostWhitelist:', '  enabled: true', '  scan: true', `  hosts: ${value}`, ''].join('\n'), hosts: ['localhost'] });
        assert.equal(quiet.startup.trim(), '', value);
    }
});

test('W15 an environment value that is not a JSON list is reported by name, and its hosts stay blocked', async () => {
    for (const value of ['a.example.test,b.example.test', 'https://a.example.test/', '"https://a.example.test/"', '{"a.example.test":true}']) {
        const { startup, statuses } = await startMiddleware({
            section: section(true, false, ['c.example.test']),
            hosts: ['a.example.test', 'b.example.test', 'c.example.test'],
            env: { SILLYTAVERN_HOSTWHITELIST_HOSTS: value },
        });
        assert.deepEqual(statuses, { 'a.example.test': 403, 'b.example.test': 403, 'c.example.test': 403 }, value);
        assert.ok(startup.includes(`${NOT_A_LIST}, but the SILLYTAVERN_HOSTWHITELIST_HOSTS environment variable sets it to`), startup);
        assert.ok(startup.includes('SILLYTAVERN_HOSTWHITELIST_HOSTS=\'["example.com"]\''), startup);
    }
    const scanOnly = await startMiddleware({
        section: section(false, true, []),
        hosts: ['a.example.test'],
        env: { SILLYTAVERN_HOSTWHITELIST_HOSTS: 'https://kris:hunter2@a.example.test' },
    });
    assert.deepEqual(scanOnly.statuses, { 'a.example.test': 200 });
    assert.ok(scanOnly.startup.includes('so the scan reports every host name except localhost as untrusted'), scanOnly.startup);
    assert.ok(!scanOnly.startup.includes('hunter2') && !scanOnly.startup.includes('kris'), scanOnly.startup);
    for (const value of ['', '[]', 'null']) {
        const quiet = await startMiddleware({ section: section(true, true, []), hosts: ['localhost'], env: { SILLYTAVERN_HOSTWHITELIST_HOSTS: value } });
        assert.equal(quiet.startup.trim(), '', JSON.stringify(value));
    }
});
