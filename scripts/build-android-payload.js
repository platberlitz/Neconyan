import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const release = process.argv.includes('--release');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (release) {
    if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Release payloads require a clean committed checkout.');
    execFileSync(process.execPath, ['scripts/build-frontend-assets.js'], { cwd: root, stdio: 'inherit' });
    if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('The frontend build changed release source files.');
}
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
// The Android Node runtime carries English-only ICU data without word-break rules, so
// Intl.Segmenter crashes it (issue 80). Ship the full official data for the same ICU major.
const icu = {
    url: 'https://github.com/unicode-org/icu/releases/download/release-78.3/icu4c-78.3-data-bin-l.zip',
    zipSha256: '982619632b78887f1895b063e96e8c3cc7f99283337c8abbd05aa71635de613c',
    file: 'icudt78l.dat',
    sha256: 'd5cf2a40dccbe471781ec7af85693bff542ff12f0b670c9630c4e72d60714b8b',
};
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const icuCache = path.join(root, '.local-runtime/icu');
const icuZip = path.join(icuCache, path.basename(icu.url));
fs.mkdirSync(icuCache, { recursive: true });
if (!fs.existsSync(icuZip) || sha256(icuZip) !== icu.zipSha256) {
    const response = await fetch(icu.url);
    if (!response.ok) throw new Error(`Could not download ICU data: HTTP ${response.status}`);
    fs.writeFileSync(icuZip, Buffer.from(await response.arrayBuffer()));
    if (sha256(icuZip) !== icu.zipSha256) throw new Error('The downloaded ICU data does not match its pinned checksum.');
}
fs.mkdirSync(path.join(staging, 'icu'));
fs.writeFileSync(path.join(staging, 'icu', icu.file), execFileSync('unzip', ['-p', icuZip, icu.file], { maxBuffer: 64 * 1024 * 1024 }));
if (sha256(path.join(staging, 'icu', icu.file)) !== icu.sha256) throw new Error('The ICU data file does not match its pinned checksum.');
fs.writeFileSync(path.join(staging, 'icu', 'LICENSE'), execFileSync('unzip', ['-p', icuZip, 'LICENSE']));
const bundledExtensions = [...new Set(files.filter(name => name.startsWith('public/scripts/extensions/third-party/')).map(name => name.split('/')[4]))].filter(Boolean).sort();
fs.writeFileSync(path.join(staging, 'bundled-extensions.json'), JSON.stringify(bundledExtensions));
fs.cpSync(path.join(root, 'dist/frontend'), path.join(staging, 'dist/frontend'), { recursive: true });
if (release) {
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const manifest = fs.readFileSync(path.join(staging, 'dist/frontend/asset-manifest.json'));
    fs.writeFileSync(path.join(staging, 'release-provenance.json'), JSON.stringify({
        commit: git('rev-parse', 'HEAD'), version, frontendManifestSha256: createHash('sha256').update(manifest).digest('hex'),
    }, null, 2) + '\n');
}
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
