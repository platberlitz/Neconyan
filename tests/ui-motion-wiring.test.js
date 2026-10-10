import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');

const scriptJs = read('public/script.js');
const tabsJs = read('public/scripts/neconyan-tabs.js');
const inputHistoryJs = read('public/scripts/extensions/input-history/index.js');
const quickImageGenJs = read('public/scripts/extensions/quick-image-gen/index.js');
const welcomeJs = read('public/scripts/welcome-screen.js');

const functionBody = (source, signature) => {
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n}\n', start);
    return source.slice(start, end);
};

describe('surfaces that used to appear without motion', () => {
    test('a newly arrived chat message eases in, while swipe re-renders stay still', () => {
        const addOneMessage = functionBody(scriptJs, 'export function addOneMessage(');
        expect(addOneMessage).toContain('if (type !== \'swipe\') revealUi(insertedElement);');
        expect(functionBody(scriptJs, 'export async function printMessages(')).not.toContain('revealUi(');
    });

    test('leaving Home eases the chat in, and returning eases Home in once', () => {
        const conceal = functionBody(welcomeJs, 'export function concealWelcomeHome(');
        expect(conceal).toContain('revealUi(document.getElementById(\'chat\'));');
        expect(conceal.indexOf('classList.remove(\'neconyan-home-visible\')')).toBeLessThan(conceal.indexOf('revealUi('));
        expect(welcomeJs).toMatch(/const homeArriving = !document\.body\.classList\.contains\('neconyan-home-visible'\);\n\s+document\.body\.classList\.add\('neconyan-home-visible'\);\n\s+if \(homeArriving\) revealUi\(welcomeHost\);/);
    });

    test('Input History fades in and fades out before it is removed', () => {
        expect(functionBody(inputHistoryJs, 'const showHistoryMenu = () => {')).toContain('revealUi(historyMenu, { distance: 0 });');
        const hide = functionBody(inputHistoryJs, 'const hideHistoryMenu = () => {');
        expect(hide).toContain('menu.removeAttribute(\'id\');');
        expect(hide.indexOf('.style.setProperty(\'overflow\', \'hidden\')')).toBeGreaterThan(-1);
        expect(hide.indexOf('.style.setProperty(\'overflow\', \'hidden\')')).toBeLessThan(hide.indexOf('setUiVisibility(menu, false'));
        expect(hide).toContain('setUiVisibility(menu, false, () => menu.remove(), { distance: 0 });');
        expect(hide).not.toContain('historyMenu?.remove()');
    });

    test('Quick Image Gen windows fade with the shared motion and stay live when reopened mid-fade', () => {
        const hide = functionBody(quickImageGenJs, 'function hidePopup(');
        expect(hide.indexOf('popup.inert = true;')).toBeLessThan(hide.indexOf('setUiVisibility(popup, false'));
        const create = functionBody(quickImageGenJs, 'function createPopup(');
        const open = create.indexOf('setUiVisibility(popup, true');
        expect(open).toBeGreaterThan(-1);
        expect(create.indexOf('popup.inert = false;', open)).toBeGreaterThan(open);
        expect(create).toContain('if (arriving) revealUi(popup.querySelector(".qig-popup-content"));');
    });
});

describe('page introductions mount in the frame their drawer opens', () => {
    test('the tour module is loaded once, warmed while idle and then used synchronously', () => {
        expect(tabsJs.match(/(?<!typeof )import\('\.\/neconyan-tool-tour\.js'\)/g)).toHaveLength(1);
        const helper = functionBody(tabsJs, 'function withNeconyanToolTour(');
        expect(helper).toMatch(/if \(neconyanToolTourModule\) \{\s*callback\(neconyanToolTourModule\);/);
        expect(functionBody(tabsJs, 'function scheduleIdlePanelStylesheetWarmup(')).toContain('loadNeconyanToolTour()');
    });
});

describe('pages follow the control that opened them', () => {
    test('shell pages and navbar drawers take their edge from the shared origin helper', () => {
        const forceDrawerState = functionBody(tabsJs, 'function forceDrawerState(');
        expect(forceDrawerState).toContain('edge: getUiDrawerEdge(el, Boolean(shouldOpen), el.classList.contains(\'fillLeft\') ? \'left\' : \'right\')');
        expect(scriptJs.match(/getUiDrawerEdge\(/g)?.length).toBeGreaterThanOrEqual(3);
        expect(scriptJs).not.toMatch(/edge: drawer\.hasClass\('fillLeft'\) \? 'left' : 'right'/);
    });
});

