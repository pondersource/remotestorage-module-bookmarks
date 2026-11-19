const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DataFactory } = require('n3');
const { SolidCollection } = require('../src/solid-collection');
const { parseDataset } = require('../src/solid-bookmarks');
const base = 'https://pod.example/';
const initial = '@prefix b: <http://www.w3.org/2002/01/bookmark#>. @prefix d: <http://purl.org/dc/terms/>. <#one> a b:Bookmark; d:title "One"; b:recalls "https://one.example/"; b:hasTopic <https://topic.example/>, "https://topic.example/"; <https://unknown.example/p> "keep me". <#two> a b:Bookmark; d:title "Two"; b:recalls <https://two.example/>.';
function setup(text = initial) {
  const client = {
    text, writes: 0,
    async getItemURL(path) { return base + path; },
    async getFile() { return { data: this.text, contentType: 'text/turtle' }; },
    async storeFile(type, path, data) { this.text = data; this.writes++; }
  };
  return { client, collection: new SolidCollection({ client, documents: ['bookmarks.ttl'] }) };
}
test('updates through rs.js file operations, retaining siblings, unknown triples and literal link form', async () => {
  const { client, collection } = setup();
  const all = await collection.getAll();
  const one = all.find(b => b.title === 'One');
  const updated = await collection.update(one.id, { title: 'Changed "title"\nnext line', url: 'https://changed.example/' });
  assert.equal(updated.title, 'Changed "title"\nnext line');
  assert.equal(updated.id, one.id);
  assert.deepEqual(updated.solid.topics, one.solid.topics);
  const store = parseDataset(client.text, base + 'bookmarks.ttl');
  const subject = DataFactory.namedNode(base + 'bookmarks.ttl#one');
  assert.equal(store.getObjects(subject, DataFactory.namedNode('http://www.w3.org/2002/01/bookmark#recalls'), null)[0].termType, 'Literal');
  assert.equal(store.getObjects(subject, DataFactory.namedNode('https://unknown.example/p'), null)[0].value, 'keep me');
  assert.equal((await collection.getAll()).find(b => b.title === 'Two').url, 'https://two.example/');
});
test('typed topic round trips preserve IRI versus literal, datatype and language', async () => {
  const { collection } = setup();
  const one = (await collection.getAll())[0];
  const topics = [
    { termType: 'NamedNode', value: 'https://topic.example/' },
    { termType: 'Literal', value: 'https://topic.example/', datatype: 'http://www.w3.org/2001/XMLSchema#string', language: '' },
    { termType: 'Literal', value: 'bonjour', language: 'fr', datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString' }
  ];
  assert.deepEqual((await collection.update(one.id, { topics })).solid.topics, topics);
});
test('serializes simultaneous edits to siblings in a shared document', async () => {
  const { collection } = setup();
  const all = await collection.getAll();
  await Promise.all(all.map(b => collection.update(b.id, { title: b.title + ' edited' })));
  assert.deepEqual((await collection.getAll()).map(b => b.title).sort(), ['One edited', 'Two edited']);
});
test('removes only one subject, retaining the shared document and its sibling', async () => {
  const { collection, client } = setup();
  const all = await collection.getAll();
  assert.equal(await collection.remove(all[0].id), true);
  assert.equal((await collection.getAll()).length, 1);
  assert.equal((await collection.getAll())[0].id, all[1].id);
  assert.equal(client.writes, 1);
});
test('rejects history-bearing documents, unsupported edits and invalid terms before writing', async () => {
  const source = fs.readFileSync(__dirname + '/fixtures/bookmark-soukai.ttl', 'utf8');
  const { client, collection } = setup(source);
  const bookmark = (await collection.getAll())[0];
  await assert.rejects(collection.update(bookmark.id, { title: 'Changed' }), /history/);
  await assert.rejects(collection.remove(bookmark.id), /history/);
  assert.equal(client.writes, 0);
  const ordinary = setup();
  const id = (await ordinary.collection.getAll())[0].id;
  for (const changes of [{ tags: ['x'] }, { url: 'not an IRI' }, { topics: ['x'] }, { creator: 'https://bad.example/\n' }]) {
    await assert.rejects(ordinary.collection.update(id, changes));
  }
  assert.equal(ordinary.client.writes, 0);
});
test('failed writes are propagated and do not poison the next operation', async () => {
  const { collection, client } = setup();
  const id = (await collection.getAll())[0].id;
  const write = client.storeFile;
  client.storeFile = async () => { throw new Error('Write failed'); };
  await assert.rejects(collection.update(id, { title: 'Failed' }), /Write failed/);
  client.storeFile = write;
  assert.equal((await collection.update(id, { title: 'Retry' })).title, 'Retry');
});
