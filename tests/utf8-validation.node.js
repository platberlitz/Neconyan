/* eslint playwright/expect-expect: off -- Uses node:assert. */
// The streaming check must give a fatal TextDecoder's verdict for every byte stream, wherever it is cut into slices.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createUtf8Validator, invalidUtf8Error } from '../src/utf8-validation.js';

function decoderAccepts(bytes) {
    try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        return true;
    } catch {
        return false;
    }
}

function validatorAccepts(bytes, cuts) {
    const validator = createUtf8Validator();
    let from = 0;
    for (const cut of [...cuts, bytes.length]) {
        validator.update(bytes.subarray(from, cut));
        from = cut;
    }
    return validator.end();
}

// Every way of cutting the bytes once and twice, every single-byte slicing, and the whole stream at once.
function assertSameVerdictAtEveryCut(bytes, label) {
    const expected = decoderAccepts(bytes);
    const cuts = [[], Array.from({ length: bytes.length }, (_, index) => index)];
    for (let first = 0; first <= bytes.length; first++) {
        cuts.push([first]);
        for (let second = first; second <= bytes.length; second++) cuts.push([first, second]);
    }
    for (const at of cuts) assert.equal(validatorAccepts(bytes, at), expected, `${label}, cut at ${at.join(',') || 'nothing'}`);
    return expected;
}

const hex = text => Buffer.from(text.replace(/\s/g, ''), 'hex');

const valid = {
    empty: Buffer.alloc(0),
    ascii: Buffer.from('{"mes":"plain"}'),
    'two bytes': Buffer.from('caf\u00e9'),
    'three bytes': Buffer.from('\u65e5\u672c\u8a9e \u2014'),
    'four bytes': Buffer.from('\u{1F642}\u{10FFFF}'),
    'every width together': Buffer.from('a\u00e9\u20ac\u{1F642}z'),
    'byte order mark': Buffer.from('\uFEFF{"chat_metadata":{}}'),
    'byte order mark alone': hex('ef bb bf'),
    'last code point before the surrogates': hex('ed 9f bf'),
    'first code point after the surrogates': hex('ee 80 80'),
};

const invalid = {
    'stray continuation': hex('41 80 41'),
    'truncated two-byte at the end': hex('41 c3'),
    'truncated three-byte at the end': hex('41 e2 82'),
    'truncated four-byte at the end': hex('41 f0 9f 99'),
    'lead followed by ASCII': hex('e2 41 82'),
    'invalid continuation in a four-byte sequence': hex('f0 9f 41 82'),
    'overlong two-byte': hex('c0 af'),
    'overlong two-byte at the edge': hex('c1 bf'),
    'overlong three-byte': hex('e0 80 af'),
    'overlong four-byte': hex('f0 80 80 af'),
    'UTF-16 high surrogate': hex('ed a0 80'),
    'UTF-16 low surrogate': hex('ed bf bf'),
    'surrogate pair encoded as two sequences': hex('ed a0 bd ed b8 82'),
    'above U+10FFFF': hex('f4 90 80 80'),
    'five-byte lead': hex('f8 88 80 80 80'),
    'lead F5': hex('f5 80 80 80'),
    'byte FF': hex('41 ff 41'),
    'byte FE': hex('fe'),
    'valid text then a truncated character': Buffer.concat([Buffer.from('\u{1F642} caf\u00e9 '), hex('e2 82')]),
};

test('the streaming UTF-8 check accepts valid text wherever it is cut', () => {
    for (const [label, bytes] of Object.entries(valid)) assert.equal(assertSameVerdictAtEveryCut(bytes, label), true, label);
});

test('the streaming UTF-8 check refuses invalid text wherever it is cut', () => {
    for (const [label, bytes] of Object.entries(invalid)) assert.equal(assertSameVerdictAtEveryCut(bytes, label), false, label);
});

test('the streaming UTF-8 check agrees with the decoder on every 1 to 4 byte sequence split at every offset', () => {
    // Every lead and continuation class, framed by ASCII so a cut can fall on every side of the sequence.
    const bytes = [0x00, 0x41, 0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xe1, 0xec, 0xed, 0xee, 0xef,
        0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xf7, 0xf8, 0xfb, 0xfc, 0xfd, 0xfe, 0xff];
    const continuations = [0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0x41];
    let accepted = 0;
    let refused = 0;
    for (const lead of bytes) {
        for (const second of continuations) {
            for (const third of continuations) {
                for (const fourth of continuations) {
                    for (const length of [1, 2, 3, 4]) {
                        const sequence = Buffer.from([0x61, lead, second, third, fourth].slice(0, length + 1).concat([0x7a]));
                        if (assertSameVerdictAtEveryCut(sequence, [...sequence].map(byte => byte.toString(16)).join(' '))) accepted++;
                        else refused++;
                    }
                }
            }
        }
    }
    assert.ok(accepted > 1000 && refused > 1000, `${accepted} accepted, ${refused} refused`);
});

test('the streaming UTF-8 check agrees with the decoder over long text cut into 64 KiB reads', () => {
    const text = Buffer.from('{"mes":"' + 'caf\u00e9 \u65e5\u672c \u{1F642} \u2014 '.repeat(20000) + '"}');
    for (const shift of [0, 1, 2, 3]) {
        const shifted = Buffer.concat([Buffer.from('a'.repeat(shift)), text]);
        const slices = Array.from({ length: Math.ceil(shifted.length / 65536) - 1 }, (_, index) => (index + 1) * 65536);
        assert.equal(validatorAccepts(shifted, slices), true, `shift ${shift}`);
        const broken = Buffer.from(shifted);
        broken[65536 + 1] = 0xff;
        assert.equal(validatorAccepts(broken, slices), decoderAccepts(broken), `shift ${shift}, broken after a slice boundary`);
        assert.equal(validatorAccepts(shifted.subarray(0, 65537), [65536]), decoderAccepts(shifted.subarray(0, 65537)), `shift ${shift}, cut short`);
    }
});

test('the streaming UTF-8 check keeps its verdict and never holds on to a reused slice', () => {
    const validator = createUtf8Validator();
    const slice = Buffer.from([0x61, 0xe2]);
    assert.equal(validator.update(slice), true);
    slice.set([0x82, 0xac]);
    assert.equal(validator.update(slice), true, 'the carried lead byte was copied before the slice was reused');
    assert.equal(validator.end(), true);
    const refused = createUtf8Validator();
    assert.equal(refused.update(Buffer.from([0xff])), false);
    assert.equal(refused.update(Buffer.from('fine')), false, 'an invalid stream stays invalid');
    assert.equal(refused.end(), false);
});

test('the refusal is the fatal decoder\'s own error', () => {
    let decoderError;
    try { new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.of(0xc3)); } catch (error) { decoderError = error; }
    const error = invalidUtf8Error();
    assert.ok(error instanceof TypeError);
    assert.equal(error.code, 'ERR_ENCODING_INVALID_ENCODED_DATA');
    assert.equal(error.code, decoderError.code);
    assert.equal(error.message, decoderError.message);
});
