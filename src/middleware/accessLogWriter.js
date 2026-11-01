import path from 'node:path';
import fs from 'node:fs';
import { getIpAddress } from '../express-common.js';
import { color, getConfigValue } from '../util.js';

const enableAccessLog = getConfigValue('logging.enableAccessLog', true, 'boolean');

const MAX_KNOWN_IPS = 10000;
const MAX_LOG_FIELD_LENGTH = 512;
const CONTROL_CHARACTERS = /[\r\n\u0000-\u001f\u007f]+/g;
const knownIPs = new Set();

function sanitizeAccessLogField(value, fallback = 'unknown') {
    if (value === undefined || value === null) return fallback;
    const cleaned = String(value).replace(CONTROL_CHARACTERS, ' ').trim();
    if (!cleaned) return fallback;
    return cleaned.length > MAX_LOG_FIELD_LENGTH ? cleaned.slice(0, MAX_LOG_FIELD_LENGTH) : cleaned;
}

function rememberKnownIp(ip) {
    if (knownIPs.has(ip)) return false;
    while (knownIPs.size >= MAX_KNOWN_IPS) {
        const oldest = knownIPs.values().next().value;
        if (oldest === undefined) break;
        knownIPs.delete(oldest);
    }
    knownIPs.add(ip);
    return true;
}

export const getAccessLogPath = () => path.join(globalThis.DATA_ROOT, 'access.log');

export function migrateAccessLog() {
    try {
        if (!fs.existsSync('access.log')) {
            return;
        }
        const logPath = getAccessLogPath();
        if (fs.existsSync(logPath)) {
            return;
        }
        fs.renameSync('access.log', logPath);
        console.log(color.yellow('Migrated access.log to new location:'), logPath);
    } catch (e) {
        console.error('Failed to migrate access log:', e);
        console.info('Please move access.log to the data directory manually.');
    }
}

/**
 * Creates middleware for logging access and new connections
 * @returns {import('express').RequestHandler}
 */
export default function accessLoggerMiddleware() {
    return function (req, res, next) {
        const clientIp = sanitizeAccessLogField(getIpAddress(req, true));
        const userAgent = sanitizeAccessLogField(req.headers['user-agent'], 'unknown');

        if (rememberKnownIp(clientIp)) {
            // Write to access log if enabled
            if (enableAccessLog) {
                console.info(color.yellow(`New connection from ${clientIp}; User Agent: ${userAgent}\n`));
                const logPath = getAccessLogPath();
                const timestamp = new Date().toISOString();
                const log = `${timestamp} ${clientIp} ${userAgent}\n`;

                fs.appendFile(logPath, log, (err) => {
                    if (err) {
                        console.error('Failed to write access log:', err);
                    }
                });
            }
        }

        next();
    };
}
