const NN_SW_CACHE_VERSION = 'neconyan-cache-v20261005-scratchpad1';
const NN_CACHE_PREFIX = 'neconyan-cache-';
const NN_STATIC_CACHE = `${NN_SW_CACHE_VERSION}-static`;
const NN_SHELL_CACHE = `${NN_SW_CACHE_VERSION}-shell`;
const NN_FRONTEND_ASSET_PREFIX = '/frontend-assets/';
const NN_HASHED_FRONTEND_ASSET_RE = /-[a-f0-9]{8,}\.[a-z0-9]+$/i;

const NN_STALE_WHILE_REVALIDATE_PREFIXES = Object.freeze([
    '/lib/',
    '/css/',
    '/img/',
    '/webfonts/',
]);

const NN_NETWORK_FIRST_EXTENSIONS = Object.freeze([
    '.html',
    '.js',
    '.mjs',
]);

function isSameOrigin(url) {
    return url.origin === self.location.origin;
}

function shouldStaleWhileRevalidate(url) {
    return NN_STALE_WHILE_REVALIDATE_PREFIXES.some(prefix => url.pathname.startsWith(prefix));
}

function isFrontendAsset(url) {
    return url.pathname.startsWith(NN_FRONTEND_ASSET_PREFIX);
}

function shouldCacheFirst(url) {
    return isFrontendAsset(url) && NN_HASHED_FRONTEND_ASSET_RE.test(url.pathname);
}

function shouldNetworkFirst(url) {
    return url.pathname === '/' || NN_NETWORK_FIRST_EXTENSIONS.some(extension => url.pathname.endsWith(extension));
}

function isCacheableResponse(response) {
    return response && response.ok && response.type === 'basic';
}

async function putCache(cache, request, response) {
    // Never cache responses that followed a redirect (e.g. a sign-in page that
    // landed under another URL) or that the server marked as non-storable.
    if (!isCacheableResponse(response) || response.redirected || (response.headers.get('Cache-Control') || '').includes('no-store')) {
        return;
    }

    await cache.put(request, response.clone());
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(NN_STATIC_CACHE);
    const cachedResponse = await cache.match(request);
    const freshResponse = fetch(request)
        .then((response) => {
            putCache(cache, request, response).catch((error) => {
                console.debug('Neconyan service worker skipped static cache update.', error);
            });

            return response;
        })
        .catch((error) => {
            if (cachedResponse) {
                return cachedResponse;
            }

            throw error;
        });

    return cachedResponse || freshResponse;
}

async function cacheFirst(request) {
    const cache = await caches.open(NN_STATIC_CACHE);
    const cachedResponse = await cache.match(request);

    if (cachedResponse) {
        return cachedResponse;
    }

    const response = await fetch(request);
    await putCache(cache, request, response).catch((error) => {
        console.debug('Neconyan service worker skipped immutable cache update.', error);
    });
    return response;
}

async function networkFirst(request) {
    const cache = await caches.open(NN_SHELL_CACHE);

    try {
        const response = await fetch(request);
        await putCache(cache, request, response).catch((error) => {
            console.debug('Neconyan service worker skipped shell cache update.', error);
        });
        return response;
    } catch (error) {
        const cachedResponse = await cache.match(request);

        if (cachedResponse) {
            return cachedResponse;
        }

        throw error;
    }
}

self.addEventListener('install', () => {
    self.skipWaiting();
});

// Neconyan: iOS WebKit keeps the current page controlled by this service worker until the
// page unloads, even after registration.unregister(). Without this the SW would re-populate
// its caches during the pre-reload window and the reload navigation itself, undoing a cache
// clear. The page posts { type: 'NN_CLEAR_CACHES' } and waits for the matching reply before
// reloading.
async function deleteNeconyanCaches() {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
        .filter(cacheName => cacheName.startsWith(NN_CACHE_PREFIX))
        .map(cacheName => caches.delete(cacheName)));
}

self.addEventListener('message', (event) => {
    const messageType = event.data?.type;
    if (messageType !== 'NN_CLEAR_CACHES') {
        return;
    }

    event.waitUntil((async () => {
        let ok = true;
        try {
            await deleteNeconyanCaches();
        } catch (error) {
            console.error('Neconyan service worker failed to clear caches on request.', error);
            ok = false;
        }

        const port = event.ports?.[0];
        if (port) {
            port.postMessage({ type: 'NN_CLEAR_CACHES_DONE', ok });
        }
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter(cacheName => cacheName.startsWith(NN_CACHE_PREFIX) && cacheName !== NN_STATIC_CACHE && cacheName !== NN_SHELL_CACHE)
            .map(cacheName => caches.delete(cacheName)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') {
        return;
    }

    const url = new URL(request.url);

    // Documents must reach the server so an offline cache cannot undo logout.
    if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) return;

    if (!isSameOrigin(url)) {
        return;
    }

    if (isFrontendAsset(url) && !shouldCacheFirst(url)) {
        return;
    }

    if (shouldCacheFirst(url)) {
        event.respondWith(cacheFirst(request));
        return;
    }

    if (shouldStaleWhileRevalidate(url)) {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }

    if (shouldNetworkFirst(url)) {
        event.respondWith(networkFirst(request));
    }
});
