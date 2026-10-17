/**
 * Bounded still-image conversion. This worker is terminated by the caller after 15 seconds.
 * It has no translation, so a failure is posted as an error code and the page that started it picks the sentence
 * (workerErrorMessages in prompt-media-labels.js). A failure the worker did not expect is posted as 'failed', including a browser
 * error: a DOMException has a numeric code (0 for an EncodingError), and only a string code is one of ours.
 */
const fail = code => { throw Object.assign(new Error(code), { code }); };
self.onmessage = async ({ data: { bytes } }) => {
    try {
        const data = new Uint8Array(bytes), view = new DataView(bytes);
        if (!data.length || data.length > 16 * 1024 * 1024) fail('too-large');
        const ascii = (offset, length) => String.fromCharCode(...data.slice(offset, offset + length));
        let width, height, mime;
        if (ascii(1, 3) === 'PNG' && data.length >= 33) {
            mime = 'image/png'; width = view.getUint32(16); height = view.getUint32(20);
            let offset = 8, ended = false;
            while (offset + 12 <= data.length) {
                const length = view.getUint32(offset), type = ascii(offset + 4, 4);
                if (type === 'acTL') fail('animated');
                if (offset + length + 12 > data.length) fail('png-incomplete');
                offset += 12 + length;
                if (type === 'IEND') { ended = offset === data.length; break; }
            }
            if (!ended) fail('png-incomplete');
        } else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && data.length >= 30) {
            mime = 'image/webp';
            if (view.getUint32(4, true) + 8 !== data.length) fail('webp-incomplete');
            let offset = 12;
            while (offset + 8 <= data.length) {
                const type = ascii(offset, 4), size = view.getUint32(offset + 4, true), body = offset + 8;
                if (['ANIM', 'ANMF'].includes(type)) fail('animated');
                if (body + size > data.length) fail('webp-incomplete');
                if (type === 'VP8X' && size >= 10) {
                    if (data[body] & 2) fail('animated');
                    width = 1 + data[body + 4] + (data[body + 5] << 8) + (data[body + 6] << 16);
                    height = 1 + data[body + 7] + (data[body + 8] << 8) + (data[body + 9] << 16);
                } else if (!width && type === 'VP8 ' && size >= 10 && ascii(body + 3, 3) === String.fromCharCode(157, 1, 42)) {
                    width = view.getUint16(body + 6, true) & 16383; height = view.getUint16(body + 8, true) & 16383;
                } else if (!width && type === 'VP8L' && size >= 5 && data[body] === 47) {
                    const bits = view.getUint32(body + 1, true); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1;
                }
                offset = body + size + size % 2;
            }
            if (offset !== data.length) fail('webp-incomplete');
        } else if (data[0] === 255 && data[1] === 216 && data[data.length - 2] === 255 && data[data.length - 1] === 217) {
            mime = 'image/jpeg'; let offset = 2;
            while (offset + 4 < data.length) {
                if (data[offset++] !== 255) fail('jpeg-damaged');
                while (data[offset] === 255) offset++;
                const marker = data[offset++];
                if (marker === 218 || marker === 217) break;
                const length = view.getUint16(offset);
                if (length < 2 || offset + length > data.length) fail('jpeg-incomplete');
                if ([192, 193, 194].includes(marker)) { height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break; }
                offset += length;
            }
        }
        if (!mime || !width || !height || width * height > 16000000) fail('unsupported');
        const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
        try {
            if (bitmap.width * bitmap.height > 16000000) fail('too-many-pixels');
            const scale = Math.min(1, 2048 / bitmap.width, 2048 / bitmap.height);
            const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
            canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            let output = await canvas.convertToBlob({ type: mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', quality: 0.9 });
            for (const quality of [0.9, 0.7, 0.5, 0.3]) {
                if (output.size <= 1024 * 1024) break;
                output = await canvas.convertToBlob({ type: 'image/webp', quality });
            }
            if (output.size > 1024 * 1024) fail('still-too-large');
            const decoded = await createImageBitmap(output);
            try { if (decoded.width > 2048 || decoded.height > 2048) fail('result-too-large'); } finally { decoded.close(); }
            self.postMessage({ blob: output, width: canvas.width, height: canvas.height, originalWidth: width, originalHeight: height });
        } finally { bitmap.close(); }
    } catch (error) { self.postMessage({ errorCode: typeof error?.code === 'string' ? error.code : 'failed' }); }
};
