# Bookmarks module: Solid compatibility work

Fork of [raucao/remotestorage-module-bookmarks](https://github.com/raucao/remotestorage-module-bookmarks). Existing JSON bookmark operations remain supported.

## Implemented in this branch

The existing folder getAll, get and search operations can read Turtle/RDF bookmarks alongside remoteStorage JSON bookmarks. Reads use the scoped rs.js getListing/getFile API, so the module does not establish another authentication session or fetch Pod files directly.

Supported RDF types: bookmark:Bookmark, legacy bookmark:BookMark, and ActivityStreams Note. Field aliases follow the Solid Data Modules vanilla reader: dc:title/rdfs:label/as:name, bookmark:recalls/as:url, dc:creator/as:actor/foaf:maker, creation/update timestamps and Soukai metadata linked through crdt:resource. All topics are retained with term kind, datatype and language in solid.topics; tags exposes their string values for existing consumers.

Each RDF bookmark has a stable opaque id encoding document path and subject IRI. Its url is the bookmarked target, while solid.subject is the RDF identity. Several bookmarks in one document, including several with the same target, remain distinct. Do not replace these ids with URL hashes.

Read one known document relative to the private bookmarks scope:

    await rs.bookmarks.readDocument('index.ttl');

Or enumerate documents in an existing folder:

    await rs.bookmarks.openFolder('archive').getAll();

RDF files must have a supported RDF content type. A selected backend must supply the document URL through client.getItemURL so relative RDF identifiers resolve correctly. Missing base URLs fail explicitly. JSON writes retain the existing format and URL-hash identities.

### Discover native Solid collections

```js
const client = rs.scope('/'); // Declare permissions and caching for the source scopes in your app.
const collection = rs.bookmarks.openSolidCollection({
  client,
  webId: rs.solid.getSession().info.webId,
  storageURL: rs.solid.getPodURL()
});
const sources = await collection.discover();
const bookmarks = await collection.getAll();
```

The client must cover the WebID profile and registered sources. Discovery reads private/public type indexes, recognizes Bookmark, BookMark and ActivityStreams Note registrations, deduplicates documents, and traverses instance containers. No type registrations or default documents are created merely by reading. Outside-scope sources are returned in `discover().unresolved`; `getAll()` rejects with those sources rather than silently returning an incomplete list. Missing or inaccessible indexes also fail explicitly. Traversal defaults to eight nested container levels and 1,000 resources; exceeding either limit fails.

Known sources can be used without a WebID:

```js
const collection = rs.bookmarks.openSolidCollection({
  client,
  storageURL: savedPodURL,
  documents: ['public/bookmarks.ttl'],
  containers: ['links/']
});
```

`storageURL` is the URL corresponding to the supplied client's scope, not always the Pod root. Persist it with your app's source configuration so cached RDF resolves to the same identities while disconnected. When connected, it must agree with the client's URL. Enable rs.js caching for the profile, indexes and discovered source scopes needed offline. The module awaits the current backend's asynchronous `getItemURL()` and accepts its binary ArrayBuffer representation of non-text RDF MIME types.

### Explicit RDF updates

```js
await collection.update(bookmark.id, { title: 'Updated title' });
await collection.update(bookmark.id, {
  topics: [
    { termType: 'NamedNode', value: 'https://example.org/topics/work' },
    { termType: 'Literal', value: 'work', language: '' }
  ]
});
await collection.remove(bookmark.id);
```

These operations use rs.js `getFile`/`storeFile` and preserve unrelated triples, sibling subjects, RDF types and supported field aliases. URL changes retain an existing literal link's term kind. Topic updates require explicit RDF terms, preserving the distinction between an IRI and an identical-looking literal. Removing one bookmark edits its document rather than deleting the document. Same-client edits to sibling subjects are serialized. Remote conflicts remain the rs.js sync engine's responsibility; a resolved local write is not a remote persistence acknowledgement.

Writes currently cover Turtle and N-Triples, and the `title`, `url`, `creator`, `topics` fields. Multilingual title edits require a language-aware editor and reject. Documents containing Soukai CRDT predicates reject update/delete until history-aware operations exist. The projected `solid.writeSupport` indicates `history-required` versus `explicit-update`; it does not promise support for every RDF serialization. The legacy `Folder.store/remove` interface continues to reject RDF records instead of converting them into JSON. Use IDs with the same scoped collection that produced them.

## Work still required before app migration

This remains an interoperability draft. Native RDF creation, Soukai operation-history writes, cross-Pod source routing, application-level conflict resolution, and original-app readback still need work before replacing existing application storage.

Read/discovery, JSON persistence, private-access denial, fresh-browser recovery and offline checks passed against the launcher's `c0f41cb89aba7e45524897e7d7fde190f6d57144` build ([run 44555139839](https://github.com/pondersource/remotestorage-module-bookmarks/actions/runs/44555139839)). Consecutive native RDF edits exposed a sync bug: CSS accepted an update with HTTP 205 but no ETag, then the next update used a creation precondition and failed with 412.

The current workflow builds `pondersource/remotestorage.js` at `b918b45f00598a9c219519b566a583344fb8f6ce`: that exact launcher baseline plus the focused [ETag-less acknowledgement fix, PR 6](https://github.com/pondersource/remotestorage.js/pull/6). It also runs the sync unit suite. This dependency has not been adopted by the production launcher.

The browser test uses disposable CSS accounts and checks login, discovery, RDF edits/deletion, JSON module writes, private-access denial, clean-browser recovery, offline reads and concurrent edits. The conflict test checks that rs.js exposes local, remote and last-common RDF bodies and keeps the newer Pod version intact; it does not claim automatic RDF merging. Check the current PR's `solid` job for the outcome; adding the test is not evidence that it passed. Local Chromium launch was unavailable. Folder enumeration remains one level deep; the explicit Solid collection supports recursive registered containers.

Next gates:

1. Pass and review the real Solid-backend acceptance workflow and design application-level conflict resolution.
2. Implement native RDF creation and history-aware Soukai operations without replacing existing formats.
3. Prove original-app readback and support the remaining source/format cases.
4. Complete real Pod/offline round trips for each consumer app's actual model.
5. Release/consume a pinned tested module and backend before migrating Solid/LWS app forks.
6. Retro-define Atomic schemas from the tested interoperable shapes, then investigate an Atomic rs.js backend against its actual storage API.

No new domain module is introduced. No npm release or app migration is part of this branch.

## Validation and source evidence

Run npm ci && npm test. Twenty-two local regressions pass, covering the production UMD bundle, discovery, RDF aliases and identities, mixed JSON/RDF reads, typed-topic round trips, sibling/unknown-triple preservation, read-only history protection, malformed input, legacy JSON CRUD and a real rs.js local cache.

Fixtures bookmark-formats.ttl and bookmark-soukai.ttl are copied from the MIT-licensed bookmarks/vanilla package in [pondersource/data-modules at 793054e](https://github.com/pondersource/data-modules/tree/793054e300c93c566ac778b91cb80a70498240ae/bookmarks/vanilla/test/unit/fixtures). The implementation is intentionally independent of Inrupt's dataset objects; parity is checked against those source fixtures. The Solid modules' pending topic-round-trip work must also be incorporated into the compatibility corpus before claiming complete parity.
