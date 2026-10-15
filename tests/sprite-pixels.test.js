import { cleanSpriteBitmap, removeSpriteBackground, splitSpriteBitmap, spriteForegroundBounds } from '../public/scripts/extensions/expressions/sprite-pixels.js';

function bitmap(colour, width = 16, height = width) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(colour, i);
    return { width, height, data };
}

const pixel = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
const paint = (image, x, y, colour) => image.data.set(colour, (y * image.width + x) * 4);

describe('conservative transparency cleanup', () => {
    test('existing alpha and exposed white fur survive unchanged', () => {
        const image = bitmap([255, 255, 255, 0]);
        for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) image.data.set([255, 255, 255, x === 4 ? 128 : 255], (y * 16 + x) * 4);
        const before = image.data.slice();
        cleanSpriteBitmap(image, { removeBackground: true });
        expect(image.data).toEqual(before);
    });
    test.each([{ name: 'white', colour: [255, 255, 255, 255] }, { name: 'green', colour: [0, 220, 0, 255] }])('removes a $name edge background but retains enclosed white detail', ({ colour }) => {
        const image = bitmap(colour);
        for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) image.data.set([180, 20, 40, 255], (y * 16 + x) * 4);
        image.data.set([255, 255, 255, 255], (7 * 16 + 7) * 4);
        removeSpriteBackground(image);
        expect(image.data[3]).toBe(0);
        expect(image.data[(7 * 16 + 7) * 4 + 3]).toBe(255);
    });
    test('a printed grey checkerboard is removed only outside the subject', () => {
        const image = bitmap([255, 255, 255, 255]);
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
            const shade = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 ? 190 : 255;
            image.data.set(x >= 5 && x <= 10 && y >= 5 && y <= 10 ? [180, 20, 40, 255] : [shade, shade, shade, 255], (y * 16 + x) * 4);
        }
        removeSpriteBackground(image);
        expect(image.data[3]).toBe(0);
        expect(image.data[(3 * 16 + 3) * 4 + 3]).toBe(0);
        expect(image.data[(7 * 16 + 7) * 4 + 3]).toBe(255);
    });
    test('cleanup is opt-in, cancellable and rejects non-byte buffers', () => {
        const image = bitmap([255, 255, 255, 255]);
        cleanSpriteBitmap(image);
        expect(image.data[3]).toBe(255);
        expect(() => removeSpriteBackground(image, () => { throw new Error('cancelled'); })).toThrow('cancelled');
        expect(() => cleanSpriteBitmap({ width: 1, height: 1, data: new Float32Array(1) })).toThrow('dimensions');
    });

    test('off-white gradients and compression noise do not split the border into unrelated colours', () => {
        const image = bitmap([255, 255, 255, 255], 96);
        for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
            const shade = 220 + Math.round(x * 35 / 95);
            paint(image, x, y, [shade, shade - (y % 3), shade - 4, 255]);
        }
        for (let y = 24; y < 72; y++) for (let x = 24; x < 72; x++) paint(image, x, y, [35, 55, 80, 255]);
        removeSpriteBackground(image);
        for (const [x, y] of [[0, 0], [95, 95], [4, 48], [90, 48]]) expect(pixel(image, x, y)[3]).toBe(0);
        expect(pixel(image, 48, 48)).toEqual([35, 55, 80, 255]);
    });

    test('a partly transparent border still supplies evidence for its remaining opaque background', () => {
        const image = bitmap([250, 248, 245, 255], 64);
        for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) paint(image, x, y, [40, 70, 100, 255]);
        for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
            if (x < 16 || x >= 48 || y < 16) paint(image, x, y, [0, 0, 0, 0]);
        }
        removeSpriteBackground(image);
        expect(pixel(image, 0, 63)[3]).toBe(0);
        expect(pixel(image, 8, 40)[3]).toBe(0);
        expect(pixel(image, 32, 32)).toEqual([40, 70, 100, 255]);
    });

    test('white-matted antialiasing becomes a soft foreground-coloured edge', () => {
        const image = bitmap([255, 255, 255, 255], 64);
        const foreground = [35, 55, 75];
        for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) paint(image, x, y, [...foreground, 255]);
        for (const [x, alpha] of [[14, 0.1], [15, 0.5]]) for (let y = 18; y < 46; y++) {
            paint(image, x, y, [...foreground.map(channel => Math.round(channel * alpha + 255 * (1 - alpha))), 255]);
        }
        removeSpriteBackground(image);
        const edge = pixel(image, 15, 32);
        expect(edge[3]).toBeGreaterThanOrEqual(120);
        expect(edge[3]).toBeLessThanOrEqual(136);
        foreground.forEach((channel, i) => expect(Math.abs(edge[i] - channel)).toBeLessThanOrEqual(3));
        expect(pixel(image, 14, 32)[3]).toBeGreaterThan(0);
        expect(pixel(image, 14, 32)[3]).toBeLessThan(40);
        expect(pixel(image, 16, 32)).toEqual([...foreground, 255]);
        const before = image.data.slice();
        removeSpriteBackground(image);
        expect(image.data).toEqual(before);
    });

    test('tiny detached corner remnants do not pull the character away from the centre', () => {
        const image = bitmap([255, 255, 255, 255], 128);
        for (let y = 24; y < 104; y++) for (let x = 32; x < 96; x++) paint(image, x, y, [40, 70, 100, 255]);
        for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) paint(image, x, y, [160, 155, 150, 255]);
        // A small detail next to the character is retained, even though it is detached.
        paint(image, 98, 60, [40, 70, 100, 255]);
        removeSpriteBackground(image);
        expect(pixel(image, 3, 3)[3]).toBe(0);
        expect(pixel(image, 98, 60)[3]).toBe(255);
        expect(spriteForegroundBounds(image)).toEqual({ minX: 32, minY: 24, maxX: 98, maxY: 103 });
    });

    test('marks on all four corner pixels do not hide an otherwise plain background', () => {
        const image = bitmap([255, 255, 255, 255], 128);
        for (let y = 24; y < 104; y++) for (let x = 32; x < 96; x++) paint(image, x, y, [40, 70, 100, 255]);
        for (const [left, top] of [[0, 0], [125, 0], [0, 125], [125, 125]]) {
            for (let y = top; y < top + 3; y++) for (let x = left; x < left + 3; x++) paint(image, x, y, [160, 155, 150, 255]);
        }
        removeSpriteBackground(image);
        expect(pixel(image, 0, 64)[3]).toBe(0);
        for (const [x, y] of [[0, 0], [127, 0], [0, 127], [127, 127]]) expect(pixel(image, x, y)[3]).toBe(0);
        expect(pixel(image, 64, 64)).toEqual([40, 70, 100, 255]);
    });

    test('a colourful full-bleed boundary is left intact', () => {
        const image = bitmap([0, 0, 0, 255], 64);
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) paint(image, x, y, [x * 4, y * 4, (x + y) * 2, 255]);
        const before = image.data.slice();
        removeSpriteBackground(image);
        expect(image.data).toEqual(before);
    });

    test('already-transparent cutouts lose white contamination without losing their soft coverage', () => {
        const image = bitmap([0, 0, 0, 0], 64);
        const colours = [[65, 75, 85], [175, 130, 80]];
        for (let y = 12; y < 52; y++) for (let x = 16; x < 48; x++) paint(image, x, y, [...colours[y < 32 ? 0 : 1], 255]);
        for (let y = 16; y < 48; y++) {
            const colour = colours[y < 32 ? 0 : 1];
            paint(image, 15, y, [...colour.map(c => Math.round(c * 0.5 + 127.5)), 128]);
            paint(image, 48, y, [...colour, 128]); // Already clean antialiasing.
        }
        paint(image, 32, 32, [255, 255, 255, 255]); // Interior white costume detail.
        removeSpriteBackground(image);
        expect(pixel(image, 15, 24)).toEqual([...colours[0], 128]);
        expect(pixel(image, 15, 40)).toEqual([...colours[1], 128]);
        expect(pixel(image, 48, 24)).toEqual([...colours[0], 128]);
        expect(pixel(image, 32, 32)).toEqual([255, 255, 255, 255]);
        const once = image.data.slice();
        removeSpriteBackground(image);
        expect(image.data).toEqual(once);
    });

    test('opaque pale rims on transparent cutouts become soft edges, keeping the solid interior', () => {
        const image = bitmap([0, 0, 0, 0], 64);
        for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) paint(image, x, y, [70, 90, 110, 255]);
        for (let y = 20; y < 44; y++) paint(image, 15, y, [163, 173, 183, 255]);
        removeSpriteBackground(image);
        expect(pixel(image, 15, 32)[3]).toBeLessThan(140);
        expect(pixel(image, 15, 32).slice(0, 3)).toEqual([70, 90, 110]);
        expect(pixel(image, 17, 32)).toEqual([70, 90, 110, 255]);
    });

    test('soft outer pixels do not expose and erode a shaded solid outline on subsequent cleanup', () => {
        const image = bitmap([0, 0, 0, 0], 64);
        for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) paint(image, x, y, [70, 90, 110, 255]);
        for (let y = 20; y < 44; y++) {
            paint(image, 15, y, [163, 173, 183, 128]);
            paint(image, 16, y, [140, 150, 160, 255]);
            paint(image, 17, y, [120, 130, 140, 255]);
        }
        for (let pass = 0; pass < 3; pass++) {
            removeSpriteBackground(image);
            expect(pixel(image, 16, 32)).toEqual([140, 150, 160, 255]);
            expect(pixel(image, 17, 32)).toEqual([120, 130, 140, 255]);
        }
    });
});

describe('sprite sheet cropping', () => {
    test('equal grid cells retain artwork at their edges without zooming or blending it', () => {
        const image = bitmap([255, 255, 255, 0], 80, 40);
        for (let y = 0; y < 40; y++) for (let x = 0; x < 80; x++) paint(image, x, y, [x, y, x < 40 ? 50 : 150, 255]);
        const tiles = splitSpriteBitmap(image, { columns: 2, rows: 1 }, 2);
        expect(tiles.map(tile => [tile.width, tile.height])).toEqual([[40, 40], [40, 40]]);
        expect(pixel(tiles[0], 0, 0)).toEqual(pixel(image, 0, 0));
        expect(pixel(tiles[0], 39, 39)).toEqual(pixel(image, 39, 39));
        expect(pixel(tiles[1], 0, 0)).toEqual(pixel(image, 40, 0));
        expect(pixel(tiles[1], 39, 39)).toEqual(pixel(image, 79, 39));
    });

    test('odd-sized sheets account for every source pixel exactly once', () => {
        const image = bitmap([0, 0, 0, 255], 31, 17);
        for (let y = 0; y < 17; y++) for (let x = 0; x < 31; x++) paint(image, x, y, [x, y, 50, 255]);
        const tiles = splitSpriteBitmap(image, { columns: 3, rows: 2 }, 6);
        expect(tiles.map(tile => [tile.width, tile.height])).toEqual([[10, 9], [11, 9], [10, 9], [10, 8], [11, 8], [10, 8]]);
        expect(pixel(tiles[1], 0, 0)).toEqual(pixel(image, 10, 0));
        expect(pixel(tiles[4], 10, 7)).toEqual(pixel(image, 20, 16));
        expect(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0)).toBe(31 * 17);
    });
});
