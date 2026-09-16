// Builds local UI dictionaries through a user-selected translation command.
// No chats, cards, settings or credentials are read by this build.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { load } from 'cheerio';
import { parse } from 'acorn';

const root = path.resolve('public');
const output = path.join(root, 'locales/neconyan');
const source = {};
const add = (key, value = key) => {
    if (typeof key !== 'string' || typeof value !== 'string' || !/[a-zA-Z]/.test(value) || value.length > 3000) return;
    source[key] = value;
};
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'locales/lang.json'), 'utf8'));
const locales = metadata.filter(item => item.lang !== 'en');
for (const locale of locales) {
    const data = JSON.parse(fs.readFileSync(path.join(root, `locales/${locale.lang}.json`), 'utf8'));
    for (const [key, value] of Object.entries(data)) if (typeof value === 'string') add(key);
}

function walkAst(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'TaggedTemplateExpression' && node.tag.name === 't') {
        add(node.quasi.quasis.map((q, index) => q.value.cooked + (index < node.quasi.expressions.length ? '${' + index + '}' : '')).join(''));
    }
    if (node.type === 'Property' && ['label', 'title', 'placeholder', 'description', 'textContent', 'innerText', 'okButton', 'cancelButton'].includes(node.key.name || node.key.value) && node.value.type === 'Literal') add(node.value.value);
    if (node.type === 'AssignmentExpression' && ['textContent', 'innerText'].includes(node.left.property?.name) && node.right.type === 'Literal') add(node.right.value);
    if (node.type === 'CallExpression' && ['translate'].includes(node.callee.name) && node.arguments[0]?.type === 'Literal') add(node.arguments[1]?.value || node.arguments[0].value, node.arguments[0].value);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walkAst);
        else if (value && typeof value === 'object') walkAst(value);
    }
}

function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['locales', 'lib', 'webfonts', 'node_modules'].includes(entry.name)) continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) { visit(filename); continue; }
        if (!/\.(html|js)$/.test(filename) || filename.endsWith('.min.js')) continue;
        const text = fs.readFileSync(filename, 'utf8');
        if (filename.endsWith('.js')) {
            try { walkAst(parse(text, { ecmaVersion: 'latest', sourceType: 'module' })); } catch { /* Vendor scripts may not be modules. */ }
            continue;
        }
        const $ = load(text);
        $('[data-i18n]').each((_index, element) => {
            for (const spec of $(element).attr('data-i18n').split(';')) {
                const match = spec.match(/^\[([^\]]+)\](.+)$/);
                add(match ? match[2] : spec, match ? $(element).attr(match[1]) : $(element).text().trim());
            }
        });
        $('button,summary,label,option,h1,h2,h3,h4,.menu_button').each((_index, element) => {
            $(element).contents().filter((_i, node) => node.type === 'text').each((_i, node) => {
                const value = node.data.trim();
                if (!/[{}<>]/.test(value)) add(value);
            });
        });
        $('[title],[placeholder],[aria-label]').each((_index, element) => {
            for (const attribute of ['title', 'placeholder', 'aria-label']) {
                const value = $(element).attr(attribute);
                if (value && !/[{}<>]/.test(value)) add(value);
            }
        });
    }
}
visit(root);
const placeholders = value => (value.match(/\$\{[^}]+\}|\{\{[^}]+\}\}|%[sd]|\{\d+\}/g) || []).sort();
const command = process.env.NECONYAN_TRANSLATION_COMMAND;
if (!command) {
    console.log(JSON.stringify({ strings: Object.keys(source).length, locales: locales.map(item => item.lang) }));
    process.exit(0);
}
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'en.json'), JSON.stringify(source, null, 2) + '\n');
async function translate(language, strings) {
    const entries = Object.entries(strings);
    const numbered = Object.fromEntries(entries.map(([, value], index) => [String(index), value]));
    return new Promise((resolve, reject) => {
        const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        const timeout = setTimeout(() => { child.kill(); reject(new Error('Translation timed out')); }, 300000);
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', code => {
            clearTimeout(timeout);
            if (code) return reject(new Error(stderr || `Translation exited ${code}`));
            try {
                const parsed = JSON.parse(stdout.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, ''));
                // A single bad entry drops only itself; the rest of the batch is kept and the key is retried next run.
                const accepted = {};
                for (const [index, [key, value]] of entries.entries()) {
                    const candidate = parsed[index];
                    if (typeof candidate === 'string' && candidate.trim() && JSON.stringify(placeholders(candidate)) === JSON.stringify(placeholders(value))) {
                        accepted[key] = candidate;
                    } else {
                        console.warn(`${language}: skipped ${key} (invalid translation or placeholders)`);
                    }
                }
                if (!Object.keys(accepted).length) throw new Error('Translation returned no usable entries');
                resolve(accepted);
            } catch (error) { reject(error); }
        });
        child.stdin.end(JSON.stringify({ language, strings: numbered }));
    });
}
async function buildLocale(locale) {
    const filename = path.join(output, locale.lang + '.json');
    const existing = JSON.parse(fs.readFileSync(path.join(root, `locales/${locale.lang}.json`), 'utf8'));
    const translated = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
    const missing = Object.entries(source).filter(([key]) => !existing[key] && !translated[key]);
    for (let index = 0; index < missing.length; index += 60) {
        const batch = Object.fromEntries(missing.slice(index, index + 60));
        let result = null;
        for (let attempt = 0; attempt < 3 && !result; attempt++) {
            try { result = await translate(locale.display, batch); } catch (error) {
                console.warn(`${locale.lang}: batch ${index / 60 + 1} attempt ${attempt + 1} failed: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
            }
        }
        // A batch that failed three times is skipped; a later run picks its keys up again.
        if (!result) continue;
        Object.assign(translated, result);
        const temp = filename + '.tmp';
        fs.writeFileSync(temp, JSON.stringify(translated, null, 2) + '\n');
        fs.renameSync(temp, filename);
        console.log(`${locale.lang}: ${Math.min(index + 60, missing.length)}/${missing.length}`);
    }
}
// Independent dictionary files can be checkpointed concurrently; requests stay bounded.
const queue = [...locales];
await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) await buildLocale(queue.shift());
}));
