const { test } = require('node:test');
const assert = require('node:assert/strict');
const Bookmarks = require('../dist/build');
const { SolidCollection } = require('../src/solid-collection');
const { parseBookmarks } = require('../src/solid-bookmarks');
const base = 'https://pod.example/alice/';
const webId = base + 'profile/card#me';
const profile = '<#me> <http://www.w3.org/ns/solid/terms#privateTypeIndex> </alice/settings/private.ttl>; <http://www.w3.org/ns/solid/terms#publicTypeIndex> </alice/settings/public.ttl>.';
const index = '@prefix s: <http://www.w3.org/ns/solid/terms#>. @prefix b: <http://www.w3.org/2002/01/bookmark#>. <#one> s:forClass b:Bookmark; s:instance </alice/public/bookmarks.ttl>. <#two> s:forClass b:BookMark; s:instanceContainer </alice/links/>.';
const bookmark = '@prefix b: <http://www.w3.org/2002/01/bookmark#>. <#one> a b:Bookmark; b:recalls <https://example.org>; <http://purl.org/dc/terms/title> "Example".';
function client() {
  const files = {
    'profile/card': profile,
    'settings/private.ttl': index,
    'settings/public.ttl': index,
    'public/bookmarks.ttl': bookmark,
    'links/one': bookmark,
    'links/nested/two.ttl': bookmark
  };
  const listings = { 'links/': { one: {}, 'nested/': {} }, 'links/nested/': { 'two.ttl': {} } };
  return {
    files, listings, calls: [],
    async getItemURL(path) { return base + path; },
    async getFile(path, age) { this.calls.push(['getFile', path, age]); return { data: files[path], contentType: 'text/turtle' }; },
    async getListing(path, age) { this.calls.push(['getListing', path, age]); return listings[path]; }
  };
}
test('discovers private/public type indexes, deduplicates sources and walks instance containers', async () => {
  const scoped = client();
  const collection = new SolidCollection({ client: scoped, webId });
  const sources = await collection.discover(100);
  assert.deepEqual(sources.documents, ['public/bookmarks.ttl']);
  assert.deepEqual(sources.containers, ['links/']);
  assert.deepEqual(sources.unresolved, []);
  const all = await collection.getAll(100);
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map(b => b.id)).size, 3);
  assert.ok(scoped.calls.every(call => call[2] === 100));
  assert.ok(all.every(b => b.url === 'https://example.org'));
});
test('reports outside-scope registrations and refuses to return a misleading partial list', async () => {
  const scoped = client();
  scoped.files['settings/private.ttl'] += ' <#external> s:forClass b:Bookmark; s:instance <https://other.example/secret.ttl>.';
  const collection = new SolidCollection({ client: scoped, webId });
  assert.deepEqual((await collection.discover()).unresolved, [{ url: 'https://other.example/secret.ttl', container: false }]);
  await assert.rejects(collection.getAll(), error => error.sources?.[0].url === 'https://other.example/secret.ttl');
  assert.ok(!scoped.calls.some(call => call[1].includes('other.example')));
});
test('explicit documents and containers work without a WebID and with cached URL configuration offline', async () => {
  const scoped = client();
  scoped.getItemURL = async () => undefined;
  const collection = new SolidCollection({ client: scoped, storageURL: base, documents: ['public/bookmarks.ttl'], containers: ['links/'] });
  assert.equal((await collection.getAll()).length, 3);
  assert.ok(!scoped.calls.some(call => call[1].startsWith('profile/')));
  await assert.rejects(new SolidCollection({ client: scoped, documents: ['public/bookmarks.ttl'] }).getAll(), /offline/);
});
test('discovery does not write, register types, or hide inaccessible/missing indexes', async () => {
  const scoped = client();
  delete scoped.files['settings/private.ttl'];
  await assert.rejects(new SolidCollection({ client: scoped, webId }).getAll(), /Missing Solid discovery document/);
  scoped.getFile = async () => { throw new Error('403 Forbidden'); };
  await assert.rejects(new SolidCollection({ client: scoped, webId }).getAll(), /403/);
});
test('enforces depth/resource limits and rejects malformed listing entries', async () => {
  await assert.rejects(new SolidCollection({ client: client(), containers: ['links/'], maxDepth: 0 }).getAll(), /depth limit/);
  await assert.rejects(new SolidCollection({ client: client(), containers: ['links/'], maxResources: 1 }).getAll(), /resource limit/);
  for (const name of ['../secret', '%2e%2e', '%2fsecret', 'nested/file.ttl']) {
    const scoped = client(); scoped.listings['links/'] = { [name]: {} };
    await assert.rejects(new SolidCollection({ client: scoped, containers: ['links/'] }).getAll());
  }
});
test('module document reader awaits asynchronous backend URLs and accepts binary RDF MIME bodies', async () => {
  const scoped = client();
  scoped.declareType = () => {};
  scoped.scope = () => scoped;
  scoped.files['public/bookmarks.ttl'] = new TextEncoder().encode(bookmark).buffer;
  const module = Bookmarks.builder(scoped).exports;
  const all = await module.readDocument('public/bookmarks.ttl');
  assert.equal(all[0].solid.subject, base + 'public/bookmarks.ttl#one');
  assert.equal((await module.openSolidCollection({ client: scoped, documents: ['public/bookmarks.ttl'] }).getAll()).length, 1);
});
test('the deployed Solid backend can return application/n-triples as ArrayBuffer', () => {
  const bytes = new TextEncoder().encode('<https://pod.example/#x> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/01/bookmark#Bookmark>.').buffer;
  assert.equal(parseBookmarks(bytes, { path: 'links/a', baseIRI: base + 'links/a', contentType: 'application/n-triples' }).length, 1);
});
