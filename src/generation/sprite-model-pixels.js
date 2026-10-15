/** Bilinear sampling with clamped edges, shared by mask and alpha resizing. */
export function samplePlane(data, width, height, x, y, stride = 1, channel = 0) {
    x = Math.max(0, Math.min(width - 1, x)); y = Math.max(0, Math.min(height - 1, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const dx = x - x0, dy = y - y0;
    const at = (sx, sy) => data[(sy * width + sx) * stride + channel];
    return (at(x0, y0) * (1 - dx) + at(x1, y0) * dx) * (1 - dy)
        + (at(x0, y1) * (1 - dx) + at(x1, y1) * dx) * dy;
}

export async function matteSprite({ data, width, height }, infer) {
    const size = 1024, plane = size * size, ratio = size / Math.max(width, height);
    const w = Math.max(1, Math.round(width * ratio)), h = Math.max(1, Math.round(height * ratio));
    const left = Math.floor((size - w) / 2), top = Math.floor((size - h) / 2);
    const input = new Float32Array(3 * plane);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = (x + 0.5) * width / w - 0.5, sy = (y + 0.5) * height / h - 0.5;
        const alpha = samplePlane(data, width, height, sx, sy, 4, 3) / 255;
        for (let c = 0; c < 3; c++) input[c * plane + (y + top) * size + x + left]
            = samplePlane(data, width, height, sx, sy, 4, c) / 255 * alpha + 1 - alpha;
    }
    const output = await infer(input, size, size);
    if (output.length !== plane) throw new Error('The background model returned invalid pixels.');
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const value = samplePlane(output, size, size, left + (x + 0.5) * w / width - 0.5, top + (y + 0.5) * h / height - 0.5);
        if (!Number.isFinite(value)) throw new Error('The background model returned invalid pixels.');
        mask[y * width + x] = Math.round(Math.max(0, Math.min(1, value)) * 255);
    }
    return { width, height, data: mask };
}

/** Extend edge colours into empty pixels so the RGB-only model cannot invent a black fringe. */
function extendColours(data, width, height) {
    const result = new Uint8Array(data), seen = new Uint8Array(width * height), queue = new Uint32Array(width * height);
    let head = 0, tail = 0;
    for (let p = 0; p < seen.length; p++) if (data[p * 4 + 3]) { seen[p] = 1; queue[tail++] = p; }
    while (head < tail) {
        const p = queue[head++], x = p % width, y = Math.floor(p / width);
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const next = ny * width + nx;
            if (seen[next]) continue;
            seen[next] = 1; queue[tail++] = next;
            for (let c = 0; c < 3; c++) result[next * 4 + c] = result[p * 4 + c];
        }
    }
    return result;
}

/** Bounded 88px tiles, with 20px overlap discarded to avoid seams between tiles. */
export async function upscaleSprite({ data, width, height, scale = 2 }, infer) {
    const core = 48, pad = 20, tile = core + 2 * pad, plane = tile * tile;
    const rgb = extendColours(data, width, height), outWidth = width * scale, outHeight = height * scale;
    const result = new Uint8ClampedArray(outWidth * outHeight * 4), step = 4 / scale;
    for (let top = 0; top < height; top += core) for (let left = 0; left < width; left += core) {
        const input = new Float32Array(3 * plane);
        for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
            const sx = Math.max(0, Math.min(width - 1, left + x - pad)), sy = Math.max(0, Math.min(height - 1, top + y - pad));
            for (let c = 0; c < 3; c++) input[c * plane + y * tile + x] = rgb[(sy * width + sx) * 4 + c] / 255;
        }
        const output = await infer(input, tile, tile), outTile = tile * 4, outPlane = outTile * outTile;
        if (output.length !== 3 * outPlane) throw new Error('The upscaler returned invalid pixels.');
        for (let y = 0; y < Math.min(core, height - top) * scale; y++) for (let x = 0; x < Math.min(core, width - left) * scale; x++) {
            const ox = left * scale + x, oy = top * scale + y, offset = (oy * outWidth + ox) * 4;
            for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++)
                    sum += output[c * outPlane + (pad * 4 + y * step + dy) * outTile + pad * 4 + x * step + dx];
                if (!Number.isFinite(sum)) throw new Error('The upscaler returned invalid pixels.');
                result[offset + c] = Math.round(sum / (step * step) * 255);
            }
            result[offset + 3] = Math.round(samplePlane(data, width, height, (ox + 0.5) / scale - 0.5, (oy + 0.5) / scale - 0.5, 4, 3));
        }
    }
    return { width: outWidth, height: outHeight, data: result };
}
