/* WeLitNexus portal — single-page app. Role-aware views, no build step. */
(function () {
  'use strict';

  let ME = null;
  let clockTimer = null;

  // ---------- tiny helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isAdmin = () => ME && ME.role === 'ADMIN';
  const fmtMins = (m) => `${Math.floor(m / 60)}h ${m % 60}m`;
  const todayISO = () => new Date().toLocaleDateString('en-CA'); // yyyy-mm-dd local
  const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1).toLowerCase();
  const badge = (v) => `<span class="badge b-${String(v).toLowerCase()}">${esc(cap(String(v).replace('_', ' ')))}</span>`;
  const initials = (n) => String(n).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
    setTimeout(() => { t.className = 'toast'; }, 2600);
  }
  function modal(html) {
    $('#modal').innerHTML = html;
    $('#modalBg').classList.add('show');
  }
  function closeModal() { $('#modalBg').classList.remove('show'); }
  $('#modalBg').addEventListener('click', (e) => { if (e.target.id === 'modalBg') closeModal(); });

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
    ME = null; clearInterval(clockTimer); showLogin();
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

    if (isAdmin()) {
      try {
        const [today, pend] = await Promise.all([api.get('/attendance/today'), api.get('/leaves/pending')]);
        const working = today.people.filter((p) => p.state === 'IN');
        const onBreak = today.people.filter((p) => p.state === 'BREAK');
        const clockedOut = today.people.filter((p) => p.state === 'OUT');
        const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
        const presenceCol = (title, list, emptyMsg) => `
          <div class="section" style="margin-bottom:0;">
            <h2>${title} (${list.length})</h2>
            ${list.length ? `<table><thead><tr><th>Name</th><th>Dept</th><th>Worked</th></tr></thead><tbody>
              ${list.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.department || '—')}</td><td>${fmtMins(p.workedMinutes)}</td></tr>`).join('')}
            </tbody></table>` : `<div class="empty">${emptyMsg}</div>`}
          </div>`;
        $('#dashAdmin').innerHTML = `
          <div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));align-items:start;margin-bottom:28px;">
            ${presenceCol('🟢 Currently in', working, 'No one is clocked in right now.')}
            ${presenceCol('☕ On break', onBreak, 'No one is on break.')}
          </div>
          <div class="section">
            <h2>✅ Clocked out today (${clockedOut.length})</h2>
            ${clockedOut.length ? `<table><thead><tr><th>Name</th><th>Dept</th><th>First in</th><th>Last out</th><th>Net worked</th><th>Break</th></tr></thead><tbody>
              ${clockedOut.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.department || '—')}</td>
                <td>${fmtTime(p.firstIn)}</td><td>${fmtTime(p.lastOut)}</td>
                <td><strong>${fmtMins(p.workedMinutes)}</strong></td><td>${fmtMins(p.breakMinutes)}</td></tr>`).join('')}
            </tbody></table>` : `<div class="empty">No one has finished their shift yet.</div>`}
          </div>
          <div class="section">
            <h2>Pending leave approvals (${pend.leaves.length})</h2>
            ${pend.leaves.length ? leaveApprovalTable(pend.leaves) : `<div class="empty">Nothing waiting for approval. 🎉</div>`}
          </div>`;
        wireLeaveApprovals();
      } catch (e) { toast(e.message, true); }
    }
  };

  const statCard = (label, value, cls) => `<div class="card stat"><div class="label">${esc(label)}</div><div class="${cls}">${value}</div></div>`;

  // ---------- Clock ----------
  VIEWS.clock = async () => {
    setMain('Clock', 'Punch in and out, take breaks, and review your timesheet.',
      `<div class="cards" style="grid-template-columns:1fr;max-width:520px;">
         <div class="card clock" id="clockCard"></div>
       </div>
       <div class="section"><h2>Last 14 days</h2><div id="timesheet"></div></div>`);
    await renderClock();
    loadTimesheet();
  };

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

  // ---------- Leaves ----------
  VIEWS.leaves = async () => {
    // Admins get a team view (approvals + who's off) — no personal apply/balance.
    if (isAdmin()) {
      setMain('Leaves', "Requests waiting for approval, and who's on leave.",
        `<div class="section" id="adminLeaves"></div>
         <div class="section"><h2 id="onLeaveHeading">On leave — current & upcoming</h2><div id="onLeave"></div></div>`);
      loadAdminLeaves();
      loadOnLeave();
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
            <td>${esc(l.start_date)}${l.end_date !== l.start_date ? ' → ' + esc(l.end_date) : ''}</td>
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
          <td>${esc(l.start_date)}${l.end_date !== l.start_date ? ' → ' + esc(l.end_date) : ''}</td>
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
        <td>${esc(l.name)}</td><td>${esc(l.start_date)}${l.end_date !== l.start_date ? ' → ' + esc(l.end_date) : ''}</td>
        <td>${esc(cap(l.kind))}</td><td>${l.days}</td><td>${esc(l.reason || '—')}</td>
        <td class="row-actions"><button class="btn btn-primary btn-sm" data-approve="${l.id}">Approve</button>
          <button class="btn btn-danger btn-sm" data-reject="${l.id}">Reject</button></td>
      </tr>`).join('')}</tbody></table>`;
  }

  function wireLeaveApprovals() {
    document.querySelectorAll('[data-approve],[data-reject]').forEach((b) => {
      if (b.dataset.wired) return; b.dataset.wired = '1';
      b.addEventListener('click', async () => {
        const id = b.dataset.approve || b.dataset.reject;
        const decision = b.dataset.approve ? 'APPROVED' : 'REJECTED';
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
  const clientLabel = (t) => t.client_name ? `<span class="badge b-public" style="font-size:.68rem">${esc(t.client_name)}</span>` : '';

  // ---------- Tasks ----------
  let taskClientFilter = '';
  VIEWS.tasks = async () => {
    const emp = !isAdmin();
    setMain('Tasks', isAdmin() ? 'Assign work and track progress, grouped by client.' : 'Your work, organised by client.',
      `<div class="admin-only toolbar">
         <div style="display:flex;gap:10px;align-items:center;">
           <h2 style="margin:0;color:var(--navy);">All tasks</h2>
           <select id="clientFilter" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;"></select>
         </div>
         <button class="btn btn-primary" id="newTaskBtn">+ Assign task</button></div>
       <div class="admin-only" id="allTasks" style="margin-bottom:28px;"></div>
       <div class="toolbar"><h2 style="margin:0;color:var(--navy);">My tasks</h2>
         ${emp ? '<button class="btn btn-primary" id="addMyTaskBtn">+ Add task</button>' : ''}</div>
       <div id="myTasks"></div>
       ${emp ? '<div class="section" style="margin-top:26px;"><h2 style="color:var(--navy);">My recurring schedules</h2><div id="myRecurring"></div></div>' : ''}`);
    if (isAdmin()) {
      await loadLookups();
      $('#clientFilter').innerHTML = `<option value="">All clients</option><option value="none">— No client —</option>`
        + CLIENTS.map((c) => `<option value="${c.id}" ${taskClientFilter == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
      $('#clientFilter').value = taskClientFilter;
      $('#clientFilter').addEventListener('change', (e) => { taskClientFilter = e.target.value; loadAllTasks(); });
      $('#newTaskBtn').addEventListener('click', () => openTaskModal());
      loadAllTasks();
    }
    if (emp) {
      await loadLookups();
      $('#addMyTaskBtn').addEventListener('click', openMyTaskModal);
      loadMyRecurring();
    }
    loadMyTasks();
  };

  // Employee: add a one-time or recurring task for themselves, tied to a client.
  async function openMyTaskModal() {
    if (!CLIENTS.length) await loadLookups();
    if (!CLIENTS.length) return toast('No clients yet — ask an admin to add one first.', true);
    modal(`<h3>Add a task</h3>
      <div class="form-row"><div class="field"><label>Client</label><select id="mtClient"><option value="">Select a client…</option>${CLIENTS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
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
          <td>${FREQ_LABEL[r.frequency]}</td><td>${esc(r.next_due)}</td><td>${r.active ? badge('approved') : badge('cancelled')}</td>
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
          <td>${clientLabel(t) || '—'}</td><td>${badge(t.priority)}</td><td>${esc(t.due_date || '—')}</td><td>${statusSelect(t.id, t.status, openItems(t) > 0)}</td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No tasks assigned to you. 🎉</div>`;
      wireStatusSelects(el, loadMyTasks);
      wireChecklist(el, loadMyTasks);
      el.querySelectorAll('[data-mychecklist]').forEach((b) => b.addEventListener('click', () => openChecklistEditor(tasks.find((t) => t.id == b.dataset.mychecklist), loadMyTasks)));
    } catch (e) { toast(e.message, true); }
  }

  async function loadAllTasks() {
    try {
      let { tasks } = await api.get('/tasks/all');
      if (taskClientFilter === 'none') tasks = tasks.filter((t) => !t.client_id);
      else if (taskClientFilter) tasks = tasks.filter((t) => t.client_id == taskClientFilter);
      const el = $('#allTasks');
      if (!tasks.length) { el.innerHTML = `<div class="empty">No tasks here yet.</div>`; return; }

      // Group by client (clients first, then "General" for untagged).
      const groups = {};
      tasks.forEach((t) => { const k = t.client_name || '— General —'; (groups[k] = groups[k] || []).push(t); });
      const order = Object.keys(groups).sort((a, b) => (a === '— General —') - (b === '— General —') || a.localeCompare(b));
      el.innerHTML = order.map((g) => `
        <div class="section" style="margin-bottom:18px;">
          <h2 style="font-size:1rem;">${esc(g)} <span style="color:var(--slate);font-weight:500;">(${groups[g].length})</span></h2>
          <table><thead><tr><th>Task</th><th>Assignee</th><th>Priority</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
          ${groups[g].map((t) => `<tr><td><strong>${esc(t.title)}</strong>${t.recurring_id ? ' <span title="from a recurring schedule">🔁</span>' : ''}${checklistBadge(t)}</td>
            <td>${esc(t.assignee_name)}</td><td>${badge(t.priority)}</td><td>${esc(t.due_date || '—')}</td><td>${statusSelect(t.id, t.status, openItems(t) > 0)}</td>
            <td class="row-actions"><button class="btn btn-ghost btn-sm" data-checklist-task="${t.id}">✓ Checklist</button><button class="btn btn-ghost btn-sm" data-edit-task="${t.id}">Edit</button><button class="btn btn-danger btn-sm" data-del-task="${t.id}">✕</button></td></tr>`).join('')}
          </tbody></table></div>`).join('');
      wireStatusSelects(el, () => { loadAllTasks(); loadMyTasks(); });
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

  function clientOptions(selectedId) {
    return `<option value="">— No client —</option>` + CLIENTS.map((c) => `<option value="${c.id}" ${selectedId == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
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
      `<div class="toolbar"><h2 style="margin:0;color:var(--navy);">Clients</h2><button class="btn btn-primary" id="addClientBtn">+ Add client</button></div>
       <div id="clientTable" style="margin-bottom:30px;"></div>
       <div class="toolbar"><h2 style="margin:0;color:var(--navy);">Recurring schedules</h2>
         <div class="row-actions"><button class="btn btn-ghost" id="runRecBtn">Generate due now</button><button class="btn btn-primary" id="addRecBtn">+ New schedule</button></div></div>
       <div id="recTable"></div>`);
    await loadLookups();
    $('#addClientBtn').addEventListener('click', () => openClientModal());
    $('#addRecBtn').addEventListener('click', () => openRecurringModal());
    $('#runRecBtn').addEventListener('click', async () => {
      try { const r = await api.post('/recurring/run'); toast(`Generated ${r.created} task(s)`); loadRecurring(); } catch (e) { toast(e.message, true); }
    });
    loadClients();
    loadRecurring();
  };

  const STAGE_LABEL = { PROSPECT: 'Prospect', INTERVIEWED: 'Interviewed – not signed', SIGNED: 'Signed' };
  const STAGE_CLASS = { PROSPECT: 'b-todo', INTERVIEWED: 'b-pending', SIGNED: 'b-done' };
  const stageBadge = (s) => `<span class="badge ${STAGE_CLASS[s] || 'b-todo'}">${esc(STAGE_LABEL[s] || cap(s || 'Prospect'))}</span>`;

  async function loadClients() {
    try {
      const { clients } = await api.get('/clients/all');
      const el = $('#clientTable');
      el.innerHTML = clients.length ? `<table><thead><tr><th>Client</th><th>Code</th><th>Business type</th><th>Stage</th><th>Notes</th><th>Active</th><th></th></tr></thead><tbody>
        ${clients.map((c) => `<tr style="${c.active ? '' : 'opacity:.5'}"><td><strong>${esc(c.name)}</strong></td><td>${esc(c.code || '—')}</td>
          <td>${esc(c.business_type || '—')}</td><td>${stageBadge(c.stage)}</td><td>${esc(c.notes || '—')}</td>
          <td>${c.active ? badge('approved') : badge('rejected')}</td>
          <td class="row-actions"><button class="btn btn-ghost btn-sm" data-edit-client="${c.id}">Edit</button>
            <button class="btn ${c.active ? 'btn-danger' : 'btn-primary'} btn-sm" data-toggle-client="${c.id}" data-active="${c.active ? 0 : 1}">${c.active ? 'Archive' : 'Restore'}</button></td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No clients yet. Add your first one.</div>`;
      const byId = {}; clients.forEach((c) => { byId[c.id] = c; });
      el.querySelectorAll('[data-edit-client]').forEach((b) => b.addEventListener('click', () => openClientModal(byId[b.dataset.editClient])));
      el.querySelectorAll('[data-toggle-client]').forEach((b) => b.addEventListener('click', async () => {
        try { await api.post(`/clients/${b.dataset.toggleClient}/active`, { active: Number(b.dataset.active) }); toast('Updated'); loadClients(); loadLookups(); } catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
  }

  function openClientModal(c) {
    const editing = !!c;
    modal(`<h3>${editing ? 'Edit client' : 'Add client'}</h3>
      <div class="form-row"><div class="field"><label>Name</label><input id="cName" value="${esc(c?.name || '')}"></div>
        <div class="field"><label>Code</label><input id="cCode" value="${esc(c?.code || '')}" placeholder="e.g. TESH"></div></div>
      <div class="form-row"><div class="field"><label>Business type</label><input id="cBizType" value="${esc(c?.business_type || '')}" placeholder="e.g. Restaurant, E-commerce, Law firm"></div>
        <div class="field"><label>Stage</label><select id="cStage">${['PROSPECT', 'INTERVIEWED', 'SIGNED'].map((s) => `<option value="${s}" ${(c?.stage || 'PROSPECT') === s ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}</select></div></div>
      <div class="form-row one"><div class="field"><label>Notes</label><textarea id="cNotes">${esc(c?.notes || '')}</textarea></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">${editing ? 'Save' : 'Create'}</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const payload = { name: $('#cName').value, code: $('#cCode').value, business_type: $('#cBizType').value, stage: $('#cStage').value, notes: $('#cNotes').value };
      try {
        if (editing) await api.put(`/clients/${c.id}`, payload); else await api.post('/clients', payload);
        closeModal(); toast(editing ? 'Saved ✓' : 'Created ✓'); loadClients(); loadLookups();
      } catch (e) { toast(e.message, true); }
    });
  }

  const FREQ_LABEL = { WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', YEARLY: 'Yearly' };
  async function loadRecurring() {
    try {
      const { recurring } = await api.get('/recurring');
      const el = $('#recTable');
      el.innerHTML = recurring.length ? `<table><thead><tr><th>Task</th><th>Client</th><th>Assignee</th><th>Every</th><th>Next due</th><th>Status</th><th></th></tr></thead><tbody>
        ${recurring.map((r) => `<tr style="${r.active ? '' : 'opacity:.5'}"><td><strong>${esc(r.title)}</strong></td><td>${esc(r.client_name || '—')}</td>
          <td>${esc(r.assignee_name)}</td><td>${r.step > 1 ? r.step + ' × ' : ''}${FREQ_LABEL[r.frequency]}</td><td>${esc(r.next_due)}</td>
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
      `"${r.name.replace(/"/g, '""')}"`, `"${(r.department || '').replace(/"/g, '""')}"`,
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
         <p class="page-sub" style="margin:0 0 12px;">P = present · L = leave · ½ = half day · H = holiday · W = weekend · A = absent · · = upcoming</p>
         <div id="regGrid" style="overflow-x:auto;"></div>
       </div>`);
    $('#repRun').addEventListener('click', loadEmpReport);
    $('#empCsvBtn').addEventListener('click', exportEmpCsv);
    $('#regMonth').addEventListener('change', loadRegister);
    $('#regCsvBtn').addEventListener('click', exportRegisterCsv);
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
      const dayNums = data.days.map((d) => d.slice(8));
      $('#regGrid').innerHTML = `<table style="min-width:max-content;"><thead><tr>
          <th style="position:sticky;left:0;background:var(--mist);">Employee</th>
          ${data.days.map((d) => { const wd = new Date(d + 'T00:00').getDay(); return `<th style="text-align:center;padding:8px 6px;${wd === 0 || wd === 6 ? 'color:#b6c2cf;' : ''}">${d.slice(8)}</th>`; }).join('')}
          <th style="text-align:center;">P</th><th style="text-align:center;">L</th><th style="text-align:center;">A</th></tr></thead><tbody>
        ${data.users.map((u) => `<tr>
          <td style="position:sticky;left:0;background:var(--white);font-weight:600;white-space:nowrap;">${esc(u.name)}</td>
          ${data.days.map((d) => { const s = u.cells[d]; return `<td style="text-align:center;padding:6px;${regCellStyle(s)}" title="${d}: ${cap(s)}">${STATUS_CODE[s] || ''}</td>`; }).join('')}
          <td style="text-align:center;font-weight:700;">${u.totals.present}</td><td style="text-align:center;">${u.totals.leave}</td><td style="text-align:center;color:var(--danger);">${u.totals.absent}</td></tr>`).join('')}
      </tbody></table>`;
      void dayNums;
    } catch (e) { toast(e.message, true); }
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
      `"${u.name.replace(/"/g, '""')}"`, `"${(u.department || '').replace(/"/g, '""')}"`,
    ].concat(REGISTER.days.map((d) => STATUS_CODE[u.cells[d]] || '')).concat([u.totals.present, u.totals.leave, u.totals.absent]).join(',')));
    downloadCsv(lines.join('\n'), `attendance-register-${REGISTER.month}.csv`);
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
      ${HOLIDAYS.map((h) => `<tr><td>${esc(h.date)} <span style="color:var(--slate)">(${new Date(h.date + 'T00:00').toLocaleDateString(undefined, { weekday: 'short' })})</span></td>
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
       <div id="empTable"></div>`);
    $('#addEmpBtn').addEventListener('click', () => openEmployeeModal());
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
