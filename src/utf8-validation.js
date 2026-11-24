import { isUtf8 } from 'node:buffer';

const EMPTY = Buffer.alloc(0);

/** The refusal a fatal TextDecoder gives, so a check that never decodes still fails in its words. */
export function invalidUtf8Error() {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.of(0xff));
    } catch (error) {
        return error;
    }
    throw new Error('The UTF-8 decoder accepted an invalid byte.');
}

// The length a lead byte announces. A byte that can never begin a character counts as one byte, so it is judged at once.
const sequenceLength = lead => (lead >= 0xf5 || lead === 0xc0 || lead === 0xc1 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1);

/** How many bytes at the end of `bytes` start a character that continues after them (0 to 3). */
function unfinishedTail(bytes) {
    for (let back = 1; back <= Math.min(3, bytes.length); back++) {
        const byte = bytes[bytes.length - back];
        if ((byte & 0xc0) !== 0x80) return sequenceLength(byte) > back ? back : 0;
    }
    return 0;
}

/**
 * Judges a byte stream as a fatal TextDecoder judges it, one slice at a time and without decoding it. A character
 * split between slices is carried into the next one, so the verdict never depends on where the slices fall.
 * `update` returns false once the stream is known to be invalid; a character still open at the end of a slice is
 * judged when it is complete. `end` gives the verdict, refusing a stream that stops inside a character. Slices are
 * read at once and never kept, so a caller may reuse its buffer.
 */
export function createUtf8Validator() {
    let carry = EMPTY;
    let valid = true;
    return {
        update(slice) {
            if (!valid) return false;
            let body = slice;
            if (carry.length) {
                const missing = sequenceLength(carry[0]) - carry.length;
                if (body.length < missing) {
                    carry = Buffer.concat([carry, body]);
                    return true;
                }
                valid = isUtf8(Buffer.concat([carry, body.subarray(0, missing)]));
                carry = EMPTY;
                if (!valid) return false;
                body = body.subarray(missing);
            }
            const tail = unfinishedTail(body);
            valid = isUtf8(body.subarray(0, body.length - tail));
            if (valid && tail) carry = Buffer.from(body.subarray(body.length - tail));
            return valid;
        },
        end() {
            return valid && carry.length === 0;
        },
    };
}
