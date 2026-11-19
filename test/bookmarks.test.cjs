const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Bookmarks = require('../dist/build');
const { parseBookmarks, decodeReference } = require('../src/solid-bookmarks');
const formats = fs.readFileSync(__dirname + '/fixtures/bookmark-formats.ttl', 'utf8');
const baseIRI = 'https://pod.example/bookmarks/archive/index.ttl';
function fixtureClient(files = {}) {
  const calls = [];
  return {
    files, calls,
    declareType() {}, scope() { return this; },
    getItemURL(path) { return 'https://pod.example/bookmarks/' + path; },
    async getListing(path, maxAge) {
      calls.push(['listing', path, maxAge]);
      return Object.fromEntries(Object.keys(files).filter(key => key.startsWith(path)).map(key => [key.slice(path.length), {}]));
    },
    async getFile(path, maxAge) { calls.push(['file', path, maxAge]); return files[path] || {}; },
    async getObject(path) { return files[path]?.data; },
    async storeObject(type, path, data) { calls.push(['store', type, path]); files[path] = { data }; },
    async remove(path) { calls.push(['remove', path]); delete files[path]; }
  };
}
test('reads all four source fixture bookmarks and Soukai dates, not metadata as a bookmark', () => {
  const all = parseBookmarks(formats, { path: 'archive/index.ttl', baseIRI });
  assert.equal(all.length, 4);
  assert.equal(all.find(b => b.title === 'one').creator, 'https://michielbdejong.solidcommunity.net/profile/card#me');
  assert.equal(all.find(b => b.title === 'two').url, 'http://example.com');
  const soukai = all.find(b => b.title === 'sdf');
  assert.equal(soukai.createdAt, '2023-11-21T12:50:32.051Z');
  assert.equal(soukai.updatedAt, soukai.createdAt);
  assert.deepEqual(soukai.tags, ['sdfg']);
});
test('supports legacy BookMark and ActivityStreams Note, relative IRIs and mixed topic term kinds', () => {
  const text = '@prefix b: <http://www.w3.org/2002/01/bookmark#>. @prefix a: <https://www.w3.org/ns/activitystreams#>. <#old> a b:BookMark; b:recalls <https://example.org>. <#note> a a:Note; a:name "Note"; a:url <https://example.net>; a:actor <https://person.example/#me>; a:published "2024-01-01"; b:hasTopic <https://topic.example/>, "https://topic.example/", "bonjour"@fr.';
  const all = parseBookmarks(text, { path: 'archive/index.ttl', baseIRI });
  assert.equal(all.length, 2);
  const note = all.find(b => b.title === 'Note');
  assert.equal(note.solid.subject, baseIRI + '#note');
  assert.equal(note.creator, 'https://person.example/#me');
  assert.equal(note.createdAt, '2024-01-01');
  assert.deepEqual(note.solid.topics.map(t => t.termType), ['NamedNode', 'Literal', 'Literal']);
  assert.equal(note.solid.topics[2].language, 'fr');
  assert.deepEqual(decodeReference(note.id), ['archive/index.ttl', baseIRI + '#note']);
});
test('existing folder API reads mixed RDF and JSON through scoped rs.js file calls', async () => {
  const original = { id: 'json-id', url: 'https://json.example', title: 'JSON', tags: ['json'] };
  const client = fixtureClient({
    'archive/index.ttl': { data: formats, contentType: 'text/turtle; charset=utf-8' },
    'archive/json-id': { data: original, contentType: 'application/json' }
  });
  const module = Bookmarks.builder(client).exports;
  const all = await module.archive.getAll(1234);
  assert.equal(all.length, 5);
  assert.deepEqual(all.find(b => b.id === 'json-id'), original);
  assert.ok(client.calls.filter(c => c[0] === 'file').every(c => c[2] === 1234));
  assert.deepEqual(await module.archive.get(all[0].id), all[0]);
  assert.ok(await module.archive.searchByURL('http://example.com'));
  assert.equal((await module.archive.searchByTags(['sdfg'])).length, 1);
});
test('distinct RDF subjects with the same target retain distinct stable identities', () => {
  const all = parseBookmarks(formats, { path: 'archive/index.ttl', baseIRI });
  assert.equal(new Set(all.map(b => b.id)).size, 4);
  assert.equal(new Set(all.map(b => b.url)).size, 1);
  assert.deepEqual(all.map(b => b.id), parseBookmarks(formats, { path: 'archive/index.ttl', baseIRI }).map(b => b.id));
});
test('rejects RDF edits/deletes before any JSON write and leaves original document intact', async () => {
  const client = fixtureClient({ 'archive/index.ttl': { data: formats, contentType: 'text/turtle' } });
  const module = Bookmarks.builder(client).exports;
  const bookmark = (await module.archive.getAll())[0];
  await assert.rejects(module.archive.store({ ...bookmark, title: 'Changed' }), /read-only/);
  await assert.rejects(module.archive.remove(bookmark.id), /read-only/);
  assert.equal(client.files['archive/index.ttl'].data, formats);
  assert.equal(client.calls.filter(c => ['store', 'remove'].includes(c[0])).length, 0);
});
test('retains legacy JSON write/read/delete behaviour', async () => {
  const client = fixtureClient();
  const module = Bookmarks.builder(client).exports;
  const saved = await module.archive.store({ url: 'https://example.org', title: 'Example', tags: [] });
  assert.match(saved.id, /^[0-9a-f]{32}$/);
  assert.equal((await module.archive.get(saved.id)).title, 'Example');
  await module.archive.remove(saved.id);
  assert.equal(await module.archive.get(saved.id), undefined);
});
test('propagates malformed RDF and fetch failures instead of reporting an empty collection', async () => {
  const client = fixtureClient({ 'archive/bad.ttl': { data: 'not turtle at all!', contentType: 'text/turtle' } });
  await assert.rejects(Bookmarks.builder(client).exports.archive.getAll());
  client.getFile = async () => { throw new Error('Forbidden'); };
  await assert.rejects(Bookmarks.builder(client).exports.readDocument('archive/bad.ttl'), /Forbidden/);
});
test('rejects absolute paths and traversal outside the module scope', async () => {
  const module = Bookmarks.builder(fixtureClient()).exports;
  for (const path of ['../secret.ttl', '%2e%2e/secret.ttl', '/secret.ttl', 'https://pod.example/secret.ttl']) {
    await assert.rejects(module.readDocument(path), /relative/);
  }
});

test('reads RDF from the real rs.js local cache without making a direct fetch', { timeout: 5000 }, async () => {
  const RemoteStorage = require('remotestoragejs');
  const rs = new RemoteStorage({ modules: [Bookmarks] });
  rs.access.claim('bookmarks', 'rw');
  rs.caching.enable('/bookmarks/');
  let started = false;
  await new Promise((resolve, reject) => rs.on('ready', () => {
    if (started) return;
    started = true;
    resolve();
  }));
  try {
    // Supply the selected Pod URL deterministically; this test does not fake an authenticated session.
    rs.bookmarks.client.getItemURL = path => 'https://pod.example/bookmarks/' + path;
    await rs.bookmarks.client.storeFile('text/turtle', 'archive/index.ttl', formats);
    const all = await rs.bookmarks.archive.getAll();
    assert.equal(all.length, 4);
    assert.deepEqual(await rs.bookmarks.archive.get(all[0].id), all[0]);
    assert.equal((await rs.bookmarks.client.getFile('archive/index.ttl')).data, formats);
  } finally {
    await rs.disconnect();
  }
});
