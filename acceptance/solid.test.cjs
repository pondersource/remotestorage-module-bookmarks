const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const app = 'http://localhost:8000/';
const pod = 'http://localhost:3000/sync-test/';
async function wait(url) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(500);
  }
  throw new Error('Test server did not start: ' + url);
}
async function login(page) {
  await page.goto(app);
  await page.locator('#connect').click();
  await page.locator('input[type=email]').fill('solid-test@example.test');
  await page.locator('input[type=password]').fill(process.env.RS_SOLID_TEST_PASSWORD);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('button', { name: 'Authorize', exact: true }).click();
  await page.waitForURL(app);
  await page.waitForFunction(() => document.querySelector('#status').textContent === 'Connected');
}
test('real Solid login, native RDF discovery, module JSON write, private data recovery and offline reads', { timeout: 150000 }, async () => {
  await Promise.all([wait(app), wait('http://localhost:3000/.well-known/openid-configuration')]);
  const browser = await chromium.launch();
  try {
    const firstContext = await browser.newContext();
    const first = await firstContext.newPage();
    const pageErrors = [];
    first.on('pageerror', error => pageErrors.push(error.message));
    await login(first);
    const fixture = readFileSync(__dirname + '/../test/fixtures/bookmark-formats.ttl', 'utf8');
    // Fixture setup writes native RDF through the authenticated backend, not the bookmark parser.
    await first.evaluate(async ({ fixture, pod }) => {
      const { rs } = acceptance;
      async function put(path, text, options) {
        const response = await rs.solid.put(path, text, 'text/turtle', options);
        if (response.statusCode !== 201) throw new Error('Fixture write failed: ' + response.statusCode);
      }
      await put('/bookmarks/native.ttl', fixture, { ifNoneMatch: '*' });
      await put('/bookmarks/native/child.ttl', '@prefix a: <https://www.w3.org/ns/activitystreams#>. <#note> a a:Note; a:name "Activity note"; a:url <https://example.net>; <https://unknown.example/p> "Keep this". <#sibling> a a:Note; a:name "Removable note"; a:url <https://sibling.example>.', { ifNoneMatch: '*' });
      await put('/bookmarks/type-index.ttl', '@prefix s: <http://www.w3.org/ns/solid/terms#>. @prefix b: <http://www.w3.org/2002/01/bookmark#>. <#doc> s:forClass b:Bookmark; s:instance <' + pod + 'bookmarks/native.ttl>. <#container> s:forClass b:Bookmark; s:instanceContainer <' + pod + 'bookmarks/native/>.', { ifNoneMatch: '*' });
      const profile = await rs.solid.get('/profile/card');
      if (profile.statusCode !== 200) throw new Error('Missing profile');
      const triple = '\n<' + rs.solid.getSession().info.webId + '> <http://www.w3.org/ns/solid/terms#privateTypeIndex> <' + pod + 'bookmarks/type-index.ttl>.\n';
      await put('/profile/card', profile.body + triple, { ifMatch: profile.revision });
    }, { fixture, pod });
    async function read(page, offline = false) {
      return page.evaluate(async ({ pod, offline }) => {
        const { rs, client } = acceptance;
        const webId = offline ? localStorage.getItem('test-webid') : rs.solid.getSession().info.webId;
        localStorage.setItem('test-webid', webId);
        const collection = rs.bookmarks.openSolidCollection({ client, webId, storageURL: pod });
        return collection.getAll(offline ? undefined : 0);
      }, { pod, offline });
    }
    let initial = await read(first);
    assert.equal(initial.length, 6);
    assert.equal(new Set(initial.map(b => b.id)).size, 6);
    assert.equal(initial.find(b => b.title === 'sdf').solid.topics[0].termType, 'Literal');
    assert.equal(initial.find(b => b.title === 'Activity note').url, 'https://example.net');
    const anonymous = await fetch(pod + 'bookmarks/native.ttl');
    assert.ok([401, 403, 404].includes(anonymous.status));

    const nativeWrite = first.waitForResponse(r => r.url() === pod + 'bookmarks/native/child.ttl' && r.request().method() === 'PUT' && r.ok() && r.request().postData()?.includes('Edited Activity note'));
    const editable = initial.find(b => b.title === 'Activity note');
    await first.evaluate(async ({ id, pod }) => {
      const { rs, client } = acceptance;
      const collection = rs.bookmarks.openSolidCollection({ client, storageURL: pod });
      await collection.update(id, { title: 'Edited Activity note' });
      await rs.startSync();
    }, { id: editable.id, pod });
    await nativeWrite;
    let raw = await first.evaluate(() => acceptance.rs.solid.get('/bookmarks/native/child.ttl'));
    assert.ok(raw.body.includes('Keep this'));
    assert.ok(raw.body.includes('Removable note'));
    const sibling = initial.find(b => b.title === 'Removable note');
    const nativeDelete = first.waitForResponse(r => r.url() === pod + 'bookmarks/native/child.ttl' && r.request().method() === 'PUT' && r.ok() && !r.request().postData()?.includes('Removable note'));
    await first.evaluate(async ({ id, pod }) => {
      const { rs, client } = acceptance;
      await rs.bookmarks.openSolidCollection({ client, storageURL: pod }).remove(id);
      await rs.startSync();
    }, { id: sibling.id, pod });
    await nativeDelete;
    raw = await first.evaluate(() => acceptance.rs.solid.get('/bookmarks/native/child.ttl'));
    assert.ok(raw.body.includes('Keep this'));
    assert.ok(!raw.body.includes('Removable note'));
    initial = await read(first);
    assert.equal(initial.length, 5);
    assert.equal(initial.find(b => b.id === editable.id).title, 'Edited Activity note');

    const written = first.waitForResponse(r => r.url().includes('/bookmarks/archive/') && r.request().method() === 'PUT' && r.ok());
    await first.evaluate(async () => {
      await acceptance.rs.bookmarks.archive.store({ title: 'Module bookmark', url: 'https://module.example/', tags: ['verified'] });
      await acceptance.rs.startSync();
    });
    const writeResponse = await written;
    assert.ok([401, 403, 404].includes((await fetch(writeResponse.url())).status));
    const secondContext = await browser.newContext();
    const second = await secondContext.newPage();
    await login(second);
    const recovered = await read(second);
    assert.deepEqual(recovered, initial);
    const json = await second.evaluate(() => acceptance.rs.bookmarks.archive.searchByURL('https://module.example/'));
    assert.equal(json.title, 'Module bookmark');
    assert.deepEqual(json.tags, ['verified']);
    await firstContext.setOffline(true);
    assert.deepEqual(await read(first, true), initial);
    assert.deepEqual(pageErrors, []);
    console.log('Verified native RDF records:', recovered.length, 'and module JSON persistence through the pinned Solid backend');
  } finally { await browser.close(); }
});
