import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createAndroidReleaseChecker } from '../src/server-admin-android-update.js';

const android = { platform: 'android', arch: 'arm64', env: { NECONYAN_ANDROID_APP: '1' } };
function release(version = '1.3.0', architecture = 'arm64') {
    const name = `Neconyan-${version}-android-${architecture}.apk`;
    return { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ name, size: 342227206,
        browser_download_url: `https://github.com/platberlitz/Neconyan/releases/download/v${version}/${name}` }] };
}
function checker(payload = release()) {
    let calls = 0;
    let time = 0;
    const check = createAndroidReleaseChecker({ now: () => time, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, 'https://api.github.com/repos/platberlitz/Neconyan/releases/latest');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.Authorization, undefined);
        return payload instanceof Error ? Promise.reject(payload) : Response.json(payload);
    } });
    return { check, calls: () => calls, advance: milliseconds => { time += milliseconds; } };
}

test('only the packaged Android server checks GitHub, not Termux or desktop', async () => {
    const fixture = checker();
    for (const runtime of [{ ...android, platform: 'linux' }, { ...android, env: {} }]) {
        assert.equal(await fixture.check('1.2.9', runtime), null);
    }
    assert.equal(fixture.calls(), 0);
});

test('selects the official APK for the native architecture', async () => {
    const arm = await checker().check('1.2.9', android);
    assert.equal(arm.canUpdate, true);
    assert.equal(arm.latestVersion, '1.3.0');
    assert.equal(arm.architecture, 'arm64');
    assert.match(arm.assetUrl, /Neconyan-1\.3\.0-android-arm64\.apk$/);
    const x64 = await checker(release('1.3.0', 'x86_64')).check('1.2.9', { ...android, arch: 'x64' });
    assert.equal(x64.canUpdate, true);
    assert.equal(x64.architecture, 'x86_64');
});

test('compares numeric releases, including four-part hotfixes, without offering downgrades', async () => {
    for (const [current, latest, expected] of [
        ['1.2.9', '1.2.10', true], ['1.2.4', '1.2.4.1', true], ['1.2.4.1', '1.2.4', false],
        ['1.3.0', '1.3.0', false], ['1.3.1', '1.3.0', false], ['1.2.4.0', '1.2.4', false],
    ]) assert.equal((await checker(release(latest)).check(current, android)).canUpdate, expected, `${current} -> ${latest}`);
});

test('missing, empty or untrusted APK assets never enable updating', async () => {
    for (const modify of [data => { data.assets = []; }, data => { data.assets[0].size = 0; },
        data => { data.assets[0].browser_download_url = 'https://example.com/app.apk'; }]) {
        const payload = release();
        modify(payload);
        const result = await checker(payload).check('1.2.9', android);
        assert.equal(result.checked, true);
        assert.equal(result.assetAvailable, false);
        assert.equal(result.canUpdate, false);
        assert.equal(result.assetUrl, '');
    }
});

test('drafts, prereleases and malformed tags are check failures, not updates', async () => {
    for (const override of [{ draft: true }, { prerelease: true }, { tag_name: 'v1.3.0-beta' }, { tag_name: '../evil' }, { tag_name: '1.3.0' }]) {
        const result = await checker({ ...release(), ...override }).check('1.2.9', android);
        assert.equal(result.checked, false);
        assert.equal(result.canUpdate, false);
    }
});

test('unsupported versions and architectures do not request metadata', async () => {
    const fixture = checker();
    assert.equal((await fixture.check('1.2.9', { ...android, arch: 'arm' })).canUpdate, false);
    assert.equal((await fixture.check('development', android)).canUpdate, false);
    assert.equal(fixture.calls(), 0);
});

test('coalesces concurrent checks, caches for thirty minutes and recomputes the installed version', async () => {
    const fixture = checker();
    const results = await Promise.all([fixture.check('1.2.9', android), fixture.check('1.3.0', android)]);
    assert.equal(fixture.calls(), 1);
    assert.equal(results[0].canUpdate, true);
    assert.equal(results[1].canUpdate, false);
    fixture.advance(30 * 60 * 1000);
    await fixture.check('1.2.9', android);
    assert.equal(fixture.calls(), 2);
});

test('an explicit refresh bypasses the cached GitHub release metadata', async () => {
    const fixture = checker();
    await fixture.check('1.2.9', android);
    await fixture.check('1.2.9', android);
    assert.equal(fixture.calls(), 1);
    await fixture.check('1.2.9', { ...android, force: true });
    assert.equal(fixture.calls(), 2);
    await fixture.check('1.2.9', android);
    assert.equal(fixture.calls(), 2);
});

test('the explicit server status refresh reaches both repository and APK release checks', () => {
    const endpoint = fs.readFileSync(new URL('../src/endpoints/server-admin.js', import.meta.url), 'utf8');
    assert.match(endpoint, /const forceRefresh = request\.body\?\.forceRefresh === true;[\s\S]*getRepositoryStatus\(\{ refresh: forceRefresh \}\)[\s\S]*getLatestAndroidReleaseStatus\(version\.pkgVersion, \{ force: forceRefresh \}\)/);
});

test('network errors retry after a minute without claiming the app is up to date', async () => {
    const fixture = checker(new Error('offline'));
    const status = await fixture.check('1.2.9', android);
    assert.equal(status.checked, false);
    assert.equal(status.canUpdate, false);
    await fixture.check('1.2.9', android);
    assert.equal(fixture.calls(), 1);
    fixture.advance(60000);
    await fixture.check('1.2.9', android);
    assert.equal(fixture.calls(), 2);
});

test('HTTP failures and oversized metadata are rejected', async () => {
    for (const response of [new Response('', { status: 403 }), new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
        const check = createAndroidReleaseChecker({ fetchImpl: async () => response });
        assert.equal((await check('1.2.9', android)).checked, false);
    }
});
