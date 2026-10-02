import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/css/neconyan.css', import.meta.url), 'utf8');

describe('Labelled message action layout', () => {
    test('removes icon aspect ratios when actions become labelled controls', () => {
        const sizing = css.match(/body\.neconyan #chat :is\(\.neconyan-message-action, \.extraMesButtons > \*\) \{([^}]+)\}/)[1];
        expect(sizing).toContain('aspect-ratio: auto;');
        expect(sizing).toContain('block-size: auto;');
    });

    test('left-aligns wrapped labels inside the expanded action menu', () => {
        const menu = css.match(/body\.neconyan #chat \.extraMesButtons > \* \{([^}]+)\}/)[1];
        expect(menu).toContain('justify-content: flex-start;');
        expect(menu).toContain('text-align: left;');
    });
});
