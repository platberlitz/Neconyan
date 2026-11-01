import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from '@jest/globals';

const HANDBOOK = 'https://platberlitz.github.io/neconyan-docs/';
const publicRoot = new URL('../public/', import.meta.url).pathname;
const read = relative => fs.readFileSync(path.join(publicRoot, relative), 'utf8');

function listShippedSources(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') {
                files.push(...listShippedSources(full));
            }
        } else if (/\.(html|js|mjs|json)$/.test(entry.name)) {
            files.push(full);
        }
    }
    return files;
}

function nearestHandbookHref(source, marker) {
    const index = source.indexOf(marker);
    expect(index).toBeGreaterThan(-1);
    const links = [...source.matchAll(/https:\/\/platberlitz\.github\.io\/neconyan-docs\/[^"'\s<)]*/g)];
    const nearest = links.reduce((best, match) => (Math.abs(match.index - index) < Math.abs(best.index - index) ? match : best));
    return nearest[0];
}

describe('in-app documentation links', () => {
    test('no shipped file links to the SillyTavern documentation', () => {
        const offenders = listShippedSources(publicRoot)
            .filter(file => fs.readFileSync(file, 'utf8').includes('docs.sillytavern.app'))
            .map(file => path.relative(publicRoot, file));
        expect(offenders).toEqual([]);
    });

    test('help links in the main page point at the matching handbook sections', () => {
        const indexHtml = read('index.html');
        const expectations = [
            ['id="openai_reasoning_effort"', 'workspace/model-settings/#reasoning-effort'],
            ['id="prompt_post_processing_form"', 'workspace/model-settings/#prompt-post-processing'],
            ['id="custom_stopping_strings"', 'workspace/model-settings/#stopping-strings'],
            ['id="tokenizer"', 'workspace/model-settings/#tokenizer'],
            ['id="user-settings-block"', 'workspace/#settings'],
            ['id="chartokenwarning"', 'workspace/characters/#token-counts'],
            ['id="description_textarea"', 'workspace/characters/#description'],
            ['id="personality_textarea"', 'workspace/characters/#personality'],
            ['id="scenario_pole"', 'workspace/characters/#scenario'],
            ['id="mes_example_textarea"', 'workspace/characters/#dialogue-examples'],
            ['id="firstmessage_textarea"', 'workspace/characters/#first-message'],
            ['id="select_chat_popup"', 'workspace/roleplay/#saved-chats'],
            ['data-i18n="Inclusion Group">Inclusion Group', 'workspace/lorebooks/#inclusion-groups'],
            ['STscript: strict escaping', 'workspace/roleplay/#script-parser-options'],
        ];
        for (const [marker, section] of expectations) {
            expect({ marker, href: nearestHandbookHref(indexHtml, marker) }).toEqual({ marker, href: HANDBOOK + section });
        }
    });

    test('script-built and extension help links point at the handbook', () => {
        expect(read('scripts/openai.js')).toContain(`href: '${HANDBOOK}workspace/model-settings/#sampling'`);
        expect(read('scripts/textgen-settings.js')).toContain(`href: '${HANDBOOK}workspace/model-settings/#sampling'`);
        expect(read('scripts/macros/engine/MacroDiagnostics.js')).toContain(`${HANDBOOK}macros/`);
        expect(read('scripts/neconyan-tabs.js')).toContain(`${HANDBOOK}workspace/lorebooks/`);
        expect(read('scripts/neconyan-tabs.js')).toContain(`${HANDBOOK}workspace/characters/#set-up-your-persona`);
        expect(read('scripts/extensions/connection-manager/settings.html')).toContain(`${HANDBOOK}start/connections/#save-a-connection-profile`);
        expect(read('scripts/extensions/regex/editor.html')).toContain(`${HANDBOOK}workspace/roleplay/#find-and-replace-rules`);
        expect(read('scripts/extensions/regex/editor.html')).toContain(`${HANDBOOK}workspace/roleplay/#regex-flags`);
        expect(read('scripts/extensions/assets/index.js')).toContain(`${HANDBOOK}workspace/model-settings/#function-tools`);
    });
});
