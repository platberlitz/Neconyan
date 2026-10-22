import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...parts) => readFileSync(path.join(repoRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');

describe('group speaker bar on phones', () => {
    const rossSource = readSource('public', 'scripts', 'RossAscends-mods.js');
    const mobileStyles = readSource('public', 'css', 'mobile-styles.css');

    test('sliding along the bar never swipes the last reply', () => {
        expect(rossSource).toContain('const MESSAGE_SWIPE_IGNORED_SELECTOR = \'#group_speaker_controls, #group_scene_strip\';');
        const guard = rossSource.slice(rossSource.indexOf('function isMessageSwipeGesture(e)'));
        expect(guard.slice(0, guard.indexOf('\n    }\n'))).toContain('target.closest(MESSAGE_SWIPE_IGNORED_SELECTOR).length');
        for (const type of ['swiped-left', 'swiped-right']) {
            const listener = rossSource.slice(rossSource.indexOf(`document.addEventListener('${type}'`));
            expect(listener.slice(0, listener.indexOf('\n    });\n'))).toContain('if (!isMessageSwipeGesture(e)) {');
        }
    });

    test('the bar sits inside the bottom panel\'s generating ring', () => {
        const rule = mobileStyles.slice(mobileStyles.indexOf('    .group_speaker_controls {'));
        expect(rule.slice(0, rule.indexOf('\n    }\n'))).toContain('margin: 0 4px 2px !important;');
        expect(readSource('public', 'css', 'neconyan-calico.css')).toContain('box-shadow: inset 0 0 0 3px var(--neco-accent-secondary);');
    });
});
