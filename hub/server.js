// FTS Live Tape hub.
//
// Receives raw WebSocket frames from the browser extension, writes them to disk
// before doing anything else with them, normalizes them into viewer events, and
// streams those to the viewer window over Server-Sent Events.
//
// Zero npm dependencies on purpose: nothing to install and nothing to break
// during a 50-minute session.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tracker, unwrap } from './protocol.js';
import { loadReplay } from './replay.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const UI_DIR = path.join(ROOT, 'ui');
const DATA_DIR = path.join(ROOT, 'data');

const PORT = Number(process.env.FTS_PORT || 8787);
const HOST = '127.0.0.1';
// The viewer rebuilds its whole curve from the trade history on connect, so
// this has to hold a full session's prints rather than a display window.
const MAX_TAPE = 20000;

const args = process.argv.slice(2);
const replayIndex = args.indexOf('--replay');
const replayFile = replayIndex === -1 ? null : args[replayIndex + 1];
const speedIndex = args.indexOf('--speed');
const replaySpeed = speedIndex === -1 ? 20 : Number(args[speedIndex + 1]) || 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- state

const tracker = new Tracker();
const clients = new Set();

const state = {
  mode: replayFile ? 'replay' : 'live',
  connected: false,
  lastFrameAt: null,
  frames: 0,
  security: null,
  clock: null,
  total: null,
  session: 'unknown',
  cash: null,
  position: null,
  vt: null,
  best: { bid: null, ask: null },
  depth: { bid: [], ask: [] },
  trades: [],
  myfills: [],
  unknownHeaders: {},
};

let rawStream = null;
function rawSink() {
  if (rawStream) return rawStream;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(DATA_DIR, `raw-${stamp}.jsonl`);
  rawStream = fs.createWriteStream(file, { flags: 'a' });
  log(`recording raw frames to ${path.relative(ROOT, file)}`);
  return rawStream;
}

function log(...parts) {
  process.stdout.write(`[hub] ${parts.join(' ')}\n`);
}

// ---------------------------------------------------------------- events

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    // A viewer that has gone away just fails to write; drop it rather than throw.
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

// Folds an event into the snapshot a newly-opened viewer gets served.
function absorb(event) {
  switch (event.t) {
    case 'meta':
      state.security = event.security;
      break;
    case 'clock':
      state.clock = event.clock;
      if (event.total != null) state.total = event.total;
      break;
    case 'session':
      state.session = event.state;
      if (event.total != null) state.total = event.total;
      break;
    case 'trade':
      state.trades.push(event);
      if (state.trades.length > MAX_TAPE) state.trades.shift();
      break;
    case 'quote':
      state.best[event.side] = event.price === null ? null : { price: event.price, qty: event.qty, trader: event.trader };
      state.depth[event.side] = event.depth;
      break;
    case 'account':
      state.cash = event.cash;
      state.position = event.position;
      if (event.vt != null) state.vt = event.vt;
      break;
    case 'myfill':
      state.myfills.push(event);
      if (state.myfills.length > MAX_TAPE) state.myfills.shift();
      break;
    case 'info':
      if (event.vt != null) state.vt = event.vt;
      break;
    default:
      break;
  }
}

function emit(events) {
  for (const event of events) {
    absorb(event);
    broadcast(event);
  }
}

function statusEvent() {
  return {
    t: 'status',
    mode: state.mode,
    connected: state.connected,
    frames: state.frames,
    lastFrameAt: state.lastFrameAt,
    unknownHeaders: state.unknownHeaders,
  };
}

// ---------------------------------------------------------------- ingest

function ingest(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return;
  const sink = rawSink();
  const now = Date.now();

  for (const frame of frames) {
    // Persist before parsing. A frame we cannot interpret is still recoverable
    // from disk; one we never wrote is gone. This is the Session 04 lesson.
    sink.write(`${JSON.stringify({ at: now, frame })}\n`);
    state.frames += 1;

    for (const msg of unwrap(frame)) {
      if (msg.header) broadcast({ t: 'raw', header: msg.header, msg });
      const events = tracker.handle(msg);
      if (events.length === 0 && msg.header && !KNOWN.has(msg.header)) {
        state.unknownHeaders[msg.header] = (state.unknownHeaders[msg.header] || 0) + 1;
      }
      emit(events);
    }
  }
  emit(tracker.flush());

  state.lastFrameAt = now;
  if (!state.connected) {
    state.connected = true;
    log('feed connected');
  }
  broadcast(statusEvent());
}

// Headers the tracker deliberately produces no event for; anything outside this
// set and outside the handled cases is surfaced in the UI as unrecognised.
const KNOWN = new Set([
  'time', 'startperiod', 'endperiod', 'pausemarket', 'resumemarket', 'secname',
  'bidasklast', 'lasttrade', 'bestbid', 'bestask', 'cash', 'endow', 'info',
  'performance', 'error', 'popuperror', 'loggedin', 'login', 'showmessage',
  'initializetrial', 'nstock', 'intrate', 'mktmak', 'div', 'dummymessage',
  'caselist', 'casename', 'clearbids', 'clearasks', 'bidbook', 'askbook',
]);

// A fill's two legs can straddle two batches; resolve stragglers on a timer.
setInterval(() => emit(tracker.flush(true)), 750).unref();

// Mark the feed stale if nothing has arrived for a while.
setInterval(() => {
  if (!state.connected || state.mode === 'replay') return;
  if (Date.now() - (state.lastFrameAt || 0) > 15000) {
    state.connected = false;
    log('feed went quiet');
    broadcast(statusEvent());
  }
}, 5000).unref();

// ---------------------------------------------------------------- http

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  // Chrome treats a public page reaching 127.0.0.1 as a private network request.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(UI_DIR, rel);
  // Refuse anything that escapes the ui directory.
  if (!file.startsWith(UI_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === '/ingest' && req.method === 'POST') {
    cors(res);
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      ingest(Array.isArray(parsed) ? parsed : [parsed]);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(err.message) }));
    }
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    // Hand the newcomer everything so far, then stream.
    res.write(`data: ${JSON.stringify({ t: 'snapshot', state: snapshot() })}\n\n`);
    clients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* dropped below */
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
    return;
  }

  if (url.pathname === '/health') {
    cors(res);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(statusEvent()));
    return;
  }

  serveStatic(req, res, url.pathname);
});

function snapshot() {
  return {
    ...statusEvent(),
    security: state.security,
    clock: state.clock,
    total: state.total,
    session: state.session,
    cash: state.cash,
    position: state.position,
    vt: state.vt,
    best: state.best,
    depth: state.depth,
    trades: state.trades,
    myfills: state.myfills,
  };
}

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  (mode: ${state.mode})`);
  if (replayFile) startReplay();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${PORT} is already in use — is the hub already running?`);
    process.exit(1);
  }
  throw err;
});

// ---------------------------------------------------------------- replay

async function startReplay() {
  let messages;
  try {
    messages = await loadReplay(replayFile);
  } catch (err) {
    log(`replay failed: ${err.message}`);
    return;
  }
  log(`replaying ${messages.length} messages from ${replayFile} at ${replaySpeed}x`);
  state.connected = true;
  broadcast(statusEvent());

  let i = 0;
  const tick = () => {
    if (i >= messages.length) {
      log('replay finished');
      broadcast({ t: 'session', state: 'end', clock: state.clock });
      return;
    }
    const current = messages[i];
    // Frames are grouped by game clock so the replay keeps the original cadence.
    const batch = [];
    while (i < messages.length && messages[i].clock === current.clock) {
      batch.push(messages[i].msg);
      i += 1;
    }
    ingest([batch]);
    const next = messages[i];
    // One game-clock unit is one second of real time; compress by the speed
    // factor. Capped because a capture with gaps in it (the Session 04 export
    // starts at minute 17) would otherwise stall on the dead stretches.
    const gap = next ? Math.max(0, current.clock - next.clock) : 0;
    const delay = Math.min(400, Math.max(8, (gap * 1000) / replaySpeed));
    setTimeout(tick, delay);
  };
  tick();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('shutting down');
    if (rawStream) rawStream.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
