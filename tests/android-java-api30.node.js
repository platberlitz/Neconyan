import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = new URL('../android/app/src/main/java/', import.meta.url);
function sources(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? sources(file) : entry.name.endsWith('.java') ? [file] : [];
    });
}
test('all Android Java avoids Java library methods absent from API 30', () => {
    const forbidden = /\b(?:readString|writeString|readNBytes)\s*\(|\.\s*(?:readAllBytes\s*\(\s*\)|repeat\s*\(|toList\s*\(|strip(?:Leading|Trailing|Indent)?\s*\(|isBlank\s*\(|lines\s*\()/;
    for (const file of sources(fs.realpathSync(root))) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), forbidden, file);
});

test('diagnostic scheduling cannot leave pending or reader state stuck on a platform error', () => {
    const app = new URL('io/github/platberlitz/neconyan/', root);
    const activity = fs.readFileSync(new URL('ActivityBreadcrumbs.java', app), 'utf8');
    const main = fs.readFileSync(new URL('MainActivity.java', app), 'utf8');
    assert.match(activity, /finally \{[\s\S]*pending = false/);
    assert.match(activity, /catch \(Throwable ignored\)/);
    assert.doesNotMatch(main, /ActivityBreadcrumbs\.WRITER\.execute/);
    assert.match(main, /\}, \(\) -> readingCrashes\.set\(false\)\)/);
    assert.match(activity, /name\.startsWith\("pending-"\)[\s\S]*60000/);
});
