#!/usr/bin/env node
// An owned local stand-in; it never connects to a network or an Obsidian account.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const folder = args[args.indexOf('--path') + 1];
if (!folder || !['sync-status', 'sync'].includes(args[0])) process.exit(10);
const record = path.join(path.dirname(folder), `.obsidian-test-${path.basename(folder)}.ndjson`);
fs.appendFileSync(record, JSON.stringify({ args, pid: process.pid }) + '\n');
if (args[0] === 'sync-status') {
    if (fs.existsSync(path.join(folder, '.fixture-status-hangs'))) {
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
    } else {
        process.stdout.write(JSON.stringify({ configured: true, secret: 'PRIVATE-CLIENT-OUTPUT' }));
        if (fs.existsSync(path.join(folder, '.fixture-not-prepared'))) process.exit(2);
        process.exit(0);
    }
} else {
    if (!args.includes('--continuous')) process.exit(11);
    fs.writeFileSync(path.join(folder, '.fixture-client-pid'), String(process.pid));
    process.stdout.write('PRIVATE-CLIENT-OUTPUT');
    process.stderr.write('PRIVATE-CLIENT-ERROR');
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => process.exit(0));
}
