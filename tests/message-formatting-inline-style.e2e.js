/* global document, getComputedStyle, CSS */
import { expect, test } from '@playwright/test';

test.describe('message formatting inline styles', () => {
    test('preserves safe inline CSS effects and strips dangerous CSS from rendered message spans', async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 0 });

        const result = await page.evaluate(async () => {
            const mod = await import('/script.js');
            const html = mod.messageFormatting(
                [
                    '<span id="scale-stretch" style="display:inline-block;transform:scaleX(1.2);transform-origin:left center;opacity:0.7;text-shadow:2px 2px red;background:url(javascript:alert(1));">scaled</span>',
                    '<span id="font-stretch" style="display:inline-block;font-stretch:expanded;opacity:0.7;text-shadow:2px 2px red;background:url(javascript:alert(1));">stretched</span>',
                ].join(' '),
                'Bob',
                false,
                false,
                123,
                {},
                false,
            );

            const host = document.createElement('div');
            host.style.position = 'fixed';
            host.style.left = '0';
            host.style.top = '0';
            host.innerHTML = html;
            document.body.appendChild(host);
            const scaleStretch = host.querySelector('#user-content-scale-stretch');
            const fontStretch = host.querySelector('#user-content-font-stretch');
            const scaleStyle = scaleStretch?.getAttribute('style') ?? '';
            const fontStretchStyle = fontStretch?.getAttribute('style') ?? '';
            const scaleComputed = scaleStretch ? getComputedStyle(scaleStretch) : null;
            const fontStretchComputed = fontStretch ? getComputedStyle(fontStretch) : null;

            return {
                html,
                scaleStyle,
                scaleDisplay: scaleComputed?.display ?? null,
                scaleTransform: scaleComputed?.transform ?? null,
                scaleOpacity: scaleComputed?.opacity ?? null,
                scaleTextShadow: scaleComputed?.textShadow ?? null,
                scaleBackgroundImage: scaleComputed?.backgroundImage ?? null,
                fontStretchStyle,
                fontStretchDisplay: fontStretchComputed?.display ?? null,
                fontStretchValue: fontStretchComputed?.fontStretch ?? null,
                fontStretchOpacity: fontStretchComputed?.opacity ?? null,
                fontStretchTextShadow: fontStretchComputed?.textShadow ?? null,
                fontStretchBackgroundImage: fontStretchComputed?.backgroundImage ?? null,
            };
        });

        expect(result.html).toContain('style="');
        expect(result.scaleStyle).toContain('display:inline-block');
        expect(result.scaleStyle).toContain('transform:scaleX(1.2)');
        expect(result.scaleStyle).toContain('transform-origin:left center');
        expect(result.scaleStyle).toContain('opacity:0.7');
        expect(result.scaleStyle).toContain('text-shadow:2px 2px red');
        expect(result.scaleDisplay).toBe('inline-block');
        expect(result.scaleTransform).not.toBe('none');
        expect(result.scaleOpacity).toBe('0.7');
        expect(result.scaleTextShadow).not.toBe('none');
        expect(result.scaleBackgroundImage).toBe('none');

        expect(result.fontStretchStyle).toContain('display:inline-block');
        expect(result.fontStretchStyle).toContain('font-stretch:expanded');
        expect(result.fontStretchStyle).toContain('opacity:0.7');
        expect(result.fontStretchStyle).toContain('text-shadow:2px 2px red');
        expect(result.fontStretchDisplay).toBe('inline-block');
        expect(result.fontStretchValue).toBe('125%');
        expect(result.fontStretchOpacity).toBe('0.7');
        expect(result.fontStretchTextShadow).not.toBe('none');
        expect(result.fontStretchBackgroundImage).toBe('none');
    });

    test('keeps labels, ARIA, image maps and SVG paint pointing at ids after they gain the user-content- prefix', async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 0 });

        const result = await page.evaluate(async () => {
            const mod = await import('/script.js');
            const html = mod.messageFormatting(
                [
                    '<input type="checkbox" id="tab-a" class="toggle"><label for="tab-a" id="tab-label">Open</label>',
                    '<div class="panel" aria-labelledby="tab-label tab-hint"><span id="tab-hint">Hint</span></div>',
                    '<svg width="40" height="20"><defs><linearGradient id="grad"><stop offset="0" stop-color="rgb(0, 128, 0)"/></linearGradient><clipPath id="clip"><rect width="10" height="10"/></clipPath></defs>',
                    '<rect id="paint-rect" width="20" height="20" fill="url(#grad)" style="clip-path: url(#clip)"/></svg>',
                    '<img id="map-img" usemap="#spots" src="/img/logo.png"><map name="spots"><area id="spot" href="#tab-a" shape="rect" coords="0,0,1,1"></map>',
                    '<style>.toggle:checked ~ .panel { color: rgb(1, 2, 3); } #paint-rect { stroke: url(#grad); }</style>',
                ].join(''),
                'Bob',
                false,
                false,
                123,
                {},
                false,
            );

            const host = document.createElement('div');
            host.className = 'mes_text';
            host.style.position = 'fixed';
            host.style.left = '0';
            host.style.top = '0';
            host.innerHTML = html;
            document.body.appendChild(host);
            try {
                const label = host.querySelector('label');
                const checkbox = host.querySelector('input[type="checkbox"]');
                label.click();
                const referenced = (attribute, element) => (element?.getAttribute(attribute) ?? '').trim().split(/\s+/).every(id => id && host.querySelector(`[id="${CSS.escape(id)}"]`));
                const urlTarget = value => {
                    const id = /url\(\s*['"]?#([^'")\s]+)/.exec(value ?? '')?.[1];
                    return Boolean(id && host.querySelector(`[id="${CSS.escape(id)}"]`));
                };
                const rect = host.querySelector('rect[fill]');
                const map = host.querySelector('map');
                const usemap = host.querySelector('img')?.getAttribute('usemap') ?? '';
                return {
                    checkboxId: checkbox?.id ?? null,
                    checkedByLabel: checkbox?.checked ?? false,
                    labelFor: label?.htmlFor ?? null,
                    ariaLabelled: referenced('aria-labelledby', host.querySelector('[aria-labelledby]')),
                    fillTarget: urlTarget(rect?.getAttribute('fill')),
                    clipTarget: urlTarget(rect?.getAttribute('style')),
                    strokeTarget: urlTarget(getComputedStyle(rect).stroke),
                    usemapMatches: usemap === `#${map?.getAttribute('name')}`,
                    areaTarget: Boolean(host.querySelector(`[id="${CSS.escape((host.querySelector('area')?.getAttribute('href') ?? '').slice(1))}"]`)),
                };
            } finally {
                host.remove();
            }
        });

        expect(result).toEqual({
            checkboxId: 'user-content-tab-a',
            checkedByLabel: true,
            labelFor: 'user-content-tab-a',
            ariaLabelled: true,
            fillTarget: true,
            clipTarget: true,
            strokeTarget: true,
            usemapMatches: true,
            areaTarget: true,
        });
    });
});
