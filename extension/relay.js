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
