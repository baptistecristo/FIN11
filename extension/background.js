// Batches captured frames to the local hub, and — only while armed here —
// collects queued orders from it and hands them to the page.
//
// Arming is deliberately split in two. The hub has its own switch, set from the
// viewer; this one is set from the extension popup, in Chrome's own UI. Both
// have to be on before an order can be sent, so a bug on either side cannot
// trade by itself. This one does not survive a restart.

const HUB = 'http://127.0.0.1:8787';
const TAG = 'fts-live-tape';
const BATCH_MS = 100;
const MAX_QUEUE = 200;
const POLL_MS = 300;

let queue = [];
let timer = null;
let posted = 0;
let failures = 0;
let lastError = null;
let lastPostAt = null;

// Never persisted: arming again is a deliberate act every time.
let armed = false;
let pollTimer = null;
let ordersSent = 0;
let lastOrderError = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'frame') {
    queue.push(message.data);
    if (queue.length >= MAX_QUEUE) flush();
    else schedule();
    return false;
  }

  if (message?.type === 'status') {
    sendResponse({
      posted, failures, lastError, lastPostAt, queued: queue.length,
      armed, ordersSent, lastOrderError,
    });
    return true;
  }

  if (message?.type === 'setArmed') {
    setArmed(Boolean(message.armed));
    sendResponse({ armed });
    return true;
  }

  if (message?.type === 'execResult') {
    handleResult(message.payload);
    return false;
  }

  return false;
});

// ---------------------------------------------------------------- capture

function schedule() {
  if (timer !== null) return;
  timer = setTimeout(flush, BATCH_MS);
}

async function flush() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];

  try {
    const res = await fetch(`${HUB}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`hub returned ${res.status}`);
    posted += batch.length;
    lastPostAt = Date.now();
    lastError = null;
    paintBadge();
  } catch (err) {
    // The hub being down must never disturb the page being traded on.
    failures += batch.length;
    lastError = String(err.message || err);
    paintBadge();
  }
}

// ---------------------------------------------------------------- execution

function setArmed(next) {
  armed = next;
  if (!armed) {
    ordersSent = 0;
    stopPolling();
  } else {
    startPolling();
  }
  broadcastArm();
  paintBadge();
}

function broadcastArm() {
  send({ __ftsExec: TAG, type: 'arm', armed, maxOrders: 60 });
}

// Reaches every FTS tab; the page-world script ignores anything it did not ask for.
async function send(payload) {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*.ftswebtrader.com/*', 'http://ftswebtrader.com/*', 'http://95.217.196.212/*'] });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, payload)?.catch?.(() => {});
    }
  } catch (err) {
    lastOrderError = String(err.message || err);
  }
}

function startPolling() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(poll, POLL_MS);
}

function stopPolling() {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

async function poll() {
  if (!armed) return stopPolling();
  try {
    const res = await fetch(`${HUB}/orders`);
    if (!res.ok) throw new Error(`hub returned ${res.status}`);
    const { armed: hubArmed, orders } = await res.json();
    // Both switches must agree. If the hub disarmed, so do we.
    if (!hubArmed) {
      setArmed(false);
      return;
    }
    if (orders?.length) send({ __ftsExec: TAG, type: 'orders', orders });
  } catch (err) {
    lastOrderError = String(err.message || err);
    // Losing the hub while armed is exactly when to stop.
    setArmed(false);
  }
}

async function handleResult(payload) {
  if (payload?.type !== 'result') return;
  if (payload.ok) ordersSent += 1;
  else lastOrderError = payload.error ?? 'send failed';

  try {
    await fetch(`${HUB}/orders/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ results: [{ id: payload.id, ok: payload.ok, error: payload.error }] }),
    });
  } catch {
    /* the hub will notice on its next poll */
  }
  if (!payload.ok) setArmed(false);
  paintBadge();
}

// ---------------------------------------------------------------- badge

function paintBadge() {
  try {
    if (armed) {
      chrome.action.setBadgeText({ text: 'ARM' });
      chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
      return;
    }
    chrome.action.setBadgeText({ text: lastError ? '!' : '' });
    chrome.action.setBadgeBackgroundColor({ color: lastError ? '#b42318' : '#1a7f37' });
  } catch {
    /* action API unavailable during startup */
  }
}
