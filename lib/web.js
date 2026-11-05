// `cmon --web`: the same board as a local page.
//
//   GET  /              web/index.html
//   GET  /api/state     the latest snapshot as JSON
//   GET  /events        Server-Sent Events: the snapshot again, only when it changed
//   POST /api/privacy   the one write: a session's privacy level or alias, private
//                       mode, a folder rule (JSON body; see lib/privacy.js applyRequest)
//
// Bound to 127.0.0.1 only — session titles and spend never leave the machine.
// The page pulls nothing from the network. No dependencies.
//
// Any web page you visit can send requests to 127.0.0.1, so the write is fenced:
// it must be application/json (a cross-site form cannot send that without a CORS
// preflight, and the preflight gets no allow headers here), an Origin header, if
// present, must be this server's own, and the Host must be 127.0.0.1 or
// localhost on this port (a rebound DNS name fails that). The privacy logic
// itself lives with the caller, in opts.onPrivacy.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'web', 'index.html');
const BODY_LIMIT = 4096;

function start(port, onListen, opts) {
  const o = opts || {};
  const clients = new Set();
  let latest = '{}';
  const own = [`127.0.0.1:${port}`, `localhost:${port}`];

  // 204 on success; 403 for a foreign host or origin, 415 for anything but
  // JSON, 400 for a body that is too big, unparseable or refused.
  function privacyWrite(req, res) {
    const done = (code) => { if (!res.headersSent) { res.writeHead(code); res.end(); } };
    const host = String(req.headers.host || '').toLowerCase();
    const origin = req.headers.origin;
    if (!own.includes(host)) return done(403);
    if (origin !== undefined && !own.map((h) => 'http://' + h).includes(String(origin).toLowerCase())) return done(403);
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return done(415);
    let size = 0;
    const chunks = [];
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      // Answer at once and let the rest drain unread.
      if (size > BODY_LIMIT) { over = true; chunks.length = 0; done(400); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return done(400); }
      let ok = false;
      try { ok = !!o.onPrivacy(body); } catch (e) { ok = false; }
      done(ok ? 204 : 400);
    });
    req.on('error', () => done(400));
  }

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && url === '/api/privacy' && o.onPrivacy) return privacyWrite(req, res);
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (url === '/' || url === '/index.html') {
      // Read on every request: editing the page needs a reload, not a restart.
      fs.readFile(PAGE, (err, buf) => {
        if (err) { res.writeHead(500); return res.end('web/index.html missing'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
      return;
    }
    if (url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(latest);
    }
    if (url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${latest}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // Keeps proxies and the browser from timing the stream out.
  const beat = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE'
      ? `cmon --web: port ${port} is already in use (another cmon?). Try --port=${port + 1}.`
      : `cmon --web: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => onListen && onListen(`http://127.0.0.1:${port}/`));

  return {
    publish(state) {
      const json = JSON.stringify(state);
      if (json === latest) return;
      latest = json;
      for (const c of clients) c.write(`data: ${json}\n\n`);
    },
    clients: () => clients.size,
    close() { clearInterval(beat); for (const c of clients) c.end(); server.close(); },
  };
}

module.exports = { start, PAGE, BODY_LIMIT };
