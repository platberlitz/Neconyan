import { describe, expect, test } from '@jest/globals';
import path from 'node:path';

import { selectRecentChatFiles } from '../src/chat-library-inventory.js';

const fixtureRoot = path.join(path.sep, 'fixture');

/**
 * @param {string} fileName
 * @param {{avatar?: string, group?: string, mtime?: number}} [options]
 */
function chatFile(fileName, { avatar, group, mtime = 0 } = {}) {
    const directory = group
        ? path.join('group chats', group)
        : avatar
            ? path.join('chats', avatar.replace('.png', ''))
            : 'chats';
    return {
        filePath: path.join(fixtureRoot, directory, fileName),
        pngFile: avatar,
        groupId: group,
        mtime,
    };
}

function names(files) {
    return files.map(file => path.basename(file.filePath));
}

describe('selectRecentChatFiles pinned membership', () => {
    test('pin-name reads stay bounded as the library grows', () => {
        let reads = 0;
        const pinnedChats = [3, 15, 27].map(index => ({
            get file_name() {
                reads++;
                return `chat-${index}.jsonl`;
            },
            avatar: 'Nova.png',
        }));
        for (const size of [100, 1000]) {
            reads = 0;
            const files = Array.from({ length: size }, (_, index) => chatFile(`chat-${index}.jsonl`, {
                avatar: 'Nova.png', mtime: (index * 31) % size,
            }));
            const selected = selectRecentChatFiles(files, { max: 15, pinnedChats });
            expect(new Set(names(selected.slice(0, 3)))).toEqual(new Set(['chat-3.jsonl', 'chat-15.jsonl', 'chat-27.jsonl']));
            expect(reads).toBeLessThanOrEqual(pinnedChats.length * 2);
        }
    });

    test('sorts newest first without pins and leaves the input order alone', () => {
        const files = [
            chatFile('old.jsonl', { mtime: 1 }),
            chatFile('new.jsonl', { mtime: 3 }),
            chatFile('middle.jsonl', { mtime: 2 }),
        ];

        const selected = selectRecentChatFiles(files, { max: 10, pinnedChats: [] });

        expect(names(selected)).toEqual(['new.jsonl', 'middle.jsonl', 'old.jsonl']);
        expect(names(files)).toEqual(['old.jsonl', 'new.jsonl', 'middle.jsonl']);
        expect(selected).not.toBe(files);
    });

    test('keeps the original missing-group matches for an avatar-only pin', () => {
        const files = [
            chatFile('A.jsonl', { avatar: 'Nova.png', mtime: 1 }),
            chatFile('A.jsonl', { avatar: 'Kit.png', mtime: 2 }),
            chatFile('A.jsonl', { mtime: 3 }),
            chatFile('A.jsonl', { group: 'g1', mtime: 4 }),
        ];

        const selected = selectRecentChatFiles(files, {
            max: 10,
            pinnedChats: [{ file_name: 'A.jsonl', avatar: 'Nova.png' }],
        });

        // Nova matches by avatar. Kit and the root chat also match because the
        // pin has no group and both chats have no groupId. The group chat does
        // not match, so it follows every pinned row.
        expect(names(selected)).toEqual(['A.jsonl', 'A.jsonl', 'A.jsonl', 'A.jsonl']);
        expect(selected.map(file => file.groupId)).toEqual([undefined, undefined, undefined, 'g1']);
        expect(selected.map(file => file.mtime)).toEqual([3, 2, 1, 4]);
    });

    test('matches duplicate basenames for a file-name-only pin', () => {
        const files = [
            chatFile('Same.jsonl', { avatar: 'Nova.png', mtime: 1 }),
            chatFile('Same.jsonl', { avatar: 'Kit.png', mtime: 2 }),
            chatFile('Same.jsonl', { mtime: 3 }),
            chatFile('Same.jsonl', { group: 'g1', mtime: 4 }),
            chatFile('Same.jsonl', { group: 'g2', mtime: 5 }),
        ];

        const selected = selectRecentChatFiles(files, {
            max: 10,
            pinnedChats: [{ file_name: 'Same.jsonl' }],
        });

        // A pin with neither avatar nor group matches every chat with that
        // basename, including group chats through the undefined avatar side.
        expect(selected.map(file => file.mtime)).toEqual([5, 4, 3, 2, 1]);
    });

    test('keeps the original missing-avatar matches for a group-only pin', () => {
        const files = [
            chatFile('G.jsonl', { group: 'g1', mtime: 1 }),
            chatFile('G.jsonl', { group: 'g2', mtime: 2 }),
            chatFile('G.jsonl', { mtime: 3 }),
            chatFile('G.jsonl', { avatar: 'Nova.png', mtime: 4 }),
        ];

        const selected = selectRecentChatFiles(files, {
            max: 10,
            pinnedChats: [{ file_name: 'G.jsonl', group: 'g1' }],
        });

        // g1 matches by group. g2 and the root chat match through the missing
        // avatar on the pin. The individual chat matches neither side.
        expect(selected.map(file => file.mtime)).toEqual([3, 2, 1, 4]);
        expect(selected[3].pngFile).toBe('Nova.png');
    });

    test('keeps avatar-and-group pins strict when both fields are present', () => {
        const files = [
            chatFile('D.jsonl', { avatar: 'Nova.png', mtime: 1 }),
            chatFile('D.jsonl', { avatar: 'Kit.png', mtime: 2 }),
            chatFile('D.jsonl', { group: 'g1', mtime: 3 }),
            chatFile('D.jsonl', { group: 'g2', mtime: 4 }),
            chatFile('D.jsonl', { mtime: 5 }),
        ];

        const selected = selectRecentChatFiles(files, {
            max: 10,
            pinnedChats: [{ file_name: 'D.jsonl', avatar: 'Nova.png', group: 'g1' }],
        });

        expect(selected.map(file => file.mtime)).toEqual([3, 1, 5, 4, 2]);
        expect(selected[0].groupId).toBe('g1');
        expect(selected[1].pngFile).toBe('Nova.png');
    });

    test('keeps stable order for equal mtimes and the balanced category depth', () => {
        const files = [
            chatFile('Group A.jsonl', { group: 'g1', mtime: 5 }),
            chatFile('Group B.jsonl', { group: 'g1', mtime: 5 }),
            chatFile('Nova.jsonl', { avatar: 'Nova.png', mtime: 5 }),
            chatFile('Kit.jsonl', { avatar: 'Kit.png', mtime: 5 }),
        ];

        const selected = selectRecentChatFiles(files, { max: 1, pinnedChats: [] });

        // max 1 keeps one group and one individual. Equal mtimes retain their
        // input order, so the first group and the first individual win.
        expect(names(selected)).toEqual(['Group A.jsonl', 'Nova.jsonl']);
    });

    test('counts a pinned individual toward the individual depth', () => {
        const files = [
            chatFile('Group A.jsonl', { group: 'g1', mtime: 5 }),
            chatFile('Nova.jsonl', { avatar: 'Nova.png', mtime: 4 }),
            chatFile('Kit.jsonl', { avatar: 'Kit.png', mtime: 3 }),
        ];

        const selected = selectRecentChatFiles(files, {
            max: 1,
            pinnedChats: [{ file_name: 'Kit.jsonl', avatar: 'Kit.png' }],
        });

        // The pinned individual is inserted by the initial slice and counted
        // by the balance loop, so the one remaining slot goes to the group.
        expect(names(selected)).toEqual(['Kit.jsonl', 'Group A.jsonl']);
    });
});
