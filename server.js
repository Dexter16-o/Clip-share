// ============================================================
//  ClipShare – server.js
//  Node.js + Express backend
//  Routes:
//    POST /api/share      – Device A pushes text (SSE sync)
//    GET  /api/stream     – Device B listens via SSE
//    GET  /api/current    – Device B polls current text (fallback)
//    DELETE /api/clear    – Clear shared text
//    POST /api/upload     – Store text, get back a download token + URL
//    GET  /download/:token – Phone opens this → file downloads instantly
//    GET  /api/server-url  – Returns this machine's LAN URL for QR generation
// ============================================================

'use strict';

const express = require('express');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const os      = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Force revalidation of HTML/JS/CSS so browsers never cache stale files
app.use((req, res, next) => {
  if (/\.(html|js|css|json)$/.test(req.path) || req.path === '/') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store (SSE sync) ───────────────────────────────
let sharedStore = {
  text      : '',
  updatedAt : null,
  updatedBy : null,
  version   : 0,
};

// ── Download token store ─────────────────────────────────────
// Map<token, { text, filename, mime, createdAt, expiresAt }>
const downloadTokens = new Map();
const TOKEN_TTL_MS   = 60 * 60 * 1000; // 1 hour

// Cleanup expired tokens every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of downloadTokens) {
    if (entry.expiresAt < now) {
      downloadTokens.delete(token);
      console.log(`[CLEANUP] Expired token ${token}`);
    }
  }
}, 15 * 60 * 1000);

// ── Active SSE clients ───────────────────────────────────────
const sseClients = new Map();

// ── Helper: get primary LAN IP ──────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// ── Helper: detect file extension from content ──────────────
function detectExtension(text) {
  const t = text.trimStart();

  if (/^<(!DOCTYPE|html|head|body)/i.test(t))         return { ext: 'html', mime: 'text/html' };
  if (/^<\?php/.test(t))                              return { ext: 'php',  mime: 'application/x-httpd-php' };
  try {
    JSON.parse(t);
    if (/^\s*[\[{]/.test(t))                          return { ext: 'json', mime: 'application/json' };
  } catch (_) {}
  if (/^(import |export |const |let |var |function |class |\/\/|async )/.test(t)) return { ext: 'js',   mime: 'text/javascript' };
  if (/^(def |import |from |class |#!\/usr\/bin\/env python|print\()/.test(t))   return { ext: 'py',   mime: 'text/x-python' };
  if (/^(package |import java\.|public class|@SpringBootApplication)/.test(t))   return { ext: 'java', mime: 'text/x-java-source' };
  if (/^(#include|int main|void |std::)/.test(t))     return { ext: 'cpp',  mime: 'text/x-c++src' };
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(t)) return { ext: 'sql', mime: 'text/x-sql' };
  if (/^(#!/|echo |if \[|function )/.test(t))         return { ext: 'sh',   mime: 'text/x-shellscript' };
  if (/^(---|\- name:| {2,}\w+:)/.test(t))            return { ext: 'yaml', mime: 'text/yaml' };
  if (/^(##|# |\*\*|\[.+\]\(.+\))/.test(t))          return { ext: 'md',   mime: 'text/markdown' };
  if (/[\w-]+\s*\{[\s\S]*?\}/.test(t) && /[{};]/.test(t)) return { ext: 'css', mime: 'text/css' };

  return { ext: 'txt', mime: 'text/plain' };
}

// ── Helper: broadcast to all SSE clients except sender ──────
function broadcast(payload, senderSessionId) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const [clientId, client] of sseClients) {
    if (client.sessionId && client.sessionId === senderSessionId) continue;
    try {
      client.res.write(data);
    } catch (_) {
      sseClients.delete(clientId);
    }
  }
}

// ════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════

/**
 * GET /api/server-url
 * Returns the server's LAN base URL so the frontend can embed
 * the correct download link inside the QR code.
 */
app.get('/api/server-url', (req, res) => {
  const ip = getLocalIP();
  res.json({ url: `http://${ip}:${PORT}`, ip, port: PORT });
});

/**
 * POST /api/upload
 * Body: { text: string, filename?: string }
 * Stores text under a UUID token and returns a direct download URL.
 * The QR code encodes this URL — phone camera taps it → file downloads.
 */
app.post('/api/upload', (req, res) => {
  const { text = '', filename = null } = req.body;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "text" field.' });
  }

  const token   = uuidv4();
  const { ext, mime } = detectExtension(text);
  const finalName     = filename || `clipshare-${Date.now()}.${ext}`;
  const ip            = getLocalIP();
  const downloadUrl   = `http://${ip}:${PORT}/download/${token}`;

  downloadTokens.set(token, {
    text,
    filename : finalName,
    mime,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });

  console.log(`[UPLOAD] token=${token} | file=${finalName} | ${text.length} chars`);
  return res.json({ success: true, token, downloadUrl, filename: finalName, ext });
});

/**
 * GET /download/:token
 * Phone opens this URL → browser downloads the file immediately.
 * Content-Disposition: attachment forces a Save dialog / download.
 */
app.get('/download/:token', (req, res) => {
  const entry = downloadTokens.get(req.params.token);

  if (!entry || entry.expiresAt < Date.now()) {
    downloadTokens.delete(req.params.token);
    return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Link Expired – ClipShare</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;
         display:flex;flex-direction:column;align-items:center;justify-content:center;
         min-height:100vh;margin:0;text-align:center;padding:24px}
    h1{font-size:2rem;margin-bottom:12px}
    p{color:#8b949e;line-height:1.6}
    a{color:#388bfd;text-decoration:none}
    .icon{font-size:3rem;margin-bottom:16px}
  </style>
</head>
<body>
  <div class="icon">⏱</div>
  <h1>Link Expired</h1>
  <p>This download link has expired or doesn't exist.<br>
     Please generate a new QR code on Device A.</p>
  <p style="margin-top:24px"><a href="/">← Back to ClipShare</a></p>
</body>
</html>`);
  }

  const encodedName = encodeURIComponent(entry.filename);
  res.setHeader('Content-Type', `${entry.mime}; charset=utf-8`);
  res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"; filename*=UTF-8''${encodedName}`);
  res.setHeader('Content-Length', Buffer.byteLength(entry.text, 'utf8'));
  res.setHeader('Cache-Control', 'no-store');
  res.send(entry.text);

  console.log(`[DOWNLOAD] token=${req.params.token} | file=${entry.filename}`);
});

// ── SSE stream ───────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  const clientId     = uuidv4();
  const sessionId    = req.query.session || null;
  const sinceVersion = parseInt(req.query.since || '0', 10);

  res.writeHead(200, {
    'Content-Type'      : 'text/event-stream',
    'Cache-Control'     : 'no-cache, no-transform',
    'Connection'        : 'keep-alive',
    'X-Accel-Buffering' : 'no',
  });
  res.flushHeaders();

  sseClients.set(clientId, { res, sessionId });
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, clientCount: sseClients.size })}\n\n`);

  if (sharedStore.version > sinceVersion && sharedStore.text !== '') {
    res.write(`data: ${JSON.stringify({ text: sharedStore.text, updatedAt: sharedStore.updatedAt, version: sharedStore.version })}\n\n`);
  }

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); sseClients.delete(clientId); }
  }, 20_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
    console.log(`[SSE] Client ${clientId} disconnected. Active: ${sseClients.size}`);
  });
  console.log(`[SSE] Client ${clientId} connected. Active: ${sseClients.size}`);
});

// ── Share (SSE push) ─────────────────────────────────────────
app.post('/api/share', (req, res) => {
  const { text = '', session = null } = req.body;
  if (typeof text !== 'string') return res.status(400).json({ error: '"text" must be a string.' });
  sharedStore = { text, updatedAt: new Date().toISOString(), updatedBy: session, version: sharedStore.version + 1 };
  broadcast({ text, updatedAt: sharedStore.updatedAt, version: sharedStore.version }, session);
  console.log(`[SHARE] v${sharedStore.version} | ${text.length} chars`);
  return res.json({ success: true, version: sharedStore.version, clientCount: sseClients.size });
});

// ── Poll fallback ────────────────────────────────────────────
app.get('/api/current', (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  if (sharedStore.version > since) {
    return res.json({ changed: true, text: sharedStore.text, updatedAt: sharedStore.updatedAt, version: sharedStore.version });
  }
  return res.json({ changed: false, version: sharedStore.version });
});

// ── Clear ────────────────────────────────────────────────────
app.delete('/api/clear', (req, res) => {
  const { session = null } = req.body;
  sharedStore = { text: '', updatedAt: new Date().toISOString(), updatedBy: session, version: sharedStore.version + 1 };
  broadcast({ text: '', updatedAt: sharedStore.updatedAt, version: sharedStore.version }, session);
  return res.json({ success: true });
});

// ── Status ───────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({
    status: 'ok', clients: sseClients.size, version: sharedStore.version,
    updatedAt: sharedStore.updatedAt, textLength: sharedStore.text.length,
    activeDownloads: downloadTokens.size,
  });
});

// ── SPA fallback ─────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  const ip = getLocalIP();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log(`  ║   ClipShare running on port ${PORT}             ║`);
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log(`  ║   Local :  http://localhost:${PORT}              ║`);
  console.log(`  ║   LAN   :  http://${ip}:${PORT}        ║`);
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});
