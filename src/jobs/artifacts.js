import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { getJob, jobKey, markProviderSettled, markProviderUncertain, setJobResume } from './store.js';

const MAX_BYTES = 16 * 1024 * 1024;

function artifactPath(directories, id, name) {
    if (!getJob(directories, id)) throw Object.assign(new Error('No such job.'), { status: 404 });
    return path.join(directories.root, 'jobs', 'artifacts', jobKey(id), jobKey(name) + '.json');
}

export function readArtifact(directories, id, name) {
    const filename = artifactPath(directories, id, name);
    try {
        if (fs.statSync(filename).size > MAX_BYTES) throw new Error('Artifact exceeds its size limit.');
        return JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw Object.assign(new Error('The saved job result needs recovery and was left untouched.'), { status: 409 });
    }
}

export function writeArtifact(directories, id, name, value) {
    const filename = artifactPath(directories, id, name);
    const data = JSON.stringify(value);
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_BYTES) {
        throw Object.assign(new Error('The job result exceeds its saved artifact limit.'), { status: 413 });
    }
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    writeFileAtomicSync(filename, data, { mode: 0o600 });
    return value;
}

/** Persist provider results separately from status; an uncertain call is never replayed on restart. */
export async function providerStep({ directories, job, signal }, name, call) {
    signal.throwIfAborted();
    const key = 'provider:' + name;
    const saved = readArtifact(directories, job.id, key);
    if (saved !== undefined) return saved;
    setJobResume(directories, job.id, key);
    markProviderUncertain(directories, job.id, { step: key });
    const result = await call();
    writeArtifact(directories, job.id, key, result);
    markProviderSettled(directories, job.id);
    signal.throwIfAborted();
    return result;
}
