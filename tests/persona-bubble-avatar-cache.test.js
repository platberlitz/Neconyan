import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tabsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'neconyan-tabs.js'), 'utf8');
const eventsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'events.js'), 'utf8');
const personasSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'personas.js'), 'utf8');

function getFunctionSource(source, name) {
    const match = source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    expect(match).not.toBeNull();
    return match[0].replace(/^export /, '');
}

class FakeBubble {
    constructor() {
        this.style = { backgroundImage: '' };
        this.attributes = new Map();
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }
}

/**
 * Rebuilds the bottom bar's persona picture pipeline from the shipped function bodies.
 * The module cannot be imported under Jest, so it runs with the handful of globals it closes over.
 */
function loadPersonaBubblePipeline({ mobile = { value: false }, personas = { 'Kris.png': 'Kris' }, userAvatar = 'Kris.png' } = {}) {
    const state = {
        bottomChatBar: {
            personaBubble: null,
            personaAvatarRevisions: new Map(),
        },
    };
    const context = {
        userAvatar,
        name1: 'You',
        powerUserSettings: { personas },
    };
    const body = [
        getFunctionSource(tabsSource, 'recordPersonaAvatarRevision'),
        getFunctionSource(tabsSource, 'updatePersonaBubble'),
        getFunctionSource(tabsSource, 'getCurrentPersonaSelection'),
        getFunctionSource(tabsSource, 'getBottomChatBarState'),
        `return {
            recordPersonaAvatarRevision,
            updatePersonaBubble,
            getCurrentPersonaSelection,
            state: nnState,
        };`,
    ].join('\n\n');

    const factory = new Function(
        'document',
        'HTMLElement',
        'getPersonaDisplayNameWithAppendices',
        'getSillyTavernContext',
        'mobile',
        'nnState',
        `function getThumbnailUrl(type, file, t = false) {
            return \`/thumbnail?type=\${type}&file=\${encodeURIComponent(file)}\${t ? \`&t=\${Date.now()}\` : ''}\`;
        }
        function getMobileThumbnailUrl(type, file, t = false) {
            return \`/thumbnail?type=\${type}&file=\${encodeURIComponent(file)}&preset=mobile\${t ? \`&t=\${Date.now()}\` : ''}\`;
        }
        function getThumbnailUrlForViewport(type, file, t = false) {
            return mobile ? getMobileThumbnailUrl(type, file, t) : getThumbnailUrl(type, file, t);
        }\n${body}`,
    );

    return factory(
        { getElementById: () => null, querySelector: () => null },
        FakeBubble,
        (contextValue, avatarId, name) => name || avatarId,
        () => context,
        mobile.value,
        state,
    );
}

function bubbleUrl(bubble) {
    const match = String(bubble.style.backgroundImage).match(/^url\("(.*)"\)$/);
    return match?.[1] ?? '';
}

describe('bottom persona bar avatar cache', () => {
    test('paints the plain thumbnail until the persona picture is replaced', () => {
        const { updatePersonaBubble } = loadPersonaBubblePipeline();
        const bubble = new FakeBubble();

        updatePersonaBubble(bubble);

        expect(bubbleUrl(bubble)).toBe('/thumbnail?type=persona&file=Kris.png');
        expect(bubble.getAttribute('title')).toBe('Persona: Kris');
    });

    test('adds a revision to the picture URL after a replacement', () => {
        const { updatePersonaBubble, recordPersonaAvatarRevision } = loadPersonaBubblePipeline();
        const bubble = new FakeBubble();

        recordPersonaAvatarRevision('Kris.png');
        updatePersonaBubble(bubble);

        expect(bubbleUrl(bubble)).toMatch(/^\/thumbnail\?type=persona&file=Kris\.png&t=\d+$/);
    });

    test('keeps one revision across later renders so the replaced picture stays cached', () => {
        const { updatePersonaBubble, recordPersonaAvatarRevision } = loadPersonaBubblePipeline();
        const bubble = new FakeBubble();

        recordPersonaAvatarRevision('Kris.png');
        updatePersonaBubble(bubble);
        const first = bubbleUrl(bubble);

        updatePersonaBubble(bubble);

        expect(bubbleUrl(bubble)).toBe(first);
    });

    test('a new revision lands on the phone preset URL too', () => {
        const { updatePersonaBubble, recordPersonaAvatarRevision } = loadPersonaBubblePipeline({ mobile: { value: true } });
        const bubble = new FakeBubble();

        recordPersonaAvatarRevision('Kris.png');
        updatePersonaBubble(bubble);

        expect(bubbleUrl(bubble)).toMatch(/^\/thumbnail\?type=persona&file=Kris\.png&preset=mobile&t=\d+$/);
    });

    test('a second replacement moves past the earlier revision even in the same millisecond', () => {
        const { updatePersonaBubble, recordPersonaAvatarRevision, state } = loadPersonaBubblePipeline();
        const bubble = new FakeBubble();

        recordPersonaAvatarRevision('Kris.png');
        const first = state.bottomChatBar.personaAvatarRevisions.get('Kris.png');
        recordPersonaAvatarRevision('Kris.png');
        const second = state.bottomChatBar.personaAvatarRevisions.get('Kris.png');

        expect(second).toBeGreaterThan(first);
        updatePersonaBubble(bubble);
        expect(bubbleUrl(bubble)).toContain(`&t=${second}`);
    });

    test('another persona replacing its picture leaves the active bubble alone', () => {        const { updatePersonaBubble, recordPersonaAvatarRevision } = loadPersonaBubblePipeline();
        const bubble = new FakeBubble();

        recordPersonaAvatarRevision('Other.png');
        updatePersonaBubble(bubble);

        expect(bubbleUrl(bubble)).toBe('/thumbnail?type=persona&file=Kris.png');
    });

    test('ignores an empty avatar id and keeps the placeholder background', () => {
        const { updatePersonaBubble, recordPersonaAvatarRevision, state } = loadPersonaBubblePipeline({ userAvatar: '' });
        const bubble = new FakeBubble();

        recordPersonaAvatarRevision('');
        updatePersonaBubble(bubble);

        expect(state.bottomChatBar.personaAvatarRevisions.size).toBe(0);
        expect(bubble.style.backgroundImage).toBe('none');
    });

    test('a changed picture is announced once, after the replacement is committed', () => {
        expect(eventsSource).toContain('PERSONA_AVATAR_CHANGED: \'persona_avatar_changed\'');
        const refreshSource = getFunctionSource(personasSource, 'refreshPersonaAvatar');

        expect(refreshSource).toContain('eventSource.emit(event_types.PERSONA_AVATAR_CHANGED, avatarId)');
        expect(refreshSource.indexOf('reloadPersonaAvatar(avatarId, true)'))
            .toBeLessThan(refreshSource.indexOf('eventSource.emit(event_types.PERSONA_AVATAR_CHANGED, avatarId)'));
    });

    test('the bottom bar listens for the announcement and redraws the bubble', () => {
        const bindingStart = tabsSource.indexOf('function bindBottomChatBarEvents');
        const binding = tabsSource.slice(bindingStart, tabsSource.indexOf('\nfunction ', bindingStart + 10));

        expect(binding).toContain('eventTypes.PERSONA_AVATAR_CHANGED');
        expect(binding).toContain('recordPersonaAvatarRevision(avatarId)');
        expect(binding).toContain('refreshPersona()');
    });
});
