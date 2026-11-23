import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function read(...parts) {
    return fs.readFileSync(path.join(root, ...parts), 'utf8');
}

describe('viewport-sized thumbnails', () => {
    test('lists and previews use the viewport thumbnail helper', () => {
        expect(read('scripts', 'extensions', 'neconyan-chats-archive', 'src', 'ui.js'))
            .toContain('ctx.getThumbnailUrlForViewport(\'avatar\'');
        expect(read('scripts', 'scratchpad', 'assistants.js'))
            .toContain('getThumbnailUrlForViewport(\'avatar\', card.avatar)');
        expect(read('scripts', 'authors-note.js'))
            .toContain('getThumbnailUrlForViewport(\'persona\', personaAvatar)');
        expect(read('scripts', 'authors-note.js'))
            .toContain('getThumbnailUrlForViewport(\'avatar\', charAvatar)');
        expect(read('scripts', 'group-chat-scene-ui.js'))
            .toContain('getThumbnailUrlForViewport(\'avatar\', avatar)');
        const groupChats = read('scripts', 'group-chats.js');
        expect(groupChats).toContain('src: getThumbnailUrlForViewport(\'avatar\', avatarId)');
        expect(groupChats).toContain('const avatar = getThumbnailUrlForViewport(\'avatar\', characters[charIndex].avatar)');
        expect(groupChats).toContain('const avatar = getThumbnailUrlForViewport(\'avatar\', character.avatar)');
    });

    test('stored message and group avatars keep their stable URL', () => {
        const groupChats = read('scripts', 'group-chats.js');
        expect(groupChats).toContain('force_avatar: getThumbnailUrl(\'avatar\', character.avatar)');
        expect(groupChats).toContain('avatar => getThumbnailUrl(\'avatar\', avatar)');
    });

    test('extensions receive the viewport helper', () => {
        const context = read('scripts', 'st-context.js');
        expect(context).toContain('getThumbnailUrlForViewport,');
        expect(context).toContain('getThumbnailUrlForViewport,\n        selectCharacterById');
    });
});
