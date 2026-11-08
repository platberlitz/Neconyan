import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { TOKEN_ENV } from '../scripts/lib/release-download.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const tokenEnvironment = `${TOKEN_ENV}: \${{ github.token }}`;

function stepBlock(workflow, name) {
    const marker = `      - name: ${name}\n`;
    const start = workflow.indexOf(marker);
    assert.notEqual(start, -1, `missing step: ${name}`);
    const next = workflow.indexOf('\n      - ', start + marker.length);
    return workflow.slice(start, next === -1 ? undefined : next);
}

function androidJob(workflow, name, end) {
    const start = workflow.indexOf(`  ${name}:\n`);
    const stop = workflow.indexOf(`  ${end}:\n`);
    assert.notEqual(start, -1, `missing job: ${name}`);
    assert.notEqual(stop, -1, `missing job: ${end}`);
    return workflow.slice(start, stop);
}

function assertTokenStep(workflow, name) {
    const block = stepBlock(workflow, name);
    assert.ok(block.includes(tokenEnvironment), `${name} must receive ${TOKEN_ENV}`);
    assert.doesNotMatch(block, /--token/);
}

function assertNoTokenStep(workflow, name) {
    assert.ok(!stepBlock(workflow, name).includes(TOKEN_ENV), `${name} must not receive ${TOKEN_ENV}`);
}

test('the Android and iOS runtime scripts use the verified fallback downloader', () => {
    const android = read('android/prepare-runtime.sh');
    assert.match(android, /node \.\.\/scripts\/fetch-release-asset\.js/);
    assert.match(android, /https:\/\/github\.com\/fogtape\/nodejs-mobile\/releases\/download\/v24\.21\.0-0\/nodejs-mobile-android-24\.21\.0-0\.zip/);
    assert.match(android, /e3cd29a1be03405f11dd5c857af8cd3ad13f84f1409ea648f5328f0bada5bd76/);
    assert.match(android, /sha256sum --check/);
    assert.doesNotMatch(android, /\bcurl\b/);

    const ios = read('ios/prepare-runtime.sh');
    assert.match(ios, /node \.\.\/scripts\/fetch-release-asset\.js/);
    assert.match(ios, /nodejs-mobile-ios-\$version\.zip/);
    assert.match(ios, /3fa1b8fb0720768b01c2e0dae3a17e788476e8c1613a1d9a54e206793b45326e/);
    assert.doesNotMatch(ios, /\bcurl\b/);
});

test('the Android payload builder downloads ICU through the verified fallback downloader', () => {
    const builder = read('scripts/build-android-payload.js');
    assert.match(builder, /import \{ downloadPinnedAsset \} from '\.\/lib\/release-download\.js'/);
    assert.match(builder, /await downloadPinnedAsset\(\{/);
    assert.match(builder, /982619632b78887f1895b063e96e8c3cc7f99283337c8abbd05aa71635de613c/);
    assert.doesNotMatch(builder, /await fetch\(icu\.url\)/);
});

test('the Android release workflow primes the pinned Gradle distribution before Gradle runs', () => {
    const workflow = read('.github/workflows/android-release.yml');
    const prime = workflow.indexOf('node scripts/prime-gradle-distribution.js');
    const gradle = workflow.indexOf('./gradlew --no-daemon assembleRelease lintRelease');
    assert.notEqual(prime, -1);
    assert.notEqual(gradle, -1);
    assert.ok(prime < gradle);
    assert.match(workflow, /name: Prime the pinned Gradle distribution/);
});

test('the Gradle wrapper keeps its existing checksum and has an exact released fallback', () => {
    const properties = read('android/gradle/wrapper/gradle-wrapper.properties');
    assert.match(properties, /distributionSha256Sum=20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78/);
    const helper = read('scripts/lib/gradle-distribution.js');
    assert.match(helper, /'gradle-8\.13-bin\.zip': 'https:\/\/github\.com\/gradle\/gradle-distributions\/releases\/download\/v8\.13\.0\/gradle-8\.13-bin\.zip'/);
});

test('the explicit GitHub token is passed only to the downloader steps', () => {
    const android = read('.github/workflows/android-release.yml');
    const baseline = androidJob(android, 'native-baseline', 'build');
    const build = androidJob(android, 'build', 'webview-fixture');
    assertTokenStep(baseline, 'Fetch the unstripped Node runtime to name crashing functions');
    assertTokenStep(build, 'Build committed server and frontend');
    assertTokenStep(build, 'Prepare the Android Node runtime');
    assertTokenStep(build, 'Prime the pinned Gradle distribution');
    assertNoTokenStep(build, 'Prepare Android toolchain');
    assertNoTokenStep(build, 'Build signed APKs');
    assert.equal((android.match(new RegExp(TOKEN_ENV, 'g')) || []).length, 4);
    assert.doesNotMatch(android, /--token/);

    const ios = read('.github/workflows/ios-build.yml');
    assertTokenStep(ios, 'Prepare the pinned iOS runtime');
    assertNoTokenStep(ios, 'Prepare the standalone server payload');
    assertNoTokenStep(ios, 'Generate the Xcode project');
    assertNoTokenStep(ios, 'Build real-device app without distribution signing');
    assert.equal((ios.match(new RegExp(TOKEN_ENV, 'g')) || []).length, 1);
    assert.doesNotMatch(ios, /--token/);
});

test('the optional Android baseline job installs the same pinned Node 24 before runtime preparation', () => {
    const workflow = read('.github/workflows/android-release.yml');
    const baseline = androidJob(workflow, 'native-baseline', 'build');
    assert.match(baseline, /uses: actions\/setup-node@cdca7365b2dadb8aad0a33bc7601856ffabcc48e # v4\.3\.0/);
    assert.match(baseline, /node-version: 24/);
    const setup = baseline.indexOf('uses: actions/setup-node@cdca7365b2dadb8aad0a33bc7601856ffabcc48e');
    const runtime = baseline.indexOf('bash android/prepare-runtime.sh');
    assert.ok(setup < runtime, 'setup-node must run before the runtime download');
    const pinned = [...workflow.matchAll(/uses: actions\/setup-node@([0-9a-f]{40})/g)].map(match => match[1]);
    assert.ok(pinned.length >= 2);
    assert.equal(new Set(pinned).size, 1);
});

test('the downloader CLI has no token argument', () => {
    const cli = read('scripts/fetch-release-asset.js');
    assert.ok(cli.includes('${TOKEN_ENV}'));
    assert.doesNotMatch(cli, /case '--token'/);
});
