import fs from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';
import writeFileAtomic from 'write-file-atomic';

// Stop Neconyan before running this against the destination copy of SB's data.
// ponytail: explicit offline migration; reuse the bundled palette and atomic writer.
if (process.argv.length !== 4) {
    throw new Error('Usage: node scripts/migrate-sillybunny-settings.js <settings.json> <config.yaml>');
}

const [settingsPath, configPath] = process.argv.slice(2).map(file => path.resolve(file));
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const config = yaml.parseDocument(fs.readFileSync(configPath, 'utf8'));
if (!settings?.power_user || typeof settings.power_user !== 'object' || Array.isArray(settings.power_user)) {
    throw new Error('Expected a settings object with power_user settings');
}
if (config.errors.length || !yaml.isMap(config.contents)
    || (config.has('performance') && !yaml.isMap(config.get('performance', true)))) {
    throw new Error('Expected a valid configuration with a performance mapping');
}

const theme = JSON.parse(fs.readFileSync(new URL('../default/content/themes/Neconyan Calico Dark.json', import.meta.url), 'utf8'));
const appearanceKeys = [
    'main_text_color', 'italics_text_color', 'underline_text_color', 'quote_text_color',
    'blur_tint_color', 'chat_tint_color', 'user_mes_blur_tint_color', 'bot_mes_blur_tint_color',
    'shadow_color', 'border_color', 'blur_strength', 'shadow_width', 'custom_css',
];
Object.assign(settings.power_user, Object.fromEntries(appearanceKeys.map(key => [key, theme[key]])), {
    theme: theme.name,
    'customCSS-bg-blur': 0,
    'customCSS-bg-opacity': 1,
    sheldBlurStrength: 0,
    mobileSheldBlurStrength: 0,
    sheldBackgroundColor: 'transparent',
});
config.setIn(['performance', 'lazyLoadCharacters'], true);

const updates = [
    [settingsPath, 'settings.json', JSON.stringify(settings, null, 4) + '\n'],
    [configPath, 'config.yaml', config.toString()],
];
const backupsRoot = path.join(path.dirname(configPath), 'backups');
fs.mkdirSync(backupsRoot, { recursive: true, mode: 0o700 });
const backupDirectory = fs.mkdtempSync(path.join(backupsRoot, 'sb-migration-'));
for (const [file, name] of updates) {
    fs.copyFileSync(file, path.join(backupDirectory, name), fs.constants.COPYFILE_EXCL);
}
console.log(`Backups: ${backupDirectory}`);
for (const [file, , content] of updates) {
    writeFileAtomic.sync(file, content, { mode: fs.statSync(file).mode & 0o777 });
}
console.log('Applied Neconyan Calico Dark and on-demand character loading.');
