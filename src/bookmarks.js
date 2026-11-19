//
// Utility functions
//

const md5 = require('md5');
const { parseBookmarks, isRdf, decodeReference, validatePath } = require('./solid-bookmarks');

const extend = function (target) {
  const sources = Array.prototype.slice.call(arguments, 1);
  sources.forEach(function (source) {
    for (const key in source) {
      target[key] = source[key];
    }
  });
  return target;
}

const urlHash = function (url) {
  // url = url; //TODO remove trailing slash
  return md5(url);
};

//
// Bookmarks module
//

const Bookmarks = function (privateClient/*, publicClient*/) {

  async function readDocument(path, maxAge) {
    validatePath(path);
    const file = await privateClient.getFile(path, maxAge);
    if (file.data === undefined || file.data === null) return [];
    if (isRdf(file.contentType)) {
      return parseBookmarks(file.data, { path, baseIRI: privateClient.getItemURL(path), contentType: file.contentType });
    }
    if (file.contentType && !/^(application\/json|application\/[^;]+\+json)(;|$)/i.test(file.contentType)) return [];
    const value = typeof file.data === 'string' ? JSON.parse(file.data) : file.data;
    return value && typeof value === 'object' && typeof value.url === 'string' ? [value] : [];
  }

  async function readReference(id, maxAge) {
    const ref = decodeReference(id);
    if (!ref) return undefined;
    return (await readDocument(ref[0], maxAge)).find(bookmark => bookmark.id === id);
  }

  //
  // Types/Schemas
  //

  const baseProperties = {
    "id": {
      "type": "string",
      "description": "A string that uniquely identifies this bookmark",
      "required": true
    },
    "url": {
      "type": "string",
      "description": "The url of the bookmarked item",
      "format": "uri",
      "required": true
    },
    "title": {
      "type": "string",
      "description": "Title, headline, or short description",
      "required": true
    },
    "tags": {
      "type": "array",
      "description": "Array of strings; use tags like labels",
      "default": []
    },
    "createdAt": {
      "type": "string",
      "description": "DateTime string of document creation",
      "format": "date-time"
    },
    "updatedAt": {
      "type": "string",
      "description": "DateTime string of last update",
      "format": "date-time"
    }
  };

  /**
   * Schema: bookmarks/archive-bookmark
   *
   * Represents an archived bookmark.
   */
  privateClient.declareType('archive-bookmark', {
    "type": "object",
    "properties": extend({
      "description": {
        "type": "string",
        "description": "A longer description of the bookmarked item",
        "default": ""
      },
      "thumbnail": {
        "description": "A base64-encoded screenshot of the bookmarked page",
        "type": "string"
      }
    }, baseProperties),
    "required": []
  });

  /**
   * Schema: bookmarks/browser-bookmark
   *
   * Represents a bookmark that is not archived.
   */
  privateClient.declareType('browser-bookmark', {
    "type": "object",
    "properties": extend({}, baseProperties)
  });

  /**
   * Schema: bookmarks/readlater-bookmark
   *
   * Represents a bookmark which the user marked for reading later.
   */
  privateClient.declareType('readlater-bookmark', {
    "type": "object",
    "properties": extend({
      "unread": {
        "type": "boolean",
        "description": "Whether the bookmark is unread",
        "default": true,
        "required": true
      }
    }, baseProperties)
  });

  /**
   * A collection of bookmarks, stored in a subdirectory
   */
  class Folder {
    constructor (folderName) {
      this.name = folderName;
      this.basePath = encodeURIComponent(folderName);
      this.client = privateClient.scope(`${this.basePath}/`);
    }

    get (id) {
      if (decodeReference(id)) return readReference(id);
      return privateClient.getObject(`${this.basePath}/${id}`);
    }

    getAll (maxAge) {
      return privateClient.getListing(this.basePath + '/', maxAge)
        .then(async listing => {
          const paths = Object.keys(listing || {}).filter(path => !path.endsWith('/'));
          const values = await Promise.all(paths.map(path => readDocument(this.basePath + '/' + path, maxAge)));
          return values.flat();
        });
    }

    searchByURL (url) {
      const id = urlHash(url);
      return privateClient.getObject(`${this.basePath}/${id}`)
        .then(bookmark => bookmark || this.getAll().then(all => all.find(item => item.url === url)));
    }

    searchByTags (tags) {
      return this.getAll()
        .then(bookmarks => {
          if (!bookmarks) return [];
          return bookmarks.filter(b => {
            return b.tags &&
                   b.tags.filter(tag => tags.includes(tag)).length > 0;
          });
        })
    }

    store (bookmark, bookmarkType='archive-bookmark') {
      if (bookmark.solid || decodeReference(bookmark.id)) {
        return Promise.reject(new Error('Solid RDF bookmarks are read-only until lossless RDF/history writes are supported'));
      }
      bookmark.id = urlHash(bookmark.url);
      if (bookmark.createdAt) {
        bookmark.updatedAt = new Date().toISOString();
      } else {
        bookmark.createdAt = new Date().toISOString();
      }
      const path = `${this.basePath}/${bookmark.id}`;

      if (this.name === 'readlater') {
        bookmarkType = 'readlater-bookmark';
      }

      return privateClient.storeObject(bookmarkType, path, bookmark)
                          .then(() => { return bookmark; });
    }

    remove (id) {
      if (decodeReference(id)) return Promise.reject(new Error('Solid RDF bookmarks are read-only'));
      return privateClient.remove(`${this.basePath}/${id}`);
    }
  }

  //
  // Public functions
  //

  const bookmarks = {
    name: 'bookmarks',

    // DEPRECATED! Please use bookmarks.openFolder() instead.
    archive: new Folder('archive'),

    openFolder (folderName) {
      return new Folder(folderName);
    },

    // Read one RDF or JSON document through the rs.js scoped cache and backend.
    readDocument,

    client: privateClient,
  };

  //
  // Return public functions
  //

  return { exports: bookmarks };
};

export default { name: 'bookmarks', builder: Bookmarks };
