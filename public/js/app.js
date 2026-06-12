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
        const present = today.people.filter((p) => p.state === 'IN' || p.state === 'BREAK');
        $('#dashAdmin').innerHTML = `
          <div class="section">
            <h2>Who's in today (${present.length}/${today.people.length})</h2>
            ${today.people.length ? `<table><thead><tr><th>Name</th><th>Dept</th><th>Status</th><th>Worked</th></tr></thead><tbody>
              ${today.people.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.department || '—')}</td><td>${badge(p.state)}</td><td>${fmtMins(p.workedMinutes)}</td></tr>`).join('')}
            </tbody></table>` : `<div class="empty">No one has clocked in yet.</div>`}
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
    setMain('Leaves', 'Apply for time off and track your requests.',
      `<div class="cards"><div class="card stat"><div class="label">Leave balance</div><div class="value small" id="balVal">—</div></div></div>
       <div class="toolbar"><h2 style="margin:0;color:var(--navy);">My requests</h2>
         <button class="btn btn-primary" id="applyBtn">+ Apply for leave</button></div>
       <div id="myLeaves"></div>
       <div class="admin-only section" id="adminLeaves" style="margin-top:28px;"></div>`);
    $('#applyBtn').addEventListener('click', openApplyLeave);
    await loadMyLeaves();
    if (isAdmin()) loadAdminLeaves();
  };

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
    setMain('Tasks', isAdmin() ? 'Assign work and track progress, grouped by client.' : 'Your assigned work.',
      `<div class="admin-only toolbar">
         <div style="display:flex;gap:10px;align-items:center;">
           <h2 style="margin:0;color:var(--navy);">All tasks</h2>
           <select id="clientFilter" style="padding:8px 10px;border:1px solid var(--line);border-radius:8px;"></select>
         </div>
         <button class="btn btn-primary" id="newTaskBtn">+ Assign task</button></div>
       <div class="admin-only" id="allTasks" style="margin-bottom:28px;"></div>
       <h2 style="color:var(--navy);">My tasks</h2><div id="myTasks"></div>`);
    if (isAdmin()) {
      await loadLookups();
      $('#clientFilter').innerHTML = `<option value="">All clients</option><option value="none">— No client —</option>`
        + CLIENTS.map((c) => `<option value="${c.id}" ${taskClientFilter == c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
      $('#clientFilter').value = taskClientFilter;
      $('#clientFilter').addEventListener('change', (e) => { taskClientFilter = e.target.value; loadAllTasks(); });
      $('#newTaskBtn').addEventListener('click', () => openTaskModal());
      loadAllTasks();
    }
    loadMyTasks();
  };

  const statusSelect = (id, status) => `<select data-status="${id}">
    ${['TODO', 'IN_PROGRESS', 'DONE'].map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${cap(s.replace('_', ' '))}</option>`).join('')}</select>`;

  async function loadMyTasks() {
    try {
      const { tasks } = await api.get('/tasks/mine');
      const el = $('#myTasks');
      el.innerHTML = tasks.length ? `<table><thead><tr><th>Task</th><th>Client</th><th>Priority</th><th>Due</th><th>Status</th></tr></thead><tbody>
        ${tasks.map((t) => `<tr><td><strong>${esc(t.title)}</strong>${t.description ? `<div style="color:var(--slate);font-size:.84rem;margin-top:3px;">${esc(t.description)}</div>` : ''}<div style="color:var(--slate);font-size:.78rem;margin-top:3px;">by ${esc(t.assigner_name)}${t.recurring_id ? ' · 🔁 recurring' : ''}</div></td>
          <td>${clientLabel(t) || '—'}</td><td>${badge(t.priority)}</td><td>${esc(t.due_date || '—')}</td><td>${statusSelect(t.id, t.status)}</td></tr>`).join('')}
      </tbody></table>` : `<div class="empty">No tasks assigned to you. 🎉</div>`;
      wireStatusSelects(el, loadMyTasks);
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
          ${groups[g].map((t) => `<tr><td><strong>${esc(t.title)}</strong>${t.recurring_id ? ' <span title="from a recurring schedule">🔁</span>' : ''}</td>
            <td>${esc(t.assignee_name)}</td><td>${badge(t.priority)}</td><td>${esc(t.due_date || '—')}</td><td>${statusSelect(t.id, t.status)}</td>
            <td class="row-actions"><button class="btn btn-ghost btn-sm" data-edit-task="${t.id}">Edit</button><button class="btn btn-danger btn-sm" data-del-task="${t.id}">✕</button></td></tr>`).join('')}
          </tbody></table></div>`).join('');
      wireStatusSelects(el, () => { loadAllTasks(); loadMyTasks(); });
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
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">${editing ? 'Save' : 'Assign'}</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const payload = { title: $('#tTitle').value, description: $('#tDesc').value, client_id: $('#tClient').value || null, assignee_id: Number($('#tAssignee').value), priority: $('#tPriority').value, due_date: $('#tDue').value };
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

  async function loadClients() {
    try {
      const { clients } = await api.get('/clients/all');
      const el = $('#clientTable');
      el.innerHTML = clients.length ? `<table><thead><tr><th>Client</th><th>Code</th><th>Notes</th><th>Status</th><th></th></tr></thead><tbody>
        ${clients.map((c) => `<tr style="${c.active ? '' : 'opacity:.5'}"><td><strong>${esc(c.name)}</strong></td><td>${esc(c.code || '—')}</td><td>${esc(c.notes || '—')}</td>
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
      <div class="form-row one"><div class="field"><label>Notes</label><textarea id="cNotes">${esc(c?.notes || '')}</textarea></div></div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">${editing ? 'Save' : 'Create'}</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const payload = { name: $('#cName').value, code: $('#cCode').value, notes: $('#cNotes').value };
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
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">${editing ? 'Save' : 'Create schedule'}</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const payload = { title: $('#rTitle').value, description: $('#rDesc').value, client_id: $('#rClient').value || null, assignee_id: Number($('#rAssignee').value),
        frequency: $('#rFreq').value, priority: $('#rPriority').value, next_due: $('#rNext').value, lead_days: Number($('#rLead').value), step: 1 };
      try {
        if (editing) await api.put(`/recurring/${r.id}`, payload); else await api.post('/recurring', payload);
        closeModal(); toast(editing ? 'Saved ✓' : 'Schedule created ✓'); loadRecurring();
      } catch (e) { toast(e.message, true); }
    });
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
    setMain('Employee Directory', 'Everyone at WeLitNexus.', `<div class="people-grid" id="people"></div>`);
    try {
      const { users } = await api.get('/users');
      $('#people').innerHTML = users.map((u) => `<div class="person">
        <div class="avatar">${esc(initials(u.name))}</div>
        <div><div class="nm">${esc(u.name)}${u.role === 'ADMIN' ? ' <span class="badge b-company" style="font-size:.66rem">Admin</span>' : ''}</div>
          <div class="tt">${esc(u.title || '—')}${u.department ? ' · ' + esc(u.department) : ''}</div>
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
      $('#empTable').innerHTML = `<table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Dept / Title</th><th>Leaves</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr style="${u.active ? '' : 'opacity:.5'}">
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
      <div class="form-row"><div class="field"><label>Department</label><input id="eDept" value="${esc(u?.department || '')}"></div>
        <div class="field"><label>Title</label><input id="eTitle" value="${esc(u?.title || '')}"></div></div>
      <div class="form-row"><div class="field"><label>Phone</label><input id="ePhone" value="${esc(u?.phone || '')}"></div>
        <div class="field"><label>Role</label><select id="eRole"><option value="EMPLOYEE" ${u?.role !== 'ADMIN' ? 'selected' : ''}>Employee</option><option value="ADMIN" ${u?.role === 'ADMIN' ? 'selected' : ''}>Admin</option></select></div></div>
      <div class="form-row"><div class="field"><label>Leave balance</label><input type="number" step="0.5" id="eBal" value="${u?.leave_balance ?? 18}"></div>
        ${editing ? '<div class="field"></div>' : '<div class="field"><label>Temp password</label><input id="ePw" placeholder="min 6 chars"></div>'}</div>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">${editing ? 'Save' : 'Create'}</button></div>`);
    $('#mCancel').addEventListener('click', closeModal);
    $('#mSave').addEventListener('click', async () => {
      const payload = { name: $('#eName').value, email: $('#eEmail').value, department: $('#eDept').value, title: $('#eTitle').value, phone: $('#ePhone').value, role: $('#eRole').value, leave_balance: Number($('#eBal').value) };
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
