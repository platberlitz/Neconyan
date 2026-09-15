import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from '@jest/globals';

describe('readable export owner identity', () => {
    test('separates characters and groups even when IDs and chat filenames match', () => {
        const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
        const context = vm.createContext({
            selected_group: null,
            this_chid: 0,
            characters: [{ avatar: 'shared', chat: 'same-name' }, { avatar: 'other', chat: 'same-name' }],
        });
        vm.runInContext(source.match(/^function getChatExportOwnerKey\(\) {[\s\S]*?^}/m)[0], context);
        const first = context.getChatExportOwnerKey();
        context.this_chid = 1;
        expect(context.getChatExportOwnerKey()).not.toBe(first);
        context.selected_group = 'shared';
        expect(context.getChatExportOwnerKey()).not.toBe(first);
    });
});
