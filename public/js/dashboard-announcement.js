/* Role-specific Dashboard. Full records remain in their own sections. */
(function () {
  'use strict';

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dateLabel = (date) => new Date(date + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const clockState = { OFF: 'Ready to clock in', IN: 'Clocked in', BREAK: 'On break', OUT: 'Clocked out' };
  const minutes = (value) => `${Math.floor(value / 60)}h ${value % 60}m`;

  function taskList(data, fromAsana) {
    if (!data) return '<p class="dash-muted" role="status">Tasks are unavailable. Open Tasks to retry.</p>';
    const today = new Date().toLocaleDateString('en-CA');
    const tasks = data.tasks.filter(t => t.status !== 'DONE').map(t => ({
      title: fromAsana ? t.name : t.title,
      due: fromAsana ? t.due_on : t.due_date,
    })).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).slice(0, 3);
    if (!tasks.length) return '<p class="dash-muted">You have no open tasks.</p>';
    return `<ul class="dash-task-list">${tasks.map(t => {
      const overdue = t.due && t.due < today;
      const due = !t.due ? 'No due date' : t.due === today ? 'Due today' : `${overdue ? 'Overdue' : 'Due'} ${dateLabel(t.due)}`;
      return `<li><span>${esc(t.title)}</span><span class="dash-due${overdue ? ' dash-overdue' : ''}">${esc(due)}</span></li>`;
    }).join('')}</ul>`;
  }

  function staffMarkup(status, tasks, fromAsana, announcements) {
    const notice = announcements?.announcements.find(a => Number(a.pinned) === 1) || announcements?.announcements[0];
    const state = status?.state === 'OUT' && status.firstIn == null ? 'OFF' : status?.state;
    return `
      <div class="dash-overview-grid">
        <section class="dash-card dash-today">
          <div><h2>Today</h2><p class="dash-clock-state">${esc(clockState[state] || 'Clock status unavailable')}</p>
            ${status ? `<p class="dash-muted">Worked ${minutes(status.workedMinutes)} · Break ${minutes(status.breakMinutes)}</p>` : ''}
          </div>
          <a class="btn btn-primary" href="#/clock">Open Clock</a>
        </section>
        <section class="dash-card">
          <div class="dash-card-heading"><h2>Tasks due next</h2><a href="#/tasks">View tasks</a></div>
          ${taskList(tasks, fromAsana)}
        </section>
      </div>
      ${notice ? `<section class="dash-card dash-notice">
        <div class="dash-card-heading"><h2>${Number(notice.pinned) === 1 ? 'Pinned notice' : 'Latest notice'}</h2><a href="#/noticeboard">Notice board</a></div>
        <p>${esc(notice.title)}</p>
      </section>` : ''}`;
  }

  function adminMarkup(approvals, today) {
    const approvalsMarkup = [
      ['Late explanations', approvals?.late, '#/late-requests'],
      ['Leave requests', approvals?.leave, '#/late-requests'],
      ['Punch corrections', approvals?.punch, '#/clock'],
    ].map(([label, count, url]) =>
      `<a class="dash-metric" href="${url}"><strong>${count ?? '—'}</strong><span>${label}</span></a>`).join('');
    const states = [['Working', 'IN'], ['On break', 'BREAK'], ['Clocked out', 'OUT'], ['Not clocked in', 'OFF']];
    return `
      <section class="dash-card">
        <div class="dash-card-heading"><h2>Needs attention</h2><a href="#/operations">Open Operations</a></div>
        <div class="dash-metrics dash-approval-counts">${approvalsMarkup}</div>
        ${approvals ? '' : '<p class="dash-muted" role="status">Approval counts are unavailable.</p>'}
      </section>
      <section class="dash-card">
        <div class="dash-card-heading"><h2>Team today</h2><a href="#/clock">Open Clock</a></div>
        <div class="dash-metrics">${states.map(([label, state]) =>
          `<div class="dash-metric"><strong data-team-count="${state}">${today?.people ? today.people.filter(p => p.state === state).length : '—'}</strong><span>${label}</span></div>`).join('')}</div>
        <details class="dash-team-details" id="dashTeamDetails">
          <summary>Live attendance and corrections</summary>
          <div id="dashAdmin"></div>
        </details>
      </section>`;
  }

  async function renderDashboard(root, { read, admin, openTeam }) {
    const safe = async (path) => { try { return await read(path); } catch (_e) { return null; } };
    if (admin) {
      const [approvals, today] = await Promise.all([safe('/operations/dashboard-approvals'), safe('/attendance/today')]);
      if (!root.isConnected) return;
      root.innerHTML = adminMarkup(approvals, today);
      const details = root.querySelector('#dashTeamDetails');
      const load = () => {
        if (!details.isConnected || !details.open) return;
        details.removeEventListener('toggle', load);
        openTeam();
      };
      details.addEventListener('toggle', load);
    } else {
      const work = (async () => {
        const asana = await safe('/asana/status');
        return asana?.enabled
          ? { fromAsana: true, tasks: await safe('/asana/my-tasks') }
          : { fromAsana: false, tasks: await safe('/tasks/mine') };
      })();
      const [status, announcements, { tasks, fromAsana }] = await Promise.all([
        safe('/attendance/status'), safe('/announcements'), work,
      ]);
      if (!root.isConnected) return;
      root.innerHTML = staffMarkup(status, tasks, fromAsana, announcements);
    }
    root.removeAttribute('aria-busy');
  }

  window.Dashboard = { render: renderDashboard };
})();
