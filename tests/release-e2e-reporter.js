import fs from 'node:fs';
import path from 'node:path';

function outcomeFor(test) {
    const outcome = test.outcome();
    // Playwright can mark a failed attempt followed by a skip as flaky.
    // A skipped retry did not resolve the failure.
    return outcome === 'flaky' && test.expectedStatus === 'skipped' ? 'unexpected' : outcome;
}

// Keep outcomes and timings without duplicating test output, errors or trace data.
export default class ReleaseE2EReporter {
    runErrors = 0;

    onBegin(config, suite) {
        this.rootDir = config.rootDir;
        this.suite = suite;
    }

    onError() {
        this.runErrors++;
    }

    onEnd(result) {
        const tests = (this.suite?.allTests() || []).map(test => ({
            file: path.relative(this.rootDir, test.location.file).split(path.sep).join('/'),
            title: test.titlePath().slice(3), // Root, project and file precede describe/test titles.
            project: test.parent.project()?.name || '',
            outcome: outcomeFor(test),
            expectedStatus: test.expectedStatus,
            attempts: test.results.map(({ status, duration }) => ({ status, durationMs: duration })),
        }));
        fs.writeFileSync(process.env.RELEASE_E2E_REPORT, JSON.stringify({
            commit: process.env.GITHUB_SHA,
            status: result.status,
            runErrors: this.runErrors,
            tests,
        }) + '\n');
    }
}
