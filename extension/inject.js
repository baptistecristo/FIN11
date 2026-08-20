// Runs in the page's own world at document_start.
//
// Read-only by construction: it observes incoming frames and never calls the
// page's order functions (mSubmitBid, mSubmitAsk, mHitAsk, mHitBid, mClearBids,
// mClearAsks). It cannot place an order and cannot trigger the blocking alert()
// that freezes browser automation.

(() => {
  const TAG = 'fts-live-tape';
  const Native = window.WebSocket;
  if (!Native || Native.__ftsPatched) return;

  function forward(data) {
    if (typeof data !== 'string') return;
    try {
      window.postMessage({ __fts: TAG, data }, '*');
    } catch {
      // A frame we cannot hand off is not worth breaking the page over.
    }
  }

  const attached = new WeakSet();
  function attach(socket) {
    if (!socket || attached.has(socket)) return;
    attached.add(socket);
    // Additive: the page keeps its own onmessage handler and its UI keeps working.
    socket.addEventListener('message', (event) => forward(event.data));
  }

  // The page builds its socket inside a click handler, so there is nothing to
  // hook at document_start. Patching the constructor catches the socket whenever
  // it is created, including on reconnect, with no polling.
  function PatchedWebSocket(...args) {
    const socket = new Native(...args);
    try {
      attach(socket);
    } catch {
      // Ignore: capture must never break the page the user is trading on.
    }
    return socket;
  }
  PatchedWebSocket.prototype = Native.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    PatchedWebSocket[key] = Native[key];
  }
  PatchedWebSocket.__ftsPatched = true;

  try {
    window.WebSocket = PatchedWebSocket;
  } catch {
    return;
  }

  // Fallback for the case where the extension is enabled after the page already
  // connected: the site leaves its socket on window.ws as an implicit global.
  // Normally the constructor patch has already caught it and this does nothing.
  const sweep = setInterval(() => {
    try {
      if (window.ws && typeof window.ws.addEventListener === 'function') attach(window.ws);
    } catch {
      /* cross-origin or not ready yet */
    }
  }, 2000);
  window.addEventListener('beforeunload', () => clearInterval(sweep));
})();
