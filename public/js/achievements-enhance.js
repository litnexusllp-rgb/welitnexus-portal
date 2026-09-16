/* Achievement categories — isolated enhancement for the existing portal UI. */
(function () {
  'use strict';

  const categories = [
    ['CLIENT_DELIVERY', 'Client Delivery'],
    ['QUALITY', 'Quality'],
    ['INITIATIVE', 'Initiative'],
    ['PROCESS_IMPROVEMENT', 'Process Improvement'],
    ['CLIENT_APPRECIATION', 'Client Appreciation'],
    ['TEAM_SUPPORT', 'Team Support'],
    ['LEARNING', 'Learning'],
    ['OTHER', 'Other'],
  ];
  const labels = Object.fromEntries(categories);
  let mineCache = [];
  let reviewCache = [];

  function categoryLabel(value) {
    return labels[String(value || 'OTHER').toUpperCase()] || 'Other';
  }

  function addCategoryField() {
    const modal = document.getElementById('modal');
    if (!modal || document.getElementById('aCategory')) return;
    const heading = modal.querySelector('h3');
    if (!heading || heading.textContent.trim() !== 'Log achievement') return;

    const firstRow = modal.querySelector('.form-row');
    if (!firstRow) return;
    const fields = firstRow.querySelectorAll('.field');
    const target = fields[1] || document.createElement('div');
    if (!fields[1]) {
      target.className = 'field';
      firstRow.appendChild(target);
    }
    target.innerHTML = `<label for="aCategory">Category</label><select id="aCategory" required>
      <option value="">— Choose category —</option>
      ${categories.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
    </select>`;

    const date = document.getElementById('aDate');
    const title = document.getElementById('aTitle');
    const desc = document.getElementById('aDesc');
    if (date) date.required = true;
    if (title) title.required = true;
    if (desc) {
      desc.required = true;
      const descLabel = desc.closest('.field')?.querySelector('label');
      if (descLabel) descLabel.textContent = 'Details';
    }

    const save = document.getElementById('mSave');
    if (save) {
      save.addEventListener('click', (event) => {
        const required = [date, document.getElementById('aCategory'), title, desc];
        const missing = required.find((field) => field && !String(field.value || '').trim());
        if (missing) {
          event.preventDefault();
          event.stopImmediatePropagation();
          missing.reportValidity();
          missing.focus();
        }
      }, true);
    }
  }

  function insertHeader(table, afterIndex, text) {
    const row = table?.querySelector('thead tr');
    if (!row || [...row.children].some((th) => th.dataset.achievementCategory === '1')) return;
    const th = document.createElement('th');
    th.textContent = text;
    th.dataset.achievementCategory = '1';
    const anchor = row.children[afterIndex];
    if (anchor?.nextSibling) row.insertBefore(th, anchor.nextSibling); else row.appendChild(th);
  }

  function insertCategoryCells(hostId, rows, afterIndex) {
    const host = document.getElementById(hostId);
    const table = host?.querySelector('table');
    if (!table || !rows.length) return;
    insertHeader(table, afterIndex, 'Category');
    table.querySelectorAll('tbody tr').forEach((tr, index) => {
      if (tr.querySelector('[data-achievement-category="1"]')) return;
      const td = document.createElement('td');
      td.dataset.achievementCategory = '1';
      td.innerHTML = `<span class="badge">${categoryLabel(rows[index]?.category)}</span>`;
      const anchor = tr.children[afterIndex];
      if (anchor?.nextSibling) tr.insertBefore(td, anchor.nextSibling); else tr.appendChild(td);
    });
  }

  function enhanceTables() {
    insertCategoryCells('myAch', mineCache, 0);
    insertCategoryCells('reviewAch', reviewCache, 1);
  }

  const originalPost = api.post.bind(api);
  api.post = function (path, body) {
    if (path === '/achievements') {
      const select = document.getElementById('aCategory');
      body = { ...(body || {}), category: select?.value || '' };
    }
    return originalPost(path, body);
  };

  const originalGet = api.get.bind(api);
  api.get = async function (path) {
    const result = await originalGet(path);
    if (path === '/achievements/mine') {
      mineCache = result?.achievements || [];
      setTimeout(enhanceTables, 0);
    } else if (/^\/achievements\/month\//.test(path)) {
      reviewCache = result?.achievements || [];
      setTimeout(enhanceTables, 0);
    }
    return result;
  };

  const observer = new MutationObserver(() => {
    addCategoryField();
    enhanceTables();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
