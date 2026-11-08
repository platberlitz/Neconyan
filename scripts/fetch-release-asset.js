#!/usr/bin/env node
import { TOKEN_ENV, downloadPinnedAsset } from './lib/release-download.js';

const USAGE = `Usage: node scripts/fetch-release-asset.js --url <url> --sha256 <hash> --output <file> [options]

Download an immutable GitHub release asset, with a bounded retry and a GitHub
release API fallback when the normal release download fails. The SHA-256 pin is
always verified before the destination file is replaced.

Options:
  --url <url>             Exact GitHub release download URL, or a pinned
                          services.gradle.org distribution URL.
  --sha256 <hash>         Pinned 64-character SHA-256 checksum.
  --output <file>         Destination file.
  --fallback-url <url>    Exact GitHub release URL for a Gradle distribution.
  --attempts <n>          Tries per normal download source (1-4, default 2).
  --retry-delay-ms <n>    Delay before the second try (default 1000).
  --timeout-ms <n>        Per-request timeout (default 300000).
  --label <text>          Name used in progress messages.
  --quiet                 Only report failures.
  --help                  Show this help.

Environment:
  ${TOKEN_ENV}   Optional ephemeral token for GitHub API requests only.
                          It is never sent to release download or CDN hosts.
                          Tokens are not accepted as command-line arguments.
`;

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
}

function parseArguments(argv) {
    const options = { attempts: 2, retryDelayMs: 1000, timeoutMs: 300000, label: 'release asset', quiet: false };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        const value = () => {
            const next = argv[++index];
            if (next === undefined) throw new Error(`${argument} needs a value.`);
            return next;
        };
        switch (argument) {
            case '--url': options.url = value(); break;
            case '--sha256': options.sha256 = value(); break;
            case '--output': options.output = value(); break;
            case '--fallback-url': options.fallbackUrl = value(); break;
            case '--attempts': options.attempts = Number(value()); break;
            case '--retry-delay-ms': options.retryDelayMs = Number(value()); break;
            case '--timeout-ms': options.timeoutMs = Number(value()); break;
            case '--label': options.label = value(); break;
            case '--quiet': options.quiet = true; break;
            case '--help': case '-h': options.help = true; break;
            default: {
                // Never echo a value after '=': it could be a secret passed by mistake.
                const name = argument.split('=', 1)[0];
                throw new Error(`Unknown option: ${name}`);
            }
        }
    }
    return options;
}

const options = (() => {
    try {
        return parseArguments(process.argv.slice(2));
    } catch (error) {
        fail(`${error.message}\n\n${USAGE}`);
        return null;
    }
})();

if (options?.help) {
    process.stdout.write(USAGE);
} else if (options) {
    for (const required of ['url', 'sha256', 'output']) {
        if (!options[required]) {
            fail(`--${required} is required.\n\n${USAGE}`);
            break;
        }
    }
    if (!process.exitCode) {
        try {
            const result = await downloadPinnedAsset({
                url: options.url,
                sha256: options.sha256,
                destination: options.output,
                fallbackUrl: options.fallbackUrl,
                attempts: options.attempts,
                retryDelayMs: options.retryDelayMs,
                timeoutMs: options.timeoutMs,
                logger: options.quiet ? () => {} : message => process.stderr.write(`${options.label}: ${message}\n`),
            });
            if (!options.quiet) {
                process.stderr.write(`${options.label}: verified ${result.bytes} bytes (SHA-256 ${result.sha256}).\n`);
            }
        } catch (error) {
            process.stderr.write(`${options.label}: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    }
}
