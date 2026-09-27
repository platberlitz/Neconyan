import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inspectRoleplayFile, readRoleplayFile, roleplayHash, roleplayLease, roleplayStoreDirectory } from '../roleplay-store.js';
import { loadResetContent } from '../account-reset-content.js';
import { prepareBinaryOutput, openBinaryOutput, publishBinaryOutput, openOperationBinary, BINARY_FILE_LIMIT } from './binary-files.js';
import { openCapturedZipEntry } from './account-import-sources.js';
import { operationError, withOperation } from './store.js';

/** Materialise every selected source before replacing any current account file. */
export async function captureImportInput(context, plan, file, index) {
    const name = `import:${index}`;
    const prepared = prepareBinaryOutput(context, name, Math.max(1, file.size));
    if (prepared.effect.publication || prepared.effect.state === 'done') return publishBinaryOutput(context, prepared, null);
    context.signal.throwIfAborted();
    let input;
    if (file.defaultIndex !== undefined) {
        const bytes = withOperation(context, ({ lease }) => {
            const content = loadResetContent(roleplayStoreDirectory(roleplayLease(lease).scope), plan.defaults, { readFile: readRoleplayFile, error: operationError });
            const saved = content.files[file.defaultIndex];
            if (!saved || saved.relative !== file.relative) throw operationError('The captured import defaults changed.');
            return Buffer.from(saved.data, 'base64');
        });
        input = Readable.from(bytes);
    } else if (file.bytes !== undefined) {
        input = Readable.from(Buffer.from(file.bytes, 'base64'));
    } else if (file.zip) {
        withOperation(context, () => {});
        input = await openCapturedZipEntry(plan.archive, file.zip);
    } else {
        input = withOperation(context, () => {
            const source = inspectRoleplayFile(file.filename, BINARY_FILE_LIMIT);
            if (!source || source.size !== file.size || roleplayHash({ rawHash: source.rawHash, physical: source.physical }) !== roleplayHash(file.evidence)) {
                throw operationError('An import source changed after acceptance. The current account files were kept.');
            }
            const fd = fs.openSync(file.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const stat = fs.fstatSync(fd, { bigint: true });
            const physical = { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
            if (roleplayHash(physical) !== roleplayHash(source.physical)) { fs.closeSync(fd); throw operationError('An import source changed before copying.'); }
            return fs.createReadStream(file.filename, { fd, autoClose: true });
        });
    }
    let output;
    let size = 0;
    const hash = createHash('sha256');
    try {
        output = fs.createWriteStream(prepared.filename, { fd: openBinaryOutput(context, prepared), autoClose: true });
        const check = new Transform({ transform(chunk, _encoding, callback) {
            size += chunk.length;
            if (size > file.size) return callback(operationError('An import source exceeded its accepted size.'));
            hash.update(chunk); callback(null, chunk);
        } });
        await pipeline(input, check, output, { signal: context.signal });
        const rawHash = hash.digest('hex');
        if (size !== file.size || (file.evidence && rawHash !== file.evidence.rawHash)) throw operationError('An import source changed while being copied.');
        return publishBinaryOutput(context, prepared, { name, relative: file.relative, rawHash });
    } catch (error) {
        input.destroy(); output?.destroy(); throw error;
    }
}

export function readImportInput(context, index, limit = 32 * 1024 * 1024) {
    const source = openOperationBinary(context, `import:${index}`);
    try {
        if (source.size > limit) throw operationError('This structured import file exceeds its format capacity.', 413);
        const bytes = fs.readFileSync(source.fd);
        if (bytes.length !== source.size || createHash('sha256').update(bytes).digest('hex') !== source.rawHash) throw operationError('The captured import file changed while being read.');
        return bytes;
    } finally { fs.closeSync(source.fd); }
}
