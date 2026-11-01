/**
 * Browser authentication policy.
 *
 * Browsers never see an HTTP Basic popup: they sign in on the dedicated login
 * page and are authenticated by an opaque, signed, HTTP-only session cookie
 * whose hashed token is stored on the server. HTTP Basic and Bearer credentials
 * are still accepted for non-browser clients (API clients, health checks),
 * which cannot render the popup anyway.
 *
 * Unauthenticated requests are answered with a redirect to /login for page
 * navigations and a plain JSON 401 (no WWW-Authenticate challenge) otherwise.
 */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getConfigValue } from '../util.js';
import { validateBrowserSession, validateCredentials, validateActiveSession, isSessionAuthEnabled } from './sessionAuth.js';
import { getIpAddress, retryAfter } from '../express-common.js';
import { serverDirectory } from '../server-directory.js';

const PREFER_REAL_IP_HEADER = !!getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const BASIC_AUTH_ATTEMPTS = getConfigValue('rateLimiting.basicAuthMaxAttempts', 5, 'number');

const basicAuthLimiter = new RateLimiterMemory({
    points: BASIC_AUTH_ATTEMPTS > 0 ? BASIC_AUTH_ATTEMPTS : Number.MAX_SAFE_INTEGER,
    duration: 60,
});

// The login page, its assets and its dictionaries, and the anonymous sign-in APIs load before any
// credentials exist. Keep this list to exactly what the sign-in flow needs.
const LOGIN_GET_ROUTES = new Set([
    '/login',
    '/login.html',
    '/css/login.css',
    '/scripts/login.js',
    '/scripts/page-locale.js',
    '/lib/jquery-3.5.1.min.js',
    '/manifest.json',
    '/favicon.ico',
    '/img/neconyan-pixel-cat-rest.webp',
    '/img/neconyan-pixel-cat.webp',
    '/img/neconyan.png',
    '/img/neconyan-icon-180.png',
    '/img/neconyan-icon-192.png',
    '/img/neconyan-icon-512.png',
    '/csrf-token',
    '/api/auth/status',
]);

// The two dictionary files of every language in lang.json, which page-locale.js reads for the sign-in page.
// An unreadable lang.json leaves the set empty: the sign-in page stays English and nothing extra is exposed.
const LOGIN_LOCALE_ROUTES = (() => {
    const routes = new Set();
    try {
        const localesRoot = path.join(serverDirectory, 'public', 'locales');
        const languages = JSON.parse(fs.readFileSync(path.join(localesRoot, 'lang.json'), 'utf8'));
        routes.add('/locales/lang.json');
        for (const { lang } of languages) {
            if (typeof lang === 'string' && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(lang)) {
                routes.add(`/locales/${lang}.json`);
                routes.add(`/locales/neconyan/${lang}.json`);
            }
        }
    } catch (error) {
        console.warn('Could not read the language list for the sign-in page:', error.message);
        routes.clear();
    }
    return routes;
})();

const LOGIN_POST_ROUTES = new Set([
    '/api/auth/browser/login',
    '/api/auth/passkeys/login-options',
    '/api/auth/passkeys/login',
]);

const LOGIN_FONT_PREFIXES = [
    '/webfonts/FredokaOne/',
    '/webfonts/Nunito/',
];

const NO_STORE_HEADERS = {
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
};

function isLoginRoute(request) {
    if (request.method === 'GET' && (LOGIN_GET_ROUTES.has(request.path) || LOGIN_LOCALE_ROUTES.has(request.path) || LOGIN_FONT_PREFIXES.some(prefix => request.path.startsWith(prefix)))) return true;
    if (request.method === 'POST' && LOGIN_POST_ROUTES.has(request.path)) return true;
    return false;
}

function isBrowserNavigation(request) {
    return String(request.headers.accept || '').includes('text/html');
}

function sendLoginRedirect(request, response) {
    response.set(NO_STORE_HEADERS);
    response.vary('Cookie');
    const queryIndex = request.originalUrl.indexOf('?');
    return response.redirect(302, '/login' + (queryIndex >= 0 ? request.originalUrl.slice(queryIndex) : ''));
}

function sendUnauthorized(response) {
    response.set(NO_STORE_HEADERS);
    response.vary('Authorization');
    response.vary('Cookie');
    return response.status(401).json({ error: 'You are signed out. Sign in to continue.' });
}

const basicAuthMiddleware = async function (request, response, callback) {
    const authHeader = request.headers.authorization;
    if (request.path === '/login' || request.path === '/login.html') response.set(NO_STORE_HEADERS);
    try {
        if (await validateBrowserSession(request)) return callback();
        if (isLoginRoute(request)) {
            request.anonymousLoginRoute = true;
            return callback();
        }
    } catch (error) {
        console.error('Could not validate the remembered login:', error.message);
        return response.sendStatus(503);
    }

    // Browser fetches also carry cached Basic headers. Fetch Metadata distinguishes
    // those requests from API clients; header sign-in never creates a browser cookie.
    if (!isBrowserNavigation(request) && !request.headers['sec-fetch-mode']) {
        if (authHeader && isSessionAuthEnabled()) {
            const [scheme, token] = authHeader.split(' ');
            if (scheme === 'Bearer' && token) {
                const session = await validateActiveSession(token);
                if (session) {
                    return callback();
                }
            }
        }

        try {
            const ip = getIpAddress(request, PREFER_REAL_IP_HEADER);

            if (authHeader) {
                const [scheme, credentials] = authHeader.split(' ');

                if (scheme === 'Basic' && credentials) {
                    const rateLimit = await basicAuthLimiter.get(ip);

                    if (rateLimit !== null && rateLimit.consumedPoints >= basicAuthLimiter.points) {
                        throw rateLimit;
                    }

                    const [username, ...passwordParts] = Buffer.from(credentials, 'base64')
                        .toString('utf8')
                        .split(':');
                    const password = passwordParts.join(':');

                    if (await validateCredentials(username, password)) {
                        await basicAuthLimiter.delete(ip);
                        return callback();
                    }

                    await basicAuthLimiter.consume(ip);
                }
            }

            return sendUnauthorized(response);
        } catch (error) {
            if (error instanceof RateLimiterRes) {
                console.error('Basic auth failed: Rate limited from', getIpAddress(request, PREFER_REAL_IP_HEADER), request.method, request.originalUrl);
                return retryAfter(response, error).sendStatus(429);
            }
            console.error('Basic auth error:', error);
            return response.sendStatus(500);
        }
    }

    return isBrowserNavigation(request) ? sendLoginRedirect(request, response) : sendUnauthorized(response);
};

export default basicAuthMiddleware;
