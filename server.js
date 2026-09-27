/* LaundryLink — tiny static server with SPA history fallback.
   Serves the app at / and returns index.html for extensionless routes
   such as /machine/3 so QR deep links open the right view. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  } catch (e) {
    res.writeHead(400);
    return res.end('Bad request');
  }

  let file = path.normalize(path.join(ROOT, urlPath));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const send = (f) => {
    fs.readFile(f, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Server error');
      }
      const type = TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  };

  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, 'index.html');
    fs.stat(file, (err2, st2) => {
      if (err2 || !st2.isFile()) {
        // SPA fallback: pretty URLs like /machine/3 render the app.
        if (!path.extname(urlPath)) return send(path.join(ROOT, 'index.html'));
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      send(file);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('LaundryLink listening on http://0.0.0.0:' + PORT);
});
