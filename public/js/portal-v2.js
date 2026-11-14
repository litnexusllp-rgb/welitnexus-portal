/* Portal v2 views: Messages (Slack), Calendar (unified), Billing & Invoices,
   People & Access, Integrations. Mounted by app.js through window.PortalV2. */
(function () {
  'use strict';

  const money = (n, cur = 'USD') =>
    (cur === 'INR' ? '₹' : '$') +
    Number(n || 0).toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const usDate = (iso) =>
    iso && /^\d{4}-\d{2}-\d{2}/.test(iso)
      ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : '—';
  const usTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const isoDay = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const STATUS = { DRAFT: 's-draft', SENT: 's-sent', OVERDUE: 's-overdue', PAID: 's-paid', VOID: 's-void' };
  const pill = (esc, label, cls) => `<span class="pill ${cls}">${esc(label)}</span>`;
  const empty = (esc, title, body) => `<div class="empty-state"><h3>${esc(title)}</h3><p>${body}</p></div>`;

  // Close streams / timers when the view is left (app.js clears registered intervals on navigation).
  function whileMounted(ctx, root, cleanup) {
    // Not registered with app.js on purpose: it must outlive navigation long
    // enough to notice the view is gone and run the cleanup.
    const t = setInterval(() => {
      if (!document.body.contains(root)) {
        clearInterval(t);
        cleanup();
      }
    }, 1000);
    return t;
  }

  // =====================================================================
  //  MESSAGES (Slack)
  // =====================================================================
  async function messages(ctx) {
    const { api, $, esc, toast } = ctx;
    ctx.setMain(
      'Messages',
      'Conversations from your Slack workspace. Messages you send here post to Slack under your name.',
      '<div id="msgRoot" class="msg-layout"><div class="loading">Loading conversations…</div></div>',
    );
    const root = $('#msgRoot');
    let data;
    try {
      data = await api.get('/messages/channels');
    } catch (e) {
      root.innerHTML = empty(esc, 'Messages are unavailable', esc(e.message));
      return;
    }
    if (!data.enabled) {
      root.innerHTML = empty(
        esc,
        'Slack is not connected yet',
        'An owner can connect Slack from <a href="#/integrations">Admin console › Integrations</a>. Until then, keep using the Slack app as usual.',
      );
      return;
    }
    if (!data.channels.length) {
      root.innerHTML = empty(
        esc,
        'No shared channels yet',
        'Channels appear here when you are a member in Slack and the portal app has been added to the channel (type <code>/invite @LIT Portal</code> in Slack).',
      );
      return;
    }
    let current = data.channels[0].id;
    let thread = null;
    let providers = { providers: [], default: null };
    api
      .get('/ai/providers')
      .then((p) => {
        providers = p;
        renderAiPanel();
      })
      .catch(() => {});

    root.innerHTML = `
      <aside class="msg-channels card" aria-label="Channels"><div class="msg-head">Channels</div><nav id="msgChanList"></nav></aside>
      <section class="msg-thread card" aria-live="polite">
        <header class="msg-thread-head"><div><div class="msg-title" id="msgTitle"></div><div class="msg-sub" id="msgSub"></div></div>
          <button class="btn btn-ghost btn-sm" id="msgThreadBack" hidden>← Back to channel</button></header>
        <div class="msg-list" id="msgList"></div>
        <form class="msg-compose" id="msgForm">
          <label class="sr-only" for="msgText">Message</label>
          <textarea id="msgText" rows="2" placeholder="Write a message — posts to Slack"></textarea>
          <div class="msg-actions">
            <label class="btn btn-ghost btn-sm file-btn">Attach file<input type="file" id="msgFile" hidden></label>
            <span id="msgFileName" class="msg-sub"></span>
            <span class="topbar-spacer"></span>
            <button type="submit" class="btn btn-navy btn-sm" id="msgSend">Send</button>
          </div>
        </form>
      </section>
      <aside class="msg-ai card" id="msgAi" aria-label="AI assistant"></aside>`;

    function renderChannels() {
      $('#msgChanList').innerHTML = data.channels
        .map(
          (c) =>
            `<button type="button" class="msg-chan${c.id === current ? ' on' : ''}" data-ch="${esc(c.id)}"><span>${c.is_private ? '🔒' : '#'} ${esc(c.name)}</span></button>`,
        )
        .join('');
      $('#msgChanList')
        .querySelectorAll('[data-ch]')
        .forEach((b) =>
          b.addEventListener('click', () => {
            current = b.dataset.ch;
            thread = null;
            renderChannels();
            load();
          }),
        );
    }
    const chan = () => data.channels.find((c) => c.id === current) || {};

    function msgHtml(m) {
      const files = (m.files || [])
        .map(
          (f) =>
            `<a class="msg-file" href="/api/messages/files/${esc(f.id)}"><span class="msg-file-type">${esc((f.filetype || 'file').toUpperCase().slice(0, 4))}</span><span>${esc(f.name)}</span></a>`,
        )
        .join('');
      return `<article class="msg" data-ts="${esc(m.ts)}">
        <span class="avatar avatar-sm">${esc(ctx.initials(m.user_name || '?'))}</span>
        <div class="msg-body"><div><strong>${esc(m.user_name || 'Slack')}</strong> <span class="msg-sub">${esc(usTime(Number(m.ts) * 1000))}${m.edited ? ' · edited' : ''}</span></div>
          <div class="msg-text">${esc(m.text).replace(/\n/g, '<br>')}</div>${files}
          <div class="msg-tools">${!thread && m.reply_count ? `<button type="button" class="link-btn" data-thread="${esc(m.ts)}">${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}</button>` : ''}
            ${!thread ? `<button type="button" class="link-btn" data-thread="${esc(m.ts)}">Reply in thread</button>` : ''}
            <button type="button" class="link-btn" data-task="${esc(m.ts)}">Create Asana task</button></div></div></article>`;
    }

    async function load() {
      $('#msgTitle').textContent = (chan().is_private ? '🔒 ' : '# ') + (chan().name || '');
      $('#msgSub').textContent = thread
        ? 'Thread'
        : 'Synced with Slack' + (chan().link && chan().link.asana_project_gid ? ' · linked to an Asana project' : '');
      $('#msgThreadBack').hidden = !thread;
      $('#msgList').innerHTML = '<div class="loading">Loading…</div>';
      try {
        const h = await api.get(
          `/messages/channels/${encodeURIComponent(current)}${thread ? '?thread=' + encodeURIComponent(thread) : ''}`,
        );
        $('#msgList').innerHTML = h.messages.length
          ? h.messages.map(msgHtml).join('')
          : '<div class="msg-sub" style="padding:20px">No messages yet.</div>';
        wireMessages();
        $('#msgList').scrollTop = $('#msgList').scrollHeight;
      } catch (e) {
        $('#msgList').innerHTML = `<div class="err-inline">${esc(e.message)}</div>`;
      }
      renderAiPanel();
    }

    function wireMessages() {
      $('#msgList')
        .querySelectorAll('[data-thread]')
        .forEach((b) =>
          b.addEventListener('click', () => {
            thread = b.dataset.thread;
            load();
          }),
        );
      $('#msgList')
        .querySelectorAll('[data-task]')
        .forEach((b) => b.addEventListener('click', () => taskFromMessage(b.dataset.task)));
    }

    function taskFromMessage(ts, name = '', due = '') {
      ctx.modal(`<h3>Create Asana task</h3>
        <div class="form-row one"><div class="field"><label>Task name</label><input id="tfName" value="${esc(name)}" placeholder="Defaults to the message text"></div></div>
        <div class="form-row one"><div class="field"><label>Due date</label><input type="date" id="tfDue" value="${esc(due)}"></div></div>
        <p class="page-sub">Assigned to you in Asana, with a link back to the Slack message. A link to the task is posted in the thread.</p>
        <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">Create task</button></div>`);
      $('#mCancel').addEventListener('click', ctx.closeModal);
      $('#mSave').addEventListener('click', async () => {
        try {
          const r = await api.post('/asana-tasks/from-message', {
            channel: current,
            ts,
            name: $('#tfName').value || undefined,
            due_date: $('#tfDue').value || undefined,
          });
          ctx.closeModal();
          toast('Asana task created ✓');
          if (r.task.url) window.open(r.task.url, '_blank', 'noopener');
        } catch (e) {
          toast(e.message, true);
        }
      });
    }

    function renderAiPanel(result) {
      const box = $('#msgAi');
      if (!box) return;
      if (!providers.providers.length) {
        box.innerHTML = `<div class="msg-head">AI assistant</div><p class="msg-sub">Not set up. An owner can add Claude or ChatGPT in Integrations.</p>`;
        return;
      }
      box.innerHTML = `<div class="msg-head">AI assistant</div>
        <label class="field-inline">Model <select id="aiProv">${providers.providers.map((p) => `<option value="${esc(p.id)}"${p.id === providers.default ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
        <div class="ai-buttons"><button class="btn btn-ghost btn-sm" data-ai="summarize_thread">Summarize</button><button class="btn btn-ghost btn-sm" data-ai="draft_reply">Draft reply</button><button class="btn btn-ghost btn-sm" data-ai="suggest_tasks">Find tasks</button></div>
        <div id="aiOut">${result || '<p class="msg-sub">Uses only this conversation. Nothing is posted without your click.</p>'}</div>`;
      box.querySelectorAll('[data-ai]').forEach((b) => b.addEventListener('click', () => runAi(b.dataset.ai)));
    }

    async function runAi(action) {
      $('#aiOut').innerHTML = '<div class="loading">Thinking…</div>';
      try {
        const r = await api.post('/ai/complete', {
          provider: $('#aiProv').value,
          action,
          context: { channel: current, thread_ts: thread || undefined },
        });
        const sug = (r.suggestions || [])
          .map((s, i) =>
            s.type === 'reply'
              ? `<div class="ai-sug"><div>${esc(s.text)}</div><button class="btn btn-ghost btn-sm" data-use="${i}">Use as reply</button></div>`
              : `<div class="ai-sug"><div><strong>Task:</strong> ${esc(s.name)}${s.due_on ? ' · due ' + esc(usDate(s.due_on)) : ''}</div><button class="btn btn-ghost btn-sm" data-mk="${i}">Create in Asana</button></div>`,
          )
          .join('');
        renderAiPanel(`<div class="ai-text">${esc(r.text).replace(/\n/g, '<br>')}</div>${sug}`);
        $('#msgAi')
          .querySelectorAll('[data-use]')
          .forEach((b) =>
            b.addEventListener('click', () => {
              $('#msgText').value = r.suggestions[b.dataset.use].text;
              $('#msgText').focus();
            }),
          );
        $('#msgAi')
          .querySelectorAll('[data-mk]')
          .forEach((b) =>
            b.addEventListener('click', () => {
              const s = r.suggestions[b.dataset.mk];
              const last = [...$('#msgList').querySelectorAll('.msg')].pop();
              if (last) taskFromMessage(last.dataset.ts, s.name, s.due_on || '');
            }),
          );
      } catch (e) {
        renderAiPanel(`<div class="err-inline">${esc(e.message)}</div>`);
      }
    }

    $('#msgThreadBack').addEventListener('click', () => {
      thread = null;
      load();
    });
    $('#msgFile').addEventListener('change', () => {
      const f = $('#msgFile').files[0];
      $('#msgFileName').textContent = f ? `${f.name} (${Math.ceil(f.size / 1024)} KB)` : '';
    });
    $('#msgText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#msgForm').requestSubmit();
      }
    });
    $('#msgForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#msgText').value.trim();
      const file = $('#msgFile').files[0];
      if (!text && !file) return;
      $('#msgSend').disabled = true;
      try {
        if (file) {
          if (file.size > 50 * 1024 * 1024) throw new Error('Files must be 50 MB or smaller');
          const res = await fetch(`/api/messages/channels/${encodeURIComponent(current)}/files`, {
            method: 'POST',
            credentials: 'same-origin',
            body: file,
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Filename': encodeURIComponent(file.name),
              'X-Comment': encodeURIComponent(text),
              ...(thread ? { 'X-Thread-Ts': thread } : {}),
            },
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || 'Upload failed');
          toast('File shared to Slack ✓');
        } else {
          await api.post(`/messages/channels/${encodeURIComponent(current)}`, { text, thread_ts: thread || undefined });
        }
        $('#msgText').value = '';
        $('#msgFile').value = '';
        $('#msgFileName').textContent = '';
        load();
      } catch (err) {
        toast(err.message, true);
      } finally {
        $('#msgSend').disabled = false;
      }
    });

    // Live updates from Slack.
    let stream = null;
    if (window.EventSource) {
      stream = new EventSource('/api/messages/stream');
      stream.addEventListener('message', (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.channel !== current || $('#msgList') === null) return;
          if (thread ? m.thread_ts !== thread : m.thread_ts && m.thread_ts !== m.ts) return;
          if (m.deleted) {
            const el = $('#msgList').querySelector(`[data-ts="${CSS.escape(m.ts)}"]`);
            if (el) el.remove();
            return;
          }
          if ($('#msgList').querySelector(`[data-ts="${CSS.escape(m.ts)}"]`)) return;
          $('#msgList').insertAdjacentHTML('beforeend', msgHtml(m));
          wireMessages();
          $('#msgList').scrollTop = $('#msgList').scrollHeight;
        } catch (_e) {
          /* ignore malformed */
        }
      });
    }
    whileMounted(ctx, root, () => {
      if (stream) stream.close();
    });
    renderChannels();
    load();
  }

  // =====================================================================
  //  CALENDAR (unified)
  // =====================================================================
  async function schedule(ctx) {
    const { api, $, esc, toast } = ctx;
    const params = new URLSearchParams(window.location.search);
    if (params.has('connect')) {
      const c = params.get('connect');
      const msg = {
        ok: `Calendar connected ✓ (${params.get('added') || 0} calendars added)`,
        cancelled: 'Connection cancelled.',
        blocked:
          'That account’s organization blocks outside apps. Share the calendar to an account you own, or add its ICS link instead.',
        failed: 'Could not connect that calendar. Please try again.',
      }[c];
      if (msg) setTimeout(() => toast(msg, c !== 'ok'), 50);
      window.history.replaceState(null, '', '/' + window.location.hash);
    }
    ctx.setMain(
      'Calendar',
      'All your calendars in one place — work and personal accounts, client calendars, holidays and time off.',
      '<div id="calRoot" class="cal2-layout"><div class="loading">Loading…</div></div>',
    );
    const root = $('#calRoot');
    let view = 'week';
    let anchor = new Date();
    anchor.setHours(0, 0, 0, 0);
    let sources = [],
      events = [],
      conflicts = new Set();

    root.innerHTML = `
      <aside class="cal2-side card">
        <button class="btn btn-navy btn-block" id="calNew">+ New event</button>
        <div id="calSources"></div>
        <details class="cal2-setup" id="calSetup">
          <summary>Add a calendar</summary>
          <div class="cal2-connect">
            <button class="btn btn-ghost btn-sm btn-block" id="calGoogle">Connect Google / Gmail</button>
            <button class="btn btn-ghost btn-sm btn-block" id="calMs">Connect Outlook / Microsoft 365</button>
            <button class="btn btn-ghost btn-sm btn-block" id="calIcs">Add calendar link (ICS)</button>
          </div>
          <p class="msg-sub">You don't need to be an admin of an account to connect it. If an organization blocks outside apps, share that calendar to an account you own, or paste its ICS link.</p>
        </details>
      </aside>
      <section class="cal2-main card">
        <header class="cal2-toolbar">
          <button class="btn btn-ghost btn-sm" id="calToday">Today</button>
          <button class="btn btn-ghost btn-sm icon-btn" id="calPrev" aria-label="Previous">‹</button>
          <button class="btn btn-ghost btn-sm icon-btn" id="calNext" aria-label="Next">›</button>
          <h2 class="cal2-range" id="calRange"></h2>
          <span class="topbar-spacer"></span>
          <span id="calConflicts"></span>
          <div class="seg" role="group" aria-label="View"><button type="button" data-view="week" class="on">Week</button><button type="button" data-view="month">Month</button><button type="button" data-view="agenda">Agenda</button></div>
        </header>
        <div id="calBody"></div>
        <div id="calErrors"></div>
      </section>`;

    // Account setup stays open beside the schedule on wide screens and folds
    // away on phones and tablets, where the schedule is shown first.
    $('#calSetup').open = window.matchMedia('(min-width: 861px)').matches;

    const startOfWeek = (d) => {
      const x = new Date(d);
      x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
      x.setHours(0, 0, 0, 0);
      return x;
    };
    function rangeFor() {
      if (view === 'week') {
        const s = startOfWeek(anchor);
        const e = new Date(s);
        e.setDate(e.getDate() + 7);
        return [s, e];
      }
      if (view === 'month') {
        const s = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
        const e = new Date(s);
        e.setDate(e.getDate() + 42);
        return [s, e];
      }
      const s = new Date(anchor);
      const e = new Date(s);
      e.setDate(e.getDate() + 30);
      return [s, e];
    }

    async function loadSources() {
      try {
        ({ sources } = await api.get('/calendar/sources'));
      } catch (e) {
        toast(e.message, true);
      }
      const groups = [
        ['Your accounts', sources.filter((s) => s.kind !== 'ICS')],
        ['Client & shared calendars', sources.filter((s) => s.kind === 'ICS')],
      ];
      $('#calSources').innerHTML =
        groups
          .map(
            ([title, list]) => `<div class="cal2-group"><div class="nav-label dark">${esc(title.toUpperCase())}</div>
        ${
          list.length
            ? list
                .map(
                  (
                    s,
                  ) => `<div class="cal2-src"><label><input type="checkbox" data-vis="${s.id}" ${s.visible ? 'checked' : ''}><span class="swatch" style="background:${esc(s.color)}"></span><span><span class="cal2-src-name">${esc(s.label)}</span>${s.last_error ? `<span class="err-inline small">${esc(s.last_error)}</span>` : ''}${s.read_only ? '<span class="msg-sub small">Read-only</span>' : ''}</span></label>
          <button class="link-btn" data-rm="${s.id}" aria-label="Remove ${esc(s.label)}">Remove</button></div>`,
                )
                .join('')
            : '<p class="msg-sub small">None yet.</p>'
        }</div>`,
          )
          .join('') +
        '<div class="cal2-group"><div class="nav-label dark">PORTAL</div><div class="cal2-src"><label><input type="checkbox" checked disabled><span class="swatch" style="background:#64748B"></span><span class="cal2-src-name">Holidays, time off, birthdays' +
        (ctx.access().adminLevel ? ' &amp; invoice due dates' : '') +
        '</span></label></div></div>';
      $('#calSources')
        .querySelectorAll('[data-vis]')
        .forEach((cb) =>
          cb.addEventListener('change', async () => {
            await api.put(`/calendar/sources/${cb.dataset.vis}`, { visible: cb.checked });
            loadEvents();
          }),
        );
      $('#calSources')
        .querySelectorAll('[data-rm]')
        .forEach((b) =>
          b.addEventListener('click', async () => {
            if (!window.confirm('Remove this calendar from the portal? Nothing is deleted from the original calendar.'))
              return;
            await api.del(`/calendar/sources/${b.dataset.rm}`);
            toast('Calendar removed');
            loadSources();
            loadEvents();
          }),
        );
    }

    async function loadEvents(refresh) {
      const [s, e] = rangeFor();
      $('#calRange').textContent =
        view === 'month'
          ? anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
          : `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(e - 1).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      $('#calBody').innerHTML = '<div class="loading">Loading events…</div>';
      try {
        const r = await api.get(
          `/calendar/events?from=${encodeURIComponent(s.toISOString())}&to=${encodeURIComponent(e.toISOString())}${refresh ? '&refresh=1' : ''}`,
        );
        events = r.events;
        conflicts = new Set(r.conflicts.flat());
        $('#calConflicts').innerHTML = r.conflicts.length
          ? pill(esc, `${r.conflicts.length} conflict${r.conflicts.length === 1 ? '' : 's'}`, 's-overdue')
          : '';
        $('#calErrors').innerHTML = r.errors.length
          ? `<p class="err-inline">Some calendars could not be refreshed: ${r.errors.map((x) => esc(x.label)).join(', ')}.</p>`
          : '';
        render(s, e);
      } catch (err) {
        $('#calBody').innerHTML = `<div class="err-inline">${esc(err.message)}</div>`;
      }
    }

    function evChip(ev, extra = '') {
      return `<button type="button" class="cal2-ev${conflicts.has(ev.uid) ? ' conflict' : ''}" data-uid="${esc(ev.uid)}" style="--c:${esc(ev.color || '#2F6FB5')};${extra}">
        <strong>${esc(ev.title)}</strong><span>${ev.all_day ? 'All day' : esc(usTime(ev.start_ts) + ' – ' + usTime(ev.end_ts))} · ${esc(ev.source_label || '')}</span></button>`;
    }

    function render(s) {
      if (view === 'agenda') {
        const byDay = new Map();
        for (const ev of events) {
          const k = isoDay(new Date(ev.start_ts));
          if (!byDay.has(k)) byDay.set(k, []);
          byDay.get(k).push(ev);
        }
        $('#calBody').innerHTML = byDay.size
          ? [...byDay]
              .map(
                ([d, list]) =>
                  `<div class="agenda-day"><h3>${esc(new Date(d + 'T12:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))}</h3>${list.map((ev) => evChip(ev)).join('')}</div>`,
              )
              .join('')
          : empty(esc, 'Nothing scheduled', 'No events in the next 30 days.');
      } else if (view === 'month') {
        const days = [...Array(42)].map((_, i) => {
          const d = new Date(s);
          d.setDate(d.getDate() + i);
          return d;
        });
        const today = isoDay(new Date());
        $('#calBody').innerHTML =
          `<div class="month-grid">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="month-dow">${d}</div>`).join('')}
          ${days
            .map((d) => {
              const k = isoDay(d);
              const list = events.filter(
                (ev) =>
                  isoDay(new Date(ev.start_ts)) === k ||
                  (ev.all_day && ev.start_ts <= d.getTime() && ev.end_ts > d.getTime()),
              );
              return `<div class="month-cell${d.getMonth() !== anchor.getMonth() ? ' muted' : ''}${k === today ? ' today' : ''}"><div class="month-num">${d.getDate()}</div>${list
                .slice(0, 3)
                .map(
                  (ev) =>
                    `<div class="month-ev" style="--c:${esc(ev.color)}">${esc(ev.all_day ? '' : usTime(ev.start_ts) + ' ')}${esc(ev.title)}</div>`,
                )
                .join('')}${list.length > 3 ? `<div class="msg-sub small">+${list.length - 3} more</div>` : ''}</div>`;
            })
            .join('')}</div>`;
      } else {
        const days = [...Array(7)].map((_, i) => {
          const d = new Date(s);
          d.setDate(d.getDate() + i);
          return d;
        });
        const H0 = 7,
          H1 = 21,
          PX = 48;
        const today = isoDay(new Date());
        const allDay = days.map((d) =>
          events.filter((ev) => ev.all_day && ev.start_ts < d.getTime() + 86400000 && ev.end_ts > d.getTime()),
        );
        $('#calBody').innerHTML = `<div class="week-wrap"><div class="week-grid" style="--rows:${H1 - H0};--px:${PX}px">
          <div class="week-corner"></div>${days.map((d) => `<div class="week-head${isoDay(d) === today ? ' today' : ''}"><span>${d.toLocaleDateString('en-US', { weekday: 'short' })}</span><strong>${d.getDate()}</strong></div>`).join('')}
          <div class="week-allday-label">All day</div>${allDay.map((list) => `<div class="week-allday">${list.map((ev) => `<div class="month-ev" style="--c:${esc(ev.color)}">${esc(ev.title)}</div>`).join('')}</div>`).join('')}
          <div class="week-hours">${[...Array(H1 - H0)].map((_, i) => `<div>${esc(new Date(2000, 0, 1, H0 + i).toLocaleTimeString('en-US', { hour: 'numeric' }))}</div>`).join('')}</div>
          ${days
            .map((d) => {
              const list = events
                .filter((ev) => !ev.all_day && isoDay(new Date(ev.start_ts)) === isoDay(d))
                .sort((a, b) => a.start_ts - b.start_ts);
              const lanes = []; // simple overlap layout
              const placed = list.map((ev) => {
                let lane = lanes.findIndex((end) => end <= ev.start_ts);
                if (lane < 0) {
                  lane = lanes.length;
                  lanes.push(0);
                }
                lanes[lane] = ev.end_ts;
                return { ev, lane };
              });
              const n = Math.max(1, lanes.length);
              return `<div class="week-col">${placed
                .map(({ ev, lane }) => {
                  const st = new Date(ev.start_ts),
                    top = Math.max(0, (st.getHours() + st.getMinutes() / 60 - H0) * PX),
                    h = Math.max(22, ((ev.end_ts - ev.start_ts) / 3600000) * PX - 3);
                  return evChip(
                    ev,
                    `position:absolute;top:${top}px;height:${h}px;left:calc(${(lane / n) * 100}% + 2px);width:calc(${100 / n}% - 4px)`,
                  );
                })
                .join('')}</div>`;
            })
            .join('')}
        </div></div>`;
      }
      $('#calBody')
        .querySelectorAll('[data-uid]')
        .forEach((b) =>
          b.addEventListener('click', () => {
            const ev = events.find((x) => x.uid === b.dataset.uid);
            if (!ev) return;
            ctx.modal(`<h3>${esc(ev.title)}</h3><p class="page-sub">${ev.all_day ? 'All day' : esc(new Date(ev.start_ts).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' – ' + usTime(ev.end_ts))}</p>
          <p><span class="swatch" style="background:${esc(ev.color)}"></span> ${esc(ev.source_label || '')}</p>${ev.location ? `<p>📍 ${esc(ev.location)}</p>` : ''}${conflicts.has(ev.uid) ? '<p class="err-inline">Overlaps another event.</p>' : ''}
          <div class="modal-actions">${ev.url && /^https:\/\//.test(ev.url) ? `<a class="btn btn-ghost" href="${esc(ev.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}<button class="btn btn-primary" id="mDone">Close</button></div>`);
            $('#mDone').addEventListener('click', ctx.closeModal);
          }),
        );
    }

    function newEvent() {
      const writable = sources.filter((s) => s.kind !== 'ICS' && !s.read_only);
      if (!writable.length) return toast('Connect a Google or Outlook calendar first to create events.', true);
      const d = new Date();
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() + 1);
      const local = (x) => new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      ctx.modal(`<h3>New event</h3>
        <div class="form-row one"><div class="field"><label>Title</label><input id="evTitle"></div></div>
        <div class="form-row"><div class="field"><label>Starts</label><input type="datetime-local" id="evStart" value="${local(d)}"></div><div class="field"><label>Ends</label><input type="datetime-local" id="evEnd" value="${local(new Date(d.getTime() + 3600000))}"></div></div>
        <div class="form-row one"><div class="field"><label>Calendar</label><select id="evSrc">${writable.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select></div></div>
        <div class="form-row one"><div class="field"><label>Location or meeting link</label><input id="evLoc"></div></div>
        <div class="form-row one"><div class="field"><label>Invite (emails, comma separated)</label><input id="evPeople" placeholder="name@client.com"></div></div>
        <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">Create event</button></div>`);
      $('#mCancel').addEventListener('click', ctx.closeModal);
      $('#mSave').addEventListener('click', async () => {
        try {
          await api.post('/calendar/events', {
            source_id: Number($('#evSrc').value),
            title: $('#evTitle').value,
            starts_at: new Date($('#evStart').value).toISOString(),
            ends_at: new Date($('#evEnd').value).toISOString(),
            location: $('#evLoc').value,
            attendees: $('#evPeople')
              .value.split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          });
          ctx.closeModal();
          toast('Event created ✓');
          loadEvents(true);
        } catch (e) {
          toast(e.message, true);
        }
      });
    }

    function addIcs() {
      ctx.modal(`<h3>Add a calendar link</h3>
        <p class="page-sub">Paste a private ICS / webcal link. In Google Calendar: Settings › your calendar › “Secret address in iCal format”. In Outlook: Settings › Calendar › Shared calendars › “Publish a calendar”. Updates every 15 minutes, view-only.</p>
        <div class="form-row one"><div class="field"><label>Calendar link</label><input id="icsUrl" placeholder="https://… or webcal://…"></div></div>
        <div class="form-row"><div class="field"><label>Name</label><input id="icsLabel" placeholder="e.g. Client Alpha — team calendar"></div><div class="field"><label>Color</label><input type="color" id="icsColor" value="#D9822B"></div></div>
        <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">Add calendar</button></div>`);
      $('#mCancel').addEventListener('click', ctx.closeModal);
      $('#mSave').addEventListener('click', async () => {
        $('#mSave').disabled = true;
        try {
          await api.post('/calendar/sources/ics', {
            url: $('#icsUrl').value,
            label: $('#icsLabel').value || 'Shared calendar',
            color: $('#icsColor').value,
          });
          ctx.closeModal();
          toast('Calendar added ✓');
          loadSources();
          loadEvents();
        } catch (e) {
          toast(e.message, true);
          $('#mSave').disabled = false;
        }
      });
    }

    async function connect(provider) {
      try {
        const r = await api.post(`/calendar/sources/${provider}/connect`);
        window.location.href = r.url;
      } catch (e) {
        toast(e.message, true);
      }
    }

    $('#calNew').addEventListener('click', newEvent);
    $('#calIcs').addEventListener('click', addIcs);
    $('#calGoogle').addEventListener('click', () => connect('google'));
    $('#calMs').addEventListener('click', () => connect('microsoft'));
    $('#calToday').addEventListener('click', () => {
      anchor = new Date();
      anchor.setHours(0, 0, 0, 0);
      loadEvents();
    });
    const step = (dir) => {
      if (view === 'month') anchor = new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
      else anchor.setDate(anchor.getDate() + dir * (view === 'week' ? 7 : 30));
      loadEvents();
    };
    $('#calPrev').addEventListener('click', () => step(-1));
    $('#calNext').addEventListener('click', () => step(1));
    root.querySelectorAll('.seg [data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        view = b.dataset.view;
        root.querySelectorAll('.seg [data-view]').forEach((x) => x.classList.toggle('on', x === b));
        loadEvents();
      }),
    );
    await loadSources();
    loadEvents();
  }

  // =====================================================================
  //  BILLING & INVOICES (admin console)
  // =====================================================================
  async function billing(ctx, openId) {
    const { api, $, esc, toast } = ctx;
    const fy = (() => {
      const d = new Date();
      return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    })();
    let currency = 'USD',
      filter = '';
    ctx.setMain(
      'Billing',
      `Fiscal year ${fy}–${String(fy + 1).slice(2)} · all clients`,
      `
      <div class="toolbar wrap"><div class="seg" role="group" aria-label="Currency"><button type="button" data-cur="USD" class="on">USD ($)</button><button type="button" data-cur="INR">INR (₹)</button></div>
        <span class="topbar-spacer"></span><button class="btn btn-navy" id="newInv">+ New invoice</button></div>
      <div class="kpi-row" id="billKpis"></div>
      <div class="split-2">
        <section class="card flush"><header class="card-head"><h2>Invoices</h2><div class="chips" id="invFilters">${['', 'DRAFT', 'SENT', 'OVERDUE', 'PAID', 'VOID'].map((s) => `<button type="button" class="chip${s === '' ? ' on' : ''}" data-f="${s}">${s ? s[0] + s.slice(1).toLowerCase() : 'All'}</button>`).join('')}</div></header><div class="table-wrap" id="invTable"></div></section>
        <section class="card"><h2 class="card-title">Top clients by revenue</h2><div id="topClients"></div><p class="msg-sub">Clients get automatic reminders 3 days before the due date, then weekly while overdue (when email is configured).</p></section>
      </div>`,
    );
    async function loadSummary() {
      try {
        const s = await api.get(`/admin/billing/summary?fy=${fy}&currency=${currency}`);
        $('#billKpis').innerHTML = [
          ['Billed this year', money(s.billed, currency), `${s.invoices} invoice${s.invoices === 1 ? '' : 's'}`, ''],
          [
            'Collected',
            money(s.collected, currency),
            s.collectionRate === null ? '—' : `${s.collectionRate}% collection rate`,
            'ok',
          ],
          ['Outstanding', money(s.outstanding, currency), `${s.open} open`, 'warn'],
          [
            'Overdue',
            money(s.overdue, currency),
            s.overdueCount
              ? `${s.overdueCount} invoice${s.overdueCount === 1 ? '' : 's'} · oldest ${s.oldestOverdueDays} day${s.oldestOverdueDays === 1 ? '' : 's'}`
              : 'Nothing overdue',
            'bad',
          ],
        ]
          .map(
            ([l, v, sub, cls]) =>
              `<div class="kpi card"><div class="kpi-label">${esc(l)}</div><div class="kpi-value ${cls}">${esc(v)}</div><div class="kpi-sub">${esc(sub)}</div></div>`,
          )
          .join('');
        const max = Math.max(1, ...s.byClient.map((c) => c.billed));
        $('#topClients').innerHTML = s.byClient.length
          ? s.byClient
              .slice(0, 6)
              .map(
                (c) =>
                  `<div class="bar-row"><div class="bar-label"><span>${esc(c.name)}</span><span>${esc(money(c.billed, currency))}</span></div><div class="bar"><i style="width:${Math.round((c.billed / max) * 100)}%"></i></div></div>`,
              )
              .join('')
          : '<p class="msg-sub">No invoices sent yet this year.</p>';
      } catch (e) {
        toast(e.message, true);
      }
    }
    async function loadInvoices() {
      try {
        const { invoices } = await api.get(
          `/admin/billing/invoices?currency=${currency}${filter ? '&status=' + filter : ''}`,
        );
        $('#invTable').innerHTML = invoices.length
          ? `<table class="data"><thead><tr><th>Invoice</th><th>Client</th><th>Issued</th><th>Due</th><th class="num">Amount</th><th class="num">Balance</th><th>Status</th></tr></thead><tbody>
          ${invoices.map((i) => `<tr class="clickable" data-id="${i.id}" tabindex="0"><td class="nowrap"><strong>${esc(i.number || 'Draft')}</strong></td><td>${esc(i.client_name)}</td><td class="nowrap">${esc(usDate(i.issue_date))}</td><td class="nowrap">${esc(usDate(i.due_date))}</td><td class="num">${esc(money(i.total, i.currency))}</td><td class="num">${esc(money(i.balance, i.currency))}</td><td>${pill(esc, i.display_status[0] + i.display_status.slice(1).toLowerCase(), STATUS[i.display_status])}</td></tr>`).join('')}</tbody></table>`
          : empty(esc, 'No invoices here yet', 'Create your first invoice with “New invoice”.');
        $('#invTable')
          .querySelectorAll('[data-id]')
          .forEach((r) => {
            const open = () => editor(Number(r.dataset.id));
            r.addEventListener('click', open);
            r.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') open();
            });
          });
      } catch (e) {
        $('#invTable').innerHTML = `<div class="err-inline">${esc(e.message)}</div>`;
      }
    }
    document.querySelectorAll('[data-cur]').forEach((b) =>
      b.addEventListener('click', () => {
        currency = b.dataset.cur;
        document.querySelectorAll('[data-cur]').forEach((x) => x.classList.toggle('on', x === b));
        loadSummary();
        loadInvoices();
      }),
    );
    $('#invFilters')
      .querySelectorAll('[data-f]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          filter = b.dataset.f;
          $('#invFilters')
            .querySelectorAll('.chip')
            .forEach((x) => x.classList.toggle('on', x === b));
          loadInvoices();
        }),
      );
    $('#newInv').addEventListener('click', () => editor(null));
    loadSummary();
    loadInvoices();
    if (openId) editor(openId);

    // ---------- invoice editor ----------
    async function editor(id) {
      let inv = null,
        clients = [];
      try {
        [{ clients }, inv] = await Promise.all([
          api.get('/admin/billing/clients'),
          id ? api.get(`/admin/billing/invoices/${id}`).then((r) => r.invoice) : Promise.resolve(null),
        ]);
      } catch (e) {
        return toast(e.message, true);
      }
      if (!clients.length)
        return toast('Add a client first (Tasks › Clients) — invoices are billed to a client.', true);
      const today = isoDay(new Date());
      const st = inv ? inv.display_status : 'DRAFT';
      const editable = !inv || inv.status === 'DRAFT';
      const state = {
        client_id: inv ? inv.client_id : clients[0].id,
        issue_date: inv ? inv.issue_date : today,
        terms: inv ? inv.terms : 'NET_30',
        currency: inv ? inv.currency : currency,
        tax_rate: inv ? inv.tax_rate : 0,
        notes: inv ? inv.notes : 'Thank you for your business. Payment by ACH or wire.',
        bill_to: inv ? inv.bill_to : '',
        reminders: inv ? Boolean(inv.reminders) : true,
        lines: inv
          ? inv.lines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unit_price: l.unit_price,
              source: l.source,
            }))
          : [{ description: '', quantity: 1, unit_price: 0 }],
      };
      ctx.setMain(
        inv && inv.number ? `Invoice ${inv.number}` : 'New invoice',
        inv
          ? `${inv.client_name} · ${st[0] + st.slice(1).toLowerCase()}`
          : 'Draft — nothing is sent until you click Send.',
        `
        <div class="toolbar wrap"><button class="btn btn-ghost" id="invBack">← Billing</button><span class="topbar-spacer"></span>
          ${editable ? '<button class="btn btn-ghost" id="invSave">Save draft</button>' : ''}
          ${inv ? '<a class="btn btn-ghost" id="invPdf" target="_blank" rel="noopener">Preview PDF</a>' : ''}
          ${inv && ['DRAFT', 'SENT'].includes(inv.status) && inv.status !== 'PAID' ? `<button class="btn btn-navy" id="invSend">${inv.status === 'SENT' ? 'Resend to client' : 'Send to client'}</button>` : ''}
          ${inv && inv.status === 'SENT' ? '<button class="btn btn-primary" id="invPay">Record payment</button>' : ''}
          ${inv && inv.status === 'SENT' && !inv.paid ? '<button class="btn btn-danger" id="invVoid">Void</button>' : ''}
          ${inv && inv.status === 'DRAFT' ? '<button class="btn btn-danger" id="invDel">Delete draft</button>' : ''}</div>
        <div class="inv-layout">
          <form class="card inv-form" id="invForm" ${editable ? '' : 'inert'}>
            <div class="form-row one"><div class="field"><label for="iClient">Client</label><select id="iClient">${clients.map((c) => `<option value="${c.id}"${c.id === state.client_id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div>
            <div class="form-row three"><div class="field"><label for="iDate">Issue date</label><input type="date" id="iDate" value="${esc(state.issue_date)}"></div>
              <div class="field"><label for="iTerms">Terms</label><select id="iTerms">${[
                ['DUE_ON_RECEIPT', 'Due on receipt'],
                ['NET_7', 'Net 7'],
                ['NET_15', 'Net 15'],
                ['NET_30', 'Net 30'],
                ['NET_45', 'Net 45'],
                ['NET_60', 'Net 60'],
              ]
                .map(([v, l]) => `<option value="${v}"${v === state.terms ? ' selected' : ''}>${l}</option>`)
                .join('')}</select></div>
              <div class="field"><label for="iCur">Currency</label><select id="iCur"><option${state.currency === 'USD' ? ' selected' : ''}>USD</option><option${state.currency === 'INR' ? ' selected' : ''}>INR</option></select></div></div>
            <div class="lines-head"><h3>Line items</h3>${inv && editable ? '<button type="button" class="btn btn-ghost btn-sm" id="iImport">Import completed tasks</button>' : ''}</div>
            <div id="iLines"></div>
            ${editable ? '<button type="button" class="btn btn-ghost btn-sm dashed" id="iAdd">+ Add line</button>' : ''}
            <div class="form-row"><div class="field"><label for="iTax">Tax rate (%)</label><input type="number" id="iTax" min="0" max="50" step="0.01" value="${esc(state.tax_rate)}"></div>
              <div class="field"><label for="iBill">Bill-to address (optional)</label><input id="iBill" value="${esc(state.bill_to)}" placeholder="Uses the client’s billing address"></div></div>
            <div class="form-row one"><div class="field"><label for="iNotes">Notes to client</label><textarea id="iNotes" rows="3">${esc(state.notes)}</textarea></div></div>
            <label class="check"><input type="checkbox" id="iRem" ${state.reminders ? 'checked' : ''}> Send automatic payment reminders</label>
          </form>
          <section class="card paper" aria-label="Invoice preview" id="iPreview"></section>
        </div>
        ${inv && inv.payments.length ? `<section class="card"><h2 class="card-title">Payments</h2><table class="data"><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th>Recorded by</th></tr></thead><tbody>${inv.payments.map((p) => `<tr><td>${esc(usDate(p.paid_on))}</td><td>${esc(p.method || '—')}</td><td>${esc(p.reference || '—')}</td><td class="num">${esc(money(p.amount, inv.currency))}</td><td>${esc(p.recorded_by_name || '')}</td></tr>`).join('')}</tbody></table></section>` : ''}`,
      );

      const read = () => {
        state.client_id = Number($('#iClient').value);
        state.issue_date = $('#iDate').value;
        state.terms = $('#iTerms').value;
        state.currency = $('#iCur').value;
        state.tax_rate = Number($('#iTax').value || 0);
        state.bill_to = $('#iBill').value;
        state.notes = $('#iNotes').value;
        state.reminders = $('#iRem').checked;
        state.lines = [...document.querySelectorAll('.line-row')].map((r) => ({
          description: r.querySelector('.l-desc').value,
          quantity: Number(r.querySelector('.l-qty').value || 0),
          unit_price: Number(r.querySelector('.l-rate').value || 0),
          source: r.dataset.source || '',
        }));
      };
      function drawLines() {
        $('#iLines').innerHTML = state.lines
          .map(
            (l, i) => `<div class="line-row" data-source="${esc(l.source || '')}">
          <div class="field"><label class="${i ? 'sr-only' : ''}" for="ld${i}">Description</label><input id="ld${i}" class="l-desc" value="${esc(l.description)}"></div>
          <div class="field"><label class="${i ? 'sr-only' : ''}" for="lq${i}">Qty</label><input id="lq${i}" class="l-qty" type="number" min="0" step="0.25" value="${esc(l.quantity)}"></div>
          <div class="field"><label class="${i ? 'sr-only' : ''}" for="lr${i}">Rate</label><input id="lr${i}" class="l-rate" type="number" min="0" step="0.01" value="${esc(l.unit_price)}"></div>
          ${editable ? `<button type="button" class="icon-btn danger" data-rmline="${i}" aria-label="Remove line ${i + 1}">✕</button>` : ''}</div>`,
          )
          .join('');
        $('#iLines')
          .querySelectorAll('[data-rmline]')
          .forEach((b) =>
            b.addEventListener('click', () => {
              read();
              state.lines.splice(Number(b.dataset.rmline), 1);
              if (!state.lines.length) state.lines.push({ description: '', quantity: 1, unit_price: 0 });
              drawLines();
              preview();
            }),
          );
      }
      function preview() {
        const c = clients.find((x) => x.id === state.client_id) || {};
        const sub = state.lines.reduce((s, l) => s + Math.round(l.quantity * l.unit_price * 100), 0) / 100;
        const tax = Math.round(sub * state.tax_rate) / 100;
        const due = (() => {
          const days =
            { DUE_ON_RECEIPT: 0, NET_7: 7, NET_15: 15, NET_30: 30, NET_45: 45, NET_60: 60 }[state.terms] ?? 30;
          const d = new Date(state.issue_date + 'T12:00');
          d.setDate(d.getDate() + days);
          return isoDay(d);
        })();
        $('#iPreview').innerHTML =
          `<div class="paper-head"><div><img src="/img/lit-logo-color.png" alt="LIT Nexus" class="paper-logo"><div class="msg-sub small">Cabin No. 12, First Floor, Big Bang Tower, Plot No. E279<br>Sector-75, Industrial Area, Mohali, Punjab - 160071</div></div>
          <div class="paper-title"><div>INVOICE</div><span>${esc(inv && inv.number ? inv.number : 'DRAFT')}</span></div></div>
          <div class="paper-meta"><div><div class="kicker">BILL TO</div><strong>${esc(c.name || '')}</strong><div class="msg-sub">${esc(state.bill_to || c.billing_address || '')}</div></div>
            <dl><dt>Issued</dt><dd>${esc(usDate(state.issue_date))}</dd><dt>Due</dt><dd>${esc(usDate(due))}</dd><dt>Terms</dt><dd>${esc($('#iTerms').selectedOptions[0].textContent)}</dd></dl></div>
          <table class="paper-lines"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>
            ${state.lines
              .filter((l) => l.description || l.unit_price)
              .map(
                (l) =>
                  `<tr><td>${esc(l.description)}</td><td class="num">${esc(l.quantity)}</td><td class="num">${esc(money(l.unit_price, state.currency))}</td><td class="num"><strong>${esc(money(l.quantity * l.unit_price, state.currency))}</strong></td></tr>`,
              )
              .join('')}</tbody></table>
          <div class="paper-totals"><div><span>Subtotal</span><span>${esc(money(sub, state.currency))}</span></div>${state.tax_rate ? `<div><span>Tax (${esc(state.tax_rate)}%)</span><span>${esc(money(tax, state.currency))}</span></div>` : ''}
            <div class="grand"><span>Total due</span><span>${esc(money(sub + tax - (inv ? inv.paid : 0), state.currency))}</span></div></div>
          ${state.notes ? `<p class="paper-notes">${esc(state.notes)}</p>` : ''}`;
      }
      async function save() {
        read();
        const body = { ...state, lines: state.lines.filter((l) => l.description.trim()) };
        const r = inv
          ? await api.put(`/admin/billing/invoices/${inv.id}`, body)
          : await api.post('/admin/billing/invoices', body);
        return r.invoice;
      }
      drawLines();
      preview();
      $('#invForm').addEventListener('input', () => {
        read();
        preview();
      });
      $('#invBack').addEventListener('click', () => billing(ctx));
      if ($('#iAdd'))
        $('#iAdd').addEventListener('click', () => {
          read();
          state.lines.push({ description: '', quantity: 1, unit_price: 0 });
          drawLines();
          preview();
        });
      if ($('#invSave'))
        $('#invSave').addEventListener('click', async () => {
          try {
            const saved = await save();
            toast('Draft saved ✓');
            editor(saved.id);
          } catch (e) {
            toast(e.message, true);
          }
        });
      if ($('#invPdf')) $('#invPdf').href = `/api/admin/billing/invoices/${inv.id}/pdf`;
      if ($('#iImport'))
        $('#iImport').addEventListener('click', async () => {
          try {
            const r = await api.get(`/admin/billing/invoices/${inv.id}/task-lines`);
            if (!r.lines.length) return toast('No completed tasks for this client this month.');
            read();
            state.lines = state.lines
              .filter((l) => l.description.trim())
              .concat(
                r.lines.map((l) => ({ description: l.description, quantity: 1, unit_price: 0, source: l.source })),
              );
            drawLines();
            preview();
            toast(`${r.lines.length} tasks added — set their prices, then save.`);
          } catch (e) {
            toast(e.message, true);
          }
        });
      if ($('#invSend'))
        $('#invSend').addEventListener('click', async () => {
          try {
            let target = inv;
            if (editable) target = await save();
            if (
              !window.confirm(
                `Send this invoice to the client by email${target.client_email ? ` (${target.client_email})` : ''}? It will be numbered and locked.`,
              )
            )
              return;
            const r = await api.post(`/admin/billing/invoices/${target.id}/send`, { send_email: true });
            toast(
              r.delivery.emailed ? `Sent to ${r.delivery.to} ✓` : `Marked as sent. ${r.delivery.reason}`,
              !r.delivery.emailed,
            );
            editor(target.id);
          } catch (e) {
            toast(e.message, true);
          }
        });
      if ($('#invPay'))
        $('#invPay').addEventListener('click', () => {
          ctx.modal(`<h3>Record payment</h3><p class="page-sub">Balance due ${esc(money(inv.balance, inv.currency))}</p>
          <div class="form-row"><div class="field"><label>Amount</label><input type="number" id="pAmt" step="0.01" value="${esc(inv.balance)}"></div><div class="field"><label>Date</label><input type="date" id="pDate" value="${today}"></div></div>
          <div class="form-row"><div class="field"><label>Method</label><select id="pMethod"><option>ACH</option><option>Wire</option><option>Check</option><option>Card</option><option>UPI</option><option>NEFT/IMPS</option><option>Other</option></select></div><div class="field"><label>Reference</label><input id="pRef"></div></div>
          <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">Record payment</button></div>`);
          $('#mCancel').addEventListener('click', ctx.closeModal);
          $('#mSave').addEventListener('click', async () => {
            try {
              await api.post(`/admin/billing/invoices/${inv.id}/payments`, {
                amount: Number($('#pAmt').value),
                paid_on: $('#pDate').value,
                method: $('#pMethod').value,
                reference: $('#pRef').value,
              });
              ctx.closeModal();
              toast('Payment recorded ✓');
              editor(inv.id);
            } catch (e) {
              toast(e.message, true);
            }
          });
        });
      if ($('#invVoid'))
        $('#invVoid').addEventListener('click', async () => {
          if (!window.confirm('Void this invoice? It stays in your records marked as void.')) return;
          try {
            await api.post(`/admin/billing/invoices/${inv.id}/void`);
            toast('Invoice voided');
            editor(inv.id);
          } catch (e) {
            toast(e.message, true);
          }
        });
      if ($('#invDel'))
        $('#invDel').addEventListener('click', async () => {
          if (!window.confirm('Delete this draft?')) return;
          try {
            await api.del(`/admin/billing/invoices/${inv.id}`);
            toast('Draft deleted');
            billing(ctx);
          } catch (e) {
            toast(e.message, true);
          }
        });
    }
  }

  // =====================================================================
  //  PEOPLE & ACCESS (owners)
  // =====================================================================
  async function access(ctx) {
    const { api, $, esc, toast } = ctx;
    let show = 'active';
    ctx.setMain(
      'People & Access',
      'Add employees, choose who can use the admin console, and remove people safely.',
      `
      <div class="toolbar wrap"><div class="chips" id="pplFilter"><button type="button" class="chip on" data-s="active">Active</button><button type="button" class="chip" data-s="admins">Admins</button><button type="button" class="chip" data-s="former">Former employees</button></div>
        <span class="topbar-spacer"></span><button class="btn btn-ghost" id="auditBtn">Audit log</button><button class="btn btn-navy" id="addPerson">+ Add employee</button></div>
      <section class="card flush"><div class="table-wrap" id="pplTable"><div class="loading">Loading…</div></div></section>
      <p class="msg-sub">Access levels: <strong>Owner</strong> — everything (partners). <strong>Billing admin</strong> — clients, invoices and billing only. <strong>Employee</strong> — the employee portal.</p>`,
    );
    let people = [];
    const me = ctx.me();
    async function load() {
      try {
        people = (await api.get('/admin/people')).people;
      } catch (e) {
        $('#pplTable').innerHTML = `<div class="err-inline">${esc(e.message)}</div>`;
        return;
      }
      const list = people.filter((p) =>
        show === 'active' ? p.active : show === 'former' ? !p.active : p.access !== 'EMPLOYEE',
      );
      $('#pplTable').innerHTML = list.length
        ? `<table class="data"><thead><tr><th>Name</th><th>Access</th><th>2-step</th><th>Department</th><th>Status</th><th class="num">Actions</th></tr></thead><tbody>
        ${list
          .map(
            (
              p,
            ) => `<tr><td><div class="who"><span class="avatar avatar-sm">${esc(ctx.initials(p.name))}</span><div><strong>${esc(p.name)}</strong><div class="msg-sub small">${esc(p.email)}</div></div></div></td>
          <td><label class="sr-only" for="acc${p.id}">Access for ${esc(p.name)}</label><select id="acc${p.id}" data-acc="${p.id}" ${p.id === me.id || !p.active ? 'disabled' : ''}>${[
            ['OWNER', 'Owner'],
            ['BILLING', 'Billing admin'],
            ['EMPLOYEE', 'Employee'],
          ]
            .map(([v, l]) => `<option value="${v}"${p.access === v ? ' selected' : ''}>${l}</option>`)
            .join('')}</select></td>
          <td>${p.access === 'EMPLOYEE' ? '<span class="msg-sub">—</span>' : p.two_step ? pill(esc, 'On', 's-paid') + (p.id !== me.id ? ` <button class="link-btn" data-reset="${p.id}">Reset</button>` : '') : pill(esc, 'Set up at next sign-in', 's-sent')}</td>
          <td>${esc(p.department || '—')}</td><td>${p.active ? pill(esc, 'Active', 's-paid') : pill(esc, 'Deactivated', 's-void')}</td>
          <td class="num nowrap">${p.id === me.id ? '<span class="msg-sub">You</span>' : p.active ? `<button class="link-btn danger" data-remove="${p.id}">Remove</button>` : `<button class="link-btn" data-restore="${p.id}">Restore</button> <button class="link-btn danger" data-remove="${p.id}">Delete</button>`}</td></tr>`,
          )
          .join('')}</tbody></table>`
        : empty(esc, 'Nobody here', 'No people match this filter.');
      $('#pplTable')
        .querySelectorAll('[data-acc]')
        .forEach((s) =>
          s.addEventListener('change', async () => {
            try {
              await api.put(`/admin/people/${s.dataset.acc}/access`, { level: s.value });
              toast('Access updated ✓');
            } catch (e) {
              toast(e.message, true);
            }
            load();
          }),
        );
      $('#pplTable')
        .querySelectorAll('[data-reset]')
        .forEach((b) =>
          b.addEventListener('click', async () => {
            if (!window.confirm('Reset 2-step verification? They will set it up again at their next admin sign-in.'))
              return;
            try {
              await api.post(`/admin/auth/reset-2fa/${b.dataset.reset}`);
              toast('2-step reset');
              load();
            } catch (e) {
              toast(e.message, true);
            }
          }),
        );
      $('#pplTable')
        .querySelectorAll('[data-restore]')
        .forEach((b) =>
          b.addEventListener('click', async () => {
            try {
              await api.post(`/admin/people/${b.dataset.restore}/restore`);
              toast('Restored ✓');
              load();
            } catch (e) {
              toast(e.message, true);
            }
          }),
        );
      $('#pplTable')
        .querySelectorAll('[data-remove]')
        .forEach((b) =>
          b.addEventListener('click', () => remove(people.find((p) => p.id === Number(b.dataset.remove)))),
        );
    }
    async function remove(p) {
      let preview = null;
      try {
        preview = await api.get(`/admin/people/${p.id}/delete-preview`);
      } catch (e) {
        return toast(e.message, true);
      }
      const canDelete = !preview.blockers.length && p.access !== 'OWNER';
      ctx.modal(`<h3>Remove ${esc(p.name)}?</h3>
        <label class="choice"><input type="radio" name="rmMode" value="deactivate" ${p.active ? 'checked' : 'disabled'}><span><strong>Deactivate (recommended)</strong><span class="msg-sub">Sign-in is blocked immediately. Attendance, leave, payroll and task history are kept for records and audits. Can be restored anytime.</span></span></label>
        <label class="choice danger"><input type="radio" name="rmMode" value="delete" ${canDelete ? '' : 'disabled'} ${!p.active && canDelete ? 'checked' : ''}><span><strong>Delete permanently</strong><span class="msg-sub">Erases this person and ${preview.records.punches} punches, ${preview.records.leaves} leave records, ${preview.records.tasks} tasks and their salary history. A full backup is saved first.${!canDelete ? ` <br><em>Not available: ${p.access === 'OWNER' ? 'change their access from Owner first.' : 'they are recorded as the author of other people’s records (e.g. bonuses or salary changes).'}</em>` : ''}</span></span></label>
        <div class="form-row one" id="rmConfirmRow" hidden><div class="field"><label>Type their full name to confirm</label><input id="rmConfirm" autocomplete="off" placeholder="${esc(p.name)}"></div></div>
        <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-danger" id="mSave">${p.active ? 'Deactivate employee' : 'Delete permanently'}</button></div>`);
      const mode = () => (document.querySelector('[name="rmMode"]:checked') || {}).value;
      document.querySelectorAll('[name="rmMode"]').forEach((r) =>
        r.addEventListener('change', () => {
          $('#rmConfirmRow').hidden = mode() !== 'delete';
          $('#mSave').textContent = mode() === 'delete' ? 'Delete permanently' : 'Deactivate employee';
        }),
      );
      $('#rmConfirmRow').hidden = mode() !== 'delete';
      $('#mCancel').addEventListener('click', ctx.closeModal);
      $('#mSave').addEventListener('click', async () => {
        try {
          if (mode() === 'delete') {
            const r = await api.req('DELETE', `/admin/people/${p.id}`, { confirmName: $('#rmConfirm').value });
            toast(`Deleted. Backup saved as ${r.backupFile}`);
          } else if (mode() === 'deactivate') {
            await api.post(`/admin/people/${p.id}/deactivate`);
            toast('Deactivated ✓');
          }
          ctx.closeModal();
          load();
        } catch (e) {
          toast(e.message, true);
        }
      });
    }
    function add() {
      ctx.modal(`<h3>Add employee</h3>
        <div class="form-row"><div class="field"><label>Full name</label><input id="apName"></div><div class="field"><label>Work email</label><input id="apEmail" type="email" placeholder="name@welitnexus.com"></div></div>
        <div class="form-row"><div class="field"><label>Job title</label><input id="apTitle"></div><div class="field"><label>Department</label><input id="apDept"></div></div>
        <div class="form-row"><div class="field"><label>Start date</label><input id="apStart" type="date"></div><div class="field"><label>Temporary password</label><input id="apPw" placeholder="min 6 characters"></div></div>
        <div class="form-row one"><div class="field"><label>Portal access</label><select id="apAccess"><option value="EMPLOYEE">Employee portal</option><option value="BILLING">Admin — billing &amp; invoices only</option><option value="OWNER">Admin — full (partners)</option></select></div></div>
        <p class="page-sub">Share the temporary password privately; they can change it from Account › Change password. Salary and shift details can be added in Employees › Personal information.</p>
        <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button><button class="btn btn-primary" id="mSave">Add employee</button></div>`);
      $('#mCancel').addEventListener('click', ctx.closeModal);
      $('#mSave').addEventListener('click', async () => {
        try {
          const r = await api.post('/users', {
            name: $('#apName').value.trim(),
            email: $('#apEmail').value.trim(),
            title: $('#apTitle').value,
            department: $('#apDept').value,
            join_date: $('#apStart').value || '',
            password: $('#apPw').value,
            role: 'EMPLOYEE',
          });
          if ($('#apAccess').value !== 'EMPLOYEE')
            await api.put(`/admin/people/${r.user.id}/access`, { level: $('#apAccess').value });
          ctx.closeModal();
          toast('Employee added ✓');
          load();
        } catch (e) {
          toast(e.message, true);
        }
      });
    }
    async function audit() {
      try {
        const { entries } = await api.get('/admin/people/audit-log?limit=200');
        ctx.modal(`<h3>Audit log</h3><div class="table-wrap audit"><table class="data"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead><tbody>${entries.map((e) => `<tr><td class="nowrap">${esc(new Date(e.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</td><td>${esc(e.actor_name || '—')}</td><td>${esc(e.action.replace(/[._]/g, ' '))}</td><td>${esc(e.target)}</td></tr>`).join('')}</tbody></table></div>
          <div class="modal-actions"><button class="btn btn-primary" id="mDone">Close</button></div>`);
        $('#mDone').addEventListener('click', ctx.closeModal);
      } catch (e) {
        toast(e.message, true);
      }
    }
    $('#pplFilter')
      .querySelectorAll('[data-s]')
      .forEach((b) =>
        b.addEventListener('click', () => {
          show = b.dataset.s;
          $('#pplFilter')
            .querySelectorAll('.chip')
            .forEach((x) => x.classList.toggle('on', x === b));
          load();
        }),
      );
    $('#addPerson').addEventListener('click', add);
    $('#auditBtn').addEventListener('click', audit);
    load();
  }

  // =====================================================================
  //  INTEGRATIONS (owners)
  // =====================================================================
  async function integrations(ctx) {
    const { api, $, esc, toast } = ctx;
    ctx.setMain(
      'Integrations',
      'Connection status for Slack, Asana, AI and calendars. Secrets are set in Railway and never shown here.',
      '<div id="intRoot"><div class="loading">Checking…</div></div>',
    );
    let s;
    try {
      s = await api.get('/admin/integrations');
    } catch (e) {
      $('#intRoot').innerHTML = `<div class="err-inline">${esc(e.message)}</div>`;
      return;
    }
    const row = (ok, label, hint) =>
      `<li class="${ok ? 'ok' : 'todo'}"><span class="dot" aria-hidden="true"></span><span><strong>${esc(label)}</strong>${hint ? `<span class="msg-sub">${hint}</span>` : ''}</span><span class="state">${ok ? 'Ready' : 'Not set'}</span></li>`;
    const code = (v) => (v ? `<code>${esc(v)}</code>` : '<em>set PUBLIC_BASE_URL first</em>');
    $('#intRoot').innerHTML = `<div class="int-grid">
      <section class="card"><h2 class="card-title">Security</h2><ul class="checklist">
        ${row(s.twoStep, '2-step verification for the admin console', 'ADMIN_2FA (default: required)')}
        ${row(s.adminConsoleRequired, 'All admin pages require the admin console sign-in', 'ADMIN_CONSOLE_REQUIRED=on — turn on once both partners have set up 2-step')}
        ${row(s.encryptionKey, 'Encryption key for stored sign-ins', 'INTEGRATIONS_KEY (32+ random characters)')}
        ${row(Boolean(s.publicBaseUrl), 'Public address', `PUBLIC_BASE_URL ${s.publicBaseUrl ? '= ' + esc(s.publicBaseUrl) : ''}`)}</ul></section>
      <section class="card"><h2 class="card-title">Slack</h2><ul class="checklist">
        ${row(s.slack.bot, 'Bot token', 'SLACK_BOT_TOKEN (already used for attendance alerts)')}
        ${row(s.slack.signingSecret, 'Signing secret (live messages)', 'SLACK_SIGNING_SECRET')}</ul>
        <p class="msg-sub">Event Subscriptions › Request URL: ${code(s.slack.eventsUrl)}<br>Bot scopes: channels:read channels:history groups:read groups:history chat:write chat:write.customize files:read files:write users:read users:read.email. Events: message.channels, message.groups.</p></section>
      <section class="card"><h2 class="card-title">Asana</h2><ul class="checklist">
        ${row(s.asana.token, 'Access token', 'ASANA_TOKEN')}${row(s.asana.project, 'Project', 'ASANA_PROJECT_GID')}</ul>
        <p class="msg-sub">Live updates webhook: ${code(s.asana.webhookUrl)}</p>
        <button class="btn btn-ghost btn-sm" id="asanaHook" ${s.asana.token && s.publicBaseUrl ? '' : 'disabled'}>Turn on live Asana updates</button></section>
      <section class="card"><h2 class="card-title">AI assistant</h2><ul class="checklist">
        ${row(
          s.ai.providers.some((p) => p.id === 'claude'),
          'Claude',
          'ANTHROPIC_API_KEY · optional AI_CLAUDE_MODEL',
        )}
        ${row(
          s.ai.providers.some((p) => p.id === 'openai'),
          'ChatGPT',
          'OPENAI_API_KEY · optional AI_OPENAI_MODEL',
        )}</ul>
        <p class="msg-sub">Default: ${esc(s.ai.default || 'none')} (AI_DEFAULT_PROVIDER). Salary figures, bank and ID numbers are removed before anything is sent.</p></section>
      <section class="card"><h2 class="card-title">Calendars</h2><ul class="checklist">
        ${row(s.calendar.google, 'Google / Gmail', 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET')}
        ${row(s.calendar.microsoft, 'Outlook / Microsoft 365', 'MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT=common')}</ul>
        <p class="msg-sub">Redirect URIs to register:<br>Google ${code(s.calendar.googleRedirect)}<br>Microsoft ${code(s.calendar.microsoftRedirect)}<br>ICS links work without any setup.</p></section>
      <section class="card"><h2 class="card-title">Email</h2><ul class="checklist">${row(s.email.smtp, 'Outgoing email (invoices, reminders, backups)', 'SMTP_HOST, SMTP_USER, SMTP_PASS · optional BILLING_EMAIL_FROM')}</ul></section>
    </div>`;
    const hook = $('#asanaHook');
    if (hook)
      hook.addEventListener('click', async () => {
        hook.disabled = true;
        try {
          await api.post('/asana-tasks/webhook/setup');
          toast('Live Asana updates turned on ✓');
        } catch (e) {
          toast(e.message, true);
          hook.disabled = false;
        }
      });
  }

  window.PortalV2 = { messages, schedule, billing, access, integrations, _money: money, _usDate: usDate };
})();
