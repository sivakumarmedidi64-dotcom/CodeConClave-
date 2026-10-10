const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');


const PREFERRED_PORT = Number(process.env.PORT) || 8080;
const MAX_FALLBACK_STEPS = 8;
const DIST = path.join(__dirname, 'dist');
let announced = false;

const BACKEND_ORIGIN = process.env.FRONTEND_PROXY_TARGET || 'http://localhost:4000';
const BACKEND = new URL(BACKEND_ORIGIN);


const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Security headers for the SPA's own static responses (HTML/JS/CSS/assets).
// Proxy responses are untouched: the backend already sends its own complete
// security headers, which flow through unchanged.
// CSP is scoped to what the bundle actually uses (all self-origin assets,
// same-origin API/SSE/WebSocket, React 19 runtime style hoisting).
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-src 'self'; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; " +
    'upgrade-insecure-requests',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function withSecurityHeaders(extraHeaders) {
  return Object.assign({}, SECURITY_HEADERS, extraHeaders);
}


function shouldProxy(urlPath) {
  return urlPath === '/' ? false : /^\/api\//.test(urlPath) || urlPath === '/health' || urlPath === '/health/';
}


function proxyRequest(req, res) {
  const urlPath = req.url === '/' ? '/' : req.url;
  const targetPath = urlPath.replace(/^\/health\/?$/, '/health');
  const isUpgrade = (req.headers.upgrade || '').toLowerCase() === 'websocket';
  const headers = { ...req.headers };
  headers.host = BACKEND.host;
  if (isUpgrade) {
    headers.connection = 'Upgrade';
  }
  const reqOpts = {
    protocol: BACKEND.protocol,
    hostname: BACKEND.hostname,
    port: BACKEND.port || (BACKEND.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: targetPath,
    headers,
  };
  const proxy = (BACKEND.protocol === 'https:' ? https : http).request(reqOpts, (backendRes) => {
    res.writeHead(backendRes.statusCode || 502, backendRes.headers);
    backendRes.pipe(res);
  });
  proxy.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: { code: 'proxy_error', message: 'Backend unreachable' } }));
  });
  proxy.on('upgrade', (backendRes, backendSocket, head) => {
    res.writeHead(101, backendRes.headers);
    backendSocket.pipe(res);
    res.pipe(backendSocket);
    if (head.length) backendSocket.write(head);
  });
  req.pipe(proxy);
}


const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (shouldProxy(urlPath)) {
    proxyRequest(req, res);
    return;
  }

  // Contain static reads inside DIST: the raw URL path is decoded, rejected
  // when malformed/NUL-bearing, then normalized and required to stay under
  // DIST, so `/../../..` cannot read files outside the bundle directory.
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400, withSecurityHeaders({ 'Content-Type': 'text/plain' }));
    res.end('Bad path');
    return;
  }
  if (decoded.includes('\0')) {
    res.writeHead(400, withSecurityHeaders({ 'Content-Type': 'text/plain' }));
    res.end('Bad path');
    return;
  }

  let filePath = path.normalize(path.join(DIST, decoded === '/' ? 'index.html' : decoded.slice(1)));
  if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
    res.writeHead(400, withSecurityHeaders({ 'Content-Type': 'text/plain' }));
    res.end('Bad path');
    return;
  }

  const ext = path.extname(filePath);

  if (!ext && !urlPath.includes('.')) filePath += '.html';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(DIST, 'index.html'), (err2, indexData) => {
        if (err2) {
          res.writeHead(404, withSecurityHeaders({ 'Content-Type': 'text/plain' }));
          res.end('Not found');
        } else {
          res.writeHead(200, withSecurityHeaders({ 'Content-Type': 'text/html' }));
          res.end(indexData);
        }
      });
    } else {
      res.writeHead(200, withSecurityHeaders({ 'Content-Type': MIME[ext] || 'application/octet-stream' }));
      res.end(data);
    }
  });
});


server.on('upgrade', (req, socket, head) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (!shouldProxy(urlPath)) {
    socket.destroy();
    return;
  }
  const targetPath = urlPath.replace(/^\/health\/?$/, '/health');
  const headers = { ...req.headers };
  headers.host = BACKEND.host;
  headers.connection = 'Upgrade';
  const reqOpts = {
    protocol: BACKEND.protocol,
    hostname: BACKEND.hostname,
    port: BACKEND.port || (BACKEND.protocol === 'https:' ? 443 : 80),
    method: req.method || 'GET',
    path: targetPath,
    headers,
  };
  const proxy = (BACKEND.protocol === 'https:' ? https : http).request(reqOpts);
  proxy.on('upgrade', (backendRes, backendSocket, backendHead) => {
    // Forward the BACKEND's own 101 with its computed Sec-WebSocket-Accept
    // (derived from the client's key); a hardcoded 101 would break the browser
    // handshake for the /agent hub through the embedded proxy.
    const responseHead =
      'HTTP/1.1 101 Switching Protocols\r\n' +
      Object.entries(backendRes.headers || {})
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : v}\r\n`)
        .join('') +
      '\r\n';
    socket.write(Buffer.concat([Buffer.from(responseHead)]));
    // Any bytes the backend sent right behind its 101 (first WebSocket frames)
    // arrive buffered as backendHead: those belong to the CLIENT socket, not the
    // backend socket we just drained them from.
    if (backendHead.length) socket.write(backendHead);
    backendSocket.pipe(socket);
    socket.pipe(backendSocket);
  });
  proxy.on('error', () => {
    try { socket.destroy(); } catch (_) { /* ignore */ }
  });
  if (head && head.length) proxy.write(head);
  proxy.end();
});


// Bind loopback only: this server both serves the SPA and proxies to the local
// backend, so exposing it on every interface put a same-origin proxy on the LAN.
// Port discovery: start at the preferred port; if it (or the next few) is taken
// by another process, fall forward a bounded number of steps. The desktop shell
// reads the REAL bound port from the machine-readable marker on stdout instead
// of assuming the preferred port ever bound.
function startListening(port, step) {
  server.once('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && step < MAX_FALLBACK_STEPS) {
      startListening(port + 1, step + 1);
      return;
    }
    console.error(`[frontend] cannot listen on port ${port} (${err && err.code ? err.code : err})`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    // A failed listen attempt can later fire a stale 'listening' thunk whose
    // planned port no longer matches the live handle, so report the address the
    // server is ACTUALLY bound to, and only once. The desktop shell relies on
    // this marker to load the real origin.
    const bound = server.address();
    if (announced || !bound) return;
    announced = true;
    process.stdout.write(`__BOUND_PORT_START__${bound.port}__BOUND_PORT_END__\n`);
    console.log(`Frontend running on port ${bound.port} (proxy -> ${BACKEND_ORIGIN})`);
  });
}
startListening(PREFERRED_PORT, 0);
