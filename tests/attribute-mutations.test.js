import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasChangedAttributeValue } from '../public/scripts/util/attribute-mutations.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function element(attributes) {
    return { getAttribute: name => attributes[name] ?? null };
}

function attributeRecord(target, attributeName, oldValue) {
    return { type: 'attributes', target, attributeName, oldValue };
}

describe('hasChangedAttributeValue', () => {
    test('ignores writes that leave every attribute as it was', () => {
        const body = element({ class: 'neconyan flatchat', 'data-neconyan-chat-mode': 'roleplay' });

        expect(hasChangedAttributeValue([
            attributeRecord(body, 'class', 'neconyan flatchat'),
            attributeRecord(body, 'data-neconyan-chat-mode', 'roleplay'),
        ])).toBe(false);
        expect(hasChangedAttributeValue([])).toBe(false);
    });

    test('reports a real change anywhere in the batch', () => {
        const body = element({ class: 'neconyan flatchat sb-mobile-modal-open' });

        expect(hasChangedAttributeValue([
            attributeRecord(body, 'class', 'neconyan flatchat sb-mobile-modal-open'),
            attributeRecord(body, 'class', 'neconyan flatchat'),
        ])).toBe(true);
    });

    test('treats added and removed attributes as changes', () => {
        expect(hasChangedAttributeValue([attributeRecord(element({ class: 'neconyan' }), 'class', null)])).toBe(true);
        expect(hasChangedAttributeValue([attributeRecord(element({}), 'data-generating', 'true')])).toBe(true);
    });

    test('lets records it cannot compare through', () => {
        expect(hasChangedAttributeValue([{ type: 'childList', target: element({}) }])).toBe(true);
        expect(hasChangedAttributeValue([{ type: 'attributes', target: element({}), attributeName: null }])).toBe(true);
    });

    test('shell body watchers skip no-op writes and record old values', () => {
        const source = readFileSync(path.join(repoRoot, 'public/scripts/neconyan-tabs.js'), 'utf8');
        const observers = [...source.matchAll(/new MutationObserver\(records => \{\s*if \(hasChangedAttributeValue\(records\)\) \{[\s\S]*?\.observe\(([^,]+),\s*\{([\s\S]*?)\}\);/g)];

        expect(observers.map(match => match[1].trim())).toEqual(['document.body', 'document.body', 'document.body']);
        for (const [, , options] of observers) {
            expect(options).toContain('attributeOldValue: true');
        }
    });
});
