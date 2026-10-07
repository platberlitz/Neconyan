import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');

const indexHtml = read('public/index.html');
const scriptJs = read('public/script.js');
const powerUserJs = read('public/scripts/power-user.js');

const TOGGLES = [
    ['messageModelNameEnabled', 'timestamp_model_name'],
    ['messageReasoningEffortEnabled', 'timestamp_reasoning_effort'],
];

function getFunctionSource(name) {
    const match = scriptJs.match(new RegExp(`(?:export )?function ${name}\\([\\s\\S]*?\\n\\}`));
    expect(match).not.toBeNull();
    return match[0].replace(/^export /, '');
}

function loadCreateModelIcon() {
    const patterns = scriptJs.match(/const CUSTOM_MODEL_ICON_PATTERNS = Object\.freeze\(\[[\s\S]*?\n\]\);/);
    expect(patterns).not.toBeNull();

    class FakeImage {
        constructor() {
            this.classList = { add() {} };
        }
    }

    return new Function('Image', 'chat_completion_sources', `${patterns[0]}
${getFunctionSource('inferCustomModelIconName')}
${getFunctionSource('createModelIcon')}
return createModelIcon;`)(FakeImage, { LINKAPI: 'linkapi' });
}

describe('message model icon label', () => {
    test('both toggles sit with the model icon toggle in Visual Toggles', () => {
        const themeToggles = indexHtml.search(/<div name="themeToggles"[\s>]/);
        expect(themeToggles).toBeGreaterThan(-1);

        for (const [id] of TOGGLES) {
            expect(indexHtml).toContain(`<input id="${id}" type="checkbox" />`);
            expect(indexHtml.indexOf(id)).toBeGreaterThan(themeToggles);
        }

        expect(indexHtml).toMatch(/messageModelIconEnabled[\s\S]{0,900}?messageModelNameEnabled[\s\S]{0,900}?messageModelNameShortEnabled[\s\S]{0,900}?messageReasoningEffortEnabled/);
    });

    test('the short model name toggle is off by default and repaints messages', () => {
        expect(indexHtml).toContain('<input id="messageModelNameShortEnabled" type="checkbox" />');
        expect(powerUserJs).toContain('timestamp_model_name_short: false,');
        expect(powerUserJs).toContain('$(\'#messageModelNameShortEnabled\').prop(\'checked\', power_user.timestamp_model_name_short);');

        const handler = powerUserJs.match(/\$\('#messageModelNameShortEnabled'\)\.on\('input', function \(\) \{([\s\S]*?)\n {4}\}\);/);
        expect(handler?.[1]).toContain('power_user.timestamp_model_name_short = !!$(this).prop(\'checked\');');
        expect(handler?.[1]).toContain('refreshMessageModelIcons();');
    });

    test('the short model name drops provider prefixes and bracket tags', () => {
        const getShortModelName = new Function(`${getFunctionSource('getShortModelName')}
return getShortModelName;`)();

        expect(getShortModelName('kimi/kimi-k3')).toBe('kimi-k3');
        expect(getShortModelName('smol-kimi/kimi-k3')).toBe('kimi-k3');
        expect(getShortModelName('openrouter/moonshotai/kimi-k3')).toBe('kimi-k3');
        expect(getShortModelName('[free] deepseek-v4-pro')).toBe('deepseek-v4-pro');
        expect(getShortModelName('[SP]claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
        expect(getShortModelName('deepseek-v4-pro')).toBe('deepseek-v4-pro');
        expect(getShortModelName('model/')).toBe('model');
        expect(getShortModelName('')).toBe('');
    });

    test('the label uses the short name only when the toggle is on', () => {
        const build = settings => new Function('power_user', `${getFunctionSource('getShortModelName')}
${getFunctionSource('getMessageIconLabel')}
return getMessageIconLabel;`)(settings);
        const extra = { model: 'kimi/kimi-k3', reasoning_effort: 'high' };

        expect(build({ timestamp_model_name: true, timestamp_reasoning_effort: true })(extra)).toBe('kimi/kimi-k3 (high)');
        expect(build({ timestamp_model_name: true, timestamp_model_name_short: true, timestamp_reasoning_effort: true })(extra)).toBe('kimi-k3 (high)');
        expect(build({ timestamp_model_name: false, timestamp_model_name_short: true })(extra)).toBe('');
    });

    test('both toggles are wired to the power user settings', () => {
        for (const [id, setting] of TOGGLES) {
            // Neconyan ships these message-chrome toggles on by default (unreleased product default).
            expect(powerUserJs).toContain(`${setting}: true,`);
            expect(powerUserJs).toContain(`$('#${id}').prop('checked', power_user.${setting});`);

            const handler = powerUserJs.match(new RegExp(`\\$\\('#${id}'\\)\\.on\\('input', function \\(\\) \\{([\\s\\S]*?)\\n    \\}\\);`));
            expect(handler?.[1]).toContain(`power_user.${setting} = !!$(this).prop('checked');`);
            // Toggling has to repaint already rendered messages, not just save.
            expect(handler?.[1]).toContain('refreshMessageModelIcons();');
        }
    });

    test('the label is written whether or not model icons are on', () => {
        // Rendering it from inside the icon insert would silently do nothing with icons off.
        expect(scriptJs).toContain(`    if (power_user.timestamp_model_icon && mes.extra?.api) {
        insertSVGIcon(messageElement, mes.extra);
    }

    insertModelLabel(messageElement, mes.extra);`);
        // Live replies also have a status timestamp; write the model label only once.
        expect(scriptJs).toContain('insertAfter(icon.length ? icon : mes.find(\'.timestamp\').first())');
    });

    test('the label is cleared before messages are repainted', () => {
        expect(scriptJs).toContain('.timestamp-icon, .thinking-icon, .timestamp-model\').remove()');
    });

    test('every generated reply records the reasoning effort next to its model', () => {
        // The effort is only known while generating, so a stamp site that forgets it
        // leaves those messages unable to ever show one.
        const modelStamps = [...scriptJs.matchAll(/^([ \t]*)(\w+)\.extra\.model = getGeneratingModel\(\);$/gm)];
        expect(modelStamps.length).toBeGreaterThan(0);

        const missingEffort = modelStamps.filter(([line, indent, target]) =>
            !scriptJs.includes(`${line}\n${indent}${target}.extra.reasoning_effort = getCurrentReasoningEffort();`));

        expect(missingEffort.map(match => match[0].trim())).toEqual([]);
    });
});

describe('LinkAPI model icons', () => {
    const createModelIcon = loadCreateModelIcon();

    test('uses the relevant SVG for each model', () => {
        for (const [model, icon] of [
            ['gemini-2.5-pro', 'makersuite'],
            ['gemma-3-27b-it', 'makersuite'],
            ['google/gemini-2.5-pro', 'makersuite'],
            ['claude-sonnet-4-5', 'claude'],
            ['[SP]claude-sonnet-4-5', 'claude'],
            ['gpt-5', 'openai'],
            ['unknown-model', 'generic'],
        ]) {
            const image = createModelIcon('linkapi', model);

            expect(image.src).toBe(`/img/${icon}.svg`);
            expect(image.title).toBe(`linkapi - ${model}`);
        }
    });

    test('leaves other API icons unchanged', () => {
        expect(createModelIcon('openrouter', 'google/gemini-2.5-pro').src).toBe('/img/openrouter.svg');
    });
});
