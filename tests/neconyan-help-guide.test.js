import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { describe, expect, test } from '@jest/globals';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

const template = read('../public/scripts/templates/help.html');
const systemMessagesSource = read('../public/scripts/system-messages.js');
const slashCommandsSource = read('../public/scripts/slash-commands.js');
const indexHtml = read('../public/index.html');
const helpCss = read('../public/css/neconyan-help.css');

function listSources(relativeDir) {
    const root = new URL(relativeDir, import.meta.url);
    const files = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.js')) {
                files.push(fs.readFileSync(full, 'utf8'));
            }
        }
    };
    walk(root.pathname);
    return files.join('\n');
}

function registeredMacroNames() {
    const source = [
        listSources('../public/scripts/macros/'),
        listSources('../public/scripts/extensions/third-party/MacroEnhanced/src/'),
    ].join('\n');
    const names = new Set();
    const patterns = [
        /(?:registerMacro|safeRegister|register[A-Za-z]*|comparison)\('([A-Za-z_]+)'/g,
        /alias: '([A-Za-z_]+)'/g,
        /PRONOUN_STATEFUL_MACRO_NAMES = Object\.freeze\(\['([A-Za-z_]+)'/g,
    ];
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
            names.add(match[1]);
        }
    }
    return names;
}

function mentionedMacroNames() {
    const names = new Set();
    for (const match of template.matchAll(/&lcub;&lcub;([^&]*)/g)) {
        if (match[1].startsWith('//')) {
            continue;
        }
        const name = match[1].replace(/^[/#!]/, '').split(/[:\s]/)[0];
        if (name) {
            names.add(name);
        }
    }
    return names;
}

describe('Neconyan /? help guide', () => {
    test('the template has no Handlebars expressions, so macro examples render literally', () => {
        expect(template).not.toContain('{{');
        expect(Handlebars.compile(template)({})).toBe(template);
    });

    test('Miso, Taro and Nori each host a section with their own face', () => {
        for (const assistant of ['miso', 'taro', 'nori']) {
            expect(template).toContain(`necoHelpHost necoHelpHost--${assistant}`);
            expect(template).toContain(`img/neconyan/assistant-icons/${assistant}-neutral.png`);
        }
        expect(template.match(/<details class="necoHelpHost/g)).toHaveLength(3);
    });

    test('the guide links to every older help page and the Macro Workbench', () => {
        for (const page of ['1', '2', '3', '4']) {
            expect(template).toContain(`data-displayHelp="${page}"`);
        }
        expect(template).toContain('data-neconyan-help-action="workbench"');
        expect(template).not.toContain('docs.sillytavern.app');
        expect(template).not.toMatch(/data-i18n="help_\d"/);
    });

    test('the copy follows the house style', () => {
        expect(template).not.toContain('\u2014');
        expect(template).not.toMatch(/\bcolor\b|\bfavorite\b|\bcustomize\b/i);
    });

    test('every macro the guide names is a real macro or a documented special case', () => {
        const registered = registeredMacroNames();
        const specialCases = new Set([
            'else', 'pipe',
            'sub', 'obj', 'poss', 'ref', 'pverb', 'Sub', 'charsub',
            'greet', 'who',
            'me-upper',
        ]);
        const unknown = [...mentionedMacroNames()].filter(name => !registered.has(name)
            && !specialCases.has(name)
            && !/^[.$]/.test(name));
        expect(unknown).toEqual([]);
    });

    test('help faces follow each assistant\'s chosen art', () => {
        const literal = systemMessagesSource.match(/const ASSISTANT_HELP_FACE_PATTERN = (\/.+\/g);/);
        expect(literal).not.toBeNull();
        const pattern = new Function(`return ${literal[1]};`)();
        const swapped = template.replace(pattern, (_, personality) => `img/neconyan/assistant-icons/${personality}-female.png?v=test`);
        expect(swapped).not.toContain('-neutral.png');
        expect(swapped.match(/-female\.png\?v=test"/g).length).toBeGreaterThanOrEqual(6);
        expect(systemMessagesSource).toContain('import { getAssistantIconSrc } from \'./neconyan-assistant-art.js\';');
        expect(systemMessagesSource).toMatch(/type === system_message_types\.HELP && !text\) \{\s*newMessage\.mes = withAssistantHelpFaces\(newMessage\.mes\);/);
    });

    test('the Workbench button runs Macro Enhanced\'s own command and explains when it is off', () => {
        const start = slashCommandsSource.indexOf('[data-neconyan-help-action="workbench"]');
        expect(start).toBeGreaterThan(-1);
        const handler = slashCommandsSource.slice(start, start + 900);
        expect(handler).toContain('SlashCommandParser.commands[\'me-workbench\']');
        expect(handler).toContain('Switch on Macro Enhanced in Extensions to use the Macro Workbench.');
    });

    test('the guide stylesheet loads deferred and only styles the guide', () => {
        expect(indexHtml).toMatch(/<link href="css\/neconyan-help\.css\?v=[^"]+" rel="preload" as="style" data-sb-deferred-style data-sb-media="all">/);
        const selectors = helpCss
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .match(/[^{}]+(?=\{)/g)
            .map(selector => selector.trim())
            .filter(selector => selector && !selector.startsWith('@') && !/^(from|to|\d+%)$/.test(selector));
        for (const group of selectors) {
            for (const selector of group.split(/,(?![^(]*\))/)) {
                expect(selector.trim()).toMatch(/^#chat (\.custom-necoHelp\b|\.mes:has\(\.custom-necoHelp\) > )/);
            }
        }
        expect(helpCss).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    });
});
