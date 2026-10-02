const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');


const PORT = process.env.PORT || 8080;
const DIST = path.join(__dirname, 'dist');

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

  let filePath = path.join(DIST, req.url === '/' ? 'index.html' : urlPath);
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
    socket.write(Buffer.concat([
      Buffer.from(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n',
      ),
    ]));
    if (backendHead.length) backendSocket.write(backendHead);
    backendSocket.pipe(socket);
    socket.pipe(backendSocket);
  });
  proxy.on('error', () => {
    try { socket.destroy(); } catch (_) { /* ignore */ }
  });
  if (head && head.length) proxy.write(head);
  proxy.end();
});


server.listen(PORT, () => console.log(`Frontend running on port ${PORT} (proxy -> ${BACKEND_ORIGIN})`));
