import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileShellCss = readFileSync(path.join(repoRoot, 'public', 'css', 'neconyan-mobile-shell.css'), 'utf8');
const mobileStylesCss = readFileSync(path.join(repoRoot, 'public', 'css', 'mobile-styles.css'), 'utf8');
const indexHtml = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');

describe('mobile composer STscript controls', () => {
    test('hides idle script controls but permits Stop during script execution', () => {
        expect(mobileShellCss).toMatch(/#form_sheld:not\(\.isExecutingCommandsFromChatInput\) #rightSendForm > \.stscript_btn,[^}]*display:\s*none\s*!important/);
        expect(mobileShellCss).toMatch(/#rightSendForm > \.stscript_btn:not\(\.stscript_stop\),[^}]*display:\s*none\s*!important/);
    });

    test('the override sheet still loads after the sheet that forces display:flex', () => {
        const mobileStylesIdx = indexHtml.indexOf('css/mobile-styles.css');
        const mobileShellIdx = indexHtml.indexOf('css/neconyan-mobile-shell.css');

        expect(mobileStylesIdx).toBeGreaterThan(-1);
        expect(mobileShellIdx).toBeGreaterThan(-1);
        expect(mobileShellIdx).toBeGreaterThan(mobileStylesIdx);
    });

    test('makes room for command and reply controls in the two-slot action rail', () => {
        expect(mobileShellCss).toMatch(/#form_sheld\.isExecutingCommandsFromChatInput #qig-input-btn,[^}]*display:\s*none\s*!important/);
        expect(mobileShellCss).toMatch(/#send_form\.sb-generating-controls\.has-slash-command #qig-input-btn\s*\{[^}]*display:\s*none\s*!important/);
    });

    test('mobile-styles.css still forces the controls visible (the thing being overridden)', () => {
        // Guards against #533 being reverted upstream: if it ever is, this test
        // flips and the override rule above can be simplified.
        expect(mobileStylesCss).toMatch(/#rightSendForm\s*>\s*\.stscript_btn\s*\{[^}]*display:\s*flex\s*!important/);
    });
});
