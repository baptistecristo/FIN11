// Batches captured frames and posts them to the local hub.

const ENDPOINT = 'http://127.0.0.1:8787/ingest';
const BATCH_MS = 100;
const MAX_QUEUE = 200;

let queue = [];
let timer = null;
let posted = 0;
let failures = 0;
let lastError = null;
let lastPostAt = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'frame') {
    queue.push(message.data);
    // Flush early on a burst so a sleeping worker cannot sit on a large backlog.
    if (queue.length >= MAX_QUEUE) flush();
    else schedule();
    return false;
  }
  if (message?.type === 'status') {
    sendResponse({ posted, failures, lastError, lastPostAt, queued: queue.length });
    return true;
  }
  return false;
});

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
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`hub returned ${res.status}`);
    posted += batch.length;
    lastPostAt = Date.now();
    lastError = null;
    badge('', '#1a7f37');
  } catch (err) {
    // The hub being down must never disturb the page the user is trading on.
    // Drop the batch and keep going; the browser tab is unaffected.
    failures += batch.length;
    lastError = String(err.message || err);
    badge('!', '#b42318');
  }
}

function badge(text, color) {
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* action API unavailable during startup */
  }
}
