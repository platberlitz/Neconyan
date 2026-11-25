import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'acorn';

const root = fileURLToPath(new URL('../', import.meta.url));

test('German dictionaries have no duplicate keys that silently override reviewed translations', () => {
    for (const filename of ['de-de.json', 'neconyan/de-de.json']) {
        const text = readFileSync(new URL(`../public/locales/${filename}`, import.meta.url), 'utf8');
        const properties = parse(`(${text})`, { ecmaVersion: 'latest' }).body[0].expression.properties;
        const keys = properties.map(property => property.key.value);
        assert.equal(new Set(keys).size, keys.length, `duplicate key in ${filename}`);
    }
});

test('the interface catalogue collects captions from helpers, fallbacks, templates and arrays', () => {
    const run = spawnSync(process.execPath, ['scripts/build-interface-locales.js', '--list'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NECONYAN_TRANSLATION_COMMAND: '' } });
    assert.equal(run.status, 0, run.stderr);
    const keys = new Set(JSON.parse(run.stdout));
    // Helper argument inside an exported function, folder fallback, Home speaker, template, tab array,
    // the In-Chat Agents bulk-edit popup, which sits inside a <template> element, and a filter label that
    // BotSearcher declares in its server folder and its client puts on the page.
    for (const caption of ['Test keys', 'Unfiled', 'All books', 'Miso, Taro and Nori', 'Close ${0}', 'Pawspective', 'No automatic agents enabled', 'depth ${0}', 'Order ${0}', 'rewrites reply', 'Scan World Info', 'Don\'t change', 'Has all of these tags', 'Contrastive_search_txt', 'help_hotkeys_19_1', 'help_hotkeys_20', 'scoped.connections.openai_follow', 'scoped.hopper.follow', 'scoped.horde.enter_anonymous', 'scoped.key.enter', 'scoped.action.change']) {
        assert.ok(keys.has(caption), `missing ${caption}`);
    }
    for (const deadKey of ['bg_chat_hint_2', 'openai_reasoning_effort_auto', 'welcome_message_part_3']) {
        assert.ok(!keys.has(deadKey), `retired dead symbolic key still listed: ${deadKey}`);
    }
    const english = JSON.parse(readFileSync(new URL('../public/locales/neconyan/en.json', import.meta.url), 'utf8'));
    for (const caption of ['Vectorize all', 'Mark entries in this lorebook for Vectorization', 'Entries in \'${0}\' will also match by meaning with Vectorization. Their keywords are kept and still work.', 'Keyword entries to change: ${0}', 'Include constant entries (${0})', 'Turn on lorebook retrieval in replies', 'Changes the Vectorization setting for every active lorebook, not just this one.', 'Entries marked for Vectorization: ${0}', 'Could not save the lorebook, so no entries were changed. Reload it and try again.']) {
        assert.ok(keys.has(caption), `missing ${caption}`);
        assert.equal(english[caption], caption, `missing English caption: ${caption}`);
    }
    for (const caption of [
        'Click this toast to undo.',
        'Recolored ${0} message.',
        'Recolored ${0} messages.',
        'Recolored ${0} character; ${1} conflicts remain.',
        'Restored ${0} stored color tables. Skipped ${1} keys that now exist.',
        'Deleted ${0} selected characters. Kept ${1} pinned characters.',
        'Verified DOM colors: applied ${0} corrections, queued ${1} suggestions for review.',
        'Verification stopped after ${0} messages: the provider request failed. Applied ${1} corrections and queued ${2} suggestions before stopping.',
    ]) {
        assert.ok(keys.has(caption), `missing M102b caption: ${caption}`);
        assert.equal(english[caption], caption, `missing M102b English caption: ${caption}`);
    }
    for (const retired of [
        'Recolored ${0} message${1}.',
        'Recolored ${0} character${1}; ${2} conflict${3} remain.',
        'Restored ${0} stored color table${1}.${2}',
        'Skipped ${0} key${1} that now exist.',
        'Deleted ${0} selected character${1}.${2}',
        'Kept ${0} pinned character${1}.',
        'Verified DOM colors: applied ${0} correction${1}, queued ${2} suggestion${3} for review.',
        'Verification stopped after ${0} message${1}: the provider request failed.${2}',
    ]) {
        assert.ok(!keys.has(retired), `retired M102b key still collected: ${retired}`);
        assert.ok(!Object.hasOwn(english, retired), `retired M102b key still in en.json: ${retired}`);
    }
    const group5Captions = [
        'A **macro** is a short instruction inside double braces, such as **{{char}}**. It becomes text when a prompt is built. This page lets you look up the syntax, try it and keep macros of your own.',
        'The syntax switches control comparisons in **{{if}}** and repairs for macros written for other apps. Their help buttons explain exactly what changes.',
        'These settings appear for **Main API** and **WebLLM**. **LLM Prompt** is the instruction the model gets when it picks a feeling; the **{{labels}}** macro becomes the list of feelings it may choose from.',
        'Describe the picture you want. You can use **{{char}}** and **{{user}}** for the character and your persona names.',
        'The **Context Template** puts the pieces in order, using a **story string** with placeholders such as **{{description}}** and **{{persona}}**. Pick a ready-made template for your model.',
        '**What it does** holds the name, **Where results go** and the agent’s instructions. **Prompt or reply** lets it work on the request or the reply; **Companion note** makes it a companion that writes its own note. **Macros** such as {{char}} and {{user}} are filled in when it runs, and the refine button asks a model to improve the instructions before anything changes.',
        'A **persona** is you, in the story. Its name replaces **{{user}}** in cards and prompts, and its description tells the model what you look like and how you act.',
        '**Outlet Name** names the outlet for the **Outlet** position: write {{outlet::Name}} in a prompt and the entry appears there. **Automation ID** can run a Quick Reply when the entry joins in.',
        'This bug report draft is not a JSON object.',
        'This bug report draft has no title.',
        'This bug report draft does not say what went wrong.',
        '${0}\'s ${1} tour',
        'Start ${0}\'s ${1} tour',
        'all chats',
        'group chats',
        'individual chats',
        'Agent switches apply to ${0}.',
        '<None>',
        'Not found',
        'This page does not exist. Check the address for typos, or go back to the main Neconyan page.',
        'The previous process ended without running its exit handler. The operating system did not supply a cause; power loss, forced termination and native failures cannot be distinguished.',
    ];
    for (const caption of group5Captions) {
        assert.ok(keys.has(caption), `missing ${caption}`);
        assert.equal(english[caption], caption, `missing English caption: ${caption}`);
    }
    const group5Scoped = {
        'scoped.story_mode.word_count_one': '${0} word',
        'scoped.story_mode.word_count_many': '${0} words',
        'scoped.hopper.timeline_default': 'Timeline',
        'scoped.hopper.timeline_numbered': 'Timeline ${0}',
    };
    for (const [scopedKey, englishText] of Object.entries(group5Scoped)) {
        assert.ok(keys.has(scopedKey), `missing ${scopedKey}`);
        assert.equal(english[scopedKey], englishText, `missing English scoped value: ${scopedKey}`);
    }
    for (const excluded of [
        '${0} word',
        '${0} words',
        'Timeline ${0}',
        'Agent switches apply to ${0}.${1}',
        'This page is holding an old security code (a token that proves a request came from you), so Neconyan turned the request away. Reloading usually fixes it; the steps below cover the rest.',
        'This Neconyan is behind a login. Here is how to get back in.',
    ]) {
        assert.ok(!keys.has(excluded), `unexpected ${excluded}`);
    }
    // Developer-facing errors and identifiers never reach the page.
    for (const text of ['Server is not ready yet.', 'Could not close Meower.', 'BatchConflictError']) {
        assert.ok(!keys.has(text), `unexpected ${text}`);
    }
    // A template hole parsed as HTML becomes U+FFFD; such a key is a caption with a hole in it.
    assert.ok(![...keys].some(key => key.includes('\ufffd')), 'replacement character in the catalogue');
    const german = JSON.parse(readFileSync(new URL('../public/locales/neconyan/de-de.json', import.meta.url), 'utf8'));
    const slots = text => (text.match(/\$\{\d+\}/g) || []).sort();
    const entries = Object.entries(german);
    const panelCaptions = entries.slice(entries.findIndex(([key]) => key === 'Filter and organise'));
    assert.ok(panelCaptions.length > 70);
    for (const [key, value] of panelCaptions) {
        // A scoped key is a name, not the caption: its holes are those of its English text in the catalogue.
        if (key.startsWith('scoped.')) assert.equal(typeof english[key], 'string', `scoped key missing from the catalogue: ${key}`);
        const caption = key.startsWith('scoped.') ? english[key] : key;
        assert.deepEqual(slots(value), slots(caption), `changed placeholders: ${key}`);
    }
    for (const key of ['Test keys', 'Unfiled', 'All books', 'Pawspective', 'No automatic agents enabled', 'depth ${0}', 'Order ${0}', 'rewrites reply', 'Snapshot everything now']) {
        assert.ok(german[key] && german[key] !== key, `missing German panel caption: ${key}`);
    }
});

test('the catalogue can be written and listed without a translator, and one language can be selected', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'neconyan-catalogue-'));
    // A stand-in translator. It records every call in a trace file and answers each string with a marked
    // copy, so a call that should never happen leaves evidence and a call that should happen leaves a mark.
    const trace = join(scratch, 'translator-calls.log');
    const translator = join(scratch, 'translator.cjs');
    writeFileSync(translator, `
        const fs = require('node:fs');
        let input = '';
        process.stdin.on('data', chunk => { input += chunk; }).on('end', () => {
            const { language, strings } = JSON.parse(input);
            fs.appendFileSync(process.env.NECONYAN_TEST_TRACE, language + '\\n');
            process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(strings).map(([index, value]) => [index, value + ' [' + language + ']']))));
        });
    `);
    // The command goes through a shell on every platform, so the paths travel in the environment, unquoted.
    const env = {
        ...process.env,
        NECONYAN_TRANSLATION_COMMAND: `"${process.execPath}" -e "require(process.env.NECONYAN_TEST_TRANSLATOR)"`,
        NECONYAN_TEST_TRANSLATOR: translator,
        NECONYAN_TEST_TRACE: trace,
    };
    const calls = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n') : [];
    const supplements = join(scratch, 'public', 'locales', 'neconyan');
    const readSupplement = name => JSON.parse(readFileSync(join(supplements, name + '.json'), 'utf8'));
    try {
        // The builder reads public/ and default/ relative to its working directory. Copy only what it
        // reads: markup, scripts and dictionaries, minus the catalogue it is about to write.
        const wanted = source => /[\\/](lib|webfonts|img|sounds)$/.test(source) ? false
            : statSync(source).isDirectory() || (/\.(html|js|json)$/.test(source) && !/[\\/]locales[\\/]neconyan[\\/]en\.json$/.test(source));
        cpSync(join(root, 'public'), join(scratch, 'public'), { recursive: true, filter: wanted });
        cpSync(join(root, 'default', 'content', 'assistants', 'manifest.json'), join(scratch, 'default', 'content', 'assistants', 'manifest.json'));
        cpSync(join(root, 'default', 'content', 'errors', 'url-not-found.html'), join(scratch, 'default', 'content', 'errors', 'url-not-found.html'));
        const script = join(root, 'scripts', 'build-interface-locales.js');

        // --write-catalogue and --list never reach the translator.
        const written = spawnSync(process.execPath, [script, '--write-catalogue'], { cwd: scratch, encoding: 'utf8', env });
        assert.equal(written.status, 0, written.stderr);
        const catalogue = readSupplement('en');
        assert.ok(Object.keys(catalogue).length > 10000);
        assert.ok(!Object.values(catalogue).some(value => value.includes('�')), 'replacement character in a catalogue value');
        assert.ok(!existsSync(join(supplements, 'en.json.tmp')), 'temporary file left behind');
        const listed = spawnSync(process.execPath, [script, '--list'], { cwd: scratch, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
        assert.equal(listed.status, 0, listed.stderr);
        assert.deepEqual(JSON.parse(listed.stdout), Object.keys(catalogue).sort());
        assert.deepEqual(calls(), [], 'the translator was invoked by a catalogue-only run');

        // A bad language selection fails before any work, and without a command the builder only reports.
        const unknown = spawnSync(process.execPath, [script], { cwd: scratch, encoding: 'utf8', env: { ...env, NECONYAN_TRANSLATION_LANGS: 'pt-br' } });
        assert.notEqual(unknown.status, 0);
        assert.match(unknown.stderr, /Unknown language pt-br/);
        const empty = spawnSync(process.execPath, [script], { cwd: scratch, encoding: 'utf8', env: { ...env, NECONYAN_TRANSLATION_LANGS: ' , ' } });
        assert.notEqual(empty.status, 0);
        assert.match(empty.stderr, /names no language/);
        const report = spawnSync(process.execPath, [script], { cwd: scratch, encoding: 'utf8', env: { ...env, NECONYAN_TRANSLATION_COMMAND: '', NECONYAN_TRANSLATION_LANGS: 'pt-pt' } });
        assert.equal(report.status, 0, report.stderr);
        assert.deepEqual(JSON.parse(report.stdout).locales, ['pt-pt']);
        assert.deepEqual(calls(), [], 'the translator was invoked by a report-only run');

        // Selecting one language translates that supplement's missing keys and touches no other file.
        // Leave Portuguese exactly five keys short of the catalogue so a single batch covers them; a key
        // the base dictionary already translates does not count as missing, so take keys it lacks.
        const base = JSON.parse(readFileSync(join(scratch, 'public', 'locales', 'pt-pt.json'), 'utf8'));
        const missing = Object.keys(catalogue).filter(key => !Object.hasOwn(base, key)).slice(0, 5);
        assert.equal(missing.length, 5);
        const portuguese = Object.fromEntries(Object.entries(catalogue).filter(([key]) => !missing.includes(key)));
        writeFileSync(join(supplements, 'pt-pt.json'), JSON.stringify(portuguese, null, 2) + '\n');
        const before = Object.fromEntries(readdirSync(supplements).map(name => [name, readFileSync(join(supplements, name), 'utf8')]));
        const translated = spawnSync(process.execPath, [script], { cwd: scratch, encoding: 'utf8', env: { ...env, NECONYAN_TRANSLATION_LANGS: 'pt-pt' } });
        assert.equal(translated.status, 0, translated.stderr);
        assert.deepEqual(calls(), ['Português (Brasil)'], `expected exactly one translator call, for Portuguese\n${translated.stdout}${translated.stderr}`);
        const after = readSupplement('pt-pt');
        for (const key of missing) assert.equal(after[key], `${catalogue[key]} [Português (Brasil)]`, `untranslated: ${key}`);
        assert.equal(Object.keys(after).length, Object.keys(catalogue).length);
        for (const name of Object.keys(before)) {
            if (name === 'pt-pt.json') continue;
            assert.equal(readFileSync(join(supplements, name), 'utf8'), before[name], `${name} changed by a Portuguese-only run`);
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
});
