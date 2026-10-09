const ALPHA_THRESHOLD = 24;
const MAX_PIXELS = 16 * 1024 * 1024;
const spread = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

function validateBitmap({ data, width, height }) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
        || width * height > MAX_PIXELS || !(data instanceof Uint8Array || data instanceof Uint8ClampedArray)
        || data.length !== width * height * 4) {
        throw new Error('The sprite bitmap dimensions are invalid.');
    }
}

function backgroundPalette({ data, width, height }) {
    const buckets = new Map();
    let transparent = 0, sampled = 0;
    const sample = (x, y) => {
        const i = (y * width + x) * 4;
        const [red, green, blue, alpha] = data.subarray(i, i + 4);
        sampled++;
        if (alpha < 250) { transparent++; return; }
        const key = [red, green, blue].map(channel => Math.floor(channel / 16)).join(',');
        const bucket = buckets.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
        bucket.count++;
        bucket.red += red;
        bucket.green += green;
        bucket.blue += blue;
        buckets.set(key, bucket);
    };
    for (let x = 0; x < width; x++) { sample(x, 0); sample(x, height - 1); }
    for (let y = 1; y < height - 1; y++) { sample(0, y); sample(width - 1, y); }
    const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
    // Existing alpha is not evidence of a white background. In particular, walking
    // from transparent pixels into white fur would remove the character itself.
    if (transparent > sampled * 0.2) return [];
    const dominant = sorted.filter(bucket => bucket.count >= sampled * 0.12).slice(0, 2);
    if (dominant.reduce((sum, bucket) => sum + bucket.count, 0) < sampled * 0.65) return [];
    const palette = dominant.map(bucket => [bucket.red / bucket.count, bucket.green / bucket.count, bucket.blue / bucket.count]);
    // Two shades are useful for a printed transparency grid. A colourful boundary
    // is more likely full-bleed artwork than a removable two-colour background.
    if (palette.length > 1 && palette.some(([r, g, b]) => spread(r, g, b) > 32)) return [];
    const corners = [0, width - 1, (height - 1) * width, width * height - 1];
    if (corners.filter(pixel => isBackground(data, pixel * 4, palette)).length < 2) return [];
    return palette;
}

function isBackground(data, i, palette) {
    const [red, green, blue, alpha] = data.subarray(i, i + 4);
    if (alpha < ALPHA_THRESHOLD) return true;
    return palette.some(([r, g, b]) => (red - r) ** 2 + (green - g) ** 2 + (blue - b) ** 2 <= 32 ** 2);
}

/** Remove only edge-connected, confidently sampled backgrounds. Never remove enclosed detail. */
export function removeSpriteBackground(bitmap, check = () => {}) {
    validateBitmap(bitmap);
    const { data, width, height } = bitmap;
    check();
    const palette = backgroundPalette(bitmap);
    if (!palette.length) return bitmap;
    const visited = new Uint8Array(width * height);
    const stack = new Uint32Array(width * height);
    let count = 0;
    const enqueue = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const pixel = y * width + x;
        if (visited[pixel]) return;
        visited[pixel] = 1;
        if (isBackground(data, pixel * 4, palette)) stack[count++] = pixel;
    };
    for (let x = 0; x < width; x++) { enqueue(x, 0); enqueue(x, height - 1); }
    for (let y = 1; y < height - 1; y++) { enqueue(0, y); enqueue(width - 1, y); }
    let processed = 0;
    while (count) {
        if ((processed++ & 4095) === 0) check();
        const pixel = stack[--count];
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        data[pixel * 4 + 3] = 0;
        enqueue(x + 1, y); enqueue(x - 1, y); enqueue(x, y + 1); enqueue(x, y - 1);
    }
    return bitmap;
}

export function spriteForegroundBounds(bitmap) {
    validateBitmap(bitmap);
    const { data, width, height } = bitmap;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] <= ALPHA_THRESHOLD) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (maxX < minX || maxY < minY || (maxX - minX + 1 < Math.min(width, height) * 0.08
        && maxY - minY + 1 < Math.min(width, height) * 0.08)) return null;
    return { minX, minY, maxX, maxY };
}

export function centreSprite(bitmap) {
    const bounds = spriteForegroundBounds(bitmap);
    if (!bounds) return bitmap;
    const { data, width, height } = bitmap;
    const shiftX = width / 2 - (bounds.minX + (bounds.maxX - bounds.minX + 1) / 2);
    const shiftY = height / 2 - (bounds.minY + (bounds.maxY - bounds.minY + 1) / 2);
    if (Math.abs(shiftX) <= 1 && Math.abs(shiftY) <= 1) return bitmap;
    const dx = Math.round(shiftX), dy = Math.round(shiftY);
    const snapshot = data.slice();
    data.fill(0);
    for (let y = 0; y < height; y++) {
        const targetY = y + dy;
        if (targetY < 0 || targetY >= height) continue;
        const from = Math.max(0, -dx), to = Math.min(width, width - dx);
        if (to > from) data.set(snapshot.subarray((y * width + from) * 4, (y * width + to) * 4), (targetY * width + from + dx) * 4);
    }
    return bitmap;
}

export function cleanSpriteBitmap(bitmap, { removeBackground = false, check = () => {} } = {}) {
    check();
    if (removeBackground) removeSpriteBackground(bitmap, check);
    centreSprite(bitmap);
    check();
    return bitmap;
}

/** Row-major equal cells, cumulative rounded edges, and a small inset to exclude neighbouring sprites. */
export function splitSpriteBitmap(bitmap, grid, tileCount, options = {}) {
    validateBitmap(bitmap);
    if (!Number.isSafeInteger(grid?.columns) || !Number.isSafeInteger(grid?.rows) || grid.columns < 1 || grid.rows < 1
        || !Number.isSafeInteger(tileCount) || tileCount < 1 || tileCount > 64 || tileCount > grid.columns * grid.rows
        || grid.columns > bitmap.width || grid.rows > bitmap.height) throw new Error('The saved sprite sheet grid is invalid.');
    const tileWidth = bitmap.width / grid.columns, tileHeight = bitmap.height / grid.rows;
    const width = Math.max(1, Math.round(tileWidth)), height = Math.max(1, Math.round(tileHeight));
    const tiles = [];
    for (let index = 0; index < tileCount; index++) {
        options.check?.();
        const column = index % grid.columns, row = Math.floor(index / grid.columns);
        const left = Math.round(column * tileWidth), right = Math.round((column + 1) * tileWidth);
        const top = Math.round(row * tileHeight), bottom = Math.round((row + 1) * tileHeight);
        const insetX = Math.min((right - left) / 4, Math.max(1, (right - left) * 0.045));
        const insetY = Math.min((bottom - top) / 4, Math.max(1, (bottom - top) * 0.045));
        const sourceWidth = right - left - insetX * 2, sourceHeight = bottom - top - insetY * 2;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
            if ((y & 63) === 0) options.check?.();
            const sy = top + insetY + (y + 0.5) * sourceHeight / height - 0.5;
            const y0 = Math.max(top, Math.min(bottom - 1, Math.floor(sy))), y1 = Math.min(bottom - 1, y0 + 1);
            const fy = Math.max(0, Math.min(1, sy - y0));
            for (let x = 0; x < width; x++) {
                const sx = left + insetX + (x + 0.5) * sourceWidth / width - 0.5;
                const x0 = Math.max(left, Math.min(right - 1, Math.floor(sx))), x1 = Math.min(right - 1, x0 + 1);
                const fx = Math.max(0, Math.min(1, sx - x0));
                const samples = [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)],
                    [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]];
                const channels = [0, 0, 0, 0];
                for (const [px, py, weight] of samples) {
                    const offset = (py * bitmap.width + px) * 4;
                    const alpha = bitmap.data[offset + 3] * weight;
                    channels[3] += alpha;
                    for (let channel = 0; channel < 3; channel++) channels[channel] += bitmap.data[offset + channel] * alpha;
                }
                const offset = (y * width + x) * 4;
                data[offset + 3] = channels[3];
                if (channels[3]) for (let channel = 0; channel < 3; channel++) data[offset + channel] = channels[channel] / channels[3];
            }
        }
        tiles.push(cleanSpriteBitmap({ data, width, height }, options));
    }
    return tiles;
}
