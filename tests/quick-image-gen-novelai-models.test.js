import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { isNovelAIV3OrNewerModel, isNovelAIV4PromptModel } from '../public/scripts/extensions/quick-image-gen/lib/hosted-provider.js';

const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('NovelAI model families', () => {
    // [model, needs the V4 prompt structures, sends ddim as ddim_v3]
    test.each([
        ['nai-diffusion-5-full', true, true],
        ['nai-diffusion-5-curated', true, true],
        ['NAI-DIFFUSION-5-FULL', true, true],
        ['nai-diffusion-4-5-curated', true, true],
        ['nai-diffusion-4-5-full', true, true],
        ['nai-diffusion-4-full', true, true],
        ['NAI-DIFFUSION-4-5-FULL', true, true],
        ['novelai-4.5', true, false],
        ['nai-diffusion-3', false, true],
        ['nai-diffusion-2', false, false],
        ['nai-diffusion', false, false],
        ['furry-diffusion', false, false],
        ['', false, false],
        [undefined, false, false],
        [null, false, false],
    ])('%s', (model, v4, v3OrNewer) => {
        expect(isNovelAIV4PromptModel(model)).toBe(v4);
        expect(isNovelAIV3OrNewerModel(model)).toBe(v3OrNewer);
    });

    test.each(['public/scripts/extensions/quick-image-gen/index.js', 'src/generation/quick-image-gen-novelai.js'])('%s decides the model family through the shared helpers', file => {
        const text = source(file);
        expect(text).not.toMatch(/includes\(["']-4["']\)/);
        expect(text).not.toMatch(/includes\(["']diffusion-[34]["']\)/);
        expect(text).toContain('isNovelAIV4PromptModel(');
        expect(text).toContain('isNovelAIV3OrNewerModel(');
    });
});
