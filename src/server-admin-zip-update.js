import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const RELEASE_API = 'https://api.github.com/repos/platberlitz/Neconyan/releases/latest';
const RELEASE_ROOT = 'https://github.com/platberlitz/Neconyan/releases';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const MAX_DOWNLOAD = 512 * 1024 * 1024;
const MAX_EXTRACTED = 2 * 1024 * 1024 * 1024;

function parseVersion(value) {
    const version = String(value ?? '').trim().replace(/^v/, '');
    if (!VERSION_PATTERN.test(version)) return null;
    const parts = version.split('.').map(Number);
    if (parts.some(part => !Number.isSafeInteger(part))) return null;
    while (parts.length < 4) parts.push(0);
    return { version, parts };
}

function newerThan(latest, current) {
    for (let index = 0; index < 4; index++) {
        if (latest.parts[index] !== current.parts[index]) return latest.parts[index] > current.parts[index];
    }
    return false;
}

function validAsset(asset, version) {
    const name = `Neconyan-${version}-source.zip`;
    return asset?.name === name
        && asset.browser_download_url === `${RELEASE_ROOT}/download/v${version}/${name}`
        && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_DOWNLOAD
        && /^sha256:[a-f0-9]{64}$/.test(asset.digest);
}

/** Cache release metadata while comparing each caller's installed version separately. */
export function createZipReleaseChecker({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    let cached;
    let expires = 0;
    let pending;
    async function readRelease(force) {
        if (!force && cached && now() < expires) return cached;
        if (pending) return pending;
        pending = (async () => {
            try {
                const response = await fetchImpl(RELEASE_API, {
                    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Neconyan-ZIP-Update' },
                    signal: AbortSignal.timeout(10000), redirect: 'error',
                });
                if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
                const chunks = [];
                let size = 0;
                for await (const chunk of response.body) {
                    size += chunk.length;
                    if (size > 2 * 1024 * 1024) throw new Error('GitHub returned too much release data.');
                    chunks.push(Buffer.from(chunk));
                }
                const release = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const latest = parseVersion(release.tag_name);
                if (!latest || release.tag_name !== `v${latest.version}` || release.draft || release.prerelease || !Array.isArray(release.assets)) {
                    throw new Error('GitHub did not return a stable Neconyan release.');
                }
                cached = { release, latest };
                expires = now() + 30 * 60 * 1000;
            } catch {
                cached = { error: 'Could not check GitHub for a ZIP update. Check your connection and try again.' };
                expires = now() + 60 * 1000;
            }
            return cached;
        })();
        try { return await pending; } finally { pending = null; }
    }
    return async function getStatus(currentVersion, { force = false } = {}) {
        const current = parseVersion(currentVersion);
        const status = {
            supported: true, checked: false, currentVersion: current?.version || String(currentVersion ?? ''),
            latestVersion: '', releaseName: '', releaseUrl: '', assetName: '', assetUrl: '',
            assetAvailable: false, canUpdate: false, message: '',
        };
        if (!current) return { ...status, message: 'This copy has an unrecognised version, so it cannot be updated automatically.' };
        const result = await readRelease(force);
        if (result.error) return { ...status, message: result.error };
        const { release, latest } = result;
        const asset = release.assets.find(item => validAsset(item, latest.version));
        const canUpdate = Boolean(asset) && newerThan(latest, current);
        return {
            ...status, checked: true, latestVersion: latest.version, releaseName: String(release.name || release.tag_name),
            releaseUrl: `${RELEASE_ROOT}/tag/${release.tag_name}`, assetName: asset?.name || '',
            assetUrl: asset?.browser_download_url || '', assetSize: asset?.size || 0, assetDigest: asset?.digest || '',
            assetAvailable: Boolean(asset), canUpdate,
            message: !asset ? 'The latest release has no verified source ZIP yet. Check again once it is published.'
                : canUpdate ? `Neconyan v${latest.version} is available. Updating will restart the server and keep your saved data and settings.`
                    : 'No newer ZIP release is available on GitHub.',
        };
    };
}

export const getLatestZipReleaseStatus = createZipReleaseChecker();

async function extractRelease(filename, releaseRoot, version) {
    const zip = await new Promise((resolve, reject) => yauzl.open(filename, { lazyEntries: true, strictFileNames: true },
        (error, archive) => error ? reject(error) : resolve(archive)));
    const prefix = `Neconyan-${version}/`;
    const seen = new Set();
    let count = 0;
    let total = 0;
    await new Promise((resolve, reject) => {
        const fail = error => { zip.close(); reject(error); };
        zip.on('error', fail);
        zip.on('end', resolve);
        zip.on('entry', entry => {
            (async () => {
                if (++count > 100000 || !entry.fileName.startsWith(prefix)) throw new Error('The release ZIP has an unexpected folder layout.');
                const relative = entry.fileName.slice(prefix.length).replace(/\/$/, '');
                if (!relative) { zip.readEntry(); return; }
                const parts = relative.split('/');
                if (parts.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f:<>"|?*]/.test(part)
                    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
                    throw new Error('The release ZIP contains an unsafe filename.');
                }
                const key = relative.toLowerCase();
                if (seen.has(key)) throw new Error('The release ZIP contains duplicate filenames.');
                seen.add(key);
                const mode = entry.externalFileAttributes >>> 16;
                const type = mode & 0o170000;
                // The source archive includes this contributor-only link to AGENTS.md.
                // It is not an application file and is never installed as a link.
                if (relative === 'CLAUDE.md' && type === 0o120000) { zip.readEntry(); return; }
                if (type && type !== 0o100000 && type !== 0o040000) throw new Error('The release ZIP contains a link or special file.');
                total += entry.uncompressedSize;
                if (!Number.isSafeInteger(total) || total > MAX_EXTRACTED || entry.uncompressedSize > MAX_DOWNLOAD) {
                    throw new Error('The release ZIP exceeds its extraction limit.');
                }
                const target = path.join(releaseRoot, ...parts);
                if (entry.fileName.endsWith('/')) {
                    fs.mkdirSync(target, { recursive: true });
                } else {
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    const input = await new Promise((resolveStream, rejectStream) => zip.openReadStream(entry,
                        (error, stream) => error ? rejectStream(error) : resolveStream(stream)));
                    await pipeline(input, fs.createWriteStream(target, { flags: 'wx', mode: mode & 0o777 || 0o644 }));
                }
                zip.readEntry();
            })().catch(fail);
        });
        zip.readEntry();
    });
}

/** Download and verify the official source asset before preparing any installed-file changes. */
export async function stageZipReleaseUpdate(release, { fetchImpl = globalThis.fetch, temporaryDirectory = os.tmpdir() } = {}) {
    const latest = parseVersion(release?.latestVersion);
    const current = parseVersion(release?.currentVersion);
    const asset = { name: release?.assetName, browser_download_url: release?.assetUrl, size: release?.assetSize, digest: release?.assetDigest };
    if (!latest || !current || !newerThan(latest, current) || !validAsset(asset, latest.version)) {
        throw new Error('A newer, verified Neconyan source ZIP is required. Check for updates again.');
    }
    const stagingRoot = fs.mkdtempSync(path.join(temporaryDirectory, 'neconyan-zip-update-'));
    try {
        const filename = path.join(stagingRoot, 'release.zip');
        const response = await fetchImpl(asset.browser_download_url, {
            headers: { 'User-Agent': 'Neconyan-ZIP-Update' }, signal: AbortSignal.timeout(10 * 60 * 1000),
        });
        if (!response.ok) throw new Error(`Could not download the release ZIP (HTTP ${response.status}).`);
        let size = 0;
        const hash = createHash('sha256');
        const check = new Transform({ transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > asset.size) return callback(new Error('The downloaded ZIP is larger than the published release.'));
            hash.update(chunk); callback(null, chunk);
        } });
        await pipeline(response.body, check, fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }));
        if (size !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) throw new Error('The downloaded ZIP does not match the published release.');
        const releaseRoot = path.join(stagingRoot, 'release');
        fs.mkdirSync(releaseRoot);
        await extractRelease(filename, releaseRoot, latest.version);
        const pkg = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'package.json'), 'utf8'));
        if (pkg.name !== 'neconyan' || pkg.version !== latest.version) throw new Error('The release ZIP contains the wrong application or version.');
        for (const relative of ['server.js', 'package-lock.json', 'src/server-main.js', 'public/index.html']) {
            if (!fs.statSync(path.join(releaseRoot, relative)).isFile()) throw new Error('The release ZIP is missing required application files.');
        }
        return { stagingRoot, releaseRoot, version: latest.version, assetName: asset.name };
    } catch (error) {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        throw error;
    }
}
