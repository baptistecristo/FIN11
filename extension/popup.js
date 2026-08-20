const set = (id, text, cls) => {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = cls || '';
};

const armButton = document.getElementById('arm');
const armNote = document.getElementById('armnote');

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
  set('orders', String(status.ordersSent ?? 0));

  if (status.lastError) {
    set('hub', 'unreachable', 'err');
    document.getElementById('hint').textContent =
      'Start the hub: run scripts\\start.ps1 in the FIN11 folder.';
  } else if (status.posted > 0) {
    set('hub', 'connected', 'ok');
    document.getElementById('hint').textContent = status.lastPostAt
      ? `Last frame ${Math.round((Date.now() - status.lastPostAt) / 1000)}s ago.`
      : '';
  } else {
    set('hub', 'waiting', '');
    document.getElementById('hint').textContent =
      'No frames yet. Open ftswebtrader.com and connect to the market.';
  }

  paintArm(status.armed, status.lastOrderError);
}

function paintArm(armed, error) {
  armButton.classList.toggle('on', armed);
  armButton.textContent = armed ? 'Disarm — stop sending' : 'Arm order sending';
  if (error) {
    armNote.textContent = `Last order problem: ${error}`;
    armNote.style.color = '#d92d20';
    return;
  }
  armNote.style.color = armed ? '#d92d20' : '#5a636f';
  armNote.textContent = armed
    ? 'ARMED. Sell orders will be sent while the viewer is also armed. Disarm here or close this tab to stop.'
    : 'Off. Nothing can be sent. Arming here is one of two switches; the viewer has the other.';
}

armButton.addEventListener('click', async () => {
  const status = await chrome.runtime.sendMessage({ type: 'status' });
  await chrome.runtime.sendMessage({ type: 'setArmed', armed: !status?.armed });
  refresh();
});

refresh();
setInterval(refresh, 1000);
