// The only code in this project that can place an order.
//
// Runs in the page's world, alongside the site's own script. It sends the same
// WebSocket messages the FTS client sends, rather than calling mSubmitAsk or
// mHitBid. Those are DOM wrappers whose error paths call alert(), and a
// blocking dialog freezes the page and every automation attached to it. This
// route has no dialog path and no dependency on the #mQty field, which was
// never validated end to end.
//
// It refuses to do anything until armed from the extension popup, and it
// re-checks every order itself rather than trusting the hub that queued it.

(() => {
  const TAG = 'fts-live-tape';
  const CAP = 25000;
  const MIN_GAP_MS = 400;
  // Mirrors of the hub's buying ceilings, checked again here so a hub bug
  // cannot spend the account on assets that expire worthless.
  const MAX_BUY_FRACTION = 0.35;
  const MAX_INVENTORY = 80;

  const state = {
    armed: false,
    socket: null,
    myName: null,
    position: null,
    lastSentAt: 0,
    sent: 0,
    maxOrders: 60,
  };

  // The capture hook hands the socket over as soon as the page opens one.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__ftsExec !== TAG) return;
    if (d.type === 'arm') {
      state.armed = Boolean(d.armed);
      state.maxOrders = Number(d.maxOrders) || state.maxOrders;
      reply({ type: 'armed', armed: state.armed });
      return;
    }
    if (d.type === 'orders') {
      for (const order of d.orders ?? []) send(order);
    }
  });

  function reply(payload) {
    try {
      window.postMessage({ __ftsExecResult: TAG, ...payload }, '*');
    } catch {
      /* nothing useful to do if the bridge is gone */
    }
  }

  // Track what the server says we hold, so a sell can be checked against the
  // real position rather than against anything the hub believes.
  function observe(raw) {
    let messages;
    try {
      messages = JSON.parse(raw);
    } catch {
      return;
    }
    for (const m of Array.isArray(messages) ? messages : [messages]) {
      if (!m || !m.header) continue;
      if (m.header === 'endow') {
        const n = Number(String(m.msg).replace(/,/g, ''));
        if (Number.isFinite(n)) state.position = n;
      }
      if (m.header === 'loggedin' || m.header === 'login') {
        if (typeof m.msg === 'string' && m.msg.includes('@')) state.myName = m.msg;
      }
    }
  }

  function findSocket() {
    if (state.socket && state.socket.readyState === 1) return state.socket;
    try {
      if (window.ws && window.ws.readyState === 1) {
        state.socket = window.ws;
        return state.socket;
      }
    } catch {
      /* not ready */
    }
    return null;
  }

  function refuse(order, reason) {
    reply({ type: 'result', id: order?.id, ok: false, error: reason });
  }

  function send(order) {
    if (!state.armed) return refuse(order, 'executor is not armed');
    if (state.sent >= state.maxOrders) return refuse(order, 'order limit reached');

    const now = Date.now();
    if (now - state.lastSentAt < MIN_GAP_MS) return refuse(order, 'too soon after the last order');

    const socket = findSocket();
    if (!socket) return refuse(order, 'no open socket to the market');

    const header = order?.header;
    // Whitelist, not blacklist. Anything not named here cannot be sent at all.
    const SELLS = ['sell', 'ask'];
    const BUYS = ['buy', 'bid'];
    const CANCELS = ['clearasks', 'clearbids'];
    if (![...SELLS, ...BUYS, ...CANCELS].includes(header)) {
      return refuse(order, `refused header ${header}`);
    }

    const message = { header, isno: Number(order.isno) || 1 };

    if (!CANCELS.includes(header)) {
      const qty = Math.floor(Number(order.qty));
      const price = Number(order.price);
      if (!Number.isFinite(qty) || qty < 1) return refuse(order, 'bad quantity');
      if (!Number.isFinite(price) || price <= 0 || price > CAP) return refuse(order, 'bad price');

      if (BUYS.includes(header)) {
        // Independent ceilings on buying. Bottles are worth nothing at the
        // bell, so paying near the cap leaves no upside to sell into.
        if (price > CAP * MAX_BUY_FRACTION) {
          return refuse(order, `will not pay ${price} for something worth zero at the bell`);
        }
        if (state.position !== null && state.position + qty > MAX_INVENTORY) {
          return refuse(order, `would hold ${state.position + qty}, above ${MAX_INVENTORY}`);
        }
      } else if (state.position !== null && qty > state.position) {
        // Independent short-sale check against what the server last told us.
        return refuse(order, `would sell ${qty} holding ${state.position}`);
      }

      message.price = String(price);
      message.qty = String(qty);
    }

    // The direct route has no dialog path, but a dialog raised by anything else
    // while we are mid-send would freeze the page. Neutralise them for the
    // duration and hand back whatever was suppressed.
    const saved = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
    const suppressed = [];
    window.alert = (m) => suppressed.push(String(m));
    window.confirm = (m) => {
      suppressed.push(String(m));
      return false;
    };
    window.prompt = (m) => {
      suppressed.push(String(m));
      return null;
    };

    try {
      socket.send(window.JSON.stringify(message));
      state.sent += 1;
      state.lastSentAt = now;
      reply({ type: 'result', id: order.id, ok: true, message, suppressed });
    } catch (err) {
      reply({ type: 'result', id: order.id, ok: false, error: String(err?.message ?? err) });
    } finally {
      window.alert = saved.alert;
      window.confirm = saved.confirm;
      window.prompt = saved.prompt;
    }
  }

  // Watch the feed for position and identity without touching the capture hook.
  const NativeWS = window.WebSocket;
  if (NativeWS && !NativeWS.__ftsExecWatching) {
    const seen = new WeakSet();
    setInterval(() => {
      const socket = findSocket();
      if (!socket || seen.has(socket)) return;
      seen.add(socket);
      socket.addEventListener('message', (e) => {
        if (typeof e.data === 'string') observe(e.data);
      });
    }, 1000);
    try {
      NativeWS.__ftsExecWatching = true;
    } catch {
      /* frozen constructor is fine */
    }
  }

  // The login field is the simplest source of truth for who we are, which the
  // own-quote check needs.
  setInterval(() => {
    if (state.myName) return;
    const field = document.getElementById('txtTrdName');
    if (field && field.value && field.value.includes('@')) state.myName = field.value;
    if (state.myName) reply({ type: 'identity', myName: state.myName });
  }, 2000);
})();
