/* Dashboard control center: daily status, work, performance, company updates and admin team summary. */
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => new Date().toLocaleDateString('en-CA');
  const month = () => today().slice(0, 7);
  const isAdmin = () => document.body.classList.contains('is-admin');
  const isDashboard = () => document.querySelector('#nav .nav-item.active')?.dataset.view === 'dashboard';
  const fmtMins = (m) => `${Math.floor((Number(m) || 0) / 60)}h ${(Number(m) || 0) % 60}m`;
  const fmtDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
    ? new Date(`${s}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—';
  const safe = async (path) => { try { return await api.get(path); } catch (_e) { return null; } };

  function go(view) {
    document.querySelector(`#nav [data-view="${view}"]`)?.click();
  }

  function injectStyles() {
    if (document.getElementById('dashboardControlStyles')) return;
    const s = document.createElement('style');
    s.id = 'dashboardControlStyles';
    s.textContent = `
      .dc-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(280px,.8fr);gap:18px;margin:18px 0 26px}
      .dc-card{background:var(--white);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:0 1px 2px rgba(15,32,52,.04)}
      .dc-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.dc-head h2{margin:0;color:var(--navy);font-size:1rem}.dc-link{border:0;background:none;color:var(--teal-dark);font:inherit;font-size:.82rem;font-weight:700;cursor:pointer;padding:0}
      .dc-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 18px}.dc-stat{background:var(--white);border:1px solid var(--line);border-radius:14px;padding:16px}.dc-stat .k{color:var(--slate);font-size:.76rem;font-weight:700;text-transform:uppercase;letter-spacing:.35px}.dc-stat .v{color:var(--navy);font-weight:800;font-size:1.22rem;margin-top:7px}.dc-stat .s{color:var(--slate);font-size:.76rem;margin-top:4px}
      .dc-work-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}.dc-work-row:last-child{border-bottom:0}.dc-work-title{font-weight:700;color:var(--navy);font-size:.88rem}.dc-work-meta{color:var(--slate);font-size:.76rem;margin-top:3px}.dc-due{font-size:.76rem;font-weight:700;white-space:nowrap}.dc-overdue{color:var(--danger)}.dc-today{color:#9a6b00}.dc-upcoming{color:var(--slate)}
      .dc-perf{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.dc-perf>div{background:var(--mist);border-radius:10px;padding:12px;text-align:center}.dc-perf strong{display:block;color:var(--navy);font-size:1.08rem}.dc-perf span{display:block;color:var(--slate);font-size:.72rem;margin-top:3px}
      .dc-ann{border-left:4px solid var(--teal);padding-left:14px}.dc-ann-title{font-weight:800;color:var(--navy);margin:3px 0 7px}.dc-ann-body{white-space:pre-wrap;color:var(--text);font-size:.86rem;line-height:1.5}.dc-small{color:var(--slate);font-size:.76rem;margin-top:8px}
      .dc-list{display:grid;gap:10px}.dc-list-item{display:flex;justify-content:space-between;gap:12px;font-size:.85rem}.dc-list-item strong{color:var(--navy)}
      .dc-team{margin:4px 0 24px}.dc-team-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}.dc-team-cell{background:var(--mist);border-radius:10px;padding:12px}.dc-team-cell .n{font-size:1.25rem;font-weight:800;color:var(--navy)}.dc-team-cell .l{font-size:.72rem;color:var(--slate);margin-top:3px}
      .dc-empty{color:var(--slate);font-size:.86rem;padding:10px 0}.dc-section-gap{margin-top:18px}
      @media(max-width:980px){.dc-grid{grid-template-columns:1fr}.dc-stats{grid-template-columns:repeat(2,1fr)}.dc-team-grid{grid-template-columns:repeat(3,1fr)}.dc-perf{grid-template-columns:repeat(3,1fr)}}
      @media(max-width:620px){.dc-stats,.dc-team-grid,.dc-perf{grid-template-columns:repeat(2,1fr)}}`;
    document.head.appendChild(s);
  }

  function normalizeTasks(portalTasks, asanaTasks, asanaOn) {
    const src = asanaOn ? (asanaTasks || []) : (portalTasks || []);
    return src.map((t) => ({
      title: asanaOn ? t.name : t.title,
      due: asanaOn ? (t.due_on || '') : (t.due_date || ''),
      overdue: asanaOn ? !!t.overdue : (!!t.due_date && t.due_date < today() && t.status !== 'DONE'),
      client: asanaOn ? '' : (t.client_parent_name ? `${t.client_parent_name} › ${t.client_name}` : (t.client_name || '')),
      status: asanaOn ? 'OPEN' : t.status,
    })).filter((t) => t.status !== 'DONE')
      .sort((a, b) => (a.overdue === b.overdue ? String(a.due || '9999').localeCompare(String(b.due || '9999')) : (a.overdue ? -1 : 1)));
  }

  function workHtml(tasks) {
    if (!tasks.length) return '<div class="dc-empty">No open work. 🎉</div>';
    return tasks.slice(0, 6).map((t) => {
      const dueClass = t.overdue ? 'dc-overdue' : (t.due === today() ? 'dc-today' : 'dc-upcoming');
      const dueText = t.overdue ? `Overdue · ${fmtDate(t.due)}` : (t.due === today() ? 'Due today' : (t.due ? `Due ${fmtDate(t.due)}` : 'No due date'));
      return `<div class="dc-work-row"><div><div class="dc-work-title">${esc(t.title)}</div>${t.client ? `<div class="dc-work-meta">${esc(t.client)}</div>` : ''}</div><div class="dc-due ${dueClass}">${esc(dueText)}</div></div>`;
    }).join('');
  }

  async function renderDashboard() {
    if (!isDashboard()) return;
    const main = document.getElementById('main');
    const oldCards = main?.querySelector('#dashCards');
    const adminHost = main?.querySelector('#dashAdmin');
    if (!main || !oldCards || main.querySelector('#dashControlCenter')) return;

    injectStyles();
    oldCards.style.display = 'none';

    const root = document.createElement('div');
    root.id = 'dashControlCenter';
    root.innerHTML = '<div class="dc-empty">Loading dashboard…</div>';
    oldCards.parentNode.insertBefore(root, oldCards.nextSibling);

    const baseReqs = [
      safe('/attendance/status'), safe('/leaves/mine'), safe(`/kpi/me?month=${month()}`),
      safe('/holidays'), safe('/announcements'), safe('/asana/status'), safe('/tasks/mine')
    ];
    const [status, leaves, kpiData, holidayData, announcementData, asanaStatus, portalTaskData] = await Promise.all(baseReqs);
    if (!isDashboard()) return;

    let asanaTaskData = null;
    if (asanaStatus?.enabled) asanaTaskData = await safe('/asana/my-tasks');
    const tasks = normalizeTasks(portalTaskData?.tasks, asanaTaskData?.tasks, !!asanaStatus?.enabled);
    const k = kpiData?.rows?.[0] || {};
    const pendingLeave = (leaves?.leaves || []).filter((l) => l.status === 'PENDING').length;
    const nextOwnLeave = (leaves?.leaves || []).filter((l) => l.status === 'APPROVED' && l.end_date >= today()).sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
    const holidays = (holidayData?.holidays || []).filter((h) => h.date >= today()).slice(0, 3);
    const announcements = announcementData?.announcements || [];
    const a = announcements.find((x) => Number(x.pinned) === 1) || announcements[0];
    const openCount = tasks.length;
    const overdueCount = tasks.filter((t) => t.overdue).length;

    root.innerHTML = `
      <div class="dc-stats">
        <div class="dc-stat"><div class="k">Today</div><div class="v">${esc(status?.state || '—')}</div><div class="s">Attendance status</div></div>
        <div class="dc-stat"><div class="k">Worked today</div><div class="v">${fmtMins(status?.workedMinutes)}</div><div class="s">Break ${fmtMins(status?.breakMinutes)}</div></div>
        <div class="dc-stat"><div class="k">My work</div><div class="v">${openCount}</div><div class="s">${overdueCount ? `${overdueCount} overdue` : 'Nothing overdue'}</div></div>
        <div class="dc-stat"><div class="k">Leave balance</div><div class="v">${esc(leaves?.balance ?? k.leaveBalance ?? '—')}</div><div class="s">${pendingLeave ? `${pendingLeave} request pending` : 'days available'}</div></div>
      </div>

      ${a ? `<div class="dc-card" style="margin-bottom:18px"><div class="dc-head"><h2>${Number(a.pinned) === 1 ? '📌 Pinned announcement' : '📣 Latest announcement'}</h2><button class="dc-link" data-go="noticeboard">View all notices</button></div><div class="dc-ann"><div class="dc-ann-title">${esc(a.title)}</div>${a.body ? `<div class="dc-ann-body">${esc(a.body)}</div>` : ''}<div class="dc-small">${esc(a.author || 'LIT Nexus')}${a.created_ts ? ` · ${esc(new Date(a.created_ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}` : ''}</div></div></div>` : ''}

      <div class="dc-grid">
        <div>
          <div class="dc-card"><div class="dc-head"><h2>My Work</h2><button class="dc-link" data-go="tasks">Open tasks</button></div>${workHtml(tasks)}</div>
          <div class="dc-card dc-section-gap"><div class="dc-head"><h2>This Month</h2><button class="dc-link" data-go="myperf">My performance</button></div>
            <div class="dc-perf">
              <div><strong>${esc(k.daysPresent ?? 0)}</strong><span>Days present</span></div>
              <div><strong>${k.punctualPct == null ? 'N/A' : `${k.punctualPct}%`}</strong><span>Punctuality</span></div>
              <div><strong>${esc(k.tasksDone ?? 0)}</strong><span>Tasks completed</span></div>
              <div><strong>${esc(k.achievementsAcknowledged ?? 0)}</strong><span>Achievements</span></div>
              <div><strong>${esc(k.leaveDays ?? 0)}</strong><span>Leave used</span></div>
            </div>
          </div>
        </div>
        <div>
          <div class="dc-card"><div class="dc-head"><h2>Upcoming</h2><button class="dc-link" data-go="calendar">Holidays</button></div>
            <div class="dc-list">
              ${nextOwnLeave ? `<div class="dc-list-item"><span>My approved leave</span><strong>${esc(nextOwnLeave.start_date === nextOwnLeave.end_date ? fmtDate(nextOwnLeave.start_date) : `${fmtDate(nextOwnLeave.start_date)}–${fmtDate(nextOwnLeave.end_date)}`)}</strong></div>` : ''}
              ${holidays.length ? holidays.map((h) => `<div class="dc-list-item"><span>${esc(h.name)}</span><strong>${esc(fmtDate(h.date))}</strong></div>`).join('') : '<div class="dc-empty">No upcoming holidays published.</div>'}
            </div>
          </div>
          <div class="dc-card dc-section-gap"><div class="dc-head"><h2>Quick access</h2></div><div class="dc-list">
            <button class="btn btn-ghost" data-go="clock">Attendance / Clock</button>
            <button class="btn btn-ghost" data-go="leaves">Leave</button>
            <button class="btn btn-ghost" data-go="achievements">Log achievement</button>
          </div></div>
        </div>
      </div>`;

    root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

    if (isAdmin() && adminHost) {
      const [teamToday, upcomingLeaves, pendingLeaves, punchPending, achMonth] = await Promise.all([
        safe('/attendance/today'), safe('/leaves/upcoming'), safe('/leaves/pending'), safe('/punch-requests/pending'), safe(`/achievements/month/${month()}`)
      ]);
      let overdueTeam = 0;
      if (asanaStatus?.enabled) {
        const teamTasks = await safe('/asana/team-tasks');
        overdueTeam = teamTasks?.totalOverdue || 0;
      } else {
        const allTasks = await safe('/tasks/all');
        overdueTeam = (allTasks?.tasks || []).filter((t) => t.status !== 'DONE' && t.due_date && t.due_date < today()).length;
      }
      const people = teamToday?.people || [];
      const working = people.filter((p) => p.state === 'IN' || p.state === 'BREAK').length;
      const todayLeaves = (upcomingLeaves?.leaves || []).filter((l) => l.start_date <= today() && l.end_date >= today()).length;
      const notClocked = Math.max(0, people.filter((p) => p.state === 'OFF').length - todayLeaves);
      const achPending = (achMonth?.achievements || []).filter((x) => x.status === 'PENDING').length;

      const summary = document.createElement('div');
      summary.className = 'dc-card dc-team';
      summary.innerHTML = `<div class="dc-head"><h2>Team Today</h2><span class="dc-small">Operational snapshot</span></div><div class="dc-team-grid">
        <div class="dc-team-cell"><div class="n">${working}</div><div class="l">Working / on break</div></div>
        <div class="dc-team-cell"><div class="n">${todayLeaves}</div><div class="l">On leave</div></div>
        <div class="dc-team-cell"><div class="n">${notClocked}</div><div class="l">Not clocked in</div></div>
        <div class="dc-team-cell"><div class="n">${overdueTeam}</div><div class="l">Overdue tasks</div></div>
        <div class="dc-team-cell"><div class="n">${punchPending?.requests?.length || 0}</div><div class="l">Attendance corrections</div></div>
        <div class="dc-team-cell"><div class="n">${achPending}</div><div class="l">Achievements pending</div></div>
      </div>${pendingLeaves?.leaves?.length ? `<div class="dc-small" style="margin-top:12px"><strong>${pendingLeaves.leaves.length}</strong> leave request(s) awaiting approval.</div>` : ''}`;
      adminHost.parentNode.insertBefore(summary, adminHost);
    }
  }

  let queued = false;
  const observer = new MutationObserver(() => {
    if (!isDashboard() || queued) return;
    queued = true;
    setTimeout(() => { queued = false; renderDashboard(); }, 0);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(renderDashboard, 0);
})();
