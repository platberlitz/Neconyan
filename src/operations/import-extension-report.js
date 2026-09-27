import fs from 'node:fs';
import path from 'node:path';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { isNativeExtension } from '../neconyan-native-extensions.js';
import { readRoleplayFile, roleplayHash } from '../roleplay-store.js';
import { operationError } from './store.js';

/** Inspect the same frozen source files that the native import will publish. */
export function captureExtensionReport(base, captured) {
    const prefix = USER_DIRECTORY_TEMPLATE.extensions;
    const selected = new Set(captured.files.map(file => file.relative));
    const names = [...new Set(captured.files.map(file => file.relative.split('/')).filter(parts => parts[0] === prefix && parts.length > 2).map(parts => parts[1]))];
    const results = names.map(name => {
        const folder = `${prefix}/${name}`;
        const sourcePath = path.join(captured.sourceRoot, folder);
        const targetPath = path.join(base.directories.root, folder);
        const source = captured.files.find(file => file.relative === `${folder}/manifest.json`);
        const shadowedByNative = isNativeExtension(name);
        const checks = { manifestFound: !!source, manifestValid: false, jsEntry: '', jsEntryExists: false,
            gitMetadataSkipped: fs.existsSync(path.join(sourcePath, '.git')), shadowedByNative };
        const result = { name, displayName: name, version: '', author: '', sourcePath, targetPath, shadowedByNative,
            copiedFiles: captured.files.filter(file => file.relative.startsWith(folder + '/')).length, warnings: [], checks };
        if (!source) result.warnings.push('Missing manifest.json. Neconyan cannot discover this extension until it is restored.');
        else {
            const file = readRoleplayFile(source.filename, 1024 * 1024);
            if (!file || roleplayHash({ rawHash: file.rawHash, physical: file.physical }) !== roleplayHash(source.evidence)) throw operationError('An extension manifest changed during import preparation.');
            let manifest;
            try { manifest = JSON.parse(file.bytes); } catch (error) { result.warnings.push(`manifest.json could not be parsed: ${error.message}`); }
            if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
                checks.manifestValid = true;
                result.displayName = typeof manifest.display_name === 'string' && manifest.display_name.trim() ? manifest.display_name.trim() : name;
                result.version = typeof manifest.version === 'string' ? manifest.version : '';
                result.author = typeof manifest.author === 'string' ? manifest.author : '';
                checks.jsEntry = typeof manifest.js === 'string' ? manifest.js.trim() : '';
                const entry = path.posix.normalize(folder + '/' + checks.jsEntry);
                checks.jsEntryExists = !!checks.jsEntry && entry.startsWith(folder + '/') && selected.has(entry);
                if (!checks.jsEntry) result.warnings.push('manifest.json is missing a JavaScript entry, so this extension may not load.');
                else if (!checks.jsEntryExists) result.warnings.push(`The manifest JavaScript entry '${checks.jsEntry}' could not be found in the imported files.`);
            } else if (!result.warnings.length) result.warnings.push('manifest.json must contain an extension object.');
        }
        result.status = shadowedByNative ? 'shadowed' : result.warnings.length ? 'warning' : 'ready';
        return result;
    });
    const readyCount = results.filter(result => result.status === 'ready').length;
    const warningCount = results.filter(result => result.status === 'warning').length;
    const shadowedCount = results.filter(result => result.status === 'shadowed').length;
    return { results, readyCount, warningCount, shadowedCount, failedCount: 0, syncedCount: readyCount + warningCount,
        gitMetadataSkippedCount: results.filter(result => result.checks.gitMetadataSkipped).length,
        message: `Saved ${results.length} extension folders. Review the retained report before reloading.` };
}
