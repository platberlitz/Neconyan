import { beforeEach, describe, expect, test } from '@jest/globals';
import { EVIDENCE_CAPS, EVIDENCE_HEADING, formatAppEvidence, redactEvidenceText } from '../public/scripts/scratchpad/evidence.js';
import { clearAppEvidenceLog, getExtensionLoadErrors, getProviderFailures, recordProviderFailure, setExtensionLoadErrors } from '../public/scripts/app-evidence-log.js';

const SECRETS = [
    'sk-PLANTEDsecretKEY1234567890',
    'hunter2-planted',
    'PlantedCookieValue99',
    'AIzaSyPLANTEDgoogleKEY000000000000000000',
    'dXNlcjpwbGFudGVkcGFzcw',
    'ghp_PLANTEDgithubTOKEN1234567890abcdef',
    'planted-url-token-abc',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkIn0.PLANTEDsignature123',
    'my planted chat line',
];

function expectNoSecrets(text) {
    for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe('redactEvidenceText', () => {
    test.each([
        ['authorization header, mixed case', 'AuthoriZation: Bearer sk-PLANTEDsecretKEY1234567890'],
        ['basic header', 'authorization: BASIC dXNlcjpwbGFudGVkcGFzcw'],
        ['cookie header with several pairs', 'COOKIE: a=1; session=PlantedCookieValue99; other=PlantedCookieValue99'],
        ['set-cookie line', 'Set-Cookie: sid=PlantedCookieValue99; HttpOnly'],
        ['url with basic auth', 'GET https://admin:hunter2-planted@example.com/v1/models failed'],
        ['query secret', 'GET https://example.com/v1/models?key=AIzaSyPLANTEDgoogleKEY000000000000000000&alt=sse failed'],
        ['query token in a stack frame', 'at load (https://example.com/app.js?token=planted-url-token-abc:12:5)'],
        ['api key assignment', 'Request failed: API_KEY=sk-PLANTEDsecretKEY1234567890'],
        ['quoted password with spaces', 'Login failed {"Password": "hunter2-planted and more"}'],
        ['x-api-key header', 'X-Api-Key: sk-PLANTEDsecretKEY1234567890'],
        ['github token', 'clone failed with ghp_PLANTEDgithubTOKEN1234567890abcdef'],
        ['jwt', 'bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkIn0.PLANTEDsignature123'],
        ['json parse error with echoed text', 'Unexpected token \'m\', "my planted chat line" is not valid JSON'],
    ])('removes the secret from %s', (_name, input) => {
        const output = redactEvidenceText(input);
        expectNoSecrets(output);
        expect(output.length).toBeGreaterThan(0);
    });

    test('keeps plain error text readable', () => {
        expect(redactEvidenceText('Unexpected token in JSON at position 5')).toBe('Unexpected token in JSON at position 5');
        expect(redactEvidenceText('Rate limit reached for gpt-4o')).toBe('Rate limit reached for gpt-4o');
    });

    test.each([
        'max_tokens: 8192 > 4096, which is the maximum allowed number of output tokens for this model',
        'Invalid value for max_completion_tokens: 0. Must be >= 1',
        'prompt_tokens=120000 total_tokens=124096',
        'maxOutputTokens: 300 is below the minimum',
        'token_limit=4096',
    ])('keeps token counts, which are not credentials: %s', input => {
        expect(redactEvidenceText(input)).toBe(input);
    });

    test.each([
        ['access_token=PlantedCookieValue99 with max_tokens=5', 'max_tokens=5'],
        ['csrf_token: PlantedCookieValue99', 'csrf_token'],
        ['{"token":"PlantedCookieValue99"}', 'token'],
    ])('still removes a real token value from %s', (input, kept) => {
        const output = redactEvidenceText(input);
        expectNoSecrets(output);
        expect(output).toContain(kept);
    });

    test('bounds length and ignores non-strings', () => {
        expect(redactEvidenceText('x '.repeat(5000), 100).length).toBeLessThanOrEqual(110);
        expect(redactEvidenceText(null)).toBe('');
        expect(redactEvidenceText({ a: 1 })).toBe('');
    });

    test('does not stall on long hostile input', () => {
        const started = Date.now();
        redactEvidenceText(`${'a'.repeat(50000)}=${'b'.repeat(50000)}:${'?'.repeat(50000)}`);
        redactEvidenceText('Authorization:'.repeat(5000));
        redactEvidenceText('https://'.repeat(5000));
        expect(Date.now() - started).toBeLessThan(2000);
    });
});

describe('formatAppEvidence', () => {
    const environment = { version: '1.2.3', build: 'abc123def456', branch: 'staging', runtime: 'Node.js v24.13.0', platform: 'linux arm64', client: 'web browser (Linux)', frontendBuild: true };

    test('is empty when there is nothing at all', () => {
        expect(formatAppEvidence({})).toBe('');
    });

    test('says when the evidence was gathered, so item times can be judged', () => {
        const text = formatAppEvidence({ environment, gatheredAt: Date.UTC(2026, 0, 2, 3, 4, 5) });
        expect(text.split('\n')[2]).toBe('Gathered at 2026-01-02T03:04:05.000Z. Times are UTC.');
        expect(formatAppEvidence({ environment })).not.toContain('Gathered at');
        expect(formatAppEvidence({ gatheredAt: Date.now() })).toBe('');
    });

    test('has a clear heading and the environment part, and leaves out empty parts', () => {
        const text = formatAppEvidence({ environment });
        expect(text.startsWith(EVIDENCE_HEADING)).toBe(true);
        expect(text).toContain('### Neconyan and this device');
        expect(text).toContain('Neconyan 1.2.3');
        expect(text).toContain('Built frontend: in use');
        expect(text).not.toContain('### Browser errors');
        expect(text).not.toContain('### Failed model requests');
        expect(text).not.toContain('### Failed jobs');
        expect(text).not.toContain('admin only');
    });

    test('lists newest first and says how many items the cap left out', () => {
        const failures = Array.from({ length: EVIDENCE_CAPS.modelFailures + 3 }, (_, index) => ({
            at: new Date(Date.UTC(2026, 10, 1, 10, index)).toISOString(), provider: 'openai', model: `m${index}`, status: 429, message: `rate limited ${index}`,
        }));
        const text = formatAppEvidence({ environment, modelFailures: failures });
        const section = text.slice(text.indexOf('### Failed model requests'));
        const newest = section.indexOf(`m${failures.length - 1}`);
        const older = section.indexOf('m0');
        expect(newest).toBeGreaterThan(-1);
        expect(older === -1 || newest < older).toBe(true);
        expect(section).toContain('HTTP 429');
        expect(section).toMatch(/3 older items were left out\./);
    });

    test('counts items the server already cut using total', () => {
        const requests = { items: [{ at: '2026-11-01T10:00:00.000Z', method: 'POST', path: '/api/x', status: 500, ms: 12, closed: false }], total: 9 };
        const text = formatAppEvidence({ environment, requests });
        expect(text).toContain('### Failed or slow server requests');
        expect(text).toMatch(/8 older items were left out\./);
    });

    test('never prints planted secrets from any part', () => {
        const dirty = 'Authorization: Bearer sk-PLANTEDsecretKEY1234567890 at https://u:hunter2-planted@h.example/x?token=planted-url-token-abc';
        const text = formatAppEvidence({
            environment,
            browserErrors: [{ kind: 'error', at: '2026-11-01T10:00:00.000Z', error: { name: 'Error', message: dirty, stack: `Error: ${dirty}\n    at f (https://h.example/a.js?key=planted-url-token-abc:1:1)` }, context: { source: 'https://h.example/a.js?key=planted-url-token-abc', line: 1 } }],
            extensionErrors: [`Extension "x" failed to load: ${dirty}`],
            modelFailures: [{ at: '2026-11-01T10:00:00.000Z', provider: 'openai', model: 'gpt', status: 401, message: dirty }],
            requests: [{ at: '2026-11-01T10:00:00.000Z', method: 'POST', path: '/api/x?token=planted-url-token-abc', status: 500, ms: 1, closed: false }],
            jobs: [{ at: '2026-11-01T10:00:00.000Z', type: 'scratchpad.reply', state: 'failed', stage: 'model', code: 'E', message: dirty }],
            serverCrashes: [{ at: '2026-11-01T10:00:00.000Z', kind: 'uncaughtException', name: 'Error', message: dirty, stack: dirty }],
            logLines: [{ at: '2026-11-01T10:00:00.000Z', stream: 'stderr', message: `Cookie: sid=PlantedCookieValue99; ${dirty}` }],
        });
        expectNoSecrets(text);
        expect(text).toContain('### Server crash reports (admin only)');
        expect(text).toContain('### Recent server error and warning lines (admin only)');
    });
});

describe('app evidence log', () => {
    beforeEach(() => clearAppEvidenceLog());

    test('keeps only the last five failures, newest first, with no prompt text', () => {
        for (let index = 0; index < 8; index++) {
            recordProviderFailure({ provider: 'openai', model: `m${index}`, status: 500 + index, message: 'upstream down', prompt: 'my planted chat line', messages: [{ content: 'my planted chat line' }] });
        }
        const failures = getProviderFailures();
        expect(failures).toHaveLength(5);
        expect(failures[0].model).toBe('m7');
        expect(JSON.stringify(failures)).not.toContain('planted chat line');
        expect(Object.keys(failures[0]).sort()).toEqual(['at', 'message', 'model', 'provider', 'status']);
    });

    test('redacts secrets in recorded messages', () => {
        recordProviderFailure({ provider: 'openai', model: 'gpt', status: 401, message: 'Incorrect API key provided: sk-PLANTEDsecretKEY1234567890. Authorization: Bearer sk-PLANTEDsecretKEY1234567890' });
        expectNoSecrets(JSON.stringify(getProviderFailures()));
    });

    test('keeps extension load errors as copied strings', () => {
        const live = new Set(['Extension "a" failed to load: boom']);
        setExtensionLoadErrors(live);
        live.add('later');
        expect(getExtensionLoadErrors()).toEqual(['Extension "a" failed to load: boom']);
        clearAppEvidenceLog();
        expect(getExtensionLoadErrors()).toEqual([]);
    });
});
