import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worldInfoCss = readFileSync(path.join(repoRoot, 'public', 'css', 'world-info.css'), 'utf8').replace(/\r\n/g, '\n');

function getRuleBody(cssSource, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...cssSource.matchAll(new RegExp(`^\\s*${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'gms'))];
    return matches.at(-1)?.groups?.body ?? '';
}

describe('lorebook entry title box', () => {
    test('centres one line of title text inside the 44px row box', () => {
        const rowPrefix = 'body.neconyan #WorldInfo.sb-shell-embedded-content #world_popup_entries_list .WIEntryTitleAndStatus';
        const boxRule = getRuleBody(worldInfoCss, `${rowPrefix} :is(textarea, select)`);
        const titleRule = getRuleBody(worldInfoCss, `${rowPrefix} textarea`);

        expect(boxRule).toContain('height: 44px;');
        expect(titleRule).toContain('padding-block: 12px;');
        expect(titleRule).toContain('line-height: 18px;');
        expect(worldInfoCss.indexOf(`${rowPrefix} textarea {`)).toBeGreaterThan(worldInfoCss.indexOf(`${rowPrefix} :is(textarea, select) {`));
    });
});
