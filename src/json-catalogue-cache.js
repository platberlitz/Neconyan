import fs from 'node:fs';
import path from 'node:path';
import { getSettingsFileIdentity, sameSettingsFileIdentity } from './settings-file-cache.js';

/**
 * Read-only catalogue files are validated once per file identity. Text callers
 * keep the original formatting; object callers receive a private copy. Directory
 * listings are never cached, so additions and deletions appear on the next read.
 * The byte budget counts the source twice for the text and parsed representations;
 * it bounds retained source bytes, not the JavaScript heap size.
 * @param {{maxBytes?: number, maxEntries?: number}} [options]
 */
export function createJsonCatalogueCache({ maxBytes = 32 * 1024 * 1024, maxEntries = 1024 } = {}) {
    const entries = new Map();
    let bytes = 0;
    function remove(key) {
        const entry = entries.get(key);
        if (!entry) return;
        entries.delete(key);
        bytes -= entry.bytes;
    }

    return {
        /**
         * @param {string} filePath
         * @param {boolean} [parsed] Return parsed JSON rather than validated text.
         * @returns {any}
         */
        read(filePath, parsed = false) {
            const key = path.resolve(filePath);
            let entry;
            try {
                const identity = getSettingsFileIdentity(key);
                entry = entries.get(key);
                if (entry && sameSettingsFileIdentity(entry.identity, identity)) {
                    entries.delete(key);
                    entries.set(key, entry);
                } else {
                    remove(key);
                    const text = fs.readFileSync(key, 'utf8');
                    entry = { text, data: JSON.parse(text), identity, bytes: Buffer.byteLength(text) * 2 };
                    // A concurrent edit must not stamp old text with a new identity.
                    const current = getSettingsFileIdentity(key);
                    if (sameSettingsFileIdentity(identity, current) && entry.bytes <= maxBytes && maxEntries > 0) {
                        entries.set(key, entry);
                        bytes += entry.bytes;
                        while (bytes > maxBytes || entries.size > maxEntries) remove(entries.keys().next().value);
                    }
                }
            } catch (error) {
                remove(key);
                throw error;
            }
            return parsed ? structuredClone(entry.data) : entry.text;
        },
    };
}
