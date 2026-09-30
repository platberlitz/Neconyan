import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('Moving UI leaves the docked chat workspace alone', () => {
    const rossSource = readSource('public', 'scripts', 'RossAscends-mods.js');
    const powerUserSource = readSource('public', 'scripts', 'power-user.js');
    const toggleDependentSource = readSource('public', 'css', 'toggle-dependent.css');
    const styleSource = readSource('public', 'style.css');

    test('never makes #sheld draggable, so the Conversation header cannot pin it over the rail', () => {
        const initMovingUI = rossSource.slice(rossSource.indexOf('export async function initMovingUI()'));
        expect(initMovingUI.slice(0, initMovingUI.indexOf('\n}\n'))).not.toContain('dragElement($(\'#sheld\'))');
        expect(rossSource).not.toContain('#sb_conversation_header');
    });

    test('drops a #sheld position saved by older builds instead of applying it', () => {
        const load = powerUserSource.slice(powerUserSource.indexOf('export function loadMovingUIState()'));
        const body = load.slice(0, load.indexOf('\n}\n'));
        expect(body).toContain('delete power_user.movingUIState.sheld;');
        expect(body.indexOf('delete power_user.movingUIState.sheld;')).toBeLessThan(body.indexOf('for (var elmntName of Object.keys(power_user.movingUIState))'));
    });

    test('shows no resize grip or drag handle on #sheld', () => {
        expect(toggleDependentSource).not.toMatch(/body\.movingUI #sheld\b/);
        expect(styleSource).toMatch(/#sheldheader \{\n\s+display: none;\n\}/);
    });
});
