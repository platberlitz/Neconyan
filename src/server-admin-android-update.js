import process from 'node:process';

const RELEASE_API = 'https://api.github.com/repos/platberlitz/Neconyan/releases/latest';
const RELEASE_ROOT = 'https://github.com/platberlitz/Neconyan/releases';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;

function parseVersion(value) {
    const version = String(value ?? '').replace(/^v/, '');
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

/** Cache release metadata, not an update decision: the installed version can change. */
export function createAndroidReleaseChecker({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    let cached;
    let expires = 0;
    let pending;

    async function readRelease({ force = false } = {}) {
        if (!force && cached && now() < expires) return cached;
        if (pending) return pending;
        pending = (async () => {
            try {
                const response = await fetchImpl(RELEASE_API, {
                    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Neconyan-Android-Update' },
                    signal: AbortSignal.timeout(10000),
                    redirect: 'error',
                });
                if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
                let text = '';
                let bytes = 0;
                const decoder = new TextDecoder();
                for await (const chunk of response.body) {
                    bytes += chunk.length;
                    if (bytes > 2 * 1024 * 1024) throw new Error('GitHub returned too much release data.');
                    text += decoder.decode(chunk, { stream: true });
                }
                const release = JSON.parse(text + decoder.decode());
                const latest = parseVersion(release.tag_name);
                if (!latest || release.tag_name !== `v${latest.version}` || release.draft || release.prerelease || !Array.isArray(release.assets)) {
                    throw new Error('GitHub did not return a stable APK release.');
                }
                cached = { release, latest };
                expires = now() + 30 * 60 * 1000;
            } catch {
                cached = { error: 'Could not check GitHub for an APK update. Check your connection and try again in a minute.' };
                expires = now() + 60 * 1000;
            }
            return cached;
        })();
        try { return await pending; } finally { pending = null; }
    }

    return async function getStatus(currentVersion, { platform = process.platform, arch = process.arch, env = process.env, force = false } = {}) {
        // Termux is also Android, but is updated through Git rather than the APK installer.
        if (platform !== 'android' || env.NECONYAN_ANDROID_APP !== '1') return null;
        const architecture = { arm64: 'arm64', x64: 'x86_64' }[arch] || '';
        const current = parseVersion(currentVersion);
        const status = {
            supported: true, checked: false, currentVersion: current?.version || String(currentVersion ?? ''),
            latestVersion: '', architecture, releaseUrl: '', assetName: '', assetUrl: '',
            assetAvailable: false, canUpdate: false, message: '',
        };
        if (!architecture || !current) {
            return { ...status, message: 'This Android build cannot check for compatible APK updates.' };
        }
        const result = await readRelease({ force });
        if (result.error) return { ...status, message: result.error };
        const { release, latest } = result;
        const assetName = `Neconyan-${latest.version}-android-${architecture}.apk`;
        const assetUrl = `${RELEASE_ROOT}/download/${release.tag_name}/${assetName}`;
        const assetAvailable = release.assets.some(asset => asset.name === assetName && asset.browser_download_url === assetUrl && asset.size > 0);
        const canUpdate = assetAvailable && newerThan(latest, current);
        return {
            ...status, checked: true, latestVersion: latest.version, assetName,
            releaseUrl: `${RELEASE_ROOT}/tag/${release.tag_name}`,
            assetUrl: assetAvailable ? assetUrl : '', assetAvailable, canUpdate,
            message: !assetAvailable ? 'The latest GitHub release has no APK for this device. Check again once the APK is published.'
                : canUpdate ? `Neconyan v${latest.version} is available from GitHub. Android will ask before installing it. Your saved data stays on this device.`
                    : 'No newer APK is available on GitHub.',
        };
    };
}

export const getLatestAndroidReleaseStatus = createAndroidReleaseChecker();
