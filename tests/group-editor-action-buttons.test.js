import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const groupChatsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'group-chats.js'), 'utf8').replace(/\r\n/g, '\n');

describe('group editor action buttons', () => {
    const selectGroupChats = groupChatsSource.slice(groupChatsSource.indexOf('function select_group_chats(groupId, skipAnimation)'));
    const body = selectGroupChats.slice(0, selectGroupChats.indexOf('\n}\n'));

    test('edit-only buttons are toggled by class, never by an inline display', () => {
        expect(body).toContain('$(\'#rm_group_submit\').toggleClass(\'displayNone\', Boolean(openGroupId));');
        expect(body).toContain('$(\'#rm_group_delete, #rm_group_scenario, #group_open_media_overrides\').css(\'display\', \'\').toggleClass(\'displayNone\', !openGroupId);');
        for (const id of ['rm_group_submit', 'rm_group_delete', 'rm_group_scenario', 'group_open_media_overrides']) {
            expect(body).not.toMatch(new RegExp(`\\$\\('#${id}'\\)\\.(show|hide)\\(`));
        }
    });
});
