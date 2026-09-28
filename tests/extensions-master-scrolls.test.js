import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const neconyanCss = readFileSync(path.join(repoRoot, 'public', 'css', 'neconyan.css'), 'utf8').replace(/\r\n/g, '\n');

describe('Extensions sheet header scrolls with its panels', () => {
    test('the extensions master is never pinned with position: sticky', () => {
        const rules = neconyanCss.replace(/\/\*[\s\S]*?\*\//g, '').split('}');
        const stickyMaster = rules.filter(rule => {
            const open = rule.lastIndexOf('{');
            const selector = rule.slice(0, open);
            const body = rule.slice(open + 1);
            return selector.includes('.sb-extensions-master') && /position\s*:\s*sticky/.test(body);
        });
        expect(stickyMaster).toEqual([]);
    });

    test('the settings navigator keeps its sticky column', () => {
        expect(neconyanCss).toMatch(/body\.neconyan \.sb-settings-nav-column \{[^}]*position: sticky;/);
    });
});
