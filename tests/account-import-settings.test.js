import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const functions = ['saveSettings', 'pauseSettingsForAccountImport'].map(name =>
    source.match(new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`))[0].replace('export ', '')).join('\n');

function fixture() {
    const context = {
        getCurrentUserHandle: () => 'alice', settingsSaveQueue: Promise.resolve(), pendingSettingsAcknowledgements: 0,
        accountImportSettingsPause: null, acknowledgedGenerationSettings: { saved: true },
        saveSettingsInner: jest.fn(async () => true), saveSettingsDebounced: jest.fn(), cancelDebounce: jest.fn(),
    };
    runInNewContext(functions, context);
    return context;
}

test('the import drains earlier saves, flushes once and blocks later direct and delayed saves until reload', async () => {
    const f = fixture();
    let release;
    f.saveSettingsInner.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const earlier = f.saveSettings();
    await Promise.resolve();
    const pausing = f.pauseSettingsForAccountImport();
    expect(await f.saveSettings(0, { returnResult: true })).toBe(false);
    expect(await f.saveSettings()).toBeUndefined();
    expect(f.saveSettingsInner).toHaveBeenCalledTimes(1);
    release(true);
    await earlier;
    const resume = await pausing;
    expect(f.saveSettingsInner).toHaveBeenCalledTimes(2);
    expect(f.cancelDebounce).toHaveBeenCalledWith(f.saveSettingsDebounced);
    expect(f.acknowledgedGenerationSettings).toBeNull();
    expect(await f.saveSettings(0, { returnResult: true })).toBe(false);
    expect(await f.pauseSettingsForAccountImport({ flush: false })).toBe(resume);
    expect(f.saveSettingsInner).toHaveBeenCalledTimes(2);
    await expect(f.pauseSettingsForAccountImport()).rejects.toThrow('Reload');
    resume(); resume();
    expect(f.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    expect(await f.saveSettings(0, { returnResult: true })).toBe(true);
});

test('observing a retained import pauses without writing over its captured settings', async () => {
    const f = fixture();
    await f.pauseSettingsForAccountImport({ flush: false });
    expect(await f.saveSettings(0, { returnResult: true })).toBe(false);
    expect(f.saveSettingsInner).not.toHaveBeenCalled();
});

test('a refused final save releases the pause so settings can be saved normally', async () => {
    const f = fixture();
    f.saveSettingsInner.mockResolvedValueOnce(false);
    await expect(f.pauseSettingsForAccountImport()).rejects.toThrow('Save the current settings');
    expect(await f.saveSettings(0, { returnResult: true })).toBe(true);
});

test('a pause never schedules the old account settings on a different account', async () => {
    const f = fixture();
    const resume = await f.pauseSettingsForAccountImport();
    await f.saveSettings();
    f.getCurrentUserHandle = () => 'bob';
    expect(await f.saveSettings(0, { returnResult: true })).toBe(true);
    resume();
    expect(f.saveSettingsDebounced).not.toHaveBeenCalled();
});
