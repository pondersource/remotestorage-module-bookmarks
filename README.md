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

## Work still required before app migration

This is a read compatibility increment, not complete Solid-backend interoperability. RDF records are explicitly read-only through store/remove. Editing them must preserve unknown triples, document siblings, topic term kinds and Soukai history; converting them to replacement JSON is not an acceptable implementation.

Automatic WebID/type-index discovery, instanceContainer traversal, access outside the module's claimed scope, persisted base-IRI resolution while disconnected, and authenticated Solid-backend browser tests remain to be implemented. Folder enumeration is one level deep. The real-rs.js regression covers the local cache with a deterministic document URL, not Pod login or remote sync. Chromium validation was attempted locally but the browser tool timed out; no passing browser result is claimed.

Next gates:

1. Verify against the actual rs.js Solid build used by the distro, including URL mapping, access scoping, MIME types, ETags and conflicts.
2. Add explicit/discovered Solid document and container sources without bypassing rs.js caching or authentication.
3. Implement lossless updates/deletion and prove original-app readback, including shared-document siblings and Soukai operation history.
4. Real Pod Playwright login, private reads/writes, anonymous denial, clean-browser recovery and offline/conflict checks.
5. Release/consume a pinned tested module and backend before migrating Solid/LWS app forks.
6. Retro-define Atomic schemas from the tested interoperable shapes, then investigate an Atomic rs.js backend against its actual storage API.

No new domain module is introduced. No npm release or app migration is part of this branch.

## Validation and source evidence

Run npm ci && npm test. Tests exercise the production UMD bundle, RDF aliases and identities, mixed JSON/RDF reads, read-only protection, malformed input, legacy JSON CRUD and a real rs.js local cache.

Fixtures bookmark-formats.ttl and bookmark-soukai.ttl are copied from the MIT-licensed bookmarks/vanilla package in [pondersource/data-modules at 793054e](https://github.com/pondersource/data-modules/tree/793054e300c93c566ac778b91cb80a70498240ae/bookmarks/vanilla/test/unit/fixtures). The implementation is intentionally independent of Inrupt's dataset objects; parity is checked against those source fixtures. The Solid modules' pending topic-round-trip work must also be incorporated into the compatibility corpus before claiming complete parity.
