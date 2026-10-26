import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import wabtFactory from 'wabt';

const sourceHash = 'ce53abdd232f9d0d6401703aea3c2e43ffa94d4e5962324fb14fedd678ae0a9a';

/**
 * Lower atomics in this specific, private-memory SentencePiece binary. No other
 * thread can access its memory, so these operations have ordinary load/store
 * semantics. Never apply this to an imported or shared memory, or other binaries.
 * @param {Uint8Array} bytes Original @agnai/sentencepiece-js 1.1.1 WASM
 * @returns {Promise<Uint8Array>} Equivalent single-threaded WASM
 */
export async function lowerPrivateSentencePiece(bytes) {
    if (createHash('sha256').update(bytes).digest('hex') !== sourceHash) throw new Error('Unexpected SentencePiece binary; re-audit before updating the iOS build.');
    const wabt = await wabtFactory();
    const original = wabt.readWasm(bytes, { threads: true });
    let wat = original.toText({ foldExprs: false, inlineExport: false });
    original.destroy();
    if (/\(import [^\n]*\(memory/.test(wat) || (wat.match(/^  \(memory /gm) ?? []).length !== 1 || !/^  \(memory \(;0;\) 256 32768\)$/m.test(wat)) throw new Error('SentencePiece memory is not exclusively private.');
    wat = wat.replace(/\b(i32|i64)\.atomic\.(load(?:8_u|32_u)?|store8?)\b/g, '$1.$2');
    const helpers = new Map();
    wat = wat.replace(/i32\.atomic\.rmw\.(add|cmpxchg)(?: offset=(\d+))?/g, (_, op, offset = '0') => {
        const name = `$private_${op}_${offset}`;
        helpers.set(name, `(func ${name} (param $address i32) (param $value i32) ${op === 'cmpxchg' ? '(param $replacement i32)' : ''} (result i32) (local $old i32)
            local.get $address i32.load offset=${offset} local.set $old
            ${op === 'add' ? `local.get $address local.get $old local.get $value i32.add i32.store offset=${offset}` : `local.get $old local.get $value i32.eq if local.get $address local.get $replacement i32.store offset=${offset} end`}
            local.get $old)`);
        return `call ${name}`;
    });
    if (wat.includes('atomic') || helpers.size !== 3) throw new Error('Unhandled SentencePiece atomic operation.');
    // Appending helpers preserves every existing numerical function index.
    wat = wat.trim().slice(0, -1) + '\n' + [...helpers.values()].join('\n') + '\n)';
    const lowered = wabt.parseWat('sentencepiece-private.wat', wat);
    try {
        lowered.validate();
        return lowered.toBinary({}).buffer;
    } finally { lowered.destroy(); }
}

/** @param {string} payload Path to the disposable iOS server payload */
export async function prepareSentencePiece(payload) {
    const filename = path.join(payload, 'node_modules/@agnai/sentencepiece-js/dist/index.js');
    const source = fs.readFileSync(filename, 'utf8');
    const matches = [...source.matchAll(/data:application\/[^,"']+;base64,([A-Za-z0-9+/=]+)/g)];
    if (matches.length !== 1) throw new Error('Expected exactly one embedded SentencePiece binary.');
    const original = matches[0][1];
    const lowered = await lowerPrivateSentencePiece(Buffer.from(original, 'base64'));
    // Only the generated payload changes; the dependency in other builds stays intact.
    fs.writeFileSync(filename, source.replace(original, Buffer.from(lowered).toString('base64')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv[2]) throw new Error('Pass the generated iOS payload directory.');
    await prepareSentencePiece(path.resolve(process.argv[2]));
}
