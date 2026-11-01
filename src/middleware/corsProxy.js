import fetch from 'node-fetch';
import { forwardFetchResponse } from '../util.js';
import { parseAndUnwrapIpAddress } from '../private-request-filter.js';
import { isLocalOrInternalHostname, safeFetchFollowRedirects } from '../safe-http.js';

function isSelfLoopbackRequest(targetUrl, req, resolvedAddresses = null) {
    let parsedUrl;
    try {
        parsedUrl = new URL(String(targetUrl));
    } catch {
        return true;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return true;
    }

    const reqHostHeader = String(req.get?.('host') || req.headers?.host || '').trim().toLowerCase();
    const serverUrl = `${req.protocol}://${reqHostHeader}`;
    if (reqHostHeader && String(targetUrl).toLowerCase().startsWith(serverUrl)) {
        return true;
    }

    const localPort = String(req.socket?.localPort || (reqHostHeader.includes(':') ? reqHostHeader.split(':').pop() : '') || (req.protocol === 'https' ? '443' : '80'));
    const targetPort = parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80');
    if (targetPort !== localPort) {
        return false;
    }

    const targetHost = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const reqHostname = String(req.hostname || reqHostHeader.replace(/:\d+$/, '')).replace(/^\[|\]$/g, '').toLowerCase();
    if (targetHost === reqHostname) {
        return true;
    }

    if (isLocalOrInternalHostname(targetHost)) {
        return true;
    }

    const parsedLocalIp = parseAndUnwrapIpAddress(String(req.socket?.localAddress || ''));
    const parsedTargetIp = parseAndUnwrapIpAddress(targetHost);
    if (parsedTargetIp && parsedLocalIp && parsedTargetIp.toString() === parsedLocalIp.toString()) {
        return true;
    }

    if (Array.isArray(resolvedAddresses)) {
        for (const addr of resolvedAddresses) {
            if (isLocalOrInternalHostname(addr)) {
                return true;
            }
            const parsedAddr = parseAndUnwrapIpAddress(String(addr || ''));
            if (parsedAddr && parsedLocalIp && parsedAddr.toString() === parsedLocalIp.toString()) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Middleware to proxy requests to a different domain
 * @param {import('express').Request} req Express request object
 * @param {import('express').Response} res Express response object
 */
export default async function corsProxyMiddleware(req, res) {
    const url = req.params.url; // get the url from the request path

    let parsedInitial;
    try {
        parsedInitial = new URL(String(url));
        if (parsedInitial.protocol !== 'http:' && parsedInitial.protocol !== 'https:') {
            return res.status(400).send('Only http and https URLs are supported by the CORS proxy.');
        }
    } catch {
        return res.status(400).send('Invalid URL provided to the CORS proxy.');
    }

    // Disallow circular requests
    if (isSelfLoopbackRequest(url, req)) {
        return res.status(400).send('This request would loop back to Neconyan itself, so it was blocked.');
    }

    try {
        const headers = JSON.parse(JSON.stringify(req.headers || {}));
        const headersToRemove = [
            'x-csrf-token', 'host', 'referer', 'origin', 'cookie',
            'x-forwarded-for', 'x-forwarded-protocol', 'x-forwarded-proto',
            'x-forwarded-host', 'x-real-ip', 'sec-fetch-mode',
            'sec-fetch-site', 'sec-fetch-dest',
        ];

        headersToRemove.forEach(header => delete headers[header]);

        // Never leak the server's own HTTP Basic Auth credentials to a proxied remote host
        if (globalThis.COMMAND_LINE_ARGS?.basicAuthMode || /^basic\s/i.test(String(headers.authorization || ''))) {
            delete headers.authorization;
        }

        const bodyMethods = ['POST', 'PUT', 'PATCH'];

        const response = await safeFetchFollowRedirects(url, {
            method: req.method,
            headers: headers,
            body: bodyMethods.includes(req.method) ? JSON.stringify(req.body) : undefined,
            allowPrivate: true,
            maxRedirects: 3,
            isAllowedHost: (_hopHost, hopUrl, addresses) => !isSelfLoopbackRequest(hopUrl.href, req, addresses),
            fetchImpl: fetch,
        });

        // Copy over relevant response params to the proxy response
        await forwardFetchResponse(response, res);
    } catch (error) {
        if (error?.code === 'SAFE_HTTP_HOST_NOT_WHITELISTED') {
            return res.status(400).send('This request would loop back to Neconyan itself, so it was blocked.');
        }
        console.error('Error in CORS proxy middleware:', error);
        if (!res.headersSent) {
            return res.sendStatus(500);
        }
        return res.end();
    }
}
