/* Surface the most relevant Notice Board item on Dashboard while keeping the full board as archive. */
(function () {
  'use strict';

  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let loading = false;
  let lastMain = null;

  function isDashboard() {
    const main = document.getElementById('main');
    const active = document.querySelector('#nav .nav-item.active');
    return !!main && active?.dataset.view === 'dashboard';
  }

  async function renderDashboardAnnouncement() {
    if (!isDashboard() || loading) return;
    const main = document.getElementById('main');
    if (!main || main.querySelector('#dashAnnouncement')) return;
    loading = true;
    try {
      const data = await api.get('/announcements');
      if (!isDashboard()) return;
      const announcements = data?.announcements || [];
      if (!announcements.length) return;

      // API is already ordered pinned first, then newest. Explicit selection
      // keeps the dashboard rule clear if the archive ordering changes later.
      const pinned = announcements.filter((a) => Number(a.pinned) === 1);
      const a = pinned[0] || announcements[0];
      const when = a.created_ts ? new Date(a.created_ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';

      const section = document.createElement('div');
      section.id = 'dashAnnouncement';
      section.className = 'section';
      section.style.margin = '18px 0 24px';
      section.innerHTML = `
        <div class="toolbar" style="align-items:flex-start;margin-bottom:8px;">
          <div>
            <div style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.45px;color:var(--slate);margin-bottom:6px;">${a.pinned ? '📌 Pinned announcement' : '📣 Latest announcement'}</div>
            <h2 style="margin:0;color:var(--navy);">${escHtml(a.title)}</h2>
          </div>
          <button class="btn btn-ghost btn-sm" id="dashAllNotices">View all notices</button>
        </div>
        ${a.body ? `<div style="white-space:pre-wrap;line-height:1.6;color:var(--text);">${escHtml(a.body)}</div>` : ''}
        <div style="margin-top:10px;color:var(--slate);font-size:.78rem;">${escHtml(a.author || 'LIT Nexus')}${when ? ` · ${escHtml(when)}` : ''}</div>`;

      const cards = main.querySelector('#dashCards');
      if (cards?.nextSibling) cards.parentNode.insertBefore(section, cards.nextSibling);
      else if (cards) cards.parentNode.appendChild(section);
      else main.appendChild(section);

      section.querySelector('#dashAllNotices')?.addEventListener('click', () => {
        document.querySelector('#nav [data-view="noticeboard"]')?.click();
      });
    } catch (_e) {
      // Dashboard should remain usable if announcements cannot be loaded.
    } finally {
      loading = false;
    }
  }

  const observer = new MutationObserver(() => {
    const main = document.getElementById('main');
    if (main !== lastMain) lastMain = main;
    if (isDashboard()) setTimeout(renderDashboardAnnouncement, 0);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(renderDashboardAnnouncement, 0);
})();
