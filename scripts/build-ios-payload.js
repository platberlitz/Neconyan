import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('iOS payloads require a clean committed checkout.');
execFileSync(process.execPath, ['scripts/build-frontend-assets.js'], { cwd: root, stdio: 'inherit' });
const target = path.join(root, 'ios/generated/server');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const name of files) {
    if (!/^(public\/|src\/|default\/|docs\/in-chat-agents-glossary\.md$|[^/]+\.js$|package(?:-lock)?\.json$|LICENSE$)/.test(name)) continue;
    fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true });
    fs.copyFileSync(path.join(root, name), path.join(target, name));
}
fs.copyFileSync(path.join(root, 'ios/server-bootstrap.mjs'), path.join(target, 'server-bootstrap.mjs'));
for (const notice of ['NODE-LICENSE.txt', 'POLYWASM-LICENSE.txt']) fs.copyFileSync(path.join(root, 'ios', notice), path.join(target, notice));
const extensions = [...new Set(files.filter(name => name.startsWith('public/scripts/extensions/third-party/')).map(name => name.split('/')[4]))].filter(Boolean).sort();
fs.writeFileSync(path.join(target, 'bundled-extensions.json'), JSON.stringify(extensions));
fs.cpSync(path.join(root, 'dist/frontend'), path.join(target, 'dist/frontend'), { recursive: true });
const provenance = {
    commit: git('rev-parse', 'HEAD'),
    version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    node: '24.22.1-0',
    frontendManifestSha256: createHash('sha256').update(fs.readFileSync(path.join(target, 'dist/frontend/asset-manifest.json'))).digest('hex'),
};
fs.writeFileSync(path.join(target, 'release-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
execFileSync('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: target, stdio: 'inherit' });
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path.join(root, 'ios/tools'), stdio: 'inherit' });
execFileSync(process.execPath, ['ios/tools/prepare-sentencepiece.mjs', target], { cwd: root, stdio: 'inherit' });
fs.writeFileSync(path.join(root, 'ios/generated/payload-version.txt'), provenance.commit + '\n');
const icons = path.join(root, 'ios/generated/Assets.xcassets/AppIcon.appiconset');
fs.mkdirSync(icons, { recursive: true });
fs.copyFileSync(path.join(root, 'public/img/neconyan-icon-512.png'), path.join(icons, 'icon.png'));
fs.writeFileSync(path.join(icons, 'Contents.json'), JSON.stringify({ images: [{ filename: 'icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }], info: { author: 'xcode', version: 1 } }));
console.log(`iOS server payload built for ${provenance.commit}`);
