// The WebSocket constructor patch is the single point of failure for capture:
// if it breaks, nothing is recorded, and if it breaks the page, the user cannot
// trade. Both properties are worth a test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, 'inject.js'), 'utf8');

// Minimal stand-ins for the page: a WebSocket that lets a test push frames, and
// a window that records what got posted.
function makeSandbox() {
  const posted = [];
  const constructed = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.listeners = [];
      this.onmessage = null;
      constructed.push(this);
    }

    addEventListener(type, fn) {
      if (type === 'message') this.listeners.push(fn);
    }

    // Simulates the server pushing a frame.
    deliver(data) {
      const event = { data };
      for (const fn of this.listeners) fn(event);
      if (this.onmessage) this.onmessage(event);
    }
  }

  const window = {
    WebSocket: FakeWebSocket,
    postMessage: (message) => posted.push(message),
    addEventListener: () => {},
    ws: undefined,
  };

  const context = vm.createContext({
    window,
    setInterval: () => 0,
    clearInterval: () => {},
    WeakSet,
  });
  context.globalThis = context;

  return { context, window, posted, constructed, FakeWebSocket };
}

function run(sandbox) {
  vm.runInContext(SOURCE, sandbox.context);
}

test('frames received on a socket are forwarded to the relay', () => {
  const sandbox = makeSandbox();
  run(sandbox);

  const socket = new sandbox.window.WebSocket('ws://example/ws.ashx');
  socket.deliver('[{"header":"lasttrade","price":"25000"}]');

  assert.equal(sandbox.posted.length, 1);
  assert.equal(sandbox.posted[0].__fts, 'fts-live-tape');
  assert.equal(sandbox.posted[0].data, '[{"header":"lasttrade","price":"25000"}]');
});

test('the page keeps its own message handler', () => {
  const sandbox = makeSandbox();
  run(sandbox);

  const socket = new sandbox.window.WebSocket('ws://example/ws.ashx');
  // The site assigns onmessage directly; capture must not displace it.
  const seen = [];
  socket.onmessage = (e) => seen.push(e.data);
  socket.deliver('{"header":"time","msg":"2900"}');

  assert.deepEqual(seen, ['{"header":"time","msg":"2900"}']);
  assert.equal(sandbox.posted.length, 1);
});

test('a socket created after a reconnect is captured too', () => {
  const sandbox = makeSandbox();
  run(sandbox);

  const first = new sandbox.window.WebSocket('ws://example/ws.ashx');
  const second = new sandbox.window.WebSocket('ws://example/ws.ashx');
  first.deliver('a');
  second.deliver('b');

  assert.deepEqual(sandbox.posted.map((p) => p.data), ['a', 'b']);
});

test('non-string frames are ignored rather than forwarded', () => {
  const sandbox = makeSandbox();
  run(sandbox);

  const socket = new sandbox.window.WebSocket('ws://example/ws.ashx');
  socket.deliver(new ArrayBuffer(4));

  assert.deepEqual(sandbox.posted, []);
});

test('the patch does not double-apply', () => {
  const sandbox = makeSandbox();
  run(sandbox);
  const afterFirst = sandbox.window.WebSocket;
  run(sandbox);
  assert.equal(sandbox.window.WebSocket, afterFirst);

  const socket = new sandbox.window.WebSocket('ws://example/ws.ashx');
  socket.deliver('once');
  // One listener, so one forward — not two.
  assert.equal(sandbox.posted.length, 1);
});

test('the socket keeps its constructor readiness constants', () => {
  const sandbox = makeSandbox();
  run(sandbox);
  assert.equal(sandbox.window.WebSocket.OPEN, 1);
  assert.equal(sandbox.window.WebSocket.CLOSED, 3);
});

test('a listener that throws cannot break the page', () => {
  const sandbox = makeSandbox();
  // postMessage failing must not propagate into the site's own handler.
  sandbox.window.postMessage = () => {
    throw new Error('relay gone');
  };
  run(sandbox);

  const socket = new sandbox.window.WebSocket('ws://example/ws.ashx');
  const seen = [];
  socket.onmessage = (e) => seen.push(e.data);
  assert.doesNotThrow(() => socket.deliver('still works'));
  assert.deepEqual(seen, ['still works']);
});

test('the injected code never calls the page order functions', () => {
  // The viewer is read-only by construction; this keeps it that way. Comments
  // are stripped first, since they name these functions to explain the rule.
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['mSubmitBid', 'mSubmitAsk', 'mHitAsk', 'mHitBid', 'mClearBids', 'mClearAsks']) {
    assert.equal(code.includes(forbidden), false, `inject.js must not call ${forbidden}`);
  }
});
