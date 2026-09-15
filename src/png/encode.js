const CRC32_MASK = 0xFFFFFFFFn;
const CRC32_POLYNOMIAL = 0xEDB88320n;
const CRC32_TABLE = (() => {
    const table = new Array(256);

    for (let i = 0; i < 256; i++) {
        let crc = BigInt(i);

        for (let bit = 0; bit < 8; bit++) {
            crc = (crc & 1n) === 1n
                ? ((crc >> 1n) ^ CRC32_POLYNOMIAL)
                : (crc >> 1n);
        }

        table[i] = crc & CRC32_MASK;
    }

    return table;
})();

function writeUint32(output, idx, value) {
    const uint32 = BigInt(value) & CRC32_MASK;

    output[idx++] = Number((uint32 >> 24n) & 0xFFn);
    output[idx++] = Number((uint32 >> 16n) & 0xFFn);
    output[idx++] = Number((uint32 >> 8n) & 0xFFn);
    output[idx++] = Number(uint32 & 0xFFn);

    return idx;
}

function getChunkCrc(nameChars, data) {
    let crc = CRC32_MASK;

    for (const byte of nameChars) {
        crc = CRC32_TABLE[Number((crc ^ BigInt(byte)) & 0xFFn)] ^ (crc >> 8n);
    }

    for (let i = 0; i < data.length; i++) {
        const byte = data[i];
        crc = CRC32_TABLE[Number((crc ^ BigInt(byte)) & 0xFFn)] ^ (crc >> 8n);
    }

    return (crc ^ CRC32_MASK) & CRC32_MASK;
}

/**
 * Encodes PNG chunks into a PNG file format buffer.
 * @param {Array<{ name: string; data: Uint8Array }>} chunks Array of PNG chunks
 * @returns {Uint8Array} Encoded PNG data
 * @copyright Based on https://github.com/hughsk/png-chunks-encode (MIT)
 */
export default function encode(chunks) {
    let totalSize = 8;
    let idx = totalSize;

    for (let i = 0; i < chunks.length; i++) {
        totalSize += chunks[i].data.length;
        totalSize += 12;
    }

    const output = new Uint8Array(totalSize);

    output[0] = 0x89;
    output[1] = 0x50;
    output[2] = 0x4E;
    output[3] = 0x47;
    output[4] = 0x0D;
    output[5] = 0x0A;
    output[6] = 0x1A;
    output[7] = 0x0A;

    for (let i = 0; i < chunks.length; i++) {
        const { name, data } = chunks[i];
        const size = data.length;
        const nameChars = [
            name.charCodeAt(0),
            name.charCodeAt(1),
            name.charCodeAt(2),
            name.charCodeAt(3),
        ];

        idx = writeUint32(output, idx, size);

        output[idx++] = nameChars[0];
        output[idx++] = nameChars[1];
        output[idx++] = nameChars[2];
        output[idx++] = nameChars[3];

        for (let j = 0; j < size;) {
            output[idx++] = data[j++];
        }

        idx = writeUint32(output, idx, getChunkCrc(nameChars, data));
    }

    return output;
}
