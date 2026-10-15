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
