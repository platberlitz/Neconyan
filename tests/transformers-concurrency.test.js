import { afterAll, beforeAll, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let active = 0;
const events = [];
const factory = jest.fn(async (_task, model) => {
    events.push(`load:${model}`);
    const pipe = async () => model;
    pipe.dispose = async () => { expect(active).toBe(0); events.push(`dispose:${model}`); };
    return pipe;
});
jest.unstable_mockModule('sillytavern-transformers', () => ({ pipeline: factory,
    env: { backends: { onnx: { wasm: {} } } }, RawImage: {} }));
jest.unstable_mockModule('../src/util.js', () => ({ getConfigValue: (key, fallback) => key === 'extensions.models.captioning' ? 'default-caption' : fallback }));
const { runPipeline } = await import('../src/transformers.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-local-model-test-'));
let oldRoot;
beforeAll(() => { oldRoot = globalThis.DATA_ROOT; globalThis.DATA_ROOT = root; });
afterAll(() => { globalThis.DATA_ROOT = oldRoot; fs.rmSync(root, { recursive: true, force: true }); });

test('a later caption model waits for an in-flight operation and then returns to the configured default', async () => {
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const first = runPipeline('image-to-text', 'selected-caption', async pipe => {
        active++;
        entered();
        await new Promise(resolve => { release = resolve; });
        active--;
        return pipe();
    });
    await started;
    const next = runPipeline('image-to-text', 'other-caption', pipe => pipe());
    await Promise.resolve();
    expect(events).toEqual(['load:selected-caption']);
    release();
    await expect(first).resolves.toBe('selected-caption');
    await expect(next).resolves.toBe('other-caption');
    await expect(runPipeline('image-to-text', '', pipe => pipe())).resolves.toBe('default-caption');
    expect(events).toEqual(['load:selected-caption', 'dispose:selected-caption', 'load:other-caption', 'dispose:other-caption', 'load:default-caption']);
});

test('cancelled and failed work releases its task without loading a queued cancelled model', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Stopped'));
    await expect(runPipeline('image-to-text', 'cancelled-caption', () => { throw new Error('Unreachable'); }, { signal: controller.signal })).rejects.toThrow('Stopped');
    expect(events).not.toContain('load:cancelled-caption');
    await expect(runPipeline('image-to-text', '', () => { throw new Error('Local model failed'); })).rejects.toThrow('Local model failed');
    await expect(runPipeline('image-to-text', '', pipe => pipe())).resolves.toBe('default-caption');
});
/* global globalThis */
