/* WeLitNexus portal — single-page app. Role-aware views, no build step. */
(function () {
  'use strict';

  let ME = null;
  let clockTimer = null;
  let dashTimers = [];          // ticking + polling intervals for the admin dashboard
  let DASH_LIVE = null;         // snapshot used to advance the live worked timers

  // ---------- tiny helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isAdmin = () => ME && ME.role === 'ADMIN';
  const fmtMins = (m) => `${Math.floor(m / 60)}h ${m % 60}m`;
  // Friendly date: '2026-06-22' -> '22 Jun 2026'. Passes through anything else.
  const fmtDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? new Date(s + 'T00:00').toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : (s || '—'));
  const todayISO = () => new Date().toLocaleDateString('en-CA'); // yyyy-mm-dd local
  const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1).toLowerCase();
  const badge = (v) => `<span class="badge b-${String(v).toLowerCase()}">${esc(cap(String(v).replace('_', ' ')))}</span>`;
  const initials = (n) => String(n).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  function toast(msg, isErr) {
    const t = $('#toast');
    // Errors interrupt (assertive); successes wait politely. Screen readers
    // announce the toast via aria-live on the element.
    t.setAttribute('aria-live', isErr ? 'assertive' : 'polite');
    t.setAttribute('role', isErr ? 'alert' : 'status');
    t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
    setTimeout(() => { t.className = 'toast'; }, 2600);
  }
  let lastFocusBeforeModal = null;
  function modal(html) {
    const m = $('#modal');
    m.innerHTML = html;
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    // Label the dialog by its first heading for screen readers.
    const h = m.querySelector('h3, h2');
    if (h) { if (!h.id) h.id = 'modalTitle'; m.setAttribute('aria-labelledby', h.id); }
    else m.removeAttribute('aria-labelledby');
    // Associate each field's <label> with its control so it's announced.
    m.querySelectorAll('.field').forEach((f, i) => {
      const label = f.querySelector('label');
      const ctrl = f.querySelector('input, select, textarea');
      if (label && ctrl) { if (!ctrl.id) ctrl.id = `modalField${i}`; label.setAttribute('for', ctrl.id); }
    });
    lastFocusBeforeModal = document.activeElement;
    $('#modalBg').classList.add('show');
    // Move focus into the dialog (first field, else the dialog itself).
    const first = m.querySelector('input, select, textarea, button');
    (first || m).focus();
  }
  function closeModal() {
    $('#modalBg').classList.remove('show');
    // Return focus to whatever opened the modal.
    if (lastFocusBeforeModal && document.contains(lastFocusBeforeModal)) lastFocusBeforeModal.focus();
    lastFocusBeforeModal = null;
  }
  $('#modalBg').addEventListener('click', (e) => { if (e.target.id === 'modalBg') closeModal(); });
  // Escape closes the modal; Tab is trapped inside it while open.
  document.addEventListener('keydown', (e) => {
    if (!$('#modalBg').classList.contains('show')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key === 'Tab') {
      const f = [...$('#modal').querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((el) => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // ---------- Notifications (bell) ----------
  let notifTimer = null;
  // Relative "time ago" for notification timestamps.
  function fmtWhen(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
  }
  async function refreshNotifCount() {
    try {
      const { unread } = await api.get('/notifications/count');
      const b = $('#bellBadge');
      if (unread > 0) { b.hidden = false; b.textContent = unread > 99 ? '99+' : String(unread); }
      else { b.hidden = true; }
    } catch (_e) { /* offline / logged out — ignore */ }
  }
  function startNotifications() { refreshNotifCount(); clearInterval(notifTimer); notifTimer = setInterval(refreshNotifCount, 30000); }
  function stopNotifications() { clearInterval(notifTimer); }

  async function openNotifications() {
    let data;
    try { data = await api.get('/notifications'); } catch (e) { return toast(e.message, true); }
    const list = data.notifications;
    modal(`<h3>Notifications</h3>
      <div class="modal-actions" style="justify-content:space-between;margin-top:0;margin-bottom:12px;">
        <span style="color:var(--slate);font-size:.85rem;align-self:center;">${data.unread} unread</span>
        <button class="btn btn-ghost btn-sm" id="nMarkAll" ${data.unread ? '' : 'disabled'}>Mark all read</button>
      </div>
      <div class="notif-list">
        ${list.length ? list.map((n) => `<button class="notif ${n.read ? '' : 'unread'}" data-nid="${n.id}" data-link="${esc(n.link_view || '')}">
          <div class="nt">${esc(n.title)}</div>${n.body ? `<div class="nb">${esc(n.body)}</div>` : ''}
          <div class="nw">${fmtWhen(n.created_ts)}</div></button>`).join('')
        : `<div class="empty">No notifications yet.</div>`}
      </div>`);
    $('#nMarkAll')?.addEventListener('click', async () => {
      try { await api.post('/notifications/read-all'); refreshNotifCount(); closeModal(); } catch (e) { toast(e.message, true); }
    });
    $('#modal').querySelectorAll('.notif').forEach((b) => b.addEventListener('click', async () => {
      try { await api.post(`/notifications/${b.dataset.nid}/read`); } catch (_e) {}
      refreshNotifCount();
      const link = b.dataset.link;
      closeModal();
      if (link && VIEWS[link]) navigate(link);
    }));
  }
  $('#bellBtn').addEventListener('click', openNotifications);

  // ---------- auth bootstrap ----------
  async function boot() {
    try {
      const { user } = await api.get('/auth/me');
      ME = user; showApp();
    } catch (_e) {
      showLogin();
    }
  }

  function showLogin() {
    $('#loginWrap').style.display = 'grid';
    $('#app').classList.remove('show');
  }

  function showApp() {
    $('#loginWrap').style.display = 'none';
    $('#app').classList.add('show');
    document.body.classList.toggle('is-admin', isAdmin());
    $('#meName').textContent = ME.name;
    $('#meRole').textContent = `${ME.title || ME.role} · ${ME.department || '—'}`;
    startNotifications();
    navigate('dashboard');
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      const { user } = await api.post('/auth/login', { email: $('#email').value, password: $('#password').value });
      ME = user; showApp();
    } catch (err) { $('#loginErr').textContent = err.message; }
  });

  $('#logoutBtn').addEventListener('click', async () => {
    try { await api.post('/auth/logout'); } catch (_e) {}
    ME = null; clearInterval(clockTimer); dashTimers.forEach(clearInterval); dashTimers = []; stopNotifications(); showLogin();
  });

  $('#changePwBtn').addEventListener('click', openChangePassword);

  function openChangePassword() {
    modal(`<h3>Change your password</h3>
      <div class="form-row one"><div class="field"><label>Current password</label><input type="password" id="cpCur" autocomplete="current-password"></div></div>
      <div class="form-row one"><div class="field"><label>New password</label><input type="password" id="cpNew" autocomplete="new-password" placeholder="min 6 chars"></div></div>
      <div class="form-row one"><div class="field"><label>Confirm new password</label><input type="password" id="cpConf" autocomplete="new-password"></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">Update password</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const cur = $('#cpCur').value, next = $('#cpNew').value, conf = $('#cpConf').value;
      if (next.length < 6) return toast('New password must be at least 6 characters', true);
      if (next !== conf) return toast('New passwords do not match', true);
      try {
        await api.post('/auth/change-password', { current_password: cur, new_password: next });
        closeModal(); toast('Password updated ✓');
      } catch (e) { toast(e.message, true); }
    });
  }

  // ---------- navigation ----------
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (btn) navigate(btn.dataset.view);
  });

  function navigate(view) {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    clearInterval(clockTimer);
    dashTimers.forEach(clearInterval); dashTimers = []; DASH_LIVE = null;
    const r = VIEWS[view];
    if (r) r();
  }

  function setMain(title, sub, body) {
    $('#main').innerHTML = `<h1 class="page-title">${esc(title)}</h1><p class="page-sub">${esc(sub)}</p>${body}`;
  }

  // ====================================================================
  //  VIEWS
  // ====================================================================
  const VIEWS = {};

  // ---------- Dashboard ----------
  VIEWS.dashboard = async () => {
    setMain(`Hi ${ME.name.split(' ')[0]} 👋`, new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      `<div class="cards" id="dashCards"></div><div id="dashAdmin"></div>`);
    try {
      const [status, mine, tasks] = await Promise.all([
        api.get('/attendance/status'),
        api.get('/leaves/mine'),
        api.get('/tasks/mine'),
      ]);
      const pending = mine.leaves.filter((l) => l.status === 'PENDING').length;
      const openTasks = tasks.tasks.filter((t) => t.status !== 'DONE').length;
      $('#dashCards').innerHTML = `
        ${statCard('Today', `${badge(status.state)}`, 'value small')}
        ${statCard('Worked today', fmtMins(status.workedMinutes), 'value small')}
        ${statCard('Leave balance', `${mine.balance} days`, 'value small')}
        ${statCard('Open tasks', openTasks, 'value')}
        ${statCard('Pending leave requests', pending, 'value')}`;
    } catch (e) { toast(e.message, true); }

    if (isAdmin()) startLiveAttendance('dashAdmin', true);
  };

  // h m s from milliseconds, e.g. "2h 14m 06s".
  const fmtHMS = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  };

  // Advance each currently-in person's timer client-side between server refreshes.
  function tickDashTimers() {
    if (!DASH_LIVE) return;
    const elapsed = Date.now() - DASH_LIVE.receivedAt;
    DASH_LIVE.working.forEach((p) => {
      const el = document.querySelector(`[data-livetimer="${p.id}"]`);
      if (el) el.textContent = fmtHMS(p.workedMinutes * 60000 + elapsed);
    });
  }

  // Live team-attendance panel, reused by the Dashboard and the Clock page.
  // hostId: element to render into. withApprovals: also show pending leaves.
  async function renderLiveAttendance(hostId, withApprovals) {
    const host = $('#' + hostId); if (!host) return; // navigated away
    try {
      const reqs = [api.get('/attendance/today')];
      if (withApprovals) { reqs.push(api.get('/leaves/pending')); reqs.push(api.get('/punch-requests/pending')); }
      const [today, pend, punchPend] = await Promise.all(reqs);
      const working = today.people.filter((p) => p.state === 'IN');
      const onBreak = today.people.filter((p) => p.state === 'BREAK');
      const clockedOut = today.people.filter((p) => p.state === 'OUT');
      DASH_LIVE = { receivedAt: Date.now(), working }; // anchor for the live tick
      const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
      // Small phone/PC indicator next to a name, from their latest punch's device.
      const deviceTag = (d) => d === 'MOBILE' ? ' <span class="dev-tag" title="Clocked in from a phone">📱 Mobile</span>'
        : d === 'PC' ? ' <span class="dev-tag" title="Clocked in from a computer">💻 PC</span>' : '';
      host.innerHTML = `
        <div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start;margin-bottom:28px;">
          <div class="section" style="margin-bottom:0;">
            <h2>🟢 Currently in (${working.length})</h2>
            ${working.length ? `<table><thead><tr><th>Name</th><th>Dept</th><th>Worked (live)</th></tr></thead><tbody>
              ${working.map((p) => `<tr><td>${esc(p.name)}${deviceTag(p.device)}</td><td>${esc(p.department || '—')}</td><td><strong style="font-variant-numeric:tabular-nums;color:var(--teal-dark);" data-livetimer="${p.id}">${fmtHMS(p.workedMinutes * 60000)}</strong></td></tr>`).join('')}
            </tbody></table>` : `<div class="empty">No one is clocked in right now.</div>`}
          </div>
          <div class="section" style="margin-bottom:0;">
            <h2>☕ On break (${onBreak.length})</h2>
            ${onBreak.length ? `<table><thead><tr><th>Name</th><th>Dept</th><th>Worked</th></tr></thead><tbody>
              ${onBreak.map((p) => `<tr><td>${esc(p.name)}${deviceTag(p.device)}</td><td>${esc(p.department || '—')}</td><td>${fmtMins(p.workedMinutes)}</td></tr>`).join('')}
            </tbody></table>` : `<div class="empty">No one is on break.</div>`}
          </div>
        </div>
        <div class="section">
          <h2>✅ Clocked out today (${clockedOut.length})</h2>
          ${clockedOut.length ? `<table><thead><tr><th>Name</th><th>Dept</th><th>First in</th><th>Last out</th><th>Net worked</th><th>Break</th></tr></thead><tbody>
            ${clockedOut.map((p) => `<tr><td>${esc(p.name)}${deviceTag(p.device)}</td><td>${esc(p.department || '—')}</td>
              <td>${fmtTime(p.firstIn)}</td><td>${fmtTime(p.lastOut)}</td>
              <td><strong>${fmtMins(p.workedMinutes)}</strong></td><td>${fmtMins(p.breakMinutes)}</td></tr>`).join('')}
          </tbody></table>` : `<div class="empty">No one has finished their shift yet.</div>`}
        </div>
        ${withApprovals ? `<div class="section">
          <h2>Pending leave approvals (${pend.leaves.length})</h2>
          ${pend.leaves.length ? leaveApprovalTable(pend.leaves) : `<div class="empty">Nothing waiting for approval. 🎉</div>`}
        </div>
        <div class="section">
          <h2>Attendance correction requests (${punchPend.requests.length})</h2>
          ${punchPend.requests.length ? punchApprovalTable(punchPend.requests) : `<div class="empty">No correction requests. 🎉</div>`}
        </div>` : ''}`;
      if (withApprovals) { wireLeaveApprovals(); wirePunchApprovals(); }
      tickDashTimers(); // paint the first tick immediately
    } catch (e) { toast(e.message, true); }
  }

  // Start the live panel in a host element with a 1s tick and a fast poll.
  function startLiveAttendance(hostId, withApprovals) {
    renderLiveAttendance(hostId, withApprovals);
    dashTimers.push(setInterval(tickDashTimers, 1000));
    dashTimers.push(setInterval(() => renderLiveAttendance(hostId, withApprovals), 10000));
  }

  const statCard = (label, value, cls) => `<div class="card stat"><div class="label">${esc(label)}</div><div class="${cls}">${value}</div></div>`;

  // ---------- Clock ----------
  VIEWS.clock = async () => {
    setMain('Clock', 'Punch in and out, take breaks, and review your timesheet.',
      `<div class="cards" style="grid-template-columns:1fr;max-width:520px;">
         <div class="card clock" id="clockCard"></div>
       </div>
       <div class="admin-only section" style="margin-top:8px;"><h2 style="color:var(--navy);">Team — live now</h2><div id="clockTeam"></div></div>
       <div class="section"><div class="toolbar"><h2 style="margin:0;">My last 14 days</h2><button class="btn btn-ghost btn-sm" id="fixPunchBtn">🛠 Request a correction</button></div><div id="timesheet"></div></div>
       <div class="section"><h2>My correction requests</h2><div id="myPunchReqs"></div></div>`);
    await renderClock();
    loadTimesheet();
    $('#fixPunchBtn').addEventListener('click', () => openPunchRequestModal());
    loadMyPunchRequests();
    if (isAdmin()) startLiveAttendance('clockTeam', false); // live team timers + 10s refresh
  };

  const PUNCH_LABEL = { IN: 'Clock in', OUT: 'Clock out', BREAK_START: 'Break start', BREAK_END: 'Break end' };
  const REQ_BADGE = { PENDING: 'b-pending', APPROVED: 'b-approved', REJECTED: 'b-high' };
  function openPunchRequestModal() {
    modal(`<h3>Request an attendance correction</h3>
      <p style="color:var(--slate);margin:0 0 14px;font-size:.88rem;">Forgot to clock in/out or punched the wrong time? Send it to an admin to add for you.</p>
      <div class="form-row"><div class="field"><label>Day</label><input type="date" id="prDay" value="${todayISO()}"></div>
        <div class="field"><label>What to add</label><select id="prType">${Object.entries(PUNCH_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div></div>
      <div class="form-row"><div class="field"><label>Time (24h)</label><input type="time" id="prTime"></div><div class="field"></div></div>
      <div class="form-row one"><div class="field"><label>Reason</label><textarea id="prReason" placeholder="e.g. Forgot to clock out, left at 6:30pm"></textarea></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSend">Send request</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSend').addEventListener('click', async () => {
      const payload = { day: $('#prDay').value, type: $('#prType').value, time: $('#prTime').value, reason: $('#prReason').value };
      if (!payload.day || !payload.time) return toast('Pick a day and time', true);
      try { await api.post('/punch-requests', payload); closeModal(); toast('Request sent to admin ✓'); loadMyPunchRequests(); }
      catch (e) { toast(e.message, true); }
    });
  }
  async function loadMyPunchRequests() {
    try {
      const { requests } = await api.get('/punch-requests/mine');
      const el = $('#myPunchReqs'); if (!el) return;
      if (!requests.length) { el.innerHTML = `<div class="empty">No correction requests.</div>`; return; }
      el.innerHTML = `<table><thead><tr><th>Day</th><th>Punch</th><th>Time</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
        ${requests.map((r) => `<tr><td>${esc(r.day)}</td><td>${PUNCH_LABEL[r.type] || r.type}</td><td>${esc(r.time)}</td>
          <td>${esc(r.reason || '—')}</td><td><span class="badge ${REQ_BADGE[r.status] || ''}">${cap(r.status)}</span>${r.admin_note ? `<div style="color:var(--slate);font-size:.76rem;margin-top:3px;">${esc(r.admin_note)}</div>` : ''}</td>
          <td>${r.status === 'PENDING' ? `<button class="btn btn-ghost btn-sm" data-cancel-req="${r.id}">Cancel</button>` : ''}</td></tr>`).join('')}
      </tbody></table>`;
      el.querySelectorAll('[data-cancel-req]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`/punch-requests/${b.dataset.cancelReq}/cancel`); toast('Cancelled'); loadMyPunchRequests(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }

  async function renderClock() {
    let status;
    try { status = await api.get('/attendance/status'); } catch (e) { return toast(e.message, true); }
    const labels = { IN: 'Clocked In', OUT: 'Clocked Out', BREAK: 'On Break', OFF: 'Off' };
    const btns = {
      IN: `<button class="btn btn-primary" data-punch="IN">▶ Clock In</button>`,
      OUT: `<button class="btn btn-danger" data-punch="OUT">⏹ Clock Out</button>`,
      BREAK_START: `<button class="btn btn-ghost" data-punch="BREAK_START">☕ Start Break</button>`,
      BREAK_END: `<button class="btn btn-primary" data-punch="BREAK_END">↩ End Break</button>`,
    };
    const card = $('#clockCard');
    if (!card) return;
    card.innerHTML = `
      <span class="state-badge b-${status.state.toLowerCase()}">${labels[status.state] || status.state}</span>
      <div class="now" id="liveClock">--:--:--</div>
      <div class="meta">Worked today: <strong>${fmtMins(status.workedMinutes)}</strong> · Breaks: ${fmtMins(status.breakMinutes)}</div>
      <div class="clock-btns">${(status.allowed || []).map((a) => btns[a]).join('')}</div>`;
    card.querySelectorAll('[data-punch]').forEach((b) => b.addEventListener('click', () => punch(b.dataset.punch)));
    clearInterval(clockTimer);
    const tick = () => { const el = $('#liveClock'); if (el) el.textContent = new Date().toLocaleTimeString(); };
    tick(); clockTimer = setInterval(tick, 1000);
  }

  async function punch(type) {
    try { await api.post('/attendance/punch', { type }); toast('Recorded ✓'); await renderClock(); loadTimesheet(); }
    catch (e) { toast(e.message, true); }
  }

  async function loadTimesheet() {
    try {
      const { days } = await api.get('/attendance/timesheet');
      const el = $('#timesheet'); if (!el) return;
      if (!days.length) { el.innerHTML = `<div class="empty">No punches yet.</div>`; return; }
      el.innerHTML = `<table><thead><tr><th>Date</th><th>First In</th><th>Last Out</th><th>Worked</th><th>Break</th></tr></thead><tbody>
        ${days.slice().reverse().map((d) => `<tr>
          <td>${esc(d.day)}</td>
          <td>${d.firstIn ? new Date(d.firstIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
          <td>${d.lastOut ? new Date(d.lastOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
          <td>${fmtMins(d.workedMinutes)}</td><td>${fmtMins(d.breakMinutes)}</td></tr>`).join('')}
      </tbody></table>`;
    } catch (e) { toast(e.message, true); }
  }

  // ---------- Notice board ----------
  VIEWS.noticeboard = async () => {
    setMain('Notice board', 'Company updates and announcements.',
      `${isAdmin() ? '<div class="toolbar"><span></span><button class="btn btn-primary" id="newNoticeBtn">+ Post notice</button></div>' : ''}
       <div id="noticeList"></div>`);
    if (isAdmin()) $('#newNoticeBtn').addEventListener('click', () => openNoticeModal());
    loadNotices();
  };
  async function loadNotices() {
    try {
      const { announcements } = await api.get('/announcements');
      const el = $('#noticeList'); if (!el) return;
      if (!announcements.length) { el.innerHTML = `<div class="empty">No announcements yet.</div>`; return; }
      el.innerHTML = announcements.map((a) => `<div class="notice ${a.pinned ? 'pinned' : ''}">
        <h3>${esc(a.title)}${a.pinned ? '<span class="pin-tag">📌 Pinned</span>' : ''}</h3>
        <div class="meta">${esc(a.author || 'Admin')} · ${fmtWhen(a.created_ts)}</div>
        ${a.body ? `<div class="body">${esc(a.body)}</div>` : ''}
        ${isAdmin() ? `<div class="row-actions" style="margin-top:10px;"><button class="btn btn-ghost btn-sm" data-edit-notice="${a.id}">Edit</button><button class="btn btn-danger btn-sm" data-del-notice="${a.id}">Delete</button></div>` : ''}
      </div>`).join('');
      el.querySelectorAll('[data-edit-notice]').forEach((b) => b.addEventListener('click', () => openNoticeModal(announcements.find((a) => a.id == b.dataset.editNotice))));
      el.querySelectorAll('[data-del-notice]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this notice?')) return;
        try { await api.del(`/announcements/${b.dataset.delNotice}`); toast('Deleted'); loadNotices(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }
  function openNoticeModal(a) {
    const editing = !!a;
    modal(`<h3>${editing ? 'Edit notice' : 'Post a notice'}</h3>
      <div class="form-row one"><div class="field"><label>Title</label><input id="anTitle" value="${esc(a?.title || '')}"></div></div>
      <div class="form-row one"><div class="field"><label>Message</label><textarea id="anBody" rows="5" style="min-height:120px;">${esc(a?.body || '')}</textarea></div></div>
      <div class="form-row one"><div class="field" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" id="anPin" ${a?.pinned ? 'checked' : ''} style="width:auto;"> <label for="anPin" style="margin:0;">Pin to top</label></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">${editing ? 'Save' : 'Post'}</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const payload = { title: $('#anTitle').value, body: $('#anBody').value, pinned: $('#anPin').checked };
      if (!payload.title.trim()) return toast('A title is required', true);
      try {
        if (editing) await api.put(`/announcements/${a.id}`, payload); else await api.post('/announcements', payload);
        closeModal(); toast(editing ? 'Saved ✓' : 'Posted ✓'); loadNotices();
      } catch (e) { toast(e.message, true); }
    });
  }

  // ---------- Trends (admin analytics, hand-drawn SVG — CSP-safe) ----------
  VIEWS.trends = async () => {
    setMain('Trends', 'How attendance and billing are moving over time.',
      `<div id="trends"><div class="empty">Loading…</div></div>`);
    try {
      const d = await api.get('/analytics');
      const nf = (n) => n.toLocaleString();
      const anyRev = d.revenue.some((m) => m.invoiced > 0);
      const anyClient = d.clients.some((c) => c.invoiced > 0);
      $('#trends').innerHTML = `
        <div class="chart-card"><h2>Hours worked — last 30 days</h2>
          ${vbars(d.attendance, (r) => r.hours, (r) => r.day.slice(5), 'var(--teal)', 'h')}
        </div>
        <div class="chart-card"><h2>Revenue per month — last 12 months</h2>
          ${anyRev ? groupedBars(d.revenue, ['invoiced', 'paid'], ['#b9c7d6', 'var(--teal)'], nf)
            + `<div class="chart-legend"><span><i style="background:#b9c7d6"></i>Invoiced</span><span><i style="background:var(--teal)"></i>Paid</span></div>`
            : `<div class="empty">No invoices yet — this fills in as you bill clients.</div>`}
        </div>
        <div class="chart-card"><h2>Top clients — invoiced vs paid</h2>
          ${anyClient ? hbars(d.clients) + `<div class="chart-legend"><span><i style="background:#c9d6e2"></i>Invoiced</span><span><i style="background:var(--teal)"></i>Paid</span></div>`
            : `<div class="empty">No client billing yet.</div>`}
        </div>`;
    } catch (e) { $('#trends').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  // Vertical bar chart.
  function vbars(rows, val, lab, color, unit) {
    const W = 720, H = 220, pad = 30; const n = rows.length || 1;
    const bw = (W - 2 * pad) / n; const max = Math.max(1, ...rows.map(val));
    const bars = rows.map((r, i) => { const h = (val(r) / max) * (H - 2 * pad); const x = pad + i * bw; const y = H - pad - h;
      return `<rect x="${(x + bw * 0.15).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${color}"><title>${esc(lab(r))}: ${val(r)}${unit}</title></rect>`; }).join('');
    const labels = rows.map((r, i) => i % 5 === 0 ? `<text x="${(pad + i * bw + bw / 2).toFixed(1)}" y="${H - 8}" font-size="10" fill="#8a97a3" text-anchor="middle">${esc(lab(r))}</text>` : '').join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;" role="img"><line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#e3eaf1"/>${bars}${labels}</svg>`;
  }
  // Grouped (two series) vertical bars.
  function groupedBars(rows, keys, colors, fmtv) {
    const W = 720, H = 240, pad = 34; const n = rows.length || 1;
    const gw = (W - 2 * pad) / n; const max = Math.max(1, ...rows.flatMap((r) => keys.map((k) => r[k])));
    const bars = rows.map((r, i) => { const x = pad + i * gw;
      return keys.map((k, ki) => { const h = (r[k] / max) * (H - 2 * pad); const bw = gw * 0.32; const bx = x + gw * 0.16 + ki * bw; const y = H - pad - h;
        return `<rect x="${bx.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.9).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${colors[ki]}"><title>${esc(r.label)} ${k}: ${fmtv(r[k])}</title></rect>`; }).join(''); }).join('');
    const labels = rows.map((r, i) => `<text x="${(pad + i * gw + gw / 2).toFixed(1)}" y="${H - 8}" font-size="10" fill="#8a97a3" text-anchor="middle">${esc(r.label)}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;" role="img"><line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#e3eaf1"/>${bars}${labels}</svg>`;
  }
  // Horizontal bars: invoiced (light) with paid (teal) overlaid.
  function hbars(rows) {
    const W = 720, rh = 34, pad = 8, labelW = 170; const H = rows.length * rh + 10;
    const max = Math.max(1, ...rows.map((r) => r.invoiced)); const track = W - labelW - 80;
    const bars = rows.map((r, i) => { const y = i * rh + pad; const full = (r.invoiced / max) * track; const paid = (r.paid / max) * track;
      const nm = r.name.length > 24 ? r.name.slice(0, 23) + '…' : r.name;
      return `<text x="0" y="${y + 17}" font-size="12" fill="#1c2733">${esc(nm)}</text>
        <rect x="${labelW}" y="${y + 4}" width="${full.toFixed(1)}" height="18" rx="3" fill="#c9d6e2"><title>${esc(r.name)} invoiced ${r.invoiced}</title></rect>
        <rect x="${labelW}" y="${y + 4}" width="${paid.toFixed(1)}" height="18" rx="3" fill="var(--teal)"><title>${esc(r.name)} paid ${r.paid}</title></rect>
        <text x="${(labelW + full + 6).toFixed(1)}" y="${y + 18}" font-size="11" fill="#51626f">${r.invoiced.toLocaleString()}</text>`; }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;" role="img">${bars}</svg>`;
  }

  // ---------- Leaves ----------
  VIEWS.leaves = async () => {
    // Admins get a team view (approvals + who's off) — no personal apply/balance.
    if (isAdmin()) {
      setMain('Leaves', "Requests waiting for approval, and who's on leave.",
        `<div class="section" id="adminLeaves"></div>
         <div class="section"><h2 id="onLeaveHeading">On leave — current & upcoming</h2><div id="onLeave"></div></div>
         <div class="section"><h2>Leave balances</h2><div id="leaveSummary"></div></div>`);
      loadAdminLeaves();
      loadOnLeave();
      loadLeaveSummary();
      return;
    }
    // Employees: personal balance + their own requests.
    setMain('Leaves', 'Apply for time off and track your requests.',
      `<div class="cards"><div class="card stat"><div class="label">Leave balance</div><div class="value small" id="balVal">—</div></div></div>
       <div class="toolbar"><h2 style="margin:0;color:var(--navy);">My requests</h2>
         <button class="btn btn-primary" id="applyBtn">+ Apply for leave</button></div>
       <div id="myLeaves"></div>`);
    $('#applyBtn').addEventListener('click', openApplyLeave);
    await loadMyLeaves();
  };

  const daysLabel = (n) => (n ? `${n} ${n === 1 ? 'day' : 'days'}` : '<span style="color:var(--slate)">none</span>');
  async function loadLeaveSummary() {
    try {
      const { rows } = await api.get('/leaves/summary');
      const el = $('#leaveSummary'); if (!el) return;
      el.innerHTML = rows.length ? `<p class="page-sub" style="margin:0 0 10px;">Click a row to see that employee's leave history.</p>
        <table><thead><tr><th>Employee</th><th>Department</th><th>Leaves left</th><th>Taken (last 30 days)</th><th>Taken (this year)</th></tr></thead><tbody>
        ${rows.map((r) => `<tr style="cursor:pointer;" data-leave-emp="${r.id}" data-leave-name="${esc(r.name)}"><td><strong>${esc(r.name)}</strong></td><td>${esc(r.department || '—')}</td>
          <td><strong>${r.balance}</strong> ${r.balance === 1 ? 'day' : 'days'}</td>
          <td>${daysLabel(r.taken30)}</td><td>${daysLabel(r.takenYear)}</td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No employees.</div>`;
      el.querySelectorAll('[data-leave-emp]').forEach((tr) => tr.addEventListener('click', () => openLeaveBreakdown(tr.dataset.leaveEmp, tr.dataset.leaveName)));
    } catch (e) { toast(e.message, true); }
  }

  async function openLeaveBreakdown(userId, name) {
    modal(`<h3>Leave history — ${esc(name)}</h3><div id="lbBody">Loading…</div>`);
    try {
      const { leaves } = await api.get(`/leaves/for/${userId}`);
      $('#lbBody').innerHTML = leaves.length ? `<table><thead><tr><th>Dates</th><th>Type</th><th>Days</th><th>Reason</th><th>Status</th></tr></thead><tbody>
        ${leaves.map((l) => `<tr><td>${fmtDate(l.start_date)}${l.end_date !== l.start_date ? ' → ' + fmtDate(l.end_date) : ''}</td>
          <td>${esc(cap(l.kind))}</td><td>${l.days}</td><td>${esc(l.reason || '—')}</td><td>${badge(l.status)}</td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No leave records.</div>`;
    } catch (e) { $('#lbBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    const done = document.createElement('div');
    done.className = 'modal-actions';
    done.innerHTML = '<button class="btn btn-primary" id="lbClose">Close</button>';
    $('#modal').appendChild(done);
    $('#lbClose').addEventListener('click', closeModal);
  }

  async function loadOnLeave() {
    try {
      const { leaves } = await api.get('/leaves/upcoming');
      const today = todayISO();
      const onNowOf = (l) => l.start_date <= today && l.end_date >= today;
      // Currently-on-leave first, then upcoming; within each group, earliest start first.
      const sorted = leaves.slice().sort((a, b) =>
        (onNowOf(b) - onNowOf(a)) || a.start_date.localeCompare(b.start_date));
      const nowCount = leaves.filter(onNowOf).length;
      const heading = $('#onLeaveHeading');
      if (heading) heading.textContent = `On leave — ${nowCount} now · ${leaves.length - nowCount} upcoming`;
      const el = $('#onLeave'); if (!el) return;
      el.innerHTML = sorted.length ? `<table><thead><tr><th>Employee</th><th>Dates</th><th>Type</th><th>Days</th><th>Status</th></tr></thead><tbody>
        ${sorted.map((l) => {
          const onNow = onNowOf(l);
          return `<tr><td>${esc(l.name)}</td>
            <td>${fmtDate(l.start_date)}${l.end_date !== l.start_date ? ' → ' + fmtDate(l.end_date) : ''}</td>
            <td>${esc(cap(l.kind))}</td><td>${l.days}</td>
            <td>${onNow ? '<span class="badge b-pending">On leave now</span>' : '<span class="badge b-todo">Upcoming</span>'}</td></tr>`;
        }).join('')}
      </tbody></table>` : `<div class="empty">No one is on leave now or in the near future.</div>`;
    } catch (e) { toast(e.message, true); }
  }

  async function loadMyLeaves() {
    try {
      const { balance, leaves } = await api.get('/leaves/mine');
      $('#balVal').textContent = `${balance} days`;
      const el = $('#myLeaves');
      el.innerHTML = leaves.length ? `<table><thead><tr><th>Dates</th><th>Type</th><th>Days</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>
        ${leaves.map((l) => `<tr>
          <td>${fmtDate(l.start_date)}${l.end_date !== l.start_date ? ' → ' + fmtDate(l.end_date) : ''}</td>
          <td>${esc(cap(l.kind))}</td><td>${l.days}</td><td>${esc(l.reason || '—')}</td><td>${badge(l.status)}</td>
          <td>${l.status === 'PENDING' ? `<button class="btn btn-ghost btn-sm" data-cancel="${l.id}">Cancel</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>` : `<div class="empty">No leave requests yet.</div>`;
      el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`/leaves/${b.dataset.cancel}/cancel`); toast('Cancelled'); loadMyLeaves(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }

  function openApplyLeave() {
    modal(`<h3>Apply for leave</h3>
      <div class="form-row"><div class="field"><label>Start date</label><input type="date" id="lStart" value="${todayISO()}"></div>
        <div class="field"><label>End date</label><input type="date" id="lEnd" value="${todayISO()}"></div></div>
      <div class="form-row"><div class="field"><label>Type</label><select id="lKind"><option value="FULL">Full day(s)</option><option value="HALF">Half day</option></select></div>
        <div class="field"><label>&nbsp;</label><div style="font-size:.82rem;color:var(--slate);padding-top:10px;">Half day counts as 0.5 days.</div></div></div>
      <div class="form-row one"><div class="field"><label>Reason</label><textarea id="lReason" placeholder="Optional"></textarea></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSubmit">Submit request</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSubmit').addEventListener('click', async () => {
      try {
        await api.post('/leaves', { start_date: $('#lStart').value, end_date: $('#lEnd').value, kind: $('#lKind').value, reason: $('#lReason').value });
        closeModal(); toast('Request submitted ✓'); loadMyLeaves();
      } catch (e) { toast(e.message, true); }
    });
  }

  function leaveApprovalTable(leaves) {
    return `<table><thead><tr><th>Employee</th><th>Dates</th><th>Type</th><th>Days</th><th>Reason</th><th>Action</th></tr></thead><tbody>
      ${leaves.map((l) => `<tr>
        <td>${esc(l.name)}</td><td>${fmtDate(l.start_date)}${l.end_date !== l.start_date ? ' → ' + fmtDate(l.end_date) : ''}</td>
        <td>${esc(cap(l.kind))}</td><td>${l.days}</td><td>${esc(l.reason || '—')}</td>
        <td class="row-actions"><button class="btn btn-primary btn-sm" data-approve="${l.id}" data-days="${l.days}" data-balance="${l.leave_balance ?? ''}" data-name="${esc(l.name)}">Approve</button>
          <button class="btn btn-danger btn-sm" data-reject="${l.id}">Reject</button></td>
      </tr>`).join('')}</tbody></table>`;
  }

  function punchApprovalTable(requests) {
    return `<table><thead><tr><th>Employee</th><th>Day</th><th>Punch</th><th>Time</th><th>Reason</th><th>Action</th></tr></thead><tbody>
      ${requests.map((r) => `<tr>
        <td>${esc(r.name)}</td><td>${esc(r.day)}</td><td>${PUNCH_LABEL[r.type] || r.type}</td><td>${esc(r.time)}</td><td>${esc(r.reason || '—')}</td>
        <td class="row-actions"><button class="btn btn-primary btn-sm" data-preq-approve="${r.id}">Approve</button>
          <button class="btn btn-danger btn-sm" data-preq-reject="${r.id}">Reject</button></td>
      </tr>`).join('')}</tbody></table>`;
  }
  function wirePunchApprovals() {
    document.querySelectorAll('[data-preq-approve],[data-preq-reject]').forEach((b) => {
      if (b.dataset.wired) return; b.dataset.wired = '1';
      b.addEventListener('click', async () => {
        const id = b.dataset.preqApprove || b.dataset.preqReject;
        const decision = b.dataset.preqApprove ? 'APPROVED' : 'REJECTED';
        try { await api.post(`/punch-requests/${id}/decide`, { decision }); toast(decision === 'APPROVED' ? 'Approved ✓ — punch added' : 'Rejected');
          navigate(document.querySelector('.nav-item.active').dataset.view);
        } catch (e) { toast(e.message, true); }
      });
    });
  }

  function wireLeaveApprovals() {
    document.querySelectorAll('[data-approve],[data-reject]').forEach((b) => {
      if (b.dataset.wired) return; b.dataset.wired = '1';
      b.addEventListener('click', async () => {
        const id = b.dataset.approve || b.dataset.reject;
        const decision = b.dataset.approve ? 'APPROVED' : 'REJECTED';
        // Warn before approving a request that exceeds the employee's balance.
        if (b.dataset.approve && b.dataset.balance !== '') {
          const days = Number(b.dataset.days); const bal = Number(b.dataset.balance);
          if (days > bal && !confirm(`${b.dataset.name} has ${bal} day(s) left but this request is ${days} day(s). Approving takes the balance to ${bal - days}. Approve anyway?`)) return;
        }
        try { await api.post(`/leaves/${id}/decide`, { decision }); toast(decision === 'APPROVED' ? 'Approved ✓' : 'Rejected');
          navigate(document.querySelector('.nav-item.active').dataset.view);
        } catch (e) { toast(e.message, true); }
      });
    });
  }

  async function loadAdminLeaves() {
    try {
      const { leaves } = await api.get('/leaves/pending');
      $('#adminLeaves').innerHTML = `<h2>Pending approvals (${leaves.length})</h2>${leaves.length ? leaveApprovalTable(leaves) : `<div class="empty">Nothing waiting.</div>`}`;
      wireLeaveApprovals();
    } catch (e) { toast(e.message, true); }
  }

  // Cache of active clients + users for dropdowns and labels.
  let CLIENTS = [];
  let USERS = [];
  async function loadLookups() {
    try {
      const [c, u] = await Promise.all([api.get('/clients'), api.get('/users')]);
      CLIENTS = c.clients; USERS = u.users;
    } catch (e) { toast(e.message, true); }
  }
  const clientLabel = (t) => t.client_name ? `<span class="badge b-public" style="font-size:.68rem">${esc(t.client_parent_name ? t.client_parent_name + ' › ' + t.client_name : t.client_name)}</span>` : '';

  // ---------- Tasks ----------
  let taskClientFilter = '';
  let taskSearch = '';
  let taskAssignee = '';
  let taskStatus = '';
  let taskPriority = '';
  const collapsedGroups = new Set();
  // Row action menus are <details> elements, which don't close each other or on
  // an outside click. This one-time listener closes any open menu when the click
  // lands outside it — so only one ⋯ menu is ever open at a time.
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.rowmenu[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
  VIEWS.tasks = async () => {
    const emp = !isAdmin();
    setMain('Tasks', isAdmin() ? 'Assign work and track progress, grouped by client.' : 'Your work, organised by client.',
      `<div class="admin-only">
         <div class="toolbar">
           <h2 style="margin:0;color:var(--navy);">All tasks</h2>
           <button class="btn btn-primary" id="newTaskBtn">+ Assign task</button></div>
         <div class="task-filters">
           <input id="taskSearch" class="tf-search" placeholder="Search title, person or client…" autocomplete="off">
           <select id="clientFilter" class="tf-sel"></select>
           <select id="assigneeFilter" class="tf-sel"></select>
           <div class="tf-chips" id="statusChips">
             <button class="chip on" data-st="">All</button>
             <button class="chip" data-st="TODO">To do</button>
             <button class="chip" data-st="IN_PROGRESS">In progress</button>
             <button class="chip" data-st="DONE">Done</button>
           </div>
           <div class="tf-chips" id="priChips">
             <button class="chip on" data-pri="">Any priority</button>
             <button class="chip" data-pri="HIGH">High</button>
             <button class="chip" data-pri="MEDIUM">Medium</button>
             <button class="chip" data-pri="LOW">Low</button>
           </div>
         </div>
       </div>
       <div class="admin-only" id="allTasks" style="margin-bottom:28px;"></div>
       <div class="toolbar"><h2 style="margin:0;color:var(--navy);">My tasks</h2>
         ${emp ? '<div class="row-actions"><button class="btn btn-ghost" id="suggestClientBtn">Suggest a client</button><button class="btn btn-primary" id="addMyTaskBtn">+ Add task</button></div>' : ''}</div>
       <div id="myTasks"></div>
       ${emp ? '<div class="section" style="margin-top:26px;"><h2 style="color:var(--navy);">My recurring schedules</h2><div id="myRecurring"></div></div>' : ''}`);
    if (isAdmin()) {
      await loadLookups();
      $('#clientFilter').innerHTML = `<option value="">All clients</option><option value="none">— No client —</option>`
        + CLIENTS.map((c) => `<option value="${c.id}" ${taskClientFilter == c.id ? 'selected' : ''}>${esc(clientPath(c))}</option>`).join('');
      $('#clientFilter').value = taskClientFilter;
      $('#clientFilter').addEventListener('change', (e) => { taskClientFilter = e.target.value; loadAllTasks(); });
      $('#assigneeFilter').innerHTML = `<option value="">Anyone</option>`
        + USERS.map((u) => `<option value="${u.id}" ${taskAssignee == u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
      $('#assigneeFilter').value = taskAssignee;
      $('#assigneeFilter').addEventListener('change', (e) => { taskAssignee = e.target.value; loadAllTasks(); });
      const search = $('#taskSearch');
      search.value = taskSearch;
      search.addEventListener('input', (e) => { taskSearch = e.target.value; loadAllTasks(); });
      const chipRow = (sel, attr, set) => $(sel).addEventListener('click', (e) => {
        const b = e.target.closest('button[' + attr + ']'); if (!b) return;
        $(sel).querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
        b.classList.add('on'); set(b.getAttribute(attr)); loadAllTasks();
      });
      chipRow('#statusChips', 'data-st', (v) => { taskStatus = v; });
      chipRow('#priChips', 'data-pri', (v) => { taskPriority = v; });
      $('#newTaskBtn').addEventListener('click', () => openTaskModal());
      loadAllTasks();
    }
    if (emp) {
      await loadLookups();
      $('#addMyTaskBtn').addEventListener('click', openMyTaskModal);
      $('#suggestClientBtn').addEventListener('click', openProposeClientModal);
      loadMyRecurring();
    }
    loadMyTasks();
  };

  // Employee proposes a new client for admin approval.
  function openProposeClientModal() {
    modal(`<h3>Suggest a client</h3>
      <p style="color:var(--slate);margin:0 0 14px;font-size:.88rem;">This goes to an admin for approval before it can be used for tasks.</p>
      <div class="form-row"><div class="field"><label>Client name</label><input id="pcName"></div>
        <div class="field"><label>Business type</label><input id="pcBiz" placeholder="e.g. Restaurant"></div></div>
      <div class="form-row"><div class="field"><label>Stage</label><select id="pcStage">${['PROSPECT', 'INTERVIEWED', 'SIGNED'].map((s) => `<option value="${s}">${STAGE_LABEL[s]}</option>`).join('')}</select></div>
        <div class="field"></div></div>
      <div class="form-row one"><div class="field"><label>Notes</label><textarea id="pcNotes" placeholder="Anything the partners should know"></textarea></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">Send for approval</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const name = $('#pcName').value.trim();
      if (!name) return toast('Please enter a client name', true);
      try {
        await api.post('/clients', { name, business_type: $('#pcBiz').value, stage: $('#pcStage').value, notes: $('#pcNotes').value });
        closeModal(); toast('Sent for approval ✓');
      } catch (e) { toast(e.message, true); }
    });
  }

  // Employee: add a one-time or recurring task for themselves, tied to a client.
  async function openMyTaskModal() {
    if (!CLIENTS.length) await loadLookups();
    if (!CLIENTS.length) return toast('No clients yet — ask an admin to add one first.', true);
    modal(`<h3>Add a task</h3>
      <div class="form-row"><div class="field"><label>Client</label><select id="mtClient"><option value="">Select a client…</option>${CLIENTS.map((c) => `<option value="${c.id}">${esc(clientPath(c))}</option>`).join('')}</select></div>
        <div class="field"><label>Priority</label><select id="mtPriority">${['LOW', 'MEDIUM', 'HIGH'].map((p) => `<option value="${p}" ${p === 'MEDIUM' ? 'selected' : ''}>${cap(p)}</option>`).join('')}</select></div></div>
      <div class="form-row one"><div class="field"><label>Title</label><input id="mtTitle" placeholder="e.g. Monthly bookkeeping"></div></div>
      <div class="form-row one"><div class="field"><label>Description</label><textarea id="mtDesc" placeholder="Optional"></textarea></div></div>
      <div class="form-row"><div class="field"><label>Repeat</label><select id="mtRepeat"><option value="">One-time</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="YEARLY">Yearly</option></select></div>
        <div class="field"><label id="mtDueLabel">Due date</label><input type="date" id="mtDue" value="${todayISO()}"></div></div>
      <div class="form-row one"><div class="field"><label>Checklist — one item per line (optional)</label><textarea id="mtChecklist" placeholder="Points to tick off before this can be marked done"></textarea></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">Add</button></div>`);
    $('#mtRepeat').addEventListener('change', (e) => { $('#mtDueLabel').textContent = e.target.value ? 'First occurrence' : 'Due date'; });
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const client_id = $('#mtClient').value;
      const title = $('#mtTitle').value.trim();
      if (!client_id) return toast('Please choose a client', true);
      if (!title) return toast('Please enter a title', true);
      const repeat = $('#mtRepeat').value;
      const checklist = $('#mtChecklist').value;
      try {
        if (repeat) {
          await api.post('/recurring', { title, description: $('#mtDesc').value, client_id, priority: $('#mtPriority').value, frequency: repeat, next_due: $('#mtDue').value, lead_days: 7, step: 1, checklist });
          toast('Recurring task added ✓');
        } else {
          await api.post('/tasks', { title, description: $('#mtDesc').value, client_id, priority: $('#mtPriority').value, due_date: $('#mtDue').value, checklist });
          toast('Task added ✓');
        }
        closeModal(); loadMyTasks(); loadMyRecurring();
      } catch (e) { toast(e.message, true); }
    });
  }

  async function loadMyRecurring() {
    const el = $('#myRecurring'); if (!el) return;
    try {
      const { recurring } = await api.get('/recurring/mine');
      el.innerHTML = recurring.length ? `<table><thead><tr><th>Task</th><th>Client</th><th>Every</th><th>Next due</th><th>Status</th><th></th></tr></thead><tbody>
        ${recurring.map((r) => `<tr style="${r.active ? '' : 'opacity:.5'}"><td><strong>${esc(r.title)}</strong></td><td>${esc(r.client_name || '—')}</td>
          <td>${FREQ_LABEL[r.frequency]}</td><td>${fmtDate(r.next_due)}</td><td>${r.active ? badge('approved') : badge('cancelled')}</td>
          <td class="row-actions"><button class="btn btn-ghost btn-sm" data-mtoggle="${r.id}" data-active="${r.active ? 0 : 1}">${r.active ? 'Pause' : 'Resume'}</button>
            <button class="btn btn-danger btn-sm" data-mdel="${r.id}">✕</button></td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No recurring tasks yet. Use “+ Add task” and pick a Repeat option.</div>`;
      el.querySelectorAll('[data-mtoggle]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`/recurring/${b.dataset.mtoggle}/active`, { active: Number(b.dataset.active) }); toast('Updated'); loadMyRecurring(); } catch (e) { toast(e.message, true); }
      }));
      el.querySelectorAll('[data-mdel]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this recurring task? Tasks already created are kept.')) return;
        try { await api.del(`/recurring/${b.dataset.mdel}`); toast('Deleted'); loadMyRecurring(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }

  const statusSelect = (id, status, lockDone) => `<select data-status="${id}">
    ${['TODO', 'IN_PROGRESS', 'DONE'].map((s) => `<option value="${s}" ${s === status ? 'selected' : ''} ${s === 'DONE' && lockDone ? 'disabled' : ''}>${cap(s.replace('_', ' '))}</option>`).join('')}</select>`;

  const openItems = (t) => (t.checklist || []).filter((i) => !i.done).length;

  // Renders a task's checklist as tick-boxes with a done/total count.
  function checklistHtml(t) {
    if (!t.checklist || !t.checklist.length) return '';
    const done = t.checklist.length - openItems(t);
    const allDone = openItems(t) === 0;
    return `<div style="margin-top:7px;">
      <div style="font-size:.7rem;font-weight:700;letter-spacing:.4px;text-transform:uppercase;margin-bottom:3px;color:${allDone ? 'var(--teal-dark)' : 'var(--slate)'};">✓ Checklist ${done}/${t.checklist.length}${allDone ? ' — ready to complete' : ''}</div>
      ${t.checklist.map((i) => `<label style="display:flex;gap:7px;align-items:flex-start;font-size:.84rem;margin:2px 0;cursor:pointer;">
        <input type="checkbox" data-check="${t.id}:${i.id}" ${i.done ? 'checked' : ''} style="margin-top:2px;">
        <span style="${i.done ? 'text-decoration:line-through;color:var(--slate);' : ''}">${esc(i.text)}</span></label>`).join('')}
    </div>`;
  }
  function wireChecklist(root, reload) {
    root.querySelectorAll('[data-check]').forEach((c) => c.addEventListener('change', async () => {
      const [taskId, itemId] = c.dataset.check.split(':');
      try { await api.post(`/tasks/${taskId}/checklist/${itemId}`, { done: c.checked }); if (reload) reload(); }
      catch (e) { toast(e.message, true); }
    }));
  }
  // A recurring template stores its checklist as a JSON array of strings.
  function parseChecklistJson(json) {
    if (!json) return '';
    try { const a = JSON.parse(json); return Array.isArray(a) ? a.join('\n') : ''; } catch (_e) { return ''; }
  }

  // Compact "✓ 2/3" badge for the admin board.
  function checklistBadge(t) {
    if (!t.checklist || !t.checklist.length) return '';
    const total = t.checklist.length, done = total - openItems(t);
    const cls = done === total ? 'b-done' : 'b-pending';
    return ` <span class="badge ${cls}" title="checklist">✓ ${done}/${total}</span>`;
  }

  // Modal to add / rename / remove a task's checklist items (admin or assignee).
  function openChecklistEditor(task, onClose) {
    renderChecklistEditor(task, onClose);
  }
  function renderChecklistEditor(task, onClose) {
    const items = task.checklist || [];
    modal(`<h3>Checklist — ${esc(task.title)}</h3>
      <div>${items.length ? items.map((i) => `<div class="form-row" style="margin-bottom:8px;">
          <div class="field" style="flex:1;"><input value="${esc(i.text)}" data-cltext="${i.id}"></div>
          <div class="field" style="flex:0 0 auto;display:flex;gap:6px;align-items:center;padding-top:2px;">
            <span title="${i.done ? 'done' : 'open'}" style="font-size:1.05rem;">${i.done ? '✅' : '⬜'}</span>
            <button class="btn btn-primary btn-sm" data-clsave="${i.id}">Save</button>
            <button class="btn btn-danger btn-sm" data-cldel="${i.id}">✕</button>
          </div></div>`).join('') : '<div class="empty" style="margin-bottom:10px;">No checklist items yet.</div>'}</div>
      <div class="form-row" style="margin-bottom:0;"><div class="field" style="flex:1;"><input id="clNew" placeholder="Add a checklist item…"></div>
        <div class="field" style="flex:0 0 auto;padding-top:2px;"><button class="btn btn-navy btn-sm" id="clAdd">Add</button></div></div>
      <div class="modal-actions"><button class="btn btn-primary" id="clDone">Done</button></div>`);
    const rerender = (updated) => renderChecklistEditor(updated, onClose);
    document.querySelectorAll('[data-clsave]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.clsave;
      try { const r = await api.post(`/tasks/${task.id}/checklist/${id}`, { text: document.querySelector(`[data-cltext="${id}"]`).value }); toast('Saved ✓'); rerender(r.task); }
      catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-cldel]').forEach((b) => b.addEventListener('click', async () => {
      try { const r = await api.del(`/tasks/${task.id}/checklist/${b.dataset.cldel}`); toast('Removed'); rerender(r.task); }
      catch (e) { toast(e.message, true); }
    }));
    $('#clAdd').addEventListener('click', async () => {
      const text = $('#clNew').value.trim(); if (!text) return;
      try { const r = await api.post(`/tasks/${task.id}/checklist`, { text }); toast('Added ✓'); rerender(r.task); }
      catch (e) { toast(e.message, true); }
    });
    $('#clDone').addEventListener('click', () => { closeModal(); if (onClose) onClose(); });
  }

  async function loadMyTasks() {
    try {
      const { tasks } = await api.get('/tasks/mine');
      const el = $('#myTasks');
      el.innerHTML = tasks.length ? `<table><thead><tr><th>Task</th><th>Client</th><th>Priority</th><th>Due</th><th>Status</th></tr></thead><tbody>
        ${tasks.map((t) => `<tr><td><strong>${esc(t.title)}</strong>${t.description ? `<div style="color:var(--slate);font-size:.84rem;margin-top:3px;">${esc(t.description)}</div>` : ''}<div style="color:var(--slate);font-size:.78rem;margin-top:3px;">by ${esc(t.assigner_name)}${t.recurring_id ? ' · 🔁 recurring' : ''}</div>${checklistHtml(t)}
          <div style="margin-top:6px;"><button class="btn btn-ghost btn-sm" data-mychecklist="${t.id}">${t.checklist && t.checklist.length ? 'Edit checklist' : '+ Add checklist'}</button></div></td>
          <td>${clientLabel(t) || '—'}</td><td>${badge(t.priority)}</td><td>${fmtDate(t.due_date)}</td><td>${statusSelect(t.id, t.status, openItems(t) > 0)}</td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No tasks assigned to you. 🎉</div>`;
      wireStatusSelects(el, loadMyTasks);
      wireChecklist(el, loadMyTasks);
      el.querySelectorAll('[data-mychecklist]').forEach((b) => b.addEventListener('click', () => openChecklistEditor(tasks.find((t) => t.id == b.dataset.mychecklist), loadMyTasks)));
    } catch (e) { toast(e.message, true); }
  }

  // Inline assignee dropdown for a task row — reassign without opening a modal.
  function assigneeInlineSelect(t) {
    return `<select class="assignee-sel" data-assignee="${t.id}" title="Reassign">${USERS.map((u) => `<option value="${u.id}" ${u.id == t.assignee_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`;
  }

  async function loadAllTasks() {
    try {
      let { tasks } = await api.get('/tasks/all');
      if (taskClientFilter === 'none') tasks = tasks.filter((t) => !t.client_id);
      else if (taskClientFilter) tasks = tasks.filter((t) => t.client_id == taskClientFilter || t.client_parent_id == taskClientFilter); // roll up: a CPA shows its files too
      if (taskAssignee) tasks = tasks.filter((t) => t.assignee_id == taskAssignee);
      if (taskStatus) tasks = tasks.filter((t) => t.status === taskStatus);
      if (taskPriority) tasks = tasks.filter((t) => t.priority === taskPriority);
      if (taskSearch.trim()) {
        const q = taskSearch.trim().toLowerCase();
        tasks = tasks.filter((t) => [t.title, t.description, t.assignee_name, t.client_name, t.client_parent_name]
          .some((f) => String(f || '').toLowerCase().includes(q)));
      }
      const filtered = !!(taskClientFilter || taskAssignee || taskStatus || taskPriority || taskSearch.trim());
      const el = $('#allTasks');
      if (!tasks.length) { el.innerHTML = `<div class="empty">${filtered ? 'No tasks match these filters.' : 'No tasks here yet.'}</div>`; return; }

      // Roll sub-client (file) tasks up under their parent CPA; standalone
      // clients group on their own; untagged tasks go under "General".
      const groups = {};
      tasks.forEach((t) => { const k = t.client_parent_name || t.client_name || '— General —'; (groups[k] = groups[k] || []).push(t); });
      const order = Object.keys(groups).sort((a, b) => (a === '— General —') - (b === '— General —') || a.localeCompare(b));
      el.innerHTML = order.map((g) => `
        <div class="tgroup ${collapsedGroups.has(g) ? 'collapsed' : ''}">
          <div class="tgroup-head"><span class="caret">▾</span><h2>${esc(g)}</h2><span class="cnt">(${groups[g].length})</span></div>
          <table class="ttable"><thead><tr><th>Task</th><th>Assignee</th><th>Priority</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
          ${groups[g].map((t) => `<tr><td><strong>${esc(t.title)}</strong>${t.client_parent_name ? ` <span class="badge b-public" style="font-size:.66rem">${esc(t.client_name)}</span>` : ''}${t.recurring_id ? ' <span title="from a recurring schedule">🔁</span>' : ''}${checklistBadge(t)}</td>
            <td>${assigneeInlineSelect(t)}</td><td>${badge(t.priority)}</td><td>${fmtDate(t.due_date)}</td><td>${statusSelect(t.id, t.status, openItems(t) > 0)}</td>
            <td style="text-align:right;"><details class="rowmenu"><summary title="Actions">⋯</summary><div class="rowmenu-list">
              <button data-checklist-task="${t.id}">✓ Checklist</button>
              <button data-edit-task="${t.id}">✎ Edit</button>
              <button class="danger" data-del-task="${t.id}">🗑 Delete</button>
            </div></details></td></tr>`).join('')}
          </tbody></table></div>`).join('');
      // Collapse / expand a client group (remembered while the page is open).
      el.querySelectorAll('.tgroup-head').forEach((h, i) => h.addEventListener('click', () => {
        const g = order[i];
        if (collapsedGroups.has(g)) collapsedGroups.delete(g); else collapsedGroups.add(g);
        h.closest('.tgroup').classList.toggle('collapsed');
      }));
      wireStatusSelects(el, () => { loadAllTasks(); loadMyTasks(); });
      el.querySelectorAll('[data-assignee]').forEach((s) => s.addEventListener('change', async () => {
        try { await api.put(`/tasks/${s.dataset.assignee}`, { assignee_id: Number(s.value) }); toast('Reassigned ✓'); loadAllTasks(); loadMyTasks(); }
        catch (e) { toast(e.message, true); loadAllTasks(); }
      }));
      el.querySelectorAll('.rowmenu-list button').forEach((b) => b.addEventListener('click', () => b.closest('details')?.removeAttribute('open')));
      el.querySelectorAll('[data-checklist-task]').forEach((b) => b.addEventListener('click', () => openChecklistEditor(tasks.find((t) => t.id == b.dataset.checklistTask), () => { loadAllTasks(); loadMyTasks(); })));
      el.querySelectorAll('[data-edit-task]').forEach((b) => b.addEventListener('click', () => openTaskModal(tasks.find((t) => t.id == b.dataset.editTask))));
      el.querySelectorAll('[data-del-task]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this task?')) return;
        try { await api.del(`/tasks/${b.dataset.delTask}`); toast('Deleted'); loadAllTasks(); loadMyTasks(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }

  function wireStatusSelects(root, reload) {
    root.querySelectorAll('[data-status]').forEach((s) => s.addEventListener('change', async () => {
      try { await api.post(`/tasks/${s.dataset.status}/status`, { status: s.value }); toast('Updated ✓'); if (reload) reload(); }
      catch (e) { toast(e.message, true); }
    }));
  }

  // "Parent › File" when a client is a sub-client, else just its name.
  const clientPath = (c) => (c.parent_name ? `${c.parent_name} › ${c.name}` : c.name);
  function clientOptions(selectedId) {
    return `<option value="">— No client —</option>` + CLIENTS.map((c) => `<option value="${c.id}" ${selectedId == c.id ? 'selected' : ''}>${esc(clientPath(c))}</option>`).join('');
  }
  function userOptions(selectedId) {
    return USERS.map((u) => `<option value="${u.id}" ${selectedId == u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  }

  async function openTaskModal(task) {
    if (!USERS.length || !CLIENTS.length) await loadLookups();
    const editing = !!task;
    modal(`<h3>${editing ? 'Edit task' : 'Assign task'}</h3>
      <div class="form-row one"><div class="field"><label>Title</label><input id="tTitle" value="${esc(task?.title || '')}"></div></div>
      <div class="form-row one"><div class="field"><label>Description</label><textarea id="tDesc">${esc(task?.description || '')}</textarea></div></div>
      <div class="form-row"><div class="field"><label>Client</label><select id="tClient">${clientOptions(task?.client_id)}</select></div>
        <div class="field"><label>Assignee</label><select id="tAssignee">${userOptions(task?.assignee_id)}</select></div></div>
      <div class="form-row"><div class="field"><label>Priority</label><select id="tPriority">${['LOW', 'MEDIUM', 'HIGH'].map((p) => `<option value="${p}" ${(task?.priority || 'MEDIUM') === p ? 'selected' : ''}>${cap(p)}</option>`).join('')}</select></div>
        <div class="field"><label>Due date</label><input type="date" id="tDue" value="${esc(task?.due_date || '')}"></div></div>
      <div class="form-row one"><div class="field"><label>Checklist — one item per line (optional)</label><textarea id="tChecklist" placeholder="e.g.\nReconcile bank\nMatch invoices\nReview VAT">${esc((task?.checklist || []).map((i) => i.text).join('\n'))}</textarea></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">${editing ? 'Save' : 'Assign'}</button></div>`);
    const initialChecklist = (task?.checklist || []).map((i) => i.text).join('\n');
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const payload = { title: $('#tTitle').value, description: $('#tDesc').value, client_id: $('#tClient').value || null, assignee_id: Number($('#tAssignee').value), priority: $('#tPriority').value, due_date: $('#tDue').value };
      // Only send checklist on create, or on edit if it actually changed (avoids resetting tick state).
      if (!editing || $('#tChecklist').value !== initialChecklist) payload.checklist = $('#tChecklist').value;
      try {
        if (editing) await api.put(`/tasks/${task.id}`, payload); else await api.post('/tasks', payload);
        closeModal(); toast(editing ? 'Saved ✓' : 'Assigned ✓'); loadAllTasks(); loadMyTasks();
      } catch (e) { toast(e.message, true); }
    });
  }

  // ---------- Clients + Recurring schedules (admin) ----------
  VIEWS.clients = async () => {
    if (!isAdmin()) return navigate('dashboard');
    setMain('Clients', 'Your client list and the recurring work scheduled for each.',
      `<div id="pendingClients"></div>
       <div class="toolbar"><div style="display:flex;gap:10px;align-items:center;">
           <h2 style="margin:0;color:var(--navy);">Clients</h2>
           <select id="clientFilter" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;"></select>
         </div><button class="btn btn-primary" id="addClientBtn">+ Add client</button></div>
       <div id="clientTable" style="margin-bottom:30px;"></div>
       <div class="toolbar"><h2 style="margin:0;color:var(--navy);">Invoices</h2><button class="btn btn-primary" id="addInvoiceBtn">+ New invoice</button></div>
       <div id="invoiceTable" style="margin-bottom:30px;"></div>
       <div class="toolbar"><h2 style="margin:0;color:var(--navy);">Recurring schedules</h2>
         <div class="row-actions"><button class="btn btn-ghost" id="runRecBtn">Generate due now</button><button class="btn btn-primary" id="addRecBtn">+ New schedule</button></div></div>
       <div id="recTable"></div>`);
    await loadLookups();
    $('#addClientBtn').addEventListener('click', () => openClientModal());
    $('#clientFilter').addEventListener('change', (e) => { clientGroupFilter = e.target.value; loadClients(); });
    $('#addInvoiceBtn').addEventListener('click', () => openInvoiceModal());
    $('#addRecBtn').addEventListener('click', () => openRecurringModal());
    $('#runRecBtn').addEventListener('click', async () => {
      try { const r = await api.post('/recurring/run'); toast(`Generated ${r.created} task(s)`); loadRecurring(); } catch (e) { toast(e.message, true); }
    });
    loadInvoices();
    loadPendingClients();
    loadClients();
    loadRecurring();
  };

  // Admin: clients proposed by employees, awaiting approval.
  async function loadPendingClients() {
    const el = $('#pendingClients'); if (!el) return;
    try {
      const { clients } = await api.get('/clients/pending');
      if (!clients.length) { el.innerHTML = ''; return; }
      el.innerHTML = `<div class="section">
        <h2 style="color:var(--navy);">🕓 Client approvals (${clients.length})</h2>
        <table><thead><tr><th>Proposed client</th><th>Business type</th><th>Stage</th><th>Suggested by</th><th>Notes</th><th>Action</th></tr></thead><tbody>
        ${clients.map((c) => `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.business_type || '—')}</td><td>${stageBadge(c.stage)}</td>
          <td>${esc(c.created_by_name || '—')}</td><td>${esc(c.notes || '—')}</td>
          <td class="row-actions"><button class="btn btn-primary btn-sm" data-appr="${c.id}">Approve</button>
            <button class="btn btn-danger btn-sm" data-rej="${c.id}">Reject</button></td></tr>`).join('')}
        </tbody></table></div>`;
      el.querySelectorAll('[data-appr]').forEach((b) => b.addEventListener('click', () => decideClient(b.dataset.appr, 'APPROVED')));
      el.querySelectorAll('[data-rej]').forEach((b) => b.addEventListener('click', () => decideClient(b.dataset.rej, 'REJECTED')));
    } catch (e) { toast(e.message, true); }
  }
  async function decideClient(id, decision) {
    try {
      await api.post(`/clients/${id}/approval`, { decision });
      toast(decision === 'APPROVED' ? 'Client approved ✓' : 'Rejected');
      loadPendingClients(); loadClients(); loadLookups();
    } catch (e) { toast(e.message, true); }
  }

  const STAGE_LABEL = { PROSPECT: 'Prospect', INTERVIEWED: 'Interviewed – not signed', SIGNED: 'Signed' };
  const STAGE_CLASS = { PROSPECT: 'b-todo', INTERVIEWED: 'b-pending', SIGNED: 'b-done' };
  const stageBadge = (s) => `<span class="badge ${STAGE_CLASS[s] || 'b-todo'}">${esc(STAGE_LABEL[s] || cap(s || 'Prospect'))}</span>`;

  const CURRENCY = '$';
  const fmtMoney = (n) => CURRENCY + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let ALL_CLIENTS = []; // cached for the parent-client picker
  let clientGroupFilter = ''; // '' = all; otherwise a parent id (show it + its files)
  async function loadClients() {
    try {
      const [{ clients }, invSummary] = await Promise.all([api.get('/clients/all'), api.get('/invoices/summary/totals')]);
      ALL_CLIENTS = clients;
      // Rolled-up income per client: a parent includes its files' invoiced totals.
      const raw = invSummary.totals || {};
      const income = {};
      clients.forEach((c) => { income[c.id] = (raw[c.id]?.invoiced || 0); });
      clients.forEach((c) => { if (c.parent_id && raw[c.id]) income[c.parent_id] = (income[c.parent_id] || 0) + (raw[c.id].invoiced || 0); });
      // Filter dropdown: top-level clients (the ones that can hold files).
      const filterEl = $('#clientFilter');
      if (filterEl) {
        const parents = clients.filter((c) => !c.parent_id);
        filterEl.innerHTML = `<option value="">All clients</option>` + parents.map((p) => `<option value="${p.id}" ${clientGroupFilter == p.id ? 'selected' : ''}>${esc(p.name)} + files</option>`).join('');
        filterEl.value = clientGroupFilter;
      }
      const shown = clientGroupFilter
        ? clients.filter((c) => c.id == clientGroupFilter || c.parent_id == clientGroupFilter)
        : clients;
      const el = $('#clientTable');
      el.innerHTML = shown.length ? `<table><thead><tr><th>Client</th><th>Parent</th><th>Business type</th><th>Stage</th><th>Income</th><th>Active</th><th></th></tr></thead><tbody>
        ${shown.map((c) => `<tr style="${c.active ? '' : 'opacity:.5'}"><td>${c.parent_name ? '<span style="color:var(--slate)">↳ </span>' : ''}<strong>${esc(c.name)}</strong>${c.approval === 'PENDING' ? ' <span class="badge b-pending" style="font-size:.66rem">Pending</span>' : c.approval === 'REJECTED' ? ' <span class="badge b-rejected" style="font-size:.66rem">Rejected</span>' : ''}</td>
          <td>${c.parent_name ? esc(c.parent_name) : '<span style="color:var(--slate)">—</span>'}</td>
          <td>${esc(c.business_type || '—')}</td><td>${stageBadge(c.stage)}</td>
          <td>${income[c.id] ? `<strong>${fmtMoney(income[c.id])}</strong>` : '<span style="color:var(--slate)">—</span>'}</td>
          <td>${c.active ? badge('approved') : badge('rejected')}</td>
          <td class="row-actions">
            <button class="btn btn-ghost btn-sm" data-invoice-client="${c.id}" title="Create an invoice for this client">+ Invoice</button>
            ${!c.parent_id && c.approval === 'APPROVED' ? `<button class="btn btn-ghost btn-sm" data-add-file="${c.id}" title="Add a file under this client">+ File</button>` : ''}
            <button class="btn btn-ghost btn-sm" data-edit-client="${c.id}">Edit</button>
            <button class="btn ${c.active ? 'btn-danger' : 'btn-primary'} btn-sm" data-toggle-client="${c.id}" data-active="${c.active ? 0 : 1}">${c.active ? 'Archive' : 'Restore'}</button></td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No clients here.</div>`;
      const byId = {}; clients.forEach((c) => { byId[c.id] = c; });
      el.querySelectorAll('[data-invoice-client]').forEach((b) => b.addEventListener('click', () => openInvoiceModal(null, b.dataset.invoiceClient)));
      el.querySelectorAll('[data-add-file]').forEach((b) => b.addEventListener('click', () => openClientModal(null, b.dataset.addFile)));
      el.querySelectorAll('[data-edit-client]').forEach((b) => b.addEventListener('click', () => openClientModal(byId[b.dataset.editClient])));
      el.querySelectorAll('[data-toggle-client]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`/clients/${b.dataset.toggleClient}/active`, { active: Number(b.dataset.active) }); toast('Updated'); loadClients(); loadLookups(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }

  function openClientModal(c, presetParent) {
    const editing = !!c;
    const selParent = c?.parent_id ?? presetParent ?? '';
    const presetName = presetParent && ALL_CLIENTS.find((x) => x.id == presetParent)?.name;
    modal(`<h3>${editing ? 'Edit client' : presetName ? `Add file under ${esc(presetName)}` : 'Add client'}</h3>
      <div class="form-row"><div class="field"><label>Name</label><input id="cName" value="${esc(c?.name || '')}"></div>
        <div class="field"><label>Code</label><input id="cCode" value="${esc(c?.code || '')}" placeholder="e.g. TESH"></div></div>
      <div class="form-row"><div class="field"><label>Business type</label><input id="cBizType" value="${esc(c?.business_type || '')}" placeholder="e.g. Restaurant, E-commerce, Law firm"></div>
        <div class="field"><label>Stage</label><select id="cStage">${['PROSPECT', 'INTERVIEWED', 'SIGNED'].map((s) => `<option value="${s}" ${(c?.stage || 'PROSPECT') === s ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}</select></div></div>
      <div class="form-row one"><div class="field"><label>Parent client (optional — for a file under a CPA/parent)</label>
        <select id="cParent"><option value="">— Top-level client —</option>${ALL_CLIENTS.filter((x) => !x.parent_id && x.id !== c?.id).map((x) => `<option value="${x.id}" ${selParent == x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div></div>
      <div class="form-row one"><div class="field"><label>Billing address (used on invoices — one line each)</label><textarea id="cBilling" placeholder="Continuum Associates\nHudson County\nJersey City New Jersey\nUnited States (USA)">${esc(c?.billing_address || '')}</textarea></div></div>
      <div class="form-row one"><div class="field"><label>Notes</label><textarea id="cNotes">${esc(c?.notes || '')}</textarea></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">${editing ? 'Save' : 'Create'}</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const payload = { name: $('#cName').value, code: $('#cCode').value, business_type: $('#cBizType').value, stage: $('#cStage').value, notes: $('#cNotes').value, parent_id: $('#cParent').value || null, billing_address: $('#cBilling').value };
      try {
        if (editing) await api.put(`/clients/${c.id}`, payload); else await api.post('/clients', payload);
        closeModal(); toast(editing ? 'Saved ✓' : 'Created ✓'); loadClients(); loadLookups();
      } catch (e) { toast(e.message, true); }
    });
  }

  // ---------- Invoices (admin) ----------
  async function loadInvoices() {
    const el = $('#invoiceTable'); if (!el) return;
    try {
      const { invoices } = await api.get('/invoices');
      const total = invoices.reduce((s, i) => s + (i.amount || 0), 0);
      const paid = invoices.filter((i) => i.status === 'PAID').reduce((s, i) => s + (i.amount || 0), 0);
      el.innerHTML = invoices.length ? `<p class="page-sub" style="margin:0 0 10px;">Total invoiced <strong>${fmtMoney(total)}</strong> · Paid <strong style="color:var(--teal-dark)">${fmtMoney(paid)}</strong> · Outstanding <strong>${fmtMoney(total - paid)}</strong></p>
        <table><thead><tr><th>Client</th><th>Invoice #</th><th>Date</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
        ${invoices.map((i) => `<tr><td><strong>${esc(i.client_parent_name ? i.client_parent_name + ' › ' + i.client_name : i.client_name)}</strong></td>
          <td>${esc(i.number || '—')}</td><td>${i.invoice_date ? fmtDate(i.invoice_date) : '—'}</td>
          <td><strong>${money(i.amount, i.currency)}</strong></td>
          <td>${i.status === 'PAID' ? '<span class="badge b-done">Paid</span>' : '<span class="badge b-pending">Unpaid</span>'}</td>
          <td class="row-actions">
            <button class="btn btn-navy btn-sm" data-inv-pdf="${i.id}">PDF</button>
            <button class="btn btn-ghost btn-sm" data-inv-toggle="${i.id}" data-paid="${i.status === 'PAID' ? 0 : 1}">${i.status === 'PAID' ? 'Mark unpaid' : 'Mark paid'}</button>
            <button class="btn btn-ghost btn-sm" data-inv-edit="${i.id}">Edit</button>
            <button class="btn btn-danger btn-sm" data-inv-del="${i.id}">✕</button></td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No invoices yet. Use “+ New invoice” or “+ Invoice” on a client row.</div>`;
      const byId = {}; invoices.forEach((i) => { byId[i.id] = i; });
      el.querySelectorAll('[data-inv-pdf]').forEach((b) => b.addEventListener('click', () => openInvoicePdf(b.dataset.invPdf)));
      el.querySelectorAll('[data-inv-toggle]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`/invoices/${b.dataset.invToggle}/status`, { status: Number(b.dataset.paid) ? 'PAID' : 'UNPAID' }); toast('Updated'); loadInvoices(); loadClients(); } catch (e) { toast(e.message, true); }
      }));
      el.querySelectorAll('[data-inv-edit]').forEach((b) => b.addEventListener('click', async () => {
        try { const { invoice } = await api.get(`/invoices/${b.dataset.invEdit}`); openInvoiceModal(invoice); } catch (e) { toast(e.message, true); }
      }));
      el.querySelectorAll('[data-inv-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this invoice?')) return;
        try { await api.del(`/invoices/${b.dataset.invDel}`); toast('Deleted'); loadInvoices(); loadClients(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }

  // Your firm's details for the "Billed By" block on the PDF. Edit here.
  const BILL_FROM = { name: 'LIT Nexus LLP', lines: ['Mohali,', 'India'], email: 'litnexusllp@gmail.com', phone: '+91 98140 11601' };
  const curSym = (cur) => ({ USD: '$', INR: '₹', GBP: '£', EUR: '€', CAD: 'C$', AUD: 'A$' }[cur] || (cur ? cur + ' ' : '$'));
  const money = (n, cur) => curSym(cur) + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const billToFor = (c) => c ? [c.name, c.billing_address || ''].filter(Boolean).join('\n') : '';

  function openInvoiceModal(inv, presetClient) {
    const editing = !!inv;
    const selClient = inv?.client_id ?? presetClient ?? '';
    let rows = (inv?.items && inv.items.length) ? inv.items.map((it) => ({ ...it })) : [{ item: '', description: '', quantity: 1, rate: 0 }];
    const initialBillTo = inv?.bill_to || billToFor(CLIENTS.find((c) => c.id == selClient));
    modal(`<h3>${editing ? 'Edit invoice' : 'New invoice'}</h3>
      <div class="form-row"><div class="field"><label>Client</label><select id="ivClient"><option value="">Select a client…</option>${CLIENTS.map((c) => `<option value="${c.id}" ${selClient == c.id ? 'selected' : ''}>${esc(clientPath(c))}</option>`).join('')}</select></div>
        <div class="field"><label>Invoice #</label><input id="ivNumber" value="${esc(inv?.number || '')}" placeholder="e.g. 106"></div></div>
      <div class="form-row"><div class="field"><label>Invoice date</label><input type="date" id="ivDate" value="${esc(inv?.invoice_date || todayISO())}"></div>
        <div class="field"><label>Due date</label><input type="date" id="ivDue" value="${esc(inv?.due_date || '')}"></div></div>
      <div class="form-row"><div class="field"><label>Currency</label><input id="ivCurrency" value="${esc(inv?.currency || 'USD')}" style="max-width:130px;text-transform:uppercase;"></div>
        <div class="field"><label>Status</label><select id="ivStatus"><option value="UNPAID" ${inv?.status !== 'PAID' ? 'selected' : ''}>Unpaid</option><option value="PAID" ${inv?.status === 'PAID' ? 'selected' : ''}>Paid</option></select></div></div>
      <div class="form-row one"><div class="field"><label>Billed to (client name + address, one line each)</label><textarea id="ivBillTo" placeholder="Client name\nAddress line">${esc(initialBillTo)}</textarea></div></div>
      <div class="field"><label>Line items</label><div id="ivItems"></div>
        <button class="btn btn-ghost btn-sm" id="ivAddItem" style="margin-top:6px;">+ Add item</button></div>
      <div style="text-align:right;margin-top:12px;font-weight:800;color:var(--navy);font-size:1.05rem;">Total: <span id="ivTotal">—</span></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">${editing ? 'Save' : 'Create invoice'}</button></div>`);

    const cur = () => $('#ivCurrency').value.toUpperCase() || 'USD';
    function updateTotal() {
      const total = rows.reduce((s, r) => s + (Number(r.quantity) || 0) * (Number(r.rate) || 0), 0);
      $('#ivTotal').textContent = money(total, cur());
    }
    function renderItems() {
      $('#ivItems').innerHTML = rows.map((r, idx) => `<div class="form-row" style="margin-bottom:6px;align-items:flex-start;gap:8px;">
        <div class="field" style="flex:2;"><input placeholder="Item (e.g. Bookkeeping)" data-ii="item" data-idx="${idx}" value="${esc(r.item)}"><textarea placeholder="Description (optional)" data-ii="description" data-idx="${idx}" style="margin-top:4px;min-height:40px;">${esc(r.description)}</textarea></div>
        <div class="field" style="flex:0 0 64px;"><input type="number" step="0.01" min="0" placeholder="Qty" data-ii="quantity" data-idx="${idx}" value="${r.quantity}"></div>
        <div class="field" style="flex:0 0 84px;"><input type="number" step="0.01" min="0" placeholder="Rate" data-ii="rate" data-idx="${idx}" value="${r.rate}"></div>
        <div class="field" style="flex:0 0 90px;padding-top:9px;text-align:right;font-weight:600;" data-amt="${idx}">${money((Number(r.quantity) || 0) * (Number(r.rate) || 0), cur())}</div>
        <div style="flex:0 0 auto;padding-top:5px;"><button class="btn btn-danger btn-sm" data-ii-del="${idx}">✕</button></div></div>`).join('');
      updateTotal();
      $('#ivItems').querySelectorAll('[data-ii]').forEach((inp) => inp.addEventListener('input', () => {
        const idx = Number(inp.dataset.idx), field = inp.dataset.ii;
        rows[idx][field] = (field === 'quantity' || field === 'rate') ? (Number(inp.value) || 0) : inp.value;
        if (field === 'quantity' || field === 'rate') {
          const cell = $('#ivItems').querySelector(`[data-amt="${idx}"]`);
          if (cell) cell.textContent = money((Number(rows[idx].quantity) || 0) * (Number(rows[idx].rate) || 0), cur());
          updateTotal();
        }
      }));
      $('#ivItems').querySelectorAll('[data-ii-del]').forEach((b) => b.addEventListener('click', () => { rows.splice(Number(b.dataset.iiDel), 1); if (!rows.length) rows = [{ item: '', description: '', quantity: 1, rate: 0 }]; renderItems(); }));
    }
    renderItems();
    $('#ivAddItem').addEventListener('click', () => { rows.push({ item: '', description: '', quantity: 1, rate: 0 }); renderItems(); });
    $('#ivCurrency').addEventListener('input', renderItems);
    $('#ivClient').addEventListener('change', (e) => {
      const c = CLIENTS.find((x) => x.id == e.target.value);
      if (c && !$('#ivBillTo').value.trim()) $('#ivBillTo').value = billToFor(c);
    });
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const items = rows.filter((r) => r.item || r.description || Number(r.quantity) || Number(r.rate));
      const total = items.reduce((s, r) => s + (Number(r.quantity) || 0) * (Number(r.rate) || 0), 0);
      if (!$('#ivClient').value) return toast('Please choose a client', true);
      if (!items.length || !(total > 0)) return toast('Add at least one line item with an amount', true);
      const payload = { client_id: $('#ivClient').value, number: $('#ivNumber').value, invoice_date: $('#ivDate').value, due_date: $('#ivDue').value, currency: cur(), bill_to: $('#ivBillTo').value, status: $('#ivStatus').value, items };
      try {
        if (editing) await api.put(`/invoices/${inv.id}`, payload); else await api.post('/invoices', payload);
        closeModal(); toast(editing ? 'Saved ✓' : 'Invoice created ✓'); loadInvoices(); loadClients();
      } catch (e) { toast(e.message, true); }
    });
  }

  // Build the Refrens-style invoice HTML and open the browser print dialog
  // (Save as PDF). No dependencies; renders same-origin so it stays within CSP.
  async function openInvoicePdf(id) {
    let inv;
    try { inv = (await api.get(`/invoices/${id}`)).invoice; } catch (e) { return toast(e.message, true); }
    const cur = inv.currency || 'USD';
    const P = '#5b4bb8'; // brand violet used in the reference invoice
    const clientTitle = inv.client_parent_name ? `${inv.client_parent_name} › ${inv.client_name}` : inv.client_name;
    const billTo = (inv.bill_to || clientTitle).split('\n').filter(Boolean);
    const items = inv.items || [];
    const rowsHtml = items.map((it, i) => `<tr style="background:${i % 2 ? '#f1eefb' : '#faf9fe'};">
        <td style="padding:14px 10px;vertical-align:top;color:#555;">${i + 1}.</td>
        <td style="padding:14px 10px;vertical-align:top;"><div style="font-weight:600;color:#222;">${escP(it.item)}</div>${it.description ? `<div style="color:#555;font-size:13px;margin-top:6px;white-space:pre-line;">${escP(it.description)}</div>` : ''}</td>
        <td style="padding:14px 10px;vertical-align:top;text-align:center;color:#333;">${it.quantity}</td>
        <td style="padding:14px 10px;vertical-align:top;text-align:right;color:#333;">${money(it.rate, cur)}</td>
        <td style="padding:14px 10px;vertical-align:top;text-align:right;color:#222;font-weight:600;">${money(it.quantity * it.rate, cur)}</td></tr>`).join('');
    const infoRow = (label, value) => `<tr><td style="padding:3px 24px 3px 0;color:#555;font-size:13px;">${label}</td><td style="padding:3px 0;font-weight:700;color:#222;">${escP(value || '—')}</td></tr>`;
    const box = (title, inner) => `<div style="flex:1;background:#f6f4fc;border-radius:10px;padding:18px 20px;">
        <div style="color:${P};font-size:20px;font-weight:700;margin-bottom:8px;">${title}</div>${inner}</div>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${escP(inv.number || inv.id)}</title>
      <style>@page{margin:0} body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#222;-webkit-print-color-adjust:exact;print-color-adjust:exact;}</style></head>
      <body><div style="max-width:820px;margin:0 auto;padding:44px 44px 24px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div style="color:${P};font-size:40px;font-weight:700;">Invoice</div>
          <img src="/img/lit-logo-color.png" style="height:52px;width:auto;" alt="LIT Nexus"/>
        </div>
        <table style="margin-top:18px;border-collapse:collapse;">
          ${infoRow('Invoice No #', inv.number || String(inv.id))}
          ${infoRow('Invoice Date', inv.invoice_date ? fmtDate(inv.invoice_date) : '—')}
          ${inv.due_date ? infoRow('Due Date', fmtDate(inv.due_date)) : ''}
        </table>
        <div style="display:flex;gap:20px;margin-top:26px;">
          ${box('Billed By', `<div style="font-weight:700;">${escP(BILL_FROM.name)}</div>${BILL_FROM.lines.map((l) => `<div style="color:#333;">${escP(l)}</div>`).join('')}<div style="margin-top:6px;"><strong>Email:</strong> ${escP(BILL_FROM.email)}</div><div><strong>Phone:</strong> ${escP(BILL_FROM.phone)}</div>`)}
          ${box('Billed To', `<div style="font-weight:700;">${escP(billTo[0] || '')}</div>${billTo.slice(1).map((l) => `<div style="color:#333;">${escP(l)}</div>`).join('')}`)}
        </div>
        <table style="width:100%;border-collapse:collapse;margin-top:28px;font-size:14px;">
          <thead><tr style="background:${P};color:#fff;">
            <th style="padding:12px 10px;text-align:left;width:34px;"></th>
            <th style="padding:12px 10px;text-align:left;">Item</th>
            <th style="padding:12px 10px;text-align:center;">Quantity</th>
            <th style="padding:12px 10px;text-align:right;">Rate</th>
            <th style="padding:12px 10px;text-align:right;">Amount</th></tr></thead>
          <tbody>${rowsHtml}</tbody></table>
        <div style="display:flex;justify-content:flex-end;margin-top:24px;">
          <table style="border-collapse:collapse;min-width:300px;border-top:2px solid #333;border-bottom:2px solid #333;">
            <tr><td style="padding:14px 16px;font-weight:700;font-size:17px;">Total (${escP(cur)})</td>
                <td style="padding:14px 16px;text-align:right;font-weight:800;font-size:19px;">${money(inv.amount, cur)}</td></tr></table>
        </div>
        <div style="text-align:center;color:#555;margin-top:40px;font-size:14px;">For any enquiry, reach out via email at <strong>${escP(BILL_FROM.email)}</strong>, call on <strong>${escP(BILL_FROM.phone)}</strong></div>
        <div style="color:#999;font-size:11px;margin-top:60px;">This is an electronically generated document, no signature is required.</div>
      </div></body></html>`;
    const img = new Image(); img.src = '/img/lit-logo-color.png'; // warm the cache
    const w = window.open('', '_blank');
    if (!w) return toast('Allow pop-ups to generate the PDF', true);
    w.document.write(html); w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch (_e) {} }, 500);
  }
  // Escape for the PDF window (own helper so it doesn't depend on esc()).
  function escP(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  const FREQ_LABEL = { WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', YEARLY: 'Yearly' };
  async function loadRecurring() {
    try {
      const { recurring } = await api.get('/recurring');
      const el = $('#recTable');
      el.innerHTML = recurring.length ? `<table><thead><tr><th>Task</th><th>Client</th><th>Assignee</th><th>Every</th><th>Next due</th><th>Status</th><th></th></tr></thead><tbody>
        ${recurring.map((r) => `<tr style="${r.active ? '' : 'opacity:.5'}"><td><strong>${esc(r.title)}</strong></td><td>${esc(r.client_name || '—')}</td>
          <td>${esc(r.assignee_name)}</td><td>${r.step > 1 ? r.step + ' × ' : ''}${FREQ_LABEL[r.frequency]}</td><td>${fmtDate(r.next_due)}</td>
          <td>${r.active ? badge('approved') : badge('cancelled')}</td>
          <td class="row-actions"><button class="btn btn-ghost btn-sm" data-edit-rec="${r.id}">Edit</button>
            <button class="btn btn-ghost btn-sm" data-toggle-rec="${r.id}" data-active="${r.active ? 0 : 1}">${r.active ? 'Pause' : 'Resume'}</button>
            <button class="btn btn-danger btn-sm" data-del-rec="${r.id}">✕</button></td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No recurring schedules. Add one to auto-create tasks each period.</div>`;
      const byId = {}; recurring.forEach((r) => { byId[r.id] = r; });
      el.querySelectorAll('[data-edit-rec]').forEach((b) => b.addEventListener('click', () => openRecurringModal(byId[b.dataset.editRec])));
      el.querySelectorAll('[data-toggle-rec]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`/recurring/${b.dataset.toggleRec}/active`, { active: Number(b.dataset.active) }); toast('Updated'); loadRecurring(); } catch (e) { toast(e.message, true); }
      }));
      el.querySelectorAll('[data-del-rec]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Delete this schedule? Already-created tasks are kept.')) return;
        try { await api.del(`/recurring/${b.dataset.delRec}`); toast('Deleted'); loadRecurring(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }

  function openRecurringModal(r) {
    const editing = !!r;
    modal(`<h3>${editing ? 'Edit schedule' : 'New recurring schedule'}</h3>
      <div class="form-row one"><div class="field"><label>Task title</label><input id="rTitle" value="${esc(r?.title || '')}" placeholder="e.g. Monthly bookkeeping"></div></div>
      <div class="form-row one"><div class="field"><label>Description</label><textarea id="rDesc">${esc(r?.description || '')}</textarea></div></div>
      <div class="form-row"><div class="field"><label>Client</label><select id="rClient">${clientOptions(r?.client_id)}</select></div>
        <div class="field"><label>Assignee</label><select id="rAssignee">${userOptions(r?.assignee_id)}</select></div></div>
      <div class="form-row"><div class="field"><label>Repeats</label><select id="rFreq">${Object.keys(FREQ_LABEL).map((f) => `<option value="${f}" ${(r?.frequency || 'MONTHLY') === f ? 'selected' : ''}>${FREQ_LABEL[f]}</option>`).join('')}</select></div>
        <div class="field"><label>Priority</label><select id="rPriority">${['LOW', 'MEDIUM', 'HIGH'].map((p) => `<option value="${p}" ${(r?.priority || 'MEDIUM') === p ? 'selected' : ''}>${cap(p)}</option>`).join('')}</select></div></div>
      <div class="form-row"><div class="field"><label>First due date</label><input type="date" id="rNext" value="${esc(r?.next_due || todayISO())}"></div>
        <div class="field"><label>Create how many days early?</label><input type="number" id="rLead" min="0" value="${r?.lead_days ?? 7}"></div></div>
      <div class="form-row one"><div class="field"><label>Checklist — one item per line (copied onto each task)</label><textarea id="rChecklist" placeholder="e.g.\nReconcile bank\nMatch invoices\nReview VAT">${esc(parseChecklistJson(r?.checklist_json))}</textarea></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">${editing ? 'Save' : 'Create schedule'}</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const payload = { title: $('#rTitle').value, description: $('#rDesc').value, client_id: $('#rClient').value || null, assignee_id: Number($('#rAssignee').value),
        frequency: $('#rFreq').value, priority: $('#rPriority').value, next_due: $('#rNext').value, lead_days: Number($('#rLead').value), step: 1, checklist: $('#rChecklist').value };
      try {
        if (editing) await api.put(`/recurring/${r.id}`, payload); else await api.post('/recurring', payload);
        closeModal(); toast(editing ? 'Saved ✓' : 'Schedule created ✓'); loadRecurring();
      } catch (e) { toast(e.message, true); }
    });
  }

  // ---------- Achievements ----------
  const thisMonthISO = () => todayISO().slice(0, 7);

  VIEWS.achievements = async () => {
    setMain('Achievements', 'Log your wins — daily, weekly, or monthly. Acknowledged achievements earn points that count toward bonuses.',
      `<div class="toolbar"><h2 style="margin:0;color:var(--navy);">My achievements</h2>
         <button class="btn btn-primary" id="logAchBtn">+ Log achievement</button></div>
       <div id="myAch"></div>
       <div class="admin-only section" style="margin-top:30px;">
         <div class="toolbar"><h2 style="margin:0;color:var(--navy);">Review (admin)</h2>
           <input type="month" id="achMonth" value="${thisMonthISO()}" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;"></div>
         <div id="reviewAch"></div>
       </div>`);
    $('#logAchBtn').addEventListener('click', openAchievementModal);
    loadMyAchievements();
    if (isAdmin()) {
      $('#achMonth').addEventListener('change', loadReviewAchievements);
      loadReviewAchievements();
    }
  };

  async function loadMyAchievements() {
    try {
      const { achievements } = await api.get('/achievements/mine');
      const el = $('#myAch'); if (!el) return;
      el.innerHTML = achievements.length ? `<table><thead><tr><th>Date</th><th>Achievement</th><th>Status</th><th>Points</th><th></th></tr></thead><tbody>
        ${achievements.map((a) => `<tr><td>${esc(a.date)}</td>
          <td><strong>${esc(a.title)}</strong>${a.description ? `<div style="color:var(--slate);font-size:.84rem;margin-top:3px;">${esc(a.description)}</div>` : ''}</td>
          <td>${badge(a.status)}</td><td>${a.status === 'ACKNOWLEDGED' ? `<strong>${a.points}</strong>` : '—'}</td>
          <td>${a.status === 'PENDING' ? `<button class="btn btn-ghost btn-sm" data-del-ach="${a.id}">Delete</button>` : ''}</td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">Nothing logged yet. Hit a milestone? Log it!</div>`;
      el.querySelectorAll('[data-del-ach]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.del(`/achievements/${b.dataset.delAch}`); toast('Deleted'); loadMyAchievements(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }

  function openAchievementModal() {
    modal(`<h3>Log achievement</h3>
      <div class="form-row"><div class="field"><label>Date</label><input type="date" id="aDate" value="${todayISO()}"></div><div class="field"></div></div>
      <div class="form-row one"><div class="field"><label>What did you achieve?</label><input id="aTitle" placeholder="e.g. Closed Teshera June books 3 days early"></div></div>
      <div class="form-row one"><div class="field"><label>Details (optional)</label><textarea id="aDesc" placeholder="Context, numbers, links…"></textarea></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">Log it</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      try {
        await api.post('/achievements', { date: $('#aDate').value, title: $('#aTitle').value, description: $('#aDesc').value });
        closeModal(); toast('Logged ✓'); loadMyAchievements();
        if (isAdmin() && $('#achMonth')) loadReviewAchievements();
      } catch (e) { toast(e.message, true); }
    });
  }

  async function loadReviewAchievements() {
    try {
      const m = $('#achMonth').value || thisMonthISO();
      const { achievements } = await api.get(`/achievements/month/${m}`);
      const el = $('#reviewAch'); if (!el) return;
      el.innerHTML = achievements.length ? `<table><thead><tr><th>Date</th><th>Employee</th><th>Achievement</th><th>Status</th><th>Points</th><th></th></tr></thead><tbody>
        ${achievements.map((a) => `<tr><td>${esc(a.date)}</td><td>${esc(a.name)}</td>
          <td><strong>${esc(a.title)}</strong>${a.description ? `<div style="color:var(--slate);font-size:.84rem;margin-top:3px;">${esc(a.description)}</div>` : ''}</td>
          <td>${badge(a.status)}</td>
          <td>${a.status === 'PENDING'
            ? `<input type="number" min="0" max="100" value="5" data-pts="${a.id}" style="width:64px;padding:6px;border:1px solid var(--line);border-radius:6px;">`
            : (a.status === 'ACKNOWLEDGED' ? `<strong>${a.points}</strong>` : '—')}</td>
          <td class="row-actions">${a.status === 'PENDING'
            ? `<button class="btn btn-primary btn-sm" data-ack="${a.id}">Award</button><button class="btn btn-danger btn-sm" data-decline="${a.id}">Decline</button>`
            : ''}</td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No achievements logged in this month.</div>`;
      el.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', async () => {
        const pts = Number(el.querySelector(`[data-pts="${b.dataset.ack}"]`)?.value || 0);
        try { await api.post(`/achievements/${b.dataset.ack}/review`, { status: 'ACKNOWLEDGED', points: pts }); toast(`Awarded ${pts} pts ✓`); loadReviewAchievements(); }
        catch (e) { toast(e.message, true); }
      }));
      el.querySelectorAll('[data-decline]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`/achievements/${b.dataset.decline}/review`, { status: 'DECLINED' }); toast('Declined'); loadReviewAchievements(); }
        catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }

  // ---------- KPIs (admin) ----------
  VIEWS.kpi = async () => {
    if (!isAdmin()) return navigate('dashboard');
    setMain('Monthly KPIs', 'Attendance, output, and achievement points per employee — your bonus worksheet.',
      `<div class="toolbar">
         <input type="month" id="kpiMonth" value="${thisMonthISO()}" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;">
         <button class="btn btn-ghost" id="kpiCsvBtn">Export CSV</button></div>
       <div id="kpiTable"></div>
       <p class="page-sub" style="margin-top:14px;">On-time % = tasks finished by their due date. Points come from acknowledged achievements (review them on the Achievements page). Hours exclude breaks; days a person forgot to clock out count only the recorded time.</p>`);
    $('#kpiMonth').addEventListener('change', loadKpi);
    $('#kpiCsvBtn').addEventListener('click', exportKpiCsv);
    loadKpi();
  };

  let KPI_ROWS = [];
  async function loadKpi() {
    try {
      const m = $('#kpiMonth').value || thisMonthISO();
      const { rows } = await api.get(`/kpi?month=${m}`);
      KPI_ROWS = rows;
      const el = $('#kpiTable'); if (!el) return;
      el.innerHTML = rows.length ? `<table><thead><tr>
          <th>Employee</th><th>Days</th><th>Hours</th><th>Tasks done</th><th>On-time</th><th>Open now</th><th>Leave days</th><th>Achievements</th><th>Points</th>
        </tr></thead><tbody>
        ${rows.map((r) => `<tr><td><strong>${esc(r.name)}</strong><div style="color:var(--slate);font-size:.78rem;">${esc(r.department || '')}</div></td>
          <td>${r.daysPresent}</td><td>${r.hoursWorked}</td><td>${r.tasksDone}</td>
          <td>${r.onTimePct === null ? '—' : r.onTimePct + '%'}</td><td>${r.openTasks}</td><td>${r.leaveDays}</td>
          <td>${r.achievementsAcknowledged}${r.achievementsPending ? ` <span class="badge b-pending" title="awaiting review">+${r.achievementsPending}</span>` : ''}</td>
          <td><strong>${r.points}</strong></td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No active employees.</div>`;
    } catch (e) { toast(e.message, true); }
  }

  function exportKpiCsv() {
    if (!KPI_ROWS.length) return toast('Nothing to export', true);
    const m = $('#kpiMonth').value || thisMonthISO();
    const head = ['Name', 'Department', 'Days Present', 'Hours Worked', 'Tasks Done', 'On-Time %', 'Open Tasks', 'Leave Days', 'Achievements', 'Pending Review', 'Points'];
    const lines = [head.join(',')].concat(KPI_ROWS.map((r) => [
      csvCell(r.name), csvCell(r.department || ''),
      r.daysPresent, r.hoursWorked, r.tasksDone, r.onTimePct === null ? '' : r.onTimePct,
      r.openTasks, r.leaveDays, r.achievementsAcknowledged, r.achievementsPending, r.points,
    ].join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `kpi-${m}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- Reports (admin) ----------
  const STATUS_CODE = { PRESENT: 'P', ABSENT: 'A', LEAVE: 'L', HALF: '½', HOLIDAY: 'H', WEEKEND: 'W', FUTURE: '·' };
  const startOfMonthISO = () => todayISO().slice(0, 8) + '01';

  VIEWS.reports = async () => {
    if (!isAdmin()) return navigate('dashboard');
    await loadLookups();
    setMain('Reports', 'Attendance reports for the team. Pick a person and dates, or view the whole-month register.',
      `<div class="section">
         <div class="toolbar"><h2 style="margin:0;color:var(--navy);">Attendance — by employee</h2>
           <button class="btn btn-ghost btn-sm" id="empCsvBtn">Export CSV</button></div>
         <div class="form-row" style="max-width:680px;">
           <div class="field"><label>Employee</label><select id="repUser">${userOptions(USERS[0] && USERS[0].id)}</select></div>
           <div class="field"><label>From</label><input type="date" id="repStart" value="${startOfMonthISO()}"></div>
         </div>
         <div class="form-row" style="max-width:680px;">
           <div class="field"><label>To</label><input type="date" id="repEnd" value="${todayISO()}"></div>
           <div class="field" style="display:flex;align-items:flex-end;"><button class="btn btn-primary" id="repRun" style="width:100%;">Run report</button></div>
         </div>
         <div id="repTotals" style="margin:14px 0;"></div>
         <div id="repTable"></div>
       </div>
       <div class="section" style="margin-top:34px;">
         <div class="toolbar"><h2 style="margin:0;color:var(--navy);">Monthly attendance register</h2>
           <div class="row-actions"><input type="month" id="regMonth" value="${thisMonthISO()}" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;">
             <button class="btn btn-ghost btn-sm" id="regCsvBtn">Export CSV</button></div></div>
         <div class="row-actions" style="margin-bottom:10px;align-items:center;flex-wrap:wrap;">
           <span style="font-size:.84rem;color:var(--slate);">Working weekend (e.g. 1st Saturday):</span>
           <input type="date" id="wdDate" style="padding:7px 9px;border:1px solid var(--line);border-radius:8px;">
           <button class="btn btn-ghost btn-sm" id="wdAdd">Mark as working day</button>
           <span id="wdList" style="display:flex;gap:6px;flex-wrap:wrap;"></span>
         </div>
         <p class="page-sub" style="margin:0 0 12px;">P = present · L = leave · ½ = half day · H = holiday · W = weekend · A = absent · · = upcoming</p>
         <div id="regGrid" style="overflow-x:auto;"></div>
       </div>`);
    $('#repRun').addEventListener('click', loadEmpReport);
    $('#empCsvBtn').addEventListener('click', exportEmpCsv);
    $('#regMonth').addEventListener('change', loadRegister);
    $('#regCsvBtn').addEventListener('click', exportRegisterCsv);
    $('#wdAdd').addEventListener('click', addWorkingDay);
    loadEmpReport();
    loadRegister();
  };

  let EMP_REPORT = null;
  async function loadEmpReport() {
    try {
      const uid = $('#repUser').value, start = $('#repStart').value, end = $('#repEnd').value;
      const data = await api.get(`/reports/attendance?user_id=${uid}&start=${start}&end=${end}`);
      EMP_REPORT = data;
      const t = data.totals;
      $('#repTotals').innerHTML = `<div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr));">
        ${statCard('Present', t.present, 'value small')}${statCard('Leave', t.leave, 'value small')}
        ${statCard('Absent', t.absent, 'value small')}${statCard('Holidays', t.holiday, 'value small')}
        ${statCard('Hours worked', fmtMins(t.workedMinutes), 'value small')}</div>`;
      $('#repTable').innerHTML = `<table><thead><tr><th>Date</th><th>Day</th><th>Status</th><th>First In</th><th>Last Out</th><th>Worked</th><th>Break</th><th></th></tr></thead><tbody>
        ${data.rows.map((r) => `<tr><td>${esc(r.day)}</td><td>${esc(r.weekday)}</td>
          <td>${badge(r.status)}${r.holidayName ? ` <span style="color:var(--slate);font-size:.8rem;">${esc(r.holidayName)}</span>` : ''}</td>
          <td>${r.firstIn ? new Date(r.firstIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
          <td>${r.lastOut ? new Date(r.lastOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
          <td>${r.workedMinutes ? fmtMins(r.workedMinutes) : '—'}</td><td>${r.breakMinutes ? fmtMins(r.breakMinutes) : '—'}</td>
          <td>${r.status === 'FUTURE' ? '' : `<button class="btn btn-ghost btn-sm" data-fix-day="${r.day}">Fix</button>`}</td></tr>`).join('')}
      </tbody></table>`;
      $('#repTable').querySelectorAll('[data-fix-day]').forEach((b) =>
        b.addEventListener('click', () => openAttendanceEditor(data.user.id, b.dataset.fixDay)));
    } catch (e) { toast(e.message, true); }
  }

  // Admin modal to add/edit/delete an employee's punches for one day.
  async function openAttendanceEditor(userId, day) {
    modal(`<h3>Fix attendance</h3><div id="fixBody">Loading…</div>`);
    renderAttendanceEditor(userId, day);
  }

  async function renderAttendanceEditor(userId, day) {
    let data;
    try { data = await api.get(`/attendance/admin/day?user_id=${userId}&day=${day}`); }
    catch (e) { return toast(e.message, true); }
    const typeOpts = (sel) => ['IN', 'OUT', 'BREAK_START', 'BREAK_END']
      .map((t) => `<option value="${t}" ${t === sel ? 'selected' : ''}>${cap(t.replace('_', ' '))}</option>`).join('');
    const body = $('#fixBody'); if (!body) return;
    body.innerHTML = `
      <p style="color:var(--slate);margin:0 0 14px;"><strong>${esc(data.user.name)}</strong> · ${esc(day)} · Worked ${fmtMins(data.workedMinutes)} · now <strong>${cap(data.state)}</strong></p>
      ${data.events.length ? `<table style="margin-bottom:14px;"><thead><tr><th>Punch</th><th>Time</th><th></th></tr></thead><tbody>
        ${data.events.map((e) => `<tr>
          <td><select data-etype="${e.id}">${typeOpts(e.type)}</select></td>
          <td><input type="time" data-etime="${e.id}" value="${esc(e.time)}" style="padding:6px;border:1px solid var(--line);border-radius:6px;"></td>
          <td class="row-actions"><button class="btn btn-primary btn-sm" data-esave="${e.id}">Save</button><button class="btn btn-danger btn-sm" data-edel="${e.id}">✕</button></td>
        </tr>`).join('')}
      </tbody></table>` : `<div class="empty" style="margin-bottom:14px;">No punches recorded for this day.</div>`}
      <div class="field" style="margin-bottom:6px;"><label>Add a punch</label></div>
      <div class="form-row" style="margin-bottom:0;">
        <div class="field"><select id="newType">${typeOpts('IN')}</select></div>
        <div class="field" style="display:flex;gap:8px;"><input type="time" id="newTime" style="flex:1;padding:8px;border:1px solid var(--line);border-radius:8px;"><button class="btn btn-navy btn-sm" id="addPunch">Add</button></div>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" id="fixDone">Done</button></div>`;

    body.querySelectorAll('[data-esave]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.esave;
      try {
        await api.put(`/attendance/admin/event/${id}`, { type: body.querySelector(`[data-etype="${id}"]`).value, time: body.querySelector(`[data-etime="${id}"]`).value });
        toast('Saved ✓'); renderAttendanceEditor(userId, day);
      } catch (e) { toast(e.message, true); }
    }));
    body.querySelectorAll('[data-edel]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.del(`/attendance/admin/event/${b.dataset.edel}`); toast('Deleted'); renderAttendanceEditor(userId, day); }
      catch (e) { toast(e.message, true); }
    }));
    $('#addPunch').addEventListener('click', async () => {
      const time = $('#newTime').value;
      if (!time) return toast('Pick a time', true);
      try { await api.post('/attendance/admin/event', { user_id: userId, day, type: $('#newType').value, time }); toast('Added ✓'); renderAttendanceEditor(userId, day); }
      catch (e) { toast(e.message, true); }
    });
    $('#fixDone').addEventListener('click', () => { closeModal(); loadEmpReport(); loadRegister(); });
  }

  function exportEmpCsv() {
    if (!EMP_REPORT) return toast('Run a report first', true);
    const head = ['Date', 'Day', 'Status', 'First In', 'Last Out', 'Worked (min)', 'Break (min)'];
    const lines = [head.join(',')].concat(EMP_REPORT.rows.map((r) => [
      r.day, r.weekday, r.status,
      r.firstIn ? new Date(r.firstIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      r.lastOut ? new Date(r.lastOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '',
      r.workedMinutes, r.breakMinutes,
    ].join(',')));
    downloadCsv(lines.join('\n'), `attendance-${EMP_REPORT.user.name.replace(/\s+/g, '_')}-${EMP_REPORT.start}_to_${EMP_REPORT.end}.csv`);
  }

  let REGISTER = null;
  async function loadRegister() {
    try {
      const month = $('#regMonth').value || thisMonthISO();
      const data = await api.get(`/reports/register?month=${month}`);
      REGISTER = data;
      const workingSet = {}; (data.workingDays || []).forEach((w) => { workingSet[w.date] = true; });
      $('#regGrid').innerHTML = `<table style="min-width:max-content;"><thead><tr>
          <th style="position:sticky;left:0;background:var(--mist);">Employee</th>
          ${data.days.map((d) => { const wd = new Date(d + 'T00:00').getDay(); const wknd = (wd === 0 || wd === 6) && !workingSet[d]; return `<th style="text-align:center;padding:8px 6px;${wknd ? 'color:#b6c2cf;' : ''}${workingSet[d] ? 'color:var(--teal-dark);' : ''}">${d.slice(8)}</th>`; }).join('')}
          <th style="text-align:center;">P</th><th style="text-align:center;">L</th><th style="text-align:center;">A</th></tr></thead><tbody>
        ${data.users.map((u) => `<tr>
          <td style="position:sticky;left:0;background:var(--white);font-weight:600;white-space:nowrap;">${esc(u.name)}</td>
          ${data.days.map((d) => { const s = u.cells[d]; return `<td style="text-align:center;padding:6px;${regCellStyle(s)}" title="${d}: ${cap(s)}">${STATUS_CODE[s] || ''}</td>`; }).join('')}
          <td style="text-align:center;font-weight:700;">${u.totals.present}</td><td style="text-align:center;">${u.totals.leave}</td><td style="text-align:center;color:var(--danger);">${u.totals.absent}</td></tr>`).join('')}
      </tbody></table>`;
      renderWorkingDays(data.workingDays || [], month);
    } catch (e) { toast(e.message, true); }
  }

  // First Saturday of a yyyy-mm month, as yyyy-mm-dd.
  function firstSaturday(month) {
    const d = new Date(month + '-01T00:00');
    d.setDate(1 + ((6 - d.getDay() + 7) % 7));
    return d.toLocaleDateString('en-CA');
  }
  function renderWorkingDays(list, month) {
    const date = $('#wdDate'); if (date) date.value = firstSaturday(month);
    const el = $('#wdList'); if (!el) return;
    el.innerHTML = list.map((w) => `<span class="badge b-present" style="display:inline-flex;gap:6px;align-items:center;">${esc(w.date)}
      <span data-wddel="${w.id}" title="remove" style="cursor:pointer;font-weight:700;">✕</span></span>`).join('');
    el.querySelectorAll('[data-wddel]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.del(`/workingdays/${b.dataset.wddel}`); toast('Removed'); loadRegister(); loadEmpReport(); } catch (e) { toast(e.message, true); }
    }));
  }
  async function addWorkingDay() {
    const date = $('#wdDate').value;
    if (!date) return toast('Pick a date', true);
    try { await api.post('/workingdays', { date }); toast('Marked as working day ✓'); loadRegister(); loadEmpReport(); }
    catch (e) { toast(e.message, true); }
  }

  function regCellStyle(status) {
    const map = {
      PRESENT: 'background:#dff5ee;color:var(--teal-dark);font-weight:700;',
      ABSENT: 'background:#fdecea;color:var(--danger);font-weight:700;',
      LEAVE: 'background:#fdf1d8;color:#9a6b00;', HALF: 'background:#fdf1d8;color:#9a6b00;',
      HOLIDAY: 'background:#e3eefb;color:var(--info);', WEEKEND: 'background:var(--mist);color:#b6c2cf;',
      FUTURE: 'color:#cdd7e1;',
    };
    return map[status] || '';
  }

  function exportRegisterCsv() {
    if (!REGISTER) return toast('Nothing to export', true);
    const head = ['Employee', 'Department'].concat(REGISTER.days.map((d) => d.slice(8))).concat(['Present', 'Leave', 'Absent']);
    const lines = [head.join(',')].concat(REGISTER.users.map((u) => [
      csvCell(u.name), csvCell(u.department || ''),
    ].concat(REGISTER.days.map((d) => STATUS_CODE[u.cells[d]] || '')).concat([u.totals.present, u.totals.leave, u.totals.absent]).join(',')));
    downloadCsv(lines.join('\n'), `attendance-register-${REGISTER.month}.csv`);
  }

  // Quote a CSV field and neutralise formula injection: a leading =,+,-,@ (or
  // tab/CR) makes Excel/Sheets treat the cell as a formula, so prefix a quote.
  function csvCell(v) {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  }

  function downloadCsv(text, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = filename; a.click(); URL.revokeObjectURL(a.href);
  }

  // ---------- Calendar / Holidays ----------
  let calMonth = new Date().getMonth(), calYear = new Date().getFullYear();
  VIEWS.calendar = async () => {
    setMain('Holiday Calendar', 'Company holidays for the year.',
      `<div class="admin-only toolbar"><div></div><button class="btn btn-primary" id="addHolidayBtn">+ Add holiday</button></div>
       <div id="calBox"></div>
       <div class="section" style="margin-top:24px;"><h2>All holidays</h2><div id="holidayList"></div></div>`);
    if (isAdmin()) $('#addHolidayBtn').addEventListener('click', openHolidayModal);
    await loadHolidays();
  };

  let HOLIDAYS = [];
  async function loadHolidays() {
    try { HOLIDAYS = (await api.get('/holidays')).holidays; } catch (e) { return toast(e.message, true); }
    renderCalendar();
    const el = $('#holidayList');
    el.innerHTML = HOLIDAYS.length ? `<table><thead><tr><th>Date</th><th>Holiday</th><th>Type</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
      ${HOLIDAYS.map((h) => `<tr><td>${fmtDate(h.date)} <span style="color:var(--slate)">(${new Date(h.date + 'T00:00').toLocaleDateString(undefined, { weekday: 'short' })})</span></td>
        <td>${esc(h.name)}</td><td>${badge(h.type)}</td>${isAdmin() ? `<td><button class="btn btn-danger btn-sm" data-del-hol="${h.id}">✕</button></td>` : ''}</tr>`).join('')}
    </tbody></table>` : `<div class="empty">No holidays published yet.</div>`;
    el.querySelectorAll('[data-del-hol]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.del(`/holidays/${b.dataset.delHol}`); toast('Removed'); loadHolidays(); } catch (e) { toast(e.message, true); }
    }));
  }

  function renderCalendar() {
    const map = {}; HOLIDAYS.forEach((h) => { map[h.date] = h; });
    const first = new Date(calYear, calMonth, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const monthName = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const today = todayISO();
    let cells = '';
    for (let i = 0; i < startDow; i++) cells += `<div class="cal-cell muted"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const h = map[iso];
      cells += `<div class="cal-cell ${iso === today ? 'today' : ''} ${h ? 'holiday' : ''}"><div class="dn">${d}</div>${h ? `<div class="hn">${esc(h.name)}</div>` : ''}</div>`;
    }
    $('#calBox').innerHTML = `<div class="cal"><div class="cal-head">
      <button class="btn btn-ghost btn-sm" id="calPrev">‹</button><strong style="color:var(--navy)">${monthName}</strong><button class="btn btn-ghost btn-sm" id="calNext">›</button></div>
      <div class="cal-grid">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}${cells}</div></div>`;
    $('#calPrev').addEventListener('click', () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); });
    $('#calNext').addEventListener('click', () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); });
  }

  function openHolidayModal() {
    modal(`<h3>Add holiday</h3>
      <div class="form-row"><div class="field"><label>Date</label><input type="date" id="hDate" value="${todayISO()}"></div>
        <div class="field"><label>Type</label><select id="hType"><option>PUBLIC</option><option>OPTIONAL</option><option>COMPANY</option></select></div></div>
      <div class="form-row one"><div class="field"><label>Name</label><input id="hName" placeholder="e.g. Diwali"></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">Publish</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      try { await api.post('/holidays', { date: $('#hDate').value, name: $('#hName').value, type: $('#hType').value }); closeModal(); toast('Published ✓'); loadHolidays(); }
      catch (e) { toast(e.message, true); }
    });
  }

  // ---------- Directory ----------
  VIEWS.directory = async () => {
    setMain('Employee Directory', 'Everyone at LIT Nexus.', `<div class="people-grid" id="people"></div>`);
    try {
      const { users } = await api.get('/users');
      $('#people').innerHTML = users.map((u) => `<div class="person">
        <div class="avatar">${esc(initials(u.name))}</div>
        <div><div class="nm">${esc(u.name)}${u.role === 'ADMIN' ? ' <span class="badge b-company" style="font-size:.66rem">Admin</span>' : ''}</div>
          <div class="tt">${esc(u.title || '—')}${u.department ? ' · ' + esc(u.department) : ''}</div>
          ${u.emp_code ? `<div class="tt" style="font-size:.78rem;">Code: <strong>${esc(u.emp_code)}</strong></div>` : ''}
          <div class="ct">${esc(u.email)}</div>${u.phone ? `<div class="ct">${esc(u.phone)}</div>` : ''}</div></div>`).join('');
    } catch (e) { toast(e.message, true); }
  };

  // ---------- Admin (people management) ----------
  VIEWS.admin = async () => {
    if (!isAdmin()) return navigate('dashboard');
    setMain('Admin', 'Manage employees and access.',
      `<div class="toolbar"><h2 style="margin:0;color:var(--navy);">Employees</h2><button class="btn btn-primary" id="addEmpBtn">+ Add employee</button></div>
       <div id="empTable"></div>
       <div class="section" style="margin-top:30px;">
         <h2 style="color:var(--navy);">Data &amp; backup</h2>
         <div class="card" style="max-width:640px;">
           <p style="margin:0 0 12px;color:var(--slate);font-size:.9rem;">Download a complete snapshot of everything — employees, attendance, leaves, tasks, clients, and invoices — as a single database file you can keep on your computer.</p>
           <button class="btn btn-primary" id="backupBtn">⬇ Download backup (.db)</button>
         </div>
       </div>
       <div class="section" style="margin-top:30px;">
         <h2 style="color:var(--navy);">Daily Slack summary</h2>
         <div class="card" style="max-width:640px;">
           <p style="margin:0 0 12px;color:var(--slate);font-size:.9rem;">Posts everyone's worked hours &amp; break to Slack automatically each day at 3 AM. Preview what it will say, or send a test now.</p>
           <div class="row-actions"><button class="btn btn-ghost" id="slackPreviewBtn">Preview</button><button class="btn btn-primary" id="slackSendBtn">Send test to Slack</button></div>
           <pre id="slackPreview" style="display:none;white-space:pre-wrap;background:var(--mist);border:1px solid var(--line);border-radius:8px;padding:12px;margin-top:12px;font-size:.85rem;"></pre>
         </div>
       </div>
       <div class="section" style="margin-top:30px;">
         <h2 style="color:var(--navy);">Slack direct messages (DMs)</h2>
         <div class="card" style="max-width:640px;">
           <p style="margin:0 0 12px;color:var(--slate);font-size:.9rem;">Sends leave decisions, task assignments, punch approvals and announcements to each person's Slack as a private message. Click test to send yourself a DM and check the connection.</p>
           <button class="btn btn-primary" id="slackDmTestBtn">Test Slack DM connection</button>
           <div id="slackDmResult" style="display:none;margin-top:12px;border-radius:8px;padding:12px;font-size:.88rem;line-height:1.5;"></div>
         </div>
       </div>`);
    $('#addEmpBtn').addEventListener('click', () => openEmployeeModal());
    $('#backupBtn').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = '/api/backup'; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
      toast('Backup downloading…');
    });
    $('#slackPreviewBtn').addEventListener('click', async () => {
      try {
        const r = await api.get('/slack/preview');
        const el = $('#slackPreview'); el.style.display = 'block';
        el.textContent = (r.configured ? '' : '⚠ SLACK_WEBHOOK_URL not set — the daily post is disabled until you add it in Railway.\n\n') + r.text;
      } catch (e) { toast(e.message, true); }
    });
    $('#slackSendBtn').addEventListener('click', async () => {
      try { await api.post('/slack/send'); toast('Sent to Slack ✓'); } catch (e) { toast(e.message, true); }
    });
    $('#slackDmTestBtn').addEventListener('click', async () => {
      const box = $('#slackDmResult'); const btn = $('#slackDmTestBtn');
      btn.disabled = true; box.style.display = 'block'; box.style.background = 'var(--mist)'; box.style.border = '1px solid var(--line)'; box.style.color = 'var(--slate)';
      box.textContent = 'Testing…';
      try {
        const r = await api.post('/notifications/slack-test');
        if (r.ok) {
          box.style.background = '#eafaf3'; box.style.border = '1px solid #b7e6d4'; box.style.color = 'var(--teal-dark)';
          box.innerHTML = `✅ <strong>Connected.</strong> ${esc(r.message)}<br><span style="color:var(--slate);font-size:.82rem;">Check your Slack — the test DM should be there.</span>`;
        } else {
          box.style.background = '#fdece9'; box.style.border = '1px solid #f3c6bf'; box.style.color = 'var(--danger)';
          box.innerHTML = `⚠️ <strong>Not working${r.step ? ` (failed at: ${esc(r.step)})` : ''}.</strong><br>${esc(r.message || '')}${r.error ? `<br><span style="color:var(--slate);font-size:.8rem;">Slack error code: ${esc(r.error)}</span>` : ''}`;
        }
      } catch (e) {
        box.style.background = '#fdece9'; box.style.border = '1px solid #f3c6bf'; box.style.color = 'var(--danger)';
        box.textContent = e.message;
      } finally { btn.disabled = false; }
    });
    loadEmployees();
  };

  async function loadEmployees() {
    try {
      const { users } = await api.get('/users/manage');
      $('#empTable').innerHTML = `<table><thead><tr><th>Code</th><th>Name</th><th>Email</th><th>Role</th><th>Dept / Title</th><th>Leaves</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr style="${u.active ? '' : 'opacity:.5'}">
          <td>${u.emp_code ? `<strong>${esc(u.emp_code)}</strong>` : '—'}</td>
          <td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${badge(u.role)}</td>
          <td>${esc(u.department || '—')}${u.title ? ' · ' + esc(u.title) : ''}</td><td>${u.leave_balance}</td>
          <td>${u.active ? badge('approved') : badge('rejected')}</td>
          <td class="row-actions">
            <button class="btn btn-ghost btn-sm" data-edit-emp="${u.id}">Edit</button>
            <button class="btn btn-ghost btn-sm" data-pw-emp="${u.id}">Password</button>
            <button class="btn ${u.active ? 'btn-danger' : 'btn-primary'} btn-sm" data-toggle-emp="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>
          </td></tr>`).join('')}
      </tbody></table>`;
      const byId = {}; users.forEach((u) => { byId[u.id] = u; });
      $('#empTable').querySelectorAll('[data-edit-emp]').forEach((b) => b.addEventListener('click', () => openEmployeeModal(byId[b.dataset.editEmp])));
      $('#empTable').querySelectorAll('[data-pw-emp]').forEach((b) => b.addEventListener('click', () => openPasswordModal(byId[b.dataset.pwEmp])));
      $('#empTable').querySelectorAll('[data-toggle-emp]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`/users/${b.dataset.toggleEmp}/active`, { active: Number(b.dataset.active) }); toast('Updated'); loadEmployees(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }

  function openEmployeeModal(u) {
    const editing = !!u;
    modal(`<h3>${editing ? 'Edit employee' : 'Add employee'}</h3>
      <div class="form-row"><div class="field"><label>Name</label><input id="eName" value="${esc(u?.name || '')}"></div>
        <div class="field"><label>Email</label><input id="eEmail" value="${esc(u?.email || '')}"></div></div>
      <div class="form-row"><div class="field"><label>Employee code</label><input id="eCode" value="${esc(u?.emp_code || '')}" placeholder="e.g. LN-001"></div>
        <div class="field"></div></div>
      <div class="form-row"><div class="field"><label>Department</label><input id="eDept" value="${esc(u?.department || '')}"></div>
        <div class="field"><label>Title</label><input id="eTitle" value="${esc(u?.title || '')}"></div></div>
      <div class="form-row"><div class="field"><label>Phone</label><input id="ePhone" value="${esc(u?.phone || '')}"></div>
        <div class="field"><label>Role</label><select id="eRole"><option value="EMPLOYEE" ${u?.role !== 'ADMIN' ? 'selected' : ''}>Employee</option><option value="ADMIN" ${u?.role === 'ADMIN' ? 'selected' : ''}>Admin</option></select></div></div>
      <div class="form-row"><div class="field"><label>Leave balance</label><input type="number" step="0.5" id="eBal" value="${u?.leave_balance ?? 18}"></div>
        ${editing ? '<div class="field"></div>' : '<div class="field"><label>Temp password</label><input id="ePw" placeholder="min 6 chars"></div>'}</div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">${editing ? 'Save' : 'Create'}</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const payload = { name: $('#eName').value, email: $('#eEmail').value, emp_code: $('#eCode').value, department: $('#eDept').value, title: $('#eTitle').value, phone: $('#ePhone').value, role: $('#eRole').value, leave_balance: Number($('#eBal').value) };
      try {
        if (editing) await api.put(`/users/${u.id}`, payload);
        else { payload.password = $('#ePw').value; await api.post('/users', payload); }
        closeModal(); toast(editing ? 'Saved ✓' : 'Created ✓'); loadEmployees();
      } catch (e) { toast(e.message, true); }
    });
  }

  function openPasswordModal(u) {
    modal(`<h3>Reset password — ${esc(u.name)}</h3>
      <div class="form-row one"><div class="field"><label>New password</label><input id="npw" placeholder="min 6 chars"></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">Set password</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      try { await api.post(`/users/${u.id}/password`, { password: $('#npw').value }); closeModal(); toast('Password updated ✓'); } catch (e) { toast(e.message, true); }
    });
  }

  boot();
})();
