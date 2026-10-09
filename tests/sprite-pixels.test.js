import { cleanSpriteBitmap, removeSpriteBackground } from '../public/scripts/extensions/expressions/sprite-pixels.js';

function bitmap(colour) {
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < data.length; i += 4) data.set(colour, i);
    return { width: 16, height: 16, data };
}

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
});
