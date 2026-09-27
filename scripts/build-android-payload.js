import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const staging = path.join(root, '.local-runtime/android-payload');
const assets = path.join(root, 'android/app/src/main/assets');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
fs.mkdirSync(assets, { recursive: true });
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const name of files) {
    if (!/^(public\/|src\/|default\/|docs\/in-chat-agents-glossary\.md$|[^/]+\.js$|package(?:-lock)?\.json$|LICENSE$)/.test(name)) continue;
    const target = path.join(staging, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, name), target);
}
fs.copyFileSync(path.join(root, 'android/server-bootstrap.mjs'), path.join(staging, 'server-bootstrap.mjs'));
fs.copyFileSync(path.join(root, 'android/file-stats.mjs'), path.join(staging, 'file-stats.mjs'));
const bundledExtensions = [...new Set(files.filter(name => name.startsWith('public/scripts/extensions/third-party/')).map(name => name.split('/')[4]))].filter(Boolean).sort();
fs.writeFileSync(path.join(staging, 'bundled-extensions.json'), JSON.stringify(bundledExtensions));
fs.cpSync(path.join(root, 'dist/frontend'), path.join(staging, 'dist/frontend'), { recursive: true });
execFileSync('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging, stdio: 'inherit' });
const output = fs.createWriteStream(path.join(assets, 'server.zip'));
const archive = archiver('zip', { zlib: { level: 6 } });
await new Promise((resolve, reject) => {
    output.on('close', resolve).on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(staging, false);
    archive.finalize();
});
const hash = createHash('sha256');
for await (const chunk of fs.createReadStream(path.join(assets, 'server.zip'))) hash.update(chunk);
fs.writeFileSync(path.join(assets, 'server.sha256'), hash.digest('hex') + '\n');
console.log(`Android server payload: ${Math.round(output.bytesWritten / 1024 / 1024)} MiB`);
