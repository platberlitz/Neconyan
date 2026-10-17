import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testFile = fileURLToPath(import.meta.url);

if (process.argv[2] === '--probe') {
    const { getRawImage } = await import('../src/transformers.js');
    const image = await getRawImage(process.argv[3]);
    console.log(image ? `${image.width}x${image.height}` : 'null');
} else {
    const validImages = {
        jpeg: '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAFF/f//Z',
        png: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4w8AARAwQCgAfjgPxzzTeXgAAAABJRU5ErkJggg==',
        gif: 'R0lGODlhAgACAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEBAAfACwAAAAAAgACAAAIBgAPCDwQEAA7',
        bmp: 'Qk1GAAAAAAAAADYAAAAoAAAAAgAAAAIAAAABABgAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAD8AAD8AAAAAPwAAPwAAA==',
        tiff: 'SUkqAGEAAAD9UQFa8AgACAAIAEgAAAABAAAASAAAAAEAAABMYXZjNjAuMzEuMTAyAA8AAAABAAAA6wAAAAEAAACAAAAAAQAAAPAAAAABAAAAgAAAAAEAAADwAAAAAQAAABAA/gAEAAEAAAAAAAAAAAEEAAEAAAACAAAAAQEEAAEAAAACAAAAAgEDAAMAAAANAAAAAwEDAAEAAAAFgAAABgEDAAEAAAAGAAAAEQEEAAEAAAAIAAAAFQEDAAEAAAADAAAAFgEEAAEAAAAACAAAFwEEAAEAAAAFAAAAGgEFAAEAAAATAAAAGwEFAAEAAAAbAAAAKAEDAAEAAAACAAAAMQECAA4AAAAjAAAAEgIDAAIAAAACAAIAFAIFAAYAAAAxAAAAAAAAAA==',
    };

    const malformed = {
        asf: Buffer.concat([Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9]), Buffer.alloc(86)]),
        truncatedPng8: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        truncatedPng12: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4)]),
        truncatedPng15: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(7)]),
        truncatedTiff4: Buffer.from([0x49, 0x49, 0x2a, 0x00]),
        truncatedTiff12: Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(8)]),
        truncatedTiff23: Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(19)]),
        minimumPngJunk: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]),
        minimumTiffJunk: Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(20)]),
        truncatedTiffBigEndian: Buffer.from([0x4d, 0x4d, 0x00, 0x2a]),
        truncatedJpeg: Buffer.from([0xff, 0xd8, 0xff]),
        truncatedGif: Buffer.from('GIF8'),
        truncatedBmp: Buffer.from('BM'),
    };

    function probe(base64) {
        const result = spawnSync(process.execPath, [testFile, '--probe', base64], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.error, undefined, `probe failed: ${result.error?.message ?? result.stderr}`);
        assert.equal(result.signal, null, `probe was killed by ${result.signal}`);
        assert.equal(result.status, 0, `probe exited ${result.status}: ${result.stderr}`);
        return result.stdout.trim();
    }

    test('malformed ASF and truncated headers cannot terminate or hang the parser process', () => {
        for (const [name, bytes] of Object.entries(malformed)) {
            assert.equal(probe(bytes.toString('base64')), 'null', name);
        }
    });

    test('valid JPEG, PNG, GIF, BMP and TIFF still decode in the parser process', () => {
        for (const [name, base64] of Object.entries(validImages)) {
            assert.equal(probe(base64), '2x2', name);
        }
    });
}
