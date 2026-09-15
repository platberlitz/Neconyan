import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'yaml';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'neconyan-migration-'));
try {
    const settingsPath = path.join(temporary, 'settings.json');
    const configPath = path.join(temporary, 'config.yaml');
    const originalSettings = {
        power_user: {
            theme: 'Datastream - by platberlitz',
            main_text_color: 'rgba(200, 204, 200, 1)',
            custom_css: 'body { color: green; }',
            blur_strength: 4,
            sheldBlurStrength: 5,
            mobileSheldBlurStrength: 3,
            'customCSS-bg-blur': 2,
            'customCSS-bg-opacity': 0.6,
            sheldBackgroundColor: 'green',
            font_scale: 1.2,
            chat_width: 50,
        },
        extension_settings: { sillybunny_conversation: { messages: ['Keep this'] } },
        accountStorage: { persona: 'avatar.png' },
        tags: [{ id: 'tag', name: 'Keep this too' }],
    };
    const originalConfig = '# Keep this comment\nport: 4444\nperformance:\n  lazyLoadCharacters: false\n  useDiskCache: true\n';
    const originalText = JSON.stringify(originalSettings, null, 2);
    fs.writeFileSync(settingsPath, originalText, { mode: 0o600 });
    fs.writeFileSync(configPath, originalConfig, { mode: 0o600 });
    const run = () => spawnSync(process.execPath, [
        fileURLToPath(new URL('./migrate-sillybunny-settings.js', import.meta.url)), settingsPath, configPath,
    ], { encoding: 'utf8' });

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const migrated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const theme = JSON.parse(fs.readFileSync(new URL('../default/content/themes/Neconyan Calico Dark.json', import.meta.url), 'utf8'));
    assert.equal(migrated.power_user.theme, theme.name);
    assert.equal(migrated.power_user.main_text_color, theme.main_text_color);
    assert.equal(migrated.power_user.blur_tint_color, theme.blur_tint_color);
    assert.equal(migrated.power_user.custom_css, '');
    assert.equal(migrated.power_user.blur_strength, 0);
    assert.equal(migrated.power_user.sheldBlurStrength, 0);
    assert.equal(migrated.power_user.mobileSheldBlurStrength, 0);
    assert.equal(migrated.power_user['customCSS-bg-blur'], 0);
    assert.equal(migrated.power_user['customCSS-bg-opacity'], 1);
    assert.equal(migrated.power_user.sheldBackgroundColor, 'transparent');
    assert.equal(migrated.power_user.font_scale, 1.2);
    assert.equal(migrated.power_user.chat_width, 50);
    assert.deepEqual({ ...migrated, power_user: originalSettings.power_user }, originalSettings);
    const migratedConfigText = fs.readFileSync(configPath, 'utf8');
    assert.deepEqual(yaml.parse(migratedConfigText), {
        port: 4444, performance: { lazyLoadCharacters: true, useDiskCache: true },
    });
    assert.ok(migratedConfigText.includes('# Keep this comment'));
    const backup = path.join(temporary, 'backups', fs.readdirSync(path.join(temporary, 'backups'))[0]);
    assert.equal(fs.readFileSync(path.join(backup, 'settings.json'), 'utf8'), originalText);
    assert.equal(fs.readFileSync(path.join(backup, 'config.yaml'), 'utf8'), originalConfig);
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), migrated);
    assert.equal(fs.readFileSync(configPath, 'utf8'), migratedConfigText);
    assert.equal(fs.readdirSync(path.join(temporary, 'backups')).length, 2);

    fs.writeFileSync(configPath, 'performance: [invalid]\n');
    assert.notEqual(run().status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), migrated);
    assert.equal(fs.readFileSync(configPath, 'utf8'), 'performance: [invalid]\n');
    assert.equal(fs.readdirSync(path.join(temporary, 'backups')).length, 2);
    console.log('Migration check passed: appearance, preserved settings, backups, repeat runs and invalid input.');
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
