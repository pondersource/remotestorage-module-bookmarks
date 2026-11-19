const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const files = new Map([
  ['/', [path.join(__dirname, 'index.html'), 'text/html']],
  ['/bookmarks.js', [path.join(__dirname, '../dist/build.js'), 'text/javascript']],
  ['/remotestorage-solid.js', [path.join(process.env.SOLID_SOURCE, 'release/remotestorage-solid.js'), 'text/javascript']]
]);
http.createServer((req, res) => {
  const file = files.get(new URL(req.url, 'http://localhost').pathname);
  if (!file) { res.writeHead(404).end(); return; }
  fs.readFile(file[0], (error, data) => {
    if (error) { res.writeHead(500).end(error.message); return; }
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' }).end(data);
  });
}).listen(8000, '127.0.0.1');
