#!/usr/bin/env node
/*
 * RaptiCaL relay — a tiny, dependency-free message relay for the hidden
 * messenger inside RaptiCaL.
 *
 * It never sees plain text: the phones encrypt every payload with a key derived
 * from their shared phrase, and this process only forwards the ciphertext.
 * Messages live in RAM only (no database, no disk, no logs of content) and are
 * dropped 24 hours after they were sent.
 *
 *   node server.js            # listens on 0.0.0.0:8080
 *   PORT=3000 node server.js
 *
 * Put it behind HTTPS (Render, Fly.io, Railway, Caddy/nginx, …) before use.
 */
'use strict';

const http = require('http');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8080', 10);
const TTL = 24 * 60 * 60 * 1000;          // messages die after 24 h
const MAX_BODY = 6 * 1024 * 1024;          // 6 MB request body
const MAX_MSGS = 800;                      // per room
const MAX_ROOMS = 5000;

/** room -> { seq, msgs: [], subs: Set<res>, hits: [] } */
const rooms = new Map();

function room(id) {
  let r = rooms.get(id);
  if (!r) {
    if (rooms.size >= MAX_ROOMS) {
      const oldest = rooms.keys().next().value;
      if (oldest) rooms.delete(oldest);
    }
    r = { seq: 0, msgs: [], subs: new Set(), hits: [] };
    rooms.set(id, r);
  }
  return r;
}

function alive(r, now) {
  const cut = now - TTL;
  while (r.msgs.length && r.msgs[0].ts < cut) r.msgs.shift();
  return r.msgs;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store'
  });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function broadcast(r, msg) {
  const line = 'data: ' + JSON.stringify(msg) + '\n\n';
  for (const res of r.subs) {
    try { res.write(line); } catch (e) { r.subs.delete(res); }
  }
}

const ROOM_RE = /^[a-f0-9]{8,64}$/i;

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { return json(res, 400, { ok: false }); }

  if (req.method === 'GET' && u.pathname === '/health') {
    return json(res, 200, { ok: true, name: 'raptical-relay', ttl: TTL, rooms: rooms.size });
  }

  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>RaptiCaL relay</title><body style="font:15px system-ui;padding:2rem;max-width:34rem;margin:auto">' +
      '<h2>RaptiCaL relay</h2><p>Running. Messages are relayed with a 24-hour lifetime and are never written to disk.</p>' +
      '<p style="color:#777">Health: <a href="/health">/health</a></p></body>');
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/send') {
    let data;
    try { data = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { ok: false, e: 'body' }); }
    if (!data || typeof data.room !== 'string' || !ROOM_RE.test(data.room)) return json(res, 400, { ok: false, e: 'room' });
    if (typeof data.id !== 'string' || data.id.length < 3 || data.id.length > 64) return json(res, 400, { ok: false, e: 'id' });
    if (typeof data.body !== 'string' || !data.body.length || data.body.length > 5 * 1024 * 1024) return json(res, 400, { ok: false, e: 'body' });
    const from = String(data.from || '').slice(0, 24);
    const now = Date.now();
    let ts = typeof data.ts === 'number' ? data.ts : now;
    if (ts > now + 60000) ts = now;
    if (ts < now - TTL) return json(res, 200, { ok: true, seq: 0, dropped: true });

    const r = room(data.room);
    // small flood guard: 90 messages per minute per room
    r.hits = r.hits.filter((t) => now - t < 60000);
    if (r.hits.length >= 90) return json(res, 429, { ok: false, e: 'rate' });
    r.hits.push(now);

    alive(r, now);
    const msg = { id: data.id, seq: ++r.seq, from: from, ts: ts, body: data.body };
    r.msgs.push(msg);
    if (r.msgs.length > MAX_MSGS) r.msgs.splice(0, r.msgs.length - MAX_MSGS);
    broadcast(r, msg);
    return json(res, 200, { ok: true, seq: msg.seq });
  }

  if (req.method === 'GET' && u.pathname === '/api/messages') {
    const id = u.searchParams.get('room') || '';
    if (!ROOM_RE.test(id)) return json(res, 400, { ok: false, e: 'room' });
    const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
    const r = rooms.get(id);
    const now = Date.now();
    const msgs = r ? alive(r, now).filter((m) => m.seq > since) : [];
    return json(res, 200, { ok: true, now: now, messages: msgs });
  }

  if (req.method === 'GET' && u.pathname === '/api/stream') {
    const id = u.searchParams.get('room') || '';
    if (!ROOM_RE.test(id)) return json(res, 400, { ok: false, e: 'room' });
    const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
    const r = room(id);
    const now = Date.now();

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    alive(r, now).filter((m) => m.seq > since).forEach((m) => {
      res.write('data: ' + JSON.stringify(m) + '\n\n');
    });
    r.subs.add(res);

    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
    }, 20000);

    const done = () => {
      clearInterval(hb);
      r.subs.delete(res);
    };
    req.on('close', done);
    req.on('error', done);
    return;
  }

  json(res, 404, { ok: false, e: 'not found' });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    alive(r, now);
    if (!r.msgs.length && !r.subs.size) rooms.delete(id);
  }
}, 60000).unref();

server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch (e) { /* ignore */ }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('RaptiCaL relay listening on http://0.0.0.0:' + PORT + ' (24 h message lifetime, memory only)');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
