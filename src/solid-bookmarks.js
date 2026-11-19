// RDF compatibility for the existing remoteStorage bookmarks API.
const { Parser, Store, DataFactory } = require('n3');
const { namedNode } = DataFactory;
const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  bookmark: 'http://www.w3.org/2002/01/bookmark#',
  dc: 'http://purl.org/dc/terms/',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  as: 'https://www.w3.org/ns/activitystreams#',
  foaf: 'http://xmlns.com/foaf/0.1/',
  crdt: 'http://soukai-solid.com/crdt/'
};
const types = [NS.bookmark + 'Bookmark', NS.bookmark + 'BookMark', NS.as + 'Note'];
const PREFIX = 'solid-rdf:';

function reference(path, subject) {
  return PREFIX + encodeURIComponent(JSON.stringify([path, subject]));
}
function decodeReference(id) {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) return null;
  const result = JSON.parse(decodeURIComponent(id.slice(PREFIX.length)));
  if (!Array.isArray(result) || result.length !== 2 || result.some(x => typeof x !== 'string')) {
    throw new Error('Invalid Solid bookmark reference');
  }
  validatePath(result[0]);
  return result;
}
function validatePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || /[?#]/.test(path) ||
      path.split('/').some(part => !part || ['.', '..'].includes(decodeURIComponent(part))) ||
      /^[a-z][a-z0-9+.-]*:/i.test(path) || /[\\]/.test(path)) {
    throw new Error('Expected a file path relative to the bookmarks module scope');
  }
  return path;
}
function isRdf(contentType) {
  return ['text/turtle', 'application/n-triples', 'text/n3', 'application/trig', 'application/n-quads']
    .includes((contentType || '').split(';')[0].trim().toLowerCase());
}
function parseBookmarks(text, { path, baseIRI, contentType = 'text/turtle' }) {
  validatePath(path);
  if (!baseIRI) throw new Error('A document base IRI is required for relative RDF identifiers');
  const store = new Store(new Parser({ baseIRI, format: contentType.split(';')[0] }).parse(text));
  const values = (subject, predicate) => store.getObjects(subject, namedNode(predicate), null);
  const first = (subject, predicates, termTypes) => {
    for (const predicate of predicates) {
      const term = values(subject, predicate).find(value => termTypes.includes(value.termType));
      if (term) return term.value;
    }
  };
  const subjects = new Map();
  for (const type of types) {
    for (const subject of store.getSubjects(namedNode(NS.rdf + 'type'), namedNode(type), null)) {
      if (subject.termType === 'NamedNode') subjects.set(subject.value, subject);
    }
  }
  return [...subjects.values()].map(subject => {
    const literal = predicates => first(subject, predicates, ['Literal']);
    const iri = predicates => first(subject, predicates, ['NamedNode']);
    const topics = values(subject, NS.bookmark + 'hasTopic').map(term => ({
      value: term.value, termType: term.termType,
      ...(term.termType === 'Literal' && { language: term.language, datatype: term.datatype.value })
    }));
    const metadata = store.getSubjects(namedNode(NS.crdt + 'resource'), subject, null);
    const meta = predicates => metadata.map(s => first(s, predicates, ['Literal'])).find(Boolean);
    const bookmark = {
      id: reference(path, subject.value),
      url: first(subject, [NS.bookmark + 'recalls', NS.as + 'url'], ['Literal', 'NamedNode']) || '',
      title: literal([NS.dc + 'title', NS.rdfs + 'label', NS.as + 'name']) || '',
      tags: topics.map(topic => topic.value),
      solid: { subject: subject.value, document: baseIRI, path, topics, readOnly: true }
    };
    const createdAt = meta([NS.crdt + 'createdAt']) || literal([NS.dc + 'created', NS.as + 'published', NS.crdt + 'createdAt']);
    const updatedAt = meta([NS.crdt + 'updatedAt']) || literal([NS.dc + 'updated', NS.crdt + 'updatedAt']);
    const creator = iri([NS.dc + 'creator', NS.as + 'actor', NS.foaf + 'maker']);
    if (createdAt) bookmark.createdAt = createdAt;
    if (updatedAt) bookmark.updatedAt = updatedAt;
    if (creator) bookmark.creator = creator;
    return bookmark;
  });
}
module.exports = { parseBookmarks, isRdf, reference, decodeReference, validatePath };
