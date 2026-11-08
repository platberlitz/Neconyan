#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { primeGradleDistribution } from './lib/gradle-distribution.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function argument(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? '' : process.argv[index + 1] || '';
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: node scripts/prime-gradle-distribution.js [--gradle-user-home <dir>]\n');
} else {
    try {
        const gradleUserHome = argument('--gradle-user-home')
            || process.env.GRADLE_USER_HOME
            || path.join(os.homedir(), '.gradle');
        const result = await primeGradleDistribution({
            root,
            gradleUserHome,
            logger: message => process.stderr.write(`Gradle distribution: ${message}\n`),
        });
        process.stdout.write(`Gradle distribution ready at ${result.destination} (SHA-256 ${result.sha256}).\n`);
    } catch (error) {
        process.stderr.write(`Gradle distribution: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
