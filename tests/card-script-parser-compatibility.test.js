import { expect, jest, test } from '@jest/globals';
import { createDefaultPolicy, parseSlashCommandRequest, POLICY_MODES } from '../public/scripts/card-script-sandbox/allowlist.js';
jest.unstable_mockModule('../public/script.js', () => ({ substituteParams: text => text }));
jest.unstable_mockModule('../public/lib.js', () => ({ hljs: { registerLanguage: jest.fn() } }));
const { SlashCommandParser } = await import('../public/scripts/slash-commands/SlashCommandParser.js');
const { setSlashCommandParserSettingsGetter } = await import('../public/scripts/slash-commands/SlashCommandParserConfig.js');
const policy = createDefaultPolicy({ mode: POLICY_MODES.ALLOWLIST });
const { SlashCommand } = await import('../public/scripts/slash-commands/SlashCommand.js');
for (const name of ['getchatname', 'audioselect', 'audiomode', 'audioplay', 'send']) SlashCommandParser.addCommand(name, jest.fn(), [], 'Test');
SlashCommandParser.addCommandObject(SlashCommand.fromProps({ name: 'echo', rawQuotes: true, callback: jest.fn(), helpString: 'Test' }));

test.each([true, false])('fixed strict escaping agrees with the full parser despite account preference %s', preference => {
    setSlashCommandParserSettingsGetter(() => ({ flags: { 1: preference, 2: true } }));
    for (const raw of ['/echo title="a|b" hi | /getchatname', '/echo a\\|b | /getchatname', '/audioselect name="a\\"|b" bell | /getchatname', '/echo a\\\\|/getchatname', '/audioselect voice=bell | /audiomode narrator | /audioplay', '/echo title="Card status" timeout=5000 hello', '/echo she said "hi" | /getchatname']) {
        const checked = parseSlashCommandRequest(raw, policy);
        expect(checked.ok).toBe(true);
        const tree = new SlashCommandParser().parse(checked.command, true, { 1: true, 2: false });
        expect(tree.executorList.map(item => '/' + item.name)).toEqual(checked.commands.map(command => command.match(/^\/\w+/)[0]));
        expect(tree.executorList.every(item => item.namedArgumentList.every(arg => typeof arg.value === 'string') && item.unnamedArgumentList.every(arg => typeof arg.value === 'string'))).toBe(true);
        for (const item of tree.executorList.filter(item => item.name === 'echo')) expect(item.namedArgumentList.some(arg => ['onClick', 'escapeHtml', 'raw', 'cssClass'].includes(arg.name))).toBe(false);
    }
});

test('no accepted request makes the full parser run a command the allowlist did not see', () => {
    setSlashCommandParserSettingsGetter(() => ({ flags: { 1: true, 2: false } }));
    const inputs = ['/echo a"b | /send x"', '/echo "a|/send b"', '/echo "a|b" | /getchatname', '/getchatname x"y | /send z"', '/echo title="t" a"|/send b"', '/audioplay foo=a"b | /send c"', '/audioselect "a | /send b"', '/audiomode x \\\\"|/send y"', '/echo title="a" b"c|/send d"'];
    for (const raw of inputs) {
        const checked = parseSlashCommandRequest(raw, policy);
        if (!checked.ok) continue;
        const safe = checked.commands.map(command => command.replace(/^\/echo(?: |$)/, '/echo escapeHtml=true ')).join('|');
        const names = new SlashCommandParser().parse(safe, true, { 1: true, 2: false }).executorList.map(item => '/' + item.name);
        expect(names).toEqual(checked.commands.map(command => command.match(/^\/\w+/)[0]));
    }
    expect(inputs.every(raw => !parseSlashCommandRequest(raw, policy).ok)).toBe(true);
});
