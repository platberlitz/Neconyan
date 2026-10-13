import fs from 'node:fs';
import { expect, jest, test } from '@jest/globals';
const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const text = source.slice(source.indexOf('function notifyCardScriptStripped('), source.indexOf('\n/**', source.indexOf('function notifyCardScriptStripped(')));

test('enabled scripts never show a blocked toast or consume its deduplication key', () => {
    const warning = jest.fn(); const mark = jest.fn();
    const run = new Function('power_user', 'toastr', 'markCardScriptToastShown', `${text}; return notifyCardScriptStripped;`)({ allow_card_scripts: true }, { warning }, mark);
    run(null, 1);
    expect(warning).not.toHaveBeenCalled(); expect(mark).not.toHaveBeenCalled();
});

test('disabled scripts show accurate setting guidance once, only with a marker and snapshot', () => {
    const warning = jest.fn(); const mark = jest.fn(); let shown = false; let hasMarker = true; let snapshot = { hash: 'hash' };
    const element = { jquery: true, length: 1, find: () => ({ filter: () => ({ first: () => ({ length: Number(hasMarker) }) }) }) };
    const run = new Function('power_user', 'toastr', 't', '$', 'CARD_SCRIPT_MARKER_TAG', 'getCardScriptSnapshot', 'buildCardScriptToastKey', 'getCurrentChatId', 'hasCardScriptToastBeenShown', 'markCardScriptToastShown', `${text}; return notifyCardScriptStripped;`)({ allow_card_scripts: false }, { warning }, strings => strings.join(''), x => x, 'custom-card-script-marker', () => snapshot, () => 'key', () => 'chat', () => shown, key => { mark(key); shown = true; });
    hasMarker = false; run(element, 1); expect(warning).not.toHaveBeenCalled();
    hasMarker = true; snapshot = null; run(element, 1); expect(warning).not.toHaveBeenCalled();
    snapshot = { hash: 'hash' }; run(element, 1); run(element, 1);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Enable \'Allow card scripts\' in Settings'), 'Card scripts are off', expect.anything());
});
