/* =========================================================================
   LaundryLink — self-contained laundry machine status app.
   State lives in localStorage (with an in-memory fallback), all timers are
   Date-based so they survive reloads and tab throttling.

   v2: Machine Setup admin page (dynamic QR generation), OTP reserve/unlock
   flow, slot booking with a 10-minute no-show protection window.
   ========================================================================= */
'use strict';

(function () {
  /* ---------------------------------------------------------- constants */

  var STATE_KEY = 'laundrylink.state.v1';
  var THEME_KEY = 'laundrylink.theme';
  var DEVICE_KEY = 'laundrylink.device';
  var INITIAL_MACHINE_COUNT = 15;
  var GRACE_MS = 10 * 60 * 1000;          // collect window + booking confirm window
  var DURATIONS = [
    { v: 30, label: '30 min (Quick wash)' },
    { v: 40, label: '40 min (Standard wash)' },
    { v: 60, label: '60 min (Heavy load)' }
  ];
  var DEFAULT_DURATION = 40;
  var OTP_ATTEMPT_LIMIT = 2;
  var ACTIVE_BOOKING_STATUSES = ['upcoming', 'pending', 'confirmed'];

  /* ---------------------------------------------------------- utilities */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function pad2(n) { return String(n).length < 2 ? '0' + n : String(n); }

  function fmtClock(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      var d = new Date(ts);
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
  }

  function fmtMMSS(ms) {
    var t = Math.max(0, Math.round(ms / 1000));
    return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60);
  }

  function dayKey(d) {
    var x = new Date(d);
    return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
  }

  function toastHost(msg, ms) {
    var host = $('#toasts');
    if (!host) return;
    while (host.children.length >= 3) host.removeChild(host.firstChild);
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add('out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, ms || 4200);
  }

  /* ---------------------------------------------------------- storage */

  var mem = {}; // in-memory fallback (e.g. sandboxed iframes without storage)

  var store = {
    get: function (k) {
      try {
        var v = window.localStorage.getItem(k);
        if (v !== null) return v;
      } catch (e) {}
      return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null;
    },
    set: function (k, v) {
      mem[k] = v;
      try { window.localStorage.setItem(k, v); } catch (e) {}
    },
    del: function (k) {
      delete mem[k];
      try { window.localStorage.removeItem(k); } catch (e) {}
    }
  };

  /* ---------------------------------------------------------- device id */

  var DEVICE = (function () {
    var id = store.get(DEVICE_KEY);
    if (!id) {
      id = 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
      store.set(DEVICE_KEY, id);
    }
    return id;
  })();

  /* ---------------------------------------------------------- seed data */

  function fnvHash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Expected washes per hour of day (peaks: morning + evening).
  var HOUR_WEIGHTS = [
    0.3, 0.15, 0.1, 0.1, 0.15, 0.5,
    1.6, 3.0, 4.0, 3.0, 2.2, 2.0,
    2.6, 2.0, 1.6, 2.1, 3.1, 4.5,
    5.0, 4.4, 3.4, 2.4, 1.4, 0.6
  ];

  function seedUsage(now) {
    var usage = {};
    for (var back = 6; back >= 0; back--) {
      var d = new Date(now - back * 86400000);
      var key = dayKey(d);
      var rnd = mulberry32(fnvHash(key));
      var dow = d.getDay();
      var dayFactor = (dow === 0 || dow === 6) ? 1.15 : 1.0;
      var nowHour = new Date(now).getHours();
      var hours = {};
      for (var h = 0; h < 24; h++) {
        if (back === 0 && h > nowHour) break;
        var w = HOUR_WEIGHTS[h] * dayFactor;
        var count;
        if (w < 0.4) {
          count = rnd() < 0.4 * w + 0.15 ? 1 : 0;
        } else {
          count = Math.max(0, Math.round(w * (0.55 + 0.9 * rnd())));
        }
        if (count > 0) hours[h] = count;
      }
      usage[key] = hours;
    }
    return usage;
  }

  function makeMachine(id) {
    return {
      id: id,
      name: null,            // custom display name (set via Machine Setup)
      sensor: id === 1,      // Machine 1 is the physical machine with a live sensor
      status: 'free',        // free | busy | complete
      startedAt: null,
      endsAt: null,
      durationMin: null,
      graceEndsAt: null,
      startedBy: null,
      mine: false,           // started from this device
      queue: [],             // [{ deviceId, name, at }] — FIFO
      bookings: []           // [{ id, machineId, startAt, endAt, durationMin, deviceId, name, status }]
    };
  }

  function defaultState() {
    var now = Date.now();
    var machines = [];
    for (var i = 1; i <= INITIAL_MACHINE_COUNT; i++) machines.push(makeMachine(i));

    // A believable mid-day snapshot so the demo feels alive immediately.
    function busy(id, durMin, leftMin, by) {
      var m = machines[id - 1];
      m.status = 'busy';
      m.durationMin = durMin;
      m.startedAt = now - (durMin - leftMin) * 60000;
      m.endsAt = now + leftMin * 60000;
      m.startedBy = by;
    }
    busy(2, 40, 26, 'Ravi (304)');
    busy(7, 60, 47, 'Priya (112)');
    busy(9, 30, 8, 'Anonymous');

    var done = machines[10]; // Machine 11 — completed 3.5 min ago, 6.5 min of grace left
    done.status = 'complete';
    done.durationMin = 40;
    done.endsAt = now - 3.5 * 60000;
    done.startedAt = done.endsAt - 40 * 60000;
    done.graceEndsAt = now + 6.5 * 60000;
    done.startedBy = 'Kabir (415)';

    // Two students already waiting on Machine 2 — shows FIFO queue counts.
    machines[1].queue = [
      { deviceId: 'seed-a', name: 'Sneha (210)', at: now - 180000 },
      { deviceId: 'seed-b', name: 'Imran (118)', at: now - 60000 }
    ];

    return {
      version: 1,
      prefs: { filterFree: false, userName: '' },
      machines: machines,
      usage: seedUsage(now)
    };
  }

  function migrate(s) {
    if (!s.prefs) s.prefs = { filterFree: false, userName: '' };
    if (!s.usage) s.usage = {};
    var now = Date.now();
    s.machines.forEach(function (m) {
      if (!Array.isArray(m.bookings)) m.bookings = [];
      if (!Array.isArray(m.queue)) m.queue = [];
      if (!('name' in m)) m.name = null;
      if (m.id === 1) m.sensor = true;
      // Drop stale timers from a previous day so the demo is sane.
      if (m.status === 'busy' && (!m.endsAt || m.endsAt > now + 24 * 3600000)) {
        Object.assign(m, makeMachine(m.id));
      }
      if (m.status === 'complete' && (!m.graceEndsAt || m.graceEndsAt > now + GRACE_MS + 3600000)) {
        Object.assign(m, makeMachine(m.id));
      }
      m.bookings = m.bookings.filter(function (b) {
        return ACTIVE_BOOKING_STATUSES.indexOf(b.status) >= 0 || b.status === 'pending';
      });
    });
    return s;
  }

  var state = (function load() {
    var raw = store.get(STATE_KEY);
    if (raw) {
      try {
        var s = JSON.parse(raw);
        if (s && s.version === 1 && Array.isArray(s.machines) && s.machines.length) {
          return migrate(s);
        }
      } catch (e) {}
    }
    var fresh = defaultState();
    try { store.set(STATE_KEY, JSON.stringify(fresh)); } catch (e) {}
    return fresh;
  })();

  function save() {
    try { store.set(STATE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function getMachine(id) {
    for (var i = 0; i < state.machines.length; i++) {
      if (state.machines[i].id === id) return state.machines[i];
    }
    return null;
  }

  function queueIndex(m) {
    for (var i = 0; i < m.queue.length; i++) {
      if (m.queue[i].deviceId === DEVICE) return i;
    }
    return -1;
  }

  function mLabel(m) {
    return m.name || ('Machine ' + m.id);
  }

  function nextMachineId() {
    var max = 0;
    state.machines.forEach(function (m) { if (m.id > max) max = m.id; });
    return max + 1;
  }

  /* ---------------------------------------------------------- bookings */

  function activeBookings(m) {
    return m.bookings
      .filter(function (b) { return ACTIVE_BOOKING_STATUSES.indexOf(b.status) >= 0; })
      .sort(function (a, b) { return a.startAt - b.startAt; });
  }

  function nextBooking(m) {
    var list = activeBookings(m);
    return list.length ? list[0] : null;
  }

  function findBooking(m, bid) {
    for (var i = 0; i < m.bookings.length; i++) {
      if (m.bookings[i].id === bid) return m.bookings[i];
    }
    return null;
  }

  function fmtRange(b) {
    return fmtClock(b.startAt) + ' – ' + fmtClock(b.endAt);
  }

  function newBookingId() {
    return 'b-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------------------------------------------------- theme */

  function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  function setTheme(t, persist) {
    document.documentElement.dataset.theme = t;
    if (persist !== false) store.set(THEME_KEY, t);
    var btn = $('#themeBtn');
    if (btn) btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }

  function toggleTheme() {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
  }

  /* ---------------------------------------------------------- audio */

  var AC = null;

  function ensureAudio() {
    try {
      if (!AC) {
        var C = window.AudioContext || window.webkitAudioContext;
        if (C) AC = new C();
      }
      if (AC && AC.state === 'suspended') AC.resume();
    } catch (e) {}
  }

  function beep(kind) {
    if (!AC) return;
    try {
      var t = AC.currentTime;
      var seq = kind === 'done'
        ? [[880, 0.00, 0.18], [660, 0.24, 0.18], [880, 0.48, 0.28]]
        : [[700, 0.00, 0.14], [920, 0.18, 0.20]];
      seq.forEach(function (n) {
        var f = n[0], d = n[1], dur = n[2];
        var osc = AC.createOscillator();
        var gain = AC.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, t + d);
        gain.gain.exponentialRampToValueAtTime(0.22, t + d + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + d + dur);
        osc.connect(gain);
        gain.connect(AC.destination);
        osc.start(t + d);
        osc.stop(t + d + dur + 0.05);
      });
    } catch (e) {}
  }

  /* ---------------------------------------------------------- notifications */

  function notifyPermission() {
    try {
      if (typeof window.Notification !== 'undefined') return Notification.permission;
    } catch (e) {}
    return 'unsupported';
  }

  function updateBell() {
    var btn = $('#bellBtn');
    if (!btn) return;
    var p = notifyPermission();
    btn.classList.toggle('has-dot', p === 'default');
    btn.title = p === 'granted' ? 'Notifications enabled' :
      p === 'denied' ? 'Notifications blocked — in-app alerts still work' :
      p === 'unsupported' ? 'In-app alerts only' : 'Enable notifications';
  }

  function requestNotifyPermission() {
    var p = notifyPermission();
    if (p !== 'default') return;
    try {
      var r = Notification.requestPermission();
      if (r && typeof r.then === 'function') r.then(updateBell).catch(function () {});
    } catch (e) {}
    setTimeout(updateBell, 400);
  }

  // Combined alert: in-app toast + sound + (best effort) system notification.
  // `quiet: true` shows only the in-app toast (used when someone else is first
  // in a queue — no beep for an event that isn't yours).
  function alertUser(opt) {
    if (opt.quiet) {
      toastHost(opt.title + (opt.body ? ' — ' + opt.body : ''), opt.ms || 4000);
      return;
    }
    toastHost(opt.title + (opt.body ? ' — ' + opt.body : ''), opt.ms || 5200);
    if (opt.sound !== false) beep(opt.soundKind || 'done');
    try {
      if (typeof window.Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(opt.title, { body: opt.body || '', tag: opt.tag || 'laundrylink' });
      }
    } catch (e) {}
  }

  /* ---------------------------------------------------------- router */

  var useHash = false;

  function matchPath(p) {
    if (!p) return { name: 'home' };
    var m = p.match(/\/machine\/(\d+)\/?$/);
    if (m) return { name: 'machine', id: parseInt(m[1], 10) };
    if (/^\/analytics\/?$/.test(p)) return { name: 'analytics' };
    if (/^\/setup\/?$/.test(p)) return { name: 'setup' };
    if (/^\/?$/.test(p)) return { name: 'home' };
    return null;
  }

  function parseRoute() {
    if (useHash) {
      return matchPath(location.hash.replace(/^#/, '') || '/') || { name: 'home' };
    }
    var r = matchPath(location.pathname || '/');
    if (r) return r;
    var h = location.hash.replace(/^#/, '');
    if (h) {
      r = matchPath(h);
      if (r) return r;
    }
    if ((location.pathname || '/').endsWith('/')) return { name: 'home' };
    return { name: '404', path: location.pathname };
  }

  function navigate(href) {
    if (useHash) {
      var target = '#' + href;
      if (location.hash !== target) location.hash = target;
      else render();
      return;
    }
    try {
      history.pushState({}, '', href);
    } catch (e) {
      useHash = true;
      location.hash = '#' + href;
      return;
    }
    render();
    try { window.scrollTo(0, 0); } catch (e) {}
  }

  /* ---------------------------------------------------------- QR codes */

  function baseUrl() {
    return /^https?:$/.test(location.protocol)
      ? location.origin
      : 'https://laundrylink.example.com';
  }

  function machineUrl(id) {
    return baseUrl() + '/machine/' + id;
  }

  function qrSvg(text, px) {
    try {
      if (typeof window.qrcode === 'undefined') throw new Error('qr lib missing');
      var qr = null, lastErr = null;
      var attempts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      for (var i = 0; i < attempts.length; i++) {
        try {
          var q = window.qrcode(attempts[i], 'M');
          q.addData(text);
          q.make();
          qr = q;
          break;
        } catch (e) { lastErr = e; }
      }
      if (!qr) throw lastErr || new Error('qr failed');

      var n = qr.getModuleCount();
      var quiet = 3;
      var total = n + quiet * 2;
      var cells = '';
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (qr.isDark(r, c)) {
            cells += '<rect x="' + (c + quiet) + '" y="' + (r + quiet) + '" width="1" height="1"/>';
          }
        }
      }
      var size = px || 150;
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total +
        '" width="' + size + '" height="' + size + '" shape-rendering="crispEdges" role="img" aria-label="QR code for ' +
        esc(text) + '"><rect width="' + total + '" height="' + total + '" fill="#ffffff"/>' +
        '<g fill="#101418">' + cells + '</g></svg>';
    } catch (e) {
      return '<p class="muted" style="font-size:13px">QR unavailable</p>';
    }
  }

  function mountQRs() {
    $$('[data-machine]').forEach(function (el) {
      if (el.dataset.mounted === '1') return;
      var id = parseInt(el.dataset.machine, 10);
      el.innerHTML = qrSvg(machineUrl(id), parseInt(el.dataset.qrSize, 10) || 150);
      el.dataset.mounted = '1';
    });
  }

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'machine';
  }

  function downloadQR(id) {
    var m = getMachine(id);
    if (!m) return;
    var svg = qrSvg(machineUrl(id), 1024);
    if (svg.indexOf('<svg') !== 0) { toastHost('QR code is unavailable right now.'); return; }
    try {
      var blob = new Blob([svg], { type: 'image/svg+xml' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'laundrylink-' + slugify(mLabel(m)) + '-qr.svg';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    } catch (e) {
      toastHost('Download not supported in this browser.');
    }
  }

  /* ---------------------------------------------------------- views */

  function statusLabel(m, now) {
    if (m.status === 'free') return 'Free';
    if (m.status === 'complete') return 'Cycle Complete — Collect Now';
    var mins = Math.max(1, Math.ceil((m.endsAt - now) / 60000));
    return 'Busy — ' + mins + ' min left';
  }

  function progressPct(m, now) {
    if (m.status === 'complete') return 100;
    if (m.status === 'free' || !m.startedAt || !m.durationMin) return 0;
    var total = m.durationMin * 60000;
    return clamp(Math.round(((now - m.startedAt) / total) * 100), 0, 100);
  }

  function subText(m, now) {
    var base;
    if (m.status === 'free') {
      if (m.queue.length) {
        var head = m.queue[0];
        base = head.deviceId === DEVICE
          ? 'You were notified first — start when ready.'
          : esc(head.name) + ' was notified first.';
      } else {
        base = 'Ready to use';
      }
    } else if (m.status === 'busy') {
      base = 'Started ' + fmtClock(m.startedAt) + ' · ' + m.durationMin + ' min cycle · ' + esc(m.startedBy || '—');
    } else {
      base = 'Auto-free in ' + fmtMMSS(m.graceEndsAt - now) + ' — please collect';
    }
    if (m.sensor) base = 'Live sensor · ' + base;
    return base;
  }

  function queueLineText(m) {
    var n = m.queue.length;
    if (!n) return '';
    var s = n + (n === 1 ? ' person waiting' : ' people waiting');
    if (m.status === 'free') {
      var head = m.queue[0];
      s += head.deviceId === DEVICE
        ? ' — you were notified first'
        : ' — ' + esc(head.name) + ' notified first';
    }
    return s;
  }

  function pendingBooking(m) {
    for (var i = 0; i < m.bookings.length; i++) {
      var b = m.bookings[i];
      if (b.status === 'pending') return b;
    }
    return null;
  }

  function bookedChipText(m, now) {
    var b = nextBooking(m);
    if (!b) return null;
    var extra = activeBookings(m).length > 1 ? ' (+' + (activeBookings(m).length - 1) + ')' : '';
    if (b.status === 'pending') {
      return {
        cls: 'booked-chip pending',
        text: (b.deviceId === DEVICE ? 'Reserved — confirm in ' : 'Held — confirm in ') +
          fmtMMSS(b.deadline - now) + extra
      };
    }
    if (b.status === 'confirmed') {
      return { cls: 'booked-chip confirmed', text: 'Confirmed: ' + fmtRange(b) + extra };
    }
    return { cls: 'booked-chip', text: 'Booked: ' + fmtRange(b) + extra };
  }

  var CAL_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>';

  function machineCardHTML(m) {
    return '' +
      '<article class="card machine" data-id="' + m.id + '">' +
        '<div class="m-head">' +
          '<span class="m-name">' + esc(mLabel(m)) + '</span>' +
          '<span class="badge" data-r="badge"></span>' +
        '</div>' +
        '<p class="m-sub" data-r="sub"></p>' +
        '<span class="booked-chip" data-r="booked" hidden></span>' +
        '<div class="progress" data-r="progress" hidden><div class="bar" data-r="bar"></div></div>' +
        '<div class="m-actions">' +
          '<button class="btn primary" type="button" data-act="start">Reserve &amp; Start</button>' +
          '<button class="btn tonal" type="button" data-act="notify">Notify me when free</button>' +
          '<button class="btn text" type="button" data-act="leave" hidden>Leave queue</button>' +
          '<p class="queue-line" data-r="queue" hidden></p>' +
        '</div>' +
        '<a class="details" data-link href="/machine/' + m.id + '">Details' +
          '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>' +
        '</a>' +
      '</article>';
  }

  function chipsHTML() {
    var free = 0, busy = 0, complete = 0;
    state.machines.forEach(function (m) {
      if (m.status === 'free') free++;
      else if (m.status === 'busy') busy++;
      else complete++;
    });
    return '<span class="chip"><i class="dot free"></i><b>' + free + '</b> Free</span>' +
      '<span class="chip"><i class="dot busy"></i><b>' + busy + '</b> Busy</span>' +
      '<span class="chip"><i class="dot complete"></i><b>' + complete + '</b> Complete</span>';
  }

  function pageHeadHTML() {
    return '' +
      '<div class="page-head">' +
        '<div>' +
          '<h1>Washing machines</h1>' +
          '<p class="sub">Hostel laundry · live status, updates every second</p>' +
        '</div>' +
        '<label class="switch">' +
          '<input type="checkbox" id="filterFree"' + (state.prefs.filterFree ? ' checked' : '') + '>' +
          '<span class="track"><span class="knob"></span></span>' +
          '<span>Show only free machines</span>' +
        '</label>' +
      '</div>';
  }

  function viewHome() {
    if (!state.machines.length) {
      return pageHeadHTML() +
        '<div class="empty">No machines yet. <a data-link href="/setup">Add one in Machine setup</a>.</div>';
    }
    return pageHeadHTML() +
      '<div class="chips" id="chips">' + chipsHTML() + '</div>' +
      '<div class="grid" id="grid">' +
        state.machines.map(machineCardHTML).join('') +
        '<div class="empty" id="emptyState" hidden>No free machines right now — use “Notify me when free” on a busy machine to join the queue.</div>' +
      '</div>';
  }

  function actionButtonsHTML() {
    return '' +
      '<div class="m-actions">' +
        '<button class="btn primary" type="button" data-act="start">Reserve &amp; Start</button>' +
        '<button class="btn tonal" type="button" data-act="notify">Notify me when free</button>' +
        '<button class="btn text" type="button" data-act="leave" hidden>Leave queue</button>' +
      '</div>';
  }

  function bookingRowHTML(m, b) {
    var pillCls = b.status === 'pending' ? ' pending' : b.status === 'confirmed' ? ' confirmed' : '';
    var pillText = b.status === 'pending' ? 'Confirm now' : b.status === 'confirmed' ? 'Confirmed' : 'Upcoming';
    var acts = '';
    if (b.status === 'upcoming') {
      acts += '<button class="btn ghost sm" type="button" data-act="booking-cancel" data-b="' + b.id + '">Cancel</button>';
    } else if (b.status === 'pending') {
      acts += '<button class="btn primary sm" type="button" data-act="booking-arrive" data-b="' + b.id + '">Confirm arrival</button>' +
        '<button class="btn ghost sm" type="button" data-act="booking-cancel" data-b="' + b.id + '">Cancel</button>';
    } else if (b.status === 'confirmed') {
      acts += '<button class="btn primary sm" type="button" data-act="booking-arrive" data-b="' + b.id + '">Start via OTP</button>' +
        '<button class="btn ghost sm" type="button" data-act="booking-cancel" data-b="' + b.id + '">Cancel</button>';
    }
    return '<li>' +
      '<span class="btime">' + esc(fmtRange(b)) + '</span>' +
      '<span class="bmeta">' + b.durationMin + ' min' + (b.deviceId === DEVICE ? ' · your slot' : '') + '</span>' +
      '<span class="bspacer"></span>' +
      '<span class="bspill' + pillCls + '">' + pillText + '</span>' +
      acts +
      '</li>';
  }

  function viewBookingsCard(m) {
    var list = activeBookings(m);
    var body = list.length
      ? '<ul class="blist">' + list.map(function (b) { return bookingRowHTML(m, b); }).join('') + '</ul>'
      : '<p class="blist-empty">No slots booked yet.</p>';
    return '' +
      '<div class="card" style="padding:20px" data-id="' + m.id + '">' +
        '<div class="card-head">' +
          '<h2>Booked slots</h2>' +
          '<button class="btn tonal sm" type="button" data-act="open-booking">Book a slot</button>' +
        '</div>' +
        body +
        '<p class="hint" style="margin-top:12px">At the start of your slot we’ll ask you to confirm within 10 minutes — otherwise it’s released to the queue.</p>' +
      '</div>';
  }

  function viewMachine(id) {
    var m = getMachine(id);
    if (!m) return view404();
    return '' +
      '<div class="crumbs no-print"><a data-link href="/">← All machines</a></div>' +
      '<div class="detail-grid">' +
        '<div class="card machine machine-view" data-id="' + m.id + '">' +
          '<div class="m-head">' +
            '<span class="m-name big">' + esc(mLabel(m)) + '</span>' +
            '<span class="badge" data-r="badge"></span>' +
          '</div>' +
          '<div class="countdown" data-r="count">Free</div>' +
          '<p class="m-sub" data-r="sub"></p>' +
          '<span class="booked-chip" data-r="booked" hidden></span>' +
          '<div class="progress lg" data-r="progress" hidden><div class="bar" data-r="bar"></div></div>' +
          '<dl class="meta">' +
            '<div class="row" data-r="rowStarted"><dt>Started</dt><dd data-r="started">—</dd></div>' +
            '<div class="row" data-r="rowEnds" hidden><dt data-r="endsLabel">Ends</dt><dd data-r="ends">—</dd></div>' +
            '<div class="row"><dt>Duration</dt><dd data-r="duration">—</dd></div>' +
            '<div class="row"><dt>Started by</dt><dd data-r="by">—</dd></div>' +
            '<div class="row"><dt>Source</dt><dd>' + (m.sensor ? 'Live sensor' : 'Simulated') + '</dd></div>' +
          '</dl>' +
          actionButtonsHTML() +
          '<p class="queue-line" data-r="queue" hidden></p>' +
          '<div class="queue-box" data-r="queueBox" hidden>' +
            '<h3>Waiting in line</h3>' +
            '<ul data-r="queueList"></ul>' +
          '</div>' +
        '</div>' +
        viewBookingsCard(m) +
      '</div>';
  }

  /* ---- Machine Setup (admin) ---- */

  var lastGeneratedId = null;

  function viewSetup() {
    var rows = state.machines.slice().sort(function (a, b) { return a.id - b.id; }).map(function (m) {
      return '' +
        '<div class="mrow" data-id="' + m.id + '">' +
          '<div class="qr-thumb" data-machine="' + m.id + '" data-qr-size="88"></div>' +
          '<div class="mrow-info">' +
            '<span class="mrow-name">' + esc(mLabel(m)) +
              (m.sensor ? '<span class="tag-sensor">Sensor</span>' : '<span class="tag-sim">Simulated</span>') +
            '</span>' +
            '<span class="mrow-id">/machine/' + m.id + '</span>' +
          '</div>' +
          '<div class="mrow-acts">' +
            '<a class="btn ghost sm" data-link href="/machine/' + m.id + '">Open</a>' +
            '<button class="btn tonal sm" type="button" data-act="download-qr" data-id="' + m.id + '">Download</button>' +
            '<button class="btn danger sm" type="button" data-act="delete-machine" data-id="' + m.id + '">Delete machine</button>' +
          '</div>' +
        '</div>';
    }).join('');

    var gen = '';
    var gm = lastGeneratedId != null ? getMachine(lastGeneratedId) : null;
    if (gm) {
      gen = '' +
        '<div class="gen-panel" id="genPanel">' +
          '<div class="qr-frame" data-machine="' + gm.id + '" data-qr-size="168"></div>' +
          '<div class="gen-info">' +
            '<span class="gen-name">' + esc(mLabel(gm)) + '</span>' +
            '<span class="url-code">' + esc(machineUrl(gm.id)) + '</span>' +
            '<span class="gen-actions">' +
              '<button class="btn primary sm" type="button" data-act="download-qr" data-id="' + gm.id + '">Download QR</button>' +
              '<a class="btn ghost sm" data-link href="/machine/' + gm.id + '">Open machine page</a>' +
            '</span>' +
          '</div>' +
        '</div>';
    }

    return '' +
      '<div class="page-head">' +
        '<div>' +
          '<h1>Machine setup</h1>' +
          '<p class="sub">Admin — add machines and generate their QR codes. Scanning a code opens the machine’s live status page.</p>' +
        '</div>' +
      '</div>' +
      '<div class="card setup-form">' +
        '<div class="setup-row">' +
          '<div class="field" style="margin-bottom:0">' +
            '<label for="setupName">Machine Name/Number</label>' +
            '<input id="setupName" type="text" maxlength="40" placeholder="e.g. 16, or “Block C Washer”">' +
          '</div>' +
          '<button class="btn primary" type="button" data-act="generate-qr">Generate QR Code</button>' +
        '</div>' +
        gen +
      '</div>' +
      '<div class="card" style="padding:20px;margin-top:16px">' +
        '<div class="card-head">' +
          '<h2>All machines (' + state.machines.length + ')</h2>' +
        '</div>' +
        '<div class="mlist">' + (rows || '<p class="blist-empty">No machines yet.</p>') + '</div>' +
      '</div>';
  }

  /* ---- analytics ---- */

  function lastDayKeys(n) {
    var keys = [];
    for (var i = n - 1; i >= 0; i--) keys.push(dayKey(Date.now() - i * 86400000));
    return keys;
  }

  function usageSum(keys) {
    var s = 0;
    keys.forEach(function (k) {
      var d = state.usage[k];
      if (!d) return;
      for (var h = 0; h < 24; h++) s += d[h] || 0;
    });
    return s;
  }

  function hourlyTotals() {
    var hours = new Array(24).fill(0);
    lastDayKeys(7).forEach(function (k) {
      var d = state.usage[k];
      if (!d) return;
      for (var h = 0; h < 24; h++) hours[h] += d[h] || 0;
    });
    return hours;
  }

  function usageChartSVG() {
    var hours = hourlyTotals();
    var max = Math.max(1, Math.max.apply(null, hours));
    var peak = hours.indexOf(Math.max.apply(null, hours));

    var W = 720, H = 270, padL = 40, padR = 10, padT = 16, padB = 30;
    var innerW = W - padL - padR;
    var innerH = H - padT - padB;
    var bw = innerW / 24;
    var barW = Math.max(6, bw - 7);

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Bar chart of washes by hour of day over the last 7 days">';

    var ticks = [0, Math.round(max / 2), max];
    ticks.forEach(function (v) {
      var y = padT + innerH - (v / max) * innerH;
      svg += '<line class="grid-line" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>';
      svg += '<text class="axis-label" x="' + (padL - 8) + '" y="' + (y + 4) + '" text-anchor="end">' + v + '</text>';
    });

    for (var h = 0; h < 24; h++) {
      var v = hours[h];
      var barH = (v / max) * innerH;
      var x = padL + h * bw + (bw - barW) / 2;
      var y = padT + innerH - barH;
      if (barH > 0) {
        svg += '<rect class="bar-rect' + (h === peak ? ' peak' : '') + '" x="' + x.toFixed(1) +
          '" y="' + y.toFixed(1) + '" width="' + barW + '" height="' + Math.max(2, barH).toFixed(1) +
          '" rx="3"><title>' + pad2(h) + ':00–' + pad2((h + 1) % 24) + ':00 · ' + v + ' washes</title></rect>';
      }
      if (h % 3 === 0) {
        svg += '<text class="axis-label" x="' + (x + barW / 2).toFixed(1) + '" y="' + (H - 8) +
          '" text-anchor="middle">' + pad2(h) + '</text>';
      }
    }
    svg += '</svg>';
    return { svg: svg, peak: peak, max: max, hours: hours };
  }

  function viewAnalytics() {
    var todayKey = dayKey(Date.now());
    var today = usageSum([todayKey]);
    var week = usageSum(lastDayKeys(7));
    var chart = usageChartSVG();
    var total = state.machines.length;
    var inUse = state.machines.filter(function (m) { return m.status !== 'free'; }).length;
    var peakLabel = pad2(chart.peak) + ':00–' + pad2((chart.peak + 1) % 24) + ':00';

    return '' +
      '<div class="page-head">' +
        '<div>' +
          '<h1>Usage analytics <span class="chip" style="vertical-align:middle;margin-left:6px">Admin</span></h1>' +
          '<p class="sub">Where the bottlenecks are — no extra machines needed to see them.</p>' +
        '</div>' +
      '</div>' +
      '<div class="stat-grid">' +
        '<div class="card stat">' +
          '<div class="stat-label">Washes completed today</div>' +
          '<div class="stat-value">' + today + '</div>' +
          '<div class="stat-hint">' + esc(todayKey) + '</div>' +
        '</div>' +
        '<div class="card stat">' +
          '<div class="stat-label">Washes completed this week</div>' +
          '<div class="stat-value">' + week + '</div>' +
          '<div class="stat-hint">Last 7 days</div>' +
        '</div>' +
        '<div class="card stat">' +
          '<div class="stat-label">Peak hour</div>' +
          '<div class="stat-value">' + peakLabel + '</div>' +
          '<div class="stat-hint">' + chart.hours[chart.peak] + ' washes · busiest window</div>' +
        '</div>' +
        '<div class="card stat">' +
          '<div class="stat-label">In use right now</div>' +
          '<div class="stat-value">' + inUse + ' / ' + total + '</div>' +
          '<div class="stat-hint">machines running or collecting</div>' +
        '</div>' +
      '</div>' +
      '<div class="card chart-card">' +
        '<div class="chart-head">' +
          '<h2>Usage by hour of day</h2>' +
          '<span class="muted">Total washes per hour · last 7 days</span>' +
        '</div>' +
        '<div class="chart">' + chart.svg + '</div>' +
        '<div class="chart-foot">' +
          '<span>Data is stored locally on this device (demo dataset).</span>' +
          '<button class="btn ghost" type="button" data-act="reset">Reset demo data</button>' +
        '</div>' +
      '</div>';
  }

  function view404() {
    return '' +
      '<div class="card notfound">' +
        '<h1>Page not found</h1>' +
        '<p class="muted">That link doesn’t point at a machine.</p>' +
        '<a class="btn primary" data-link href="/" style="text-decoration:none;display:inline-block">Back to machines</a>' +
      '</div>';
  }

  /* ---------------------------------------------------------- patching (live updates) */

  function patchMachineEl(m, el, now) {
    var badge = $('[data-r=badge]', el);
    if (badge) {
      badge.className = 'badge b-' + m.status;
      badge.textContent = statusLabel(m, now);
    }

    var sub = $('[data-r=sub]', el);
    if (sub) sub.innerHTML = subText(m, now);

    var chip = $('[data-r=booked]', el);
    if (chip) {
      var info = bookedChipText(m, now);
      if (info) {
        chip.hidden = false;
        chip.className = info.cls;
        chip.innerHTML = CAL_SVG + '<span>' + esc(info.text) + '</span>';
      } else {
        chip.hidden = true;
      }
    }

    var prog = $('[data-r=progress]', el);
    var bar = $('[data-r=bar]', el);
    if (prog) {
      var showBar = m.status !== 'free';
      prog.hidden = !showBar;
      if (bar && showBar) {
        bar.style.width = progressPct(m, now) + '%';
        bar.classList.toggle('is-complete', m.status === 'complete');
      }
    }

    var count = $('[data-r=count]', el);
    if (count) {
      count.className = 'countdown' +
        (m.status === 'free' ? ' is-free' : m.status === 'complete' ? ' is-complete' : '');
      if (m.status === 'free') count.textContent = 'Free';
      else if (m.status === 'busy') count.textContent = fmtMMSS(m.endsAt - now) + ' left';
      else count.textContent = 'Collect now · ' + fmtMMSS(m.graceEndsAt - now);
    }

    var started = $('[data-r=started]', el);
    if (started) {
      started.textContent = m.startedAt ? fmtClock(m.startedAt) : '—';
      var dur = $('[data-r=duration]', el);
      var by = $('[data-r=by]', el);
      var rowEnds = $('[data-r=rowEnds]', el);
      if (dur) dur.textContent = m.durationMin ? m.durationMin + ' min' : '—';
      if (by) by.textContent = m.startedBy || '—';
      if (rowEnds) {
        rowEnds.hidden = m.status === 'free';
        if (!rowEnds.hidden) {
          var endsLabel = $('[data-r=endsLabel]', el);
          var ends = $('[data-r=ends]', el);
          if (m.status === 'busy') {
            if (endsLabel) endsLabel.textContent = 'Ends';
            if (ends) ends.textContent = fmtClock(m.endsAt);
          } else {
            if (endsLabel) endsLabel.textContent = 'Auto-free';
            if (ends) ends.textContent = fmtClock(m.graceEndsAt);
          }
        }
      }
    }

    // action buttons
    var idx = queueIndex(m);
    var held = !!pendingBooking(m) && m.status === 'free';
    var startBtn = $('[data-act=start]', el);
    var notifyBtn = $('[data-act=notify]', el);
    var leaveBtn = $('[data-act=leave]', el);
    if (startBtn) {
      startBtn.hidden = m.status !== 'free';
      startBtn.disabled = held;
      startBtn.title = held ? 'A reservation is pending on this machine — confirm or wait for it to release.' : '';
    }
    if (notifyBtn) {
      notifyBtn.hidden = !(m.status === 'busy' && idx < 0);
      notifyBtn.textContent = 'Notify me when free';
      notifyBtn.disabled = false;
    }
    if (leaveBtn) leaveBtn.hidden = idx < 0;
    if (notifyBtn && idx >= 0) {
      notifyBtn.hidden = false;
      notifyBtn.textContent = 'In line — #' + (idx + 1);
      notifyBtn.disabled = true;
    }

    var qline = $('[data-r=queue]', el);
    if (qline) {
      var txt = queueLineText(m);
      qline.hidden = !txt;
      qline.innerHTML = txt;
    }

    var qbox = $('[data-r=queueBox]', el);
    if (qbox) {
      qbox.hidden = m.queue.length === 0;
      var list = $('[data-r=queueList]', el);
      if (list && m.queue.length) {
        list.innerHTML = m.queue.map(function (q, i) {
          var you = q.deviceId === DEVICE;
          return '<li class="' + (you ? 'you' : '') + '">' +
            '<span class="pos">#' + (i + 1) + '</span>' +
            '<span>' + (you ? 'You' : esc(q.name || 'Anonymous')) + '</span>' +
            '</li>';
        }).join('');
      }
    }
  }

  function applyFilter() {
    var grid = $('#grid');
    if (!grid) return;
    var f = !!state.prefs.filterFree;
    var anyVisible = false;
    $$('.machine', grid).forEach(function (el) {
      var m = getMachine(parseInt(el.dataset.id, 10));
      if (!m) return;
      var show = !f || m.status === 'free';
      el.hidden = !show;
      if (show) anyVisible = true;
    });
    var empty = $('#emptyState');
    if (empty) empty.hidden = anyVisible;
  }

  function updatePromptCountdown(now) {
    if (!currentPrompt) return;
    var el = $('#promptCount');
    if (!el || !currentPrompt.deadline) return;
    el.textContent = fmtMMSS(currentPrompt.deadline - now);
  }

  function patchAll() {
    var now = Date.now();
    var route = parseRoute();
    if (route.name === 'home') {
      $$('#grid .machine').forEach(function (el) {
        var m = getMachine(parseInt(el.dataset.id, 10));
        if (m) patchMachineEl(m, el, now);
      });
      applyFilter();
    } else if (route.name === 'machine') {
      var m = getMachine(route.id);
      var el = $('.machine-view');
      if (m && el) patchMachineEl(m, el, now);
    }
    updateBanner(now);
    updatePromptCountdown(now);
  }

  /* ---------------------------------------------------------- reminder banner */

  var bannerDismissed = {}; // machineId -> graceEndsAt dismissed for

  function updateBanner(now) {
    var el = $('#banner');
    var text = $('#bannerText');
    if (!el || !text) return;
    var mine = null;
    state.machines.forEach(function (m) {
      if (m.mine && m.status === 'complete') mine = m;
    });
    if (mine && bannerDismissed[mine.id] !== mine.graceEndsAt) {
      text.textContent = 'Please collect your laundry from ' + mLabel(mine) +
        ' — auto-free in ' + fmtMMSS(mine.graceEndsAt - now);
      if (el.hidden) el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  /* ---------------------------------------------------------- render */

  function updateNav(route) {
    var active = (route.name === 'home' || route.name === 'machine') ? '/'
      : route.name === 'setup' ? '/setup'
      : route.name === 'analytics' ? '/analytics' : '';
    $$('[data-nav]').forEach(function (a) {
      var on = a.dataset.nav === active;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function render() {
    var route = parseRoute();
    updateNav(route);

    var main = $('#main');
    if (!main) return;

    if (route.name === 'home') main.innerHTML = viewHome();
    else if (route.name === 'machine') main.innerHTML = viewMachine(route.id);
    else if (route.name === 'setup') main.innerHTML = viewSetup();
    else if (route.name === 'analytics') main.innerHTML = viewAnalytics();
    else main.innerHTML = view404();

    document.title = route.name === 'machine' ? mLabel(getMachine(route.id) || { id: route.id }) + ' · LaundryLink'
      : route.name === 'setup' ? 'Machine setup · LaundryLink'
      : route.name === 'analytics' ? 'Analytics · LaundryLink'
      : route.name === '404' ? 'Not found · LaundryLink'
      : 'LaundryLink';

    patchAll();
    mountQRs();
  }

  /* ---------------------------------------------------------- OTP reserve & start */

  var otpSession = null;      // { machineId, code, attempts, locked, bookingId }
  var currentPrompt = null;   // { bookingId, deadline }
  var promptDismissed = {};   // bookingId -> true (don't auto-reopen)

  function genOtp() {
    var n;
    try {
      var buf = new Uint16Array(1);
      window.crypto.getRandomValues(buf);
      n = buf[0] % 10000;
    } catch (e) {
      n = Math.floor(Math.random() * 10000);
    }
    var s = String(n);
    while (s.length < 4) s = '0' + s;
    return s;
  }

  function durationOptions(selected) {
    return DURATIONS.map(function (d) {
      return '<option value="' + d.v + '"' + (d.v === selected ? ' selected' : '') + '>' + d.label + '</option>';
    }).join('');
  }

  function otpDisplayHTML(code) {
    return code.split('').map(function (ch) {
      return '<span class="otp-cell">' + ch + '</span>';
    }).join('');
  }

  function otpInputsHTML() {
    var cells = '';
    for (var i = 0; i < 4; i++) {
      cells += '<input class="otp-box" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="4" aria-label="OTP digit ' + (i + 1) + '">';
    }
    return cells;
  }

  function openReserveModal(id, opts) {
    opts = opts || {};
    var m = getMachine(id);
    if (!m) return;
    if (m.status !== 'free') {
      toastHost(mLabel(m) + ' isn’t free right now.');
      return;
    }
    if (pendingBooking(m) && !opts.bookingId) {
      toastHost('A reservation is pending on ' + mLabel(m) + ' — confirm or wait for it to release.');
      return;
    }
    ensureAudio();
    requestNotifyPermission();

    otpSession = {
      machineId: m.id,
      code: genOtp(),
      attempts: 0,
      locked: false,
      bookingId: opts.bookingId || null
    };

    var dur = opts.durationMin || DEFAULT_DURATION;
    var root = $('#modalRoot');
    root.innerHTML = '' +
      '<div class="overlay">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">' +
          '<h2 id="modalTitle">Reserve &amp; Start — ' + esc(mLabel(m)) + '</h2>' +
          '<div class="field">' +
            '<label for="durSel">Cycle duration</label>' +
            '<select id="durSel">' + durationOptions(dur) + '</select>' +
          '</div>' +
          '<div class="field">' +
            '<label for="nameInp">Your name / room <span class="opt">(optional)</span></label>' +
            '<input id="nameInp" type="text" maxlength="48" placeholder="e.g. Amit, Room 212" value="' +
              esc(state.prefs.userName || '') + '">' +
          '</div>' +
          '<div class="section-label">Step 2 · Confirm at the machine</div>' +
          '<div class="otp-display" id="otpDisplay" aria-label="Your one-time code">' + otpDisplayHTML(otpSession.code) + '</div>' +
          '<p class="otp-hint">Enter this code at the machine to confirm and start your wash</p>' +
          '<div class="otp-inputs" id="otpInputs">' + otpInputsHTML() + '</div>' +
          '<p class="otp-err" id="otpErr" role="alert"></p>' +
          '<div class="modal-actions">' +
            '<button class="btn ghost" type="button" data-act="close-modal">Cancel</button>' +
            '<button class="btn primary" type="button" data-act="confirm-otp" id="otpConfirm">Confirm &amp; Start</button>' +
            '<button class="btn primary" type="button" data-act="regen-otp" id="otpRegen" hidden>Generate new code</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    setTimeout(function () {
      var first = $('#otpInputs .otp-box');
      if (first) { try { first.focus(); } catch (e) {} }
    }, 40);
  }

  function readOtpInputs() {
    return $$('#otpInputs .otp-box').map(function (b) { return b.value.replace(/\D/g, ''); }).join('');
  }

  function clearOtpInputs() {
    $$('#otpInputs .otp-box').forEach(function (b) { b.value = ''; b.classList.remove('shake'); });
  }

  function setOtpError(msg, shake) {
    var err = $('#otpErr');
    if (err) err.textContent = msg || '';
    if (shake) {
      $$('#otpInputs .otp-box').forEach(function (b) {
        b.classList.remove('shake');
        void b.offsetWidth; // restart animation
        b.classList.add('shake');
      });
    }
  }

  function lockOtp(reason) {
    if (!otpSession) return;
    otpSession.locked = true;
    $$('#otpInputs .otp-box').forEach(function (b) { b.disabled = true; });
    var confirm = $('#otpConfirm');
    var regen = $('#otpRegen');
    if (confirm) confirm.hidden = true;
    if (regen) regen.hidden = false;
    setOtpError(reason, true);
  }

  function verifyOtp() {
    if (!otpSession || otpSession.locked) return;
    var digits = readOtpInputs();
    if (digits.length < 4) return;

    if (digits === otpSession.code) {
      // Correct — the wash actually starts now.
      var m = getMachine(otpSession.machineId);
      var durSel = $('#durSel');
      var nameInp = $('#nameInp');
      var dur = parseInt(durSel ? durSel.value : DEFAULT_DURATION, 10);
      if (DURATIONS.map(function (d) { return d.v; }).indexOf(dur) < 0) dur = DEFAULT_DURATION;
      var name = nameInp ? nameInp.value : '';
      var bookingId = otpSession.bookingId;
      otpSession = null;
      closeModal();
      startWash(m ? m.id : null, dur, name, bookingId);
      return;
    }

    otpSession.attempts += 1;
    if (otpSession.attempts >= OTP_ATTEMPT_LIMIT) {
      clearOtpInputs();
      lockOtp('That code didn’t match twice. Generate a new code and try again.');
      return;
    }
    clearOtpInputs();
    setOtpError('Incorrect code — attempt ' + otpSession.attempts + ' of ' + OTP_ATTEMPT_LIMIT + '. Try again.', true);
    var first = $('#otpInputs .otp-box');
    if (first) { try { first.focus(); } catch (e) {} }
  }

  function regenOtp() {
    if (!otpSession) return;
    otpSession.code = genOtp();
    otpSession.attempts = 0;
    otpSession.locked = false;
    var disp = $('#otpDisplay');
    if (disp) {
      disp.innerHTML = otpDisplayHTML(otpSession.code);
      $$('.otp-cell', disp).forEach(function (c) {
        c.classList.add('fresh');
        setTimeout(function () { c.classList.remove('fresh'); }, 350);
      });
    }
    $$('#otpInputs .otp-box').forEach(function (b) { b.disabled = false; b.value = ''; });
    var confirm = $('#otpConfirm');
    var regen = $('#otpRegen');
    if (confirm) confirm.hidden = false;
    if (regen) regen.hidden = true;
    setOtpError('');
    var first = $('#otpInputs .otp-box');
    if (first) { try { first.focus(); } catch (e) {} }
  }

  /* ---------------------------------------------------------- booking modals */

  function roundToFiveMin(ts) {
    var d = new Date(ts);
    d.setSeconds(0, 0);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5);
    return d;
  }

  function defaultBookingTime(now) {
    var t = roundToFiveMin(now + 30 * 60000);
    return pad2(t.getHours()) + ':' + pad2(t.getMinutes());
  }

  function bookingRangeText() {
    var timeEl = $('#bookTime');
    var durEl = $('#bookDur');
    if (!timeEl || !durEl) return '';
    var parts = (timeEl.value || '').split(':');
    var hh = parseInt(parts[0], 10), mm = parseInt(parts[1], 10);
    if (isNaN(hh) || isNaN(mm)) return '';
    var start = new Date();
    start.setHours(hh, mm, 0, 0);
    var dur = parseInt(durEl.value, 10) || 30;
    return fmtClock(start.getTime()) + ' – ' + fmtClock(start.getTime() + dur * 60000);
  }

  function updateBookingSummary() {
    var sum = $('#bookSum');
    if (sum) sum.textContent = bookingRangeText() || '—';
  }

  function openBookingModal(id) {
    var m = getMachine(id);
    if (!m) return;
    ensureAudio();
    var root = $('#modalRoot');
    root.innerHTML = '' +
      '<div class="overlay">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="bookTitle">' +
          '<h2 id="bookTitle">Book a slot — ' + esc(mLabel(m)) + '</h2>' +
          '<div class="two-col">' +
            '<div class="field">' +
              '<label for="bookTime">Start time (today)</label>' +
              '<input id="bookTime" type="time" step="300" value="' + defaultBookingTime(Date.now()) + '">' +
            '</div>' +
            '<div class="field">' +
              '<label for="bookDur">Duration</label>' +
              '<select id="bookDur">' + durationOptions(DEFAULT_DURATION) + '</select>' +
            '</div>' +
          '</div>' +
          '<div class="book-sum" id="bookSum">' + esc(bookingRangeText()) + '</div>' +
          '<p class="hint">When the slot starts we’ll ask you to confirm within 10 minutes. Unconfirmed slots are released automatically.</p>' +
          '<p class="err" id="bookErr" role="alert"></p>' +
          '<div class="modal-actions">' +
            '<button class="btn ghost" type="button" data-act="close-modal">Cancel</button>' +
            '<button class="btn primary" type="button" data-act="confirm-booking" data-id="' + m.id + '">Book slot</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    updateBookingSummary();
    setTimeout(function () {
      var t = $('#bookTime');
      if (t) { try { t.focus(); } catch (e) {} }
    }, 40);
  }

  function createBooking(id) {
    var m = getMachine(id);
    if (!m) return;
    var err = $('#bookErr');
    function fail(msg) { if (err) err.textContent = msg; }

    var timeEl = $('#bookTime');
    var durEl = $('#bookDur');
    if (!timeEl || !durEl) return;
    var parts = (timeEl.value || '').split(':');
    var hh = parseInt(parts[0], 10), mm = parseInt(parts[1], 10);
    if (isNaN(hh) || isNaN(mm) || !timeEl.value) return fail('Pick a start time for your slot.');

    var now = Date.now();
    var start = new Date(now);
    start.setHours(hh, mm, 0, 0);
    var startAt = start.getTime();
    var dur = parseInt(durEl.value, 10);
    if (DURATIONS.map(function (d) { return d.v; }).indexOf(dur) < 0) dur = DEFAULT_DURATION;
    var endAt = startAt + dur * 60000;

    if (startAt < now + 60000) return fail('Choose a start time at least a minute in the future.');
    if (endAt > startAt && new Date(endAt).getHours() < new Date(startAt).getHours()) {
      return fail('The slot must end before midnight.');
    }
    if (m.status === 'busy' && m.endsAt && startAt < m.endsAt) {
      return fail('Machine is busy until ' + fmtClock(m.endsAt) + ' — pick a later time.');
    }
    var clash = activeBookings(m).some(function (b) {
      return startAt < b.endAt && endAt > b.startAt;
    });
    if (clash) return fail('That slot overlaps another booking on this machine.');

    m.bookings.push({
      id: newBookingId(),
      machineId: m.id,
      startAt: startAt,
      endAt: endAt,
      durationMin: dur,
      deviceId: DEVICE,
      name: (state.prefs.userName || '').trim() || 'You',
      status: 'upcoming',
      createdAt: now
    });
    save();
    closeModal();
    render();
    toastHost('Booked ' + mLabel(m) + ' for ' + fmtClock(startAt) + ' – ' + fmtClock(endAt) + '.');
  }

  function openBookingPrompt(b) {
    var m = getMachine(b.machineId);
    if (!m || b.status !== 'pending') return;
    ensureAudio();
    requestNotifyPermission();
    promptDismissed[b.id] = false;
    currentPrompt = { bookingId: b.id, deadline: b.deadline };

    var root = $('#modalRoot');
    root.innerHTML = '' +
      '<div class="overlay">' +
        '<div class="modal" id="promptModal" role="dialog" aria-modal="true" aria-labelledby="promptTitle">' +
          '<h2 id="promptTitle" style="text-align:center">Are you going to use ' + esc(mLabel(m)) + ' now?</h2>' +
          '<p class="prompt-lead">Confirm within 10 minutes or your slot will be released.</p>' +
          '<div class="prompt-count" id="promptCount">' + fmtMMSS(b.deadline - Date.now()) + '</div>' +
          '<p class="prompt-deadline">Slot: ' + esc(fmtRange(b)) + ' · ' + b.durationMin + ' min</p>' +
          '<div class="modal-actions" style="justify-content:center">' +
            '<button class="btn ghost" type="button" data-act="cancel-booking" data-b="' + b.id + '">Cancel slot</button>' +
            '<button class="btn primary" type="button" data-act="arrive-yes" data-b="' + b.id + '">Yes, I’m here</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Sound + system notification (the visible popup is the toast replacement).
    beep('turn');
    try {
      if (typeof window.Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(mLabel(m) + ' — your slot starts now',
          { body: 'Confirm within 10 minutes or your slot will be released.', tag: 'book-' + b.id });
      }
    } catch (e) {}
    setTimeout(function () {
      var btn = $('#promptModal [data-act=arrive-yes]');
      if (btn) { try { btn.focus(); } catch (e) {} }
    }, 40);
  }

  function arriveYes(bid) {
    var m = null, b = null;
    state.machines.forEach(function (mm) {
      var found = findBooking(mm, bid);
      if (found) { m = mm; b = found; }
    });
    if (!m || !b || b.status !== 'pending') { closeModal(); return; }

    b.status = 'confirmed';
    b.confirmedAt = Date.now();
    save();
    currentPrompt = null;   // clear BEFORE replacing modal so it isn't marked dismissed
    if (m.status === 'free' && !pendingBooking(m)) {
      openReserveModal(m.id, { bookingId: b.id, durationMin: b.durationMin });
      render();
    } else {
      closeModal();
      render();
      toastHost('You’re confirmed for ' + fmtRange(b) + ' — start via OTP once the machine is free.');
    }
  }

  function cancelBookingAct(bid) {
    var m = null, b = null;
    state.machines.forEach(function (mm) {
      var found = findBooking(mm, bid);
      if (found) { m = mm; b = found; }
    });
    if (!m || !b) return;
    if (b.status === 'upcoming' || b.status === 'pending') {
      b.status = 'cancelled';
      save();
      toastHost('Booking cancelled — ' + fmtRange(b) + ' released.');
    } else if (b.status === 'confirmed') {
      b.status = 'cancelled';
      save();
      toastHost('Booking cancelled.');
    }
    if (currentPrompt && currentPrompt.bookingId === bid) currentPrompt = null;
    closeModal();
    render();
  }

  function bookingArrive(bid) {
    var m = null, b = null;
    state.machines.forEach(function (mm) {
      var found = findBooking(mm, bid);
      if (found) { m = mm; b = found; }
    });
    if (!m || !b) return;
    if (b.status === 'pending') {
      openBookingPrompt(b); // manual re-open after a dismissal
    } else if (b.status === 'confirmed') {
      if (m.status === 'free' && !pendingBooking(m)) {
        openReserveModal(m.id, { bookingId: b.id, durationMin: b.durationMin });
      } else {
        toastHost(mLabel(m) + ' isn’t free right now — try again in a moment.');
      }
    }
  }

  /* ---------------------------------------------------------- machine actions */

  function closeModal() {
    var root = $('#modalRoot');
    if (root) root.innerHTML = '';
    otpSession = null;
    if (currentPrompt) {
      promptDismissed[currentPrompt.bookingId] = true; // user closed it manually
      currentPrompt = null;
    }
  }

  function startWash(id, durMin, name, bookingId) {
    var m = getMachine(id);
    if (!m) return;
    if (m.status !== 'free') {
      closeModal();
      toastHost('Too late — ' + mLabel(m) + ' was just taken.');
      render();
      return;
    }
    var now = Date.now();
    m.status = 'busy';
    m.startedAt = now;
    m.durationMin = durMin;
    m.endsAt = now + durMin * 60000;
    m.graceEndsAt = null;
    m.mine = true;
    var label = (name || '').trim();
    m.startedBy = label || 'You';
    if (label) state.prefs.userName = label;

    // Consume the confirmed booking this start belongs to (if any).
    var consumed = null;
    if (bookingId) {
      var b = findBooking(m, bookingId);
      if (b) { b.status = 'consumed'; consumed = b; }
    }
    if (!consumed) {
      m.bookings.forEach(function (b) {
        if (b.status === 'confirmed' && b.deviceId === DEVICE) {
          b.status = 'consumed';
          consumed = b;
        }
      });
    }

    m.queue = m.queue.filter(function (q) { return q.deviceId !== DEVICE; });

    save();
    closeModal();
    ensureAudio();
    requestNotifyPermission();
    render();
    toastHost(mLabel(m) + ' started — ' + durMin + ' min cycle. We’ll alert you when it’s done.');
  }

  function joinQueue(id) {
    var m = getMachine(id);
    if (!m) return;
    if (m.status !== 'busy') {
      toastHost(mLabel(m) + ' is free — reserve a wash instead.');
      render();
      return;
    }
    if (queueIndex(m) >= 0) return;
    m.queue.push({
      deviceId: DEVICE,
      name: (state.prefs.userName || '').trim() || 'You',
      at: Date.now()
    });
    save();
    ensureAudio();
    requestNotifyPermission();
    render();
    toastHost('You’re #' + m.queue.length + ' in line for ' + mLabel(m) + '.');
  }

  function leaveQueue(id) {
    var m = getMachine(id);
    if (!m) return;
    m.queue = m.queue.filter(function (q) { return q.deviceId !== DEVICE; });
    save();
    render();
    toastHost('You left the queue for ' + mLabel(m) + '.');
  }

  /* ---- setup actions ---- */

  function resolveMachineName(raw, id) {
    var s = (raw || '').trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return 'Machine ' + s;
    return s;
  }

  function setupGenerate() {
    var input = $('#setupName');
    if (!input) return;
    var id = nextMachineId();
    var m = makeMachine(id);
    m.sensor = false;
    m.name = resolveMachineName(input.value, id);
    state.machines.push(m);
    save();
    lastGeneratedId = id;
    render();
    toastHost((mLabel(m)) + ' added — QR code ready below.');
    setTimeout(function () {
      var panel = $('#genPanel');
      if (panel && typeof panel.scrollIntoView === 'function') {
        try { panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
      }
      var again = $('#setupName');
      if (again) { again.value = ''; try { again.focus(); } catch (e) {} }
    }, 60);
  }

  function setupDelete(id) {
    var m = getMachine(id);
    if (!m) return;
    var ok = window.confirm('Delete ' + mLabel(m) + '? Its QR code will stop working.');
    if (!ok) return;
    state.machines = state.machines.filter(function (x) { return x.id !== id; });
    if (lastGeneratedId === id) lastGeneratedId = null;
    save();
    render();
    toastHost(mLabel(m) + ' deleted.');
  }

  /* ---------------------------------------------------------- transitions */

  function recordCompletion(m, now) {
    var key = dayKey(now);
    var h = new Date(now).getHours();
    if (!state.usage[key]) state.usage[key] = {};
    state.usage[key][h] = (state.usage[key][h] || 0) + 1;
  }

  function processTransitions(now) {
    var changed = false;
    var alerts = [];

    state.machines.forEach(function (m) {
      if (m.status === 'busy' && m.endsAt && now >= m.endsAt) {
        m.status = 'complete';
        m.graceEndsAt = now + GRACE_MS;
        recordCompletion(m, now);
        if (m.mine) {
          alerts.push({
            title: mLabel(m) + ' is done!',
            body: 'Cycle complete — collect your laundry now.',
            tag: 'cycle-' + m.id,
            soundKind: 'done'
          });
        }
        changed = true;
      } else if (m.status === 'complete' && m.graceEndsAt && now >= m.graceEndsAt) {
        var head = m.queue.length ? m.queue[0] : null;
        var headIsMine = head && head.deviceId === DEVICE;

        m.status = 'free';
        m.startedAt = null;
        m.endsAt = null;
        m.durationMin = null;
        m.graceEndsAt = null;
        m.startedBy = null;
        m.mine = false;

        if (head) {
          alerts.push({
            title: mLabel(m) + ' is free',
            body: headIsMine ? 'It’s your turn — start your wash now.'
              : (head.name || 'The next student') + ' was notified first.',
            tag: 'queue-' + m.id,
            soundKind: 'turn',
            quiet: !headIsMine
          });
        }
        changed = true;
      }
    });

    if (changed) {
      alerts.forEach(alertUser);
    }
    return changed;
  }

  function processBookings(now) {
    var changed = false;
    var alerts = [];
    var openPromptFor = null;

    state.machines.forEach(function (m) {
      m.bookings.forEach(function (b) {
        // Slot start time reached → hold the slot, ask for confirmation.
        if (b.status === 'upcoming' && now >= b.startAt) {
          b.status = 'pending';
          b.deadline = b.startAt + GRACE_MS;
          changed = true;
        }
        // No-show protection window elapsed → release the slot.
        if (b.status === 'pending' && now >= b.deadline) {
          b.status = 'noshow';
          changed = true;
          if (b.deviceId === DEVICE) {
            alerts.push({
              title: 'Booking expired',
              body: 'Your slot on ' + mLabel(m) + ' was released.',
              tag: 'noshow-' + b.id,
              soundKind: 'turn'
            });
          }
          var head = m.queue.length ? m.queue[0] : null;
          if (head) {
            var headIsMine = head.deviceId === DEVICE;
            alerts.push({
              title: mLabel(m) + ' is available',
              body: headIsMine ? 'You’re next in line — grab it now.'
                : (head.name || 'The next student') + ' was notified first.',
              tag: 'queue-' + m.id,
              soundKind: 'turn',
              quiet: !headIsMine
            });
          }
        }
        // Auto-open the confirmation popup for this device's pending slots.
        if (b.status === 'pending' && b.deviceId === DEVICE &&
            !promptDismissed[b.id] && !currentPrompt && !openPromptFor) {
          if (!$('#modalRoot .modal')) openPromptFor = b;
        }
      });
    });

    if (changed) {
      alerts.forEach(alertUser);
    }
    return { changed: changed, prompt: openPromptFor };
  }

  function tick() {
    var now = Date.now();
    var a = processTransitions(now);
    var b = processBookings(now);
    if (a || b.changed) {
      save();
      render();
    } else {
      patchAll();
    }
    if (b.prompt) openBookingPrompt(b.prompt);
  }

  /* ---------------------------------------------------------- events */

  function onClick(e) {
    var t = e.target;

    if (t && t.classList && t.classList.contains('overlay')) {
      closeModal();
      return;
    }

    var link = t && t.closest ? t.closest('a[data-link]') : null;
    if (link) {
      e.preventDefault();
      navigate(link.getAttribute('href'));
      return;
    }

    var actEl = t && t.closest ? t.closest('[data-act]') : null;
    if (!actEl) return;
    var act = actEl.dataset.act;

    if (act === 'start') {
      var root = actEl.closest('[data-id]');
      if (root) openReserveModal(parseInt(root.dataset.id, 10));
    } else if (act === 'notify') {
      var r2 = actEl.closest('[data-id]');
      if (r2) joinQueue(parseInt(r2.dataset.id, 10));
    } else if (act === 'leave') {
      var r3 = actEl.closest('[data-id]');
      if (r3) leaveQueue(parseInt(r3.dataset.id, 10));
    } else if (act === 'close-modal') {
      closeModal();
    } else if (act === 'confirm-otp') {
      verifyOtp();
    } else if (act === 'regen-otp') {
      regenOtp();
    } else if (act === 'open-booking') {
      var r4 = actEl.closest('[data-id]');
      if (r4) openBookingModal(parseInt(r4.dataset.id, 10));
    } else if (act === 'confirm-booking') {
      createBooking(parseInt(actEl.dataset.id, 10));
    } else if (act === 'arrive-yes') {
      arriveYes(actEl.dataset.b);
    } else if (act === 'cancel-booking') {
      cancelBookingAct(actEl.dataset.b);
    } else if (act === 'booking-arrive') {
      bookingArrive(actEl.dataset.b);
    } else if (act === 'booking-cancel') {
      cancelBookingAct(actEl.dataset.b);
    } else if (act === 'generate-qr') {
      setupGenerate();
    } else if (act === 'download-qr') {
      downloadQR(parseInt(actEl.dataset.id, 10));
    } else if (act === 'delete-machine') {
      setupDelete(parseInt(actEl.dataset.id, 10));
    } else if (act === 'print') {
      try { window.print(); } catch (err) {}
    } else if (act === 'reset') {
      if (window.confirm('Reset LaundryLink demo data (machines, queues, bookings and analytics)?')) {
        store.del(STATE_KEY);
        location.reload();
      }
    }
  }

  function onChange(e) {
    if (e.target && e.target.id === 'filterFree') {
      state.prefs.filterFree = !!e.target.checked;
      save();
      applyFilter();
    }
    if (e.target && (e.target.id === 'bookTime' || e.target.id === 'bookDur')) {
      updateBookingSummary();
    }
  }

  function onInput(e) {
    var box = e.target;
    if (!box.classList || !box.classList.contains('otp-box')) return;
    var boxes = $$('#otpInputs .otp-box');
    var idx = boxes.indexOf(box);
    if (idx < 0) return;

    var digits = box.value.replace(/\D/g, '');
    if (digits.length > 1) {
      // Pasted / multi-char input — distribute across the boxes.
      for (var i = 0; i < 4; i++) {
        if (boxes[i]) boxes[i].value = digits[i] || '';
      }
      var lastFilled = Math.min(digits.length, 4) - 1;
      if (boxes[lastFilled] && digits.length >= 4) { try { boxes[3].focus(); } catch (err) {} }
    } else {
      box.value = digits.slice(0, 1);
      if (box.value && boxes[idx + 1]) {
        try { boxes[idx + 1].focus(); } catch (err) {}
      }
    }
    if (readOtpInputs().length === 4) {
      setTimeout(verifyOtp, 0);
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && $('#modalRoot') && $('#modalRoot').firstChild) {
      closeModal();
      return;
    }
    // OTP boxes: backspace on an empty box steps back.
    if (e.key === 'Backspace' && e.target && e.target.classList && e.target.classList.contains('otp-box')) {
      if (!e.target.value) {
        var boxes = $$('#otpInputs .otp-box');
        var idx = boxes.indexOf(e.target);
        if (idx > 0) {
          boxes[idx - 1].value = '';
          try { boxes[idx - 1].focus(); } catch (err) {}
        }
      }
    }
  }

  function onBell() {
    ensureAudio();
    var p = notifyPermission();
    if (p === 'granted') {
      toastHost('Notifications are on — you’ll be alerted when your cycle finishes.');
    } else if (p === 'denied') {
      toastHost('Notifications are blocked in your browser. In-app alerts and sounds still work.');
    } else if (p === 'default') {
      requestNotifyPermission();
      toastHost('Enable notifications so we can alert you the moment your wash is done.');
    } else {
      toastHost('System notifications aren’t available here — in-app alerts still work.');
    }
  }

  /* ---------------------------------------------------------- init */

  function init() {
    setTheme(currentTheme(), false);

    // Legacy /qr links (from old printed labels) now land on Machine Setup.
    if (!useHash && /^\/qr\/?$/.test(location.pathname || '')) {
      try { history.replaceState({}, '', '/setup'); } catch (e) { useHash = true; location.hash = '#/setup'; }
    }

    $('#themeBtn') && $('#themeBtn').addEventListener('click', toggleTheme);
    $('#bellBtn') && $('#bellBtn').addEventListener('click', onBell);

    var dismiss = $('#bannerDismiss');
    if (dismiss) {
      dismiss.addEventListener('click', function () {
        state.machines.forEach(function (m) {
          if (m.mine && m.status === 'complete') bannerDismissed[m.id] = m.graceEndsAt;
        });
        updateBanner(Date.now());
      });
    }

    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('click', function once() {
      ensureAudio();
      document.removeEventListener('click', once);
    });

    window.addEventListener('popstate', function () { render(); });
    window.addEventListener('hashchange', function () { render(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    window.addEventListener('focus', tick);

    render();
    updateBell();

    setInterval(tick, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
