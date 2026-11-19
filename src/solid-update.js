const { DataFactory, Writer } = require('n3');
const { parseDataset, parseBookmarks, decodeReference, NS, types } = require('./solid-bookmarks');
const { namedNode, literal, quad, defaultGraph } = DataFactory;
const pending = new WeakMap();

function iri(value) {
  if (typeof value !== 'string' || /[\s<>"{}|^`\\]/.test(value)) throw new Error('Expected an absolute IRI');
  const url = new URL(value);
  if (!url.protocol) throw new Error('Expected an absolute IRI');
  return namedNode(value);
}
function topic(term) {
  if (!term || typeof term.value !== 'string') throw new Error('Expected a typed topic term');
  if (term.termType === 'NamedNode') return iri(term.value);
  if (term.termType !== 'Literal') throw new Error('Unsupported topic term kind');
  if (term.language) {
    if (!/^[a-z]+(?:-[a-z0-9]+)*$/i.test(term.language)) throw new Error('Invalid topic language');
    if (term.datatype && term.datatype !== 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString') throw new Error('Language and datatype disagree');
    return literal(term.value, term.language);
  }
  return literal(term.value, term.datatype ? iri(term.datatype) : undefined);
}

// Serialize edits to the same cached document, including edits to sibling subjects.
// The rs.js sync engine remains responsible for remote ETag conflict handling.
function mutate(client, id, changes, baseIRI, remove = false) {
  const ref = decodeReference(id);
  if (!ref) return Promise.reject(new Error('Expected a Solid bookmark reference'));
  let paths = pending.get(client);
  if (!paths) { paths = new Map(); pending.set(client, paths); }
  const previous = paths.get(ref[0]) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const [path, subjectIRI] = ref;
    const file = await client.getFile(path);
    const mime = (file.contentType || '').split(';')[0].trim().toLowerCase();
    if (!['text/turtle', 'application/n-triples'].includes(mime)) throw new Error('RDF writes currently require Turtle or N-Triples');
    const store = parseDataset(file.data, baseIRI, mime);
    const subject = iri(subjectIRI);
    const typeQuads = store.getQuads(subject, namedNode(NS.rdf + 'type'), null, null);
    if (!typeQuads.some(q => types.includes(q.object.value))) throw new Error('Bookmark no longer exists in the source document');
    if (store.getQuads(null, null, null, null).some(q => q.predicate.value.startsWith(NS.crdt))) {
      throw new Error('Soukai/CRDT documents require history-aware writes and remain read-only');
    }
    if (remove) {
      store.removeQuads(store.getQuads(subject, null, null, null));
    } else {
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Expected bookmark changes');
      const allowed = ['title', 'url', 'topics', 'creator'];
      for (const key of Object.keys(changes)) if (!allowed.includes(key)) throw new Error('Unsupported RDF bookmark field: ' + key);
      const asNote = typeQuads.some(q => q.object.value === NS.as + 'Note');
      const graph = typeQuads[0]?.graph || defaultGraph();
      const replace = (predicates, fallback, termFor) => {
        const current = predicates.flatMap(p => store.getQuads(subject, namedNode(p), null, null));
        if (current.length) {
          for (const q of current) {
            const term = termFor(q.object);
            store.removeQuad(q);
            store.addQuad(quad(subject, q.predicate, term, q.graph));
          }
        } else store.addQuad(quad(subject, namedNode(fallback), termFor(), graph));
      };
      if ('title' in changes) {
        if (typeof changes.title !== 'string') throw new Error('Title must be a string');
        const predicates = [NS.dc + 'title', NS.rdfs + 'label', NS.as + 'name'];
        const existing = predicates.flatMap(p => store.getQuads(subject, namedNode(p), null, null));
        if (existing.some(q => q.object.termType !== 'Literal' || q.object.language)) throw new Error('Use an explicit language-aware editor for multilingual titles');
        replace(predicates, asNote ? NS.as + 'name' : NS.dc + 'title', old => literal(changes.title, old?.datatype));
      }
      if ('url' in changes) {
        const value = iri(changes.url);
        replace([NS.bookmark + 'recalls', NS.as + 'url'], asNote ? NS.as + 'url' : NS.bookmark + 'recalls', old =>
          old?.termType === 'Literal' ? literal(changes.url, old.language || old.datatype) : value);
      }
      if ('creator' in changes) {
        const value = iri(changes.creator);
        replace([NS.dc + 'creator', NS.as + 'actor', NS.foaf + 'maker'], asNote ? NS.as + 'actor' : NS.dc + 'creator', () => value);
      }
      if ('topics' in changes) {
        if (!Array.isArray(changes.topics)) throw new Error('Topics must be typed RDF terms');
        const terms = changes.topics.map(topic);
        store.removeQuads(store.getQuads(subject, namedNode(NS.bookmark + 'hasTopic'), null, null));
        for (const term of terms) store.addQuad(quad(subject, namedNode(NS.bookmark + 'hasTopic'), term, graph));
      }
      // Timestamp policy matches the existing Solid vanilla bookmark reader.
      replace([NS.dc + 'updated'], NS.dc + 'updated', () => literal(new Date().toISOString(), namedNode('http://www.w3.org/2001/XMLSchema#dateTime')));
    }
    const writer = new Writer({ format: mime });
    writer.addQuads(store.getQuads(null, null, null, null));
    const text = await new Promise((resolve, reject) => writer.end((error, result) => error ? reject(error) : resolve(result)));
    await client.storeFile(file.contentType, path, text);
    return remove ? true : parseBookmarks(text, { path, baseIRI, contentType: mime }).find(b => b.id === id);
  });
  paths.set(ref[0], operation);
  operation.then(() => { if (paths.get(ref[0]) === operation) paths.delete(ref[0]); }, () => { if (paths.get(ref[0]) === operation) paths.delete(ref[0]); });
  return operation;
}
module.exports = { mutate };
