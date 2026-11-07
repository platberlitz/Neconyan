import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const archiveCss = readFileSync(new URL('../public/scripts/extensions/neconyan-chats-archive/style.css', import.meta.url), 'utf8');

describe('archive panel shapes', () => {
    test.each([
        '.sbca-tools-content', '.sbca-mention-menu', '.sbca-organizer',
        '.sbca-viewer', '.sbca-row-button', '.sbca-viewer-details', '.sbca-organizer-tags',
    ])('%s caps the button radius for its multi-line contents', selector => {
        const start = archiveCss.indexOf(`${selector} {`);
        expect(start).toBeGreaterThanOrEqual(0);
        const rule = archiveCss.slice(start, archiveCss.indexOf('}', start));
        expect(rule).toContain('border-radius: min(var(--sb-radius-button, 14px), 18px);');
    });
});
