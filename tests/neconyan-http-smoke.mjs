// Run against a disposable server: NECONYAN_PREVIEW_URL=http://127.0.0.1:4477 node tests/neconyan-http-smoke.mjs
import assert from 'node:assert/strict';
const base = process.env.NECONYAN_PREVIEW_URL || 'http://127.0.0.1:4433';
const jar = new Map();
let csrf;
async function request(path, { method = 'GET', body, redirect = 'follow' } = {}) {
    const response = await fetch(base + path, { method, redirect, headers: { Cookie: [...jar].map(([key,value]) => `${key}=${value}`).join('; '), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? {'Content-Type':'application/json'} : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const raw of response.headers.getSetCookie()) { const pair = raw.split(';')[0]; const at = pair.indexOf('='); jar.set(pair.slice(0,at),pair.slice(at+1)); }
    return response;
}
csrf = (await (await request('/csrf-token')).json()).token;
const root = await request('/');
assert.equal(root.status,200);
const html = await root.text();
assert.match(html, /<title>Neconyan/);
for (const id of ['main_api','chat','send_textarea','extensions_settings','extensions_settings2']) {
    assert.ok(html.includes(`id="${id}"`), `canonical control ${id}`);
}
assert.ok(!html.includes('type="importmap"'), 'full program is not remapped to a subset');
assert.ok(!html.includes('/neconyan/app.js'), 'retired mini-app is not loaded');
const linkedPage = new URL('/?neconyanView=connections', base);
const linkedHtml = await (await request(linkedPage.pathname + linkedPage.search)).text();
const baseHref = linkedHtml.match(/<base[^>]+href=["']([^"']+)/i)?.[1];
const fragment = new URL('#bg_tabs', baseHref ? new URL(baseHref, linkedPage) : linkedPage);
assert.equal(fragment.search, linkedPage.search, 'hash tabs stay on the current page when a workspace link has a query');
for (const path of ['/script.js','/scripts/st-context.js','/scripts/extensions.js','/scripts/tokenizers.js','/img/neconyan.png']) {
    const response = await request(path);
    assert.equal(response.status,200,path);
    await response.arrayBuffer();
}
for (const path of ['/legacy','/characters','/lorebooks','/extensions','/connections','/settings','/chat/Calico.png?branchId=test&personaId=User']) {
    const response=await request(path,{redirect:'manual'});
    assert.ok(response.status>=300 && response.status<400,`${path} redirects`);
    assert.ok(response.headers.get('location')?.startsWith('/'), 'same-site redirect');
    await response.arrayBuffer();
}
const callback = await request('/callback/openrouter?code=local-fixture', {redirect:'manual'});
const callbackUrl = new URL(callback.headers.get('location'), base);
await callback.arrayBuffer();
assert.equal(callbackUrl.pathname, '/');
assert.equal(callbackUrl.searchParams.get('source'), 'openrouter');
assert.equal(new URLSearchParams(callbackUrl.searchParams.get('query')).get('code'), 'local-fixture');
const discover=await request('/api/extensions/discover');
assert.equal(discover.status,200);
const extensions=await discover.json();
assert.ok(extensions.some(x=>x.name==='connection-manager'));
assert.ok(extensions.some(x=>x.name==='quick-image-gen'));
assert.equal(extensions.filter(x=>x.type==='native').length,17);
assert.ok(!extensions.some(x=>['memory','stable-diffusion'].includes(x.name)));
for (const path of ['/scripts/extensions/memory/manifest.json','/scripts/extensions/stable-diffusion/manifest.json','/scripts/extensions/tts/coqui.js']) {
    const response=await request(path);
    assert.equal(response.status,404,path);
    await response.arrayBuffer();
}
console.log(`PASS full frontend, module URLs, aliases, and ${extensions.length} extension manifests on ${base}`);
