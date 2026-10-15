import { cleanSpriteBitmap } from './sprite-pixels.js';
import { getExpressionSpriteBackground } from './sprite-prompts.js';

export async function enhanceSpriteBitmap(bitmap, settings, { headers, signal, check = () => {}, fetchImpl = fetch } = {}) {
    const process = async (kind, scale) => {
        check();
        const query = new URLSearchParams({ kind, width: bitmap.width, height: bitmap.height, scale: scale || 2 });
        const response = await fetchImpl(`/api/sprites/process?${query}`, {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: bitmap.data, signal,
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || `Sprite processing failed (${response.status}).`);
        }
        check();
        return new Uint8Array(await response.arrayBuffer());
    };
    const mask = settings.agentSpriteMatting ? await process('matting') : undefined;
    cleanSpriteBitmap(bitmap, { mask, removeBackground: settings.agentSpriteRemoveBackground
        || getExpressionSpriteBackground(settings.agentSpriteBackground) !== 'white', keyOnly: !settings.agentSpriteRemoveBackground, check });
    const scale = Number(settings.agentSpriteUpscale);
    if ([2, 4].includes(scale)) {
        const data = await process('upscale', scale), width = bitmap.width * scale, height = bitmap.height * scale;
        if (data.length !== width * height * 4) throw new Error('The upscaler returned an invalid image.');
        bitmap = { width, height, data: new Uint8ClampedArray(data) };
    }
    check();
    return bitmap;
}
