import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStringHash } from '../public/scripts/macro-primitives.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vectorsIndexPath = path.join(repoRoot, 'public', 'scripts', 'extensions', 'vectors', 'index.js');
const vectorsSource = fs.readFileSync(vectorsIndexPath, 'utf8');

describe('vector string hash identity and non-retention', () => {
    test('removes the unbounded page-lifetime hashCache wrapper and uses getStringHash directly', () => {
        expect(vectorsSource).not.toContain('hashCache');
        expect(vectorsSource).not.toContain('calculateHash');
        expect(vectorsSource).not.toContain('function getStringHash');
        expect(vectorsSource).toContain('import { debounce, getStringHash, onlyUnique, isTrueBoolean } from \'../../utils.js\';');
        expect(vectorsSource).toContain('return `file_${getStringHash(fileUrl)}`;');
    });

    test('produces identical file collection IDs and lorebook content hashes for ASCII, Unicode and large strings', () => {
        const getFileCollectionIdMatch = vectorsSource.match(/function getFileCollectionId\(fileUrl\) \{\s*return `file_\$\{getStringHash\(fileUrl\)\}`;\s*\}/);
        expect(getFileCollectionIdMatch).not.toBeNull();
        const getFileCollectionId = new Function('getStringHash', `${getFileCollectionIdMatch[0]}\nreturn getFileCollectionId;`)(getStringHash);

        const samples = [
            '/api/files/notes.txt',
            '/user/files/Résumé - 2026 📚.md',
            'lore-entry:' + 'x'.repeat(25000),
            '',
        ];

        for (const sample of samples) {
            expect(getFileCollectionId(sample)).toBe(`file_${getStringHash(sample)}`);
            expect(typeof getStringHash(sample)).toBe('number');
            expect(Number.isSafeInteger(getStringHash(sample))).toBe(true);
        }
    });

    test('short-circuits lorebook projection matching by world and UID before hashing content', () => {
        expect(vectorsSource).toContain('item.world === entry.world\n            && String(item.uid) === String(entry.uid) && item.hash === getStringHash(entry.content)');

        const hashSpy = jest.fn(str => getStringHash(str));
        const matchEntries = new Function(
            'entries',
            'projectionWorldInfo',
            'getStringHash',
            'return entries.filter(entry => projectionWorldInfo.some(item => item.world === entry.world && String(item.uid) === String(entry.uid) && item.hash === getStringHash(entry.content)));',
        );

        const entries = [
            { world: 'WorldA', uid: 1, content: 'Unmatched world content ' + 'a'.repeat(5000) },
            { world: 'WorldB', uid: 99, content: 'Unmatched uid content ' + 'b'.repeat(5000) },
            { world: 'WorldB', uid: 2, content: 'Matched lore entry content 🌟' },
        ];
        const projectionWorldInfo = [
            { world: 'WorldB', uid: '2', hash: getStringHash('Matched lore entry content 🌟') },
        ];

        const matched = matchEntries(entries, projectionWorldInfo, hashSpy);
        expect(matched).toEqual([entries[2]]);
        // Only the entry whose world and UID matched is hashed.
        expect(hashSpy).toHaveBeenCalledTimes(1);
        expect(hashSpy).toHaveBeenCalledWith('Matched lore entry content 🌟');
    });
});
