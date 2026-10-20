import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, jest, test } from '@jest/globals';
import { isImageInputIssue, promptMediaError } from '../public/scripts/prompt-media-policy.js';

// M10, Component B: the Prompt Manager's background dry run builds the same prompt as a real reply. An image refusal there must not
// reject, because nothing catches it; any other error still must. The adapter is cut out of openai.js as it stands and run against
// stand-ins, so the real isImageInputIssue decides which failures are quiet.
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const nodesOf = (node, found = []) => {
    if (typeof node?.type === 'string') found.push(node);
    for (const value of Object.values(node ?? {})) {
        if (Array.isArray(value)) value.forEach(item => nodesOf(item, found));
        else if (value && typeof value === 'object') nodesOf(value, found);
    }
    return found;
};
const source = read('public/scripts/openai.js');
const matches = nodesOf(parse(source, { ecmaVersion: 'latest', sourceType: 'module' })).filter(node => node.type === 'AssignmentExpression'
    && node.left?.type === 'MemberExpression' && node.left.object?.name === 'promptManager' && node.left.property?.name === 'tryGenerate');
if (matches.length !== 1) throw new Error(`Expected exactly one promptManager.tryGenerate assignment, found ${matches.length}`);
const tryGenerateSource = source.slice(matches[0].right.start, matches[0].right.end);
const tryGenerate = ({ characters, this_chid, Generate }) => vm.runInNewContext(`(${tryGenerateSource})`, {
    characters, this_chid, Generate, isImageInputIssue,
});
const serverRefusal = () => Object.assign(new Error('Words.'), { status: 409, body: { error: 'Words.', code: 'ROLEPLAY_INVALID',
    imageIssue: { reason: 'unsupported-image', index: 0, mediaIndex: 0, actions: [] } } });

describe('@m10 prompt manager dry-run refusal', () => {
    test('@m10 AC 5 a client refusal and a server-shaped refusal end the dry run quietly', async () => {
        const client = promptMediaError('too-many-images', 1, -1, 'Too many images.');
        await expect(tryGenerate({ characters: [{ avatar: 'nova.png' }], this_chid: 0,
            Generate: jest.fn(async () => { throw client; }) })()).resolves.toBeUndefined();
        await expect(tryGenerate({ characters: [{ avatar: 'nova.png' }], this_chid: 0,
            Generate: jest.fn(async () => { throw serverRefusal(); }) })()).resolves.toBeUndefined();
    });

    test('@m10 AC 5 any other error still rejects, and the dry run is called with its own arguments', async () => {
        const failure = new Error('Provider down.');
        const Generate = jest.fn(async () => { throw failure; });
        await expect(tryGenerate({ characters: [{ avatar: 'nova.png' }], this_chid: 0, Generate })()).rejects.toBe(failure);
        expect(Generate).toHaveBeenCalledWith('normal', {}, true);
    });

    test('@m10 AC 5 with no character the dry run resolves without calling Generate', async () => {
        const Generate = jest.fn(async () => 'called');
        await expect(tryGenerate({ characters: [], this_chid: 0, Generate })()).resolves.toBeUndefined();
        expect(Generate).not.toHaveBeenCalled();
    });
});
