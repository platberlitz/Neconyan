export const RECEIPT_LIMIT = 1024 * 1024;
export const RECEIPTS_LIMIT = 16 * 1024 * 1024;
const fail = message => { throw Object.assign(new Error(message), { status: 413 }); };

/** Open operations reserve their maximum receipt size; no evidence is evicted. */
export function checkMeowerReceipts(receipts, reserve = 0) {
    if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)) fail('The saved Meower job receipts need recovery.');
    let bytes = reserve;
    let actual = 2;
    for (const [key, receipt] of Object.entries(receipts)) {
        if (!/^[a-f0-9]{64}$/.test(key) || receipt?.version !== 1 || typeof receipt.jobId !== 'string'
            || !receipt.units || typeof receipt.units !== 'object' || Array.isArray(receipt.units)
            || typeof receipt.closed !== 'boolean') fail('The saved Meower job receipts need recovery.');
        const size = Buffer.byteLength(JSON.stringify(receipt)) + key.length + 8;
        if (size > RECEIPT_LIMIT) fail('This Meower job has reached its permanent receipt limit.');
        actual += size;
        bytes += receipt.closed ? size : RECEIPT_LIMIT;
    }
    if (bytes > RECEIPTS_LIMIT) fail('Meower has no room for another permanent job receipt. Existing records were kept.');
    return { reserved: bytes, unused: Math.max(0, bytes - actual) };
}
