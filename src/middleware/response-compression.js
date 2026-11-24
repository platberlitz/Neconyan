import compression from 'compression';
import { isNativeTermuxEnvironment } from '../runtime.js';

function getHeaderValue(response, headerName) {
    const value = response?.getHeader?.(headerName);
    if (Array.isArray(value)) {
        return value.join(',');
    }

    return value === undefined || value === null ? '' : String(value);
}

function hasCacheDirective(response, directive) {
    const cacheControl = getHeaderValue(response, 'Cache-Control').toLowerCase();
    return cacheControl.split(',').map(part => part.trim()).includes(directive);
}

function isLocalMobileRuntime() {
    return process.env.NECONYAN_ANDROID_APP === '1'
        || process.env.NECONYAN_IOS_APP === '1'
        || isNativeTermuxEnvironment();
}

/**
 * Keeps generic response compression away from live streams.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @returns {boolean}
 */
export function shouldCompressResponse(request, response) {
    if (isLocalMobileRuntime()) {
        // Phone apps and Termux serve the browser on the same device over
        // loopback, where gzipping large chat payloads burns CPU and RAM
        // without saving real network transfer.
        return false;
    }

    const contentType = getHeaderValue(response, 'Content-Type').toLowerCase();
    if (contentType.split(';', 1)[0].trim() === 'text/event-stream') {
        return false;
    }

    if (hasCacheDirective(response, 'no-transform')) {
        return false;
    }

    return compression.filter(request, response);
}

export default function getResponseCompressionMiddleware() {
    return compression({ filter: shouldCompressResponse });
}
