// Runs in the extension's isolated world. Bridges frames from the page world to
// the service worker, which is the only context allowed to reach 127.0.0.1
// without tripping Chrome's private-network restrictions.

const TAG = 'fts-live-tape';

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const payload = event.data;
  if (!payload || payload.__fts !== TAG || typeof payload.data !== 'string') return;
  try {
    // The worker may be asleep; sendMessage wakes it. Rejection just means the
    // extension is reloading, and the page is unaffected either way.
    chrome.runtime.sendMessage({ type: 'frame', data: payload.data })?.catch?.(() => {});
  } catch {
    /* extension context invalidated */
  }
});

// Execution bridge. Orders come from the service worker (the only context that
// may reach the hub) and go to execute.js in the page world; results come back
// the same way. The relay itself validates nothing: both ends do that.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.__ftsExec !== TAG) return false;
  try {
    window.postMessage({ ...message }, '*');
  } catch {
    /* page went away */
  }
  return false;
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const payload = event.data;
  if (!payload || payload.__ftsExecResult !== TAG) return;
  try {
    chrome.runtime.sendMessage({ type: 'execResult', payload })?.catch?.(() => {});
  } catch {
    /* extension context invalidated */
  }
});
