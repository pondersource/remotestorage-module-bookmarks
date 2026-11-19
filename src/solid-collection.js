const { DataFactory } = require('n3');
const { parseBookmarks, parseDataset, isRdf, types, validatePath, decodeReference } = require('./solid-bookmarks');
const { namedNode } = DataFactory;
const SOLID = 'http://www.w3.org/ns/solid/terms#';

// All network/storage access stays behind the supplied rs.js scoped client.
// A root-scoped client can discover same-Pod resources outside /bookmarks/.
class SolidCollection {
  constructor({ client, webId, storageURL, documents = [], containers = [], maxDepth = 8, maxResources = 1000 } = {}) {
    if (!client) throw new Error('A scoped rs.js client is required');
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || !Number.isInteger(maxResources) || maxResources < 1) {
      throw new Error('Invalid discovery limits');
    }
    Object.assign(this, { client, webId, storageURL, documents, containers, maxDepth, maxResources });
  }

  async baseURL() {
    const actual = await this.client.getItemURL('');
    if (this.storageURL && actual && new URL(this.storageURL).href !== new URL(actual).href) {
      throw new Error('storageURL does not match the supplied client scope');
    }
    const value = this.storageURL || actual;
    if (!value) throw new Error('Supply storageURL when reopening a cached Solid collection offline');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
      throw new Error('storageURL must be the absolute directory URL of the supplied client scope');
    }
    return url.href;
  }

  pathFor(value, base, container = false) {
    const url = new URL(value, base);
    url.hash = '';
    if (!url.href.startsWith(base) || url.search || url.username || url.password) return null;
    const relative = url.href.slice(base.length);
    const path = container ? relative.replace(/\/$/, '') : relative;
    if (!path && container) return '';
    validatePath(path);
    return container ? path + '/' : path;
  }

  async dataset(path, base, maxAge) {
    const file = await this.client.getFile(path, maxAge);
    if (file.data === undefined || file.data === null) throw new Error('Missing Solid discovery document: ' + path);
    if (!isRdf(file.contentType)) throw new Error('Expected RDF in Solid discovery document: ' + path);
    return parseDataset(file.data, new URL(path, base).href, file.contentType);
  }

  async discover(maxAge) {
    const base = await this.baseURL();
    const documents = new Set();
    const containers = new Set();
    const unresolved = [];
    const add = (value, container = false) => {
      const path = this.pathFor(value, base, container);
      if (path === null) {
        if (!unresolved.some(item => item.url === value && item.container === container)) unresolved.push({ url: value, container });
      } else (container ? containers : documents).add(path);
    };
    this.documents.forEach(value => add(value));
    this.containers.forEach(value => add(value, true));

    if (this.webId) {
      const profilePath = this.pathFor(this.webId, base);
      if (profilePath === null) throw new Error('WebID is outside the supplied client scope; supply a root-scoped client or explicit sources');
      const profile = await this.dataset(profilePath, base, maxAge);
      const indexes = new Set();
      for (const predicate of ['privateTypeIndex', 'publicTypeIndex']) {
        for (const object of profile.getObjects(namedNode(this.webId), namedNode(SOLID + predicate), null)) {
          if (object.termType === 'NamedNode') indexes.add(object.value);
        }
      }
      for (const index of indexes) {
        const path = this.pathFor(index, base);
        if (path === null) { unresolved.push({ url: index, typeIndex: true }); continue; }
        const dataset = await this.dataset(path, base, maxAge);
        for (const type of types) {
          for (const registration of dataset.getSubjects(namedNode(SOLID + 'forClass'), namedNode(type), null)) {
            for (const predicate of ['instance', 'instanceContainer']) {
              for (const object of dataset.getObjects(registration, namedNode(SOLID + predicate), null)) {
                if (object.termType === 'NamedNode') add(object.value, predicate === 'instanceContainer');
              }
            }
          }
        }
      }
    }
    return { storageURL: base, documents: [...documents], containers: [...containers], unresolved };
  }

  async getAll(maxAge) {
    const sources = await this.discover(maxAge);
    if (sources.unresolved.length) {
      const error = new Error('Some Solid sources are outside the supplied client scope');
      error.sources = sources.unresolved;
      throw error;
    }
    const documents = new Set(sources.documents);
    const seen = new Set();
    const queue = sources.containers.map(path => ({ path, depth: 0 }));
    let count = documents.size;
    const limit = () => { if (count > this.maxResources) throw new Error('Solid discovery resource limit exceeded'); };
    limit();
    while (queue.length) {
      const { path, depth } = queue.shift();
      if (seen.has(path)) continue;
      seen.add(path);
      if (depth > this.maxDepth) throw new Error('Solid discovery depth limit exceeded');
      count++;
      limit();
      const listing = await this.client.getListing(path, maxAge);
      if (!listing || typeof listing !== 'object' || Array.isArray(listing)) throw new Error('Invalid Solid container listing');
      for (const name of Object.keys(listing)) {
        const isContainer = name.endsWith('/');
        const part = isContainer ? name.slice(0, -1) : name;
        if (part.includes('/')) throw new Error('Invalid nested entry in Solid container listing');
        validatePath(part);
        const child = path + name;
        if (isContainer) queue.push({ path: child, depth: depth + 1 });
        else if (!documents.has(child)) { documents.add(child); count++; limit(); }
      }
    }
    const bookmarks = new Map();
    for (const path of documents) {
      const file = await this.client.getFile(path, maxAge);
      if (file.data === undefined || file.data === null) throw new Error('Missing Solid bookmark document: ' + path);
      if (!isRdf(file.contentType)) continue;
      for (const bookmark of parseBookmarks(file.data, { path, baseIRI: new URL(path, sources.storageURL).href, contentType: file.contentType })) {
        bookmarks.set(bookmark.id, bookmark);
      }
    }
    return [...bookmarks.values()];
  }

  async update(id, changes) {
    const ref = decodeReference(id);
    if (!ref) throw new Error('Expected a Solid bookmark reference');
    const base = await this.baseURL();
    return require('./solid-update').mutate(this.client, id, changes, new URL(ref[0], base).href);
  }

  async remove(id) {
    const ref = decodeReference(id);
    if (!ref) throw new Error('Expected a Solid bookmark reference');
    const base = await this.baseURL();
    return require('./solid-update').mutate(this.client, id, undefined, new URL(ref[0], base).href, true);
  }
}

module.exports = { SolidCollection };
