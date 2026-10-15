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
        const red = data[i], green = data[i + 1], blue = data[i + 2], alpha = data[i + 3];
        sampled++;
        if (alpha < 250) { transparent++; return; }
        // Paper whites often straddle several quantisation buckets after JPEG
        // compression or generation. Treat their small tint/shade changes together.
        const key = Math.min(red, green, blue) >= 210 && spread(red, green, blue) <= 28
            ? 'paper' : [red, green, blue].map(channel => Math.floor(channel / 16)).join(',');
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
    // Only opaque border pixels are evidence. Partial cleanup may already have
    // removed some sides; fully transparent sprites must keep exposed white fur.
    const opaque = sampled - transparent;
    if (opaque < Math.max(6, sampled * 0.15)) return [];
    const dominant = sorted.filter(bucket => bucket.count >= opaque * 0.12).slice(0, 2);
    if (dominant.reduce((sum, bucket) => sum + bucket.count, 0) < opaque * 0.65) return [];
    const palette = dominant.map(bucket => [bucket.red / bucket.count, bucket.green / bucket.count, bucket.blue / bucket.count]);
    // Two shades are useful for a printed transparency grid. A colourful boundary
    // is more likely full-bleed artwork than a removable two-colour background.
    if (palette.length > 1 && palette.some(([r, g, b]) => spread(r, g, b) > 32)) return [];
    // Look around each corner, not just at its one pixel: tiny corner marks are
    // precisely the fragments cleanup should remove, not a reason to reject it.
    const size = Math.min(width, height, Math.max(2, Math.min(16, Math.ceil(Math.min(width, height) * 0.05))));
    const corners = [[0, 0], [width - size, 0], [0, height - size], [width - size, height - size]];
    const matching = corners.filter(([left, top]) => {
        let count = 0;
        for (let y = top; y < top + size; y++) for (let x = left; x < left + size; x++) {
            const i = (y * width + x) * 4;
            if (data[i + 3] >= 250 && isBackground(data, i, palette)) count++;
        }
        return count >= size * size * 0.65;
    });
    if (matching.length < 2) return [];
    return palette;
}

function isBackground(data, i, palette) {
    const red = data[i], green = data[i + 1], blue = data[i + 2], alpha = data[i + 3];
    if (alpha < ALPHA_THRESHOLD) return true;
    return palette.some(([r, g, b]) => (red - r) ** 2 + (green - g) ** 2 + (blue - b) ** 2 <= 32 ** 2
        || (Math.min(r, g, b) >= 210 && Math.min(red, green, blue) >= 210
            && spread(red, green, blue) <= 28 && Math.max(Math.abs(red - r), Math.abs(green - g), Math.abs(blue - b)) <= 38));
}

/** Recover antialiasing from the local foreground colour, rather than leaving a white fringe. */
function softenSpriteEdges(bitmap, background, palette, check, transparentCutout = false) {
    const { data, width, height } = bitmap;
    const core = new Uint8Array(width * height);
    const edges = [];
    for (let y = 0; y < height; y++) {
        if ((y & 63) === 0) check();
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            let outside = false, inside = false;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                // Partial coverage still belongs to the subject. Treating it as
                // outside would move the edge inwards on every cleanup pass.
                if (background[ny * width + nx]) outside = true;
                else inside = true;
            }
            if (!outside && data[pixel * 4 + 3] === 255) core[pixel] = 1;
            if (outside && inside && (data[pixel * 4 + 3] === 255 || (transparentCutout && data[pixel * 4 + 3] > 0))) edges.push(pixel);
        }
    }
    for (let pixel = 0; pixel < background.length; pixel++) if (background[pixel]) data[pixel * 4 + 3] = 0;
    const radius = Math.min(6, Math.max(3, Math.round(Math.min(width, height) / 256)));
    for (let index = 0; index < edges.length; index++) {
        if ((index & 1023) === 0) check();
        const pixel = edges[index], offset = pixel * 4, x = pixel % width, y = Math.floor(pixel / width);
        let bestDistance = Infinity, foreground = -1, bestAlpha = 1, nearestDistance = Infinity, nearestDifference = Infinity;
        for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx, ny = y + dy, distance = dx * dx + dy * dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height || !core[ny * width + nx]) continue;
            const candidate = (ny * width + nx) * 4;
            const difference = Math.max(Math.abs(data[candidate] - data[offset]), Math.abs(data[candidate + 1] - data[offset + 1]), Math.abs(data[candidate + 2] - data[offset + 2]));
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestDifference = difference;
            } else if (distance === nearestDistance) nearestDifference = Math.min(nearestDifference, difference);
            if (distance >= bestDistance) continue;
            for (const colour of palette) {
                let dot = 0, length = 0;
                for (let c = 0; c < 3; c++) {
                    const delta = data[candidate + c] - colour[c];
                    dot += (data[offset + c] - colour[c]) * delta;
                    length += delta * delta;
                }
                // A low-contrast white detail is not a reliable foreground sample.
                if (length < 48 ** 2) continue;
                const alpha = Math.max(0, Math.min(1, dot / length));
                let error = 0;
                for (let c = 0; c < 3; c++) error += (data[offset + c] - (colour[c] + alpha * (data[candidate + c] - colour[c]))) ** 2;
                if (error > 12 ** 2) continue;
                bestDistance = distance;
                foreground = candidate;
                bestAlpha = alpha;
            }
        }
        if (foreground < 0 || bestAlpha >= 0.98) continue;
        // A nearby matching solid colour is evidence of actual detail, including
        // white fur. Do not replace it with a darker sample farther inside.
        if (transparentCutout && nearestDifference < 16) continue;
        // Already-cut-out pixels carry their coverage in alpha. Correct their
        // colour without applying that coverage a second time.
        if (bestAlpha < 0.025) data[offset + 3] = 0;
        else if (!transparentCutout || data[offset + 3] === 255) data[offset + 3] = Math.round(255 * bestAlpha);
        for (let c = 0; c < 3; c++) data[offset + c] = data[foreground + c];
    }
}

/** Discard only tiny, distant edge fragments; keep detached details near the character. */
function removeCornerSpecks(bitmap, check) {
    const { data, width, height } = bitmap;
    const seen = new Uint8Array(width * height), queue = new Uint32Array(width * height);
    const components = [];
    let largest = null;
    for (let start = 0; start < seen.length; start++) {
        if ((start & 4095) === 0) check();
        if (seen[start] || data[start * 4 + 3] <= ALPHA_THRESHOLD) continue;
        let head = 0, tail = 1;
        queue[0] = start;
        seen[start] = 1;
        const component = { size: 0, minX: width, minY: height, maxX: -1, maxY: -1 };
        while (head < tail) {
            if ((head & 4095) === 0) check();
            const pixel = queue[head++], x = pixel % width, y = Math.floor(pixel / width);
            component.minX = Math.min(component.minX, x); component.maxX = Math.max(component.maxX, x);
            component.minY = Math.min(component.minY, y); component.maxY = Math.max(component.maxY, y);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy, next = ny * width + nx;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height || seen[next] || data[next * 4 + 3] <= ALPHA_THRESHOLD) continue;
                seen[next] = 1;
                queue[tail++] = next;
            }
        }
        component.size = tail;
        components.push(component);
        if (!largest || tail > largest.size) largest = component;
    }
    if (!largest) return;
    const limit = Math.min(width * height * 0.001, largest.size * 0.005);
    const margin = Math.max(3, Math.min(width, height) / 32);
    for (const component of components) {
        if (component.size > limit) continue;
        const atEdge = component.maxX < width * 0.1 || component.minX > width * 0.9
            || component.maxY < height * 0.1 || component.minY > height * 0.9;
        const distant = component.maxX < largest.minX - margin || component.minX > largest.maxX + margin
            || component.maxY < largest.minY - margin || component.minY > largest.maxY + margin;
        if (!atEdge || !distant) continue;
        // Include the fragment's faint fringe as well as its opaque pixels.
        for (let y = Math.max(0, component.minY - 1); y <= Math.min(height - 1, component.maxY + 1); y++) {
            for (let x = Math.max(0, component.minX - 1); x <= Math.min(width - 1, component.maxX + 1); x++) data[(y * width + x) * 4 + 3] = 0;
        }
    }
}

/** Remove confidently sampled, edge-connected backgrounds while protecting enclosed white detail. */
export function removeSpriteBackground(bitmap, check = () => {}) {
    validateBitmap(bitmap);
    const { data, width, height } = bitmap;
    check();
    const palette = backgroundPalette(bitmap);
    if (!palette.length) {
        const transparent = new Uint8Array(width * height);
        let count = 0;
        for (let pixel = 0; pixel < transparent.length; pixel++) {
            if (data[pixel * 4 + 3] === 0) { transparent[pixel] = 1; count++; }
        }
        // Previously cleaned PNGs have no opaque perimeter left to sample.
        // Their transparent outline still identifies the narrow edge to dematte.
        if (count) softenSpriteEdges(bitmap, transparent, [[255, 255, 255]], check, true);
        return bitmap;
    }
    const visited = new Uint8Array(width * height);
    const background = new Uint8Array(width * height);
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
        background[pixel] = 1;
        enqueue(x + 1, y); enqueue(x - 1, y); enqueue(x, y + 1); enqueue(x, y - 1);
    }
    softenSpriteEdges(bitmap, background, palette, check);
    removeCornerSpecks(bitmap, check);
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

/** Row-major equal cells with cumulative rounded edges, without clipping or resampling the artwork. */
export function splitSpriteBitmap(bitmap, grid, tileCount, options = {}) {
    validateBitmap(bitmap);
    if (!Number.isSafeInteger(grid?.columns) || !Number.isSafeInteger(grid?.rows) || grid.columns < 1 || grid.rows < 1
        || !Number.isSafeInteger(tileCount) || tileCount < 1 || tileCount > 64 || tileCount > grid.columns * grid.rows
        || grid.columns > bitmap.width || grid.rows > bitmap.height) throw new Error('The saved sprite sheet grid is invalid.');
    const tileWidth = bitmap.width / grid.columns, tileHeight = bitmap.height / grid.rows;
    const tiles = [];
    for (let index = 0; index < tileCount; index++) {
        options.check?.();
        const column = index % grid.columns, row = Math.floor(index / grid.columns);
        const left = Math.round(column * tileWidth), right = Math.round((column + 1) * tileWidth);
        const top = Math.round(row * tileHeight), bottom = Math.round((row + 1) * tileHeight);
        const width = right - left, height = bottom - top;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
            if ((y & 63) === 0) options.check?.();
            const start = ((top + y) * bitmap.width + left) * 4;
            data.set(bitmap.data.subarray(start, start + width * 4), y * width * 4);
        }
        tiles.push(cleanSpriteBitmap({ data, width, height }, options));
    }
    return tiles;
}
