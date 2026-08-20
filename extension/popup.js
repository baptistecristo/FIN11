const set = (id, text, cls) => {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = cls || '';
};

async function refresh() {
  let status;
  try {
    status = await chrome.runtime.sendMessage({ type: 'status' });
  } catch {
    set('hint', 'Extension is reloading — reopen this popup.');
    return;
  }
  if (!status) return;

  set('posted', String(status.posted));
  set('queued', String(status.queued));
  set('failures', String(status.failures), status.failures ? 'err' : '');

  if (status.lastError) {
    set('hub', 'unreachable', 'err');
    document.getElementById('hint').textContent =
      'Start the hub: run scripts\\start.ps1 in the FIN11 folder.';
  } else if (status.posted > 0) {
    set('hub', 'connected', 'ok');
    document.getElementById('hint').textContent =
      status.lastPostAt ? `Last frame ${Math.round((Date.now() - status.lastPostAt) / 1000)}s ago.` : '';
  } else {
    set('hub', 'waiting', '');
    document.getElementById('hint').textContent =
      'No frames yet. Open ftswebtrader.com and connect to the market.';
  }
}

refresh();
setInterval(refresh, 1000);
