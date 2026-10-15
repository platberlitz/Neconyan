import { jest } from '@jest/globals';
import { enhanceSpriteBitmap } from '../public/scripts/extensions/expressions/sprite-enhancement.js';

test('optional models stay off without a request', async () => {
    const fetchImpl = jest.fn();
    await enhanceSpriteBitmap({ width: 8, height: 8, data: new Uint8ClampedArray(256).fill(255) }, {}, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
});
test('matting removes enclosed gaps before upscale and never restores existing transparent pixels', async () => {
    const data = new Uint8ClampedArray(16 * 16 * 4).fill(255); data[3] = 0;
    const fetchImpl = jest.fn(async (url, request) => {
        if (url.includes('matting')) {
            const mask = new Uint8Array(256).fill(255); mask[8 * 16 + 8] = 0;
            return new Response(mask);
        }
        expect(request.body[3]).toBe(0);
        expect(request.body[(8 * 16 + 8) * 4 + 3]).toBe(0);
        expect(request.body[(6 * 16 + 6) * 4 + 3]).toBe(255);
        return new Response(new Uint8Array(32 * 32 * 4));
    });
    const result = await enhanceSpriteBitmap({ width: 16, height: 16, data }, { agentSpriteMatting: true, agentSpriteUpscale: 2 }, { fetchImpl });
    expect(result.width).toBe(32);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
});
test('failed or cancelled model processing cannot silently publish an unprocessed image', async () => {
    const image = { width: 8, height: 8, data: new Uint8ClampedArray(256) };
    await expect(enhanceSpriteBitmap(image, { agentSpriteMatting: true }, { fetchImpl: async () => new Response(JSON.stringify({ error: 'Download first' }), { status: 409 }) })).rejects.toThrow('Download first');
    const fetchImpl = jest.fn();
    await expect(enhanceSpriteBitmap(image, { agentSpriteMatting: true }, { fetchImpl, check: () => { throw new Error('stopped'); } })).rejects.toThrow('stopped');
    expect(fetchImpl).not.toHaveBeenCalled();
});
