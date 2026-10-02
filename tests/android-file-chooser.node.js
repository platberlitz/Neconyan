import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../android/app/src/main/java/io/github/platberlitz/neconyan/MainActivity.java', import.meta.url), 'utf8');

function block(start, end) {
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `missing ${start}`);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(to, -1, `missing ${end} after ${start}`);
    return source.slice(from, to);
}

test('file inputs with multiple ask the Android picker for several files', () => {
    const chooser = block('public boolean onShowFileChooser', 'return true;');
    assert.match(chooser, /params\.getMode\(\) == FileChooserParams\.MODE_OPEN_MULTIPLE\) intent\.putExtra\(Intent\.EXTRA_ALLOW_MULTIPLE, true\)/);
});

test('every picked file reaches the page, not only a single getData() result', () => {
    const result = block('public void onActivityResult', 'if (code == 13');
    assert.match(result, /chooser\.onReceiveValue\(chosenFiles\(result, data\)\)/);
    assert.doesNotMatch(result, /chooser\.onReceiveValue\(WebChromeClient\.FileChooserParams\.parseResult/);

    const chosen = block('private static Uri[] chosenFiles', 'public void onActivityResult');
    assert.match(chosen, /data\.getClipData\(\)/);
    assert.match(chosen, /clip\.getItemAt\(i\)\.getUri\(\)/);
    assert.ok(chosen.indexOf('getClipData') < chosen.indexOf('parseResult'), 'ClipData must be read before the single-file fallback');
});
