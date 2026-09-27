import assert from 'node:assert/strict';
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
