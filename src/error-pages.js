import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { serverDirectory } from './server-directory.js';
import { setPermissionsSync } from './util.js';
import { chooseRequestLocale, getPageTranslations, renderPageTemplate } from './page-translations.js';
import { templateKeys } from '../public/scripts/page-locale.js';

/**
 * The error pages Neconyan manages: which ones exist, which bytes earlier versions shipped, how a page is created or
 * updated in the data folder, where each page is read from, and how a blocked request is answered.
 * default/content/errors is the only shipped copy of every page.
 */

export const HTTPS_REQUIRED_MESSAGE = 'This connection is not secure, so Neconyan cannot be opened from another computer yet. Ask the person running Neconyan to turn on HTTPS (the secure, padlock address) in config.yaml, then reload.';

export const MANAGED_ERROR_PAGES = Object.freeze([
    'forbidden-by-whitelist.html',
    'host-not-allowed.html',
    'https-required.html',
    'invalid-csrf.html',
    'url-not-found.html',
]);

/**
 * sha256 of every version of a managed page that Neconyan or SillyTavern shipped, in the LF form and the CRLF form
 * (a checkout on Windows can hold CRLF copies). The LF form is the exact bytes with every CRLF replaced by LF; the
 * CRLF form is the LF form with every LF replaced by CRLF; nothing else is changed before hashing. A copy in the data
 * folder whose exact bytes are in this list is an unchanged old default and is replaced by the current page; any
 * other copy is the administrator's and is kept. tests/error-pages.node.js fails when a page in
 * default/content/errors has no entry for its current bytes; add the hashes of the new bytes under a new comment.
 */
export const SHIPPED_ERROR_PAGE_HASHES = Object.freeze({
    'forbidden-by-whitelist.html': Object.freeze([
        // 70ff71852b: SillyTavern, SillyBunny, Neconyan, Necodev (both folders), 2025-01-25 to 2026-10-11
        'fb177a81be2d7d7648fd5fa9df0a9d8b70cd8cd2e53fc69719de0918493cb5a0',
        '123b84855ce2104be082c58438641532a92b71fb17848ac828000c1b88f0ede0',
        // 8a0722beee: Neconyan, Necodev (both folders), 2026-10-12, error-message pass (#138)
        '3cf4f89d0448c48897062e736ead115352c04350ec2c97c77cf82b37d451b327',
        'e6c23ded13b70e2b60766f85be46a1ae2c3ab21dadb2fa07e3247a2aeec06a0b',
        // d858ef2eef: translated page, this change (the pages in default/content/errors when C5 was built)
        'fab2e63f76d9e75aa313b3fc4190bd3a2e7edee410d06580c80c7f0069f8f3ff',
        'a1655309b6899da81b720b64250f1ce16697efdbde6827edbb74c6855fa6b3d0',
    ]),
    'host-not-allowed.html': Object.freeze([
        // 19ec5e990b: SillyTavern, SillyBunny, Neconyan, Necodev (both folders), 2025-09-04 to 2026-10-11
        '01a8748f57751cceb2af35c4568734707fc2bd290d038b03dd6b73773cd16db5',
        'abe2288467514e97897ea10981116f55cc23050f88be797b7f5b808b4370b0eb',
        // 06a5cedc65: Neconyan, Necodev (both folders), 2026-10-12, error-message pass (#138)
        '2e70f9de45d1deaa58129f39304a1cc2c4a56b6254b2938cbf54452c3dc0e8d9',
        'f42c1feee224c6c82e80cb307766871dad3fbbbb01a04e04c607744daa678318',
        // 2d021e9a90: translated page, this change
        '66ed8683edcb1faf35dda8d403cb3cf50ee62972e88fd49ed41d1b44b4851f33',
        'd2d12b267b2873e47e77804f40c5ba2ec6ad0ccbdfd6c9ee7c4f4af9059908ad',
    ]),
    'https-required.html': Object.freeze([
        // af9b01869e: new in this change (there is no earlier version)
        '335a16d447246b2419ec315245697ad89bb520a9b5a2a5d8804282f1994c9854',
        '7fa300ebfb3996ba1695b051e40c5ad1ae7cba6d2db9ae1b4f3ee0e808a94b77',
    ]),
    'invalid-csrf.html': Object.freeze([
        // f72eb8cf14: Neconyan, Necodev (both folders), 2026-09-15 to 2026-10-11
        'f12a673046b026ff038a1a03131602fd565b3e35c8ec4564bd57652a0101ae86',
        '88c3239a0c066a93894af0ef19c19a6734504ff35d89aad13a229d3c898c462c',
        // a96a8cdba9: Neconyan, Necodev (both folders), 2026-10-12, error-message pass (#138)
        '3743f4eb12d6459fe808d66a607fdfcbe62f058aa03ad7e705b232119bcde525',
        '40d1b7243cadee2f0dcd64254a6198205c1b9ba42c06325944c65bc6ceb3f86a',
        // 56ea4ecd4c: translated page, this change
        '5165f89ab8052069cf2ed257649c3484ac1812d39b793281ab034cba878ddf92',
        '1d14234fb7df227d8fc91700bdb0acbceaf6eb675f3d1a79e690f9ffde37b427',
    ]),
    'url-not-found.html': Object.freeze([
        // 87974145f7: SillyTavern, SillyBunny, Neconyan, Necodev (default/public/error), 2025-01-25 to 2026-10-11
        '2fe1a07c6871f156112a415625ef15955cab8c8b9b320285c6beb9fa6017e1d7',
        'f6f27bd40fb4812c8d7156256e334a3f3481aae574dcad7b72f18339906a40e7',
        // 9c881dfc21: SillyTavern, SillyBunny, Neconyan, Necodev (default/content/errors), 2026-04-05 to 2026-10-11
        '5b142e6d20753118256ddf86c40095aaedf09f64619af7613fb2b77b9174ce1c',
        '3c9c01243df0eb3beaa4cd0b55c8b1caa30b54fd30348bca1e8452f91a101cbe',
        // 2c1fbbb301: Neconyan, Necodev (default/content/errors), 2026-10-12, error-message pass (#138), title 'Not Found'
        '96c6be93236da2fecae436275bb11044600f122458e5ea1bafe9fc2cec094d2f',
        '90d8bce09439c41480a07a565b68fb399f1a1af7f065fb6da542b60b5115eb28',
        // c331cd018e: Neconyan, Necodev (default/public/error), 2026-10-12, error-message pass (#138), title 'Not found'
        '7f28c4caef0586e2eca4b242985607ee4811f94fe9469c65c91e088504b9b3de',
        'be2fa9f2bc98d17ca82bc88183366e6ff586f67505496225a059a196769b67d2',
        // d60dd8aa7a: translated page, this change
        '941effef573c82dc463440d1e4e63a990f86910602b9ef0dc3e83624c3434053',
        '96cc599c25014557b5543b376b51b56247296cc40dc563996d72826966ceedc4',
    ]),
});

const NOT_FOUND_PAGE = 'url-not-found.html';
const TRANSLATED_PAGE_PATTERN = /\{\{\s*t\s/;

/** @type {Set<string>} */
const reportedMissingPages = new Set();

/**
 * @typedef {object} PageLocations
 * @property {string} [dataRoot] The data folder (default: the server's data folder)
 * @property {string} [shippedRoot] Where the shipped pages are (default: default/content/errors)
 * @property {string} [publicErrorRoot] Where older versions kept copies (default: public/error)
 * @property {string} [localesRoot] Where the dictionaries are (default: public/locales)
 * @property {{ info: Function, warn: Function, error: Function }} [log] Where start-up messages go (default: console)
 */

function shippedRootOf(shippedRoot) {
    return shippedRoot ?? path.join(serverDirectory, 'default', 'content', 'errors');
}

function dataErrorsRootOf(dataRoot) {
    return path.join(dataRoot ?? globalThis.DATA_ROOT, '_errors');
}

function publicErrorRootOf(publicErrorRoot) {
    return publicErrorRoot ?? path.join(serverDirectory, 'public', 'error');
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Reads a file when it holds at least one byte (a symbolic link is followed).
 * @param {string} file Path
 * @returns {Buffer|null} Bytes, or null when the file is missing, a folder, unreadable or empty
 */
function readUsableFile(file) {
    try {
        const bytes = fs.readFileSync(file);
        return bytes.length > 0 ? bytes : null;
    } catch {
        return null;
    }
}

function reasonOf(error) {
    return error?.code ?? error?.message ?? String(error);
}

/**
 * Creates and updates the managed pages in the data folder, once per start. A missing or empty page is created; a page
 * whose exact bytes match a version Neconyan or SillyTavern shipped is replaced with the current page; anything else
 * is the administrator's page and is kept byte for byte. Synchronous, and never throws.
 * @param {PageLocations} [locations] Folders and log (defaults for the real server)
 */
export function syncErrorPages({ dataRoot, shippedRoot, publicErrorRoot, log = console } = {}) {
    try {
        const errorsRoot = dataErrorsRootOf(dataRoot);
        const shippedFolder = shippedRootOf(shippedRoot);
        let folderReady = false;
        for (const name of MANAGED_ERROR_PAGES) {
            const shipped = readShippedPage(shippedFolder, name, log);
            if (!shipped) continue;
            if (!folderReady) {
                try {
                    fs.mkdirSync(errorsRoot, { recursive: true });
                    folderReady = true;
                } catch (error) {
                    log.error(`Could not create the folder _errors (${reasonOf(error)}); the error pages shipped with Neconyan are served.`);
                    return;
                }
            }
            syncOnePage(name, shipped, errorsRoot, log);
        }
        warnAboutCustomNotFoundPage(publicErrorRootOf(publicErrorRoot), shippedFolder, log);
    } catch (error) {
        log.error(`Could not check the error pages: ${error?.message ?? error}`);
    }
}

function readShippedPage(shippedFolder, name, log) {
    const file = path.join(shippedFolder, name);
    try {
        const bytes = fs.readFileSync(file);
        if (bytes.length > 0) return bytes;
        log.error(`Could not read the shipped error page default/content/errors/${name} (empty); _errors/${name} is left as it is.`);
    } catch (error) {
        log.error(`Could not read the shipped error page default/content/errors/${name} (${reasonOf(error)}); _errors/${name} is left as it is.`);
    }
    return null;
}

function writePage(file, shipped) {
    writeFileAtomicSync(file, shipped);
    setPermissionsSync(file);
}

function syncOnePage(name, shipped, errorsRoot, log) {
    const file = path.join(errorsRoot, name);
    let stats;
    try {
        stats = fs.lstatSync(file);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            log.warn(`Could not read _errors/${name} (${reasonOf(error)}); the page shipped with Neconyan is served instead.`);
            return;
        }
        writeCreated(file, name, shipped, log, '');
        return;
    }
    if (!stats.isFile()) {
        log.warn(`Kept _errors/${name}: it is not a plain file, so it is not updated.`);
        return;
    }
    if (stats.size === 0) {
        writeCreated(file, name, shipped, log, ' (it was empty)');
        return;
    }
    let current;
    try {
        current = fs.readFileSync(file);
    } catch (error) {
        log.warn(`Could not read _errors/${name} (${reasonOf(error)}); the page shipped with Neconyan is served instead.`);
        return;
    }
    const hash = sha256(current);
    if (hash === sha256(shipped)) return;
    if (SHIPPED_ERROR_PAGE_HASHES[name].includes(hash)) {
        try {
            writePage(file, shipped);
            log.info(`Updated _errors/${name} to the current version (it was an unchanged copy of an earlier version).`);
        } catch (error) {
            log.error(`Could not update _errors/${name}: ${reasonOf(error)}. The page shipped with Neconyan is served until it can be written.`);
        }
        return;
    }
    log.warn(`Kept your own _errors/${name}; it is not updated or translated. Delete it and restart to get the current page.`);
}

function writeCreated(file, name, shipped, log, note) {
    try {
        writePage(file, shipped);
        log.info(`Created the error page _errors/${name}${note}.`);
    } catch (error) {
        log.error(`Could not update _errors/${name}: ${reasonOf(error)}. The page shipped with Neconyan is served until it can be written.`);
    }
}

/**
 * An administrator's public/error/url-not-found.html: readable, and neither a version shipped earlier nor the current page.
 * @param {Buffer|null} bytes Contents of the file
 * @param {Buffer|null} currentBytes Contents of the current shipped page
 * @returns {boolean} True when the page is the administrator's own
 */
function isCustomPage(bytes, currentBytes) {
    if (!bytes) return false;
    const hash = sha256(bytes);
    return !SHIPPED_ERROR_PAGE_HASHES[NOT_FOUND_PAGE].includes(hash) && !(currentBytes && hash === sha256(currentBytes));
}

function warnAboutCustomNotFoundPage(publicErrorFolder, shippedFolder, log) {
    const file = path.join(publicErrorFolder, NOT_FOUND_PAGE);
    try {
        if (!fs.statSync(file).isFile()) return;
    } catch {
        return;
    }
    if (isCustomPage(readUsableFile(file), readUsableFile(path.join(shippedFolder, NOT_FOUND_PAGE)))) {
        log.warn('Missing pages use your own public/error/url-not-found.html; _errors/url-not-found.html is not used while it exists.');
    }
}

/**
 * Reads a managed page: the data folder's copy when it can be read, else the shipped copy.
 * A missing file, a folder, an unreadable file and an empty file all count as 'cannot be read'.
 * @param {string} name Page file name
 * @param {PageLocations} [locations] Folders (defaults for the real server)
 * @returns {string|null} The page, or null when no copy can be read (reported once per page)
 */
export function readErrorPage(name, { dataRoot, shippedRoot } = {}) {
    const errorsRoot = dataErrorsRootOf(dataRoot);
    const shippedFolder = shippedRootOf(shippedRoot);
    const bytes = readUsableFile(path.join(errorsRoot, name)) ?? readUsableFile(path.join(shippedFolder, name));
    if (bytes) return bytes.toString('utf8');
    const reportKey = `${errorsRoot}\n${shippedFolder}\n${name}`;
    if (!reportedMissingPages.has(reportKey)) {
        reportedMissingPages.add(reportKey);
        console.error(`No copy of the error page ${name} could be read; a plain answer is sent instead.`);
    }
    return null;
}

/**
 * Reads the 404 page: an administrator's own public/error/url-not-found.html (never a copy of a shipped version),
 * else the managed page.
 * @param {PageLocations} [locations] Folders (defaults for the real server)
 * @returns {string|null} The page, or null when no copy can be read
 */
export function readNotFoundPage({ dataRoot, shippedRoot, publicErrorRoot } = {}) {
    const custom = readUsableFile(path.join(publicErrorRootOf(publicErrorRoot), NOT_FOUND_PAGE));
    if (custom && isCustomPage(custom, readUsableFile(path.join(shippedRootOf(shippedRoot), NOT_FOUND_PAGE)))) {
        return custom.toString('utf8');
    }
    return readErrorPage(NOT_FOUND_PAGE, { dataRoot, shippedRoot });
}

/**
 * Tells a browser page load from an API request: the path is not under /api and the client accepts HTML.
 * Fetch Metadata is not used, because a browser on a plain-HTTP address on the local network does not send it.
 * @param {import('express').Request} request Request
 * @returns {boolean} True for a page load
 */
export function isPageLoad(request) {
    const requestPath = String(request?.path ?? '');
    if (requestPath === '/api' || requestPath.startsWith('/api/')) return false;
    return String(request?.headers?.accept ?? '').includes('text/html');
}

function sendPlainForbidden(response) {
    if (response.headersSent) return;
    response.status(403).set('Content-Type', 'text/plain; charset=utf-8').send('Forbidden');
}

function sendTranslatedPage(response, html, locale, vary) {
    response.status(403).type('html').vary(vary).set({ 'Content-Language': locale, 'Cache-Control': 'no-store' }).send(html);
}

/**
 * Answers a blocked request with one of the managed pages (403). A page that uses {{t}} is rendered in the language of
 * Accept-Language; an administrator's older page is sent as before. When no copy can be read, or rendering fails, the
 * answer is a plain-text 403. The promise never rejects.
 * @param {import('express').Request} request Request
 * @param {import('express').Response} response Response
 * @param {string} name Page file name
 * @param {object} context Values for the template
 * @param {PageLocations} [locations] Folders (defaults for the real server)
 * @returns {Promise<void>}
 */
export async function sendBlockedPage(request, response, name, context, { dataRoot, shippedRoot, localesRoot } = {}) {
    try {
        const source = readErrorPage(name, { dataRoot, shippedRoot });
        if (source === null) return sendPlainForbidden(response);
        if (!TRANSLATED_PAGE_PATTERN.test(source)) {
            if (name === 'forbidden-by-whitelist.html') {
                response.status(403).send(Handlebars.compile(source)(context));
            } else {
                response.writeHead(403, { 'Content-Type': 'text/html' });
                response.end(source);
            }
            return;
        }
        const locale = chooseRequestLocale(request, { localesRoot });
        const translations = await getPageTranslations(locale, templateKeys(source), { localesRoot });
        sendTranslatedPage(response, renderPageTemplate(source, { locale, translations, context }), locale, 'Accept-Language');
    } catch (error) {
        console.error(`Could not render the error page ${name}:`, error);
        sendPlainForbidden(response);
    }
}

function sendHttpsRequiredJson(response) {
    response.vary('Accept');
    response.status(403).json({ error: HTTPS_REQUIRED_MESSAGE });
}

/**
 * Answers a request refused because it is not secure (403): an HTML page for a browser page load, in the language of
 * Accept-Language, and today's JSON for every other request. The promise never rejects.
 * @param {import('express').Request} request Request
 * @param {import('express').Response} response Response
 * @param {PageLocations} [locations] Folders (defaults for the real server)
 * @returns {Promise<void>}
 */
export async function sendHttpsRequired(request, response, { dataRoot, shippedRoot, localesRoot } = {}) {
    try {
        if (!isPageLoad(request)) return sendHttpsRequiredJson(response);
        const source = readErrorPage('https-required.html', { dataRoot, shippedRoot });
        if (source === null) return sendHttpsRequiredJson(response);
        let locale = 'en';
        let html;
        try {
            locale = chooseRequestLocale(request, { localesRoot });
            const translations = await getPageTranslations(locale, templateKeys(source), { localesRoot });
            html = renderPageTemplate(source, { locale, translations, context: {} });
        } catch (error) {
            console.error('Could not translate the HTTPS error page:', error);
            locale = 'en';
            html = renderPageTemplate(source, { locale, translations: new Map(), context: {} });
        }
        sendTranslatedPage(response, html, locale, 'Accept, Accept-Language');
    } catch (error) {
        console.error('Could not render the HTTPS error page:', error);
        if (!response.headersSent) sendHttpsRequiredJson(response);
    }
}
