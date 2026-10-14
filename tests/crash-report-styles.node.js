import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const crashReports = read('public/css/neconyan-crash-reports.css');
const debuggerStyles = read('public/scripts/extensions/neconyan-debugger/style.css');
const browser = read('public/scripts/crash-diagnostics.js');
const script = read('public/script.js');

test('crash-reader text styling stays scoped to the crash reader', () => {
    // The reader reuses .sbdbg-report, so its pre-wrap/40vh text rule must be namespaced under
    // .neconyan-crash-report and the Debugger's own rule must exclude the reader.
    assert.match(crashReports, /\.neconyan-crash-report \.sbdbg-report-text \{/);
    assert.doesNotMatch(crashReports, /^\.sbdbg-report-text \{/m);
    assert.match(debuggerStyles, /\.sbdbg-report:not\(\.neconyan-crash-report\) \.sbdbg-report-text \{/);
});

test('the recovery notice has its own container instead of the shared toast stack', () => {
    // A toast-container notice swallows the application's other toasts and loses its own actions.
    assert.doesNotMatch(browser, /toastr\.warning/);
    assert.match(browser, /notice\.id = 'neconyan-crash-notice'/);
    assert.match(crashReports, /#neconyan-crash-notice \{/);
    // Floating over a drawer must not close that drawer, so the shell lists the notice as a forbidden target.
    assert.match(script, /'#neconyan-crash-notice'/);
});
