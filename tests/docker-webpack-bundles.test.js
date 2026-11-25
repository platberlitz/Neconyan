import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverMainSource = readFileSync(path.join(repoRoot, 'src', 'server-main.js'), 'utf8');
const buildLibSource = readFileSync(path.join(repoRoot, 'docker', 'build-lib.js'), 'utf8');
const dockerfileSource = readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');

// The image's dist folder belongs to the build user, so a container running as another user cannot
// compile a bundle at run time. Every bundle the server serves has to be built when the image is.
const servedBundles = ['lib', ...[...serverMainSource.matchAll(/bundle:\s*'([^']+)'/g)].map(match => match[1])];

describe('Docker image precompiles every webpack bundle the server serves', () => {
    test('the server serves more than the default bundle', () => {
        expect(servedBundles.length).toBeGreaterThan(1);
    });

    test('docker/build-lib.js builds every served bundle', () => {
        const missing = servedBundles.filter(name => !buildLibSource.includes(`'${name}'`));
        expect(missing).toEqual([]);
    });

    test('Dockerfile still runs docker/build-lib.js', () => {
        expect(dockerfileSource).toContain('bun "./docker/build-lib.js"');
    });
});
