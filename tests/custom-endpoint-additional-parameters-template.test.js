import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const template = fs.readFileSync(
    fileURLToPath(new URL('../public/scripts/templates/customEndpointAdditionalParameters.html', import.meta.url)),
    'utf8',
);
const openaiSource = fs.readFileSync(
    fileURLToPath(new URL('../public/scripts/openai.js', import.meta.url)),
    'utf8',
);

describe('Custom endpoint Additional Parameters popup', () => {
    test('keeps the three YAML fields and the reasoning parameter controls', () => {
        for (const id of [
            'custom_include_body',
            'custom_exclude_body',
            'custom_include_headers',
            'custom_reasoning_param_format',
            'custom_reasoning_param_name',
            'custom_reasoning_enabled_value',
            'custom_reasoning_disabled_value',
        ]) {
            expect(template).toContain(`id="${id}"`);
        }
    });

    test('no longer ships the Model Preset select', () => {
        expect(template).not.toContain('custom_reasoning_preset');
        expect(template).not.toContain('Model Preset');
        expect(openaiSource).not.toContain('custom_reasoning_preset');
        expect(openaiSource).not.toContain('custom-reasoning-preset');
    });

    test('every visible label and hint is translatable', () => {
        const labelSpans = [...template.matchAll(/<span\b([^>]*)>/g)];
        const hints = [...template.matchAll(/<small\b([^>]*)>/g)];
        const headings = [...template.matchAll(/<h[34]\b([^>]*)>/g)];
        expect(labelSpans.length).toBeGreaterThan(0);
        expect(hints.length).toBeGreaterThan(0);
        for (const [, attrs] of [...labelSpans, ...hints, ...headings]) {
            expect(attrs).toMatch(/\bdata-i18n="/);
        }
    });

    test('has one hint per reasoning parameter format', () => {
        const formats = [...template.matchAll(/<option value="([a-z_]+)"/g)].map(match => match[1]);
        expect(formats).toEqual(['openai', 'boolean', 'string', 'thinking_object']);
        for (const format of formats) {
            expect(template).toContain(`data-format="${format}"`);
        }
    });

    test('opens as a scrollable popup instead of a fixed-height one', () => {
        const openCall = openaiSource.match(/callGenericPopup\(template, POPUP_TYPE\.TEXT, '', \{([^}]*)\}\)/);
        expect(openCall).not.toBeNull();
        expect(openCall[1]).toContain('allowVerticalScrolling: true');
        expect(openCall[1]).not.toContain('large');
    });
});
