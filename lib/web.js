// `cmon --web`: the same board as a local page.
//
//   GET /            web/index.html
//   GET /api/state   the latest snapshot as JSON
//   GET /events      Server-Sent Events: the snapshot again, only when it changed
//
// Bound to 127.0.0.1 only — session titles and spend never leave the machine.
// The page pulls nothing from the network. No dependencies.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PAGE = path.join(__dirname, '..', 'web', 'index.html');

function start(port, onListen) {
  const clients = new Set();
  let latest = '{}';

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
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

module.exports = { start, PAGE };
