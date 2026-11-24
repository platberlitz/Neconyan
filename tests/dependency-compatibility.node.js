import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import test from 'node:test';
import onnx from 'onnx-proto';

test('the patched Protobuf runtime still reads ONNX model metadata and tensor values', () => {
    const model = onnx.onnx.ModelProto.create({
        irVersion: 8,
        graph: { name: 'release-check', initializer: [{ name: 'weight', dims: [1], dataType: 1, floatData: [1.5] }] },
    });
    const restored = onnx.onnx.ModelProto.decode(onnx.onnx.ModelProto.encode(model).finish());
    assert.equal(restored.graph.name, 'release-check');
    assert.equal(Number(restored.irVersion), 8);
    assert.deepEqual(restored.graph.initializer[0].floatData, [1.5]);
});

test('simple-git resolves a parser with the CVE-2026-102829 fix', () => {
    const gitEntry = import.meta.resolve('simple-git');
    // Resolve from simple-git, not from Neconyan, in case it has a nested copy.
    const manifest = findPackageJSON('@simple-git/argv-parser', gitEntry);
    const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
    const [major, minor, patch] = version.split('.').map(Number);
    assert.ok(major > 2 || (major === 2 && (minor > 0 || (minor === 0 && patch >= 1))),
        `simple-git resolved vulnerable @simple-git/argv-parser ${version}`);
});
